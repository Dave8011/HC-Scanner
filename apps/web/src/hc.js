const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3001'
  : 'https://api.hcdavecloud.in';

let hcAuthToken = null;
// Handshake listener
window.addEventListener('message', (event) => {
  const allowedOrigins = [
    'https://hcdavecloud.in',
    'https://drive.hcdavecloud.in'
  ];
  
  if (!allowedOrigins.includes(event.origin)) {
    return;
  }
  
  if (event.data && event.data.type === 'AUTH_TOKEN' && event.data.token) {
    hcAuthToken = event.data.token;
  }
});

// Signal to the opener (HC Cloud) that the scanner is ready for the token
if (window.opener) {
  // Use '*' for the targetOrigin here because we don't know the exact origin yet,
  // but we strictly validate the origin when receiving the token.
  window.opener.postMessage({ type: 'SCANNER_READY' }, '*');
}

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
