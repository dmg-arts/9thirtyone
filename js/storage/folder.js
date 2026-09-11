/**
 * `folder` backend — File System Access API against a real folder on disk.
 *
 * This is the literal reading of "point the app at the org's Google Drive": the
 * detachment installs Google Drive for Desktop, and picks their synced
 * 9ThirtyOne folder here. Google's client handles sync; the app just reads and
 * writes JSON files. Desktop Chromium only (Chrome/Edge) — Safari and every
 * mobile browser lack the API, which is why the `drive` backend exists.
 */

import { idb, STORE_HANDLES } from './idb.js';

const HANDLE_KEY = 'root-folder';

let rootHandle = null;

export const folderAdapter = {
  id: 'folder',
  label: 'Synced Drive folder on this computer',

  isAvailable: () => typeof window.showDirectoryPicker === 'function' && window.isSecureContext,

  /** Opens the native folder picker and remembers the handle. */
  async chooseFolder() {
    const handle = await window.showDirectoryPicker({ id: 'nine31-root', mode: 'readwrite' });
    await idb.put(STORE_HANDLES, handle, HANDLE_KEY);
    rootHandle = handle;
    return { name: handle.name };
  },

  /** Re-attaches to the saved handle, re-prompting for permission if needed. */
  async connect({ interactive = false } = {}) {
    if (!rootHandle) rootHandle = await idb.get(STORE_HANDLES, HANDLE_KEY);
    if (!rootHandle) return { ok: false, reason: 'no-handle' };

    const opts = { mode: 'readwrite' };
    let permission = await rootHandle.queryPermission(opts);
    if (permission !== 'granted' && interactive) {
      permission = await rootHandle.requestPermission(opts);
    }
    if (permission !== 'granted') return { ok: false, reason: 'permission' };
    return { ok: true, detail: rootHandle.name };
  },

  async ensureLayout(folders) {
    const root = await requireRoot();
    for (const name of folders) {
      await root.getDirectoryHandle(name, { create: true });
    }
    return true;
  },

  async readDoc(path) {
    const root = await requireRoot();
    const { dir, filename } = await walk(root, path, false);
    if (!dir) return null;
    try {
      const fileHandle = await dir.getFileHandle(filename);
      const text = await (await fileHandle.getFile()).text();
      return text.trim() ? JSON.parse(text) : null;
    } catch (err) {
      if (err.name === 'NotFoundError') return null;
      throw err;
    }
  },

  async writeDoc(path, data) {
    const root = await requireRoot();
    const { dir, filename } = await walk(root, path, true);
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
    return data;
  },

  async deleteDoc(path) {
    const root = await requireRoot();
    const { dir, filename } = await walk(root, path, false);
    if (!dir) return false;
    try {
      await dir.removeEntry(filename);
      return true;
    } catch (err) {
      if (err.name === 'NotFoundError') return false;
      throw err;
    }
  },

  async list(folderPath) {
    const dir = await resolveDir(await requireRoot(), folderPath, false);
    if (!dir) return [];
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
      const file = await handle.getFile();
      out.push({ name, path: `${folderPath}/${name}`, modifiedAt: new Date(file.lastModified).toISOString() });
    }
    return out;
  },

  /** Lists .json files under `folderPath` at any depth. */
  async listDeep(folderPath) {
    const dir = await resolveDir(await requireRoot(), folderPath, false);
    if (!dir) return [];
    const out = [];
    const visit = async (handle, prefix) => {
      for await (const [name, child] of handle.entries()) {
        if (child.kind === 'directory') await visit(child, `${prefix}${name}/`);
        else if (name.endsWith('.json')) {
          const file = await child.getFile();
          out.push({
            name: `${prefix}${name}`,
            path: `${folderPath}/${prefix}${name}`,
            modifiedAt: new Date(file.lastModified).toISOString(),
          });
        }
      }
    };
    await visit(dir, '');
    return out;
  },

  /** Lists subfolder names directly under `folderPath`. */
  async listFolders(folderPath) {
    const dir = await resolveDir(await requireRoot(), folderPath, false);
    if (!dir) return [];
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') out.push(name);
    }
    return out;
  },

  async status() {
    if (!rootHandle) rootHandle = await idb.get(STORE_HANDLES, HANDLE_KEY);
    if (!rootHandle) return { status: 'error', detail: 'No folder selected' };
    const permission = await rootHandle.queryPermission({ mode: 'readwrite' });
    return permission === 'granted'
      ? { status: 'ready', detail: `Folder: ${rootHandle.name}` }
      : { status: 'error', detail: 'Permission needed — click Reconnect' };
  },

  async forget() {
    await idb.delete(STORE_HANDLES, HANDLE_KEY);
    rootHandle = null;
  },
};

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

async function requireRoot() {
  if (!rootHandle) rootHandle = await idb.get(STORE_HANDLES, HANDLE_KEY);
  if (!rootHandle) throw new Error('No folder connected. Open Settings and reconnect.');
  const permission = await rootHandle.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') {
    const granted = await rootHandle.requestPermission({ mode: 'readwrite' });
    if (granted !== 'granted') throw new Error('Permission to the folder was denied.');
  }
  return rootHandle;
}

/** Resolves `a/b/c` to its directory handle. */
async function resolveDir(root, path, create) {
  const parts = path.split('/').filter(Boolean);
  let dir = root;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch (err) {
      if (err.name === 'NotFoundError' && !create) return null;
      throw err;
    }
  }
  return dir;
}

/** Splits `a/b/file.json` into its parent directory handle and filename. */
async function walk(root, path, create) {
  const parts = path.split('/').filter(Boolean);
  const filename = parts.pop();
  const dir = await resolveDir(root, parts.join('/'), create);
  return { dir, filename };
}
