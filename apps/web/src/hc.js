const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3001'
  : 'https://api.hcdavecloud.in';

let hcAuthToken = null;

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
      // Update UI proactively if tray is visible
      const btnSave = document.getElementById('btn-save');
      const btnSaveLocal = document.getElementById('btn-save-local');
      if (btnSave && btnSaveLocal) {
        btnSave.textContent = 'Save to HC Cloud';
        btnSaveLocal.hidden = false;
      }
      
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
    const targetOrigin = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ? 'http://localhost:3000'
      : 'https://hcdavecloud.in';
    window.opener.postMessage({ type: 'SCANNER_READY' }, targetOrigin);
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
