/**
 * Google identity — "Sign in with Google", shared with the Drive adapter.
 *
 * A detachment already runs on Google accounts: cadets read det mail through
 * Gmail whatever their school address says, and the det's drives are already
 * shared to those accounts. Issuing a second username and password for this app
 * duplicates an identity system everyone already carries, and creates the one
 * job admins actually do all day — resetting passwords.
 *
 * So the app stops storing credentials. `users/users.json` becomes a roster:
 * verified email, roles, AS level. Nothing secret lives in it.
 *
 * WHAT THIS CHECK IS WORTH. The ID token is validated here — issuer, audience,
 * expiry, verified email — but this runs in the browser, and a browser is under
 * the control of whoever is sitting at it. Client-side validation stops
 * mistakes, not attackers. The boundaries that actually hold are:
 *
 *   - **Google Drive sharing.** Reading or writing the det's folder requires an
 *     OAuth token issued to an account that has been granted access. Google
 *     enforces that, not this file.
 *   - **The submission proxy**, which re-verifies the same token
 *     server-side before it writes anything.
 *
 * Which is a better position than the password scheme it replaces: those hashes
 * sat in the same Drive folder as the data they protected.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

let gisPromise = null;
let initialisedFor = null;

/**
 * Loads Google Identity Services once, however many callers ask.
 *
 * `isReady` differs by caller and cannot be folded away: this module wants the
 * sign-in API, and the Drive adapter wants `accounts.oauth2` for the token
 * client, which appears at its own pace. What *was* worth folding away is the
 * loader — drive.js carried a byte-identical copy with its own `gisPromise`, so
 * a page that touched both could inject the script twice, each copy believing it
 * was the one loading it.
 *
 * @param {() => boolean} isReady  true when the part the caller needs exists
 */
export function loadGis(isReady = () => Boolean(window.google?.accounts)) {
  if (isReady()) return Promise.resolve();
  if (gisPromise) return gisPromise;

  gisPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisPromise = null;
      reject(new Error('Could not load Google sign-in. Check the network connection.'));
    };
    document.head.append(script);
  });
  return gisPromise;
}

/**
 * Decodes and sanity-checks a Google ID token.
 *
 * @returns {{email, emailVerified, name, picture, sub, hd, exp}}
 * @throws if the token is malformed, expired, for another app, or unverified.
 */
export function decodeIdToken(credential, clientId) {
  const parts = String(credential || '').split('.');
  if (parts.length !== 3) throw new Error('That sign-in response was not a valid token.');

  let claims;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    // atob yields Latin-1; re-decode as UTF-8 so accented names survive.
    claims = JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    throw new Error('That sign-in response could not be read.');
  }

  if (!ISSUERS.has(claims.iss)) throw new Error('That token was not issued by Google.');
  if (clientId && claims.aud !== clientId) {
    throw new Error('That sign-in was for a different application.');
  }
  if (Number(claims.exp) * 1000 < Date.now()) {
    throw new Error('That sign-in has expired. Try again.');
  }
  if (claims.email_verified === false) {
    throw new Error('That Google account has not verified its email address.');
  }
  if (!claims.email) throw new Error('That Google account did not return an email address.');

  const email = String(claims.email).trim().toLowerCase();
  return {
    email,
    emailVerified: claims.email_verified !== false,
    // Some accounts carry no display name. Falling back to the normalised email
    // keeps the roster from recording a mixed-case address as someone's name.
    name: claims.name || email,
    picture: claims.picture || null,
    sub: claims.sub,
    hd: claims.hd || null,       // Workspace domain, absent for personal accounts
    exp: Number(claims.exp),
  };
}

/**
 * Renders Google's own sign-in button into `target`.
 *
 * Google's rendered button is used rather than a custom one because it is the
 * only form that reliably survives their browser and cookie restrictions, and
 * because people recognise it.
 *
 * @param {HTMLElement} target
 * @param {{clientId: string, onCredential: (profile, raw) => void, onError: (err) => void}} options
 */
export async function renderSignInButton(target, { clientId, onCredential, onError }) {
  if (!clientId) throw new Error('No Google Client ID is configured.');
  await loadGis();

  // initialize() is global to the page, so only redo it when the id changes.
  if (initialisedFor !== clientId) {
    google.accounts.id.initialize({
      client_id: clientId,
      auto_select: false,
      cancel_on_tap_outside: true,
      callback: (response) => {
        try {
          onCredential(decodeIdToken(response.credential, clientId), response.credential);
        } catch (err) {
          onError(err);
        }
      },
    });
    initialisedFor = clientId;
  }

  target.replaceChildren();
  google.accounts.id.renderButton(target, {
    theme: document.documentElement.dataset.theme === 'dark' ? 'filled_black' : 'outline',
    size: 'large',
    text: 'signin_with',
    shape: 'rectangular',
    logo_alignment: 'left',
    width: Math.min(360, Math.max(240, target.clientWidth || 320)),
  });
}

/** Stops Google silently re-selecting the last account after a sign-out. */
export function forgetGoogleSession() {
  try {
    window.google?.accounts?.id?.disableAutoSelect?.();
  } catch { /* GIS not loaded; nothing to forget */ }
}
