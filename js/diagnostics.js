/**
 * The file a detachment sends when something is wrong and nobody can look.
 *
 * A detachment's install runs on its own Drive and its own Apps Script
 * deployment, and deliberately not on ours — that is the privacy arrangement the
 * whole design rests on. The cost of it is that when something misbehaves there
 * is nothing to inspect. This is the one channel back, and it has to earn its
 * place twice over: useful enough to diagnose an install sight unseen, and safe
 * enough that a cadre member can read it before pressing send.
 *
 * WHAT THIS REPLACED
 *
 * There was a diagnostics download before this, and it was a device dump: app
 * version, the connection record, display settings, round-trip times, user
 * agent. It described the browser rather than the install, and it was redacted
 * backwards — it hid `clientId`, which `config.js` says outright is public, while
 * emitting the detachment's name, its Drive folder id and URL, and the proxy URL
 * verbatim. That last one is capability-bearing: `doGet` verifies no token, so
 * anyone holding the URL can wake and poll a detachment's Apps Script quota.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 *   - The roster, and anything derived from it but the counts.
 *   - Any free text at all: no audit summaries, no deletion reasons, no answers.
 *   - Queue paths. Receipts are stored as `receipts/<requestId>/<username>.json`,
 *     so a list of paths is a list of usernames, and "we only sent the paths, not
 *     the payloads" would not have been true.
 *   - Adapter `status().detail`, which is a sentence containing the folder name.
 *   - **Any timestamp with a time component.** A submission logged to the second
 *     lines up against a receipt written moments later, which is the correlation
 *     `export-anon.js` exists to defeat; it survives having the names removed.
 *     Dates here are months. Round trips keep their *spacing* — that is what
 *     diagnoses a cold start — as an offset from the first one, which says how
 *     the calls were spaced without saying when they happened.
 *
 * HOW IT STAYS THAT WAY
 *
 * Every section is built by naming the fields that go in, never by taking an
 * object and deleting from it. A field is here because somebody decided it
 * should be, not because nobody remembered to remove it — the same construction
 * `stripResponse` uses in `export-anon.js`. When a new field appears on
 * `connection` or on an audit entry, it does not silently arrive in this file.
 *
 * `tests/unit/diagnostics.test.mjs` searches the serialised text for seeded
 * names, emails, folder ids and the org name, rather than checking fields — a
 * field-by-field assertion only proves the fields somebody thought of are clean.
 */

import { APP, GOOGLE_CLIENT_ID, DB_LAYOUT } from './config.js';
import { connection, settings } from './state.js';
import { db } from './storage/index.js';
import { proxyTimings, proxyTimingSummary, checkProxy, isProxyUrl } from './storage/proxy.js';
import { queueState } from './storage/queue.js';
import { failureCounts } from './failures.js';

/** Dates become months — the same reduction, and for the same reason, as export-anon.js. */
function toMonth(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : null;
}

/**
 * Runs one section, and never lets it take the file down with it.
 *
 * Half the reason to ask for this file is that something is broken, so sections
 * failing is the expected case, not the exceptional one. A builder that threw on
 * the first missing folder would be useless exactly when it was needed. An
 * unavailable section says so and the rest of the file still arrives.
 */
async function section(fn) {
  try {
    const value = await fn();
    return value === undefined ? 'unavailable' : value;
  } catch {
    return 'unavailable';
  }
}

/** Which Client ID is in use, without reproducing it. */
function clientIdKind(clientId) {
  if (!clientId) return 'absent';
  return clientId === GOOGLE_CLIENT_ID ? 'shared-default' : 'custom';
}

/**
 * Browser and platform, coarsened.
 *
 * The full user-agent string is a fingerprint, and a detachment-level report
 * does not need one. Family and major version answer every question this file
 * exists to answer — "is this Safari on an old iPad" — and nothing else.
 */
function platform() {
  const ua = String(navigator.userAgent || '');
  const browser = [
    [/Edg\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+).*Safari/, 'Safari'],
  ].reduce((found, [re, name]) => found || (re.test(ua) ? `${name} ${ua.match(re)[1]}` : null), null);

  const os = [
    [/iPhone|iPad|iPod/, 'iOS'],
    [/Android/, 'Android'],
    [/Mac OS X/, 'macOS'],
    [/Windows/, 'Windows'],
    [/Linux/, 'Linux'],
  ].reduce((found, [re, name]) => found || (re.test(ua) ? name : null), null);

  return {
    browser: browser || 'unrecognised',
    os: os || 'unrecognised',
    online: navigator.onLine,
    secureContext: window.isSecureContext,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
    touch: navigator.maxTouchPoints > 0,
  };
}

/**
 * Which build is actually executing.
 *
 * The largest blind spot in the old file. This is a PWA: a device whose service
 * worker is still serving an old shell is running code that was replaced, and
 * every report from it describes a build that no longer exists. `caches.keys()`
 * names the shells present, and `activate` prunes to one — so more than one
 * entry here means an update that did not finish.
 */
async function build() {
  const caches = 'caches' in window
    ? (await window.caches.keys()).filter((k) => k.startsWith('nine31-shell-'))
    : [];

  let worker = 'unsupported';
  if (navigator.serviceWorker) {
    const registration = await navigator.serviceWorker.getRegistration();
    worker = registration
      ? {
        active: registration.active?.state || null,
        waiting: Boolean(registration.waiting),
        installing: Boolean(registration.installing),
        controlling: Boolean(navigator.serviceWorker.controller),
      }
      : 'not registered';
  }

  return {
    appVersion: APP.version,
    schemaVersion: APP.schemaVersion,
    shellCaches: caches,
    serviceWorker: worker,
  };
}

/** How this device is pointed at a detachment, with nothing that addresses it. */
function install() {
  const conn = connection.get();
  return {
    backend: conn.backend || 'none',
    clientId: clientIdKind(conn.clientId),
    proxyConfigured: Boolean(conn.proxyUrl),
    // Whether the stored URL is even the right shape. A deployment pasted from
    // the wrong place is a common enough setup failure to be worth one boolean,
    // and it needs none of the URL to answer.
    proxyUrlWellFormed: conn.proxyUrl ? isProxyUrl(conn.proxyUrl) : null,
    connectedMonth: toMonth(conn.connectedAt),
    // Display preferences only: these change what a screenshot looks like,
    // which is worth knowing when somebody reports a layout fault. Named
    // individually rather than spread, so a future preference holding something
    // about a person does not arrive here by default.
    display: {
      theme: settings.get().theme || null,
      palette: settings.get().palette || null,
      contrast: settings.get().contrast || null,
      textSize: settings.get().textSize || null,
      reduceMotion: Boolean(settings.get().reduceMotion),
    },
  };
}

/**
 * The submission server, including the version it is actually running.
 *
 * `checkProxy` has always returned the deployed `PROXY_VERSION` and the client
 * has always discarded it — nothing compares it to anything, so a detachment on
 * a stale `Code.gs` reports perfectly healthy. It is one unauthenticated GET
 * that costs no `UrlFetch` quota, and it is the difference between fixing
 * something and guessing.
 */
async function proxy() {
  const conn = connection.get();
  if (!conn.proxyUrl) return { configured: false };

  const rows = proxyTimings();
  const first = rows.length ? Date.parse(rows[0].at) : 0;

  const summary = proxyTimingSummary(rows);
  // `since` is a precise timestamp; the count it summarises is not.
  delete summary.since;

  return {
    configured: true,
    deployment: await section(async () => {
      const result = await checkProxy(conn.proxyUrl);
      return result.ok
        ? { reachable: true, version: result.version, configured: result.configured, ms: result.ms }
        : { reachable: false };
    }),
    summary,
    // Spacing without wall-clock: how far each call sat from the first one in
    // the buffer, which is what shows a cold start followed by warm calls.
    roundTrips: rows.map((r) => ({
      action: r.action,
      ms: r.ms,
      ok: r.ok,
      sinceFirstMs: first ? Date.parse(r.at) - first : null,
    })),
  };
}

/**
 * Whether the folder tree is intact.
 *
 * `listFolders` returns folder names and nothing else, which is the only reason
 * this is safe to include: a *file* listing of `receipts/` would be a list of
 * usernames, because that is how receipts are stored.
 *
 * Only the Drive and local-folder adapters have it. IndexedDB has no folders to
 * miss, and proxy mode has no adapter on this device at all, so both report
 * unavailable rather than pretending to an answer.
 */
async function layout() {
  if (typeof db.adapter?.listFolders !== 'function') return 'unavailable';
  const expected = Object.values(DB_LAYOUT.folders);
  const present = (await db.adapter.listFolders('')).map((f) => f.name || f);
  return {
    expected: expected.length,
    missing: expected.filter((name) => !present.includes(name)),
  };
}

/**
 * Builds the whole report.
 *
 * @returns {Promise<object>} ready to serialise; never throws.
 */
export async function buildDiagnostics() {
  const conn = connection.get();

  return {
    format: 'nine31-diagnostics',
    appVersion: APP.version,
    schemaVersion: APP.schemaVersion,
    generatedMonth: toMonth(new Date().toISOString()),

    // Stated in the file, so the person sending it can check rather than trust.
    redacted: {
      roster: 'never included',
      feedback: 'never included',
      freeText: 'never included, including audit summaries and deletion reasons',
      detachmentName: 'removed',
      folderId: 'removed',
      proxyUrl: 'removed — it is a working address, kept out of a file that travels',
      timestamps: 'reduced to the month; round trips keep spacing, not wall-clock',
      clientId: 'reported as shared-default, custom or absent',
    },
    notice: 'Technical information about this installation only. It contains no '
      + 'roster, no feedback and no free text, and nothing here identifies a cadet.',

    build: await section(build),
    install: install(),
    platform: platform(),
    proxy: await section(proxy),

    // Where the folder's schema stands against this build — behind, level, or
    // mid-migration.
    schema: await section(() => db.migrationStatus()),

    // Enough to tell a five-person pilot from a full wing, which is what decides
    // whether a slow screen is a defect or a volume.
    //
    // The response numbers come from `responses/_counts.json`, and that document
    // is deliberately best-effort: a submission writes its own file and touches
    // no shared index, because a read-modify-write on a counter is exactly what
    // two simultaneous submissions would clobber. Readers repair it instead. So
    // a zero here means "nobody has opened a panel since these arrived" as often
    // as it means "none", and reporting the number without saying so would send
    // somebody looking for a bug in a detachment that simply has not been read
    // yet. `students` and `requests` are counted directly and are exact.
    scale: await section(async () => {
      const stats = await db.stats();
      const counts = await db.responseCounts();
      // Named rather than spread, like everything else here: a field added to
      // `db.stats()` later should have to be let in, not arrive.
      return {
        forms: stats.forms,
        requests: stats.requests,
        openRequests: stats.openRequests,
        students: stats.students,
        instructors: stats.instructors,
        admins: stats.admins,
        responses: stats.responses,
        responsesPerRequest: counts.byRequest || {},
        responseCountSource: 'index — best-effort, repaired when a panel reads responses',
      };
    }),

    health: {
      // The code, never the detail: every adapter's detail is a sentence with
      // the folder name in it.
      storage: await section(async () => (await db.status()).status),
      folders: await section(layout),
      queue: await section(async () => {
        const state = await queueState();
        return { pending: state.pending, draining: state.draining };
      }),
    },

    // What kinds of things have been done, never by whom or to what. The action
    // names are a closed set; everything else on an audit entry is identifying.
    activity: await section(async () => {
      const { loadAudit } = await import('./data-source.js');
      const entries = await loadAudit(3);
      const histogram = {};
      for (const entry of entries) {
        const key = `${toMonth(entry.at)} ${entry.action}`;
        histogram[key] = (histogram[key] || 0) + 1;
      }
      return histogram;
    }),

    failures: failureCounts(),

    // Named last because it is the one thing here that is not automatic: if the
    // proxy is configured but unreachable above, this says whether the device
    // even thinks it is online.
    reachability: {
      proxyConfigured: Boolean(conn.proxyUrl),
      online: navigator.onLine,
    },
  };
}

/** The filename, dated like every other export in the app. */
export function diagnosticsFilename() {
  return `nine31-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
}
