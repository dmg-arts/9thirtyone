/**
 * Home — the two role entries plus settings. Deliberately spare: on a shared
 * detachment laptop this is the screen a cadet walks up to.
 */

import { el, icon, badge, emptyState, mount, remount } from '../util.js';
import { connection } from '../state.js';
import { db } from '../storage/index.js';
import { canDoMaintenance, loadOverview } from '../data-source.js';
import { navigate } from '../router.js';
import { APP, ROLE_LABELS } from '../config.js';
import { currentUser, activeRoles } from '../auth.js';
import { PANELS, canOpenPanel } from '../panels.js';

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

  // Counts are a live read, so keep them off the critical render path.
  try {
    // In proxy mode this device has no storage adapter, so db.stats() throws and
    // the home screen told a cadet their database was unreadable — on the one
    // screen that exists to reassure them the app is working. The Instructor
    // Panel already forks the same call; this is that fork, applied here too.
    const stats = canDoMaintenance()
      ? await db.stats()
      : (await loadOverview()).stats;
    remount(counts, 
      badge(`${stats.openRequests} open`, stats.openRequests ? 'ok' : 'neutral', 'send'),
      badge(`${stats.responses} responses`, 'neutral', 'inbox'),
      badge(`${stats.students} cadets`, 'neutral', 'users'));
  } catch (err) {
    remount(counts, badge('Not reachable', 'danger', 'alert'));
    mount(root, el('div', { style: { marginTop: 'var(--sp-4)' } },
      emptyState({
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
