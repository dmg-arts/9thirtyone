/**
 * Settings — database location, appearance, accessibility, and app info.
 * Reachable without signing in, since display preferences belong to
 * whoever is holding the device.
 */

import {
  el, icon, field, select, notice, toast, confirmDialog, spinner, badge,
  fmtDateTime, download, modal,
  mount, remount } from '../util.js';
import { APP, BACKENDS, ROLES, SEMESTERS, schoolYears, isDirectSignIn, setDirectSignIn } from '../config.js';
import { settings, connection, applySettings, markSetupComplete, disconnectDevice } from '../state.js';
import { hasAdmin, signOut, currentUser } from '../auth.js';
import { db, adapters, parseFolderId } from '../storage/index.js';
import { checkProxy } from '../storage/proxy.js';
import { connectionStatus } from '../data-source.js';
import { navigate } from '../router.js';
import { resetSetupDraft } from './setup.js';

export async function renderSettings(root) {
  const conn = connection.get();

  mount(root, 
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, 'Settings'),
      el('p', { class: 'page-sub' }, 'Applies to this device. Feedback data is unaffected.')),
    await storageSection(conn),
    proxySection(conn),
    appearanceSection(),
    defaultsSection(),
    await accessSection(),
    aboutSection(),
  );
}

/* ------------------------------------------------------------------ *
 * Access — signing in without Google
 * ------------------------------------------------------------------ */

/**
 * The one switch on this page that touches access, and what it no longer does.
 *
 * This was "development mode", and it made every role check pass — the panels
 * opened with no sign-in at all. Since this page is deliberately reachable
 * without signing in, that meant anybody holding a detachment laptop could tick
 * a box and open the admin console. The proxy still refused them data, needing
 * a token they did not have, but "the server would have stopped them" is a poor
 * reason to leave a door unlatched.
 *
 * It now enables exactly one thing: the email sign-in on the sign-in screen,
 * for installations with no Google Client ID. That is the *This device only*
 * evaluation path the setup guide recommends, and without this it is a dead end
 * — Google cannot sign anyone in without a Client ID, so the Instructor Panel
 * could never be opened.
 *
 * It grants nothing by itself. Whoever signs in that way is checked against the
 * roster like anybody else and gets the roles they actually hold.
 */
async function accessSection() {
  const adminExists = await hasAdmin().catch(() => false);
  const on = isDirectSignIn();
  const conn = connection.get();
  const hasClientId = Boolean(conn.clientId);

  // Enabling requires being an administrator once the detachment has one.
  // Turning it *off* never does: the safe direction should not need a
  // credential, least of all one the person may be unable to produce.
  const session = currentUser();
  const isAdmin = (session?.roles || []).includes(ROLES.admin);
  const mayEnable = !adminExists || isAdmin;

  const toggle = el('input', {
    type: 'checkbox', checked: on, disabled: !on && !mayEnable,
    onchange: async (e) => {
      if (!e.target.checked) {
        setDirectSignIn(false);
        toast('Google sign-in is now the only way in on this device.', 'ok');
        return navigate('/settings');
      }
      if (!mayEnable) {
        e.target.checked = false;
        return toast('Sign in as a database administrator to turn this on.', 'warn', 6000);
      }
      const confirmed = await confirmDialog('Allow signing in without Google?',
        'This device will offer an email box on the sign-in screen. The roster still decides '
        + 'who gets in and as what \u2014 but an email is easier to claim than a Google account, '
        + 'so leave it off wherever Google sign-in works.',
        { confirmLabel: 'Allow it', danger: true });
      if (!confirmed) { e.target.checked = false; return undefined; }
      setDirectSignIn(true);
      toast('Email sign-in allowed on this device.', 'warn');
      return navigate('/settings');
    },
  });

  return el('section', { class: 'card stack', style: { marginTop: 'var(--sp-5)' } },
    el('h2', { class: 'section-title' }, 'Access'),

    on
      ? notice('warn', 'This device allows signing in without Google',
        el('p', {}, hasClientId
          ? 'This installation has a Google Client ID, so nobody needs this \u2014 and the '
            + 'sign-in screen will not offer it while one is configured. Turn it off.'
          : 'The sign-in screen offers an email box as well as Google. The roster still '
            + 'decides who gets in and what they may do.'))
      : notice('ok', 'Google sign-in only',
        el('p', {}, adminExists
          ? 'Every panel requires an account on the roster.'
          : 'No administrator account exists yet \u2014 the first person to sign in claims '
            + 'the detachment.')),

    el('label', { class: 'check' }, toggle,
      el('span', {},
        el('span', { class: 'check__text' }, 'Allow signing in with an email instead of Google'),
        el('span', { class: 'check__desc', style: { display: 'block' } },
          !on && !mayEnable
            ? 'Locked. This detachment has administrator accounts, so turning this on requires '
              + 'signing in as one first. It can always be turned off.'
            : 'For an installation with no Google Client ID \u2014 evaluating the app on one '
              + 'device, before the Google setup exists. Device-local, and it grants no access '
              + 'on its own.'))),

    el('p', { class: 'field__hint' },
      'The roster is managed in Database Administration. This app stores no passwords: access is '
      + 'decided by which emails are on the roster, and by the roles each one holds.'));
}

/**
 * Checks for a new version, and says what it found.
 *
 * The previous version of this button called `registration.update()` and always
 * reported "Checked for updates", which resolves whether or not anything was
 * found — so it looked identical when an update existed and when none did.
 *
 * The version shown above it is read from the code *currently running*, which is
 * the cached copy. It cannot change until a new worker has installed and the
 * page has reloaded, so a stale number there is expected rather than a fault.
 * That is the whole reason this needs to report an outcome: without one, there
 * is no way to tell "already current" from "update sitting there unapplied".
 */
function updateButton() {
  const button = el('button', { type: 'button', class: 'btn btn--sm' },
    icon('refresh'), 'Check for updates');
  const status = el('div', {});

  const offerReload = () => {
    remount(status, notice('ok', 'An update is ready',
      el('p', {}, 'It installs when the app reloads.'),
      el('div', { style: { marginTop: 'var(--sp-3)' } },
        el('button', {
          type: 'button', class: 'btn btn--sm btn--primary',
          onclick: () => window.location.reload(),
        }, icon('refresh'), 'Reload now'))));
  };

  button.onclick = async () => {
    button.disabled = true;
    remount(status, spinner('Asking the server…'));
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (!registration) {
        remount(status, notice('warn', 'Not installed as an app',
          el('p', {}, 'Updates arrive on the next page load.')));
        return;
      }

      // A worker already waiting means a previous check found an update that
      // has not been applied yet.
      if (registration.waiting) return offerReload();

      await registration.update();

      // update() resolves as soon as the request is made, so give the new
      // worker a moment to reach `installing` before deciding nothing changed.
      const found = await new Promise((resolve) => {
        if (registration.installing || registration.waiting) return resolve(true);
        const timer = setTimeout(() => resolve(false), 3000);
        registration.addEventListener('updatefound', () => {
          clearTimeout(timer);
          resolve(true);
        }, { once: true });
      });

      if (found) offerReload();
      else {
        remount(status, notice('ok', `You are on the latest version (${APP.version})`,
          el('p', {}, 'Nothing new is available.')));
      }
    } catch (err) {
      remount(status, notice('danger', 'Could not check for updates', el('p', {}, err.message)));
    } finally {
      button.disabled = false;
    }
  };

  return el('div', { class: 'stack-sm' }, el('div', { class: 'row row--wrap' }, button), status);
}

/* ------------------------------------------------------------------ *
 * Storage / database location
 * ------------------------------------------------------------------ */

/**
 * The submission server.
 *
 * Without one, every cadet needs Editor on the Drive folder in order to submit —
 * and Drive has no write-without-read, so they can also read every response in
 * it. With one, cadets need no Drive access at all. This is the single setting
 * that decides whether "anonymous" means anonymous from other cadets.
 */
function proxySection(conn) {
  const input = el('input', {
    class: 'input mono', type: 'url', value: conn.proxyUrl || '',
    placeholder: 'https://script.google.com/macros/s/…/exec',
    spellcheck: 'false', autocapitalize: 'off',
  });
  const status = el('div', {});

  const save = async () => {
    const value = input.value.trim();

    if (!value) {
      connection.set({ proxyUrl: '' });
      remount(status, notice('warn', 'Proxy turned off',
        el('p', {}, 'Cadets will write to Drive directly again, which means they need Editor '
          + 'access to the folder and can read every response in it.')));
      return;
    }

    remount(status, spinner('Checking the deployment…'));
    const result = await checkProxy(value);
    if (!result.ok) {
      remount(status, notice('danger', 'That proxy is not usable yet', el('p', {}, result.error)));
      return;
    }

    connection.set({ proxyUrl: value });
    remount(status, notice('ok', `Connected to proxy v${result.version}`,
      el('p', {}, 'Cadets who join from now on will submit through it and will not be asked '
        + 'for Drive access at all.'),
      el('p', {}, 'Anyone already set up keeps their current configuration until they open a '
        + 'new join link — and existing cadets still hold whatever Drive access you granted '
        + 'them, so remove that separately.')));
  };

  return el('section', { class: 'card stack' },
    el('h2', { class: 'section-title' }, 'Submission server'),
    el('p', { class: 'muted' },
      'Optional, and worth doing before you field this. A small script running in your own '
      + 'Google account files cadets\' feedback for them, so they never need access to the '
      + 'folder. Setup instructions are in the guide.'),
    field('Web app URL', input, {
      hint: 'From Apps Script → Deploy → New deployment → Web app. Ends in /exec. '
        + 'Leave blank to turn it off.',
    }),
    el('div', { class: 'row row--wrap' },
      el('button', { type: 'button', class: 'btn btn--primary', onclick: save },
        icon('check'), 'Save and test')),
    status,
    conn.proxyUrl ? null : notice('warn', 'No proxy configured',
      el('p', {}, 'Cadets must have Editor access to the Drive folder to submit, which also '
        + 'lets them read every response in it. Until this is set up, do not tell cadets their '
        + 'feedback is private from each other.')));
}

async function storageSection(conn) {
  const statusRow = el('div', { class: 'row row--wrap' }, spinner('Checking…'));

  connectionStatus().then((status) => {
    remount(statusRow, 
      el('span', { class: 'conn', dataset: { status: status.status } },
        el('span', { class: 'conn__dot' }),
        el('span', {}, status.status)),
      el('span', { class: 'muted' }, status.detail || ''));
  });

  const card = el('section', { class: 'card stack' },
    el('h2', { class: 'section-title' }, 'Database location'),
    el('div', { class: 'row row--between row--wrap' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Backend'),
        el('div', { style: { fontWeight: '570' } }, backendLabel(conn.backend)),
        conn.folderName && el('div', { class: 'muted' }, conn.folderName),
        conn.connectedAt && el('div', { class: 'faint' }, `Connected ${fmtDateTime(conn.connectedAt)}`)),
      statusRow),
  );

  if (conn.backend === BACKENDS.drive) {
    mount(card, 
      conn.folderUrl && el('a', { class: 'btn btn--sm', href: conn.folderUrl, target: '_blank', rel: 'noopener' },
        icon('external'), 'Open folder in Drive'),
      el('div', { class: 'row row--wrap' },
        el('button', {
          type: 'button', class: 'btn btn--sm',
          onclick: async () => {
            try {
              const result = await adapters.drive.connect({ interactive: true });
              toast(result.ok ? 'Reconnected to Drive.' : `Could not connect: ${result.detail || result.reason}`,
                result.ok ? 'ok' : 'danger');
            } catch (err) { toast(err.message, 'danger', 7000); }
          },
        }, icon('refresh'), 'Reconnect'),
        el('button', {
          type: 'button', class: 'btn btn--sm',
          onclick: () => { adapters.drive.signOut(); toast('Signed out of Google on this device.', 'ok'); },
        }, icon('lock'), 'Sign out of Google'),
        el('button', { type: 'button', class: 'btn btn--sm', onclick: () => editDriveTarget(conn) },
          icon('edit'), 'Change folder')));
  }

  if (conn.backend === BACKENDS.folder) {
    mount(card, el('div', { class: 'row row--wrap' },
      el('button', {
        type: 'button', class: 'btn btn--sm',
        onclick: async () => {
          const result = await adapters.folder.connect({ interactive: true });
          toast(result.ok ? 'Folder access restored.' : 'Folder access was declined.', result.ok ? 'ok' : 'warn');
        },
      }, icon('refresh'), 'Reconnect'),
      el('button', {
        type: 'button', class: 'btn btn--sm',
        onclick: async () => {
          try {
            const { name } = await adapters.folder.chooseFolder();
            connection.set({ folderName: name, connectedAt: new Date().toISOString() });
            await db.initialize({ seed: false });
            toast(`Now using "${name}".`, 'ok');
            navigate('/settings');
          } catch (err) {
            if (err.name !== 'AbortError') toast(err.message, 'danger', 7000);
          }
        },
      }, icon('folder'), 'Choose a different folder')));
  }

  if (conn.backend === BACKENDS.local) {
    mount(card, notice('warn', 'Data lives only in this browser',
      el('p', {}, 'Clearing site data will erase it. Export a backup from Cadre → Database, '
        + 'then re-run setup pointing at Google Drive when the detachment account is ready.')));
  }

  mount(card, 
    el('hr', { class: 'rule' }),
    el('div', { class: 'row row--wrap' },
      el('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
          const confirmed = await confirmDialog('Re-run setup?',
            'You will choose the storage backend and location again. Export a backup first if you are switching backends — '
            + 'records do not move automatically.',
            { confirmLabel: 'Re-run setup' });
          if (!confirmed) return;
          resetSetupDraft();
          navigate('/setup?rerun=1');
        },
      }, icon('refresh'), 'Re-run setup'),
      el('button', {
        type: 'button', class: 'btn btn--danger',
        onclick: async () => {
          const confirmed = await confirmDialog('Disconnect this device?',
            'This device forgets where the database is and returns to setup. '
            + 'No records are deleted, other devices keep working, and setup will offer you '
            + 'this same folder again rather than making a new one.',
            { confirmLabel: 'Disconnect', danger: true });
          if (!confirmed) return;
          if (connection.get().backend === BACKENDS.drive) adapters.drive.signOut();
          if (connection.get().backend === BACKENDS.folder) await adapters.folder.forget();
          disconnectDevice();
          signOut();
          markSetupComplete(false);
          resetSetupDraft();
          navigate('/setup');
        },
      }, icon('x'), 'Disconnect this device')));

  return card;
}

async function editDriveTarget(conn) {
  const clientInput = el('input', { class: 'input mono', type: 'text', value: conn.clientId || '', spellcheck: 'false' });
  const folderInput = el('input', { class: 'input', type: 'text', value: conn.folderUrl || conn.folderId || '', spellcheck: 'false' });

  const result = await modal({
    title: 'Reconnect to a folder',
    body: el('div', {},
      field('OAuth Client ID', clientInput),
      field('Folder link or ID', folderInput, {
        hint: 'The folder this app created for this Google account — its address is in the '
          + 'app bar under Storage, and in Drive.',
      }),
      notice('info', 'Only folders this app created',
        el('p', {}, 'This app can reach files it made itself and nothing else in your Drive. '
          + 'So this reconnects to a folder it already created for this Google account — '
          + 'after clearing site data, say. It cannot adopt a folder made by hand, and it '
          + 'cannot open another detachment\'s folder.')),
      notice('warn', 'Records do not move',
        el('p', {}, 'Pointing at a different folder shows whatever is already in that folder. '
          + 'Export a backup first if you mean to migrate.'))),
    actions: [{ label: 'Cancel', value: null }, { label: 'Save and connect', value: 'save', variant: 'primary' }],
  });
  if (result !== 'save') return;

  const folderId = parseFolderId(folderInput.value);
  if (!folderId) return toast('That folder link could not be read.', 'danger');

  connection.set({ clientId: clientInput.value.trim(), folderId, folderUrl: `https://drive.google.com/drive/folders/${folderId}` });
  db.use(BACKENDS.drive, { clientId: clientInput.value.trim(), folderId });
  try {
    const connected = await adapters.drive.connect({ interactive: true });
    if (!connected.ok) throw new Error(connected.detail || 'Could not verify the folder.');
    connection.set({ folderName: connected.folderName, connectedAt: new Date().toISOString() });
    await db.initialize({ seed: false });
    toast(`Now using "${connected.folderName}".`, 'ok');
  } catch (err) {
    // "Not found" here almost always means the folder is real but was not made
    // by this app for this account — which is invisible under `drive.file` and
    // reads like a broken ID unless it is spelled out.
    const notFound = /404|not found/i.test(err.message);
    toast(notFound
      ? 'Google cannot see that folder for this account. It exists only if this app created '
        + 'it while signed in as you — a folder made by hand in Drive cannot be used.'
      : err.message, 'danger', 10000);
  }
  return navigate('/settings');
}

/* ------------------------------------------------------------------ *
 * Appearance & accessibility
 * ------------------------------------------------------------------ */

function appearanceSection() {
  const current = settings.get();

  const segmented = (name, options, value, onChange) => {
    const wrap = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': name });
    for (const option of options) {
      mount(wrap, el('label', { class: 'segmented__opt' },
        el('input', {
          type: 'radio', name, value: option.value, checked: option.value === value,
          onchange: () => onChange(option.value),
        }),
        el('span', {}, option.label)));
    }
    return wrap;
  };

  return el('section', { class: 'card stack', style: { marginTop: 'var(--sp-5)' } },
    el('h2', { class: 'section-title' }, 'Appearance'),

    field('Theme', segmented('theme', [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ], current.theme, (value) => settings.set({ theme: value })), {
      hint: 'System follows the device\'s light/dark setting.',
    }),

    field('Color vision', segmented('palette', [
      { value: 'default', label: 'Default' },
      { value: 'deuteranopia', label: 'Deuteranopia' },
      { value: 'protanopia', label: 'Protanopia' },
      { value: 'tritanopia', label: 'Tritanopia' },
      { value: 'mono', label: 'Monochrome' },
    ], current.palette, (value) => settings.set({ palette: value })), {
      hint: 'Remaps status colors. Every status also carries an icon and a text label, '
        + 'so nothing depends on color alone.',
    }),

    field('Contrast', segmented('contrast', [
      { value: 'normal', label: 'Normal' },
      { value: 'high', label: 'High' },
    ], current.contrast, (value) => settings.set({ contrast: value }))),

    field('Text size', segmented('textSize', [
      { value: 'sm', label: 'Small' },
      { value: 'md', label: 'Default' },
      { value: 'lg', label: 'Large' },
    ], current.textSize, (value) => settings.set({ textSize: value }))),

    el('label', { class: 'check' },
      el('input', {
        type: 'checkbox', checked: current.reduceMotion,
        onchange: (e) => settings.set({ reduceMotion: e.target.checked }),
      }),
      el('span', {},
        el('span', { class: 'check__text' }, 'Reduce motion'),
        el('span', { class: 'check__desc', style: { display: 'block' } },
          'Turns off transitions and animations.'))),

    el('div', { class: 'row row--wrap' },
      el('button', {
        type: 'button', class: 'btn btn--sm',
        onclick: () => {
          settings.replace({});
          applySettings();
          toast('Appearance reset.', 'ok');
          navigate('/settings');
        },
      }, icon('refresh'), 'Reset appearance')),

    previewSwatches());
}

/** Shows every status color at once so a palette choice can be judged quickly. */
function previewSwatches() {
  return el('div', {},
    el('div', { class: 'eyebrow', style: { marginBottom: 'var(--sp-2)' } }, 'Preview'),
    el('div', { class: 'row row--wrap' },
      badge('Open', 'ok', 'checkCircle'),
      badge('Overdue', 'warn', 'clock'),
      badge('Closed', 'neutral', 'lock'),
      badge('Error', 'danger', 'alert'),
      badge('Info', 'info', 'info')));
}

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

function defaultsSection() {
  const current = settings.get();
  const years = schoolYears();

  return el('section', { class: 'card stack', style: { marginTop: 'var(--sp-5)' } },
    el('h2', { class: 'section-title' }, 'Defaults'),
    el('p', { class: 'muted' }, 'Pre-selects the filters on the cadet screen for this device — '
      + 'useful on a kiosk laptop in a classroom.'),
    el('div', { class: 'filters' },
      field('School year', select(
        [{ value: '', label: 'Follow the calendar' }, ...years.map((y) => ({ value: y, label: y }))],
        { value: current.defaultSchoolYear, onchange: (e) => settings.set({ defaultSchoolYear: e.target.value }) })),
      field('Semester', select(
        [{ value: '', label: 'Follow the calendar' }, ...SEMESTERS.map((s) => ({ value: s, label: s }))],
        { value: current.defaultSemester, onchange: (e) => settings.set({ defaultSemester: e.target.value }) }))),
    el('label', { class: 'check' },
      el('input', {
        type: 'checkbox', checked: current.studentShowClosed,
        onchange: (e) => settings.set({ studentShowClosed: e.target.checked }),
      }),
      el('span', { class: 'check__text' }, 'Show closed requests to cadets by default')));
}

/* ------------------------------------------------------------------ *
 * About
 * ------------------------------------------------------------------ */

function aboutSection() {
  const install = el('div', { class: 'row row--wrap' });

  // The beforeinstallprompt event is captured in app.js and stashed here.
  const deferred = window.__nine31InstallPrompt;
  if (deferred) {
    mount(install, el('button', {
      type: 'button', class: 'btn',
      onclick: async () => {
        deferred.prompt();
        const { outcome } = await deferred.userChoice;
        if (outcome === 'accepted') toast('Installing…', 'ok');
        window.__nine31InstallPrompt = null;
      },
    }, icon('download'), 'Install this app'));
  }

  return el('section', { class: 'card stack', style: { marginTop: 'var(--sp-5)' } },
    el('h2', { class: 'section-title' }, 'About'),
    el('dl', { class: 'stack-sm' },
      row('Version', `${APP.version} (schema v${APP.schemaVersion})`),
      row('Organization', connection.get().orgName || '—'),
      row('Offline', navigator.onLine ? 'Online' : 'Offline'),
      row('Installed', window.matchMedia('(display-mode: standalone)').matches ? 'Yes' : 'No')),
    install,
    updateButton(),
    el('div', { class: 'row row--wrap' },
      el('button', {
        type: 'button', class: 'btn btn--sm',
        onclick: () => download('nine31-diagnostics.json', JSON.stringify({
          app: APP,
          connection: { ...connection.get(), clientId: connection.get().clientId ? '(set)' : '' },
          settings: settings.get(),
          userAgent: navigator.userAgent,
          online: navigator.onLine,
          generatedAt: new Date().toISOString(),
        }, null, 2)),
      }, icon('download'), 'Download diagnostics'),
      // Google requires the privacy policy to be reachable from the product,
      // not only from a listing. This is the durable place for it.
      el('a', {
        class: 'btn btn--sm', href: './privacy.html', target: '_blank', rel: 'noopener',
      }, icon('lock'), 'Privacy policy'),
      el('a', {
        class: 'btn btn--sm', href: './terms.html', target: '_blank', rel: 'noopener',
      }, icon('clipboard'), 'Terms of service')));
}

function row(label, value) {
  return el('div', { class: 'row row--between' },
    el('dt', { class: 'muted' }, label),
    el('dd', { style: { fontWeight: '570' } }, value));
}

function backendLabel(backend) {
  return {
    [BACKENDS.drive]: 'Google Drive (organization account)',
    [BACKENDS.folder]: 'Synced folder on this computer',
    [BACKENDS.local]: 'This device only',
  }[backend] || 'Not configured';
}
