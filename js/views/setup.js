/**
 * First-run setup: name the detachment, choose where the database lives,
 * connect it, and build the folder tree.
 */

import { BACKENDS, DB_LAYOUT, FOLDER_TREE_PREVIEW, APP, GOOGLE_CLIENT_ID } from '../config.js';
import { el, icon, field, notice, toast, spinner, clear, mount, remount, fmtDate } from '../util.js';
import { connection, markSetupComplete } from '../state.js';
import { db, adapters } from '../storage/index.js';
import { navigate } from '../router.js';

const STEPS = ['Organization', 'Storage', 'Connect', 'Finish'];

/** Wizard-local draft; discarded if the user backs out. */
let draft = null;

export function renderSetup(root, { rerun = false } = {}) {
  if (!draft) {
    const saved = connection.get();
    draft = {
      step: 0,
      orgName: saved.orgName || '',
      backend: saved.backend || null,
      clientId: saved.clientId || GOOGLE_CLIENT_ID,
      folderId: saved.folderId || '',
      folderName: saved.folderName || '',
      connected: false,
      reused: false,
      rerun,
    };
  }
  draw(root);
}

export function resetSetupDraft() {
  draft = null;
}

function draw(root) {
  clear(root);
  const wizard = el('div', { class: 'wizard stack' });

  mount(wizard, 
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, draft.rerun ? 'Reconfigure storage' : `Set up ${APP.name}`),
      el('p', { class: 'page-sub' },
        'A one-time setup that tells this device where your detachment keeps its feedback data.')),
    stepper(),
  );

  const body = el('div', { class: 'card stack' });
  mount(wizard, body);

  switch (draft.step) {
    case 0: stepOrg(body, root); break;
    case 1: stepBackend(body, root); break;
    case 2: stepConnect(body, root); break;
    default: stepFinish(body, root); break;
  }

  mount(root, wizard);
}

function stepper() {
  const wrap = el('div', { class: 'steps', role: 'list' });
  STEPS.forEach((label, i) => {
    const state = i < draft.step ? 'done' : i === draft.step ? 'active' : 'todo';
    mount(wrap, el('div', { class: 'step', dataset: { state }, role: 'listitem' },
      el('span', { class: 'step__dot' }, state === 'done' ? icon('check') : String(i + 1)),
      el('span', { class: 'step__label' }, label)));
    if (i < STEPS.length - 1) mount(wrap, el('div', { class: 'step__bar' }));
  });
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Step 1 — organization
 * ------------------------------------------------------------------ */

function stepOrg(body, root) {
  const nameInput = el('input', {
    class: 'input', type: 'text', value: draft.orgName,
    placeholder: 'e.g. AFROTC Detachment 025',
    autocomplete: 'organization',
    oninput: (e) => { draft.orgName = e.target.value; next.disabled = !draft.orgName.trim(); },
  });

  mount(body, 
    el('h2', { class: 'section-title' }, 'Who is this installation for?'),
    field('Organization name', nameInput, {
      required: true,
      hint: 'Shown in the app header and stamped on exported reports.',
    }),
    notice('info', 'Your data stays yours',
      el('p', {}, `${APP.name} has no server. Every record is written to storage you control, `
        + 'under an account your detachment owns. Nothing is sent anywhere else.')),
  );

  const next = el('button', {
    type: 'button', class: 'btn btn--primary', disabled: !draft.orgName.trim(),
    onclick: () => { draft.step = 1; draw(root); },
  }, 'Continue');

  mount(body, el('div', { class: 'row row--end', style: { marginTop: 'var(--sp-5)' } }, next));
  setTimeout(() => nameInput.focus(), 40);
}

/* ------------------------------------------------------------------ *
 * Step 2 — pick a backend
 * ------------------------------------------------------------------ */

function stepBackend(body, root) {
  const options = [
    {
      id: BACKENDS.drive,
      iconName: 'cloud',
      title: 'Google Drive (recommended)',
      desc: 'Connects to your detachment\'s Google account over the Drive API. '
        + 'Works on phones, tablets and computers, and every device sees the same data.',
      available: adapters.drive.isAvailable(),
      unavailableReason: 'Requires a secure (https) connection.',
    },
    {
      id: BACKENDS.folder,
      iconName: 'folder',
      title: 'Synced Drive folder on this computer',
      desc: 'Points at the 9ThirtyOne folder inside Google Drive for Desktop. '
        + 'Google\'s own client handles syncing. Desktop Chrome or Edge only.',
      available: adapters.folder.isAvailable(),
      unavailableReason: 'This browser cannot open local folders — use Chrome or Edge on a computer.',
    },
    {
      id: BACKENDS.local,
      iconName: 'device',
      title: 'This device only',
      desc: 'Stores everything in this browser. Nothing syncs and nothing is shared. '
        + 'Good for trying the app out before the Google account exists.',
      available: adapters.local.isAvailable(),
      unavailableReason: 'Browser storage is unavailable.',
    },
  ];

  const list = el('div', { class: 'choice-list' });
  for (const option of options) {
    const input = el('input', {
      type: 'radio', name: 'backend', value: option.id,
      checked: draft.backend === option.id,
      disabled: !option.available,
      onchange: () => { draft.backend = option.id; next.disabled = false; },
    });
    mount(list, el('label', { class: 'choice' },
      input,
      el('span', { class: 'choice__mark', 'aria-hidden': 'true' }),
      el('div', {},
        el('div', { class: 'row' }, icon(option.iconName), el('span', { class: 'choice__title' }, option.title)),
        el('div', { class: 'choice__desc' },
          option.available ? option.desc : `${option.desc} — unavailable: ${option.unavailableReason}`))));
  }

  mount(body, 
    el('h2', { class: 'section-title' }, 'Where should the database live?'),
    el('p', { class: 'muted', style: { marginTop: 'calc(-1 * var(--sp-2))' } },
      'You can change this later in Settings, and export your data first if you do.'),
    list,
  );

  const next = el('button', {
    type: 'button', class: 'btn btn--primary', disabled: !draft.backend,
    onclick: () => { draft.step = 2; draft.connected = false; draw(root); },
  }, 'Continue');

  mount(body, el('div', { class: 'row row--end', style: { marginTop: 'var(--sp-5)' } },
    el('button', { type: 'button', class: 'btn', onclick: () => { draft.step = 0; draw(root); } }, 'Back'),
    next));
}

/* ------------------------------------------------------------------ *
 * Step 3 — connect
 * ------------------------------------------------------------------ */

function stepConnect(body, root) {
  if (draft.backend === BACKENDS.drive) return connectDrive(body, root);
  if (draft.backend === BACKENDS.folder) return connectFolder(body, root);
  return connectLocal(body, root);
}

/**
 * The Drive step: sign in, and let the app make its own folder.
 *
 * This used to ask for a link to a folder created by hand in Drive. It cannot
 * any more, and the reason is worth knowing before anyone tries to put the field
 * back: the app asks Google only for `drive.file`, which grants access to files
 * **this app created** and nothing else. A folder made by hand is invisible
 * under that scope — Google returns "not found" for it, however obviously it
 * exists in the browser tab next door.
 *
 * The alternative was `auth/drive`, full access to everything in the account,
 * which Google classes as restricted: verification plus an annual paid security
 * assessment, for a free tool that only ever touches one folder. Creating the
 * folder is the cheaper half of that trade and the more honest permission to ask
 * a detachment for.
 */
function connectDrive(body, root) {
  const status = el('div');

  const clientInput = el('input', {
    class: 'input mono', type: 'text', value: draft.clientId,
    placeholder: '000000000000-abc123.apps.googleusercontent.com',
    spellcheck: 'false', autocapitalize: 'off',
    oninput: (e) => { draft.clientId = e.target.value.trim(); draft.connected = false; refresh(); },
  });

  const createBtn = el('button', { type: 'button', class: 'btn btn--primary', onclick: doConnect },
    icon('cloud'), 'Sign in and set up the folder');

  const nextBtn = el('button', {
    type: 'button', class: 'btn btn--primary', disabled: !draft.connected,
    onclick: () => { draft.step = 3; draw(root); },
  }, 'Continue');

  function refresh() {
    createBtn.disabled = !draft.clientId || draft.connected;
    nextBtn.disabled = !draft.connected;
    clear(status);
    if (draft.connected) {
      mount(status, notice('ok', draft.reused
        ? `Using "${draft.folderName}", which was already in your Drive`
        : `Created "${draft.folderName}" in your Drive`,
        el('p', {}, draft.reused
          ? 'Nothing was created and nothing was overwritten — this is the folder as you left '
            + 'it. Its address is below; you will need it for the submission server.'
          : 'Every record lives here. Its address is below — you will need it in a '
            + 'moment for the submission server, and it is worth keeping somewhere.'),
        el('p', { class: 'mono', style: { wordBreak: 'break-all' } }, draft.folderId),
        el('div', { class: 'row row--wrap' },
          el('a', {
            class: 'btn btn--sm', target: '_blank', rel: 'noopener',
            href: `https://drive.google.com/drive/folders/${draft.folderId}`,
          }, icon('external'), 'Open it in Drive'),
          el('button', {
            type: 'button', class: 'btn btn--sm',
            onclick: () => {
              navigator.clipboard?.writeText(draft.folderId);
              toast('Folder ID copied.', 'ok');
            },
          }, icon('copy'), 'Copy the folder ID'))));
    }
  }

  /** Adopts a folder this app made earlier, without creating anything. */
  async function useExisting(folder) {
    createBtn.disabled = true;
    remount(status, spinner(`Opening "${folder.name}"…`));
    try {
      db.use(BACKENDS.drive, { clientId: draft.clientId, folderId: folder.id });
      const result = await adapters.drive.connect({ interactive: true });
      if (!result.ok) throw new Error(result.detail || describeConnectFailure(result.reason));
      draft.folderId = folder.id;
      draft.folderName = result.folderName || folder.name;
      draft.connected = true;
      draft.reused = true;
      toast(`Using the existing "${draft.folderName}".`, 'ok');
    } catch (err) {
      draft.connected = false;
      remount(status, notice('danger', 'Could not open that folder', el('p', {}, err.message)));
      createBtn.disabled = false;
      nextBtn.disabled = true;
      return;
    }
    refresh();
  }

  /** Creates a new root. Only ever reached by an explicit choice. */
  async function doCreate() {
    createBtn.disabled = true;
    remount(status, spinner('Talking to Google…'));
    try {
      db.use(BACKENDS.drive, { clientId: draft.clientId, folderId: '' });
      const result = await adapters.drive.createRoot(DB_LAYOUT.root);
      if (!result.ok) throw new Error(describeConnectFailure(result.reason));
      draft.folderId = result.folderId;
      draft.folderName = result.folderName || DB_LAYOUT.root;
      db.use(BACKENDS.drive, { clientId: draft.clientId, folderId: draft.folderId });
      draft.connected = true;
      draft.reused = false;
      toast('Folder created in your Drive.', 'ok');
    } catch (err) {
      draft.connected = false;
      remount(status, notice('danger', 'Could not create the folder', el('p', {}, err.message)));
      createBtn.disabled = false;
      nextBtn.disabled = true;
      return;
    }
    refresh();
  }

  /**
   * Sign in, then look before creating.
   *
   * This step used to be a single unconditional create, which made re-running
   * setup the one thing a stranded detachment must never do: it produced a new
   * empty folder every time and left the records in the previous one. The app
   * then reported an empty roster, which reads exactly like the failure that sent
   * someone back to setup in the first place.
   *
   * The choice is never made automatically. Adopting a folder silently would be
   * wrong for a det deliberately standing up a second detachment, and picking the
   * newest would have chosen the empty one in every case that has actually gone
   * wrong so far.
   */
  async function doConnect() {
    createBtn.disabled = true;
    remount(status, spinner('Talking to Google…'));
    let found;
    try {
      db.use(BACKENDS.drive, { clientId: draft.clientId, folderId: '' });
      found = await adapters.drive.findRoots(DB_LAYOUT.root);
      if (!found.ok) throw new Error(describeConnectFailure(found.reason));
    } catch (err) {
      remount(status, notice('danger', 'Could not reach Google Drive', el('p', {}, err.message)));
      createBtn.disabled = false;
      return;
    }

    if (!found.folders.length) return doCreate();

    remount(status, notice('warn',
      found.folders.length === 1
        ? 'This app has already made a folder for this account'
        : `This app has already made ${found.folders.length} folders for this account`,
      el('p', {}, 'Your records are in one of these. Creating another would leave them where '
        + 'they are and start an empty detachment — so pick the one you already use, unless you '
        + 'are deliberately setting up a second.'),
      el('div', { class: 'stack-sm', style: { marginTop: 'var(--sp-3)' } },
        ...found.folders.map((folder) => el('div', { class: 'row row--wrap' },
          el('div', { style: { flex: '1 1 12rem' } },
            el('div', { style: { fontWeight: '570' } }, folder.name),
            el('div', { class: 'faint' }, `Created ${fmtDate(folder.createdTime)}`),
            el('div', { class: 'faint mono', style: { wordBreak: 'break-all' } }, folder.id)),
          el('button', {
            type: 'button', class: 'btn btn--primary btn--sm',
            onclick: () => useExisting(folder),
          }, icon('check'), 'Use this one')))),
      el('div', { class: 'row row--wrap', style: { marginTop: 'var(--sp-3)' } },
        el('button', { type: 'button', class: 'btn btn--sm', onclick: doCreate },
          icon('plus'), 'Create a new folder anyway'))));
    createBtn.disabled = false;
  }

  mount(body,
    el('h2', { class: 'section-title' }, 'Connect your detachment\'s Google Drive'),
    notice('info', 'Sign in as the account that will own the records',
      el('p', {}, '9ThirtyOne is a verified Google application, registered once for every '
        + 'detachment. There is no Cloud project to create, no consent screen to configure and '
        + 'no client ID to paste — this used to be twenty minutes of setup and is now none.'),
      el('p', {}, 'Google will ask your permission before the app touches this account\'s '
        + 'Drive. It asks only for files it creates itself.')),
    // The Client ID is correct out of the box, so it is not a step. It stays
    // reachable because config.js promises a stored value overrides the shared
    // one — for anyone running their own copy, or a detachment that registered
    // its own client before the programme moved to one.
    el('details', { class: 'disclosure' },
      el('summary', {}, 'Advanced — use a different Google client'),
      field('OAuth Client ID', clientInput, {
        hint: 'Leave this alone unless you are running your own copy of the app against your '
          + 'own Google registration. Replacing it with anything else will stop sign-in working.',
      })),
    notice('info', 'The app makes its own folder',
      el('p', {}, 'You do not need to create anything in Drive first. This app can only see '
        + 'files it made itself — it has no access to the rest of your Drive and cannot ask '
        + 'for any — so it creates its own folder and works inside that.')),
    el('div', { class: 'row row--wrap' }, createBtn),
    status,
    el('div', { class: 'row row--end', style: { marginTop: 'var(--sp-5)' } },
      el('button', { type: 'button', class: 'btn', onclick: () => { draft.step = 1; draw(root); } }, 'Back'),
      nextBtn),
  );
  refresh();
}

function connectFolder(body, root) {
  const status = el('div');
  const nextBtn = el('button', {
    type: 'button', class: 'btn btn--primary', disabled: !draft.connected,
    onclick: () => { draft.step = 3; draw(root); },
  }, 'Continue');

  async function choose() {
    try {
      const { name } = await adapters.folder.chooseFolder();
      draft.folderName = name;
      draft.folderId = 'root-folder';
      draft.connected = true;
      db.use(BACKENDS.folder);
      nextBtn.disabled = false;
      remount(status, notice('ok', `Folder selected: ${name}`,
        el('p', {}, 'The app will read and write JSON files here. Google Drive for Desktop syncs them.')));
    } catch (err) {
      if (err.name === 'AbortError') return;
      remount(status, notice('danger', 'Could not open that folder', el('p', {}, err.message)));
    }
  }

  mount(body, 
    el('h2', { class: 'section-title' }, 'Choose the synced folder'),
    notice('warn', 'Before you continue',
      el('p', {}, 'Install ', el('strong', {}, 'Google Drive for Desktop'), ', sign in to the detachment account, '
        + `and create a folder named ${DB_LAYOUT.root} inside the synced drive. Then select that folder below.`)),
    el('div', { class: 'row row--wrap' },
      el('button', { type: 'button', class: 'btn btn--primary', onclick: choose }, icon('folder'), 'Select folder…')),
    status,
    el('div', { class: 'row row--end', style: { marginTop: 'var(--sp-5)' } },
      el('button', { type: 'button', class: 'btn', onclick: () => { draft.step = 1; draw(root); } }, 'Back'),
      nextBtn),
  );
}

function connectLocal(body, root) {
  draft.connected = true;
  draft.folderName = 'This device';
  db.use(BACKENDS.local);
  mount(body, 
    el('h2', { class: 'section-title' }, 'Use this device only'),
    notice('warn', 'Nothing will sync',
      el('p', {}, 'Records live in this browser\'s storage. Other devices will not see them, and clearing '
        + 'site data erases them. Export a backup from Settings regularly, and switch to Google Drive '
        + 'once the detachment account exists — your export imports straight in.')),
    el('div', { class: 'row row--end', style: { marginTop: 'var(--sp-5)' } },
      el('button', { type: 'button', class: 'btn', onclick: () => { draft.step = 1; draw(root); } }, 'Back'),
      el('button', {
        type: 'button', class: 'btn btn--primary',
        onclick: () => { draft.step = 3; draw(root); },
      }, 'Continue')),
  );
}

/* ------------------------------------------------------------------ *
 * Step 4 — build the folder tree
 * ------------------------------------------------------------------ */

function stepFinish(body, root) {
  const status = el('div');
  const finishBtn = el('button', { type: 'button', class: 'btn btn--primary btn--lg', onclick: finish },
    icon('check'), 'Create folders and finish');

  async function finish() {
    finishBtn.disabled = true;
    remount(status, spinner('Creating folders…'));
    try {
      connection.set({
        backend: draft.backend,
        orgName: draft.orgName.trim(),
        folderId: draft.folderId,
        folderName: draft.folderName,
        folderUrl: draft.backend === BACKENDS.drive
          ? `https://drive.google.com/drive/folders/${draft.folderId}` : '',
        // Only the Drive backend needs Google. Storing the shared client on a
        // *This device only* install would leave it with a Client ID it never
        // uses, and that is exactly the condition the email sign-in option keys
        // off — so a local trial would silently lose its only way in.
        clientId: draft.backend === BACKENDS.drive ? draft.clientId : '',
        connectedAt: new Date().toISOString(),
      });
      db.use(draft.backend, { clientId: draft.clientId, folderId: draft.folderId });
      await db.initialize({ orgName: draft.orgName.trim(), seed: true });
      markSetupComplete(true);
      resetSetupDraft();
      toast('Setup complete.', 'ok');
      navigate('/home');
    } catch (err) {
      remount(status, notice('danger', 'Setup could not finish', el('p', {}, err.message)));
      finishBtn.disabled = false;
    }
  }

  mount(body, 
    el('h2', { class: 'section-title' }, 'Ready to build the database'),
    el('p', { class: 'muted' }, 'These folders will be created if they do not already exist. '
      + 'Existing data is left untouched, so it is safe to point a second device at the same folder.'),
    el('pre', { class: 'tree' }, FOLDER_TREE_PREVIEW),
    el('dl', { class: 'stack-sm' },
      summaryRow('Organization', draft.orgName),
      summaryRow('Storage', adapters[draft.backend]?.label || draft.backend),
      summaryRow('Location', draft.folderName || '—')),
    status,
    el('div', { class: 'row row--end', style: { marginTop: 'var(--sp-5)' } },
      el('button', { type: 'button', class: 'btn', onclick: () => { draft.step = 2; draw(root); } }, 'Back'),
      finishBtn),
  );
}

function summaryRow(label, value) {
  return el('div', { class: 'row row--between' },
    el('dt', { class: 'muted' }, label),
    el('dd', { style: { fontWeight: '570' } }, value));
}

function describeConnectFailure(reason) {
  const reasons = {
    auth: 'Google sign-in did not complete.',
    'no-folder': 'Enter the Drive folder link first.',
    'not-a-folder': 'That link points at a file, not a folder.',
    'read-only': 'This account cannot write to that folder.',
    permission: 'Permission to the folder was denied.',
    'no-handle': 'No folder has been selected.',
  };
  return reasons[reason] || 'The connection could not be verified.';
}
