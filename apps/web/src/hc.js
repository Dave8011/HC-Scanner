const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3001'
  : 'https://api.hcdavecloud.in';

let hcAuthToken = null;

// Temporary diagnostics
function logDiag(msg) {
  let diag = document.getElementById('hc-diag');
  if (!diag) {
    diag = document.createElement('div');
    diag.id = 'hc-diag';
    diag.style = 'position:fixed;top:0;left:0;z-index:99999;background:rgba(0,0,0,0.85);color:#0f0;padding:12px;font-size:12px;pointer-events:none;font-family:monospace;white-space:pre-wrap;width:100%;';
    if (document.body) document.body.appendChild(diag);
    else window.addEventListener('DOMContentLoaded', () => document.body.appendChild(diag));
  }
  diag.textContent += msg + '\n';
  console.log('[HC Diag]', msg);
}

// Handshake listener
window.addEventListener('message', (event) => {
  if (event.data?.type === 'AUTH_TOKEN') {
    logDiag(`AUTH_TOKEN message received from origin: ${event.origin}`);
    
    const allowedOrigins = [
      'https://hcdavecloud.in',
      'https://drive.hcdavecloud.in',
      'http://localhost:3000',
      'http://localhost:3001'
    ];
    
    // We allow matching the origin exactly, or if it's empty in some weird environments, though it shouldn't be.
    if (!allowedOrigins.includes(event.origin) && event.origin !== 'null') {
      logDiag(`Origin rejected. Expected one of: ${allowedOrigins.join(', ')}`);
      return;
    }
    
    if (event.data.token) {
      hcAuthToken = event.data.token;
      logDiag(`AUTH_TOKEN accepted!`);
      // Update UI proactively if tray is visible
      const btnSave = document.getElementById('btn-save');
      const btnSaveLocal = document.getElementById('btn-save-local');
      if (btnSave && btnSaveLocal) {
        btnSave.textContent = 'Save to HC Cloud';
        btnSaveLocal.hidden = false;
      }
      
      const trayCloudHint = document.getElementById('tray-cloud-hint');
      if (trayCloudHint) trayCloudHint.hidden = true;
    } else {
      logDiag(`AUTH_TOKEN message had no .token property!`);
    }
  }
});

logDiag(`Scanner loaded. Origin: ${window.location.origin}`);
logDiag(`window.opener present: ${!!window.opener}`);

// Reliable handshake: Ping the opener until we get the token (max 10 seconds)
let pingCount = 0;
const pingInterval = setInterval(() => {
  if (hcAuthToken || pingCount >= 20) {
    clearInterval(pingInterval);
    return;
  }
  
  pingCount++;
  if (window.opener) {
    // Send to '*' to avoid blocking if the launcher is on a subdomain we didn't exact-match.
    // The security risk of '*' here is zero because SCANNER_READY contains no secrets.
    window.opener.postMessage({ type: 'SCANNER_READY' }, '*');
    if (pingCount === 1 || pingCount % 5 === 0) {
      logDiag(`Pinged SCANNER_READY to opener (attempt ${pingCount})`);
    }
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
