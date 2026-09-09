/**
 * Accounts and sessions.
 *
 * Identity is the person's Google account. This app issues no passwords and
 * stores no credentials — `users/users.json` is a **roster**: verified email,
 * roles, AS level, section. Nothing in it is secret.
 *
 * That is a deliberate reversal of the earlier design, and a better one for a
 * regional detachment. Cadets travel in from several schools, so there is no
 * single institutional domain to key on, but every one of them already has a
 * Google account — it is how the det mails them. The roster of allowed emails
 * therefore does the job a domain restriction would do at a single-school unit.
 *
 * It also deletes the two worst jobs in the old scheme: distributing a
 * generated password to every cadet, and resetting the ones they forget.
 *
 * See js/google-identity.js for what the client-side token check is and is not
 * worth. Short version: Drive sharing is the boundary that holds.
 */

import { ROLES, isDirectSignIn, effectiveRoles } from './config.js';
import { startSession, currentUser, signOut } from './session.js';
import { makeId, nowIso } from './util.js';
import { AUDIT } from './audit.js';
import {
  loadRoster, resolveIdentity, usingProxy,
  createAccountRecord, updateAccountRecord, deleteAccountRecord, writeAudit,
} from './data-source.js';

// Session handling lives in session.js so that data-source.js can reach the
// ID token without this module and that one importing each other.
export { startSession, currentUser, currentIdToken, signOut } from './session.js';

/* ------------------------------------------------------------------ *
 * usernames
 * ------------------------------------------------------------------ */

/** Usernames are matched case-insensitively and stored lowercased. */
export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Validates the shape of a username. Kept deliberately narrow: cadets type
 * these by hand on a phone, so no spaces and no case sensitivity.
 */
export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!username) return 'Enter a username.';
  if (username.length < 3) return 'Usernames are at least 3 characters.';
  if (username.length > 32) return 'Usernames are at most 32 characters.';
  if (!/^[a-z0-9._-]+$/.test(username)) {
    return 'Use letters, numbers, dots, dashes or underscores only.';
  }
  // Receipts are stored as <username>.json alongside index files, which are the
  // ones starting with an underscore. Reserving the prefix keeps them apart.
  if (username.startsWith('_')) return 'Usernames cannot start with an underscore.';
  return null;
}

/** Emails are matched case-insensitively and stored lowercased. */
export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Checks the shape of an email. Deliberately permissive — a regional
 * detachment's cadets arrive with school addresses, Gmail addresses and
 * everything in between, and rejecting an unusual but real address is worse
 * than accepting a typo an admin can see and fix.
 */
export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return 'Enter the Google account email.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That does not look like an email address.';
  if (email.length > 254) return 'That email address is too long.';
  return null;
}

/** Suggests `last.first` from a display name, deduped against existing users. */
export function suggestUsername(name, taken = []) {
  const parts = String(name || '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
  const last = parts.length > 1 ? parts[0] : (parts[0] || 'cadet');
  const first = parts.length > 1 ? parts[1] : '';
  let base = normalizeUsername(`${last}${first ? `.${first}` : ''}`.replace(/[^a-z0-9._-]/gi, ''));
  if (base.length < 3) base = `${base}user`;
  const existing = new Set(taken.map(normalizeUsername));
  if (!existing.has(base)) return base;
  for (let n = 2; n < 999; n++) {
    if (!existing.has(`${base}${n}`)) return `${base}${n}`;
  }
  return `${base}${Date.now().toString(36)}`;
}

/* ------------------------------------------------------------------ *
 * the account directory
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Account
 * @property {string} id
 * @property {string} email        the Google account they sign in with; the key
 * @property {string} username     stable internal username; receipts are filed under it
 * @property {string} name         display name
 * @property {string[]} roles      any of student | instructor | admin
 * @property {string} asClass      AS100…AS400, FT, CADRE
 * @property {string} section
 * @property {boolean} active
 * @property {boolean} [needsEmail] set by the v4 migration on records with no email
 */

/**
 * The roster, from whichever source this detachment uses.
 *
 * Routed rather than read from Drive: in proxy mode there is no Drive access to
 * read from. This used to be the direct-mode primitive because auth and
 * data-source imported each other; session.js now sits underneath both, so the
 * cycle is gone and this can simply ask for the roster.
 */
export async function listAccounts() {
  return loadRoster();
}

export async function findByUsername(username) {
  const target = normalizeUsername(username);
  if (!target) return null;
  return (await listAccounts()).find((a) => normalizeUsername(a.username) === target) || null;
}

/** The identity lookup: a verified Google address against the roster. */
export async function findByEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  return (await listAccounts()).find((a) => normalizeEmail(a.email) === target) || null;
}

export async function listStudents() {
  return (await listAccounts())
    .filter((a) => a.roles?.includes(ROLES.student) && a.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Adds someone to the roster.
 *
 * The email is the identity — it is what a Google sign-in is matched against.
 * The username is kept as a stable internal identifier: receipts are stored as
 * `receipts/<requestId>/<username>.json`, and keying those on an address that
 * can change would orphan a cadet's submission history the first time they move
 * schools.
 */
export async function createAccount({ email, name, username = '', roles = [ROLES.student], asClass = '', section = '' }) {
  const emailProblem = validateEmail(email);
  if (emailProblem) throw new Error(emailProblem);
  if (!String(name || '').trim()) throw new Error('Enter a name.');

  const address = normalizeEmail(email);
  if (await findByEmail(address)) {
    throw new Error(`${address} is already on the roster.`);
  }

  const existing = await listAccounts();
  const wanted = normalizeUsername(username) || suggestUsername(name, existing.map((a) => a.username));
  const problem = validateUsername(wanted);
  if (problem) throw new Error(problem);
  if (existing.some((a) => normalizeUsername(a.username) === wanted)) {
    throw new Error(`The username "${wanted}" is already in use.`);
  }

  const account = {
    id: makeId('usr'),
    email: address,
    username: wanted,
    name: String(name).trim(),
    roles: [...new Set(roles)],
    asClass,
    section,
    active: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  // Routed: through the proxy this runs inside a server-side lock, which is a
  // stronger guarantee than the compare-and-retry the direct path uses. The
  // duplicate-email check happens on whichever side actually performs the write,
  // so two administrators adding the same address cannot both succeed.
  await createAccountRecord(account);
  // Role **ids** here, not ROLE_LABELS — so this log line reads "(student)"
  // while every screen says "Cadet". That is deliberate. The summary is written
  // once and kept forever, so it has to record the role that was actually
  // granted; a display name baked into a permanent record goes stale the next
  // time the label changes, and then the log says something that was never true.
  // The action column is label-mapped (js/audit.js) because it is UI. This is
  // data.
  await writeAudit({
    action: AUDIT.accountCreated,
    summary: `Added ${account.email} (${account.roles.join(', ')})`,
    target: account.email,
  });
  return account;
}

export async function updateAccount(id, patch) {
  if (patch.email) {
    const problem = validateEmail(patch.email);
    if (problem) throw new Error(problem);
  }
  if (patch.username) {
    const problem = validateUsername(patch.username);
    if (problem) throw new Error(problem);
  }
  // Read first, so validation and the audit line have the same picture in both
  // modes. In proxy mode the server re-checks all of this under its lock — the
  // checks here are for a clear message, not for correctness.
  const roster = await listAccounts();
  const existing = roster.find((a) => a.id === id);
  if (!existing) throw new Error('That account no longer exists.');

  const wantedEmail = patch.email ? normalizeEmail(patch.email) : normalizeEmail(existing.email);
  if (wantedEmail !== normalizeEmail(existing.email)
      && roster.some((a) => a.id !== id && normalizeEmail(a.email) === wantedEmail)) {
    throw new Error('That email is already on the roster.');
  }
  const wantedUsername = patch.username ? normalizeUsername(patch.username) : existing.username;
  if (wantedUsername !== existing.username
      && roster.some((a) => a.id !== id && normalizeUsername(a.username) === wantedUsername)) {
    throw new Error('That username is already in use.');
  }

  const emailChanged = wantedEmail !== normalizeEmail(existing.email);
  const next = {
    ...existing, ...patch,
    email: wantedEmail, username: wantedUsername,
    updatedAt: nowIso(),
  };
  // Nothing here stores credentials any more; drop any left by an old record.
  delete next.password;
  delete next.needsPassword;

  const result = await updateAccountRecord(id, next, (users) =>
    users.map((a) => (a.id === id ? next : a))) || next;

  await writeAudit({
    action: AUDIT.accountUpdated,
    summary: emailChanged
      ? `Changed the sign-in email for ${result.name} to ${result.email}`
      : `Updated ${result.email}`,
    target: result.email,
    detail: { fields: Object.keys(patch) },
  });
  return result;
}

export async function deleteAccount(id) {
  let removed = null;
  removed = (await listAccounts()).find((a) => a.id === id) || null;
  await deleteAccountRecord(id);
  if (removed) {
    await writeAudit({
      action: AUDIT.accountDeleted,
      summary: `Removed ${removed.email || removed.username} (${removed.name})`,
      target: removed.email || removed.username,
      detail: { roles: removed.roles, asClass: removed.asClass },
    });
  }
}

/** True once at least one admin exists — used to gate first-run bootstrap. */
export async function hasAdmin() {
  return (await listAccounts()).some((a) => a.roles?.includes(ROLES.admin) && a.active !== false);
}

/* ------------------------------------------------------------------ *
 * sign in
 * ------------------------------------------------------------------ */


/**
 * Completes a Google sign-in.
 *
 * The token has already been decoded and checked by google-identity.js; this
 * decides whether that verified person is *allowed in*, which is a roster
 * question, not a cryptographic one.
 *
 * @param {{email, name, picture}} profile  from decodeIdToken()
 * @param {string|null} requiredRole
 * @returns {Promise<Account>}
 */
export async function signInWithGoogle(profile, requiredRole = null, rawToken = null) {
  const email = normalizeEmail(profile?.email);
  if (!email) throw new Error('That Google account did not provide an email address.');

  // Not findByEmail: that reads the roster through the session, and there is no
  // session yet — see resolveIdentity. The raw token is what proves who this is
  // until startSession below has somewhere to put it.
  const account = await resolveIdentity(email, rawToken);

  if (!account) {
    // Bootstrap: a folder with nobody on the roster yet would otherwise be
    // unreachable. Anyone who can sign in *and* reach the folder can claim it —
    // and reaching the folder is a Drive permission the det controls.
    //
    // Direct mode only. A proxy refuses every action to an address it cannot
    // find on the roster, so there is no first-person-through-the-door to be
    // had — and asking anyway would fail the read rather than report the
    // refusal that actually happened.
    if (!usingProxy() && !(await hasAnyAccount())) {
      const founder = await createAccount({
        email,
        name: profile.name || email,
        roles: [ROLES.admin, ROLES.instructor],
      });
      startSession(founder, { idToken: rawToken, idTokenExp: profile.exp });
      return founder;
    }
    throw new Error(
      `${email} is not on this detachment's roster. Ask an administrator to add it.`);
  }

  if (account.active === false) {
    throw new Error('That account has been deactivated. Ask an administrator.');
  }
  if (requiredRole && !account.roles?.includes(requiredRole)) {
    throw new Error(`${email} does not have ${ROLE_ACCESS[requiredRole] || requiredRole} access.`);
  }

  // Keep the roster's display name in step with Google's, so a married name or
  // a corrected spelling does not need an admin edit.
  if (profile.name && profile.name !== account.name) {
    updateAccount(account.id, { name: profile.name }).catch(() => {});
  }

  startSession(account, { idToken: rawToken, idTokenExp: profile.exp });
  return account;
}

/**
 * Signing in with an email instead of Google.
 *
 * An installation using *This device only* has no Google Client ID, so Google
 * cannot sign anybody in — and that is the evaluation path the setup guide
 * recommends. Without this, such an install would be a dead end: setup would
 * complete and the Instructor Panel could never be opened.
 *
 * It takes an email and trusts it, which is exactly as weak as it sounds, and
 * three things keep that from mattering:
 *
 *   - **The roster still decides.** This calls `signInWithGoogle` below, so an
 *     address nobody has added is refused, a deactivated account is refused,
 *     and the roles that come back are the real ones. It is a different way to
 *     assert who you are, not a way to skip being anybody.
 *   - It throws unless the device has switched it on in Settings, which now
 *     requires being an administrator once the detachment has one.
 *   - The sign-in screen only offers it when no Client ID is configured, and a
 *     Drive-backed detachment always has one.
 */
export async function signInAsDeveloper(email, requiredRole = null) {
  if (!isDirectSignIn()) {
    throw new Error('Signing in without Google is switched off on this device. '
      + 'Turn it on in Settings.');
  }
  const problem = validateEmail(email);
  if (problem) throw new Error(problem);
  return signInWithGoogle({ email: normalizeEmail(email), name: null, developer: true }, requiredRole);
}

const ROLE_ACCESS = {
  [ROLES.admin]: 'database administrator',
  [ROLES.instructor]: 'instructor',
  [ROLES.student]: 'student',
};

/** True once anyone at all is on the roster. Gates the bootstrap above. */
export async function hasAnyAccount() {
  return (await listAccounts()).length > 0;
}

/**
 * Role check used by the route guards.
 *
 * There is no longer any device-local flag that makes this return true. It used
 * to: development mode short-circuited every role check, so anyone holding a
 * detachment laptop could open the Cadre Panel and the admin console by ticking
 * a box on a page that needs no sign-in. What replaced it is signing in — the
 * email sign-in exists for installations with no Google Client ID, but it goes
 * through the roster like any other, so the roles it produces are real.
 */
export function hasRole(role) {
  return effectiveRoles(currentUser()?.roles || []).includes(role);
}

/**
 * The roles to treat this session as holding, implications included.
 *
 * Anything asking "which areas may I show?" uses this rather than reading
 * `currentUser().roles` directly, so it can never disagree with `hasRole` about
 * what somebody holds.
 */
export function activeRoles() {
  return effectiveRoles(currentUser()?.roles || []);
}

