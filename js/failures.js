/**
 * Counts things that went wrong, so an install nobody can watch can still say so.
 *
 * Every failure path in this app throws and forgets. `driveError` has the HTTP
 * status in hand and folds it into a sentence; `postJson` knows whether a request
 * timed out, was refused or came back as a sign-in page, and turns all three into
 * prose; the queue's `attempts` field is initialised to zero and never
 * incremented. That is fine for telling a person what to do next, and useless for
 * telling a maintainer what has been happening on a detachment's device.
 *
 * WHY COUNTS AND NOT EVENTS
 *
 * An event log of failures would carry times, and a time is half of the
 * correlation this project works to prevent — a failed `submit` logged to the
 * second lines up against a receipt written moments later. Counts carry the same
 * diagnostic weight (is this constant, or did it happen once?) with none of that,
 * so the dates here are reduced to a month, exactly as the anonymised export
 * reduces its own.
 *
 * WHY ITS OWN MODULE
 *
 * `diagnostics.js` reads the storage layer, and the storage layer is what needs
 * to record failures. Putting both in one file makes a cycle. This has one
 * import, `config.js`, and no other module depends on it being loaded.
 *
 * Nothing here may ever throw. A submission that failed because the code
 * *counting* failures failed would be a poor trade.
 */

import { LS } from './config.js';

/** Distinct where/code pairs kept. Beyond this the rarest are dropped. */
const KEPT = 40;

const month = () => new Date().toISOString().slice(0, 7);

/** Every counter recorded on this device, newest activity last. */
export function failureCounts() {
  try {
    const raw = localStorage.getItem(LS.failures);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Notes that something failed, by category rather than by description.
 *
 * @param {string} where  a fixed code for the operation — `'drive'`, `'proxy'`,
 *   `'queue'`. Never a message: messages carry folder names and free text.
 * @param {string|number} code  what kind of failure — an HTTP status, or a short
 *   fixed word like `'timeout'` or `'network'`.
 */
export function recordFailure(where, code) {
  try {
    const key = `${where}:${code}`;
    const rows = failureCounts();
    const found = rows.find((r) => `${r.where}:${r.code}` === key);
    if (found) {
      found.count += 1;
      found.lastMonth = month();
    } else {
      rows.push({ where: String(where), code: String(code), count: 1, firstMonth: month(), lastMonth: month() });
    }

    // Keep the ones that happen most: a counter at one is noise, a counter at
    // four hundred is the report.
    const kept = rows.sort((a, b) => b.count - a.count).slice(0, KEPT);
    localStorage.setItem(LS.failures, JSON.stringify(kept));
  } catch { /* counting must never break the thing it is counting */ }
}

/** Starts the counts again. Used by the tests, and by nothing else. */
export function clearFailures() {
  try { localStorage.removeItem(LS.failures); } catch { /* nothing to clear */ }
}
