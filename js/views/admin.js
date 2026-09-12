/**
 * Database Administration — account maintenance for one organization.
 *
 * The roster lives in the organization's own Drive folder, so a detachment owns
 * its user base the same way it owns its feedback. Everyone signs in with their
 * Google account; this app issues no passwords and stores no credentials, so
 * administration is adding and removing email addresses.
 *
 * A folder with an empty roster is claimed by the first Google account to sign
 * in, so a detachment can never lock itself out. If every admin is ever lost,
 * `users/users.json` can be edited directly in Drive by anyone with access.
 */

import {
  el, icon, field, select, notice, toast, spinner, badge, modal, confirmDialog,
  emptyState, download, toCsv, pickFile, readFileAsText, pluralize, fmtDate,
  fmtDateTime, mount, remount } from '../util.js';
import {
  APP, AS_CLASSES, BACKENDS, ROLES, ROLE_LABELS, AS_PROGRESSION, MAX_COMMANDERS,
  currentSchoolYear,
} from '../config.js';
import { AUDIT, AUDIT_LABELS } from '../audit.js';
import {
  createAccount, updateAccount, deleteAccount, signOut, currentUser, hasRole, normalizeEmail,
} from '../auth.js';
import { renderLogin } from './sign-in.js';
import { buildJoinLink, joinMailto } from '../join.js';
import {
  loadRoster, loadAudit, applyRollover, writeAudit, canDoMaintenance,
} from '../data-source.js';
import { connection } from '../state.js';
import { db } from '../storage/index.js';
import { navigate } from '../router.js';

export async function renderAdmin(root, { query }) {
  // No bootstrap gate is needed: an empty roster is claimed by the first Google
  // account that signs in, and after that the roster itself is the gate.
  if (!hasRole(ROLES.admin)) {
    return renderLogin(root, ROLES.admin, 'Database Administration',
      () => renderAdmin(root, { query }));
  }
  return renderConsole(root);
}

/* ------------------------------------------------------------------ *
 * console
 * ------------------------------------------------------------------ */

async function renderConsole(root) {
  remount(root, spinner('Loading accounts…'));
  let accounts = await loadRoster();

  const table = el('div', {});
  const state = { role: '', search: '' };

  const reload = async () => { accounts = await loadRoster(); paint(); };

  async function editAccount(existing = null, defaults = {}) {
    const isNew = !existing;
    const name = el('input', { class: 'input', type: 'text', value: existing?.name || '' });
    const emailInput = el('input', {
      class: 'input mono', type: 'email', value: existing?.email || '',
      placeholder: 'name@school.edu or name@gmail.com',
      autocapitalize: 'off', spellcheck: 'false',
    });
    const asClass = select([{ value: '', label: '—' }, ...AS_CLASSES.map((c) => ({ value: c.code, label: c.label }))],
      { value: existing?.asClass || '' });
    const section = el('input', { class: 'input', type: 'text', value: existing?.section || '' });

    const roleBoxes = Object.values(ROLES).map((role) => {
      const input = el('input', {
        type: 'checkbox', value: role,
        checked: existing
          ? existing.roles?.includes(role)
          : (defaults.roles ? defaults.roles.includes(role) : role === ROLES.student),

      });
      return { role, input, node: el('label', { class: 'check' }, input,
        el('span', {},
          el('span', { class: 'check__text' }, ROLE_LABELS[role]),
          el('span', { class: 'check__desc', style: { display: 'block' } }, ROLE_HINTS[role]))) };
    });

    const activeBox = el('input', { type: 'checkbox', checked: existing ? existing.active !== false : true });

    const result = await modal({
      title: isNew ? 'Add someone to the roster' : `Edit ${existing.name}`,
      body: el('div', { class: 'stack' },
        field('Name', name, { required: true }),
        field('Google account email', emailInput, {
          required: true,
          hint: 'This is how they sign in. Use the account your detachment already mails them at — '
            + 'for most cadets that is their Gmail address, whatever their school address says.',
        }),
        el('div', {}, el('div', { class: 'field__label' }, 'Roles'),
          el('div', { class: 'stack-sm' }, ...roleBoxes.map((r) => r.node))),
        el('div', { class: 'filters' }, field('AS level', asClass), field('Section / flight', section)),
        el('label', { class: 'check' }, activeBox,
          el('span', { class: 'check__text' }, 'Active')),
        !isNew ? el('p', { class: 'field__hint' },
          `Internal username: ${existing.username} — used to file their submission receipts, and left alone `
          + 'when the email changes.') : null),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', variant: 'primary' }],
    });
    if (result !== 'save') return;

    const roles = roleBoxes.filter((r) => r.input.checked).map((r) => r.role);
    if (!roles.length) return toast('Pick at least one role.', 'warn');

    // The server enforces this under a lock and is the authority; checking here
    // just means the refusal arrives before the round trip, naming who already
    // holds it rather than saying no.
    if (roles.includes(ROLES.commander)) {
      const holders = accounts.filter((a) => a.id !== existing?.id
        && a.active !== false && a.roles?.includes(ROLES.commander));
      if (holders.length >= MAX_COMMANDERS) {
        return toast(
          `Only ${MAX_COMMANDERS} commanders at once. ${holders.map((a) => a.name).join(' and ')} `
          + 'hold it — remove one first, so a handover overlaps rather than a third appearing.',
          'warn', 9000);
      }
    }

    try {
      if (isNew) {
        await createAccount({
          email: emailInput.value,
          name: name.value,
          roles,
          asClass: asClass.value,
          section: section.value.trim(),
        });
        toast('Added to the roster.', 'ok');
      } else {
        const wouldOrphan = existing.roles?.includes(ROLES.admin) && !roles.includes(ROLES.admin)
          && accounts.filter((a) => a.roles?.includes(ROLES.admin) && a.active !== false).length <= 1;
        if (wouldOrphan) return toast('That is the only admin account — give another account admin first.', 'warn', 6000);

        await updateAccount(existing.id, {
          name: name.value,
          email: emailInput.value,
          roles,
          asClass: asClass.value,
          section: section.value.trim(),
          active: activeBox.checked,
        });
        toast('Account updated.', 'ok');
      }
      return reload();
    } catch (err) {
      return toast(err.message, 'danger', 7000);
    }
  }

  /**
   * Bulk roster import.
   *
   * Needs a `name` and an `email` column — the same list the det already uses to
   * mail cadets. No passwords are generated or handed out, because there are
   * none: being on this list is what grants access.
   *
   * `roles`, `class`, `section` and `username` are optional, and are the other
   * four columns Export CSV writes. They used to be ignored while Export wrote
   * them, so exporting a roster, editing it in a spreadsheet and importing it
   * back turned every instructor, cadre member and commander into a cadet
   * without saying so. A file that states what somebody is has to be read as
   * stating it, or the export is a trap rather than a backup.
   *
   * A row naming something invalid is skipped and reported rather than silently
   * downgraded — a silent downgrade is the whole failure being fixed here.
   */
  async function importCsv() {
    const file = await pickFile('.csv,text/csv');
    if (!file) return undefined;
    try {
      const rows = parseCsv(await readFileAsText(file));
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const col = (...names) => header.findIndex((h) => names.includes(h));
      const nameCol = col('name', 'student', 'full name');
      const emailCol = col('email', 'google account', 'address');
      if (nameCol < 0) throw new Error('No "name" column found.');
      if (emailCol < 0) throw new Error('No "email" column found.');
      const classCol = col('class', 'as class', 'asclass', 'as level');
      const rolesCol = col('roles', 'role');
      const sectionCol = col('section', 'flight');
      const usernameCol = col('username', 'user name');

      const cell = (row, index) => (index >= 0 ? (row[index] || '').trim() : '');
      const classCodes = new Map(AS_CLASSES.map((c) => [c.code.toLowerCase(), c.code]));
      const roleNames = new Set(Object.values(ROLES));

      // Counted across the whole file rather than per row: three commanders on
      // three separate rows is still three commanders. The proxy enforces this
      // under a lock and is the authority, but direct mode has no such check, so
      // without this the cap would hold only for detachments running a server.
      let commanders = accounts.filter(
        (a) => a.active !== false && a.roles?.includes(ROLES.commander)).length;

      let added = 0;
      const skipped = [];
      for (const row of rows.slice(1)) {
        const personName = cell(row, nameCol);
        const address = normalizeEmail(cell(row, emailCol));
        if (!personName && !address) continue;
        const who = address || personName;
        try {
          // Split on spaces as well as commas: Export CSV joins roles with a
          // space, so its own output has to parse without being quoted.
          const wanted = cell(row, rolesCol).split(/[\s,;]+/).filter(Boolean)
            .map((r) => r.toLowerCase());
          const unknown = wanted.filter((r) => !roleNames.has(r));
          if (unknown.length) {
            throw new Error(`unknown role "${unknown[0]}" — use ${[...roleNames].join(', ')}`);
          }
          // An empty roles column still means cadet, so a det with a plain
          // name/email list gets what it used to get.
          const roles = wanted.length ? [...new Set(wanted)] : [ROLES.student];
          if (roles.includes(ROLES.commander) && commanders >= MAX_COMMANDERS) {
            throw new Error(`only ${MAX_COMMANDERS} commanders at once, and this would be one more`);
          }

          const rawClass = cell(row, classCol);
          if (rawClass && !classCodes.has(rawClass.toLowerCase())) {
            throw new Error(`unknown class "${rawClass}" — use `
              + `${AS_CLASSES.map((c) => c.code).join(', ')}`);
          }

          await createAccount({
            email: address,
            name: personName,
            roles,
            asClass: rawClass ? classCodes.get(rawClass.toLowerCase()) : '',
            section: cell(row, sectionCol),
            username: cell(row, usernameCol),
          });
          added++;
          if (roles.includes(ROLES.commander)) commanders++;
        } catch (err) {
          skipped.push(`${who}: ${err.message}`);
        }
      }

      if (!added && !skipped.length) return toast('That file had no rows.', 'warn');
      if (skipped.length) {
        await modal({
          title: `Added ${pluralize(added, 'person', 'people')}, skipped ${skipped.length}`,
          body: el('div', { class: 'stack' },
            notice('warn', 'Some rows could not be added',
              el('p', {}, 'Usually a duplicate email or a typo. Fix the file and import again — '
                + 'rows already added are skipped rather than duplicated.')),
            el('div', { class: 'table-wrap', style: { maxHeight: '16rem', overflowY: 'auto' } },
              el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, el('th', {}, 'Row'), el('th', {}, 'Reason'))),
                el('tbody', {}, ...skipped.map((line) => {
                  const [who, ...rest] = line.split(': ');
                  return el('tr', {}, el('td', { class: 'mono' }, who), el('td', {}, rest.join(': ')));
                }))))),
          actions: [{ label: 'Close', value: true, autofocus: true }],
        });
      } else {
        toast(`Added ${pluralize(added, 'person', 'people')} to the roster.`, 'ok', 6000);
      }
      return reload();
    } catch (err) {
      return toast(`Import failed: ${err.message}`, 'danger', 8000);
    }
  }

  function paint() {
    const visible = accounts
      .filter((a) => !state.role || a.roles?.includes(state.role))
      .filter((a) => !state.search
        || `${a.name} ${a.email || ''} ${a.username}`.toLowerCase().includes(state.search.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!visible.length) {
      remount(table, emptyState({
        iconName: 'users',
        title: accounts.length ? 'No accounts match' : 'No accounts yet',
        message: accounts.length ? 'Try a different filter.' : 'Add one, or import a roster CSV.',
        action: el('button', { type: 'button', class: 'btn btn--primary', onclick: () => editAccount() },
          icon('plus'), 'Add person'),
      }));
      return;
    }

    const body = el('tbody');
    for (const account of visible) {
      mount(body, el('tr', {},
        el('td', {}, el('div', { style: { fontWeight: '550' } }, account.name),
          el('div', { class: 'mono faint' }, account.email || '— no email —')),
        el('td', {}, el('div', { class: 'row row--wrap' },
          ...(account.roles || []).map((r) => badge(ROLE_LABELS[r] || r,
            r === ROLES.admin ? 'danger' : r === ROLES.instructor ? 'info' : 'neutral')))),
        el('td', {}, account.asClass || '—'),
        el('td', {}, account.active === false
          ? badge('Inactive', 'neutral')
          : !account.email
            ? badge('No email', 'warn', 'alert')
            : badge('Active', 'ok', 'check')),
        el('td', { class: 'faint nowrap' }, fmtDate(account.createdAt)),
        el('td', { class: 'num' }, el('div', { class: 'row row--end' },

          el('button', { type: 'button', class: 'btn btn--sm btn--ghost', title: 'Edit', onclick: () => editAccount(account) },
            icon('edit')),
          el('button', {
            type: 'button', class: 'btn btn--sm btn--ghost', title: 'Delete',
            onclick: async () => {
              const admins = accounts.filter((a) => a.roles?.includes(ROLES.admin) && a.active !== false);
              if (account.roles?.includes(ROLES.admin) && admins.length <= 1) {
                return toast('You cannot delete the only admin account.', 'warn', 6000);
              }
              if (!(await confirmDialog('Delete this account?',
                `${account.name} (${account.email || account.username}) will be removed from the `
                + 'roster and can no longer sign in.\n\n'
                + 'Their feedback is kept, but their name is permanently stripped from it — '
                + 'every response they wrote becomes anonymous, and their submission receipts '
                + 'stop identifying them. Completion counts still add up. This cannot be undone, '
                + 'and it is not undone by restoring a backup taken afterwards.',
                { confirmLabel: 'Delete', danger: true }))) return undefined;
              await deleteAccount(account.id);
              toast('Account deleted.', 'ok');
              return reload();
            },
          }, icon('trash'))))));
    }

    remount(table, el('div', { class: 'table-wrap' },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Account'), el('th', {}, 'Roles'), el('th', {}, 'AS level'),
          el('th', {}, 'Status'), el('th', {}, 'Created'), el('th', { class: 'num' }, ''))),
        body)));
  }

  const session = currentUser();

  remount(root, 
    el('div', { class: 'page-head row row--between row--wrap' },
      el('div', {},
        el('h1', { class: 'page-title' }, 'Database Administration'),
        el('p', { class: 'page-sub' }, session
          ? `Signed in as ${session.name} (${session.email || session.username})`
          : 'Development mode — no sign-in required')),
      el('div', { class: 'row row--wrap' },
        session && el('button', {
          type: 'button', class: 'btn btn--sm',
          onclick: () => { signOut(); toast('Signed out.', 'ok'); navigate('/home'); },
        }, icon('lock'), 'Sign out'))),

    accounts.filter((a) => a.roles?.includes(ROLES.admin) && a.active !== false).length === 1
      && notice('warn', 'You are the only administrator',
        el('p', {}, 'If this account loses access to the Drive folder, nobody can manage the roster '
          + 'from inside the app — it would have to be repaired by editing ',
          el('code', { class: 'mono' }, 'users/users.json'),
          ' in Drive directly. Give a second person admin.')),

    (() => {
      // Left by the v4 migration: accounts that predate Google sign-in and have
      // no address to match a token against. They are harmless — nobody can sign
      // in as them — but they are also invisible until someone says so.
      const stranded = accounts.filter((a) => !a.email && a.active !== false);
      return stranded.length ? notice('warn',
        `${pluralize(stranded.length, 'account')} cannot sign in yet`,
        el('p', {}, 'These were carried over from before Google sign-in and have no email address, '
          + 'so there is nothing for a sign-in to match. Edit each one and add the Google account '
          + 'your detachment mails them at:'),
        el('p', { class: 'mono' }, stranded.slice(0, 12).map((a) => a.name).join(', ')
          + (stranded.length > 12 ? `, and ${stranded.length - 12} more` : ''))) : null;
    })(),

    el('section', { class: 'card stack' },
      el('div', { class: 'row row--between row--wrap' },
        el('h2', { class: 'section-title', style: { margin: '0' } }, 'Account maintenance'),
        el('div', { class: 'row row--wrap' },
          el('button', { type: 'button', class: 'btn btn--sm', onclick: importCsv }, icon('upload'), 'Import roster CSV'),
          el('button', {
            type: 'button', class: 'btn btn--sm',
            onclick: () => download('roster.csv', toCsv(accounts, [
              { key: 'name', label: 'name' }, { key: 'email', label: 'email' },
              { key: 'roles', label: 'roles', get: (a) => (a.roles || []).join(' ') },
              { key: 'asClass', label: 'class' }, { key: 'section', label: 'section' },
              { key: 'username', label: 'username' },
            ]), 'text/csv'),
          }, icon('download'), 'Export CSV'),
          el('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => editAccount() },
            icon('plus'), 'Add person'))),

      el('div', { class: 'filters' },
        field('Role', select([
          { value: '', label: 'All roles' },
          ...Object.values(ROLES).map((r) => ({ value: r, label: ROLE_LABELS[r] })),
        ], { onchange: (e) => { state.role = e.target.value; paint(); } })),
        field('Search', el('input', {
          class: 'input', type: 'search', placeholder: 'Name or email…',
          oninput: (e) => { state.search = e.target.value; paint(); },
        }))),

      table),

    inviteCard(),
    rolloverCard(reload),
    await auditCard(),
    canDoMaintenance() ? await schemaCard() : null,

    canDoMaintenance() ? el('section', { class: 'card stack', style: { marginTop: 'var(--sp-5)' } },
      el('h2', { class: 'section-title' }, 'Database maintenance'),
      el('p', { class: 'muted' },
        'Roll-up indexes make the app fast by avoiding a read per response. '
        + 'Rebuild them if counts ever look wrong after a restore.'),
      el('div', { class: 'row row--wrap' },
        el('button', {
          type: 'button', class: 'btn',
          onclick: async () => {
            const busy = toast('Rebuilding indexes…', 'info', 30000);
            try {
              const result = await db.rebuildIndexes();
              await writeAudit({
                action: AUDIT.indexesRebuilt,
                summary: `Rebuilt indexes for ${pluralize(result.requests, 'form')}`,
                detail: { responses: result.responses },
              });
              busy.remove();
              toast(`Rebuilt ${pluralize(result.requests, 'request')} · ${pluralize(result.responses, 'response')}.`, 'ok', 6000);
            } catch (err) {
              busy.remove();
              toast(err.message, 'danger', 8000);
            }
          },
        }, icon('refresh'), 'Rebuild indexes'),
        el('button', { type: 'button', class: 'btn', onclick: () => navigate('/instructor?tab=database') },
          icon('database'), 'Backup and restore'))) : null,
  );

  paint();
}

/**
 * Annual rollover.
 *
 * Every August a detachment's AS100s become AS200s and the AS400s commission
 * out. Done by hand across 150 accounts it is a morning's work that somebody
 * eventually skips, and once the levels are stale every class filter and every
 * cohort comparison is quietly wrong for a year.
 *
 * Graduating cadets are *deactivated, never deleted* — their submitted feedback
 * stays part of the record, and the account can be reactivated if someone
 * returns.
 */
/**
 * The join link, and the ways an admin hands it out.
 *
 * Lives here because giving someone access and putting them on the roster are
 * the same act from an administrator's point of view — you add an email, then
 * you send them the link. Splitting those across two screens would guarantee
 * that half the roster never gets told how to get in.
 */
function inviteCard() {
  const conn = connection.get();
  const host = el('div', { class: 'stack' });

  const card = el('section', { class: 'card stack' },
    el('h2', { class: 'section-title', style: { margin: '0' } }, 'Invite people'),
    host);

  // A join link points at a Drive folder. The local and folder backends are
  // device-local by definition, so there is nothing another device could join.
  if (conn.backend !== BACKENDS.drive) {
    mount(host, notice('info', 'Join links need Google Drive storage',
      el('p', {}, 'This installation stores its records ',
        conn.backend === BACKENDS.local ? 'in this browser' : 'in a folder on this computer',
        ', which no other device can reach. Switch to Google Drive in Settings to invite people.')));
    return card;
  }

  let link;
  try {
    link = buildJoinLink({
      clientId: conn.clientId,
      folderId: conn.folderId,
      orgName: conn.orgName,
      proxyUrl: conn.proxyUrl,
    });
  } catch (err) {
    mount(host, notice('warn', 'No join link yet', el('p', {}, err.message)));
    return card;
  }

  const linkBox = el('input', {
    class: 'input mono', type: 'text', readonly: true, value: link,
    onclick: (e) => e.target.select(),
  });

  const copyBtn = el('button', {
    type: 'button', class: 'btn btn--primary',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(link);
        toast('Join link copied.', 'ok');
      } catch {
        // Clipboard access is refused in some embedded and insecure contexts;
        // selecting the text is something the admin can still act on.
        linkBox.select();
        toast('Press Cmd-C or Ctrl-C to copy.', 'info', 6000);
      }
    },
  }, icon('copy'), 'Copy link');

  const shareBtn = navigator.share
    ? el('button', {
      type: 'button', class: 'btn',
      onclick: async () => {
        try {
          await navigator.share({
            title: `${APP.name} — join ${conn.orgName || 'the detachment'}`,
            text: 'Open this to set up feedback on your phone.',
            url: link,
          });
        } catch { /* the share sheet was dismissed */ }
      },
    }, icon('send'), 'Share')
    : null;

  mount(host,
    el('p', { class: 'muted', style: { margin: '0' } },
      'Send this to anyone on the roster. It sets up their device for them — no Client ID, '
      + 'no folder link, nothing to type. They sign in with Google and land on their feedback.'),

    field('Join link', linkBox),

    el('div', { class: 'row row--wrap' },
      copyBtn,
      shareBtn,
      el('a', {
        class: 'btn',
        href: joinMailto({ link, orgName: conn.orgName, appName: APP.name }),
      }, icon('mail'), 'Email it'),
      el('button', {
        type: 'button', class: 'btn',
        onclick: () => navigate('/admin/invite'),
      }, icon('qr'), 'Show QR code')),

    notice('info', 'The link is not a password',
      el('p', {}, 'Everything in it is public or an address: the Client ID ships in the page '
        + 'source, and the folder ID is not a key. Opening the link grants nothing on its own — '
        + 'the roster decides who may sign in, and an unknown address is turned away. It is safe '
        + 'to post wherever your detachment already talks.')));

  return card;
}

/**
 * Whether this school year has already been advanced, and by whom.
 *
 * The rollover is irreversible and the preview cannot tell you it has run: it
 * recomputes from whatever the roster says now, so the morning after a rollover
 * it offers a fresh, entirely plausible set of moves. Nothing on the screen
 * distinguished "not yet run" from "already run", which does not merely permit a
 * second run — it invites one, and a second run advances the whole detachment
 * another year.
 *
 * Nothing new is recorded to detect it. `apply` below has always written a
 * `roster.rollover` audit entry stamped with the school year; it was simply never
 * read back.
 *
 * Twelve months rather than the default six: a re-run in May belongs to the same
 * school year as a rollover the previous July, and that late case is the
 * dangerous one — the six-month window would have missed it.
 *
 * This is a mistake-guard and not a boundary, which is why it lives here and not
 * in the proxy. Rollover already requires an administrator, and an administrator
 * can edit every AS level by hand, so a server-side check would prevent nothing
 * a determined caller could not do another way. Contrast `enforceAdminFloor` in
 * tools/proxy/Code.gs, which is server-side because losing every administrator
 * cannot be undone from inside the app at all.
 */
async function priorRolloverThisYear() {
  const year = currentSchoolYear();
  try {
    const entries = await loadAudit(12);
    return entries.find((entry) => entry.action === AUDIT.rolloverApplied
      && entry.detail?.schoolYear === year) || null;
  } catch {
    // A broken or unreadable audit must not stop a legitimate rollover. Falling
    // through unguarded is the lesser failure: the confirm dialog still says
    // there is no undo.
    return null;
  }
}

function rolloverCard(reload) {
  const host = el('div', {});

  const preview = async () => {
    const accounts = await loadRoster();
    const students = accounts.filter((a) => a.roles?.includes(ROLES.student) && a.active !== false);
    const moves = new Map();
    for (const student of students) {
      const from = student.asClass || '—';
      if (!(from in AS_PROGRESSION)) continue;   // Field Training, cadre: untouched
      const to = AS_PROGRESSION[from];
      const key = `${from}->${to ?? 'graduating'}`;
      if (!moves.has(key)) moves.set(key, { from, to, people: [] });
      moves.get(key).people.push(student);
    }
    const untouched = students.filter((s) => !((s.asClass || '') in AS_PROGRESSION));
    return { moves: [...moves.values()].sort((a, b) => a.from.localeCompare(b.from)), untouched, students };
  };

  const draw = async () => {
    const [{ moves, untouched, students }, prior] = await Promise.all([
      preview(), priorRolloverThisYear(),
    ]);
    remount(host);

    if (prior) {
      mount(host, notice('warn', `Already advanced for ${currentSchoolYear()}`,
        el('p', {}, `${prior.actor?.username || 'Someone'} ran this on `
          + `${fmtDateTime(prior.at)}. ${prior.summary || ''}`),
        el('p', {}, 'Running it again moves every cadet up a second level — an AS100 '
          + 'would become AS300 — and there is no undo. If you are unsure whether the '
          + 'first run worked, check the levels in the roster above rather than running '
          + 'it again.')));
    }

    if (!students.length) {
      mount(host, el('p', { class: 'muted' }, 'No active cadet accounts to advance.'));
      return;
    }
    if (!moves.length) {
      mount(host, el('p', { class: 'muted' },
        'No accounts sit on the AS100–AS400 ladder, so there is nothing to advance.'));
      return;
    }

    const deactivateBox = el('input', { type: 'checkbox', checked: true });
    const body = el('tbody');
    for (const move of moves) {
      mount(body, el('tr', {},
        el('td', {}, move.from),
        el('td', {}, move.to || el('span', {}, 'Graduating')),
        el('td', { class: 'num' }, String(move.people.length))));
    }

    mount(host,
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Currently'), el('th', {}, 'Becomes'), el('th', { class: 'num' }, 'Cadets'))),
          body)),
      untouched.length
        ? el('p', { class: 'field__hint' },
          `${pluralize(untouched.length, 'account')} left unchanged — not on the AS100–AS400 ladder.`)
        : null,
      el('label', { class: 'check' }, deactivateBox,
        el('span', {},
          el('span', { class: 'check__text' }, 'Deactivate graduating cadets'),
          el('span', { class: 'check__desc', style: { display: 'block' } },
            'Their feedback is kept and the account can be reactivated. Never deleted.'))),
      el('div', { class: 'row row--wrap' },
        el('button', {
          type: 'button', class: 'btn btn--primary',
          onclick: () => apply(moves, deactivateBox.checked, prior),
        }, icon('refresh'), 'Advance the academic year')));
  };

  const apply = async (moves, deactivate, prior = null) => {
    const total = moves.reduce((n, m) => n + m.people.length, 0);
    const graduating = moves.filter((m) => m.to === null).reduce((n, m) => n + m.people.length, 0);

    // A second run is warned about, not refused. There is a legitimate one: a
    // detachment that rolled over, then restored a backup taken before it, has
    // to roll over again in the same year — and refusing would leave them
    // re-levelling the whole roster by hand.
    if (prior) {
      const again = await confirmDialog(`Advance ${currentSchoolYear()} a second time?`,
        `This year was already advanced on ${fmtDateTime(prior.at)}`
        + `${prior.actor?.username ? ` by ${prior.actor.username}` : ''}. Doing it again `
        + 'moves every cadet up another level, and cannot be undone.\n\n'
        + 'Only continue if you know the first run was reversed — by restoring a backup, '
        + 'say. Otherwise cancel and check the roster.',
        { confirmLabel: 'I know it was reversed — advance again', danger: true });
      if (!again) return;
    }

    const confirmed = await confirmDialog('Advance the academic year?',
      `${pluralize(total, 'cadet')} will move up a level`
      + (graduating ? `, and ${pluralize(graduating, 'graduating cadet')} will be `
        + `${deactivate ? 'deactivated' : 'left active at AS400'}.` : '.')
      + ' This is recorded in the audit trail. There is no undo, though levels can be edited back by hand.',
      { confirmLabel: 'Advance', danger: true });
    if (!confirmed) return;

    const busy = toast('Advancing…', 'info', 60000);
    let moved = 0;
    let retired = 0;
    try {
      // One call rather than one per cadet: through the proxy that is fifty
      // round trips saved, and the whole roster moves under a single lock
      // instead of fifty chances to be interrupted half way.
      const map = {};
      for (const move of moves) {
        map[move.from] = move.to;
        if (move.to === null) { if (deactivate) retired += move.people.length; }
        else moved += move.people.length;
      }
      await applyRollover(map, deactivate);

      await writeAudit({
        action: AUDIT.rolloverApplied,
        summary: `Advanced ${pluralize(moved, 'cadet')}`
          + (retired ? `, deactivated ${pluralize(retired, 'graduating cadet')}` : ''),
        detail: { schoolYear: currentSchoolYear(), moved, retired },
      });
      busy.remove();
      toast(`Advanced ${pluralize(moved, 'cadet')}${retired ? `, ${retired} deactivated` : ''}.`,
        'ok', 6000);
      reload();
      draw();
    } catch (err) {
      busy.remove();
      toast(`Rollover stopped: ${err.message}`, 'danger', 9000);
      draw();
    }
  };

  const card = el('section', { class: 'card stack', style: { marginTop: 'var(--sp-5)' } },
    el('h2', { class: 'section-title' }, 'Academic year rollover'),
    el('p', { class: 'muted' },
      `Moves every cadet up one AS level for ${currentSchoolYear()}. Run it once, at the start of `
      + 'the year. Individual accounts can still be corrected by hand afterwards.'),
    host);
  draw();
  return card;
}

/**
 * Recent activity. Read-only by construction — there is no delete in the audit
 * module, so nothing in this app removes an entry.
 */
async function auditCard() {
  const host = el('div', {}, spinner('Loading activity…'));
  const card = el('section', { class: 'card stack', style: { marginTop: 'var(--sp-5)' } },
    el('div', { class: 'row row--between row--wrap' },
      el('h2', { class: 'section-title', style: { margin: '0' } }, 'Activity log'),
      el('button', {
        type: 'button', class: 'btn btn--sm',
        onclick: async () => {
          const rows = (await loadAudit(24)).slice(0, 5000);
          download(`activity-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, [
            { key: 'at', label: 'When' },
            { key: 'who', label: 'Who', get: (r) => r.actor?.username || '' },
            { key: 'action', label: 'Action', get: (r) => AUDIT_LABELS[r.action] || r.action },
            { key: 'summary', label: 'Detail' },
            { key: 'target', label: 'Target' },
            { key: 'reason', label: 'Reason' },
          ]), 'text/csv');
        },
      }, icon('download'), 'Export')),
    el('p', { class: 'muted' },
      'Every deletion, roster change and rollover, with who did it. Nothing in this app '
      + 'removes an entry.'),
    host);

  loadAudit(6).then((all) => {
    const rows = all.slice(0, 60);
    if (!rows.length) {
      remount(host, el('p', { class: 'muted' }, 'No recorded activity yet.'));
      return;
    }
    const body = el('tbody');
    for (const row of rows) {
      mount(body, el('tr', {},
        el('td', { class: 'faint nowrap' }, fmtDateTime(row.at)),
        el('td', { class: 'mono' }, row.actor?.username || '—'),
        el('td', {}, row.severe
          ? badge(AUDIT_LABELS[row.action] || row.action, 'danger', 'alert')
          : (AUDIT_LABELS[row.action] || row.action)),
        el('td', {}, row.summary,
          row.reason ? el('div', { class: 'field__hint' }, `Reason: ${row.reason}`) : null)));
    }
    remount(host, el('div', { class: 'table-wrap', style: { maxHeight: '26rem', overflowY: 'auto' } },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'When'), el('th', {}, 'Who'), el('th', {}, 'Action'), el('th', {}, 'Detail'))),
        body)));
  }).catch((err) => {
    remount(host, notice('danger', 'Could not read the activity log', el('p', {}, err.message)));
  });

  return card;
}

/**
 * Schema panel. Migrations normally run automatically on startup; this shows
 * what version the folder is at and lets an admin re-run them after restoring
 * a backup written by an older release.
 */
async function schemaCard() {
  let status;
  try {
    status = await db.migrationStatus();
  } catch (err) {
    return notice('danger', 'Could not read the schema version', el('p', {}, err.message));
  }

  const log = el('div', {});
  const runBtn = el('button', {
    type: 'button', class: status.pending.length ? 'btn btn--primary' : 'btn',
    onclick: async () => {
      runBtn.disabled = true;
      const lines = el('ul', { style: { margin: '0', paddingLeft: '1.1rem' } });
      remount(log, el('div', { class: 'notice notice--info' }, el('div', {},
        el('strong', { class: 'notice__title' }, 'Updating…'), lines)));
      try {
        const result = await db.migrate({
          onProgress: (message) => mount(lines, el('li', {}, message)),
        });
        remount(log, notice('ok',
          result.ran.length ? `Updated from v${result.from} to v${result.to}` : 'Already up to date',
          result.notes.length
            ? el('ul', { style: { margin: '0', paddingLeft: '1.1rem' } },
              ...result.notes.map((n) => el('li', {}, n)))
            : el('p', {}, 'No records needed changing.')));
        toast('Database schema is up to date.', 'ok');
      } catch (err) {
        remount(log, notice('danger', 'Update failed', el('p', {}, err.message)));
      }
      runBtn.disabled = false;
    },
  }, icon('refresh'), status.pending.length ? 'Run migrations now' : 'Re-run migrations');

  return el('section', { class: 'card stack', style: { marginTop: 'var(--sp-5)' } },
    el('h2', { class: 'section-title' }, 'Schema version'),
    el('div', { class: 'row row--between row--wrap' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'This folder'),
        el('div', { style: { fontWeight: '570' } }, `v${status.from}`)),
      el('div', {},
        el('div', { class: 'eyebrow' }, 'This app expects'),
        el('div', { style: { fontWeight: '570' } }, `v${status.to}`)),
      status.pending.length
        ? badge(`${pluralize(status.pending.length, 'update')} pending`, 'warn', 'alert')
        : badge('Up to date', 'ok', 'checkCircle')),

    status.pending.length
      ? notice('warn', 'Pending updates',
        el('ul', { style: { margin: '0', paddingLeft: '1.1rem' } },
          ...status.pending.map((p) => el('li', {}, p))))
      : el('p', { class: 'muted' },
        'Records match this build. Migrations run automatically when a device opens a folder '
        + 'written by an older release — export a backup before a major update all the same.'),

    el('div', { class: 'row row--wrap' }, runBtn),
    log);
}

const ROLE_HINTS = {
  student: 'Can be targeted by feedback requests, and submits them once.',
  instructor: 'Opens the Instructor Panel to create feedback and read responses.',
  cadre: 'Everything an instructor can do, plus a cadre-only area instructors cannot '
    + 'see — a separate folder, not a hidden screen.',
  commander: 'Sees every area including its own, which nobody else can read. '
    + `At most ${MAX_COMMANDERS} at a time, so a change of command overlaps.`,
  admin: 'Manages the roster, and can delete feedback — always with a recorded reason.',
};

/** Shared with the roster importer — quoted fields, embedded commas/newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; } else quoted = false;
      } else value += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(value); value = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else value += char;
  }
  row.push(value);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}
