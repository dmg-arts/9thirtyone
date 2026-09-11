/**
 * Offline write queue.
 *
 * An installable app that caches its shell offline implies it works offline.
 * Without this, a cadet who submits feedback on classroom wifi that has dropped
 * loses everything they typed.
 *
 * How it works: every write goes through `runWrite`. If the adapter fails for a
 * reason that looks like a connectivity problem, the operation is parked in
 * IndexedDB and replayed on the next `online` event (or on demand). Queued
 * writes are also mirrored into a pending overlay, so the UI shows the record
 * immediately rather than pretending nothing happened.
 *
 * Ordering is preserved: the queue drains oldest-first and stops at the first
 * failure, so a later edit can never land before the create it depends on.
 */

import { idb, openDb, STORE_QUEUE } from './idb.js';

const STORE = STORE_QUEUE;

/** Listeners fired whenever the queue length or drain state changes. */
const listeners = new Set();
let draining = false;

export function onQueueChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function announce() {
  const state = await queueState();
  listeners.forEach((fn) => fn(state));
}

export async function queueState() {
  const items = await allItems();
  return {
    pending: items.length,
    draining,
    oldest: items[0]?.queuedAt || null,
  };
}

/* ------------------------------------------------------------------ *
 * classification
 * ------------------------------------------------------------------ */

/**
 * True when a failure is plausibly transient connectivity rather than the
 * server rejecting the request. A 403/404 means the folder is wrong or
 * permission is missing — queueing those would hide a real misconfiguration
 * behind a pending badge forever.
 */
export function isTransient(err) {
  if (!navigator.onLine) return true;
  const message = String(err?.message || '');
  if (err instanceof TypeError && /fetch|network/i.test(message)) return true;
  return /network|failed to fetch|load failed|timeout|temporarily|rate limit|backend error|503|502|504|429/i
    .test(message);
}

/* ------------------------------------------------------------------ *
 * queue storage
 * ------------------------------------------------------------------ */

async function ensureStore() {
  // The store is declared in idb.js's upgrade; opening validates it exists.
  const db = await openDb();
  if (!db.objectStoreNames.contains(STORE)) {
    throw new Error('Offline queue store is missing — reload the app.');
  }
}

async function allItems() {
  try {
    await ensureStore();
    const items = await idb.all(STORE);
    return items.sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

async function enqueue(op) {
  await ensureStore();
  const item = { ...op, id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, seq: Date.now() + Math.random(), queuedAt: new Date().toISOString(), attempts: 0 };
  await idb.put(STORE, item);
  await announce();
  return item;
}

/* ------------------------------------------------------------------ *
 * the pending overlay
 * ------------------------------------------------------------------ */

/**
 * Path -> data for writes that have not landed yet, so reads can merge them.
 * Rebuilt from the queue on load so it survives a refresh.
 */
const overlay = new Map();
const deleted = new Set();

export async function primeOverlay() {
  overlay.clear();
  deleted.clear();
  for (const item of await allItems()) {
    if (item.kind === 'write') overlay.set(item.path, item.data);
    else if (item.kind === 'delete') { overlay.delete(item.path); deleted.add(item.path); }
  }
  await announce();
}

export const pending = {
  get: (path) => (deleted.has(path) ? null : overlay.get(path)),
  has: (path) => overlay.has(path) || deleted.has(path),
  isDeleted: (path) => deleted.has(path),
  /** Paths queued under a folder prefix, for merging into list results. */
  under(folderPath) {
    const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
    return [...overlay.keys()].filter((p) => p.startsWith(prefix));
  },
  size: () => overlay.size,
};

/* ------------------------------------------------------------------ *
 * the write path
 * ------------------------------------------------------------------ */

/**
 * Attempts a write; queues it when the failure looks like connectivity.
 *
 * @param {'write'|'delete'} kind
 * @param {string} path
 * @param {object|null} data
 * @param {() => Promise<any>} attempt
 * @returns {Promise<{queued: boolean, data: any}>}
 */
export async function runWrite(kind, path, data, attempt) {
  try {
    const result = await attempt();
    // A successful direct write supersedes anything queued for the same path.
    // Unconditional: delete on an absent key is already a no-op, so the guard
    // this used to carry only asked the same question twice.
    overlay.delete(path);
    deleted.delete(path);
    return { queued: false, data: result ?? data };
  } catch (err) {
    if (!isTransient(err)) throw err;
    await enqueue({ kind, path, data });
    if (kind === 'write') { overlay.set(path, data); deleted.delete(path); }
    else { overlay.delete(path); deleted.add(path); }
    return { queued: true, data };
  }
}

/**
 * Replays queued writes oldest-first. Stops at the first still-failing item so
 * ordering holds. Returns a summary for the UI.
 */
export async function drain(adapter) {
  if (draining) return { sent: 0, remaining: (await allItems()).length, stopped: true };
  draining = true;
  await announce();

  let sent = 0;
  let lastError = null;
  try {
    for (const item of await allItems()) {
      try {
        if (item.kind === 'write') await adapter.writeDoc(item.path, item.data);
        else await adapter.deleteDoc(item.path);
        await idb.delete(STORE, item.id);
        overlay.delete(item.path);
        deleted.delete(item.path);
        sent++;
      } catch (err) {
        lastError = err;
        if (isTransient(err)) break; // still offline — try again later
        // A permanent rejection would block the queue forever. Drop it and
        // surface it, rather than wedging every later write behind it.
        await idb.delete(STORE, item.id);
        overlay.delete(item.path);
        deleted.delete(item.path);
      }
    }
  } finally {
    draining = false;
    await announce();
  }

  const remaining = (await allItems()).length;
  return { sent, remaining, error: lastError };
}

