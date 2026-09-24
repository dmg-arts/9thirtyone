/**
 * Bootstrap: apply display settings, register routes, wire the app bar, and
 * start the service worker.
 */

import { APP } from './config.js';
import { $, el, icon, toast, mount, remount } from './util.js';
import { applySettings, connection, isConfigured } from './state.js';
import { db } from './storage/index.js';
import { connectionStatus } from './data-source.js';
import { route, startRouter, navigate, currentPath } from './router.js';
import { renderHome } from './views/home.js';
import { renderSetup } from './views/setup.js';
import { renderJoin } from './views/join.js';
import { renderInvite } from './views/invite.js';
import { renderStudentList, renderStudentFill } from './views/student.js';
import { renderInstructor, renderCadre } from './views/instructor.js';
import { renderFormCreator } from './views/formCreator.js';
import { renderAdmin } from './views/admin.js';
import { renderSettings } from './views/settings.js';
import { primeOverlay, flushQueue, onQueueChange, queueState } from './storage/index.js';

applySettings();

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

/** Sends anyone who has not finished setup to the wizard. */
const requireSetup = () => (isConfigured() ? null : '/setup');

route('/', () => navigate('/home', { replace: true }));
route('/setup', ({ outlet, query }) => renderSetup(outlet, { rerun: query.get('rerun') === '1' }),
  { title: 'Setup' });
route('/join', ({ outlet, query }) => renderJoin(outlet, { query }), { title: 'Join' });
route('/home', ({ outlet }) => renderHome(outlet), { guard: requireSetup, title: 'Home' });

route('/student', ({ outlet }) => renderStudentList(outlet), { guard: requireSetup, title: 'Cadet' });
route('/student/fill/:id', ({ outlet, params }) => renderStudentFill(outlet, { params }),
  { guard: requireSetup, title: 'Feedback' });

route('/instructor', ({ outlet, query }) => renderInstructor(outlet, { query }),
  { guard: requireSetup, title: 'Instructor Panel' });
route('/instructor/create/:id', ({ outlet, params, query }) => renderFormCreator(outlet, { params, query }),
  { guard: requireSetup, title: 'Create Feedback' });

// The same screen as /instructor, pointed at the cadre and commander folders.
route('/cadre', ({ outlet, query }) => renderCadre(outlet, { query }),
  { guard: requireSetup, title: 'Cadre Panel' });

route('/admin/invite', ({ outlet }) => renderInvite(outlet),
  { guard: requireSetup, title: 'Invite' });
route('/admin', ({ outlet, query }) => renderAdmin(outlet, { query }),
  { guard: requireSetup, title: 'Database Administration' });

route('/settings', ({ outlet }) => renderSettings(outlet), { title: 'Settings' });

/* ------------------------------------------------------------------ *
 * app bar
 * ------------------------------------------------------------------ */

function buildAppBar() {
  const bar = $('#appbar');
  const conn = connection.get();

  const back = el('button', {
    type: 'button', class: 'btn btn--icon btn--ghost', 'aria-label': 'Back to home',
    onclick: () => navigate('/home'),
  }, icon('arrowLeft'));

  const brand = el('button', {
    type: 'button', class: 'appbar__brand',
    style: { background: 'none', border: '0', padding: '0', cursor: 'pointer', textAlign: 'left' },
    onclick: () => navigate('/home'),
  },
    el('span', { class: 'appbar__mark', 'aria-hidden': 'true' }, '931'),
    el('span', { style: { minWidth: '0' } },
      el('span', { class: 'appbar__title', style: { display: 'block' } }, APP.name),
      el('span', { class: 'appbar__sub', style: { display: 'block' } }, conn.orgName || 'Not configured')));

  const status = el('span', { class: 'conn', dataset: { status: 'unknown' }, id: 'conn-indicator' },
    el('span', { class: 'conn__dot' }),
    el('span', { class: 'conn__label' }, 'checking'),
    el('span', { class: 'visually-hidden' }, 'Database connection status'));

  remount(bar, 
    back, brand,
    el('span', { class: 'appbar__spacer' }),
    buildQueuePill(),
    status,
    el('button', {
      type: 'button', class: 'btn btn--icon btn--ghost', 'aria-label': 'Settings',
      onclick: () => navigate('/settings'),
    }, icon('settings')));
}

/**
 * How long a connection reading is allowed to stand before it is taken again.
 *
 * The pill is refreshed on every navigation, and in proxy mode each refresh is
 * a request to the detachment's Apps Script deployment. Apps Script allows
 * thirty *simultaneous executions* across the whole account, so on a drill
 * night the cost of an untimed status pill is real: forty-five cadets moving
 * between the list and a form spend four or five executions each on it, and
 * every one of those is a slot a submission is queueing for.
 *
 * Thirty seconds is chosen against what the pill is for. It answers "is the
 * detachment's server reachable", which does not change minute to minute — and
 * the two things that *do* change it, the network flipping and the connection
 * being reconfigured, both refresh past the cache rather than waiting for it.
 */
const STATUS_TTL_MS = 30_000;

/** The last answer and when it was given, so navigation can reuse it. */
let lastStatus = null;

/** An in-flight check, so two callers at once make one request. */
let statusInFlight = null;

buildAppBar();
// The org name and connection live in the bar, so rebuild it when they change.
// A changed connection means the cached reading describes a server this device
// is no longer pointed at, so it is dropped rather than waited out.
connection.subscribe(() => {
  buildAppBar(); syncAppBar(); forgetStatus(); refreshStatus({ force: true });
});

/** Hides the back button on the home screen, where it has nowhere to go. */
function syncAppBar() {
  const path = currentPath();
  const atHome = path === '/home' || path === '/' || path === '/setup' || path === '/join';
  const back = $('#appbar .btn--icon');
  if (back) back.hidden = atHome;
}

/**
 * Connection pill: refreshed on navigation and when the network flips.
 *
 * @param {{force?: boolean}} options  `force` skips the cache, for the cases
 *   where the previous answer is known to be about a different server.
 */
async function refreshStatus({ force = false } = {}) {
  const node = $('#conn-indicator');
  if (!node) return;
  if (!isConfigured()) {
    node.dataset.status = 'unknown';
    node.querySelector('.conn__label').textContent = 'setup';
    return;
  }

  const paint = ({ status, detail }) => {
    node.dataset.status = status;
    node.querySelector('.conn__label').textContent = status;
    node.title = detail || '';
  };

  // Painted from the last answer rather than skipped: the app bar is rebuilt on
  // navigation, so a pill that returned early here would render blank.
  if (!force && lastStatus && Date.now() - lastStatus.at < STATUS_TTL_MS) {
    paint(lastStatus);
    return;
  }

  try {
    if (!statusInFlight) {
      statusInFlight = connectionStatus()
        .then((status) => ({ status: status.status, detail: status.detail || '' }))
        .catch((err) => ({ status: 'error', detail: err.message }))
        .finally(() => { statusInFlight = null; });
    }
    const answer = await statusInFlight;
    lastStatus = { ...answer, at: Date.now() };
    paint(answer);
  } catch (err) {
    // connectionStatus is caught above; this is anything the painting threw.
    node.dataset.status = 'error';
    node.querySelector('.conn__label').textContent = 'error';
    node.title = err.message;
  }
}

/** Drop the cached reading — the answer would be about a different server. */
function forgetStatus() {
  lastStatus = null;
  statusInFlight = null;
}

/**
 * Pending-write badge. Anything queued while offline is surfaced here rather
 * than silently held, and clicking it retries immediately.
 */
function buildQueuePill() {
  const pill = el('button', {
    type: 'button', class: 'conn queue-pill', id: 'queue-pill', hidden: true,
    title: 'Retry sending now',
    onclick: () => sendQueue({ manual: true }),
  }, icon('upload'), el('span', { id: 'queue-count' }, '0'));
  return pill;
}

async function refreshQueuePill(state = null) {
  const pill = $('#queue-pill');
  if (!pill) return;
  const { pending, draining } = state || await queueState();
  pill.hidden = pending === 0;
  pill.dataset.status = draining ? 'offline' : pending ? 'error' : 'ready';
  const count = $('#queue-count');
  if (count) count.textContent = draining ? 'sending…' : String(pending);
}

let flushing = false;
async function sendQueue({ manual = false } = {}) {
  if (flushing) return;
  flushing = true;
  try {
    const before = (await queueState()).pending;
    if (!before) {
      if (manual) toast('Nothing is waiting to send.', 'info', 2500);
      return;
    }
    const result = await flushQueue();
    if (result.sent) toast(`Sent ${result.sent} saved ${result.sent === 1 ? 'change' : 'changes'}.`, 'ok');
    else if (manual) toast('Still no connection — your work is safe on this device.', 'warn', 5000);
  } catch (err) {
    if (manual) toast(err.message, 'danger', 6000);
  } finally {
    flushing = false;
    refreshQueuePill();
  }
}

onQueueChange((state) => refreshQueuePill(state));

window.addEventListener('online', () => {
  refreshStatus({ force: true });
  toast('Back online.', 'ok', 2500);
  sendQueue();
});
window.addEventListener('offline', () => {
  refreshStatus({ force: true });
  toast('Offline — your work is saved on this device and sent when you reconnect.', 'warn', 5000);
});

/* ------------------------------------------------------------------ *
 * start
 * ------------------------------------------------------------------ */

// Re-point the storage facade at whatever this device was set up with.
if (connection.get().backend) db.use(connection.get().backend);

startRouter($('#view'), {
  afterRender: (current) => {
    document.title = current.title ? `${current.title} · ${APP.name}` : APP.name;
    syncAppBar();
    refreshStatus();
    refreshQueuePill();
  },
});

// Restore anything queued from a previous session, then try to send it.
primeOverlay()
  .then(() => refreshQueuePill())
  .then(() => { if (navigator.onLine) sendQueue(); })
  .catch((err) => console.warn('[queue] could not restore', err));

/**
 * Bring the connected folder up to this build's schema before any view reads
 * it. A device opening a detachment's folder for the first time after an update
 * is the normal case, so this runs quietly and only speaks up if it did work.
 */
async function migrateIfNeeded() {
  if (!isConfigured()) return;
  try {
    const status = await db.migrationStatus();
    if (!status.pending.length) return;
    const busy = toast(`Updating your database to v${status.to}…`, 'info', 60000);
    const result = await db.migrate();
    busy.remove();
    if (result.ran.length) {
      toast(`Database updated from v${result.from} to v${result.to}.`, 'ok', 6000);
      console.info('[migrations]', result.ran, result.notes);
    }
  } catch (err) {
    console.error('[migrations]', err);
    toast(`Database update failed: ${err.message}`, 'danger', 12000);
  }
}

migrateIfNeeded();

/* ------------------------------------------------------------------ *
 * PWA plumbing
 * ------------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then((registration) => {
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            // An installed app has no address bar to reload from, so the
            // notice has to carry the action itself.
            const notice = toast('An update is ready.', 'info', 15000);
            mount(notice, el('button', {
              type: 'button', class: 'btn btn--sm',
              style: { marginLeft: 'var(--sp-3)' },
              onclick: () => window.location.reload(),
            }, 'Reload'));
          }
        });
      });
    }).catch((err) => console.warn('[sw] registration failed', err));
  });
}

// Stashed so Settings can offer an explicit "Install this app" button.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  window.__nine31InstallPrompt = event;
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[unhandled]', event.reason);
  toast(event.reason?.message || 'Something went wrong.', 'danger', 6000);
});
