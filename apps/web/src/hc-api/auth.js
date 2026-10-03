/**
 * HC Cloud Authentication Layer
 * Handles the secure postMessage handshake with the parent/opener window.
 */

let hcToken = null;
let isReady = false;

// Generate a random nonce for this session
const sessionNonce = Math.random().toString(36).substring(2, 15);

export function initAuth() {
  if (isReady) return;
  isReady = true;

  // Listen for the incoming token from the parent window
  window.addEventListener('message', (event) => {
    // Only accept messages from the main HC Cloud domain
    if (event.origin !== 'https://drive.hcdavecloud.in') {
      return;
    }

    if (event.data?.type !== 'HC_SCANNER_AUTH') {
      return;
    }

    // Verify the nonce to prevent replay/early injection
    if (event.data.nonce !== sessionNonce) {
      console.warn('HC Scanner: Nonce mismatch on auth token');
      return;
    }

    if (event.data.token) {
      hcToken = event.data.token;
      console.log('HC Scanner: Securely received authentication token.');
    }
  });

  // Signal the parent window that we are ready to receive the token
  const readyMessage = {
    type: 'SCANNER_READY',
    nonce: sessionNonce
  };

  const targetOrigin = 'https://drive.hcdavecloud.in';

  if (window.opener) {
    window.opener.postMessage(readyMessage, targetOrigin);
  } else if (window.parent !== window) {
    window.parent.postMessage(readyMessage, targetOrigin);
  } else {
    console.warn('HC Scanner: No opener/parent window found. Running standalone.');
  }
}

export function getToken() {
  return hcToken;
}
