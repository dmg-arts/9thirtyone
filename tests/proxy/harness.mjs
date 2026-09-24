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

/** Zero the counter, so a test can measure one action rather than a run. */
export const resetOps = () => { opCount = 0; };

class FakeFile {
  constructor(name, content) {
    this.name = name;
    this.content = content;
    this.trashed = false;
  }

  getName() { return this.name; }

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
  }

  getName() { return this.name; }

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
export function createProxy({
  clientId = 'test-client.apps.googleusercontent.com',
  tokens = {},
  configured = true,
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

  const properties = configured
    ? { FOLDER_ID: 'folder-1', CLIENT_ID: clientId }
    : {};

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
        if (id !== 'folder-1') throw new Error(`No folder with id ${id}`);
        return root;
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

    UrlFetchApp: {
      fetch(url) {
        fetches.push(url);
        const token = decodeURIComponent(url.split('id_token=')[1] || '');
        const claims = byJwt.get(token);
        return {
          getResponseCode: () => (claims ? 200 : 400),
          getContentText: () => JSON.stringify(claims || { error: 'invalid_token' }),
        };
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
    /** The JWT a label encodes to, for tests that need the raw string. */
    jwtFor: (label) => jwtByLabel.get(label),
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
