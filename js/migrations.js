/**
 * Schema migrations.
 *
 * A detachment's records live in their own Drive folder and outlive any single
 * release of this app. When a record shape changes, old documents must be
 * upgraded in place rather than silently misread — a v1 response read by v2
 * code is the kind of bug that shows up as quietly wrong statistics a term
 * later.
 *
 * How it works:
 *   - `APP.schemaVersion` is the version this build expects.
 *   - The version a folder is actually at is stored in `config/org.json`.
 *   - On startup, every migration with `to` greater than the stored version
 *     runs in ascending order, then the stored version is set to the app's.
 *
 * Rules for writing one:
 *   - Idempotent. It may run twice if a device dies mid-upgrade.
 *   - Forward only. There is no downgrade path; a detachment that needs to roll
 *     back restores the backup they were told to take.
 *   - Additive where possible. Prefer filling in a missing field to rewriting a
 *     record wholesale, so a half-finished run leaves usable data.
 */

import { APP, INDEXES } from './config.js';
import { nowIso, makeId } from './util.js';

/**
 * @typedef {object} Migration
 * @property {number} to        schema version this produces
 * @property {string} describe  one line, shown in the admin console
 * @property {(ctx: {db: object, report: (msg: string) => void}) => Promise<void>} run
 */

/** @type {Migration[]} */
const MIGRATIONS = [
  {
    to: 2,
    describe: 'Accounts, submission receipts and roll-up indexes',
    async run({ db, report }) {
      // --- 1. Roster records become accounts -------------------------------
      const usersDoc = await db.getUsers().catch(() => null);
      const existing = usersDoc?.users || [];
      const byUsername = new Map(existing.map((u) => [u.username, u]));

      const roster = await db.getRoster().catch(() => ({ students: [] }));
      let addedFromRoster = 0;
      for (const student of roster.students || []) {
        const username = uniqueUsername(student.name, byUsername);
        if ([...byUsername.values()].some((u) => u.name === student.name)) continue;
        byUsername.set(username, {
          id: student.id || makeId('usr'),
          username,
          name: student.name,
          roles: ['student'],
          asClass: student.asClass || '',
          section: student.section || '',
          email: normalizeEmail(student.email),
          active: student.active !== false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          migratedFromRoster: true,
        });
        addedFromRoster++;
      }
      if (addedFromRoster) report(`Converted ${addedFromRoster} roster entries into accounts`);

      // --- 2. Every account gains the fields v2 expects ---------------------
      let repaired = 0;
      for (const account of byUsername.values()) {
        let changed = false;
        if (!Array.isArray(account.roles) || !account.roles.length) {
          account.roles = ['student'];
          changed = true;
        }
        if (account.active === undefined) { account.active = true; changed = true; }
        if (changed) repaired++;
      }
      if (repaired) report(`Repaired ${repaired} account records`);
      if (byUsername.size) await db.saveUsers([...byUsername.values()]);

      // --- 3. Requests gain a feedback id and an audience ------------------
      const requests = await db.listRequests();
      const usedIds = requests.map((r) => r.feedbackId).filter(Boolean);
      let stamped = 0;
      for (const request of requests) {
        const patch = {};
        if (!request.feedbackId) {
          patch.feedbackId = nextFeedbackId(usedIds, request.createdAt);
          usedIds.push(patch.feedbackId);
        }
        if (!Array.isArray(request.assignedUsernames)) patch.assignedUsernames = [];
        if (!request.eventName) patch.eventName = request.title || '';
        if (Object.keys(patch).length) {
          await db.saveRequest({ ...request, ...patch });
          stamped++;
        }
      }
      if (stamped) report(`Stamped ${stamped} feedback requests with an ID`);

      // --- 4. Build the roll-up indexes -------------------------------------
      const result = await db.rebuildIndexes();
      report(`Indexed ${result.responses} responses across ${result.requests} forms`);

      // --- 5. Backfill receipts from attributed responses -------------------
      // Anonymous responses cannot produce a receipt — by design, there is
      // nothing in them to attribute. Those students show as outstanding until
      // they submit again, which is the honest reading of the data.
      let receipts = 0;
      let anonymous = 0;
      for (const request of await db.listRequests()) {
        const rows = await db.listResponses(request.id);
        for (const response of rows) {
          const username = response.respondent?.username;
          if (!username) { if (response.anonymous) anonymous++; continue; }
          if (await db.hasSubmitted(request.id, username)) continue;
          await db.addReceipt(request.id, username);
          receipts++;
        }
      }
      if (receipts) report(`Created ${receipts} submission receipts from named responses`);
      if (anonymous) {
        report(`${anonymous} anonymous responses could not be receipted (expected — they carry no name)`);
      }
    },
  },

  {
    to: 3,
    describe: 'Receipts split into one file per cadet',
    async run({ db, report }) {
      // v2 kept every receipt for a form in a single array. A whole flight
      // submitting at once meant concurrent read-modify-writes on that one
      // document, and a dropped receipt let a cadet submit twice while showing
      // as outstanding — a loss nothing could rebuild, because an anonymous
      // response carries no name. One file per student removes the shared
      // document, so the race cannot happen.
      let moved = 0;
      let forms = 0;

      for (const request of await db.listRequests()) {
        const legacyPath = INDEXES.legacyReceiptsFor(request.id);
        const legacy = await db.readRaw(legacyPath);
        if (!legacy?.receipts?.length) continue;

        forms++;
        for (const row of legacy.receipts) {
          const username = String(row.username || '').trim().toLowerCase();
          if (!username || username.startsWith('_')) continue;
          await db.writeRaw(INDEXES.receiptFor(request.id, username), {
            schemaVersion: APP.schemaVersion,
            requestId: request.id,
            username,
            submittedAt: row.submittedAt || nowIso(),
            migratedFromIndex: true,
          });
          moved++;
        }
        // The old array is left in place on purpose: it costs nothing, and a
        // device still running v2 keeps working against the same folder until
        // everyone has updated.
      }

      if (moved) report(`Split ${moved} receipts across ${forms} forms into individual files`);
      else report('No legacy receipt arrays to split');
    },
  },

  {
    to: 4,
    describe: 'Google accounts replace app passwords',
    async run({ db, report }) {
      // The app no longer issues or checks credentials — a roster entry's email
      // is matched against a verified Google ID token instead. Two things follow.
      //
      // First, every stored password hash is deleted. They are worthless now,
      // and a hash sitting in a shared Drive folder is a liability with no
      // upside: people reuse passwords, so a leaked hash from this app is a
      // guess at someone's other accounts.
      //
      // Second, an account with no email can no longer sign in — there is
      // nothing for a token to match. Those are flagged rather than deleted or
      // deactivated: the record still carries a name, an AS level and the username
      // its receipts are filed under, all of which an admin needs in order to
      // fix it by adding the address. `needsEmail` marks them, and is read back
      // on a re-run so a second pass does not count the same record twice —
      // these migrations must be idempotent. The admin console does not use it:
      // it finds these accounts by the absence of an email, which cannot go
      // stale the way a flag can.
      const users = (await db.getUsers().catch(() => null))?.users || [];
      if (!users.length) return report('No accounts to convert');

      let stripped = 0;
      let flagged = 0;
      const next = users.map((account) => {
        const copy = { ...account };
        if (copy.password !== undefined || copy.needsPassword !== undefined
            || copy.passwordUpdatedAt !== undefined) {
          delete copy.password;
          delete copy.needsPassword;
          delete copy.passwordUpdatedAt;
          stripped++;
        }
        copy.email = normalizeEmail(copy.email);
        if (!copy.email) {
          if (!copy.needsEmail) flagged++;
          copy.needsEmail = true;
        } else {
          delete copy.needsEmail;
        }
        return copy;
      });

      await db.saveUsers(next);
      report(`Deleted stored passwords from ${stripped} accounts`);
      if (flagged) {
        report(`${flagged} accounts have no email address and cannot sign in until an admin adds one`);
      }
    },
  },
];

/** Local copy of auth.js's normaliser — migrations must not import app logic. */
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Brings a folder up to `APP.schemaVersion`.
 *
 * @returns {Promise<{from: number, to: number, ran: string[], notes: string[]}>}
 */
export async function runMigrations(db, { onProgress = null } = {}) {
  const org = (await db.getOrg()) || {};
  const from = Number(org.schemaVersion) || 1;
  const to = APP.schemaVersion;
  const ran = [];
  const notes = [];

  if (from > to) {
    throw new Error(
      `This folder was written by a newer version of ${APP.name} (schema v${from}, this build expects v${to}). `
      + 'Update the app rather than downgrading the data.');
  }
  if (from === to) return { from, to, ran, notes };

  const report = (message) => {
    notes.push(message);
    onProgress?.(message);
  };

  for (const migration of MIGRATIONS.filter((m) => m.to > from && m.to <= to)
    .sort((a, b) => a.to - b.to)) {
    onProgress?.(`Running: ${migration.describe}`);
    await migration.run({ db, report });
    ran.push(`v${migration.to} — ${migration.describe}`);
  }

  await db.saveOrg({ schemaVersion: to, migratedAt: nowIso() });
  return { from, to, ran, notes };
}

/** The version a folder is currently at, without changing anything. */
export async function pendingMigrations(db) {
  const org = (await db.getOrg()) || {};
  const from = Number(org.schemaVersion) || 1;
  return {
    from,
    to: APP.schemaVersion,
    pending: MIGRATIONS.filter((m) => m.to > from && m.to <= APP.schemaVersion)
      .map((m) => `v${m.to} — ${m.describe}`),
  };
}

/* ------------------------------------------------------------------ *
 * helpers — local copies so migrations never drift with live app code
 * ------------------------------------------------------------------ */

function uniqueUsername(name, taken) {
  const parts = String(name || '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
  const last = parts.length > 1 ? parts[0] : (parts[0] || 'cadet');
  const first = parts.length > 1 ? parts[1] : '';
  let base = `${last}${first ? `.${first}` : ''}`.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (base.length < 3) base = `${base}user`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 999; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
  return `${base}${Date.now().toString(36)}`;
}

function nextFeedbackId(existing, createdAt) {
  const year = createdAt ? new Date(createdAt).getFullYear() : new Date().getFullYear();
  const prefix = `FB-${year}-`;
  const highest = existing
    .filter((id) => typeof id === 'string' && id.startsWith(prefix))
    .map((id) => Number.parseInt(id.slice(prefix.length), 10))
    .filter(Number.isFinite)
    .reduce((max, n) => Math.max(max, n), 0);
  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
}
