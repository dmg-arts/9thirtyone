/**
 * The failure counter, and the discipline that keeps the diagnostics file safe.
 *
 *     node tests/unit/diagnostics.test.mjs
 *
 * Two different kinds of check live here, for two different reasons.
 *
 * The counter is behaviour, and it is tested as behaviour: it must count, it
 * must bound itself, it must never throw, and it must never record a time finer
 * than a month.
 *
 * The rest is a **source check**, in the same spirit as `tests/unit/proxy.test.mjs`
 * reading `Code.gs`. What makes `diagnostics.js` safe is not any individual
 * field but the way it is written — every value is named on its way in, and no
 * object is ever spread into the file wholesale. That is a property of the text,
 * and a property of the text is what a source check can hold.
 *
 * It matters because the failure mode is silent and in the future. Spreading
 * `connection.get()` is safe on the day it is written and becomes a leak the day
 * somebody adds a field to `connection` — which is exactly how the *previous*
 * diagnostics download came to be emitting the detachment's name, its Drive
 * folder id and its proxy URL. Nobody decided to send those. They arrived.
 *
 * The assertion that the file contains no personal data is not here, because it
 * cannot honestly be made here: it needs a real detachment with real names in
 * it. It lives in `tests/e2e/app.test.mjs`, which seeds one and then searches
 * the serialised text.
 */

import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

/* ---------- the counter ---------- */

// A localStorage good enough to exercise the module, including the failure the
// module is written to survive.
function fakeStorage({ broken = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => { if (broken) throw new Error('storage disabled'); return map.get(k) ?? null; },
    setItem: (k, v) => { if (broken) throw new Error('storage disabled'); map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

globalThis.localStorage = fakeStorage();
const { recordFailure, failureCounts, clearFailures } = await import('../../js/failures.js');

check('a failure is counted, and counted again rather than duplicated', () => {
  clearFailures();
  recordFailure('drive', 403);
  recordFailure('drive', 403);
  recordFailure('proxy', 'timeout');

  const rows = failureCounts();
  if (rows.length !== 2) throw new Error(`${rows.length} rows, expected 2`);
  const drive = rows.find((r) => r.where === 'drive');
  if (drive.count !== 2) throw new Error(`drive counted ${drive.count}, expected 2`);
  if (drive.code !== '403') throw new Error(`code stored as ${JSON.stringify(drive.code)}`);
});

check('a counter records a month and never a time', () => {
  clearFailures();
  recordFailure('proxy', 'sign-in-page');
  const [row] = failureCounts();
  for (const value of [row.firstMonth, row.lastMonth]) {
    if (!/^\d{4}-\d{2}$/.test(value)) throw new Error(`not a bare month: ${value}`);
  }
});

check('the counter is bounded, keeping what happens most', () => {
  clearFailures();
  // One frequent failure and sixty rare ones: the frequent one is the report.
  recordFailure('drive', 'frequent');
  for (let i = 0; i < 200; i++) recordFailure('drive', 'frequent');
  for (let i = 0; i < 60; i++) recordFailure('proxy', `rare${i}`);

  const rows = failureCounts();
  if (rows.length > 40) throw new Error(`${rows.length} rows kept, budget 40`);
  if (!rows.some((r) => r.code === 'frequent')) {
    throw new Error('the most frequent failure was evicted by one-offs');
  }
});

check('a device with storage disabled records nothing and throws nothing', () => {
  globalThis.localStorage = fakeStorage({ broken: true });
  // Counting failures must never become a reason a submission fails.
  recordFailure('drive', 500);
  if (failureCounts().length !== 0) throw new Error('something was returned from broken storage');
  globalThis.localStorage = fakeStorage();
});

/* ---------- the construction discipline ---------- */

const source = read('js/diagnostics.js');

check('the report never spreads a stored object into itself', () => {
  // `{...connection.get()}` is how the previous diagnostics file came to carry
  // the detachment name, the folder id and the proxy URL. Every value in this
  // file is named individually, so a new field on `connection` or `settings`
  // cannot arrive in it by default.
  const spreads = [...source.matchAll(/\.\.\.\s*(connection|settings|conn|db|org)\b[^,\n]*/g)]
    .map((m) => m[0].trim());
  if (spreads.length) throw new Error(`spread into the report: ${spreads.join(', ')}`);
});

check('the report names no field that addresses or identifies the detachment', () => {
  // Allowed as a *key* in the redaction notice, which says these were removed —
  // so the check is for reading them off `conn`, not for the words appearing.
  const reads = [...source.matchAll(/conn\.(orgName|folderId|folderUrl|folderName)\b/g)]
    .map((m) => m[0]);
  if (reads.length) throw new Error(`read from the connection record: ${reads.join(', ')}`);
});

check('the proxy URL is used but never written into the file', () => {
  // Using it is fine and necessary — `checkProxy(conn.proxyUrl)` is how the
  // deployed version is learned, and testing it answers "is one configured, and
  // is it the right shape". What must never happen is it becoming a *value* in
  // the report, because that puts a working, unauthenticated endpoint into a
  // file that travels by email: anyone holding it can wake and poll the
  // detachment's Apps Script quota.
  //
  // So the check is for assignment, not for mention.
  const emitted = [...source.matchAll(/:\s*conn\.proxyUrl\b(?!\s*\?)/g)].map((m) => m[0].trim());
  if (emitted.length) throw new Error(`the proxy URL is assigned into the report: ${emitted.join(', ')}`);
});

check('round trips carry spacing, not wall-clock', () => {
  // The buffer rows hold a precise `at`. Emitting it would hand over a list of
  // submission times, which lines up against receipts — the correlation the
  // anonymised export exists to defeat.
  if (/\bat:\s*r\.at\b/.test(source) || /\.\.\.r\b/.test(source)) {
    throw new Error('a round trip was emitted with its timestamp');
  }
  if (!/sinceFirstMs/.test(source)) throw new Error('round trips no longer carry their spacing');
});

check('the failure key is registered with the others', () => {
  const config = read('js/config.js');
  if (!/failures:\s*'nine31\.failures\.v1'/.test(config)) {
    throw new Error('LS.failures is not declared in config.js');
  }
});

check('every module that records a failure passes a code, never a message', () => {
  for (const file of ['js/storage/drive.js', 'js/storage/proxy.js', 'js/storage/queue.js']) {
    const text = read(file);
    for (const call of [...text.matchAll(/recordFailure\(([^)]*)\)/g)]) {
      const args = call[1];
      // A message would arrive as a variable or a template with a space in it.
      if (/err\.message|`[^`]* [^`]*`|\bmessage\b/.test(args)) {
        throw new Error(`${file} passes a message: recordFailure(${args})`);
      }
    }
  }
});

console.log(failures
  ? `\n${failures} diagnostics check(s) failed.`
  : '\nDiagnostics carry technical facts and nothing else.');
process.exit(failures ? 1 : 0);
