/**
 * The fake Drive REST layer, against what real Drive actually does.
 *
 *     npm run test:proxy
 *
 * Stage 2 of 1.4 moves the expensive reads from Apps Script's Drive binding to
 * the Drive REST API over UrlFetchApp. The harness grows a fake of that API,
 * and a fake is a hypothesis about Google — so every assertion here cites the
 * expectation it encodes, and every expectation was measured against real Drive
 * from the staging Apps Script project on 28 Oct 2026 before any of this was
 * written. See tools/proxy/fidelity-probe.gs.
 *
 * The ordering mattered. Expectations written after observing produce a fake
 * that agrees with whatever happened that afternoon, accidents included.
 *
 * One expectation is NOT measured and is called out where it appears: E10,
 * rate limiting, never triggered even at 107 concurrent requests. It cannot be
 * forced. Its shape here is a guess, and a green run against it is evidence
 * about this file only.
 */

import { createProxy, idOf } from './harness.mjs';

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

const API = 'https://www.googleapis.com/drive/v3/';

/** A proxy with a small tree, and the raw fetch Code.gs would use. */
function detachment() {
  const proxy = createProxy({});
  const root = proxy.root;
  root.put(['responses', 'req-1'], 'alice.json', { rating: 5 });
  root.put(['responses', 'req-1'], 'bob.json', { rating: 7 });
  root.put(['responses', 'req-1'], "o'brien \\ \"quoted\".json", { rating: 9 });
  // Every call Code.gs makes carries the bearer token and the mute flag, so the
  // default here does too — a test that omitted them would be exercising a
  // request shape production never sends.
  const auth = {
    headers: { Authorization: `Bearer ${proxy.sandbox.ScriptApp.getOAuthToken()}` },
    muteHttpExceptions: true,
  };
  const fetch = (url, options = auth) => proxy.sandbox.UrlFetchApp.fetch(url, options);
  const folder = root.folders.get('responses').folders.get('req-1');
  return { proxy, root, fetch, folder, mute: auth, auth };
}


const q = (text) => encodeURIComponent(text);

check('an unauthenticated call is refused', () => {
  // The failure this guards is forgetting the header on one request out of a
  // batch, which yields a listing that is quietly short rather than an error.
  const { fetch, folder, mute } = detachment();
  const url = `${API}files?q=${q(`'${idOf(folder)}' in parents and trashed=false`)}`;
  const res = fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 401) throw new Error(`code ${res.getResponseCode()}, expected 401`);
  if (fetch(url, mute).getResponseCode() !== 200) throw new Error('authenticated call did not succeed');
});

/* ---------- E3 / E5 : listing and field projection ---------- */

check('E5 fields=files(id,name) returns those keys and no others', () => {
  const { fetch, folder, mute } = detachment();
  const res = fetch(`${API}files?q=${q(`'${idOf(folder)}' in parents and trashed=false`)}`
    + `&fields=${q('files(id,name),nextPageToken')}`, mute);
  if (res.getResponseCode() !== 200) throw new Error(`code ${res.getResponseCode()}`);
  const rows = JSON.parse(res.getContentText()).files;
  if (rows.length !== 3) throw new Error(`${rows.length} children, expected 3`);
  const keys = Object.keys(rows[0]).sort().join(',');
  if (keys !== 'id,name') throw new Error(`projection leaked: ${keys}`);
});

/* ---------- E4 : paging ---------- */

check('E4 pageSize above 1000 is a 400 naming the range', () => {
  const { fetch, folder, mute } = detachment();
  const res = fetch(`${API}files?q=${q(`'${idOf(folder)}' in parents and trashed=false`)}&pageSize=2000`, mute);
  if (res.getResponseCode() !== 400) throw new Error(`code ${res.getResponseCode()}, expected 400`);
  if (!/within the range/.test(res.getContentText())) {
    throw new Error(`message does not name the range: ${res.getContentText().slice(0, 120)}`);
  }
});

check('E4 nextPageToken appears and pages through without loss or repeat', () => {
  const { fetch, folder, mute } = detachment();
  const seen = [];
  let token = null;
  let guard = 0;
  do {
    const url = `${API}files?q=${q(`'${idOf(folder)}' in parents and trashed=false`)}`
      + `&pageSize=2&fields=${q('files(id),nextPageToken')}${token ? `&pageToken=${token}` : ''}`;
    const body = JSON.parse(fetch(url, mute).getContentText());
    for (const row of body.files) seen.push(row.id);
    token = body.nextPageToken || null;
  } while (token && guard++ < 10);
  if (seen.length !== 3) throw new Error(`paged ${seen.length} rows, expected 3`);
  if (new Set(seen).size !== 3) throw new Error('a row was returned on two pages');
});

/* ---------- E6 : quoting ---------- */

check('E6 a name is found when backslashes then quotes are escaped', () => {
  const { fetch, folder, mute } = detachment();
  const name = "o'brien \\ \"quoted\".json";
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = fetch(`${API}files?q=${q(`'${idOf(folder)}' in parents and name = '${escaped}' and trashed=false`)}`
    + `&fields=${q('files(id,name)')}`, mute);
  const rows = JSON.parse(res.getContentText()).files;
  if (rows.length !== 1) throw new Error(`${rows.length} matches for an escaped name, expected 1`);
  if (rows[0].name !== name) throw new Error(`unescaped wrongly: ${rows[0].name}`);
});

check('E6 an unescaped quote is a 400, never a silent miss', () => {
  // The whole point. A silent miss would make a lookup for o'brien.json return
  // empty and read as a missing file, which is the bug that takes a day.
  const { fetch, folder, mute } = detachment();
  const res = fetch(`${API}files?q=${q(`'${idOf(folder)}' in parents and name = 'o'brien.json' and trashed=false`)}`, mute);
  if (res.getResponseCode() !== 400) {
    throw new Error(`code ${res.getResponseCode()}, expected 400 — a miss would be worse than an error`);
  }
});

/* ---------- E7 : content ---------- */

check('E7 alt=media returns the raw body with no envelope', () => {
  const { fetch, folder, mute } = detachment();
  const id = idOf(folder.files.get('alice.json'));
  const res = fetch(`${API}files/${id}?alt=media`, mute);
  if (res.getResponseCode() !== 200) throw new Error(`code ${res.getResponseCode()}`);
  const body = res.getContentText();
  if (JSON.parse(body).rating !== 5) throw new Error(`body was ${body}`);
  if (/"files"|"error"/.test(body)) throw new Error('the body came wrapped');
});

/* ---------- E8 : fetchAll ---------- */

check('E8 fetchAll preserves request order', () => {
  const { proxy, folder } = detachment();
  const names = ['alice.json', 'bob.json', 'alice.json'];
  const { auth } = detachment();
  const requests = names.map((n) => ({
    url: `${API}files/${idOf(folder.files.get(n))}?alt=media`,
    headers: auth.headers,
    muteHttpExceptions: true,
  }));
  const all = proxy.sandbox.UrlFetchApp.fetchAll(requests);
  const ratings = all.map((r) => JSON.parse(r.getContentText()).rating);
  if (ratings.join(',') !== '5,7,5') throw new Error(`order was ${ratings.join(',')}`);
});

/* ---------- E11 / E12 : errors ---------- */

check('E11 a missing id is 404 with reason notFound', () => {
  const { fetch, mute } = detachment();
  const res = fetch(`${API}files/definitelyNotARealFileId0000?alt=media`, mute);
  if (res.getResponseCode() !== 404) throw new Error(`code ${res.getResponseCode()}`);
  const reason = JSON.parse(res.getContentText()).error.errors[0].reason;
  if (reason !== 'notFound') throw new Error(`reason was ${reason}`);
});

check('E12 a non-2xx throws unless muteHttpExceptions is set', () => {
  const { fetch, folder, mute } = detachment();

  // Asserted against the message, not merely "something threw". An earlier
  // draft caught any throw and passed while the harness was broken in an
  // unrelated way — a test that cannot tell its own subject from a typo.
  let message = null;
  const { auth } = detachment();
  try {
    fetch(`${API}files/definitelyNotARealFileId0000?alt=media`,
      { headers: auth.headers });
  } catch (err) { message = String(err.message || err); }
  if (!message) {
    throw new Error('did not throw without muteHttpExceptions — real UrlFetchApp does, '
      + 'so error handling written without it would never run in production');
  }
  if (!/returned code 404/.test(message)) {
    throw new Error(`threw, but not about the response: ${message}`);
  }

  // And the same call with the flag returns rather than throwing.
  const muted = fetch(`${API}files/definitelyNotARealFileId0000?alt=media`, mute);
  if (muted.getResponseCode() !== 404) throw new Error('muted call did not return the 404');
  void folder;
});

/* ---------- E10 : UNVERIFIED ---------- */

check('E10 a throttled call is reported, NOT proof of what Google sends', () => {
  // Rate limiting never triggered against real Drive, even at 107 concurrent
  // requests, and it cannot be forced. This asserts the fake can drive a retry
  // path. It asserts nothing about Drive. The retry in Code.gs must accept 429
  // as well as 403-with-reason, because this shape is a guess.
  const { proxy, fetch, folder, mute } = detachment();
  const id = idOf(folder.files.get('alice.json'));

  proxy.throttleNext(1);
  const limited = fetch(`${API}files/${id}?alt=media`, mute);
  if (limited.getResponseCode() !== 403) {
    throw new Error(`throttled call returned ${limited.getResponseCode()}`);
  }
  const reason = JSON.parse(limited.getContentText()).error.errors[0].reason;
  if (reason !== 'rateLimitExceeded') throw new Error(`reason was ${reason}`);

  // And the queue drains, so one throttle does not poison the rest of a run.
  const after = fetch(`${API}files/${id}?alt=media`, mute);
  if (after.getResponseCode() !== 200) throw new Error('throttling did not clear');
});

/* ---------- E13 : shared drives ---------- */

check('E13 supportsAllDrives changes nothing for a My Drive folder', () => {
  const { fetch, folder, mute } = detachment();
  const base = `${API}files?q=${q(`'${idOf(folder)}' in parents and trashed=false`)}&fields=${q('files(id)')}`;
  const plain = JSON.parse(fetch(base, mute).getContentText()).files.length;
  const flagged = JSON.parse(fetch(`${base}&supportsAllDrives=true&includeItemsFromAllDrives=true`, mute).getContentText()).files.length;
  if (plain !== flagged) throw new Error(`${plain} without flags, ${flagged} with`);
});

/* ---------- the store is one store ---------- */

check('REST and DriveApp are two views of the same store, not two stores', () => {
  // The failure this guards is stage 2 passing against data no other code path
  // can see. A write through the DriveApp surface must be visible to REST
  // immediately, with no synchronisation step, because in production there is
  // only ever one Drive.
  const { fetch, root, folder, mute } = detachment();
  root.put(['responses', 'req-1'], 'late.json', { rating: 3 });
  const res = fetch(`${API}files?q=${q(`'${idOf(folder)}' in parents and trashed=false`)}`
    + `&fields=${q('files(id,name)')}`, mute);
  const names = JSON.parse(res.getContentText()).files.map((f) => f.name);
  if (!names.includes('late.json')) {
    throw new Error(`REST cannot see a DriveApp write: ${names.join(', ')}`);
  }
});

check('a trashed file disappears from REST as it does from DriveApp', () => {
  const { fetch, folder, mute } = detachment();
  folder.files.get('bob.json').setTrashed(true);
  const res = fetch(`${API}files?q=${q(`'${idOf(folder)}' in parents and trashed=false`)}`
    + `&fields=${q('files(id,name)')}`, mute);
  const names = JSON.parse(res.getContentText()).files.map((f) => f.name);
  if (names.includes('bob.json')) throw new Error('a trashed file was still listed');
});

console.log(failures
  ? `\n${failures} Drive REST check(s) failed.`
  : '\nThe fake answers as the measured API does.');
process.exit(failures ? 1 : 0);
