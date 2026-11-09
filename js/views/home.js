/**
 * Home — the two role entries plus settings. Deliberately spare: on a shared
 * detachment laptop this is the screen a cadet walks up to.
 */

import { el, icon, badge, emptyState, mount, remount } from '../util.js';
import { connection } from '../state.js';
import { db } from '../storage/index.js';
import { canDoMaintenance, loadOverview } from '../data-source.js';
import { navigate } from '../router.js';
import { APP, ROLE_LABELS, ROLES, needsSubmissionServer } from '../config.js';
import { currentUser, activeRoles } from '../auth.js';
import { PANELS, canOpenPanel } from '../panels.js';
import { joinLinkCard } from './join-card.js';

/** Shows whether a panel will ask for credentials before it opens. */
function gateBadge() {
  const session = currentUser();
  return session
    ? badge(`Signed in — ${session.username}`, 'ok', 'unlock')
    : badge('Sign-in required', 'neutral', 'lock');
}

export async function renderHome(root) {
  const conn = connection.get();
  const showCadre = canOpenPanel(PANELS.cadre, activeRoles());

  const roleCard = (path, iconName, title, desc, extra = null) =>
    el('button', {
      type: 'button', class: 'role-card',
      onclick: () => navigate(path),
    },
      el('span', { class: 'role-card__icon' }, icon(iconName)),
      el('span', { class: 'role-card__title' }, title),
      el('span', { class: 'role-card__desc' }, desc),
      extra);

  const counts = el('div', { class: 'row row--wrap', style: { minHeight: '1.5rem' } });

  mount(root, 
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, conn.orgName || APP.name),
      el('p', { class: 'page-sub' }, 'Choose how you are signing in.')),

    el('div', { class: 'role-grid' },
      roleCard('/student', 'student', ROLE_LABELS.student,
        'See the feedback assigned to you and fill it out. Sign in with your Google account.'),
      roleCard(PANELS.instructor.path, 'cadre', PANELS.instructor.title,
        PANELS.instructor.blurb, gateBadge()),
      // Only shown to an account that actually holds cadre. Everyone else does
      // not need a door they cannot open, and a cadet walking up to a shared
      // laptop should not be met with a list of spaces they are shut out of.
      showCadre && roleCard(PANELS.cadre.path, 'lock', PANELS.cadre.title,
        PANELS.cadre.blurb, gateBadge()),
      roleCard('/admin', 'database', 'Database Administration',
        'Create and manage cadet, instructor and administrator accounts for your detachment.',
        gateBadge()),
      el('button', {
        type: 'button', class: 'role-card role-card--wide',
        onclick: () => navigate('/settings'),
      },
        el('span', { class: 'role-card__icon' }, icon('settings')),
        el('span', {},
          el('span', { class: 'role-card__title', style: { display: 'block' } }, 'Settings'),
          el('span', { class: 'role-card__desc' }, 'Database location, appearance, accessibility, backups.')),
        el('span', { class: 'spacer' }),
        icon('chevronRight', { cls: 'list__chev' }))),

    el('div', { class: 'card', style: { marginTop: 'var(--sp-5)' } },
      el('div', { class: 'row row--between row--wrap' },
        el('div', {},
          el('div', { class: 'eyebrow' }, 'Database'),
          el('div', { style: { fontWeight: '570' } }, describeConnection(conn))),
        counts)),
  );

  // Nobody who cannot read the counts should be asked to watch them fail.
  //
  // `overview` is instructor and above, so a cadet — or anyone signed out —
  // was refused, landed in the catch below, and got a red "Not reachable"
  // badge and "The database could not be read" on the one screen that exists
  // to reassure them the app is working.
  //
  // That sat dormant while cadets landed on /student. Stage 7 made it
  // universal: joining now lands on /home, so every cadet who joins by link
  // met an error panel on first open. Found 4 Nov, by reading rather than by
  // any test — every cadet check navigates straight to #/student, and the
  // four #/home visits in the browser suite are all staff.
  //
  // Tested as "holds a role that is not student", which is what `overview`
  // means and what the server itself uses in readPeopleSummary. Not a panel
  // check: `admin` implies no other role, so a database administrator with no
  // teaching role would have been wrongly excluded.
  const mayReadCounts = activeRoles().some((role) => role !== ROLES.student);
  if (!mayReadCounts) {
    // Nothing, deliberately. The doors above are what this screen is for, and
    // a cadet has no use for detachment totals.
    remount(counts);
    return;
  }

  // Counts are a live read, so keep them off the critical render path.
  try {
    // In proxy mode this device has no storage adapter, so db.stats() throws and
    // the home screen told a cadet their database was unreadable. The Instructor
    // Panel already forks the same call; this is that fork, applied here too.
    const stats = canDoMaintenance()
      ? await db.stats()
      : (await loadOverview()).stats;
    remount(counts, 
      badge(`${stats.openRequests} open`, stats.openRequests ? 'ok' : 'neutral', 'send'),
      badge(`${stats.responses} responses`, 'neutral', 'inbox'),
      badge(`${stats.students} cadets`, 'neutral', 'users'));
  } catch (err) {
    // Two different faults used to land here wearing the same face.
    //
    // A device with a folder and no submission server cannot read that folder
    // and never will: `drive.file` grants access to files this browser
    // created, and somebody else's browser created the detachment's. The old
    // panel said "the database could not be read" and offered Settings, which
    // is where the fault was introduced — a loop Det 752's commander went
    // round for most of a day.
    //
    // Everything else landing here really is "could not be read", including
    // simply being signed out, so the generic panel stays for those.
    const stuck = needsSubmissionServer(connection.get());
    remount(counts, badge(stuck ? 'Not set up for this detachment' : 'Not reachable', 'danger', 'alert'));
    mount(root, el('div', { style: { marginTop: 'var(--sp-4)' } },
      stuck
        ? el('div', { class: 'stack' },
          emptyState({
            iconName: 'alert',
            title: 'This device was set up, not joined',
            message: 'It is pointed at the detachment\u2019s folder, which only the browser that '
              + 'created that folder can open. Nothing is wrong with the folder or with your '
              + 'account \u2014 this device just needs the join link instead.',
          }),
          // The recovery, in the error itself. Sending somebody to Settings is
          // what caused this; the thing that fixes it is a join link, so the
          // box for pasting one belongs here rather than two screens away.
          joinLinkCard({
            title: 'Paste your join link',
            blurb: '',
            action: 'Set this device up properly',
          }))
        : emptyState({
          iconName: 'alert',
          title: 'The database could not be read',
          message: err.message,
          action: el('button', { type: 'button', class: 'btn', onclick: () => navigate('/settings') },
            icon('settings'), 'Open Settings'),
        })));
  }
}

function describeConnection(conn) {
  const labels = {
    drive: `Google Drive — ${conn.folderName || 'connected folder'}`,
    folder: `Synced folder — ${conn.folderName || 'selected folder'}`,
    local: 'This device only (not synced)',
  };
  return labels[conn.backend] || 'Not configured';
}
