/**
 * Audit trail.
 *
 * Records who did the things that cannot be undone. It exists mainly for one
 * scenario: an instructor who is the subject of a complaint should not be able
 * to delete that complaint and leave no trace. Response and account deletions,
 * roster changes, imports, wipes and the annual rollover all land here.
 *
 * Design notes:
 *
 *   - **One file per entry**, under `audit/<YYYY-MM>/`. Same reasoning as
 *     receipts: an append-to-one-array log is a read-modify-write that two
 *     people can clobber, and a log that loses entries under load is worse than
 *     no log because it looks complete. Monthly folders keep any single listing
 *     small.
 *   - **No delete function is exposed.** Entries can still be removed from
 *     Drive directly by anyone with folder access — this is a client-side app
 *     and cannot pretend otherwise. What it gives you is a record that has to
 *     be *deliberately* destroyed rather than one that never existed.
 *   - **Logging never blocks the action it describes.** A failure to write the
 *     log is reported to the console and swallowed; losing an audit line is bad,
 *     but failing a cadet's submission because the log was unreachable is worse.
 */

import { APP, DB_LAYOUT, LS } from './config.js';
import { makeId, nowIso } from './util.js';
import { db } from './storage/index.js';

/** Actions worth a permanent record. Anything destructive or privileged. */
export const AUDIT = {
  responseDeleted: 'response.deleted',
  requestDeleted: 'request.deleted',
  accountCreated: 'account.created',
  accountUpdated: 'account.updated',
  accountDeleted: 'account.deleted',
  rolloverApplied: 'roster.rollover',
  dataExported: 'database.exported_anonymised',
  dataImported: 'database.imported',
  dataWiped: 'database.wiped',
  indexesRebuilt: 'database.reindexed',
};

export const AUDIT_LABELS = {
  'response.deleted': 'Response deleted',
  'request.deleted': 'Feedback deleted',
  'account.created': 'Account created',
  'account.updated': 'Account updated',
  'account.deleted': 'Account deleted',
  // Retired in v4, when Google accounts replaced app passwords. The label stays
  // so entries written before that still read properly in the viewer.
  'account.password_reset': 'Password reset',
  'roster.rollover': 'Academic year advanced',
  'database.exported_anonymised': 'Anonymised export',
  'database.imported': 'Backup imported',
  'database.wiped': 'All records deleted',
  'database.reindexed': 'Indexes rebuilt',
};

/** Destructive actions, highlighted in the viewer. */
const SEVERE = new Set([
  AUDIT.responseDeleted, AUDIT.requestDeleted, AUDIT.accountDeleted, AUDIT.dataWiped,
]);

/**
 * Reads the signed-in account straight from session storage.
 *
 * Deliberately not imported from auth.js: auth writes audit entries, so an
 * import in that direction would be a cycle.
 */
function actor() {
  try {
    const raw = sessionStorage.getItem(LS.session);
    if (!raw) return { username: 'unknown', name: 'Not signed in' };
    const s = JSON.parse(raw);
    return { username: s.username, name: s.name, roles: s.roles || [] };
  } catch {
    return { username: 'unknown', name: 'Not signed in' };
  }
}

const monthFolder = (iso) => `${DB_LAYOUT.folders.audit}/${iso.slice(0, 7)}`;

/**
 * Writes one entry. Never throws.
 *
 * @param {string} action  one of AUDIT
 * @param {{summary: string, target?: string, reason?: string, detail?: object}} info
 */
export async function record(action, info = {}) {
  const at = nowIso();
  const who = actor();
  const entry = {
    schemaVersion: APP.schemaVersion,
    id: makeId('aud'),
    action,
    at,
    actor: who,
    summary: info.summary || AUDIT_LABELS[action] || action,
    target: info.target || null,
    reason: info.reason || null,
    detail: info.detail || null,
    severe: SEVERE.has(action),
  };
  try {
    await db.writeRaw(`${monthFolder(at)}/${entry.id}.json`, entry);
  } catch (err) {
    console.warn('[audit] entry could not be written', action, err);
  }
  return entry;
}

/**
 * Most recent entries, newest first.
 *
 * Walks back a month at a time so a detachment with years of history does not
 * pay to list all of it just to show the last page.
 */
export async function recent({ months = 6, limit = 200 } = {}) {
  const out = [];
  const cursor = new Date();

  for (let i = 0; i < months && out.length < limit; i++) {
    const key = `${DB_LAYOUT.folders.audit}/${cursor.toISOString().slice(0, 7)}`;
    try {
      const entries = await db.listRawFolder(key);
      for (const entry of entries) {
        const doc = await db.readRaw(entry.path);
        if (doc) out.push(doc);
      }
    } catch (err) {
      console.warn('[audit] could not read', key, err);
    }
    cursor.setMonth(cursor.getMonth() - 1);
  }

  return out
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}
