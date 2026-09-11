/**
 * `drive` backend — the org's own Google Drive, via the Drive REST API.
 *
 * This is the backend that works everywhere, including phones. The detachment
 * owns the Google account, the Cloud project, and the folder; this app only ever
 * holds a short-lived access token issued to the person sitting at the device.
 *
 * Setup on the org's side (once):
 *   1. Sign in to the detachment's Google account.
 *   2. console.cloud.google.com -> new project -> enable the Google Drive API.
 *   3. OAuth consent screen -> Internal (Workspace) or External + add testers.
 *   4. Credentials -> OAuth client ID -> Web application.
 *      Authorised JavaScript origins must include wherever this app is served.
 *   5. Paste the Client ID into setup, and paste the folder's share link.
 *
 * A browser OAuth client ID is public by design; it is an identifier, not a
 * secret. Access is still gated by Google's sign-in and the folder's own
 * sharing settings.
 */

import { loadGis as loadSharedGis } from '../google-identity.js';

/**
 * The narrowest scope that does the job.
 *
 * `drive.file` grants access to files this app created, and nothing else. It
 * cannot see the rest of somebody's Drive, which is both the honest permission
 * to ask for and the one that keeps this app out of Google's restricted tier —
 * `auth/drive` is restricted, and restricted means verification plus an annual
 * third-party security assessment for a free tool nobody is selling.
 *
 * The consequence is the reason setup creates the folder rather than asking for
 * a link to one: a folder made by hand in Drive is invisible under this scope,
 * because the app did not create it. The grant is recorded per user, per app,
 * per file on Google's side, so the same account keeps access from any device.
 */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const TOKEN_KEY = 'nine31.drive.token';

let tokenClient = null;
let config = { clientId: '', rootId: '' };
/** path (relative to root) -> Drive file id. Cleared on reconnect. */
const idCache = new Map();

export const driveAdapter = {
  id: 'drive',
  label: 'Google Drive (detachment account)',

  isAvailable: () => window.isSecureContext,

  configure({ clientId, folderId }) {
    if (config.clientId !== clientId || config.rootId !== folderId) idCache.clear();
    config = { clientId: (clientId || '').trim(), rootId: (folderId || '').trim() };
  },

  /**
   * Ensures a usable access token. `interactive: false` attempts a silent
   * refresh and resolves to null rather than showing Google's popup, so
   * background refreshes never steal focus.
   */
  async authorize({ interactive = true } = {}) {
    const cached = readToken();
    if (cached) return cached;
    if (!config.clientId) throw new Error('No Google Client ID configured.');

    await loadGis();
    return new Promise((resolve, reject) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: config.clientId,
        scope: SCOPE,
        prompt: interactive ? '' : 'none',
        callback: (response) => {
          if (response.error) {
            if (!interactive) return resolve(null);
            return reject(new Error(describeAuthError(response.error)));
          }
          storeToken(response.access_token, Number(response.expires_in || 3600));
          resolve(response.access_token);
        },
        error_callback: (err) => {
          if (!interactive) return resolve(null);
          reject(new Error(describeAuthError(err?.type || 'popup_failed')));
        },
      });
      tokenClient.requestAccessToken();
    });
  },

  signOut() {
    const token = readToken();
    if (token && window.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(token, () => {});
    }
    sessionStorage.removeItem(TOKEN_KEY);
    idCache.clear();
  },

  isSignedIn: () => Boolean(readToken()),

  /** Verifies the token and that the root folder exists and is writable. */
  async connect({ interactive = true } = {}) {
    const token = await this.authorize({ interactive });
    if (!token) return { ok: false, reason: 'auth' };
    if (!config.rootId) return { ok: false, reason: 'no-folder' };

    const meta = await api(`/files/${config.rootId}?fields=id,name,mimeType,capabilities(canEdit)&supportsAllDrives=true`);
    if (meta.mimeType !== FOLDER_MIME) {
      return { ok: false, reason: 'not-a-folder', detail: `"${meta.name}" is a file, not a folder.` };
    }
    if (meta.capabilities && meta.capabilities.canEdit === false) {
      return { ok: false, reason: 'read-only', detail: `You have read-only access to "${meta.name}".` };
    }
    return { ok: true, detail: meta.name, folderName: meta.name };
  },

  /**
   * Creates the detachment's root folder and returns its id.
   *
   * Under `drive.file` this is the only way to get a folder the app can reach —
   * which is why the wizard calls it instead of accepting a pasted link. It is
   * `files.create` with a folder mime type, the same call `ensureFolder` below
   * already made for every subfolder; the only thing that was ever missing was
   * doing it for the top one.
   */
  async createRoot(name) {
    const token = await this.authorize({ interactive: true });
    if (!token) return { ok: false, reason: 'auth' };
    const created = await api('/files?fields=id,name&supportsAllDrives=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
    config.rootId = created.id;
    idCache.clear();
    return { ok: true, folderId: created.id, folderName: created.name };
  },

  /**
   * Folders this app has already made with this name, newest first.
   *
   * The counterpart `createRoot` never had. Every *sub*folder is found before it
   * is created — `ensureFolder` below does exactly that — but the root was an
   * unconditional create, so re-running setup could not be recovery: it always
   * produced a new empty detachment and left the real one behind. Three turned up
   * in one account that way.
   *
   * A root has no parent to search inside, which is why `findChild` cannot serve
   * here. `files.list` without a parent clause would be too broad under a wider
   * scope, but under `drive.file` the scope does the filtering: the query can only
   * ever return files **this app created for this account**. A folder made by hand
   * in Drive is invisible to it, and so is another detachment's.
   *
   * Returns candidates rather than picking one. Two folders with this name is a
   * question only the person setting up can answer.
   */
  async findRoots(name) {
    const token = await this.authorize({ interactive: true });
    if (!token) return { ok: false, reason: 'auth' };
    const q = encodeURIComponent(
      `name='${name.replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and trashed=false`);
    const page = await api(`/files?q=${q}&fields=files(id,name,createdTime)`
      + '&orderBy=createdTime desc&pageSize=20&supportsAllDrives=true&includeItemsFromAllDrives=true');
    return { ok: true, folders: page.files || [] };
  },

  async ensureLayout(folders) {
    for (const name of folders) {
      await ensureFolder(config.rootId, name, name);
    }
    return true;
  },

  async readDoc(path) {
    const fileId = await findPath(path);
    if (!fileId) return null;
    const text = await api(`/files/${fileId}?alt=media&supportsAllDrives=true`, {}, 'text');
    return text && text.trim() ? JSON.parse(text) : null;
  },

  async writeDoc(path, data) {
    const parts = path.split('/').filter(Boolean);
    const filename = parts.pop();
    const parentId = await ensurePath(parts);
    const body = JSON.stringify(data, null, 2);
    const existing = await findPath(path);

    if (existing) {
      await upload(`/files/${existing}?uploadType=media&supportsAllDrives=true`, 'PATCH', body);
      return data;
    }

    const boundary = `nine31${Math.random().toString(36).slice(2)}`;
    const metadata = { name: filename, parents: [parentId], mimeType: 'application/json' };
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n` +
      `--${boundary}--`;
    const created = await upload(
      '/files?uploadType=multipart&fields=id&supportsAllDrives=true',
      'POST', multipart, `multipart/related; boundary=${boundary}`);
    idCache.set(path, created.id);
    return data;
  },

  async deleteDoc(path) {
    const fileId = await findPath(path);
    if (!fileId) return false;
    // Trash rather than destroy: a detachment can recover a misclick from Drive.
    await upload(`/files/${fileId}?supportsAllDrives=true`, 'PATCH', JSON.stringify({ trashed: true }), 'application/json');
    idCache.delete(path);
    return true;
  },

  async list(folderPath) {
    const folderId = await findPath(folderPath);
    if (!folderId) return [];
    const files = await listChildren(folderId, "mimeType!='application/vnd.google-apps.folder'");
    return files.map((f) => {
      const path = `${folderPath}/${f.name}`;
      idCache.set(path, f.id);
      return { name: f.name, path, id: f.id, modifiedAt: f.modifiedTime };
    });
  },

  async listDeep(folderPath) {
    const out = await this.list(folderPath);
    for (const sub of await this.listFolders(folderPath)) {
      const nested = await this.listDeep(`${folderPath}/${sub}`);
      out.push(...nested.map((f) => ({ ...f, name: `${sub}/${f.name}` })));
    }
    return out;
  },

  async listFolders(folderPath) {
    const folderId = await findPath(folderPath);
    if (!folderId) return [];
    const files = await listChildren(folderId, `mimeType='${FOLDER_MIME}'`);
    for (const f of files) idCache.set(`${folderPath}/${f.name}`, f.id);
    return files.map((f) => f.name);
  },

  async status() {
    if (!config.clientId || !config.rootId) return { status: 'error', detail: 'Drive not configured' };
    if (!navigator.onLine) return { status: 'offline', detail: 'No network — Drive unavailable' };
    if (!readToken()) return { status: 'offline', detail: 'Signed out of Google' };
    try {
      const meta = await api(`/files/${config.rootId}?fields=name&supportsAllDrives=true`);
      return { status: 'ready', detail: `Drive folder: ${meta.name}` };
    } catch (err) {
      return { status: 'error', detail: err.message };
    }
  },

  /** Human-facing link so cadre can open the folder in Drive directly. */
  folderUrl: () => (config.rootId ? `https://drive.google.com/drive/folders/${config.rootId}` : ''),
};

/* ------------------------------------------------------------------ *
 * Drive REST plumbing
 * ------------------------------------------------------------------ */

async function api(path, options = {}, as = 'json') {
  const token = await driveAdapter.authorize({ interactive: false })
    ?? await driveAdapter.authorize({ interactive: true });
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });

  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    const fresh = await driveAdapter.authorize({ interactive: true });
    const retry = await fetch(`${API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${fresh}`, ...(options.headers || {}) },
    });
    if (!retry.ok) throw await driveError(retry);
    return as === 'text' ? retry.text() : retry.json();
  }
  if (!res.ok) throw await driveError(res);
  return as === 'text' ? res.text() : res.json();
}

async function upload(path, method, body, contentType = 'application/json') {
  const token = await driveAdapter.authorize({ interactive: false })
    ?? await driveAdapter.authorize({ interactive: true });
  const base = path.startsWith('/files?') || path.includes('uploadType=') ? UPLOAD : API;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
  });
  if (!res.ok) throw await driveError(res);
  return res.status === 204 ? null : res.json();
}

async function driveError(res) {
  let message = `Drive request failed (${res.status})`;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
  } catch { /* body was not JSON */ }
  if (res.status === 403) message += ' — check that the Drive API is enabled and the account can edit this folder.';
  if (res.status === 404) message += ' — the folder or file was not found. Confirm the folder link in Settings.';
  return new Error(message);
}

async function listChildren(parentId, extraQuery) {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false and ${extraQuery}`);
    const url = `/files?q=${q}&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=1000`
      + `&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=name`
      + (pageToken ? `&pageToken=${pageToken}` : '');
    const page = await api(url);
    out.push(...(page.files || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function findChild(parentId, name) {
  const q = encodeURIComponent(`'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`);
  const page = await api(`/files?q=${q}&fields=files(id,name)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return page.files?.[0]?.id || null;
}

async function ensureFolder(parentId, name, cachePath) {
  if (cachePath && idCache.has(cachePath)) return idCache.get(cachePath);
  let id = await findChild(parentId, name);
  if (!id) {
    const created = await api('/files?fields=id&supportsAllDrives=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    id = created.id;
  }
  if (cachePath) idCache.set(cachePath, id);
  return id;
}

/** Resolves a path to a file id, or null when any segment is missing. */
async function findPath(path) {
  if (idCache.has(path)) return idCache.get(path);
  const parts = path.split('/').filter(Boolean);
  let current = config.rootId;
  let walked = '';
  for (const part of parts) {
    walked = walked ? `${walked}/${part}` : part;
    if (idCache.has(walked)) {
      current = idCache.get(walked);
      continue;
    }
    const found = await findChild(current, part);
    if (!found) return null;
    idCache.set(walked, found);
    current = found;
  }
  return current;
}

/** Resolves a folder path, creating any missing segments. */
async function ensurePath(parts) {
  let current = config.rootId;
  let walked = '';
  for (const part of parts) {
    walked = walked ? `${walked}/${part}` : part;
    current = await ensureFolder(current, part, walked);
  }
  return current;
}

/* ------------------------------------------------------------------ *
 * Google Identity Services
 * ------------------------------------------------------------------ */

/**
 * The shared loader, asked for the part this adapter needs.
 *
 * This used to be a second copy of loadGis with its own promise cache, so the
 * app could inject the Google script twice — once for the sign-in button and
 * once for the token client — with neither copy aware of the other.
 */
function loadGis() {
  return loadSharedGis(() => Boolean(window.google?.accounts?.oauth2));
}

function storeToken(token, expiresInSeconds) {
  // Expire a minute early so a request never dies mid-flight.
  const expiresAt = Date.now() + (expiresInSeconds - 60) * 1000;
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
}

function readToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() >= expiresAt) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

function describeAuthError(code) {
  switch (code) {
    case 'popup_closed':
    case 'popup_closed_by_user':
      return 'Google sign-in was closed before finishing.';
    case 'popup_failed_to_open':
      return 'The sign-in popup was blocked. Allow popups for this site and try again.';
    case 'access_denied':
      return 'Google access was declined.';
    case 'idpiframe_initialization_failed':
      return 'Google sign-in could not start. Third-party cookies may be blocked.';
    default:
      return `Google sign-in failed (${code}).`;
  }
}

/** Accepts a folder id, a /folders/<id> link, or an ?id= link. */
export function parseFolderId(input) {
  const value = (input || '').trim();
  if (!value) return '';
  const patterns = [/\/folders\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/];
  for (const re of patterns) {
    const match = value.match(re);
    if (match) return match[1];
  }
  return /^[a-zA-Z0-9_-]{10,}$/.test(value) ? value : '';
}
