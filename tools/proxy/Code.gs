/**
 * 9ThirtyOne submission proxy.
 *
 * Runs as a Google Apps Script web app inside the detachment's own Google
 * account. Deployment instructions are in README.md next to this file.
 *
 * WHY THIS EXISTS
 *
 * Without it, a cadet's browser writes their response straight into the
 * detachment's Drive folder. Google requires Editor permission to write, and
 * Drive has no write-without-read, so every cadet who can submit can also open
 * the folder and read every response in it, alter them, or delete the audit log.
 * The app's anonymity design is real within its own screens and worth nothing
 * against a cadet who opens Drive directly.
 *
 * This script breaks that chain. The folder is shared with cadre only. A cadet's
 * device sends its answers here instead, along with the Google ID token proving
 * who they are. This script verifies that token *server-side*, checks the
 * roster, and writes the files using the owner's credentials. The cadet never
 * touches Drive and never needs access to it.
 *
 * WHAT GUARDS THIS ENDPOINT
 *
 * It is deployed as "anyone can access", because cadets are not members of any
 * Workspace domain. So the URL is public and the token check is the only thing
 * standing there. Everything it enforces:
 *
 *   - The ID token is verified against Google, not merely decoded. A token this
 *     script cannot verify is refused.
 *   - The token's audience must equal this detachment's own client ID, so a
 *     token minted for some other app is refused.
 *   - The email must be on the roster, active, and hold the student role.
 *   - **Paths are constructed here, never accepted from the caller.** The client
 *     sends a request id, which is pattern-checked; it cannot send a path.
 *   - One submission per cadet per form, enforced under a script lock, so two
 *     taps on a slow connection cannot both land.
 *
 * IT SERVES READS TOO, AND HAS TO
 *
 * A cadet with no Drive access cannot read `requests/` or `forms/` either, so a
 * write-only proxy would leave them staring at an empty app. The `bundle` action
 * returns exactly what one cadet's screens need — their assignments, the forms
 * to render them, and which they have already done. No responses, not even
 * their own.
 *
 * IT SERVES CADRE TOO, NOW
 *
 * An earlier version of this comment said cadre still reached Drive directly.
 * They no longer do. Role checks in a browser cannot lock anything when every
 * cadre member holds Drive access to the same folder, so the cadre and commander
 * spaces are only genuinely separate because this script decides who may open
 * which folder. `SPACE_ACCESS` is where that lives, and it is enforced by never
 * opening the folder rather than by filtering what was read out of it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not re-validate answers against the form definition. The client does
 * that, and duplicating the form engine here would mean maintaining it twice.
 * What this enforces is *who* may write and *how often* — the parts a client
 * cannot be trusted with.
 */

/** Bump when the contract with the app changes. Reported by doGet. */
var PROXY_VERSION = '1.1.0';

/** Refuse anything larger; a submission is a few KB at most. */
var MAX_BODY_BYTES = 96 * 1024;

/** Two, so a change of command overlaps rather than cutting over. */
var MAX_COMMANDERS = 2;

/**
 * Where a request and its responses live.
 *
 * A different folder, not a label on a record — that is what makes "locked"
 * mean locked. `shared` keeps the original paths so nothing already written has
 * to move.
 */
var SPACE_FOLDERS = {
  shared: { requests: ['requests'], responses: ['responses'], receipts: ['receipts'], forms: ['forms'] },
  cadre: { requests: ['cadre', 'requests'], responses: ['cadre', 'responses'], receipts: ['cadre', 'receipts'], forms: ['cadre', 'forms'] },
  commander: { requests: ['commander', 'requests'], responses: ['commander', 'responses'], receipts: ['commander', 'receipts'], forms: ['commander', 'forms'] }
};

/** Which spaces each role may reach. Students are handled separately. */
var SPACE_ACCESS = {
  instructor: ['shared'],
  admin: ['shared'],
  cadre: ['shared', 'cadre'],
  commander: ['shared', 'cadre', 'commander']
};

/**
 * Whose results an account may see in the By-instructor view.
 *
 * `SPACE_ACCESS` above decides which folders an account reads. This decides
 * which *subjects* within them, which is the oversight tier:
 *
 *   own          an instructor sees their own results
 *   instructors  cadre see the instructors they oversee, and themselves
 *   all          a commander sees everyone, cadre included
 *
 * **Held roles, never effective ones.** `effectiveRoles` below makes cadre imply
 * instructor, so running this on the effective set would drop every cadre member
 * into the instructor tier and hand them each other's results — the exact thing
 * the tier exists to prevent. Effective roles answer "may this account call this
 * action"; this answers "whose records come back".
 *
 * WHAT THIS ENFORCES, AND WHAT IT DOES NOT
 *
 * It stops this endpoint serving an instructor a By-instructor view of somebody
 * else. It does not make that data confidential: `allResponses` and `catalog`
 * are still open to `instructor` in ACTIONS above, so an instructor with this
 * URL can fetch every response in the shared space and group it themselves.
 * Narrowing those would also narrow Responses & analysis, which is a separate
 * decision nobody has taken. Do not let a document claim more than this does.
 *
 * **Mirrored in `js/people-scope.js`.** Apps Script cannot import it, the same
 * reason SPACE_ACCESS is declared twice. Change one, change the other.
 */
function peopleTierFor(account) {
  var held = (account && account.roles) || [];
  for (var i = 0; i < held.length; i++) {
    if (held[i] === 'commander') return 'all';
  }
  for (var j = 0; j < held.length; j++) {
    if (held[j] === 'cadre') return 'instructors';
  }
  return 'own';
}

/** An instructor and nothing above it. Admin does not disqualify. */
function isPlainInstructor(user) {
  var held = (user && user.roles) || [];
  var instructor = false;
  for (var i = 0; i < held.length; i++) {
    if (held[i] === 'cadre' || held[i] === 'commander') return false;
    if (held[i] === 'instructor') instructor = true;
  }
  return instructor;
}

/** The person a request reflects on: its subject, or whoever issued it. */
function subjectOfRequest(request) {
  return (request && (request.subject || request.createdBy)) || null;
}

/**
 * Whether one request is in an account's people scope.
 *
 * An instructor keeps what they *issued* as well as what is about them — they
 * built and sent the form, so withholding the answers reads as a fault rather
 * than a policy.
 */
function requestInPeopleScope(root, request, account, tier) {
  if (tier === 'all') return true;
  var me = String((account && account.username) || '').toLowerCase();
  if (tier === 'own') {
    return String(request.subject || '').toLowerCase() === me
      || String(request.createdBy || '').toLowerCase() === me;
  }
  var subject = subjectOfRequest(request);
  if (!subject) return false;
  subject = String(subject).toLowerCase();
  if (subject === me) return true;
  return isPlainInstructor(findByUsername(root, subject));
}

/** Every space this account may see, combined across the roles it holds. */
function spacesFor(account) {
  var roles = effectiveRoles(account);
  var seen = {};
  for (var i = 0; i < roles.length; i++) {
    var allowed = SPACE_ACCESS[roles[i]] || [];
    for (var j = 0; j < allowed.length; j++) seen[allowed[j]] = true;
  }
  return Object.keys(seen);
}

/** The folder path for one collection in one space, or null if the space is unknown. */
function spacePath(space, collection, requestId) {
  var entry = SPACE_FOLDERS[space];
  if (!entry) return null;
  var base = entry[collection];
  if (!base) return null;
  return requestId ? base.concat([requestId]) : base;
}

/**
 * The space a request belongs to.
 *
 * Read from the record rather than trusted from the caller: a client that could
 * name the space could file a commander's request into the shared folder, or
 * read one out of it.
 */
function spaceOf(request) {
  var space = String((request && request.space) || 'shared');
  return SPACE_FOLDERS[space] ? space : 'shared';
}

/** UTF-8 byte length of a string, without allocating a copy of it. */
function byteLength(text) {
  var bytes = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF) { bytes += 4; i++; }   // surrogate pair
    else bytes += 3;
  }
  return bytes;
}

/** Ids come from the client, so they are pattern-checked before use in a path. */
var ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Every action this script will perform, and who may perform it.
 *
 * An action not listed here does not exist. That is the whole access model:
 * there is no generic "read a path" call to be talked into handing over the
 * wrong file, because the caller never names a path — it names an intention,
 * and this table decides whether it may.
 *
 * `commander` and `cadre` are accepted already so that rosters written by a
 * newer app do not fail against a proxy deployed slightly earlier.
 */
var ACTIONS = {
  bundle:       ['student'],
  submit:       ['student'],
  catalog:      ['instructor', 'cadre', 'commander', 'admin'],
  responses:    ['instructor', 'cadre', 'commander', 'admin'],
  allResponses: ['instructor', 'cadre', 'commander', 'admin'],
  roster:       ['instructor', 'cadre', 'commander', 'admin'],
  audit:        ['commander', 'admin'],
  overview:     ['instructor', 'cadre', 'commander', 'admin'],
  // Open to every panel role, but what comes back is narrowed by
  // peopleTierFor: an instructor gets their own, cadre get the instructors they
  // oversee, a commander gets everyone. The narrowing is the point of the
  // action — see peopleTierFor for what it does and does not guarantee.
  people:       ['instructor', 'cadre', 'commander', 'admin'],

  saveForm:       ['instructor', 'cadre', 'commander', 'admin'],
  saveRequest:    ['instructor', 'cadre', 'commander', 'admin'],
  deleteForm:     ['instructor', 'cadre', 'commander', 'admin'],
  deleteRequest:  ['instructor', 'cadre', 'commander', 'admin'],
  // Deleting a response is admin-only here, and always needs a reason. The app
  // alone let an instructor remove an unflagged one, but the server cannot tell
  // flagged from unflagged without carrying the safety lexicon — and the audit
  // trail exists precisely so someone who is the subject of a complaint cannot
  // quietly remove it. Requiring an administrator is the honest way to keep that
  // true without duplicating the lexicon.
  deleteResponse: ['admin', 'commander'],
  accountCreate:  ['admin'],
  accountUpdate:  ['admin'],
  accountDelete:  ['admin'],
  rollover:       ['admin'],
  recordAudit:    ['instructor', 'cadre', 'commander', 'admin']
};

/**
 * Roles that carry another's access.
 *
 * Cadre is a superset of instructor, commander of cadre. Listed here as well as
 * in the app because the action table names concrete roles, and a cadre-only
 * account must satisfy an instructor-level action without being listed twice on
 * the roster.
 */
var ROLE_IMPLIES = {
  cadre: ['instructor'],
  commander: ['cadre', 'instructor']
};

function effectiveRoles(account) {
  var held = account.roles || [];
  var out = {};
  for (var i = 0; i < held.length; i++) {
    out[held[i]] = true;
    var implied = ROLE_IMPLIES[held[i]] || [];
    for (var j = 0; j < implied.length; j++) out[implied[j]] = true;
  }
  return Object.keys(out);
}

function hasAnyRole(account, allowed) {
  var held = effectiveRoles(account);
  for (var i = 0; i < allowed.length; i++) {
    if (held.indexOf(allowed[i]) !== -1) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * configuration
 * ------------------------------------------------------------------ */

/**
 * Read from Script Properties rather than hard-coded, so the same script can be
 * pasted into any detachment's account without editing code.
 */
function config() {
  var props = PropertiesService.getScriptProperties();
  return {
    folderId: props.getProperty('FOLDER_ID'),
    clientId: props.getProperty('CLIENT_ID'),
  };
}

/* ------------------------------------------------------------------ *
 * entry points
 * ------------------------------------------------------------------ */

/**
 * Health check. Deliberately says nothing about the folder or the roster —
 * only whether this deployment is alive and configured, which is what an
 * administrator needs to confirm they pasted the right URL.
 */
function doGet() {
  var cfg = config();
  return json({
    ok: true,
    service: 'nine31-proxy',
    version: PROXY_VERSION,
    configured: Boolean(cfg.folderId && cfg.clientId),
  });
}

/**
 * A cadet submitting one response.
 *
 * The app posts with Content-Type text/plain on purpose. That makes this a CORS
 * "simple request", which skips the preflight — and Apps Script cannot answer a
 * preflight, so an application/json post from a browser fails before it arrives.
 * The body is still JSON; only the header is lying, and it is lying to get past
 * a limitation on Google's side rather than ours.
 */
function doPost(e) {
  try {
    var cfg = config();
    if (!cfg.folderId || !cfg.clientId) {
      return fail('This proxy has not been configured. Set FOLDER_ID and CLIENT_ID in Script Properties.');
    }

    if (!e || !e.postData || !e.postData.contents) return fail('Empty request.');
    // Measured in bytes, not characters. `.length` counts UTF-16 units, so a
    // body of accented or non-Latin text could be several times the intended
    // ceiling and still pass — and free-text feedback is exactly where that
    // shows up.
    if (byteLength(e.postData.contents) > MAX_BODY_BYTES) {
      return fail('That submission is too large.');
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return fail('That request was not valid JSON.');
    }

    var required = ACTIONS[body.action];
    if (!required) return fail('Unknown action.');

    // --- 1. who is this, according to Google ---------------------------
    var identity = verifyIdToken(body.idToken, cfg.clientId);
    if (!identity.ok) return fail(identity.error);

    // --- 2. are they allowed, according to the roster ------------------
    var root = DriveApp.getFolderById(cfg.folderId);
    var account = findAccount(root, identity.email);
    if (!account) {
      return fail(identity.email + ' is not on this detachment\'s roster.');
    }
    if (account.active === false) {
      return fail('That account has been deactivated.');
    }
    if (!hasAnyRole(account, required)) {
      return fail('That account is not allowed to do this.');
    }

    // --- 3. read actions ------------------------------------------------
    // A cadet with no Drive access cannot read the folder to find out what was
    // assigned to them, and once cadre lose Drive access the same is true of
    // them. Every read is a named action with its own role requirement: the
    // caller can never name a path, so it can never reach a file this script
    // did not decide to hand over.
    if (body.action === 'bundle') {
      return json({ ok: true, bundle: buildBundle(root, account) });
    }
    if (body.action === 'catalog') {
      return json({ ok: true, catalog: readCatalog(root, account) });
    }
    if (body.action === 'responses') {
      var forId = String(body.requestId || '');
      if (!ID_PATTERN.test(forId)) return fail('That feedback request id is not valid.');
      var found = readResponses(root, account, forId);
      if (!found) return fail('That feedback is not available to this account.');
      return json({ ok: true, responses: found.responses, receipts: found.receipts });
    }
    if (body.action === 'allResponses') {
      return json({ ok: true, responses: readAllResponses(root, account) });
    }
    if (body.action === 'people') {
      return json({ ok: true, people: readPeople(root, account) });
    }
    if (body.action === 'roster') {
      return json({ ok: true, users: readRoster(root) });
    }
    if (body.action === 'audit') {
      return json({ ok: true, entries: readAudit(root, Number(body.months) || 6) });
    }
    if (body.action === 'overview') {
      return json({ ok: true, org: readJson(root, ['config'], 'org.json'), stats: readStats(root) });
    }

    // --- 4. cadre writes -------------------------------------------------
    // Each takes a record, never a path. Anything that touches a shared
    // document runs under the script lock, which is a stronger guarantee than
    // the client-side compare-and-retry it replaces: two administrators editing
    // the roster at once are serialised here rather than racing and retrying.
    if (body.action === 'saveForm') return saveFormInSpace(root, account, body.form);
    if (body.action === 'saveRequest') return saveRequestInSpace(root, account, body.request);
    if (body.action === 'deleteForm') return removeForm(root, account, body.formId);
    if (body.action === 'deleteRequest') return removeRequest(root, account, body.requestId);
    if (body.action === 'deleteResponse') return removeResponse(root, body, account);
    if (body.action === 'accountCreate') return withRoster(function (users) {
      return addAccount(users, body.account);
    }, account, describeAccountChange);
    if (body.action === 'accountUpdate') return withRoster(function (users) {
      return patchAccount(users, body.id, body.patch);
    }, account, describeAccountChange);
    if (body.action === 'accountDelete') return removeAccount(root, account, body.id);
    if (body.action === 'rollover') return withRoster(function (users) {
      return applyRollover(users, body.moves, body.deactivate);
    }, account, function (before, result) {
      return {
        action: 'roster.rollover',
        summary: 'Advanced the year for ' + result.users.length + ' accounts',
        detail: { moves: body.moves || null, deactivate: body.deactivate !== false },
        severe: true
      };
    });
    if (body.action === 'recordAudit') return appendAudit(root, body.entry, account);

    // --- 5. the one student write ---------------------------------------
    // Explicit rather than a fall-through: an action added to ACTIONS and not
    // handled above would otherwise drop quietly into the submit path.
    if (body.action !== 'submit') return fail('That action is not implemented.');

    var requestId = String(body.requestId || '');
    if (!ID_PATTERN.test(requestId)) return fail('That feedback request id is not valid.');

    var located = locateRequest(root, requestId);
    if (!located) return fail('That feedback request no longer exists.');
    var request = located.request;
    if (request.status && request.status !== 'open') {
      return fail('That feedback is closed.');
    }
    if (!isAddressedTo(request, account)) {
      return fail('That feedback was not assigned to you.');
    }

    // --- 4. write, once -------------------------------------------------
    // The lock is what makes "one submission per cadet" a rule rather than a
    // convention: without it two taps on a slow connection can both pass the
    // receipt check before either writes one.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(20000);
    } catch (err) {
      return fail('The server is busy. Try again in a moment.');
    }

    try {
      if (hasReceipt(root, located.space, requestId, account.username)) {
        return fail('You have already submitted this feedback.');
      }

      // The response is filed in the request's own space, so answering a
      // commander's request puts the answer where only a commander can read it.
      var record = buildResponse(body, request, account);
      record.space = located.space;
      writeJson(root, spacePath(located.space, 'responses', requestId), record.id + '.json', record);
      writeJson(root, spacePath(located.space, 'receipts', requestId), account.username + '.json', {
        schemaVersion: record.schemaVersion,
        requestId: requestId,
        username: account.username,
        submittedAt: record.submittedAt,
        viaProxy: true
      });

      return json({ ok: true, responseId: record.id, submittedAt: record.submittedAt });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    // Never leak a stack trace to a public endpoint.
    console.error(err);
    return fail('The submission could not be saved. Tell your cadre if this keeps happening.');
  }
}

/* ------------------------------------------------------------------ *
 * identity
 * ------------------------------------------------------------------ */

/**
 * Verifies a Google ID token by asking Google.
 *
 * Deliberately not a local signature check. Google publishes rotating keys, and
 * a wrong or stale key cache here would either reject everyone or, far worse,
 * accept something it should not. The round trip costs a few hundred
 * milliseconds on a path that runs once per cadet per form.
 */
function verifyIdToken(token, expectedClientId) {
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'No sign-in was included with that submission.' };
  }

  // --- 1. cheap local checks, before spending a network call -------------
  //
  // This endpoint is public and its URL travels in join links and QR codes, so
  // anyone can post to it. Every post used to cost one UrlFetch to Google
  // regardless of how obviously junk the token was, and Apps Script allows a
  // fixed number of those per day — so a stranger could exhaust a detachment's
  // quota and take the app down for everyone until midnight.
  //
  // These checks cost nothing and reject anything that could never verify. They
  // are **not** a security boundary: the payload is decoded here without
  // checking the signature, so a forged token passes this and is caught by the
  // real check below. Everything asserted here is asserted again against
  // Google's answer, which is the one that counts.
  var local = readClaimsWithoutVerifying(token);
  if (!local) return { ok: false, error: 'Your sign-in could not be read.' };
  if (ISSUERS.indexOf(String(local.iss)) === -1) {
    return { ok: false, error: 'That sign-in was not issued by Google.' };
  }
  if (local.aud !== expectedClientId) {
    return { ok: false, error: 'That sign-in was for a different application.' };
  }
  if (Number(local.exp) * 1000 < Date.now()) {
    return { ok: false, error: 'Your sign-in has expired. Sign in again and resubmit.' };
  }

  // --- 2. already verified this exact token recently? ---------------------
  // A cadet opening the app makes several calls in a row with one token. The
  // key is a digest of the whole token, so a hit cannot be forged without
  // holding the token itself.
  var cache = tokenCache();
  var key = tokenCacheKey(token);
  if (cache) {
    var hit = cache.get(key);
    if (hit) {
      try {
        var cached = JSON.parse(hit);
        return { ok: true, email: cached.email, sub: cached.sub };
      } catch (err) { /* unreadable cache entry; verify properly */ }
    }
  }

  // --- 3. the check that actually decides --------------------------------
  var response;
  try {
    response = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
  } catch (err) {
    return { ok: false, error: 'Could not reach Google to check your sign-in.' };
  }

  if (response.getResponseCode() !== 200) {
    return { ok: false, error: 'Your sign-in could not be verified. Sign in again.' };
  }

  var claims;
  try {
    claims = JSON.parse(response.getContentText());
  } catch (err) {
    return { ok: false, error: 'Your sign-in could not be read.' };
  }

  // Re-checked against Google's answer rather than the local decode above.
  // tokeninfo returns every value as a string, including exp and
  // email_verified — comparing them as booleans or numbers silently passes.
  if (claims.aud !== expectedClientId) {
    return { ok: false, error: 'That sign-in was for a different application.' };
  }
  if (Number(claims.exp) * 1000 < Date.now()) {
    return { ok: false, error: 'Your sign-in has expired. Sign in again and resubmit.' };
  }
  if (String(claims.email_verified) !== 'true') {
    return { ok: false, error: 'That Google account has not verified its email address.' };
  }
  if (!claims.email) {
    return { ok: false, error: 'That Google account did not provide an email address.' };
  }

  var verified = {
    email: String(claims.email).trim().toLowerCase(),
    sub: claims.sub
  };

  if (cache) {
    // Never cache past the token's own expiry, and never longer than Apps
    // Script allows.
    var seconds = Math.floor((Number(claims.exp) * 1000 - Date.now()) / 1000);
    var ttl = Math.max(0, Math.min(seconds, 21600));
    if (ttl > 30) {
      try { cache.put(key, JSON.stringify(verified), ttl); } catch (err) { /* cache full */ }
    }
  }

  return { ok: true, email: verified.email, sub: verified.sub };
}

/** Issuers Google mints ID tokens under. */
var ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Decodes a JWT payload **without verifying the signature**.
 *
 * Only ever used to decide whether a token is worth spending a network call on.
 * Nothing it returns is trusted.
 */
function readClaimsWithoutVerifying(token) {
  var parts = String(token).split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    var bytes = Utilities.base64DecodeWebSafe(parts[1]);
    return JSON.parse(Utilities.newBlob(bytes).getDataAsString('UTF-8'));
  } catch (err) {
    return null;
  }
}

/** The script cache, or null where it is unavailable. */
function tokenCache() {
  try {
    return CacheService.getScriptCache();
  } catch (err) {
    return null;
  }
}

/** A digest of the whole token, so a cache hit needs the token itself. */
function tokenCacheKey(token) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return 'idt_' + hex;
}

/* ------------------------------------------------------------------ *
 * the cadet's view
 * ------------------------------------------------------------------ */

/**
 * Everything one cadet is allowed to see, and nothing else.
 *
 * Note what is absent: no responses, not even their own. A submitted response
 * is not shown back to anyone, and on an anonymous form there is deliberately
 * nothing linking it to them to show. What comes back is the assignment list,
 * the forms needed to render them, and which ones they have already done.
 */
function buildBundle(root, account) {
  var requests = [];
  var formIds = {};

  // Every space, deliberately. A cadet answers a commander's feedback request
  // like any other — the point of the locked space is that they never see
  // anyone's *responses*, not that they are excluded from being asked.
  var spaces = Object.keys(SPACE_FOLDERS);
  for (var s = 0; s < spaces.length; s++) {
    var rows = readFolderDocs(root, spacePath(spaces[s], 'requests'));
    for (var r = 0; r < rows.length; r++) {
      var request = rows[r];
      if (!request || !request.id) continue;
      if (!isAddressedTo(request, account)) continue;
      request.space = spaces[s];
      requests.push(request);
      if (request.formId) formIds[request.formId] = true;
    }
  }

  // A cadet is answering requests from several spaces at once, so each form is
  // fetched from wherever its own request lives rather than from one folder.
  var forms = {};
  var wanted = Object.keys(formIds);
  for (var i = 0; i < wanted.length; i++) {
    if (!ID_PATTERN.test(wanted[i])) continue;
    var located = locateForm(root, wanted[i]);
    if (located) forms[wanted[i]] = located.form;
  }

  var submitted = [];
  for (var j = 0; j < requests.length; j++) {
    if (hasReceipt(root, requests[j].space, requests[j].id, account.username)) {
      submitted.push(requests[j].id);
    }
  }

  return {
    account: {
      username: account.username,
      name: account.name,
      email: account.email,
      asClass: account.asClass || '',
      section: account.section || '',
      roles: account.roles || []
    },
    requests: requests,
    forms: forms,
    submitted: submitted
  };
}

/* ------------------------------------------------------------------ *
 * cadre writes
 *
 * The client sends a record, never a path. Ids are generated here when absent
 * and pattern-checked when supplied, so nothing a caller sends can escape the
 * folder it belongs in.
 * ------------------------------------------------------------------ */

/** Writes one record into an explicit folder path. */
function writeRecordAt(root, segments, record, prefix) {
  if (!record || typeof record !== 'object') return fail('That record is missing.');

  var id = String(record.id || '');
  if (!id) {
    id = prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    record.id = id;
  }
  if (!ID_PATTERN.test(id)) return fail('That record has an invalid id.');

  if (!record.createdAt) record.createdAt = new Date().toISOString();
  record.updatedAt = new Date().toISOString();

  writeJson(root, segments, id + '.json', record);
  return json({ ok: true, record: record });
}

/** Writes one record into a collection, minting an id if it has none. */
function writeRecord(root, collection, record, prefix) {
  if (!record || typeof record !== 'object') return fail('That record is missing.');

  var id = String(record.id || '');
  if (!id) {
    id = prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    record.id = id;
  }
  if (!ID_PATTERN.test(id)) return fail('That record has an invalid id.');

  if (!record.createdAt) record.createdAt = new Date().toISOString();
  record.updatedAt = new Date().toISOString();

  writeJson(root, [collection], id + '.json', record);
  return json({ ok: true, record: record });
}

function removeRecord(root, segments, id) {
  if (!ID_PATTERN.test(String(id || ''))) return fail('That id is not valid.');
  var folder = findFolder(root, segments);
  if (folder) {
    var files = folder.getFilesByName(id + '.json');
    while (files.hasNext()) files.next().setTrashed(true);
  }
  return json({ ok: true });
}

/**
 * Files a form into a space this account is allowed to write to.
 *
 * Same rule as a request, for the same reason: the caller names the space, the
 * server decides whether they may have it. A form cannot change space once it
 * exists, because the requests pointing at it would then be reading their
 * questions out of a folder their own readers cannot reach.
 */
function saveFormInSpace(root, account, form) {
  if (!form || typeof form !== 'object') return fail('That form is missing.');

  var space = spaceOf(form);
  if (!mayReach(account, space)) {
    return fail('This account cannot save a form in that space.');
  }

  var existing = form.id ? locateForm(root, String(form.id)) : null;
  if (existing && existing.space !== space) {
    return fail('A form cannot be moved between spaces once it exists.');
  }
  if (existing && !mayReach(account, existing.space)) {
    return fail('That form is not available to this account.');
  }

  form.space = space;
  return writeRecordAt(root, spacePath(space, 'forms'), form, 'form_');
}

/** Deletes a form, if this account may reach the space it lives in. */
function removeForm(root, account, formId) {
  if (!ID_PATTERN.test(String(formId || ''))) return fail('That id is not valid.');
  var located = locateForm(root, formId);
  if (!located) return json({ ok: true });
  if (!mayReach(account, located.space)) {
    return fail('That form is not available to this account.');
  }
  return removeRecord(root, spacePath(located.space, 'forms'), formId);
}

/**
 * Files a request into a space this account is allowed to write to.
 *
 * The space is taken from the record but validated against the caller's roles,
 * so an instructor cannot file into the commander's space and a cadre member
 * cannot quietly move an existing request out of one.
 */
function saveRequestInSpace(root, account, request) {
  if (!request || typeof request !== 'object') return fail('That request is missing.');

  var space = spaceOf(request);
  if (!mayReach(account, space)) {
    return fail('This account cannot file feedback into that space.');
  }

  // Moving a request between spaces would carry its responses somewhere they
  // were never meant to be readable, so it is refused rather than handled.
  var existing = request.id ? locateRequest(root, String(request.id)) : null;
  if (existing && existing.space !== space) {
    return fail('Feedback cannot be moved between spaces once it exists.');
  }
  if (existing && !mayReach(account, existing.space)) {
    return fail('That feedback is not available to this account.');
  }

  // Who issued it comes from the verified token, never from the body — the same
  // rule as the audit actor. A client that could name its own creator could file
  // feedback under another instructor's name, and this record is used to review
  // that instructor.
  request.createdBy = existing ? existing.request.createdBy || account.username : account.username;

  // Who it is *about* is a deliberate choice, so it is taken from the caller —
  // but it must name somebody real, or a commander reviewing by person would
  // find feedback filed against nobody.
  var subject = String(request.subject || '').trim().toLowerCase();
  if (subject) {
    if (!findByUsername(root, subject)) {
      return fail('That feedback names somebody who is not on the roster.');
    }
    request.subject = subject;
  } else {
    request.subject = request.createdBy;
  }

  request.space = space;
  return writeRecordAt(root, spacePath(space, 'requests'), request, 'req_');
}

/** Removing a request takes its responses and receipts with it. */
function removeRequest(root, account, requestId) {
  if (!ID_PATTERN.test(String(requestId || ''))) return fail('That id is not valid.');
  var located = locateRequest(root, requestId);
  if (!located) return json({ ok: true });
  if (!mayReach(account, located.space)) {
    return fail('That feedback is not available to this account.');
  }
  trashFolder(findFolder(root, spacePath(located.space, 'responses', requestId)));
  trashFolder(findFolder(root, spacePath(located.space, 'receipts', requestId)));
  return removeRecord(root, spacePath(located.space, 'requests'), requestId);
}

function trashFolder(folder) {
  if (folder) folder.setTrashed(true);
}

/**
 * Deletes one response, always with a reason, always recorded.
 *
 * The reason is required rather than optional because this is the operation the
 * audit trail exists for: someone who is the subject of a complaint should not
 * be able to make it disappear without leaving an account of why.
 */
function removeResponse(root, body, account) {
  var requestId = String(body.requestId || '');
  var responseId = String(body.responseId || '');
  var reason = String(body.reason || '').trim();

  if (!ID_PATTERN.test(requestId) || !ID_PATTERN.test(responseId)) {
    return fail('That id is not valid.');
  }
  if (reason.length < 4) return fail('Deleting feedback requires a recorded reason.');

  var located = locateRequest(root, requestId);
  if (!located) return fail('That feedback no longer exists.');
  if (!mayReach(account, located.space)) {
    return fail('That feedback is not available to this account.');
  }

  var result = removeRecord(root, spacePath(located.space, 'responses', requestId), responseId);
  appendAudit(root, {
    action: 'response.deleted',
    summary: 'Deleted a response from ' + requestId,
    target: responseId,
    reason: reason,
    severe: true
  }, account);
  return result;
}

/* ------------------------------------------------------------------ *
 * the roster
 *
 * Every change runs the whole read-modify-write under the script lock. That is
 * stronger than the compare-and-retry it replaces on the client: two
 * administrators editing at once are serialised rather than racing.
 * ------------------------------------------------------------------ */

/**
 * Runs a roster change under the lock, and records it.
 *
 * @param {function} mutate   users -> { users, account } or { error }
 * @param {object} actor      the verified account making the change
 * @param {function} describe (before, result) -> audit entry, or null for none
 *
 * The audit entry is written **here**, server-side, from the token's identity.
 * It used to be written only by the client calling `recordAudit` afterwards,
 * which meant the one operation worth logging above all others — granting
 * somebody the commander role — left no trace at all if the caller simply did
 * not make that second call. The proxy exists because the client is the thing
 * being guarded against, so a log the client can decline to write is not a log.
 */
function withRoster(mutate, actor, describe) {
  var cfg = config();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return fail('The roster is busy. Try again in a moment.');
  }

  try {
    var root = DriveApp.getFolderById(cfg.folderId);
    var users = readRoster(root);
    var before = JSON.parse(JSON.stringify(users));
    var result = mutate(users);
    if (result && result.error) return fail(result.error);

    writeJson(root, ['users'], 'users.json', {
      schemaVersion: 4,
      users: result.users,
      updatedAt: new Date().toISOString()
    });

    if (actor && describe) {
      var entry = describe(before, result);
      if (entry) appendAudit(root, entry, actor);
    }
    return json({ ok: true, users: result.users, account: result.account || null });
  } finally {
    lock.releaseLock();
  }
}

/** The roles an account holds, as a stable sorted string, for comparison. */
function rolesOf(account) {
  return ((account && account.roles) || []).slice().sort().join(',');
}

/**
 * Describes a roster edit for the log, naming a role change explicitly.
 *
 * A change of roles is marked severe because it is the one edit that changes
 * what somebody can *read* — including, at the top of the range, every
 * restricted space in the detachment.
 */
function describeAccountChange(before, result) {
  var account = result.account;
  if (!account) return null;

  var previous = null;
  for (var i = 0; i < before.length; i++) {
    if (before[i].id === account.id) previous = before[i];
  }

  var who = account.email || account.username || account.id;
  if (!previous) {
    return {
      action: 'account.created',
      summary: 'Added ' + who + ' as ' + (rolesOf(account) || 'no role'),
      target: who,
      detail: { roles: account.roles || [] },
      severe: false
    };
  }

  var wasRoles = rolesOf(previous);
  var nowRoles = rolesOf(account);
  if (wasRoles !== nowRoles) {
    return {
      action: 'account.roles.changed',
      summary: 'Changed ' + who + ' from [' + (wasRoles || 'none') + '] to ['
        + (nowRoles || 'none') + ']',
      target: who,
      detail: { from: previous.roles || [], to: account.roles || [] },
      severe: true
    };
  }

  return {
    action: 'account.updated',
    summary: 'Updated ' + who,
    target: who,
    detail: null,
    severe: false
  };
}

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function addAccount(users, account) {
  if (!account || !normaliseEmail(account.email)) return { error: 'That account has no email address.' };
  var email = normaliseEmail(account.email);
  for (var i = 0; i < users.length; i++) {
    if (normaliseEmail(users[i].email) === email) {
      return { error: email + ' is already on the roster.' };
    }
  }
  account.email = email;
  account.createdAt = account.createdAt || new Date().toISOString();
  account.updatedAt = new Date().toISOString();

  var capped = enforceCommanderCap(users.concat([account]));
  if (capped.error) return capped;
  return { users: capped.users, account: account };
}

/**
 * Fields a roster edit is allowed to touch.
 *
 * The client sends the whole merged account rather than a diff, so this is a
 * filter rather than a schema. What it keeps out matters more than what it lets
 * through: `id` is the record's identity, `createdAt` is history, and anything
 * unrecognised is somebody putting fields into the roster that nothing reads.
 *
 * `username` is absent deliberately — see below.
 */
var PATCHABLE = ['name', 'email', 'roles', 'active', 'asClass', 'section'];

function patchAccount(users, id, patch) {
  if (!patch || typeof patch !== 'object') return { error: 'That change is missing.' };

  // Receipts are filed as `receipts/<requestId>/<username>.json`, and the
  // anonymisation that runs when somebody is removed finds their records the
  // same way. Renaming a username would orphan every receipt they hold: their
  // submissions would stop counting, they could answer the same feedback twice,
  // and a later deletion would leave their records behind. The app never asks
  // for it, so it is refused here rather than half-supported.
  var target = null;
  for (var t = 0; t < users.length; t++) if (users[t].id === id) target = users[t];
  if (!target) return { error: 'That account no longer exists.' };
  if (patch.username !== undefined
      && String(patch.username).toLowerCase() !== String(target.username || '').toLowerCase()) {
    return {
      error: 'A username cannot be changed once feedback has been filed under it. '
        + 'Remove the account and add it again if it really has to change.'
    };
  }

  var found = null;
  var next = users.map(function (user) {
    if (user.id !== id) return user;
    found = {};
    for (var key in user) found[key] = user[key];
    for (var f = 0; f < PATCHABLE.length; f++) {
      var field = PATCHABLE[f];
      if (patch[field] !== undefined) found[field] = patch[field];
    }
    if (patch.email) found.email = normaliseEmail(patch.email);
    found.updatedAt = new Date().toISOString();
    return found;
  });
  if (!found) return { error: 'That account no longer exists.' };

  var email = normaliseEmail(found.email);
  for (var i = 0; i < next.length; i++) {
    if (next[i].id !== id && normaliseEmail(next[i].email) === email) {
      return { error: 'That email is already on the roster.' };
    }
  }
  var capped = enforceCommanderCap(next);
  if (capped.error) return capped;
  var floored = enforceAdminFloor(capped.users);
  if (floored.error) return floored;
  return { users: floored.users, account: found };
}

/**
 * At most two commanders, ever.
 *
 * Two rather than one so a change of command overlaps: the outgoing and
 * incoming commander both hold it during the handover. Enforced here rather
 * than in the app because the app is the thing being guarded against — and
 * because the roster is the only place the count can be known for certain.
 */
function enforceCommanderCap(users) {
  var commanders = users.filter(function (user) {
    return user.active !== false && (user.roles || []).indexOf('commander') !== -1;
  });
  if (commanders.length > MAX_COMMANDERS) {
    return {
      error: 'Only ' + MAX_COMMANDERS + ' commanders are allowed at once. Remove the '
        + 'designation from someone before granting it, so a handover overlaps rather '
        + 'than a third person appearing.'
    };
  }
  return { users: users };
}

/**
 * A detachment always has at least one administrator.
 *
 * Here for the same reason as the cap above: the app is the thing being guarded
 * against. The console already refuses to delete or demote the last admin, and
 * that refusal is worth exactly as much as the client honouring it — which is
 * nothing, for a public endpoint anybody can post to.
 *
 * The consequence of losing the last one is not theoretical. An empty roster is
 * claimed by the first account to sign in, but a roster with people and no
 * administrator is claimed by nobody: Database Administration becomes
 * unreachable, and the only way back is editing users.json by hand in Drive,
 * which only the folder's owner can do.
 */
function enforceAdminFloor(users) {
  var admins = users.filter(function (user) {
    return user.active !== false && (user.roles || []).indexOf('admin') !== -1;
  });
  if (!admins.length) {
    return {
      error: 'That would leave the detachment with no administrator, and nobody '
        + 'could add one back. Give another account the administrator role first.'
    };
  }
  return { users: users };
}

function dropAccount(users, id) {
  return {
    users: users.filter(function (user) { return user.id !== id; })
  };
}

/**
 * Removes someone from the roster and permanently anonymises what they left.
 *
 * Deleting the roster entry alone would leave their name on every attributed
 * response and their username on every receipt — so "delete this person" would
 * mean "stop them signing in" and nothing more. Worse, a backup export would
 * still carry all of it out of the folder on somebody's laptop.
 *
 * So the records stay and the person is removed *from* them. Responses lose
 * their respondent and become genuinely anonymous. Receipts keep their existence
 * — completion counts must still add up — but are renamed away from the
 * username and emptied of it.
 *
 * This is irreversible on purpose. That is what makes it worth anything.
 */
function removeAccount(root, actor, id) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return fail('The roster is busy. Try again in a moment.');
  }

  try {
    var users = readRoster(root);
    var target = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].id === id) target = users[i];
    }
    if (!target) return fail('That account no longer exists.');

    // Checked before the sweep, not after: anonymiseEverywhere rewrites the
    // folder, and there is no undo for it. A deletion that must be refused has
    // to be refused while the records are still intact.
    var remaining = users.filter(function (user) { return user.id !== id; });
    var floored = enforceAdminFloor(remaining);
    if (floored.error) return fail(floored.error);

    var scrubbed = anonymiseEverywhere(root, target.username);

    writeJson(root, ['users'], 'users.json', {
      schemaVersion: 4,
      users: remaining,
      updatedAt: new Date().toISOString()
    });

    appendAudit(root, {
      action: 'account.deleted',
      summary: 'Removed ' + (target.email || target.username)
        + ' and permanently anonymised their records',
      target: target.email || target.username,
      detail: {
        responsesAnonymised: scrubbed.responses,
        receiptsAnonymised: scrubbed.receipts
      },
      severe: true
    }, actor);

    return json({ ok: true, anonymised: scrubbed });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Strips one username out of every response and receipt, in every space.
 *
 * Walks all spaces rather than only the ones the caller can read: a person's
 * records must not survive in a space the administrator happens not to have
 * access to.
 */
function anonymiseEverywhere(root, username) {
  var spaces = Object.keys(SPACE_FOLDERS);
  var counts = { responses: 0, receipts: 0 };
  var at = new Date().toISOString();

  for (var s = 0; s < spaces.length; s++) {
    // --- responses: drop the respondent, and say so ---
    var responsesRoot = findFolder(root, spacePath(spaces[s], 'responses'));
    if (responsesRoot) {
      var requestFolders = responsesRoot.getFolders();
      while (requestFolders.hasNext()) {
        var folder = requestFolders.next();
        var files = folder.getFiles();
        while (files.hasNext()) {
          var file = files.next();
          var record;
          try {
            record = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
          } catch (err) {
            continue;
          }
          if (!record.respondent || record.respondent.username !== username) continue;

          record.respondent = null;
          // It really is anonymous now, and the analysis screens must treat it
          // that way — including withholding it below the disclosure threshold.
          record.anonymous = true;
          record.anonymisedAt = at;
          file.setContent(JSON.stringify(record, null, 2));
          counts.responses++;
        }
      }
    }

    // --- receipts: keep the count, lose the name ---
    var receiptsRoot = findFolder(root, spacePath(spaces[s], 'receipts'));
    if (receiptsRoot) {
      var receiptFolders = receiptsRoot.getFolders();
      while (receiptFolders.hasNext()) {
        var rFolder = receiptFolders.next();
        var existing = rFolder.getFilesByName(username + '.json');
        while (existing.hasNext()) {
          var receipt = existing.next();
          var parsed;
          try {
            parsed = JSON.parse(receipt.getBlob().getDataAsString('UTF-8'));
          } catch (err) {
            parsed = {};
          }
          // A new file under a name that identifies nobody; the old one goes.
          var replacement = 'removed-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12) + '.json';
          rFolder.createFile(Utilities.newBlob(JSON.stringify({
            schemaVersion: parsed.schemaVersion || 4,
            requestId: parsed.requestId || null,
            username: null,
            removed: true,
            submittedAt: parsed.submittedAt || null,
            anonymisedAt: at
          }, null, 2), 'application/json', replacement));
          receipt.setTrashed(true);
          counts.receipts++;
        }
      }
    }
  }
  return counts;
}

function applyRollover(users, moves, deactivate) {
  var map = moves || {};
  return {
    users: users.map(function (user) {
      if (!user.roles || user.roles.indexOf('student') === -1) return user;
      var to = map[user.asClass];
      if (to === undefined) return user;
      var copy = {};
      for (var key in user) copy[key] = user[key];
      if (to === null) {
        // Graduating: the level is kept so past feedback still reads sensibly.
        if (deactivate !== false) copy.active = false;
      } else {
        copy.asClass = to;
      }
      copy.updatedAt = new Date().toISOString();
      return copy;
    })
  };
}

/* ------------------------------------------------------------------ *
 * audit
 * ------------------------------------------------------------------ */

/**
 * Appends one audit entry.
 *
 * The actor is taken from the verified token, never from the request body. A
 * client that could name its own actor could write someone else's name against
 * its own deletion, which would make the log worse than not having one.
 */
function appendAudit(root, entry, account) {
  if (!entry || typeof entry !== 'object') return fail('That audit entry is missing.');
  var at = new Date().toISOString();
  var id = 'aud_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);

  writeJson(root, ['audit', at.slice(0, 7)], id + '.json', {
    schemaVersion: 4,
    id: id,
    action: String(entry.action || 'unknown'),
    at: at,
    actor: { username: account.username, name: account.name, roles: account.roles || [] },
    summary: String(entry.summary || ''),
    target: entry.target || null,
    reason: entry.reason || null,
    detail: entry.detail || null,
    severe: Boolean(entry.severe),
    viaProxy: true
  });
  return json({ ok: true, id: id });
}

/* ------------------------------------------------------------------ *
 * cadre reads
 *
 * Every one of these returns records the caller was already entitled to read
 * from Drive directly. Moving them here changes who holds the Drive permission,
 * not who may see what — that comes later, when the cadre and commander spaces
 * arrive and these functions start filtering by folder.
 * ------------------------------------------------------------------ */

/** Reads every JSON file in a folder, skipping the roll-up index files. */
function readFolderDocs(root, segments) {
  var folder = findFolder(root, segments);
  var out = [];
  if (!folder) return out;

  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    // Files beginning with an underscore are caches the app rebuilds for
    // itself; sending them would only invite the client to trust them.
    if (name.indexOf('_') === 0 || name.slice(-5) !== '.json') continue;
    try {
      out.push(JSON.parse(file.getBlob().getDataAsString('UTF-8')));
    } catch (err) {
      // One unreadable record must not take the whole listing down.
      console.warn('unreadable: ' + segments.join('/') + '/' + name);
    }
  }
  return out;
}

/**
 * Forms and requests, from the spaces this account may see.
 *
 * A request in a space this account cannot reach is not filtered out of a
 * larger result — it is never read at all. There is nothing here for a client
 * to sift through, because the folder was never opened.
 */
function readCatalog(root, account) {
  var spaces = spacesFor(account);
  var requests = [];
  var forms = [];
  for (var i = 0; i < spaces.length; i++) {
    var rows = readFolderDocs(root, spacePath(spaces[i], 'requests'));
    for (var j = 0; j < rows.length; j++) {
      rows[j].space = spaces[i];
      requests.push(rows[j]);
    }
    // Forms are read per space too. A form in a space this account cannot
    // reach is not filtered out of a larger list — its folder is never opened.
    var formRows = readFolderDocs(root, spacePath(spaces[i], 'forms'));
    for (var k = 0; k < formRows.length; k++) {
      formRows[k].space = spaces[i];
      forms.push(formRows[k]);
    }
  }
  return { forms: forms, requests: requests };
}

/**
 * Responses for one request, if this account may reach the space it lives in.
 *
 * The space comes from the request record, so a caller naming a request it
 * cannot see gets nothing rather than a redirect to somewhere it can.
 */
function readResponses(root, account, requestId) {
  var located = locateRequest(root, requestId);
  if (!located || !mayReach(account, located.space)) return null;
  return {
    responses: readFolderDocs(root, spacePath(located.space, 'responses', requestId)),
    receipts: readFolderDocs(root, spacePath(located.space, 'receipts', requestId))
  };
}

function mayReach(account, space) {
  return spacesFor(account).indexOf(space) !== -1;
}

/**
 * Finds a form across every space, returning it with the space it was in.
 *
 * Forms used to live in one flat `forms/` folder while requests were already
 * separated, which meant a commander-only request kept its *questions* in a
 * folder every instructor could read — and the questions are where the
 * sensitive wording lives. "Describe the complaint against Capt Reyes" is the
 * disclosure, not the response to it.
 */
function locateForm(root, formId) {
  var spaces = Object.keys(SPACE_FOLDERS);
  for (var i = 0; i < spaces.length; i++) {
    var doc = readJson(root, spacePath(spaces[i], 'forms'), formId + '.json');
    if (doc) return { form: doc, space: spaces[i] };
  }
  return null;
}

/** Finds a request across every space, returning it with the space it was in. */
function locateRequest(root, requestId) {
  var spaces = Object.keys(SPACE_FOLDERS);
  for (var i = 0; i < spaces.length; i++) {
    var doc = readJson(root, spacePath(spaces[i], 'requests'), requestId + '.json');
    if (doc) return { request: doc, space: spaces[i] };
  }
  return null;
}

/**
 * Every response across every request, for cross-form analysis.
 *
 * Deliberately the one call that can get large. A detachment with a term of
 * feedback is comfortably inside Apps Script's response limit, but this is the
 * first thing that will need paging if a detachment runs for years.
 */
/**
 * The By-instructor view: requests, their forms, their responses, and the staff
 * they are about — all narrowed to this account's people tier.
 *
 * **The narrowing happens here, before anything is returned.** A client-side
 * filter over `catalog` and `allResponses` would put every instructor's records
 * in every instructor's browser and hide them with a predicate, which is not a
 * boundary at all. Responses are gathered per surviving request rather than
 * read wholesale and filtered, so a request out of scope is never opened.
 *
 * `staff` is narrowed the same way, because the view lists people who have no
 * feedback yet — "nobody has asked about this instructor" is worth seeing, and
 * it must not become a way to enumerate people the tier excludes.
 */
function readPeople(root, account) {
  var tier = peopleTierFor(account);
  var spaces = spacesFor(account);
  var me = String((account && account.username) || '').toLowerCase();

  var requests = [];
  var forms = [];
  var responses = [];
  var formIds = {};

  for (var s = 0; s < spaces.length; s++) {
    var rows = readFolderDocs(root, spacePath(spaces[s], 'requests'));
    for (var i = 0; i < rows.length; i++) {
      if (!requestInPeopleScope(root, rows[i], account, tier)) continue;
      rows[i].space = spaces[s];
      requests.push(rows[i]);
      formIds[rows[i].formId] = spaces[s];

      var found = readFolderDocs(root, spacePath(spaces[s], 'responses', rows[i].id));
      for (var r = 0; r < found.length; r++) {
        found[r].space = spaces[s];
        responses.push(found[r]);
      }
    }
  }

  // Only the forms the surviving requests actually render with.
  for (var id in formIds) {
    if (!Object.prototype.hasOwnProperty.call(formIds, id)) continue;
    var form = readJson(root, spacePath(formIds[id], 'forms'), id + '.json');
    if (form) {
      form.space = formIds[id];
      forms.push(form);
    }
  }

  var users = readRoster(root);
  var staff = [];
  for (var u = 0; u < users.length; u++) {
    var user = users[u];
    var name = String(user.username || '').toLowerCase();
    var isStaff = false;
    var held = user.roles || [];
    for (var h = 0; h < held.length; h++) {
      if (held[h] !== 'student') isStaff = true;
    }
    if (!isStaff) continue;
    if (tier === 'all' || name === me
        || (tier === 'instructors' && isPlainInstructor(user))) {
      staff.push(user);
    }
  }

  return { requests: requests, forms: forms, responses: responses, staff: staff, tier: tier };
}

function readAllResponses(root, account) {
  var spaces = spacesFor(account);
  var out = [];
  for (var s = 0; s < spaces.length; s++) {
    var parent = findFolder(root, spacePath(spaces[s], 'responses'));
    if (!parent) continue;
    var subs = parent.getFolders();
    while (subs.hasNext()) {
      var sub = subs.next();
      var rows = readFolderDocs(root, spacePath(spaces[s], 'responses', sub.getName()));
      for (var i = 0; i < rows.length; i++) {
        rows[i].space = spaces[s];
        out.push(rows[i]);
      }
    }
  }
  return out;
}

function readRoster(root) {
  var doc = readJson(root, ['users'], 'users.json');
  return (doc && doc.users) || [];
}

/** Audit entries, newest month first, walking back from today. */
function readAudit(root, months) {
  var out = [];
  var cursor = new Date();
  for (var i = 0; i < Math.min(months, 24); i++) {
    var key = Utilities.formatDate(cursor, 'UTC', 'yyyy-MM');
    var rows = readFolderDocs(root, ['audit', key]);
    for (var j = 0; j < rows.length; j++) out.push(rows[j]);
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return out;
}

/**
 * Counts only — enough for a summary without shipping records.
 *
 * Counted across every space, because an overview that silently omits the
 * restricted spaces tells a commander their detachment is quieter than it is.
 */
function readStats(root) {
  var spaces = Object.keys(SPACE_FOLDERS);
  var total = 0;
  var open = 0;
  var forms = 0;
  for (var s = 0; s < spaces.length; s++) {
    var requests = readFolderDocs(root, spacePath(spaces[s], 'requests'));
    for (var i = 0; i < requests.length; i++) {
      total++;
      if (!requests[i].status || requests[i].status === 'open') open++;
    }
    forms += readFolderDocs(root, spacePath(spaces[s], 'forms')).length;
  }
  return { requests: total, openRequests: open, forms: forms, accounts: readRoster(root).length };
}

/* ------------------------------------------------------------------ *
 * roster and addressing
 * ------------------------------------------------------------------ */

function findByUsername(root, username) {
  var users = readRoster(root);
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].username || '').toLowerCase() === username) return users[i];
  }
  return null;
}

function findAccount(root, email) {
  var doc = readJson(root, ['users'], 'users.json');
  var users = (doc && doc.users) || [];
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].email || '').trim().toLowerCase() === email) return users[i];
  }
  return null;
}

/**
 * Mirrors the client's audience rule: a named list wins, otherwise the AS level.
 * Checked here as well as there, because the client is the thing being guarded
 * against.
 */
function isAddressedTo(request, account) {
  var named = request.assignedUsernames || [];
  if (named.length) return named.indexOf(account.username) !== -1;
  if (!request.asClass) return true;
  return String(request.asClass) === String(account.asClass || '');
}

function hasReceipt(root, space, requestId, username) {
  var folder = findFolder(root, spacePath(space, 'receipts', requestId));
  if (!folder) return false;
  return folder.getFilesByName(username + '.json').hasNext();
}

/**
 * Builds the stored record.
 *
 * The identity decision happens here rather than being taken from the client: an
 * anonymous form stores no respondent, full stop. A client that asked to be
 * attributed on an anonymous form would be ignored, and vice versa.
 */
function buildResponse(body, request, account) {
  var anonymous = request.anonymous !== false;
  return {
    schemaVersion: Number(body.schemaVersion) || 4,
    id: 'res_' + Utilities.getUuid().replace(/-/g, '').slice(0, 14),
    requestId: request.id,
    formId: request.formId || body.formId || null,
    anonymous: anonymous,
    asClass: request.asClass || account.asClass || '',
    schoolYear: request.schoolYear || '',
    semester: request.semester || '',
    answers: sanitizeAnswers(body.answers),
    respondent: anonymous ? null : {
      username: account.username,
      name: account.name,
      asClass: account.asClass || ''
    },
    submittedAt: new Date().toISOString(),
    viaProxy: true
  };
}

/**
 * Keeps answers to flat scalars.
 *
 * Not form validation — the client does that, and duplicating the form engine
 * here would mean maintaining it twice. This only ensures nothing structural
 * gets stored that the reading code would choke on.
 */
function sanitizeAnswers(answers) {
  var clean = {};
  if (!answers || typeof answers !== 'object') return clean;
  var keys = Object.keys(answers);
  for (var i = 0; i < keys.length && i < 200; i++) {
    var key = keys[i];
    if (!ID_PATTERN.test(key)) continue;
    var value = answers[key];
    if (typeof value === 'number' && isFinite(value)) clean[key] = value;
    else if (typeof value === 'string') clean[key] = value.slice(0, 8000);
    else if (typeof value === 'boolean') clean[key] = value;
  }
  return clean;
}

/* ------------------------------------------------------------------ *
 * Drive helpers
 *
 * Paths are always built from literal segment names plus pattern-checked ids.
 * No caller-supplied string ever reaches Drive as a path.
 * ------------------------------------------------------------------ */

function findFolder(root, segments) {
  var current = root;
  for (var i = 0; i < segments.length; i++) {
    var children = current.getFoldersByName(segments[i]);
    if (!children.hasNext()) return null;
    current = children.next();
  }
  return current;
}

function ensureFolder(root, segments) {
  var current = root;
  for (var i = 0; i < segments.length; i++) {
    var children = current.getFoldersByName(segments[i]);
    current = children.hasNext() ? children.next() : current.createFolder(segments[i]);
  }
  return current;
}

function readJson(root, segments, name) {
  var folder = findFolder(root, segments);
  if (!folder) return null;
  var files = folder.getFilesByName(name);
  if (!files.hasNext()) return null;
  try {
    return JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
  } catch (err) {
    return null;
  }
}

function writeJson(root, segments, name, value) {
  var folder = ensureFolder(root, segments);
  var blob = Utilities.newBlob(JSON.stringify(value, null, 2), 'application/json', name);
  var existing = folder.getFilesByName(name);
  if (existing.hasNext()) {
    existing.next().setContent(JSON.stringify(value, null, 2));
    return;
  }
  folder.createFile(blob);
}

/* ------------------------------------------------------------------ *
 * responses
 * ------------------------------------------------------------------ */

function json(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * A refusal.
 *
 * Always HTTP 200 with `ok: false`, because Apps Script turns a thrown error
 * into an HTML page the app cannot parse, and a cadet would see "something went
 * wrong" instead of the reason. The message is written to be read by a
 * nineteen-year-old on a phone, not by a developer.
 */
function fail(message) {
  return json({ ok: false, error: message });
}

/* ------------------------------------------------------------------ *
 * setup check
 * ------------------------------------------------------------------ */

/**
 * Optional, and worth the thirty seconds.
 *
 * Configuration is two entries under **Project Settings -> Script Properties**,
 * `FOLDER_ID` and `CLIENT_ID`. This function does not set them; the editor's own
 * UI does that, and it does it without anyone having to edit code, save the file,
 * find the function selector, or remember to clear values out afterwards.
 *
 * This replaced a `setUp()` that took the values as literals and stored them.
 * That version failed silently in a way nobody could see: Run executes the last
 * *saved* file, so pasting values and pressing Run without saving threw on the
 * guard and wrote nothing, and the endpoint kept reporting "not configured" with
 * no clue why. An hour went into that once. The properties UI cannot fail that
 * way.
 *
 * What the UI cannot do is make Google ask for the Drive permission this script
 * needs. Only running code that touches Drive does that — so that is what this
 * is for. Without it the first cadet submission is where the missing
 * authorisation surfaces.
 */
function checkSetUp() {
  var cfg = config();
  if (!cfg.folderId || !cfg.clientId) {
    throw new Error(
      'Not configured. Project Settings -> Script Properties, add FOLDER_ID and '
      + 'CLIENT_ID, then run this again.');
  }
  // Reaching Drive is the point: it validates the id *and* triggers the
  // authorisation prompt, at a moment someone is watching.
  var name = DriveApp.getFolderById(cfg.folderId).getName();
  console.log('Configured and authorised. Folder: ' + name);
  console.log('Deploy as a web app: execute as me, access to anyone.');
}
