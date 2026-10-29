/**
 * A simulated Apps Script environment, so the real proxy can be executed.
 *
 * Everything the proxy guarantees — role gating, space isolation, the commander
 * cap, one submission per cadet — was previously pinned as *source text*. That
 * catches a missing check. It does not catch a typo, a wrong argument order, or
 * a method that returns something other than what the code assumes, and Apps
 * Script has no type checking to catch them either.
 *
 * So `tools/proxy/Code.gs` is loaded and run here, unmodified, against an
 * in-memory Drive. Same file that gets pasted into the editor.
 *
 * WHAT THIS CATCHES, AND WHAT IT CANNOT
 *
 * It catches logic: a role that reaches a space it should not, a duplicate
 * submission that gets through, an id that escapes its folder. That is the part
 * worth testing, and the part the source-level checks could only approximate.
 *
 * It cannot catch the environment: real Drive quotas, real lock contention
 * across concurrent executions, Apps Script's own runtime quirks, or a
 * deployment misconfigured in the console. Those need a real deployment, and
 * this does not replace one — it means a real deployment is checking the
 * environment rather than discovering the logic is wrong.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

/* ------------------------------------------------------------------ *
 * an in-memory Drive
 * ------------------------------------------------------------------ */

/**
 * Every call the script makes to the Drive surface, counted.
 *
 * Not a performance measurement — an in-memory Map is nothing like Drive. It is
 * a count of *round trips*, which is the part that survives the translation: on
 * a real deployment each of these is a network call taking tens of
 * milliseconds, so the count is proportional to how long an execution runs.
 *
 * That matters because of the lock. `submit` holds one script-wide lock across
 * all of its Drive work (`Code.gs`, "the lock is what makes one submission per
 * cadet a rule"), so every submission in the detachment serialises behind it.
 * Operations-under-lock is therefore the number that decides how many cadets
 * can submit at once, and it is the only honest offline proxy for it.
 *
 * Deliberately counts only the Apps Script surface — `getFilesByName`,
 * `createFile` and friends. The test helpers below (`path`, `put`, `read`,
 * `snapshot`) reach into the Maps directly and are not counted, so seeding a
 * 45-cadet roster does not pollute the measurement of what the script then does.
 */
let opCount = 0;
const bump = () => { opCount += 1; };

/** Drive operations counted so far. */
export const ops = () => opCount;

/*
 * Outbound HTTP, counted separately and deliberately not folded into opCount.
 *
 * `ops()` counts the Apps Script Drive surface. From stage 2 of 1.4 the
 * expensive reads move to the Drive REST API over `UrlFetchApp`, and if the two
 * were summed a rewrite could halve `ops()` while doing strictly more work —
 * the suite reporting an improvement that is an artefact of what it chose to
 * measure. They are different cost models (quota'd API calls against bytes on
 * the wire) and summing them would produce a number that means nothing.
 *
 * Bytes as well as calls, because `fetchAll` makes calls cheap and payloads
 * large: one batched request for 130 documents is a single call and is not
 * therefore free.
 */
let netCalls = 0;
let netBytes = 0;
let netBatches = 0;

/**
 * Outbound HTTP so far: `{ calls, batches, bytes }`.
 *
 * **Calls and batches are different costs and only one of them stage 2 moves.**
 * `fetchAll` does not reduce the number of requests — quota is charged per
 * request whether it travelled in a batch or not — so `calls` grows linearly
 * with documents under both the old and new implementations, and a test
 * asserting otherwise is testing nothing.
 *
 * What stage 2 changes is `batches`: one round of concurrent requests instead
 * of N sequential ones. That is where the 7x came from, and it is the only one
 * of the two that distinguishes a batched read from a per-document loop.
 */
export const net = () => ({ calls: netCalls, batches: netBatches, bytes: netBytes });

/** Zero the counters, so a test can measure one action rather than a run. */
export const resetOps = () => { opCount = 0; netCalls = 0; netBytes = 0; netBatches = 0; };

/*
 * Ids, and why they live here rather than in the REST layer.
 *
 * DriveApp addresses things by name inside a folder; Drive REST addresses them
 * by id. Stage 2 of 1.4 reads through REST while everything else still writes
 * through DriveApp, so for the length of that stage **both must be views of one
 * store**. A REST fake with its own objects would let stage 2 pass against data
 * no other code path can see, which is the precise failure this harness exists
 * to prevent.
 */
let nextNodeId = 0;
const byNodeId = new Map();

function registerNode(node, kind) {
  const id = `${kind}-${++nextNodeId}`;
  node.id = id;
  byNodeId.set(id, node);
  return id;
}

/** The id Drive REST would address this node by. For writing tests. */
export const idOf = (node) => node.id;

class FakeFile {
  constructor(name, content) {
    this.name = name;
    this.content = content;
    this.trashed = false;
    registerNode(this, 'file');
  }

  getName() { return this.name; }

  /** Real DriveApp exposes this; stage 2 uses it to address the same node
   *  through Drive REST. Not counted: it reads an id already in hand. */
  getId() { return this.id; }

  getBlob() {
    // The download, not the lookup: in Drive these are separate round trips and
    // the script pays for both.
    bump();
    return { getDataAsString: () => this.content };
  }

  setContent(next) { bump(); this.content = next; }

  setTrashed(value) { bump(); this.trashed = value; }
}

/** Iterators in Apps Script are hasNext/next, not JavaScript iterables. */
function iterator(items) {
  let i = 0;
  return {
    hasNext: () => i < items.length,
    next: () => items[i++],
  };
}

class FakeFolder {
  constructor(name) {
    this.name = name;
    this.folders = new Map();
    this.files = new Map();
    this.trashed = false;
    registerNode(this, 'folder');
  }

  getName() { return this.name; }

  getId() { return this.id; }

  getFoldersByName(name) {
    bump();
    const found = this.folders.get(name);
    return iterator(found && !found.trashed ? [found] : []);
  }

  getFilesByName(name) {
    bump();
    const found = this.files.get(name);
    return iterator(found && !found.trashed ? [found] : []);
  }

  getFiles() {
    bump();
    return iterator([...this.files.values()].filter((f) => !f.trashed));
  }

  getFolders() {
    bump();
    return iterator([...this.folders.values()].filter((f) => !f.trashed));
  }

  createFolder(name) {
    bump();
    const folder = new FakeFolder(name);
    this.folders.set(name, folder);
    return folder;
  }

  createFile(blob) {
    bump();
    const file = new FakeFile(blob.name, blob.content);
    this.files.set(blob.name, file);
    return file;
  }

  setTrashed(value) { bump(); this.trashed = value; }

  /* ---- helpers for tests, not part of the Apps Script surface ---- */

  path(segments) {
    let node = this;
    for (const segment of segments) {
      if (!node.folders.has(segment)) node.folders.set(segment, new FakeFolder(segment));
      node = node.folders.get(segment);
    }
    return node;
  }

  put(segments, name, value) {
    this.path(segments).files.set(name, new FakeFile(name, JSON.stringify(value)));
  }

  read(segments, name) {
    let node = this;
    for (const segment of segments) {
      node = node.folders.get(segment);
      if (!node || node.trashed) return null;
    }
    const file = node.files.get(name);
    if (!file || file.trashed) return null;
    return JSON.parse(file.content);
  }

  /** Every live file, as `path -> parsed`, for asserting on the whole store. */
  snapshot(prefix = '', out = {}) {
    for (const file of this.files.values()) {
      if (file.trashed) continue;
      try { out[`${prefix}${file.name}`] = JSON.parse(file.content); }
      catch { out[`${prefix}${file.name}`] = file.content; }
    }
    for (const folder of this.folders.values()) {
      if (folder.trashed) continue;
      folder.snapshot(`${prefix}${folder.name}/`, out);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * loading the real script
 * ------------------------------------------------------------------ */

const SOURCE = readFileSync(new URL('../../tools/proxy/Code.gs', import.meta.url), 'utf8');

/**
 * Builds a fresh proxy instance with its own folder.
 *
 * @param {{folderId?: string, clientId?: string, tokens?: object}} options
 *   `tokens` maps a token string to the claims Google would return for it, so a
 *   test can hand out a valid token, an expired one, or one minted for another
 *   application without needing the network.
 */
/* ------------------------------------------------------------------ *
 * Fake Drive REST v3
 * ------------------------------------------------------------------ */

/**
 * The half of the store stage 2 reads through.
 *
 * **Every behaviour below was measured against real Drive before it was
 * written** — see tools/proxy/fidelity-probe.gs, run from the staging Apps
 * Script project on 28 Oct 2026. The expectations were written down first and
 * checked after, on purpose: a fake built by observing and then describing
 * agrees with whatever happened to be true that afternoon, accidents included.
 *
 * Confirmed and reproduced here:
 *
 *   pageSize caps at 1000; 2000 is a 400 naming the range    (E4)
 *   nextPageToken appears whenever a page is not the last    (E4)
 *   fields=files(id,name) projects, and nothing else arrives (E5)
 *   q escapes backslashes first, then single quotes          (E6)
 *   an UNescaped quote is a 400, never a silent miss         (E6)
 *   alt=media returns the raw body with no JSON envelope     (E7)
 *   a missing id is 404 with errors[0].reason "notFound"     (E11)
 *   non-2xx throws unless muteHttpExceptions is set          (E12)
 *   supportsAllDrives changes nothing for a My Drive folder  (E13)
 *
 * NOT confirmed, and marked so nobody mistakes it for measured:
 *
 *   E10 — rate limiting never triggered, even at 107 concurrent requests. It
 *   cannot be forced on demand. `throttleNext()` below lets a test drive the
 *   retry path, and it emits the 403-with-reason shape *as a guess*. Code the
 *   retry to accept 429 as well, and do not let a green test here be read as
 *   evidence that this is what Google sends.
 */

const DRIVE_REST = 'https://www.googleapis.com/drive/v3/';

/** Queued synthetic failures, for exercising paths real Drive will not produce. */
let throttleQueue = [];

/**
 * Make the next `count` REST calls answer as rate-limited.
 *
 * Unverified shape — see E10 above.
 */
export function throttleNext(count = 1, code = 403) {
  for (let i = 0; i < count; i++) throttleQueue.push(code);
}

const resetThrottle = () => { throttleQueue = []; };

function httpResponse(code, text) {
  return {
    getResponseCode: () => code,
    getContentText: () => text,
    getAllHeaders: () => ({}),
  };
}

function driveError(code, message, reason) {
  return JSON.stringify({
    error: { code, message, errors: [{ message, domain: 'global', reason }] },
  });
}

/**
 * Unescapes one `'...'` literal and reports whether it was legally escaped.
 *
 * Real Drive rejects an unescaped quote with a 400 rather than matching
 * nothing, which is the good failure mode: a silent miss would make a lookup
 * for `o'brien.json` return empty and look like a missing file.
 */
function readQuoted(text, from) {
  let out = '';
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\\' || next === "'") { out += next; i += 2; continue; }
      return { bad: true };
    }
    if (ch === "'") return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  return { bad: true };
}

/** Children of a folder, as REST sees them: files and subfolders together. */
function childrenOf(folder) {
  if (!folder || !(folder instanceof FakeFolder)) return [];
  return [
    ...[...folder.folders.values()].filter((f) => !f.trashed),
    ...[...folder.files.values()].filter((f) => !f.trashed),
  ];
}

function metaFor(node) {
  const isFolder = node instanceof FakeFolder;
  return {
    id: node.id,
    name: node.name,
    mimeType: isFolder ? 'application/vnd.google-apps.folder' : 'application/json',
    size: isFolder ? undefined : String(node.content.length),
  };
}

/** Applies a `fields=files(a,b),nextPageToken` projection. */
function project(rows, fields) {
  const inner = /files\(([^)]*)\)/.exec(fields || '');
  if (!inner) return rows;
  const keep = inner[1].split(',').map((f) => f.trim()).filter(Boolean);
  return rows.map((row) => {
    const out = {};
    for (const key of keep) if (row[key] !== undefined) out[key] = row[key];
    return out;
  });
}

function listFiles(params) {
  const q = params.get('q') || '';
  const fields = params.get('fields') || '';

  const size = params.has('pageSize') ? Number(params.get('pageSize')) : 100;
  if (!Number.isFinite(size) || size < 1 || size > 1000) {
    return httpResponse(400, driveError(400,
      `Invalid value '${params.get('pageSize')}'. Values must be within the range: [value: 1\n, value: 1000\n]`,
      'invalid'));
  }

  // q: "'<id>' in parents and trashed=false [and name = '<escaped>']"
  const parent = /'([^']+)' in parents/.exec(q);
  if (!parent) {
    return httpResponse(400, driveError(400, `Invalid Value: ${q}`, 'invalid'));
  }
  let rows = childrenOf(byNodeId.get(parent[1]));

  const nameAt = q.indexOf("name = '");
  if (nameAt >= 0) {
    const parsed = readQuoted(q, nameAt + "name = '".length);
    if (parsed.bad) {
      return httpResponse(400, driveError(400, `Invalid Value: ${q}`, 'invalid'));
    }
    // An unescaped quote closes the literal early and leaves the rest of the
    // name sitting in the query as syntax. Without this check the fake parsed
    // "name = 'o'brien.json'" as name = "o", matched nothing, and returned an
    // empty 200 — a silent miss, which is the one behaviour real Drive does
    // NOT have. It answers 400, and that difference is worth a day of somebody
    // hunting a file that was there all along.
    const rest = q.slice(parsed.end);
    if (rest && !/^\s*(and|or)\s/i.test(rest)) {
      return httpResponse(400, driveError(400, `Invalid Value: ${q}`, 'invalid'));
    }
    rows = rows.filter((n) => n.name === parsed.value);
  }

  const from = Number(params.get('pageToken') || 0);
  const page = rows.slice(from, from + size);
  const body = { files: project(page.map(metaFor), fields) };
  if (from + size < rows.length) body.nextPageToken = String(from + size);
  return httpResponse(200, JSON.stringify(body));
}

function driveRest(url, options) {
  // Drive refuses an unauthenticated call. Checked here because the failure it
  // guards — forgetting the header on one request out of a batch — produces a
  // listing that is quietly short rather than an error, which is the hardest
  // kind of bug to see.
  const auth = (options && options.headers && options.headers.Authorization) || '';
  if (!/^Bearer \S+/.test(auth)) {
    return httpResponse(401, driveError(401, 'Request is missing required authentication credential.', 'required'));
  }

  const parsed = new URL(url);
  const params = parsed.searchParams;
  const tail = parsed.pathname.split('/drive/v3/')[1] || '';

  if (throttleQueue.length) {
    const code = throttleQueue.shift();
    return httpResponse(code, driveError(code,
      'Rate Limit Exceeded', code === 429 ? 'rateLimitExceeded' : 'rateLimitExceeded'));
  }

  if (tail === 'files') return listFiles(params);

  const id = tail.startsWith('files/') ? tail.slice('files/'.length) : null;
  if (!id) return httpResponse(404, driveError(404, `Not Found: ${tail}`, 'notFound'));

  const node = byNodeId.get(id);
  if (!node || node.trashed) {
    return httpResponse(404, driveError(404, `File not found: ${id}.`, 'notFound'));
  }
  if (params.get('alt') === 'media') {
    if (node instanceof FakeFolder) {
      return httpResponse(403, driveError(403,
        'Only files with binary content can be downloaded.', 'fileNotDownloadable'));
    }
    return httpResponse(200, node.content);
  }
  return httpResponse(200, JSON.stringify(project([metaFor(node)], `files(${params.get('fields') || 'id,name,mimeType,size'})`)[0]));
}

export function createProxy({
  clientId = 'test-client.apps.googleusercontent.com',
  tokens = {},
  configured = true,
  properties: extraProperties = {},
  mailQuota = 100,
  mailApp = 'record',
} = {}) {
  const root = new FakeFolder('9ThirtyOne');
  const cache = new Map();
  let uuidCounter = 0;
  let lockHeld = false;
  const lockWaits = [];

  // Drive operations performed between waitLock and releaseLock, one entry per
  // completed critical section. See the note on `bump` above for why this is
  // the number that decides how many cadets can submit at once.
  const lockedOps = [];
  let opsAtAcquire = null;

  /**
   * The proxy now decodes the token locally before spending a network call, so
   * a bare label like "tok-cadet" is rejected before it ever reaches the fake
   * UrlFetchApp. Tests still address tokens by label; each is encoded into a
   * real JWT here and swapped in by `post`, which means the local decode path
   * is genuinely exercised rather than stepped around.
   */
  const b64url = (value) => Buffer.from(value).toString('base64url');
  const encodeJwt = (claims) =>
    `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.`
    + `${b64url(JSON.stringify(claims))}.`
    + b64url('signature-not-checked-here');

  const jwtByLabel = new Map();
  const byJwt = new Map();
  for (const [label, claims] of Object.entries(tokens)) {
    const jwt = encodeJwt(claims);
    jwtByLabel.set(label, jwt);
    byJwt.set(jwt, claims);
  }

  /** Every tokeninfo URL fetched, so a test can count network calls. */
  const fetches = [];

  const properties = {
    ...(configured ? { FOLDER_ID: 'folder-1', CLIENT_ID: clientId } : {}),
    ...extraProperties,
  };

  /**
   * Every message the script tried to send.
   *
   * `mailApp` picks the behaviour:
   *   'record'    — collect them, the normal case
   *   'forbidden' — throw on any access, for proving the feature is inert
   *   'failing'   — throw on send, for proving a failure cannot fail the save
   *
   * 'forbidden' earns its keep. The notify call sits inside a swallowing catch,
   * so an accidental MailApp reference with the switch off would be eaten
   * silently and `mails.length === 0` would still pass. Making the object itself
   * explode is the only way to see it.
   */
  const mails = [];
  const mailStub = {
    record: {
      getRemainingDailyQuota: () => mailQuota,
      sendEmail: (options) => { mails.push(options); },
    },
    failing: {
      getRemainingDailyQuota: () => mailQuota,
      sendEmail: () => { throw new Error('mail service unavailable'); },
    },
    forbidden: {
      getRemainingDailyQuota: () => { throw new Error('MailApp touched while off'); },
      sendEmail: () => { throw new Error('MailApp touched while off'); },
    },
  }[mailApp];

  const sandbox = {
    console: { error() {}, warn() {}, log() {} },

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] ?? null,
        setProperties: (next) => Object.assign(properties, next),
      }),
    },

    DriveApp: {
      getFolderById(id) {
        // Was hard-wired to 'folder-1'. Now resolved through the same registry
        // the REST layer reads, so a folder created in a test is addressable
        // from both halves of the store rather than only one.
        if (id === 'folder-1') return root;
        const node = byNodeId.get(id);
        if (!node || !(node instanceof FakeFolder) || node.trashed) {
          throw new Error(`No folder with id ${id}`);
        }
        return node;
      },
    },

    Utilities: {
      newBlob: (content, type, name) => ({
        content, type, name,
        // Real Blobs carry bytes; the proxy builds one from base64 output to
        // read a JWT payload back as text.
        getDataAsString: () => (typeof content === 'string' ? content : Buffer.from(content).toString('utf8')),
      }),
      base64DecodeWebSafe: (value) => [...Buffer.from(String(value), 'base64url')],
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_algorithm, value) =>
        [...createHash('sha256').update(String(value)).digest()].map((b) => (b > 127 ? b - 256 : b)),
      // Deterministic, so a test can predict the ids a run produces — but the
      // counter has to live in the *leading* characters. `buildResponse` builds
      // a response id from `getUuid().replace(/-/g, '').slice(0, 14)`, so a
      // counter in the trailing group gets sliced off and every response in a
      // run is handed the same id. In a Map keyed by filename that reads as 45
      // cadets submitting and one response surviving, which is a fault in this
      // fake rather than in the script, and one that only appears at volume.
      getUuid: () => `${String(uuidCounter++).padStart(8, '0')}-0000-4000-8000-000000000000`,
      formatDate: (date, _tz, format) => {
        const iso = date.toISOString();
        return format === 'yyyy-MM' ? iso.slice(0, 7) : iso;
      },
    },

    CacheService: {
      getScriptCache: () => ({
        get: (key) => (cache.has(key) ? cache.get(key) : null),
        put: (key, value) => { cache.set(key, value); },
      }),
    },

    LockService: {
      getScriptLock: () => ({
        waitLock(ms) {
          lockWaits.push(ms);
          if (lockHeld) throw new Error('Could not obtain lock');
          lockHeld = true;
          opsAtAcquire = opCount;
        },
        releaseLock() {
          lockHeld = false;
          if (opsAtAcquire !== null) lockedOps.push(opCount - opsAtAcquire);
          opsAtAcquire = null;
        },
      }),
    },

    MailApp: mailStub,

    /**
     * Only getOAuthToken, which is all Code.gs uses. Measured as E1/E2: the
     * token this returns is accepted by Drive REST v3, and the scopes DriveApp
     * already forces cover files.list and alt=media — so no manifest change and
     * no re-consent by any detachment.
     */
    ScriptApp: {
      getOAuthToken: () => 'fake-oauth-token-for-tests',
    },

    UrlFetchApp: {
      fetch(url, options) {
        netBatches += 1;
        // `fetches` means tokeninfo specifically — it is how the suite asserts
        // the verification cache holds, and it is the quota an attacker would
        // burn. Drive REST is outbound HTTP too, but it is a different cost
        // against a different limit, so it is counted in net() and nowhere
        // else. Pushing both here made "verified once" read 16 verifications.
        netCalls += 1;

        // Drive REST, from stage 2 onward. Routed here rather than given its
        // own binding because that is how Code.gs will reach it in production:
        // through UrlFetchApp, counted against the same quota as everything
        // else this script sends.
        if (String(url).startsWith(DRIVE_REST)) {
          const res = driveRest(String(url), options);
          netBytes += res.getContentText().length;
          // E12, measured: UrlFetchApp throws on any non-2xx unless
          // muteHttpExceptions is set. An error-handling path written without
          // it never runs, so the fake has to throw too or the tests would
          // prove the opposite of what production does.
          if (res.getResponseCode() >= 300 && !(options && options.muteHttpExceptions)) {
            throw new Error(`Request failed for https://www.googleapis.com returned code `
              + `${res.getResponseCode()}. Truncated server response: ${res.getContentText().slice(0, 120)}`);
          }
          return res;
        }

        fetches.push(url);
        const token = decodeURIComponent(url.split('id_token=')[1] || '');
        const claims = byJwt.get(token);
        const body = JSON.stringify(claims || { error: 'invalid_token' });
        netBytes += body.length;
        return {
          getResponseCode: () => (claims ? 200 : 400),
          getContentText: () => body,
        };
      },
      /**
       * Present so stage 2 has something to run against, and counted the same
       * way. Apps Script issues these concurrently, which is the entire point
       * of using it — so this counts one call per request rather than one per
       * batch, because the quota and the bytes are both per request. A batch
       * that looks like a single operation here would hide exactly the cost
       * the stage is meant to be reducing.
       */
      fetchAll(requests) {
        // One batch, however many requests ride in it. fetch() below counts
        // each request against the quota; this counts the round trip, which is
        // the thing concurrency actually buys.
        netBatches += 1;
        const list = requests || [];
        const out = list.map((req) => (typeof req === 'string'
          ? this.fetch(req)
          : this.fetch(req.url, req)));
        netBatches -= list.length; // fetch() counted each; keep only the batch
        return out;
      },
    },

    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        text,
        setMimeType() { return this; },
      }),
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'Code.gs' });

  /** Calls doPost the way a browser would, and parses the answer. */
  const post = (body) => {
    const sent = jwtByLabel.has(body.idToken)
      ? { ...body, idToken: jwtByLabel.get(body.idToken) }
      : body;
    const output = sandbox.doPost({ postData: { contents: JSON.stringify(sent) } });
    return JSON.parse(output.text);
  };

  /** Sends a raw body, for testing what happens when it is not JSON at all. */
  const postRaw = (contents) => {
    const output = sandbox.doPost({ postData: { contents } });
    return JSON.parse(output.text);
  };

  return {
    root,
    post,
    postRaw,
    get: () => JSON.parse(sandbox.doGet().text),
    /** True while a test is holding the lock, to simulate contention. */
    holdLock: () => { lockHeld = true; },
    releaseLock: () => { lockHeld = false; },
    lockWaits,
    /** Drive operations per completed critical section, newest last. */
    lockedOps,
    /** tokeninfo calls made so far — the quota an attacker would burn. */
    fetches,
    /** Messages the script tried to send, newest last. */
    mails,
    /** The JWT a label encodes to, for tests that need the raw string. */
    jwtFor: (label) => jwtByLabel.get(label),
    /**
     * The Apps Script globals, for tests that exercise a binding directly
     * rather than through doPost. drive-rest.test.mjs calls UrlFetchApp the way
     * Code.gs will once stage 2 lands.
     */
    sandbox,
    /** Queue synthetic rate limiting. UNVERIFIED shape — see throttleNext. */
    throttleNext,
  };
}

/** A token whose claims Google would accept. */
export function validToken(email, clientId = 'test-client.apps.googleusercontent.com') {
  return {
    // Real Google ID tokens carry an issuer, and the proxy checks it before
    // spending a network call. Omitting it here made every token look forged.
    iss: 'https://accounts.google.com',
    aud: clientId,
    email,
    email_verified: 'true',
    exp: String(Math.floor(Date.now() / 1000) + 3600),
    sub: `sub-${email}`,
  };
}

/** Seeds a roster, and returns it so tests can assert against it. */
export function seedRoster(root, accounts) {
  root.put(['users'], 'users.json', { schemaVersion: 4, users: accounts });
  return accounts;
}

export function account(username, email, roles, extra = {}) {
  return {
    id: `usr_${username}`,
    username,
    email,
    name: username,
    roles,
    active: true,
    asClass: 'AS200',
    ...extra,
  };
}
