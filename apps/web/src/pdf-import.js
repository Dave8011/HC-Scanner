// Client-side, offline PDF import using local Mozilla PDF.js vendor library.

const SCRIPT_SRC = new URL('../vendor/pdfjs/pdf.min.js', import.meta.url).href;
const WORKER_SRC = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;

let pdfjsPromise = null;

export async function loadPdfJs() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
    return window.pdfjsLib;
  }
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.onload = () => {
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
          resolve(window.pdfjsLib);
        } else {
          reject(new Error('PDF.js failed to load'));
        }
      };
      script.onerror = () => reject(new Error('Failed to load ' + SCRIPT_SRC));
      document.head.appendChild(script);
    });
  }
  return pdfjsPromise;
}

/**
 * Render all or specific pages of a PDF into ImageData arrays.
 * @param {Blob|File|ArrayBuffer} fileOrBuffer
 * @param {number} maxEdge
 * @param {Function} [onProgress] (currentIndex, totalCount)
 * @returns {Promise<Array<{ imageData: ImageData, width: number, height: number, pageNumber: number }>>}
 */
export async function renderPdfPages(fileOrBuffer, maxEdge = 2400, onProgress = null) {
  const pdfjs = await loadPdfJs();
  const data = fileOrBuffer instanceof ArrayBuffer
    ? fileOrBuffer
    : await fileOrBuffer.arrayBuffer();

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;
  const pages = [];

  for (let i = 1; i <= numPages; i++) {
    if (onProgress) onProgress(i, numPages);
    const page = await pdfDoc.getPage(i);
    const baseViewport = page.getViewport({ scale: 1.0 });
    const longest = Math.max(baseViewport.width, baseViewport.height);
    
    // Scale for crisp resolution up to maxEdge, minimum 1.5x for clarity
    let scale = 1.5;
    if (longest > 0 && maxEdge > 0) {
      scale = Math.max(1.0, Math.min(2.5, maxEdge / longest));
    }
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Paint clean white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport,
    }).promise;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pages.push({
      imageData,
      width: canvas.width,
      height: canvas.height,
      pageNumber: i,
    });
  }

  return pages;
}
