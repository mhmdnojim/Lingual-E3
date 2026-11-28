// Google Identity Services button. The public client ID is fetched from the server; ID tokens
// are posted back for verification and the server never trusts an identity supplied by the page.
import { deviceId } from './util.js';

let gisPromise;

function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      let script = document.querySelector('script[data-google-identity]');
      if (!script) {
        script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.dataset.googleIdentity = 'true';
        document.head.append(script);
      }
      script.addEventListener('load', () => window.google?.accounts?.id
        ? resolve(window.google.accounts.id) : reject(new Error('Google sign-in did not load.')),
      { once: true });
      script.addEventListener('error', () => reject(new Error('Google sign-in could not be reached.')),
        { once: true });
      if (window.google?.accounts?.id) resolve(window.google.accounts.id);
    }).catch((error) => {
      gisPromise = null;
      document.querySelector('script[data-google-identity]')?.remove();
      throw error;
    });
  }
  return gisPromise;
}

export async function mountGoogleButton(host, { endpoint = '/api/google-login', setupCode = '', onSuccess = () => {}, onError = () => {} } = {}) {
  host.replaceChildren();
  delete host.dataset.error;
  host.hidden = true;
  try {
    const response = await fetch('/api/google/config', { cache: 'no-store', credentials: 'same-origin' });
    const config = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(config.error || `Could not check Google sign-in (${response.status}).`);
    if (!config.enabled) return false;
    const identity = await loadGoogleIdentity();
    identity.initialize({
      client_id: config.clientId,
      nonce: config.nonce,
      callback: async ({ credential } = {}) => {
        if (!credential) { onError(new Error('Google did not return a sign-in credential.')); return; }
        try {
          const result = await fetch(endpoint, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential, device: deviceId(), adminSetupCode: setupCode() }),
          });
          const data = await result.json().catch(() => ({}));
          if (!result.ok) throw new Error(data.error || `Google sign-in failed (${result.status}).`);
          await onSuccess(data);
        } catch (error) {
          onError(error);
          // The server consumes the nonce even when an account/setup rule rejects sign-in.
          // Give the user a fresh nonce-bound Google button for another attempt.
          await mountGoogleButton(host, { endpoint, setupCode, onSuccess, onError });
        }
      },
    });
    identity.renderButton(host, {
      type: 'standard', theme: 'outline', size: 'large', shape: 'rectangular',
      text: 'continue_with',
      width: Math.max(240, Math.min(440, Math.floor(host.getBoundingClientRect().width || 320))),
    });
    host.hidden = false;
    return true;
  } catch (error) {
    host.dataset.error = error.message || 'Google sign-in could not be loaded.';
    onError(error);
    return false;
  }
}
