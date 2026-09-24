/**
 * The submission proxy client.
 *
 * When a detachment has deployed the Apps Script in tools/proxy, cadets stop
 * writing to Drive and post here instead. The script verifies their Google ID
 * token server-side and writes the files with the owner's credentials, which
 * means cadets need no Drive access at all — and therefore cannot read, alter
 * or delete anyone else's feedback.
 *
 * The proxy is optional. A detachment that has not deployed it keeps the
 * previous behaviour, where every cadet needs Editor on the folder. That is a
 * worse position and the setup guide says so, but it works, and forcing an
 * Apps Script deployment on a detachment mid-term to keep a working app running
 * would be the wrong trade.
 *
 * TWO THINGS THAT LOOK WRONG AND ARE NOT
 *
 * **Content-Type is text/plain on a JSON body.** That makes the POST a CORS
 * "simple request", which skips the preflight. Apps Script cannot answer a
 * preflight OPTIONS, so a correctly-labelled application/json post fails before
 * it ever reaches the script. The body really is JSON; only the header is
 * lying, and it is lying to get around a limitation on Google's side.
 *
 * **Errors come back with HTTP 200.** Apps Script renders a thrown error as an
 * HTML page, which a fetch cannot parse into anything useful. The script always
 * answers 200 with `{ok: false, error}` so the cadet sees the actual reason.
 * A non-200 here therefore means the network or the deployment is broken, not
 * that the submission was refused.
 */

import { LS } from '../config.js';
import { recordFailure } from '../failures.js';

/** Google's own redirect chain is slow on a bad campus connection. */
const TIMEOUT_MS = 30000;

/* ------------------------------------------------------------------ *
 * how long the server takes
 *
 * Apps Script lets an idle deployment sleep, so the first call back pays a cold
 * start — and until this existed the only way to know how long was to sit with a
 * stopwatch, which is how the question came up. Every round trip is timed and the
 * last few kept, so the answer can be read off instead.
 *
 * Deliberately no "was this a cold start" flag. That is a judgement, and baking it
 * into the record would hide the numbers it was inferred from; a cold start shows
 * up plainly as an outlier. Durations and action names only — nothing here
 * identifies a person, so the diagnostics file stays as safe to send as it was.
 * ------------------------------------------------------------------ */

const TIMINGS_KEPT = 50;

/** Reads the ring buffer. Never throws: private browsing can refuse storage. */
export function proxyTimings() {
  try {
    const raw = localStorage.getItem(LS.proxyTimings);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Records one round trip.
 *
 * Wrapped end to end: a full or disabled localStorage must never be the reason a
 * cadet's submission fails. Measuring is the least important thing happening on
 * this code path.
 */
function recordTiming(action, ms, ok) {
  try {
    const rows = proxyTimings();
    rows.push({ at: new Date().toISOString(), action, ms: Math.round(ms), ok });
    localStorage.setItem(LS.proxyTimings, JSON.stringify(rows.slice(-TIMINGS_KEPT)));
  } catch { /* measuring must not break anything */ }
}

/** Count, median and slowest — enough to see a cold start without reading rows. */
export function proxyTimingSummary(rows = proxyTimings()) {
  if (!rows.length) return { count: 0 };
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const mid = Math.floor(ms.length / 2);
  return {
    count: ms.length,
    medianMs: ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2),
    slowestMs: ms[ms.length - 1],
    fastestMs: ms[0],
    since: rows[0].at,
  };
}

/**
 * What a deployment calls itself, and what it used to.
 *
 * Exported because `data-source.connectionStatus` runs the same health check for
 * the app bar and had its own copy of the current name and none of the old one —
 * so the two disagreed about a deployment left on the pre-rename script: Settings
 * said "running an older version, redeploy", the header just said ready.
 */
export const PROXY_SERVICE = 'nine31-proxy';
export const PROXY_SERVICE_LEGACY = 'top-feedback-proxy';

/** Recognises a deployed Apps Script web app URL. */
const EXEC_PATTERN = /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]+\/exec$/;

/**
 * True only for a deployed Apps Script web app URL.
 *
 * Exported so `js/join.js` can use the same definition rather than keeping a
 * second copy of the pattern. A join link designates where a cadet's answers
 * and their Google sign-in are sent, so two patterns that could drift apart is
 * exactly the wrong shape for this check.
 */
export function isProxyUrl(url) {
  return EXEC_PATTERN.test(String(url || '').trim());
}

/**
 * Checks the shape of a proxy URL before anyone relies on it.
 *
 * @returns {string|null} an error message, or null when it looks right.
 */
export function validateProxyUrl(url) {
  const value = String(url || '').trim();
  if (!value) return 'Enter the web app URL, or leave this blank to turn the proxy off.';
  if (!/^https:\/\//.test(value)) return 'That must be an https address.';
  if (value.includes('/dev')) {
    return 'That is the test URL. Deploy the script and use the /exec address instead — '
      + 'the /dev one only works for you.';
  }
  if (!EXEC_PATTERN.test(value)) {
    return 'That does not look like an Apps Script web app URL. It should end in /exec.';
  }
  return null;
}

/**
 * Marks a failure as worth trying again.
 *
 * The distinction that matters is transport versus answer. A refusal the script
 * actually sent — not on the roster, not allowed, already submitted — is a real
 * answer, and repeating it produces a slower, less clear version of the same no.
 * Only a request that never got an answer is worth repeating.
 */
function transient(err) {
  err.transient = true;
  return err;
}

/**
 * The server's way of saying it could not take the lock in time.
 *
 * Matched on the message because that is all the script sends — `fail()` emits
 * `{ok: false, error}` with no code. Matching prose is not lovely, and the
 * client already does it for "not on this detachment"; if the proxy ever grows
 * a machine-readable reason, this is the first thing that should use it.
 */
const BUSY = /server is busy/i;
const BUSY_RETRY_MS = 1200;

async function postJson(url, payload, { timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const began = Date.now();
  let served = false;
  try {
    const response = await fetch(url, {
      method: 'POST',
      // See the header: text/plain avoids a preflight Apps Script cannot answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      recordFailure('proxy', response.status);
      const err = new Error(`The submission service answered ${response.status}. `
        + 'Its deployment may need updating.');
      // 5xx is Apps Script having a bad moment, which a second attempt often
      // survives. 4xx is the deployment being wrong, which it never does.
      throw response.status >= 500 ? transient(err) : err;
    }

    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      served = true;
      return parsed;
    } catch {
      // Apps Script serves a sign-in page when a deployment is set to anything
      // other than "anyone", which is the single most common misconfiguration.
      // Counted under its own name because it is a setup fault, not an outage,
      // and the two want different advice.
      recordFailure('proxy', 'sign-in-page');
      throw new Error('The submission service returned a sign-in page instead of an answer. '
        + 'Its deployment access is probably not set to "Anyone".');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      recordFailure('proxy', 'timeout');
      throw transient(new Error(
        'The submission service did not answer in time. Check your connection.'));
    }
    // fetch rejects with a TypeError when the request never reached anybody.
    if (err instanceof TypeError) {
      recordFailure('proxy', 'unreachable');
      throw transient(err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    recordTiming(payload?.action || 'post', Date.now() - began, served);
  }
}

/**
 * Wakes the deployment, and waits for nothing.
 *
 * Apps Script sleeps when idle, so the first call back has to start a container.
 * The app already health-checks on navigation, but that fires as somebody *arrives*
 * at sign-in — a quick click then races a container still booting. Called when the
 * screen paints instead, the Google account-chooser popup absorbs the wait: two to
 * five seconds of human time that was being wasted.
 *
 * Costs one script execution and no `UrlFetch`, because `doGet` verifies no token
 * and so never calls out to Google. Bounded, and every failure swallowed: this is
 * an optimisation, and an optimisation that can break sign-in is not one.
 */
export function warmProxy(url) {
  if (!url) return;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);
    fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal })
      .catch(() => {});
  } catch { /* nothing here is worth failing a sign-in for */ }
}

/**
 * Confirms a deployment is reachable and configured. Used by Settings so an
 * administrator finds out now rather than when a cadet cannot submit.
 *
 * @returns {Promise<{ok: boolean, version?: string, configured?: boolean, error?: string}>}
 */
export async function checkProxy(url) {
  const problem = validateProxyUrl(url);
  if (problem) return { ok: false, error: problem };

  let response;
  const began = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    recordTiming('health', Date.now() - began, false);
    return { ok: false, error: 'Could not reach that address. Check the URL and the network.' };
  }
  // Measured to here: the answer has arrived, and how it is judged below costs
  // nothing. This is the figure Settings reports, and pressing Save and test twice
  // is the cheapest way to see a cold start — the first is slow, the second is not.
  const ms = Date.now() - began;
  recordTiming('health', ms, true);

  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return {
      ok: false,
      error: 'That address answered, but not with a 9ThirtyOne proxy. If the deployment asks '
        + 'people to sign in, set its access to "Anyone" and deploy again.',
    };
  }

  if (body.service === PROXY_SERVICE_LEGACY) {
    // The name it answered to before the rename. Recognised rather than
    // rejected so the message can say what to do instead of "not ours".
    return {
      ok: false,
      error: 'That deployment is running an older version of the script, from before the app '
        + 'was renamed. Open the Apps Script editor, paste in the current Code.gs, and deploy '
        + 'a new version. The URL does not change.',
    };
  }
  if (body.service !== PROXY_SERVICE) {
    return { ok: false, error: 'That is a Google Apps Script, but not the 9ThirtyOne proxy.' };
  }
  if (!body.configured) {
    return {
      ok: false,
      error: 'The proxy is deployed but not configured. In the Apps Script editor open '
        + 'Project Settings → Script Properties and add FOLDER_ID and CLIENT_ID, then Save.',
    };
  }
  return { ok: true, version: body.version, configured: true, ms };
}

/**
 * Fetches everything one cadet is allowed to see.
 *
 * A single call on purpose. A cadet in proxy mode has no Drive access, so every
 * screen would otherwise be a separate round trip to Apps Script — which is
 * slow on a good connection and painful on a phone with two bars.
 *
 * @returns {Promise<{account: object, requests: object[], forms: object, submitted: string[]}>}
 */
export async function fetchBundle(url, idToken, opts) {
  if (!idToken) throw new Error('Your sign-in has expired. Sign in again.');
  const result = await postJson(url, { action: 'bundle', idToken }, opts);
  if (!result || result.ok !== true) {
    throw new Error(result?.error || 'Could not load your feedback.');
  }
  return result.bundle;
}

/**
 * The cadre-side reads.
 *
 * Each is a named action the script decides the shape of. Nothing here sends a
 * path — the client asks for a kind of thing, and the proxy decides whether this
 * account may have it. That is what makes the role checks worth anything: a
 * generic "fetch this file" call would put the decision back in the browser,
 * which is exactly the arrangement being replaced.
 */
async function ask(url, idToken, payload, opts) {
  if (!idToken) throw new Error('Your sign-in has expired. Sign in again.');
  const result = await postJson(url, { ...payload, idToken }, opts);
  if (!result || result.ok !== true) {
    throw new Error(result?.error || 'The server refused that request.');
  }
  return result;
}

/** Forms and requests — what a panel lists on arrival. */
export async function fetchCatalog(url, idToken) {
  return (await ask(url, idToken, { action: 'catalog' })).catalog;
}

/** Responses and receipts for one request. */
export async function fetchResponses(url, idToken, requestId) {
  const result = await ask(url, idToken, { action: 'responses', requestId });
  return { responses: result.responses, receipts: result.receipts };
}

/**
 * Every response across every request, for cross-form analysis.
 *
 * The one call that can get large. Fine for a detachment with a term of
 * feedback; the first thing that will need paging if one runs for years.
 */
export async function fetchAllResponses(url, idToken) {
  return (await ask(url, idToken, { action: 'allResponses' })).responses;
}

export async function fetchRoster(url, idToken, opts) {
  return (await ask(url, idToken, { action: 'roster' }, opts)).users;
}

/**
 * The By-instructor view, already narrowed to this account's people tier.
 *
 * Deliberately not assembled from `fetchCatalog` and `fetchAllResponses` with a
 * filter over the top: that would put every instructor's records in every
 * instructor's browser and hide them behind a predicate. The server decides
 * what comes back — see `readPeople` in tools/proxy/Code.gs.
 */
export async function fetchPeople(url, idToken) {
  return (await ask(url, idToken, { action: 'people' })).people;
}

export async function fetchAudit(url, idToken, months = 6) {
  return (await ask(url, idToken, { action: 'audit', months })).entries;
}

/** Org record and headline counts, without shipping the records themselves. */
export async function fetchOverview(url, idToken) {
  const result = await ask(url, idToken, { action: 'overview' });
  return { org: result.org, stats: result.stats };
}

/* ---------------- cadre writes ---------------- */

export async function saveFormViaProxy(url, idToken, form) {
  return (await ask(url, idToken, { action: 'saveForm', form })).record;
}

export async function saveRequestViaProxy(url, idToken, request) {
  return (await ask(url, idToken, { action: 'saveRequest', request })).record;
}

export async function deleteFormViaProxy(url, idToken, formId) {
  await ask(url, idToken, { action: 'deleteForm', formId });
}

export async function deleteRequestViaProxy(url, idToken, requestId) {
  await ask(url, idToken, { action: 'deleteRequest', requestId });
}

/**
 * Deleting one response.
 *
 * A reason is required by the server, not merely requested by the UI — this is
 * the operation the audit trail exists for.
 */
export async function deleteResponseViaProxy(url, idToken, requestId, responseId, reason) {
  await ask(url, idToken, { action: 'deleteResponse', requestId, responseId, reason });
}

/* ---------------- the roster ---------------- */

export async function createAccountViaProxy(url, idToken, account) {
  return (await ask(url, idToken, { action: 'accountCreate', account })).account;
}

export async function updateAccountViaProxy(url, idToken, id, patch) {
  return (await ask(url, idToken, { action: 'accountUpdate', id, patch })).account;
}

export async function deleteAccountViaProxy(url, idToken, id) {
  await ask(url, idToken, { action: 'accountDelete', id });
}

export async function rolloverViaProxy(url, idToken, moves, deactivate) {
  return (await ask(url, idToken, { action: 'rollover', moves, deactivate })).users;
}

/**
 * Appends an audit entry.
 *
 * The actor is *not* sent: the server takes it from the verified token. A client
 * that could name its own actor could write someone else's name against its own
 * deletion, which would make the log worse than not having one.
 */
export async function recordAuditViaProxy(url, idToken, entry) {
  await ask(url, idToken, { action: 'recordAudit', entry });
}

/**
 * Submits one response through the proxy.
 *
 * Note what is *not* sent: no respondent, no username, no path. The script
 * decides whether the response is anonymous by reading the request, and builds
 * every path itself from ids it pattern-checks. A client that asked to be
 * attributed on an anonymous form would simply be ignored.
 *
 * @throws with a message written for the cadet reading it.
 */
export async function submitViaProxy(url, { idToken, requestId, formId, answers, schemaVersion }) {
  if (!idToken) {
    throw new Error('Your sign-in has expired. Sign in again and resubmit.');
  }

  const send = () => postJson(url, {
    action: 'submit',
    idToken,
    requestId,
    formId,
    answers,
    schemaVersion,
  });

  let result = await send();

  /**
   * The one refusal a submission may be retried on, and no other.
   *
   * Retrying a submission is normally wrong: an attempt that succeeded but
   * whose answer was lost comes back as "you have already submitted", which
   * tells a cadet their feedback failed when it is already filed. That is why
   * the retry in `data-source.js` is scoped to reads.
   *
   * This refusal is different in kind. The script fails to take its lock
   * *before* it writes anything, so there is provably nothing to duplicate —
   * pinned from the server side by "a submission refused for a busy lock writes
   * absolutely nothing" in `tests/proxy/load.test.mjs`, which is what licenses
   * this. Without it the cadet is simply told to try again, and forty-five
   * people retrying by hand at the end of a drill night is the same stampede
   * that caused the refusal, arriving a second time.
   *
   * Once, not until it works. Every attempt holds a simultaneous-execution slot
   * for as long as it waits for the lock, so a persistent retry would spend the
   * scarce thing to get the scarce thing. Jittered, because the whole flight
   * was refused at the same moment and would otherwise come back at the same
   * moment.
   */
  if (result && result.ok !== true && BUSY.test(result.error || '')) {
    await new Promise((resolve) => {
      setTimeout(resolve, BUSY_RETRY_MS + Math.random() * BUSY_RETRY_MS);
    });
    result = await send();
  }

  if (!result || result.ok !== true) {
    const err = new Error(result?.error || 'The submission was refused.');
    // Marked for what it is, even though nothing retries it again: a refusal
    // the detachment could fix by spreading submissions out reads very
    // differently from one the cadet has to act on.
    throw BUSY.test(result?.error || '') ? transient(err) : err;
  }
  return { id: result.responseId, submittedAt: result.submittedAt };
}
