/**
 * Whose results a person may see in the By-instructor view.
 *
 * `panels.js` decides which *spaces* an account reads. This decides which
 * *subjects* within them, which is a different question and the one the
 * oversight tiers turn on:
 *
 *   - an **instructor** sees their own results;
 *   - **cadre** see the instructors they oversee, and themselves;
 *   - a **commander** sees everyone, cadre included.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * The proxy applies this rule server-side to the `people` action, so the app
 * will not serve an instructor a By-instructor view of somebody else. That is a
 * real boundary on this view.
 *
 * It is **not** confidentiality. `allResponses` and `catalog` remain open to
 * instructors (`ACTIONS` in tools/proxy/Code.gs), so an instructor holding the
 * proxy URL can still fetch every response in the shared space and group it
 * themselves. Narrowing those actions would also narrow Responses & analysis,
 * which is a separate decision that has not been taken. Do not describe this
 * anywhere as instructors being unable to see each other's feedback — see
 * docs/STYLE.md §4.
 *
 * On a backend with no proxy there is no server to enforce anything, and this
 * runs in the browser as a lens only.
 *
 * **Mirrored in `tools/proxy/Code.gs` as `peopleTierFor` and `readPeople`.**
 * (`subjectAllowed` never existed; the narrowing lives inside `readPeople`.)
 * Apps Script cannot import this file, the same reason `SPACE_ACCESS` is
 * declared in both places. Change one, change the other.
 */

import { ROLES } from './config.js';

export const PEOPLE_SCOPE = {
  own: 'own',
  instructors: 'instructors',
  all: 'all',
};

const LABELS = {
  own: 'Your results',
  instructors: 'Instructors you oversee',
  all: 'Everyone',
};

/**
 * The tier a set of **held** roles grants.
 *
 * Held, never effective. `ROLE_IMPLIES` makes cadre imply instructor, so a cadre
 * member's effective roles contain `instructor` — running this on
 * `effectiveRoles()` would put every cadre member in the instructor tier and
 * hand them each other's results, which is exactly the tier this exists to
 * enforce. `effectiveRoles()` answers "may this account open the panel"; this
 * answers "whose results does it contain", and they are not the same question.
 */
export function peopleTierFor(heldRoles = []) {
  const held = new Set(heldRoles);
  if (held.has(ROLES.commander)) return PEOPLE_SCOPE.all;
  if (held.has(ROLES.cadre)) return PEOPLE_SCOPE.instructors;
  return PEOPLE_SCOPE.own;
}

/**
 * Whether an account is an instructor and nothing above it.
 *
 * Cadre and commanders hold `instructor` in their effective roles and often in
 * their held ones too, so "has instructor" alone is not the question — "has
 * instructor and is not cadre or a commander" is. An account that is also a
 * database administrator still counts: administering the roster is a different
 * job from being overseen, and says nothing about whose results these are.
 */
export function isPlainInstructor(account) {
  const held = new Set(account?.roles || []);
  if (held.has(ROLES.cadre) || held.has(ROLES.commander)) return false;
  return held.has(ROLES.instructor);
}

/** The person a request reflects on: its subject, or whoever issued it. */
export function subjectOf(request) {
  return request?.subject || request?.createdBy || null;
}

/**
 * A scope, bound to one account and roster.
 *
 * `rosterByUsername` is a Map of username to account record — the roster the
 * caller already loaded, rather than a second read.
 */
export function peopleScope(heldRoles, username, rosterByUsername = new Map()) {
  const tier = peopleTierFor(heldRoles);
  const me = username || null;

  /** Whether this scope covers a person at all — used for the staff list. */
  function allowsSubject(subject) {
    if (tier === PEOPLE_SCOPE.all) return true;
    // Unattributed. Only the everyone tier covers it, and that already returned
    // above — this read as though it might still say yes.
    if (!subject) return false;
    if (subject === me) return true;
    if (tier === PEOPLE_SCOPE.own) return false;
    return isPlainInstructor(rosterByUsername.get(subject));
  }

  /**
   * Whether one request is in scope.
   *
   * An instructor keeps the requests they *issued* as well as the ones about
   * them: they built and sent the form, so withholding what came back reads as
   * a fault rather than a policy. A request they issued about somebody else
   * still groups under that person, so their view can show another name — with
   * only the requests they created under it, never that person's full picture.
   */
  function allows(request) {
    if (tier === PEOPLE_SCOPE.all) return true;
    if (tier === PEOPLE_SCOPE.own) {
      return request?.subject === me || request?.createdBy === me;
    }
    return allowsSubject(subjectOf(request));
  }

  return { tier, label: LABELS[tier], allows, allowsSubject };
}
