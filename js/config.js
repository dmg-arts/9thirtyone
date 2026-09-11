/**
 * 9ThirtyOne — application constants and the shape of the data model.
 *
 * Everything the rest of the app assumes about *where things live* and *what a
 * record looks like* is declared here, so re-pointing at a different Drive or
 * bumping the schema is a one-file change.
 */

/**
 * The Google OAuth client every detachment signs in through.
 *
 * One verified client for the whole programme, rather than one Cloud project per
 * detachment. That reversal is the difference between a detachment spending
 * twenty minutes in the Cloud console — consent screen, Drive API, a test-user
 * list holding every cadet, a client ID to copy out — and spending none.
 *
 * It is public by design. A Client ID identifies the application to Google and is
 * visible to anyone who loads the page; there is no client *secret* here and
 * nothing to protect. What stops a stranger reaching a detachment's records is
 * Google sign-in and that detachment's own roster, never the obscurity of this
 * string.
 *
 * A detachment that configured its own client before this change keeps working:
 * a stored clientId overrides this default, and nothing revokes an existing one.
 */
export const GOOGLE_CLIENT_ID =
  '536562746421-uf9hu736m0bq0t41s0ck8h9fmu9ggkos.apps.googleusercontent.com';

export const APP = {
  name: '9ThirtyOne',
  shortName: '9ThirtyOne',
  version: '1.0.5-beta.1',
  /**
   * Bump when the on-disk record shape changes, and add a matching entry to
   * MIGRATIONS in js/migrations.js. The runner upgrades a detachment's existing
   * records to this version on startup.
   */
  schemaVersion: 4,
};

/** localStorage keys. Device-local only — never org data. */
export const LS = {
  settings: 'nine31.settings.v1',
  connection: 'nine31.connection.v1',
  studentPrefs: 'nine31.student.prefs.v1',
  setupComplete: 'nine31.setup.complete.v1',
  session: 'nine31.session.v1',
  directSignIn: 'nine31.directsignin.v1',
  queue: 'nine31.queue.v1',
};

/**
 * Account roles. An account may hold several (an instructor who also
 * administers the database holds both `instructor` and `admin`).
 */
export const ROLES = {
  student: 'student',
  instructor: 'instructor',
  cadre: 'cadre',
  commander: 'commander',
  admin: 'admin',
};

/**
 * Where a feedback request and its responses live.
 *
 * Not a label on a record — a different folder, so "locked" means locked rather
 * than hidden. The proxy decides which spaces a role may read and write, and a
 * space nobody may reach is simply never returned.
 */
export const SPACES = {
  shared: 'shared',
  cadre: 'cadre',
  commander: 'commander',
};

/**
 * Which spaces each role may see, most permissive last.
 *
 * Students are absent on purpose: a cadet sees the requests addressed to them
 * wherever they live, because a commander's feedback request is still meant to
 * be answered. What they never see is anyone's responses, so nothing leaks
 * across a boundary by being answerable.
 */
export const SPACE_ACCESS = {
  [ROLES.instructor]: [SPACES.shared],
  [ROLES.admin]: [SPACES.shared],
  [ROLES.cadre]: [SPACES.shared, SPACES.cadre],
  [ROLES.commander]: [SPACES.shared, SPACES.cadre, SPACES.commander],
};

/** At most two, so a change of command overlaps rather than cutting over. */
export const MAX_COMMANDERS = 2;

/**
 * Roles that carry another role's access.
 *
 * Cadre is a superset of instructor and commander a superset of cadre, so a
 * cadre member opens the Instructor Panel without also being listed as an
 * instructor. Without this a cadre-only account is locked out of the panel it
 * is supposed to have more access to, not less.
 *
 * Deliberately not applied to `admin`: managing the roster and running the
 * panel are separate jobs that happen to be held together often.
 */
export const ROLE_IMPLIES = {
  [ROLES.cadre]: [ROLES.instructor],
  [ROLES.commander]: [ROLES.cadre, ROLES.instructor],
};

/** Every role a set of held roles grants, following the implications above. */
export function effectiveRoles(roles = []) {
  const out = new Set(roles);
  for (const role of roles) {
    for (const implied of ROLE_IMPLIES[role] || []) out.add(implied);
  }
  return [...out];
}

/** The spaces a set of roles can reach, combined. */
export function spacesFor(roles = []) {
  const out = new Set();
  for (const role of roles) {
    for (const space of SPACE_ACCESS[role] || []) out.add(space);
  }
  return [...out];
}

/**
 * What each role is called on screen.
 *
 * `student` reads "Cadet" on purpose, and the mismatch is not a leftover. The
 * key is a stored identifier — it is written into roster records, addressed by
 * the `/student` route and by `students.json`, and persisted in
 * `nine31.student.prefs.v1` — so renaming it is a migration. The label is what a
 * person reads, AFROTC says cadet, and this is the seam that lets the two differ
 * without one being wrong. See docs/STYLE.md §1, note 3.
 *
 * Read role names from here rather than writing them inline, so the next
 * terminology decision is one edit instead of another sweep.
 */
export const ROLE_LABELS = {
  student: 'Cadet',
  instructor: 'Instructor',
  cadre: 'Cadre',
  commander: 'Commander',
  admin: 'Database admin',
};

/**
 * Whether this device offers signing in with an email instead of Google.
 *
 * This used to be "development mode", and it did something much broader and
 * much worse: it made every role check pass, so the panels opened with no
 * sign-in at all. That is gone. The flag now enables exactly one thing — the
 * email sign-in on the sign-in screen — and grants no access by itself.
 *
 * It still has to exist, because an installation using *This device only* has
 * no Google Client ID and therefore no way to sign anybody in. That is the
 * evaluation path the setup guide recommends, and without this it is a dead
 * end: setup completes and the Instructor Panel can never be opened.
 *
 * What it is not is a bypass. `signInAsDeveloper` goes through the same roster
 * check as a Google sign-in — an email that is not on the roster is refused,
 * the account's real roles apply, and the audit log names a real person. The
 * sign-in screen only offers it when no Client ID is configured, which a
 * Drive-backed detachment always has.
 *
 * The storage key changed with the meaning, so any device that had the old
 * development mode switched on comes back with this off. That is the safe
 * direction and the intended one.
 */
export function isDirectSignIn() {
  return localStorage.getItem(LS.directSignIn) === '1';
}

export function setDirectSignIn(on) {
  if (on) localStorage.setItem(LS.directSignIn, '1');
  else localStorage.removeItem(LS.directSignIn);
}

/**
 * Storage backends. The org picks one during setup; every view talks to the
 * facade in js/storage/index.js and never to a backend directly.
 */
export const BACKENDS = {
  drive: 'drive',   // Google Drive REST API + OAuth (phone + desktop)
  folder: 'folder', // File System Access API against a synced Drive folder (desktop)
  local: 'local',   // IndexedDB on this device only (evaluation / offline)
};

/**
 * The folder tree created inside the org's chosen Drive folder. This *is* the
 * database: one JSON document per record, grouped by collection.
 */
export const DB_LAYOUT = {
  root: '9ThirtyOne',
  folders: {
    config: 'config',
    users: 'users',
    forms: 'forms',
    requests: 'requests',
    responses: 'responses',
    receipts: 'receipts',
    audit: 'audit',
    roster: 'roster',
    reports: 'reports',
    archive: 'archive',
  },
};

/** Single-document files that live in config/ or a collection root. */
export const DOCS = {
  org: 'config/org.json',
  shared: 'config/settings.json',
  users: 'users/users.json',
};

/**
 * Roll-up files. Reading one of these replaces reading every record in the
 * folder, which is the difference between 1 API call and several thousand.
 * The leading underscore marks them as indexes; readCollection() skips them.
 */
export const INDEXES = {
  /** responses/_counts.json — {byRequest: {id: n}, total: n} */
  responseCounts: 'responses/_counts.json',
  /** responses/<requestId>/_index.json — every response for one request */
  responsesFor: (requestId) => `responses/${requestId}/_index.json`,
  /**
   * receipts/<requestId>/<username>.json — one file per student per form.
   *
   * Deliberately NOT one array in one document. Every cadet in a flight submits
   * within minutes of each other, and a shared array means read-modify-write
   * races that silently drop a receipt — which would let that student submit
   * twice and leave them showing as outstanding forever. A lost receipt is also
   * the one loss that cannot be rebuilt, because an anonymous response carries
   * no name to reconstruct it from. Separate paths make the race impossible
   * rather than merely detectable.
   */
  receiptFor: (requestId, username) => `receipts/${requestId}/${username}.json`,
  receiptsFolder: (requestId) => `receipts/${requestId}`,
  /** Pre-v3 layout, still read so an un-migrated folder keeps working. */
  legacyReceiptsFor: (requestId) => `receipts/${requestId}/_index.json`,
};

export const FOLDER_TREE_PREVIEW = `9ThirtyOne/
├── config/      org profile, shared settings
├── users/       accounts — students, instructors, admins
├── roster/      legacy student roster (migrated into users/)
├── forms/       feedback form definitions
├── requests/    feedback requests issued to students
├── responses/   submitted feedback, one folder per request
├── receipts/    who submitted (kept apart from what they said)
├── audit/       who deleted or changed what, and when
├── reports/     exported reports (CSV / JSON)
└── archive/     closed terms retained for the record`;

/**
 * Disclosure control for anonymous feedback.
 *
 * Anonymity has a hard floor: with n responses from a known set of n
 * submitters, the best anyone can do is a 1-in-n guess — and at n=1 that is a
 * certainty. Receipts make the submitters known by design, so a single response
 * shown next to a completion list identifies its author by elimination.
 *
 * Below this many responses, an anonymous form's results are withheld from the
 * analysis entirely: no statistics, no comments, no individual responses. Only
 * the counts remain, so cadre can still chase the people who owe feedback.
 *
 * This applies to anonymous forms only. On an attributed form the names are
 * already attached, so withholding would cost visibility and buy nothing.
 */
export const PRIVACY = {
  minResponsesToShow: 3,
};

/** Standardized form limits, per the form creator specification. */
export const FORM_RULES = {
  minQuestions: 3,
  textWordLimit: 250,
  scaleMin: 1,
  scaleMax: 9,
};

/**
 * The rating scale.
 *
 * Students choose a *word*; the number behind it is what gets averaged and is
 * never shown to them. All nine points are named, so the full 1–9 resolution is
 * actually reachable rather than only the odd values.
 *
 * The vocabulary alternates by design. Odd points carry the direction —
 * Detrimental, Unfavorable, Neutral, Favorable, Outstanding — and even points
 * carry the magnitude of the step either side of centre: Minor (4) mirrors
 * Slight (6), and Major (8) is the strong step on the favourable side.
 * Position in the row supplies the direction for the magnitude words, which is
 * why the options are always rendered in numeric order and never re-sorted.
 *
 * Point 2 deliberately breaks that symmetry. It was "Significant", the mirror
 * of Major (8), and out of context that word reads as neutral or even positive
 * — a cadet scanning the row had only the position to tell them it was the
 * second-worst option available. "Alarming" carries its own direction, so the
 * harshest end of the scale cannot be picked by mistake. Losing the 2/8 pairing
 * is the price, and it is worth paying at the end where a misread matters most.
 *
 * This object drives the UI directly: one option is rendered per entry, so
 * changing the vocabulary or the number of points needs no code change.
 *
 * Changing these words does not touch stored feedback — every form records the
 * scale it was built with, so old responses keep their original wording and
 * numbers and remain comparable among themselves.
 */
export const SCALE_ANCHORS = {
  1: 'Detrimental',
  2: 'Alarming',
  3: 'Unfavorable',
  4: 'Minor',
  5: 'Neutral',
  6: 'Slight',
  7: 'Favorable',
  8: 'Major',
  9: 'Outstanding',
};

/** The selectable values of an anchor set, in order. */
export function scaleValues(anchors = SCALE_ANCHORS) {
  return Object.keys(anchors).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

/**
 * The word closest to a computed score, for reporting a mean in the same
 * vocabulary students answered in. Ties round toward the lower anchor so a
 * score is never described more favourably than it earned.
 */
export function nearestAnchor(value, anchors = SCALE_ANCHORS) {
  if (!Number.isFinite(value)) return null;
  const values = scaleValues(anchors);
  if (!values.length) return null;
  let best = values[0];
  for (const candidate of values) {
    if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate;
  }
  return anchors[best] ?? anchors[String(best)] ?? null;
}

/* ------------------------------------------------------------------ *
 * Academic term vocabulary — drives the filter controls everywhere.
 * ------------------------------------------------------------------ */

export const SEMESTERS = ['Fall', 'Spring', 'Summer'];

/** AFROTC class years. `label` is what cadre/students actually say. */
export const AS_CLASSES = [
  { code: 'AS100', label: 'AS100 — GMC First Year' },
  { code: 'AS200', label: 'AS200 — GMC Second Year' },
  { code: 'AS300', label: 'AS300 — POC First Year' },
  { code: 'AS400', label: 'AS400 — POC Second Year' },
  { code: 'FT', label: 'Field Training' },
  { code: 'CADRE', label: 'Cadre' },
];

/**
 * How a cadet's AS level advances at the end of an academic year.
 * A level with no entry here is left alone — Field Training and cadre are not
 * on the four-year ladder.
 */
export const AS_PROGRESSION = {
  AS100: 'AS200',
  AS200: 'AS300',
  AS300: 'AS400',
  AS400: null,      // null means "graduating" — deactivated, never deleted
};

export const REQUEST_STATUS = {
  draft: { label: 'Draft', tone: 'neutral' },
  open: { label: 'Open', tone: 'ok' },
  closed: { label: 'Closed', tone: 'neutral' },
  archived: { label: 'Archived', tone: 'neutral' },
};

/**
 * Human-readable feedback id stamped on every request by the form creator, so
 * cadre can quote "FB-2026-0007" in conversation and filter on it later.
 */
export function makeFeedbackId(existingIds = [], now = new Date()) {
  const year = now.getFullYear();
  const prefix = `FB-${year}-`;
  const highest = existingIds
    .filter((id) => typeof id === 'string' && id.startsWith(prefix))
    .map((id) => Number.parseInt(id.slice(prefix.length), 10))
    .filter(Number.isFinite)
    .reduce((max, n) => Math.max(max, n), 0);
  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
}

/** Counts words the way the 250-word limit is described to students. */
export function countWords(text) {
  const trimmed = (text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Generates the school-year strings used in filters, e.g. "2025-2026".
 * The academic year is treated as rolling over in July.
 */
export function schoolYears(span = 5, now = new Date()) {
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const out = [];
  for (let i = 1; i >= -(span - 2); i--) {
    out.push(`${startYear + i}-${startYear + i + 1}`);
  }
  return out;
}

export function currentSchoolYear(now = new Date()) {
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${startYear + 1}`;
}

export function currentSemester(now = new Date()) {
  const m = now.getMonth();
  if (m >= 7 && m <= 11) return 'Fall';
  if (m >= 0 && m <= 4) return 'Spring';
  return 'Summer';
}

/** Default settings. Anything absent from stored settings falls back to this. */
export const DEFAULT_SETTINGS = {
  theme: 'system',       // system | light | dark
  palette: 'default',    // default | deuteranopia | protanopia | tritanopia | mono
  contrast: 'normal',    // normal | high
  textSize: 'md',        // sm | md | lg
  reduceMotion: false,
  defaultSchoolYear: '',   // '' = follow the calendar
  defaultSemester: '',
  studentShowClosed: false,
};
