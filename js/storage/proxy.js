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

/** Google's own redirect chain is slow on a bad campus connection. */
const TIMEOUT_MS = 30000;

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

async function postJson(url, payload, { timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      const err = new Error(`The submission service answered ${response.status}. `
        + 'Its deployment may need updating.');
      // 5xx is Apps Script having a bad moment, which a second attempt often
      // survives. 4xx is the deployment being wrong, which it never does.
      throw response.status >= 500 ? transient(err) : err;
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      // Apps Script serves a sign-in page when a deployment is set to anything
      // other than "anyone", which is the single most common misconfiguration.
      throw new Error('The submission service returned a sign-in page instead of an answer. '
        + 'Its deployment access is probably not set to "Anyone".');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw transient(new Error(
        'The submission service did not answer in time. Check your connection.'));
    }
    // fetch rejects with a TypeError when the request never reached anybody.
    if (err instanceof TypeError) throw transient(err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, error: 'Could not reach that address. Check the URL and the network.' };
  }

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

  if (body.service === 'top-feedback-proxy') {
    // The name it answered to before the rename. Recognised rather than
    // rejected so the message can say what to do instead of "not ours".
    return {
      ok: false,
      error: 'That deployment is running an older version of the script, from before the app '
        + 'was renamed. Open the Apps Script editor, paste in the current Code.gs, and deploy '
        + 'a new version. The URL does not change.',
    };
  }
  if (body.service !== 'nine31-proxy') {
    return { ok: false, error: 'That is a Google Apps Script, but not the 9ThirtyOne proxy.' };
  }
  if (!body.configured) {
    return {
      ok: false,
      error: 'The proxy is deployed but not configured. In the Apps Script editor open '
        + 'Project Settings → Script Properties and add FOLDER_ID and CLIENT_ID, then Save.',
    };
  }
  return { ok: true, version: body.version, configured: true };
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

  const result = await postJson(url, {
    action: 'submit',
    idToken,
    requestId,
    formId,
    answers,
    schemaVersion,
  });

  if (!result || result.ok !== true) {
    throw new Error(result?.error || 'The submission was refused.');
  }
  return { id: result.responseId, submittedAt: result.submittedAt };
}
