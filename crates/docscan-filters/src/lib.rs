//! The three scan filters, written as passes over a raw RGBA buffer.
//!
//! Everything a filter does to a document scan is, at bottom, one of two
//! shapes:
//!
//! * a **per-channel map** — brightness and contrast stretching both
//!   answer "what does the byte 137 become?" the same way everywhere in
//!   the image, so the answer can be computed 256 times up front and read
//!   back per byte; and
//! * a **per-pixel decision** — binarisation reads all three channels to
//!   get a luma, so it cannot be a per-channel map, but its *output* is
//!   only ever one of two colours, which can also be precomputed.
//!
//! Writing them that way matters more than it looks. These run inside a
//! phone browser on a page that can be 4 megapixels, while the user drags
//! a brightness slider and expects the preview to follow their thumb. The
//! straightforward version — convert to luma, sort every pixel to find
//! percentiles, allocate an output image, do float arithmetic per channel,
//! then allocate again to apply brightness — spends most of its time on
//! allocation and on recomputing, four million times, an answer that
//! depends on nothing but the byte in front of it.
//!
//! So the entry points here take `&mut [u8]` and rewrite it in place. The
//! `DynamicImage` wrappers below them are kept because they are the
//! honest way to express the operation on the desktop side and because
//! the tests read better against them, but the browser calls the slices.

use image::DynamicImage;

/// Fixed luma threshold used by [`to_black_and_white`]. Chosen as the
/// midpoint of the 0-255 luma range; a reasonable default for document
/// scans without per-image calibration.
const BW_THRESHOLD: u8 = 128;

/// Rec. 709 luma weights, in fixed point.
///
/// These are the weights the `image` crate uses for the same conversion.
/// Doing the arithmetic in integers rather than calling it keeps the
/// result bit-identical across targets — a promise this pipeline makes
/// elsewhere and should not quietly drop in its innermost loop — and
/// agrees with `image`'s float version on all but about 0.4% of colours,
/// where the two land one level apart purely from float rounding.
const LUMA_R: u32 = 2126;
const LUMA_G: u32 = 7152;
const LUMA_B: u32 = 722;
const LUMA_DIV: u32 = 10000;
/// Added before the divide so it rounds instead of truncating. See
/// [`luma`] for why that is worth a constant.
const LUMA_HALF: u32 = LUMA_DIV / 2;

/// The fraction of pixels [`stretch_lut`] pushes past pure black and pure
/// white respectively. Clipping the extremes is what makes the stretch
/// useful on a real photograph: a single specular highlight or one dark
/// speck would otherwise define the whole range and the correction would
/// do almost nothing.
const CLIP_LOW: f64 = 0.01;
const CLIP_HIGH: f64 = 0.99;

/// The grey a colour reads as, rounded rather than truncated.
///
/// The rounding is not cosmetic. Truncating biases every value down by
/// half a level, and *how much* it loses depends on the fractional part,
/// which is a function of the colour — so truncation is not a constant
/// offset but colour-correlated noise of up to one level. Edge detection
/// downstream reads precisely the kind of small local differences that
/// noise manufactures, and this is shared with the detector's luma pass
/// (`docscan-wasm` calls it) so the two cannot drift apart on what grey a
/// colour is.
#[inline]
pub fn luma(r: u8, g: u8, b: u8) -> u8 {
    ((LUMA_R * r as u32 + LUMA_G * g as u32 + LUMA_B * b as u32 + LUMA_HALF) / LUMA_DIV) as u8
}

/// A precomputed per-channel colour map: `lut[v]` is what the byte `v`
/// becomes.
///
/// This is the whole optimisation in one type. Any composition of
/// per-channel operations — stretch then brighten, in this crate's case —
/// is itself a per-channel operation, so composing them costs 256 steps
/// once instead of one step per byte, and the pixel loop that applies the
/// result never does arithmetic at all.
pub type Lut = [u8; 256];

/// The identity map, optionally shifted by `brightness`.
pub fn brightness_lut(brightness: i32) -> Lut {
    let mut lut = [0u8; 256];
    for (value, out) in lut.iter_mut().enumerate() {
        *out = (value as i32 + brightness).clamp(0, 255) as u8;
    }
    lut
}

/// Counts how many pixels fall in each of the 256 luma buckets.
///
/// This replaces sorting every pixel to read percentiles off the sorted
/// array. Both answer the same question, but a histogram is one linear
/// pass into one kilobyte, where the sort was `n log n` over a freshly
/// allocated copy of every pixel in the image — four megabytes of
/// allocation and roughly twenty million comparisons on a full page, to
/// find two numbers.
///
/// `rgba` is read four bytes at a time; a trailing partial pixel, which a
/// well-formed buffer never has, is ignored.
pub fn luma_histogram(rgba: &[u8]) -> [u32; 256] {
    let mut hist = [0u32; 256];
    for &[r, g, b, _] in rgba.as_chunks::<4>().0 {
        hist[luma(r, g, b) as usize] += 1;
    }
    hist
}

/// The contrast-stretching map implied by `hist`, composed with a
/// `brightness` shift.
///
/// Returns `None` when there is nothing to stretch — an empty image, or
/// one whose 1st and 99th percentiles coincide, which is a flat image and
/// where the stretch would be a division by zero. The caller should fall
/// back to [`brightness_lut`]; returning `None` rather than silently
/// substituting it keeps "this image has no usable spread" distinguishable
/// from "this image was stretched".
pub fn stretch_lut(hist: &[u32; 256], brightness: i32) -> Option<Lut> {
    let total: u64 = hist.iter().map(|&c| u64::from(c)).sum();
    if total == 0 {
        return None;
    }

    // The same two percentile *indices* the sort-based version took, found
    // by walking the cumulative histogram instead of indexing a sorted
    // array. `low_idx` counts from the bottom and `high_idx` from the top,
    // matching `values[(len * 0.01) as usize]` and
    // `values[min(len - 1, (len * 0.99) as usize)]` on the same data.
    let low_rank = (total as f64 * CLIP_LOW) as u64;
    let high_rank = ((total as f64 * CLIP_HIGH) as u64).min(total - 1);

    let mut low = 0u8;
    let mut high = 255u8;
    let mut seen = 0u64;
    let mut have_low = false;
    for (value, &count) in hist.iter().enumerate() {
        if count == 0 {
            continue;
        }
        let next = seen + u64::from(count);
        if !have_low && next > low_rank {
            low = value as u8;
            have_low = true;
        }
        if next > high_rank {
            high = value as u8;
            break;
        }
        seen = next;
    }

    if high <= low {
        return None;
    }

    let (low, high) = (f32::from(low), f32::from(high));
    let mut lut = [0u8; 256];
    for (value, out) in lut.iter_mut().enumerate() {
        let stretched = (value as f32 - low) / (high - low) * 255.0;
        let stretched = stretched.round().clamp(0.0, 255.0) as i32;
        *out = (stretched + brightness).clamp(0, 255) as u8;
    }
    Some(lut)
}

/// Rewrites every colour channel of `rgba` through `lut`, leaving alpha
/// untouched.
pub fn apply_lut_rgba(rgba: &mut [u8], lut: &Lut) {
    for px in rgba.as_chunks_mut::<4>().0 {
        px[0] = lut[px[0] as usize];
        px[1] = lut[px[1] as usize];
        px[2] = lut[px[2] as usize];
    }
}

/// Binarises `rgba` in place: each pixel becomes black or white by luma,
/// then `brightness` shifts the two results.
///
/// The shift is applied to the two possible outputs rather than to the
/// pixels, which is both faster and the behaviour the UI wants — the
/// filter decides what kind of image this is and the slider then nudges
/// the result, so brightening can lift a black-and-white scan off pure
/// black without ever changing which pixels were called black.
pub fn binarize_rgba(rgba: &mut [u8], brightness: i32) {
    let dark = brightness.clamp(0, 255) as u8;
    let light = (255 + brightness).clamp(0, 255) as u8;
    for px in rgba.as_chunks_mut::<4>().0 {
        let value = if luma(px[0], px[1], px[2]) >= BW_THRESHOLD {
            light
        } else {
            dark
        };
        px[0] = value;
        px[1] = value;
        px[2] = value;
    }
}

/// A summed-area table over one plane, for constant-time window means.
///
/// This is what makes both spatial filters below affordable. A box mean over an
/// `r`-radius window is four lookups whatever `r` is, so a 60-pixel window
/// costs the same per pixel as a 2-pixel one — which matters because the
/// background estimate needs a window wide enough to see mostly paper.
///
/// `u64` rather than `u32`: the running sum of squares over a 12-megapixel page
/// reaches ~8e11, which overflows a `u32` about a hundredth of the way in and
/// would silently produce garbage thresholds rather than panicking.
struct Integral {
    width: usize,
    height: usize,
    sum: Vec<u64>,
    sum_sq: Vec<u64>,
}

impl Integral {
    fn new(luma: &[u8], width: usize, height: usize) -> Self {
        let stride = width + 1;
        let mut sum = vec![0u64; stride * (height + 1)];
        let mut sum_sq = vec![0u64; stride * (height + 1)];
        for y in 0..height {
            let mut row = 0u64;
            let mut row_sq = 0u64;
            for x in 0..width {
                let v = u64::from(luma[y * width + x]);
                row += v;
                row_sq += v * v;
                sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1] + row;
                sum_sq[(y + 1) * stride + x + 1] = sum_sq[y * stride + x + 1] + row_sq;
            }
        }
        Self {
            width,
            height,
            sum,
            sum_sq,
        }
    }

    /// Mean and variance of the window of radius `r` centred on `(x, y)`,
    /// clipped to the image. Returns the pixel count too, since edge windows
    /// are smaller and dividing by the nominal area darkens every border.
    fn window(&self, x: usize, y: usize, r: usize) -> (f32, f32) {
        let stride = self.width + 1;
        let x0 = x.saturating_sub(r);
        let y0 = y.saturating_sub(r);
        let x1 = (x + r + 1).min(self.width);
        let y1 = (y + r + 1).min(self.height);
        let area = ((x1 - x0) * (y1 - y0)) as f32;

        let at = |t: &Vec<u64>, yy: usize, xx: usize| t[yy * stride + xx];
        let s = (at(&self.sum, y1, x1) + at(&self.sum, y0, x0)) as f32
            - (at(&self.sum, y0, x1) + at(&self.sum, y1, x0)) as f32;
        let sq = (at(&self.sum_sq, y1, x1) + at(&self.sum_sq, y0, x0)) as f32
            - (at(&self.sum_sq, y0, x1) + at(&self.sum_sq, y1, x0)) as f32;

        let mean = s / area;
        (mean, (sq / area - mean * mean).max(0.0))
    }
}

fn luma_plane(rgba: &[u8]) -> Vec<u8> {
    rgba.as_chunks::<4>()
        .0
        .iter()
        .map(|px| luma(px[0], px[1], px[2]))
        .collect()
}

/// How wide a window has to be before it sees mostly paper rather than ink.
///
/// Expressed as a fraction of the page's shorter side rather than in pixels, so
/// it means the same thing on a 2-megapixel phone photo and a 12-megapixel one.
/// Too small and the estimate follows the text, which erases strokes; too large
/// and it stops tracking the shadow it exists to remove.
const BACKGROUND_WINDOW: f32 = 0.045;

/// The local window for adaptive thresholding — around a character height.
const THRESHOLD_WINDOW: f32 = 0.012;

/// Sauvola's sensitivity. Higher pulls the threshold further below the local
/// mean, which keeps faint paper texture out of the ink at the cost of thinning
/// very light strokes.
const SAUVOLA_K: f32 = 0.2;

/// Half the dynamic range, which is what Sauvola normalises the local standard
/// deviation against.
const SAUVOLA_R: f32 = 128.0;

fn window_radius(width: usize, height: usize, fraction: f32) -> usize {
    ((width.min(height) as f32 * fraction) as usize).max(1)
}

/// The brightest value within `r` of each pixel, in two separable passes.
///
/// Used to estimate what the paper would read if the ink were not there. A box
/// *mean* cannot do that job where the ink is dense: the mean of a window full
/// of small print sits well below the paper around it, so dividing by it lifts
/// the strokes as much as the paper and the print comes out fainter than it
/// went in. A maximum over the same window is the paper wherever any paper
/// shows through, which on text is everywhere between the letters.
///
/// Each pass is a sliding-window maximum over a monotonic deque, so the cost
/// is one pass per axis regardless of how wide the window is.
fn local_max(plane: &[u8], width: usize, height: usize, r: usize) -> Vec<u8> {
    let mut rows = vec![0u8; width * height];
    let mut deque: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    for y in 0..height {
        deque.clear();
        let row = &plane[y * width..][..width];
        for x in 0..width {
            // The window for output pixel `x - r` closes at input `x`.
            while let Some(&back) = deque.back() {
                if row[back] <= row[x] { deque.pop_back(); } else { break }
            }
            deque.push_back(x);
            if x >= r {
                let out = x - r;
                while *deque.front().unwrap() + r < out { deque.pop_front(); }
                rows[y * width + out] = row[*deque.front().unwrap()];
            }
        }
        // The last `r` outputs have no further input to wait for.
        for out in width.saturating_sub(r)..width {
            while *deque.front().unwrap() + r < out { deque.pop_front(); }
            rows[y * width + out] = row[*deque.front().unwrap()];
        }
    }

    let mut out = vec![0u8; width * height];
    let mut column = vec![0u8; height];
    for x in 0..width {
        for y in 0..height { column[y] = rows[y * width + x]; }
        deque.clear();
        for y in 0..height {
            while let Some(&back) = deque.back() {
                if column[back] <= column[y] { deque.pop_back(); } else { break }
            }
            deque.push_back(y);
            if y >= r {
                let o = y - r;
                while *deque.front().unwrap() + r < o { deque.pop_front(); }
                out[o * width + x] = column[*deque.front().unwrap()];
            }
        }
        for o in height.saturating_sub(r)..height {
            while *deque.front().unwrap() + r < o { deque.pop_front(); }
            out[o * width + x] = column[*deque.front().unwrap()];
        }
    }
    out
}

/// Divide out the page's own lighting, in place.
///
/// A photograph of a page is the page multiplied by however the light fell on
/// it. Estimating that lighting and dividing it back out is what turns a
/// hand-held photo into something that looks photocopied — and it is the step
/// the global contrast stretch cannot substitute for, because a shadow supplies
/// both ends of the histogram itself and leaves the stretch nearly an identity.
///
/// The estimate is the local *peak* luma, smoothed: the brightest value within
/// a window of each pixel is the paper there, because on text there is always
/// paper between the letters. It was a box mean of the luma, on the reasoning
/// that text is small and dark and a wide window therefore averages mostly
/// paper. That holds for a double-spaced A4 and fails for the thing people
/// photograph most: a till receipt, where small print fills the full width of a
/// narrow page. There the mean sits well below the paper, the gain comes out
/// too high, and the strokes are lifted along with the paper — measured on a
/// photographed thermal receipt, the mean estimate raised the median of the
/// darkest tenth of the page from 19 to 28 while the paper went to 245 — faint
/// grey text on white.
pub fn flatten_illumination_rgba(rgba: &mut [u8], width: u32, height: u32) {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return;
    }

    let plane = luma_plane(rgba);
    let r = window_radius(w, h, BACKGROUND_WINDOW);
    // The paper under each pixel: the brightest value nearby, then smoothed so
    // the field has no steps in it. See `local_max` for why this is not a mean.
    let paper = local_max(&plane, w, h, r);
    let integral = Integral::new(&paper, w, h);

    // Scale back to a paper white just under 255. Going to 255 exactly clips
    // the lightest real paper texture into a flat block and costs the ink its
    // softest edges.
    const TARGET: f32 = 245.0;

    for y in 0..h {
        for x in 0..w {
            let (background, _) = integral.window(x, y, r);
            // A window that is genuinely dark everywhere — a photograph of
            // something that is not a page — would otherwise be multiplied up
            // into noise.
            let gain = TARGET / background.max(24.0);
            let px = &mut rgba[(y * w + x) * 4..][..4];
            for c in px.iter_mut().take(3) {
                *c = (f32::from(*c) * gain).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Binarize with a threshold computed per pixel from its neighbourhood.
///
/// Sauvola's rule: `t = mean * (1 + k * (stddev / R - 1))`. Where the
/// neighbourhood is flat — blank paper, however brightly or dimly lit — the
/// standard deviation is small and the threshold sits well below the local
/// mean, so paper stays paper. Where there is a stroke, the deviation is large
/// and the threshold rises to meet it.
///
/// This is what a single global cutoff cannot do. At a fixed 128 a shadowed
/// corner is simply below the line, and the whole corner turns black —
/// measured at 15.6% ink on a page that should carry about 5%.
pub fn binarize_adaptive_rgba(rgba: &mut [u8], width: u32, height: u32, brightness: i32) {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        // Nothing spatial is possible; fall back rather than leave it untouched.
        binarize_rgba(rgba, brightness);
        return;
    }

    let plane = luma_plane(rgba);
    let integral = Integral::new(&plane, w, h);
    let r = window_radius(w, h, THRESHOLD_WINDOW);

    let dark = brightness.clamp(0, 255) as u8;
    let light = (255 + brightness).clamp(0, 255) as u8;

    for y in 0..h {
        for x in 0..w {
            let (mean, variance) = integral.window(x, y, r);
            let threshold = mean * (1.0 + SAUVOLA_K * (variance.sqrt() / SAUVOLA_R - 1.0));
            let value = if f32::from(plane[y * w + x]) > threshold {
                light
            } else {
                dark
            };
            let px = &mut rgba[(y * w + x) * 4..][..4];
            px[0] = value;
            px[1] = value;
            px[2] = value;
        }
    }
}

/// Contrast-stretch `rgba` in place, then shift it by `brightness`.
///
/// One histogram pass and one lookup pass, whatever the image size. Global, and
/// therefore blind to how the light fell: prefer [`enhance_page_rgba`] for a
/// photograph. This remains for input that is already evenly lit — a PDF
/// render, a flatbed scan — where it is both correct and cheaper.
pub fn enhance_rgba(rgba: &mut [u8], brightness: i32) {
    let hist = luma_histogram(rgba);
    let lut = stretch_lut(&hist, brightness).unwrap_or_else(|| brightness_lut(brightness));
    apply_lut_rgba(rgba, &lut);
}

/// Flatten the lighting, then stretch what is left.
///
/// The order matters and is the whole point. On a shadowed photograph the
/// stretch alone achieves almost nothing — the shadow contributes the darkest
/// pixel and the lit corner the brightest, so the 1st and 99th percentiles are
/// already near 0 and 255 and the lookup table is nearly the identity. Measured
/// on a page photo with an ordinary hand-held gradient, the stretch alone moved
/// paper coverage from 32.7% to 35.8%; flattening first takes it to 94.5%.
pub fn enhance_page_rgba(rgba: &mut [u8], width: u32, height: u32, brightness: i32) {
    // First, before anything has clipped. Both of the steps below raise the
    // page toward white, and the channel the cast had already pushed highest
    // reaches 255 first — after that its true value is gone and the ratio the
    // correction needs cannot be recovered. Measured: run last, the estimator
    // sees a paper reference of exactly (255, 255, 255) on a page whose paper
    // is plainly cream, computes gains of 1.0, and does nothing at all.
    neutralise_paper_rgba(rgba);
    flatten_illumination_rgba(rgba, width, height);
    enhance_rgba(rgba, brightness);
}

/// How far the paper's own colour is allowed to be corrected.
///
/// A gain of 1.0 is no change. The ceiling exists because the correction is a
/// division: on a page photographed through a strong colour filter the weakest
/// channel can be near zero, and an uncapped gain would turn its sensor noise
/// into confetti. Beyond this the page is left partly tinted, which is honest —
/// it says the light was too coloured to recover rather than inventing detail.
const MAX_CAST_GAIN: f32 = 1.8;

/// Below this the cast is not worth correcting: it is within the spread of an
/// ordinary white page under ordinary light, and touching it would only add
/// rounding error.
const CAST_FLOOR: f32 = 1.02;

/// Make the paper grey, so a warm lamp stops being part of the document.
///
/// `flatten_illumination_rgba` derives one gain per window from the *luma* and
/// applies it to all three channels alike. That evens out how bright the page
/// is and cannot touch what colour it is, so a page shot under a desk lamp came
/// out of Enhance as bright cream — measured at 255, 240, 208 against the
/// 243, 244, 239 of a neutral original. The site promises the paper reads
/// white, so the missing step is this one.
///
/// The estimate is a white patch rather than a grey world: the brightest fifth
/// of the page *is* the paper, and averaging the whole image instead would let
/// a dark photograph or a wide ink block drag the reference off. Channels are
/// only ever raised, never cut, so the correction cannot darken a page that was
/// already neutral.
pub fn neutralise_paper_rgba(rgba: &mut [u8]) {
    if rgba.len() < 4 {
        return;
    }

    // The luma above which a pixel counts as paper: the 80th percentile, so
    // ink, shadow and any photograph on the page are excluded.
    let hist = luma_histogram(rgba);
    let total: u32 = hist.iter().sum();
    if total == 0 {
        return;
    }
    let cut = (total as f32 * 0.80) as u32;
    let mut seen = 0u32;
    let mut paper_from = 255u8;
    for (value, count) in hist.iter().enumerate() {
        seen += count;
        if seen >= cut {
            paper_from = value as u8;
            break;
        }
    }

    let (mut sum_r, mut sum_g, mut sum_b, mut n) = (0u64, 0u64, 0u64, 0u64);
    for px in rgba.chunks_exact(4) {
        // The shared `luma`, not a second copy of the same weights. The
        // threshold above comes out of `luma_histogram`, which rounds; an
        // inline truncating version put paper at 220 against a threshold of
        // 221, selected nothing, and made this whole function a no-op.
        if luma(px[0], px[1], px[2]) >= paper_from {
            sum_r += px[0] as u64;
            sum_g += px[1] as u64;
            sum_b += px[2] as u64;
            n += 1;
        }
    }
    if n == 0 {
        return;
    }

    let (r, g, b) = (sum_r as f32 / n as f32, sum_g as f32 / n as f32, sum_b as f32 / n as f32);
    let target = r.max(g).max(b);
    if target <= 0.0 {
        return;
    }
    let gains = [target / r.max(1.0), target / g.max(1.0), target / b.max(1.0)];

    // Nothing to do on a page that is already neutral.
    if gains.iter().all(|gain| *gain < CAST_FLOOR) {
        return;
    }

    let luts: Vec<Lut> = gains
        .iter()
        .map(|gain| {
            let gain = gain.clamp(1.0, MAX_CAST_GAIN);
            let mut lut = [0u8; 256];
            for (value, out) in lut.iter_mut().enumerate() {
                *out = ((value as f32 * gain).round() as i32).clamp(0, 255) as u8;
            }
            lut
        })
        .collect();

    for px in rgba.chunks_exact_mut(4) {
        px[0] = luts[0][px[0] as usize];
        px[1] = luts[1][px[1] as usize];
        px[2] = luts[2][px[2] as usize];
    }
}

/// Binarizes the image for document-scan readability: pixels are mapped to
/// pure black or pure white based on a fixed luma threshold (not just
/// grayscale/desaturation).
pub fn to_black_and_white(img: &DynamicImage) -> DynamicImage {
    let mut rgba = img.to_rgba8();
    binarize_rgba(&mut rgba, 0);
    DynamicImage::ImageRgba8(rgba)
}

/// Shifts brightness by `delta` (positive brightens, negative darkens),
/// clamping each channel to the valid [0, 255] range.
pub fn adjust_brightness(img: &DynamicImage, delta: i32) -> DynamicImage {
    let mut rgba = img.to_rgba8();
    apply_lut_rgba(&mut rgba, &brightness_lut(delta));
    DynamicImage::ImageRgba8(rgba)
}

/// Adaptive contrast enhancement for scanned pages: stretches the luma
/// histogram so the effective darkest and lightest values expand toward
/// black/white, improving readability of low-contrast scans.
///
/// An image with no usable spread — no pixels at all, or a flat one — is
/// returned unchanged: there is no histogram to read percentiles from.
pub fn enhance(img: &DynamicImage) -> DynamicImage {
    let mut rgba = img.to_rgba8();
    let hist = luma_histogram(&rgba);
    match stretch_lut(&hist, 0) {
        Some(lut) => {
            apply_lut_rgba(&mut rgba, &lut);
            DynamicImage::ImageRgba8(rgba)
        }
        None => img.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageBuffer, Rgb};

    /// Builds an RGB image of `width x height` where every pixel is the
    /// same gray value `v` (so channel value == luma).
    fn gray_image(width: u32, height: u32, v: u8) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_pixel(width, height, Rgb([v, v, v])))
    }

    fn average_luma(img: &DynamicImage) -> f64 {
        let luma = img.to_luma8();
        let sum: u64 = luma.pixels().map(|p| p.0[0] as u64).sum();
        sum as f64 / luma.pixels().len() as f64
    }

    /// A narrow page whose small print fills its width, which is what a till
    /// receipt is and what the illumination estimate used to get wrong.
    ///
    /// `paper` and `ink` are close together on purpose: thermal print is grey
    /// on grey, and that is the case where lifting the ink along with the paper
    /// destroys the page.
    fn dense_receipt(width: u32, height: u32, paper: u8, ink: u8) -> Vec<u8> {
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            // A line of print every 14 rows, 5 rows tall: about a third of the
            // page is ink, which is a receipt rather than a letter.
            let printing = y % 14 < 5 && y > 20 && y < height - 20;
            for x in 0..width {
                // A margin, and gaps between the characters, so the page is not
                // one solid bar.
                let on_paper = x > 12 && x < width - 12;
                let stroke = printing && on_paper && (x / 3) % 2 == 0;
                let value = if stroke { ink } else { paper };
                let i = ((y * width + x) * 4) as usize;
                rgba[i] = value;
                rgba[i + 1] = value;
                rgba[i + 2] = value;
                rgba[i + 3] = 255;
            }
        }
        rgba
    }

    fn luma_at(rgba: &[u8], quantile: f64) -> f64 {
        let mut l: Vec<u8> = rgba.chunks_exact(4).map(|p| luma(p[0], p[1], p[2])).collect();
        l.sort_unstable();
        f64::from(l[((l.len() - 1) as f64 * quantile) as usize])
    }

    /// The illumination estimate has to track the paper, not the print.
    ///
    /// It was a box mean over a wide window, on the reasoning that text is
    /// small and dark so a wide window averages mostly paper. That holds for a
    /// double-spaced A4 and fails for the thing people photograph most: on a
    /// till receipt the small print fills the width of a narrow page, the mean
    /// sits well below the paper, and the gain comes out too high. Here that
    /// shows as the paper overshooting its target and clipping — 255 instead
    /// of 245 — which is the headroom the next step needs.
    ///
    /// On a flat synthetic that is the whole of the damage. On a photograph,
    /// where the light falls unevenly and the print is dense in some places and
    /// not others, the overshoot varies across the page and takes the local
    /// contrast with it: a photographed till receipt came back as faint grey on
    /// white, and of thirty words printed on it the recogniser found six. This
    /// test covers the mechanism; `apps/web/e2e/receipt-ocr.spec.mjs` covers
    /// the path it sits in.
    #[test]
    fn the_paper_estimate_follows_the_paper_not_the_print() {
        let (w, h) = (300u32, 900u32);
        let mut page = dense_receipt(w, h, 170, 110);
        flatten_illumination_rgba(&mut page, w, h);

        let paper = luma_at(&page, 0.9);
        assert!(
            (240.0..=250.0).contains(&paper),
            "the paper should land on its target with headroom to spare, got {paper} \
             — above 250 the estimate is reading the print as if it were shadow"
        );

        // And the print must still be print: the ratio it had to the paper is
        // what the flattening is supposed to preserve.
        let print = luma_at(&page, 0.05);
        let ratio = print / paper;
        assert!(
            (0.60..=0.70).contains(&ratio),
            "the print's depth against the paper changed: {print}/{paper} = {ratio:.2}, \
             it was 110/170 = 0.65 before"
        );
    }
    #[test]
    fn binarizes_below_and_above_threshold_pixels_to_pure_black_and_white() {
        // 2x1 image: pixel 0 has luma clearly below BW_THRESHOLD (128),
        // pixel 1 clearly above it. Gray pixels so channel value == luma.
        let mut buf: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::new(2, 1);
        buf.put_pixel(0, 0, Rgb([50, 50, 50]));
        buf.put_pixel(1, 0, Rgb([200, 200, 200]));
        let img = DynamicImage::ImageRgb8(buf);

        let out = to_black_and_white(&img).to_rgb8();

        assert_eq!(*out.get_pixel(0, 0), Rgb([0, 0, 0]));
        assert_eq!(*out.get_pixel(1, 0), Rgb([255, 255, 255]));
    }

    #[test]
    fn increasing_brightness_raises_average_luma_by_approximately_delta() {
        let img = gray_image(5, 5, 128);
        let delta = 40;

        let out = adjust_brightness(&img, delta);

        let before = average_luma(&img);
        let after = average_luma(&out);
        let diff = after - before;
        assert!(
            (diff - delta as f64).abs() <= 5.0,
            "expected luma to increase by ~{delta}, got {diff}"
        );
    }

    #[test]
    fn brightening_a_near_white_image_clamps_at_255() {
        let img = gray_image(4, 4, 250);

        let out = adjust_brightness(&img, 40).to_rgb8();

        for pixel in out.pixels() {
            assert_eq!(*pixel, Rgb([255, 255, 255]));
        }
    }

    #[test]
    fn darkening_a_near_black_image_clamps_at_0() {
        let img = gray_image(4, 4, 5);

        let out = adjust_brightness(&img, -40).to_rgb8();

        for pixel in out.pixels() {
            assert_eq!(*pixel, Rgb([0, 0, 0]));
        }
    }

    #[test]
    fn enhance_stretches_a_narrow_luma_band_toward_black_and_white() {
        // Explicit low-contrast image: luma values confined to 100-140.
        let values: [u8; 9] = [100, 105, 110, 115, 120, 125, 130, 135, 140];
        let mut buf: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::new(values.len() as u32, 1);
        for (x, &v) in values.iter().enumerate() {
            buf.put_pixel(x as u32, 0, Rgb([v, v, v]));
        }
        let img = DynamicImage::ImageRgb8(buf);

        let out = enhance(&img);

        let (in_min, in_max) = (*values.iter().min().unwrap(), *values.iter().max().unwrap());
        let out_luma = out.to_luma8();
        let out_min = out_luma.pixels().map(|p| p.0[0]).min().unwrap();
        let out_max = out_luma.pixels().map(|p| p.0[0]).max().unwrap();

        assert!(
            out_min < in_min,
            "expected stretched min {out_min} < original min {in_min}"
        );
        assert!(
            out_max > in_max,
            "expected stretched max {out_max} > original max {in_max}"
        );
    }

    /// A zero-pixel image has no histogram, so the 99th-percentile index
    /// computation used to underflow (`len - 1` on `len == 0`) and panic
    /// before the flat-image guard could return. `image` permits zero
    /// dimensions, so this is constructible — and a filter panicking on a
    /// buffer it was handed is never the right answer.
    #[test]
    fn enhancing_a_zero_pixel_image_returns_it_unchanged() {
        for (width, height) in [(0u32, 0u32), (0, 8), (8, 0)] {
            let img = DynamicImage::ImageRgb8(ImageBuffer::new(width, height));

            let out = enhance(&img);

            assert_eq!(
                out.to_rgb8().dimensions(),
                (width, height),
                "{width}x{height}: dimensions should survive untouched"
            );
        }
    }

    /// A page photographed by hand: even text, lit from one side.
    ///
    /// Every filter fixture in this file before these was evenly lit — a flat
    /// synthetic image or a PDF render — which is exactly the input that cannot
    /// expose a global filter's blind spot. The shadow is the product's normal
    /// case, and nothing tested it.
    /// A page under a warm lamp: white paper, dark text, an even warm cast.
    ///
    /// The cast holds the blue channel down and green a little, because that is
    /// what a tungsten bulb does to a phone sensor.
    fn warm_page(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let on_a_line = (y / 8) % 3 == 0 && x > width / 10 && x < width * 9 / 10;
                let base: f32 = if on_a_line && (x / 3) % 4 != 0 { 45.0 } else { 235.0 };
                // Warm light: red passes, green loses a little, blue loses most.
                let r = base.min(255.0);
                let g = (base * 0.94).min(255.0);
                let b = (base * 0.80).min(255.0);
                rgba.extend_from_slice(&[r as u8, g as u8, b as u8, 255]);
            }
        }
        rgba
    }

    /// The mean colour of the blank lower band, which is what the report
    /// measured in the exported PDF.
    fn paper_mean(rgba: &[u8], width: u32, height: u32) -> (f32, f32, f32) {
        let (w, h) = (width as usize, height as usize);
        let from = h * 3 / 4;
        let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
        for y in from..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                // Paper only: skip anything dark enough to be ink.
                if rgba[i] as u32 + rgba[i + 1] as u32 + rgba[i + 2] as u32 > 330 {
                    r += rgba[i] as u64;
                    g += rgba[i + 1] as u64;
                    b += rgba[i + 2] as u64;
                    n += 1;
                }
            }
        }
        assert!(n > 0, "no paper found to measure");
        (r as f32 / n as f32, g as f32 / n as f32, b as f32 / n as f32)
    }

    fn shadowed_page(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                // Text: dark bars over part of every eighth row.
                let on_a_line = (y / 8) % 3 == 0 && x > width / 10 && x < width * 9 / 10;
                let base: f32 = if on_a_line && (x / 3) % 4 != 0 {
                    40.0
                } else {
                    235.0
                };
                // The light falls off to the right and down.
                let fx = x as f32 / width as f32;
                let fy = y as f32 / height as f32;
                let gain = (1.0 - 0.45 * fx.powf(1.3) - 0.25 * fy.powf(1.6)).clamp(0.30, 1.0);
                let v = (base * gain).round().clamp(0.0, 255.0) as u8;
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        rgba
    }

    fn paper_fraction(rgba: &[u8]) -> f64 {
        let hist = luma_histogram(rgba);
        let total: u64 = hist.iter().map(|&c| u64::from(c)).sum();
        let paper: u64 = hist[200..].iter().map(|&c| u64::from(c)).sum();
        paper as f64 / total as f64
    }

    fn ink_fraction(rgba: &[u8]) -> f64 {
        let hist = luma_histogram(rgba);
        let total: u64 = hist.iter().map(|&c| u64::from(c)).sum();
        let ink: u64 = hist[..60].iter().map(|&c| u64::from(c)).sum();
        ink as f64 / total as f64
    }

    /// The measurement that names the defect: a global stretch cannot fix a
    /// gradient, because the gradient supplies both ends of the histogram.
    #[test]
    fn the_global_stretch_cannot_rescue_a_shadowed_page() {
        let mut rgba = shadowed_page(400, 520);
        let before = paper_fraction(&rgba);
        enhance_rgba(&mut rgba, 0);
        let after = paper_fraction(&rgba);

        assert!(
            after - before < 0.15,
            "the global stretch moved paper coverage {before:.3} -> {after:.3}; if this \
             ever passes, the stretch has started doing something spatial and these \
             tests need rewriting rather than deleting"
        );
    }

    /// Stated as a comparison rather than an absolute. This fixture's synthetic
    /// text is far denser than a real page's — roughly a fifth of it is ink
    /// against a document's few percent — so an absolute paper threshold would
    /// be measuring the fixture rather than the filter. What has to be true is
    /// that flattening beats not flattening, by a wide margin, on the same
    /// bytes. On a real page photo the same change reads 35.8% -> 94.8%.
    #[test]
    fn flattening_beats_the_global_stretch_on_the_same_page() {
        let original = shadowed_page(400, 520);

        let mut stretched = original.clone();
        enhance_rgba(&mut stretched, 0);

        let mut flattened = original.clone();
        enhance_page_rgba(&mut flattened, 400, 520, 0);

        let before = paper_fraction(&original);
        let global = paper_fraction(&stretched);
        let spatial = paper_fraction(&flattened);

        assert!(
            spatial > global + 0.30,
            "flattening should recover far more paper than the stretch alone: \
             original {before:.3}, stretch {global:.3}, flattened {spatial:.3}"
        );
        assert!(
            spatial > 0.70,
            "and most of the page should be paper again, got {spatial:.3}"
        );
    }

    /// The black wedge. A fixed cutoff puts the whole shadowed corner below the
    /// line, so a page that should carry a few percent of ink turns a sixth
    /// black.
    #[test]
    fn a_fixed_threshold_turns_the_shadow_into_ink() {
        let mut rgba = shadowed_page(400, 520);
        binarize_rgba(&mut rgba, 0);
        assert!(
            ink_fraction(&rgba) > 0.12,
            "the fixed threshold used to flood the shadow; if it no longer does, \
             BW_THRESHOLD has changed and this test is measuring nothing"
        );
    }

    #[test]
    fn the_adaptive_threshold_keeps_the_shadow_as_paper() {
        let mut rgba = shadowed_page(400, 520);
        binarize_adaptive_rgba(&mut rgba, 400, 520, 0);

        let ink = ink_fraction(&rgba);
        let paper = paper_fraction(&rgba);
        assert!(paper > 0.70, "expected mostly paper, got {paper:.3}");
        assert!(
            ink < 0.30,
            "expected the text and not the shadow, got {ink:.3} ink"
        );
        assert!(ink > 0.02, "the text must survive; got {ink:.3} ink");
    }

    /// Binarizing means two values and nothing between them, whatever the
    /// threshold was computed from.
    #[test]
    fn the_adaptive_threshold_still_produces_two_values() {
        let mut rgba = shadowed_page(120, 160);
        binarize_adaptive_rgba(&mut rgba, 120, 160, 0);
        let mut seen: Vec<u8> = rgba.as_chunks::<4>().0.iter().map(|px| px[0]).collect();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen, vec![0, 255], "expected pure black and white only");
    }

    /// Evenly lit input must not be made worse by machinery that exists for
    /// uneven input.
    #[test]
    fn flattening_leaves_an_already_flat_page_alone() {
        let flat: Vec<u8> = (0..200 * 200)
            .flat_map(|i| {
                let v = if i % 97 == 0 { 40 } else { 235 };
                [v, v, v, 255]
            })
            .collect();
        let mut rgba = flat.clone();
        flatten_illumination_rgba(&mut rgba, 200, 200);

        let before = paper_fraction(&flat);
        let after = paper_fraction(&rgba);
        assert!(
            (after - before).abs() < 0.05,
            "flattening moved an already-flat page {before:.3} -> {after:.3}"
        );
    }

    /// A buffer that does not match the dimensions must not index past its end.
    #[test]
    fn the_spatial_filters_refuse_a_mismatched_buffer() {
        let mut rgba = vec![128u8; 4 * 10];
        flatten_illumination_rgba(&mut rgba, 1000, 1000);
        binarize_adaptive_rgba(&mut rgba, 1000, 1000, 0);
        assert_eq!(rgba.len(), 40, "the buffer must be left as it was");
    }

    #[test]
    fn enhance_takes_the_warm_light_out_of_the_paper() {
        // The reported defect: Enhance lifted the brightness and left the
        // colour alone, so a page under a desk lamp came out cream. Measured
        // in the report at 255, 240, 208 — a 47-point spread across channels.
        let (w, h) = (240, 240);
        let mut before = warm_page(w, h);
        let (r0, g0, b0) = paper_mean(&before, w, h);
        let spread_before = r0.max(g0).max(b0) - r0.min(g0).min(b0);

        enhance_page_rgba(&mut before, w, h, 0);
        let (r1, g1, b1) = paper_mean(&before, w, h);
        let spread_after = r1.max(g1).max(b1) - r1.min(g1).min(b1);

        assert!(
            spread_before > 30.0,
            "the fixture is not warm enough to be a test: spread {spread_before:.1}"
        );
        assert!(
            spread_after < 8.0,
            "paper still carries a cast: {r1:.0}, {g1:.0}, {b1:.0} (spread {spread_after:.1})"
        );
        assert!(r1 > 230.0 && g1 > 230.0 && b1 > 230.0, "paper is not white: {r1:.0}, {g1:.0}, {b1:.0}");
    }

    #[test]
    fn a_neutral_page_is_left_alone() {
        // The correction only ever raises a channel, and only when there is a
        // cast to remove. A page that was already grey must come out the same
        // shade rather than being pushed somewhere new.
        let (w, h) = (240, 240);
        let mut page = shadowed_page(w, h);
        let mut untouched = page.clone();
        neutralise_paper_rgba(&mut page);
        enhance_page_rgba(&mut untouched, w, h, 0);

        let (r, g, b) = paper_mean(&page, w, h);
        let spread = r.max(g).max(b) - r.min(g).min(b);
        assert!(spread < 2.0, "a neutral page gained a cast: {r:.0}, {g:.0}, {b:.0}");
    }

    #[test]
    fn a_page_photographed_through_deep_colour_is_not_amplified_into_noise() {
        // An extreme cast is capped rather than divided out: the weakest
        // channel would otherwise be multiplied by a large number, and all
        // that is left down there is sensor noise.
        let (w, h) = (120, 120);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            rgba.extend_from_slice(&[230, 90, 20, 255]);
        }
        neutralise_paper_rgba(&mut rgba);
        // 230/20 would be a gain of 11.5; the cap holds it to 1.8.
        let blue = rgba[2] as f32;
        assert!(blue <= 20.0 * MAX_CAST_GAIN + 1.0, "blue was amplified to {blue}");
    }
}

#[cfg(test)]
mod receipt_probe {
    use super::*;

    fn stats(label: &str, rgba: &[u8]) {
        let mut l: Vec<u8> = rgba.chunks_exact(4).map(|p| luma(p[0], p[1], p[2])).collect();
        l.sort_unstable();
        let at = |q: f64| f64::from(l[((l.len() - 1) as f64 * q) as usize]);
        let ink = l.iter().filter(|v| **v < 128).count() as f64 / l.len() as f64;
        let darkest = l[..l.len() / 20].iter().map(|v| f64::from(*v)).sum::<f64>()
            / (l.len() / 20) as f64;
        println!("{label:28} p5 {:5.1}  median {:5.1}  p95 {:5.1}  ink<128 {:5.2}%  darkest5% {:5.1}",
                 at(0.05), at(0.5), at(0.95), 100.0 * ink, darkest);
    }

    #[test]
    fn what_enhance_does_to_a_thermal_receipt() {
        let Ok(path) = std::env::var("DOCSCAN_RECEIPT") else { return };
        let img = image::open(&path).expect("open").to_rgba8();
        // Receipt only — no hand, no keyboard. A rectified page is just paper,
        // and letting the dark surroundings into the crop hides what the
        // global stretch at the end of Enhance does, because they supply the
        // bottom of the histogram themselves.
        let crop = image::imageops::crop_imm(&img, 310, 210, 290, 1030).to_image();
        let (w, h) = crop.dimensions();
        let raw = crop.into_raw();

        stats("as photographed", &raw);
        let mut a = raw.clone();
        neutralise_paper_rgba(&mut a);
        stats("  after neutralise", &a);
        flatten_illumination_rgba(&mut a, w, h);
        stats("  after flatten", &a);
        enhance_rgba(&mut a, 0);
        stats("  after stretch (= Enhance)", &a);

        let mut bw = raw.clone();
        binarize_adaptive_rgba(&mut bw, w, h, 0);
        stats("B & W", &bw);

        if let Ok(dir) = std::env::var("DOCSCAN_OUT") {
            image::RgbaImage::from_raw(w, h, a).unwrap()
                .save(format!("{dir}/receipt-enhanced.png")).unwrap();
            image::RgbaImage::from_raw(w, h, bw).unwrap()
                .save(format!("{dir}/receipt-bw.png")).unwrap();
        }
    }

}
