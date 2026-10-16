const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3001'
  : 'https://api.hcdavecloud.in';

let hcAuthToken = null;

// Restore token if previously authorized in this session (e.g. across user reload)
try {
  const cachedToken = sessionStorage.getItem('hc_auth_token');
  if (cachedToken) {
    hcAuthToken = cachedToken;
    document.addEventListener('DOMContentLoaded', () => {
      document.body.classList.add('auth-ok');
      const trayCloudHint = document.getElementById('tray-cloud-hint');
      if (trayCloudHint) trayCloudHint.hidden = true;
    });
    if (document.body) {
      document.body.classList.add('auth-ok');
      const trayCloudHint = document.getElementById('tray-cloud-hint');
      if (trayCloudHint) trayCloudHint.hidden = true;
    }
  }
} catch (_) {}

/**
 * Normalizes and validates an HC Cloud URL, ensuring it redirects to HC Cloud Drive
 * (e.g. drive.hcdavecloud.in) and never to the unrouted apex domain (hcdavecloud.in).
 */
export function sanitizeCloudUrl(url) {
  const defaultUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://drive.hcdavecloud.in';

  if (!url || typeof url !== 'string') {
    return defaultUrl;
  }

  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return defaultUrl;
    }
    // Normalize apex domain or www to drive.hcdavecloud.in
    if (u.hostname === 'hcdavecloud.in' || u.hostname === 'www.hcdavecloud.in') {
      u.hostname = 'drive.hcdavecloud.in';
    }
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    const isHcCloud = u.hostname === 'drive.hcdavecloud.in' || u.hostname.endsWith('.hcdavecloud.in');
    if (!isLocal && !isHcCloud) {
      return defaultUrl;
    }
    return u.toString();
  } catch (_) {
    return defaultUrl;
  }
}

/**
 * Determines the target HC Cloud return URL.
 * Checks URL parameters, cached return URL in storage, referrer, or defaults to drive.hcdavecloud.in.
 */
export function getCloudUrl() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const qUrl = urlParams.get('returnUrl') || urlParams.get('cloudUrl');
    if (qUrl) {
      const clean = sanitizeCloudUrl(qUrl);
      try { localStorage.setItem('hc_cloud_return_url', clean); } catch (_) {}
      return clean;
    }

    const saved = localStorage.getItem('hc_cloud_return_url');
    if (saved) {
      const clean = sanitizeCloudUrl(saved);
      // Auto-repair if the saved value in localStorage was pointing to the apex domain
      if (clean !== saved) {
        try { localStorage.setItem('hc_cloud_return_url', clean); } catch (_) {}
      }
      return clean;
    }

    if (document.referrer) {
      const ref = sanitizeCloudUrl(document.referrer);
      if (document.referrer.includes('hcdavecloud.in') || document.referrer.includes('localhost:3000')) {
        try { localStorage.setItem('hc_cloud_return_url', ref); } catch (_) {}
        return ref;
      }
    }
  } catch (_) {}

  return (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://drive.hcdavecloud.in';
}

// Handshake listener
window.addEventListener('message', (event) => {
  if (event.data?.type === 'AUTH_TOKEN') {
    const allowedOrigins = [
      'https://hcdavecloud.in',
      'https://drive.hcdavecloud.in',
      'http://localhost:3000',
      'http://localhost:3001'
    ];
    
    if (!allowedOrigins.includes(event.origin) && event.origin !== 'null') {
      return;
    }
    
    if (window.opener && event.source !== window.opener) {
      return;
    }
    
    if (event.data.token) {
      hcAuthToken = event.data.token;
      try { sessionStorage.setItem('hc_auth_token', event.data.token); } catch (_) {}

      const rawCandidate = event.data.returnUrl || (event.origin && event.origin !== 'null' ? event.origin : null);
      if (rawCandidate) {
        const clean = sanitizeCloudUrl(rawCandidate);
        try { localStorage.setItem('hc_cloud_return_url', clean); } catch (_) {}
      }

      // Proactively update UI state class
      document.body.classList.add('auth-ok');
      
      const trayCloudHint = document.getElementById('tray-cloud-hint');
      if (trayCloudHint) trayCloudHint.hidden = true;
    }
  }
});

// Reliable handshake: Ping the opener until we get the token (max 10 seconds)
let pingCount = 0;
const pingInterval = setInterval(() => {
  if (hcAuthToken || pingCount >= 20) {
    clearInterval(pingInterval);
    return;
  }
  
  pingCount++;
  if (window.opener) {
    window.opener.postMessage({ type: 'SCANNER_READY' }, '*');
  } else {
    clearInterval(pingInterval);
  }
}, 500);

/**
 * Returns true if an authentication token is present in memory.
 */
export function getAuthState() {
  return hcAuthToken !== null;
}

/**
 * Fetches the available HC Cloud drives.
 */
export async function fetchDrives() {
  if (!hcAuthToken) throw new Error('401');
  
  const response = await fetch(`${API_BASE_URL}/api/hc/drives`, {
    headers: {
      'Authorization': `Bearer ${hcAuthToken}`
    }
  });
  
  if (!response.ok) {
    throw new Error(response.status.toString());
  }
  
  return response.json();
}

/**
 * Fetches the folders for a specific drive.
 */
export async function fetchFolders(driveId) {
  if (!hcAuthToken) throw new Error('401');
  
  const response = await fetch(`${API_BASE_URL}/api/hc/drives/${encodeURIComponent(driveId)}/folders`, {
    headers: {
      'Authorization': `Bearer ${hcAuthToken}`
    }
  });
  
  if (!response.ok) {
    throw new Error(response.status.toString());
  }
  
  return response.json();
}

/**
 * Uploads a document to HC Cloud, reporting progress.
 */
export function uploadDocument(file, driveId, folderId, filename, onProgress) {
  return new Promise((resolve, reject) => {
    if (!hcAuthToken) {
      reject(new Error('401'));
      return;
    }
    
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}/api/hc/upload`, true);
    xhr.setRequestHeader('Authorization', `Bearer ${hcAuthToken}`);
    
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (typeof onProgress === 'function') onProgress(100);
        resolve();
      } else {
        reject(new Error(xhr.status.toString()));
      }
    };
    
    xhr.onerror = () => {
      reject(new Error('NETWORK_ERROR'));
    };
    
    const formData = new FormData();
    formData.append('driveId', driveId);
    formData.append('folderId', folderId);
    formData.append('filename', filename);
    formData.append('file', file, filename);
    
    xhr.send(formData);
  });
}
