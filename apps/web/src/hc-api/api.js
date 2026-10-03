import { getToken } from './auth.js';

/**
 * Perform an API request with the HC token automatically attached.
 */
async function fetchHcApi(endpoint, options = {}) {
  const token = getToken();
  if (!token) {
    throw new Error('HC Scanner: Not authenticated. Cannot perform API call.');
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`/api/hc${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HC API Error (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Fetch all available drives for the authenticated user.
 */
export async function getDrives() {
  return fetchHcApi('/drives');
}

/**
 * Fetch folders for a specific drive.
 */
export async function getFolders(driveId) {
  return fetchHcApi(`/folders?driveId=${encodeURIComponent(driveId)}`);
}

/**
 * Upload a scanned file to the HC Agent.
 * @param {Blob} file The PDF or JPG Blob
 * @param {string} filename The name of the file to save as
 * @param {string} driveId The destination drive ID
 * @param {string} folderPath The destination folder path
 */
export async function uploadScan(file, filename, driveId, folderPath) {
  const formData = new FormData();
  formData.append('file', file, filename);
  formData.append('driveId', driveId);
  formData.append('folderPath', folderPath);

  // Use the token directly instead of fetchHcApi because fetchHcApi expects JSON response
  // but we might just get a 200 OK or different format, let's keep it safe.
  const token = getToken();
  if (!token) {
    throw new Error('HC Scanner: Not authenticated.');
  }

  const response = await fetch('/api/hc/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HC Upload Error (${response.status}): ${errorText}`);
  }

  return response.json();
}
