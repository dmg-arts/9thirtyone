/**
 * Device-local state: display settings, the saved storage connection, and the
 * cadre session. None of this is org data — org data lives in the Drive folder.
 */

import { LS, DEFAULT_SETTINGS } from './config.js';

/* ------------------------------------------------------------------ *
 * tiny observable store
 * ------------------------------------------------------------------ */

function createStore(key, fallback) {
  let value = load();
  const listeners = new Set();

  function load() {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return structuredClone(fallback);
      return { ...structuredClone(fallback), ...JSON.parse(raw) };
    } catch {
      return structuredClone(fallback);
    }
  }

  function persist() {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn(`[state] could not persist ${key}`, err);
    }
  }

  return {
    get: () => value,
    set(patch) {
      value = { ...value, ...patch };
      persist();
      listeners.forEach((fn) => fn(value));
      return value;
    },
    replace(next) {
      value = { ...structuredClone(fallback), ...next };
      persist();
      listeners.forEach((fn) => fn(value));
      return value;
    },
    reset() {
      return this.replace({});
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/* ------------------------------------------------------------------ *
 * settings (display preferences)
 * ------------------------------------------------------------------ */

export const settings = createStore(LS.settings, DEFAULT_SETTINGS);

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

/** Writes the current settings onto <html> as data-attributes. */
export function applySettings(next = settings.get()) {
  const root = document.documentElement;
  const theme = next.theme === 'system' ? (prefersDark.matches ? 'dark' : 'light') : next.theme;
  root.dataset.theme = theme;
  root.dataset.palette = next.palette || 'default';
  root.dataset.contrast = next.contrast || 'normal';
  root.dataset.textsize = next.textSize || 'md';
  root.dataset.motion = next.reduceMotion ? 'reduced' : 'full';

  // Keep the browser/OS chrome in step with the app.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', theme === 'dark' ? '#161b22' : '#ffffff');
  }
}

settings.subscribe(applySettings);
prefersDark.addEventListener('change', () => {
  if (settings.get().theme === 'system') applySettings();
});

/* ------------------------------------------------------------------ *
 * connection (which storage backend, and where)
 * ------------------------------------------------------------------ */

/**
 * Shape:
 *   { backend, orgName, folderId, folderName, folderUrl, clientId, proxyUrl, connectedAt }
 * `proxyUrl` is the deployed Apps Script web app, when the detachment has one.
 * It belongs here rather than in shared settings because a cadet in proxy mode
 * cannot read shared settings — they have no Drive access. It arrives in their
 * join link instead.
 * `folderId` is a Drive file id for the `drive` backend; for `folder` it is the
 * IndexedDB key of the saved FileSystemDirectoryHandle.
 */
export const connection = createStore(LS.connection, {
  backend: null,
  orgName: '',
  folderId: '',
  folderName: '',
  folderUrl: '',
  /*
   * Empty until a backend that needs Google supplies one.
   *
   * The shared verified client is applied by the Drive path in the setup wizard,
   * and arrives in a join link for everyone else. It is deliberately *not* the
   * default here: an installation with no Client ID is a real state — *This
   * device only*, evaluated before any Google setup exists — and it is the state
   * the email sign-in option in Settings exists to serve. Defaulting this to the
   * shared client made that state unreachable and quietly retired a working
   * escape hatch, along with the copy in sign-in.js and settings.js explaining it.
   */
  clientId: '',
  proxyUrl: '',
  connectedAt: null,
});

/**
 * Forgets where the database is, without forgetting how to sign in.
 *
 * `connection.reset()` restores every field to its fallback, and the fallback for
 * `clientId` is deliberately empty — see the note above. That is right for a
 * device that never had one and wrong for a device that had the shared verified
 * client, because the two states are indistinguishable afterwards and only the
 * second one can be repaired. A Drive install that disconnected lost its Client
 * ID, so sign-in offered no Google button at all and sent the person to setup,
 * which was the one place that made things worse.
 *
 * Location is forgotten; identity configuration is kept. Any non-empty Client ID
 * survives, not merely the shared one — a detachment running its own registration
 * is stranded by exactly the same sequence, and keeping only the shared client
 * would fix the common case while leaving that one broken.
 *
 * A device-only install holds no Client ID to begin with, so it still ends at
 * empty and still gets the email sign-in that state exists to serve. Switching
 * *to* device-only deliberately is unaffected: the wizard's finish step writes an
 * empty Client ID for every backend but Drive.
 */
export function disconnectDevice() {
  const { clientId } = connection.get();
  connection.replace(clientId ? { clientId } : {});
}

export function isConfigured() {
  return Boolean(connection.get().backend) && localStorage.getItem(LS.setupComplete) === '1';
}

export function markSetupComplete(done = true) {
  if (done) localStorage.setItem(LS.setupComplete, '1');
  else localStorage.removeItem(LS.setupComplete);
}


/* ------------------------------------------------------------------ *
 * student view preferences (last-used filters, remembered name)
 * ------------------------------------------------------------------ */

export const studentPrefs = createStore(LS.studentPrefs, {
  schoolYear: '',
  semester: '',
  asClass: '',
});
