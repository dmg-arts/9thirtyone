/**
 * The join screen — what a cadet sees when they tap a join link.
 *
 * This replaces the four-step setup wizard for everyone who is not the person
 * who set the detachment up. It asks for nothing, because everything it needs
 * arrived in the link.
 *
 * It deliberately does *not* call `db.initialize()`. The wizard does, because
 * the wizard creates a detachment. A joining device is arriving at a folder that
 * already exists, and a cadet's phone has no business creating folder structure
 * or writing an org record. If `config/org.json` is missing, that means no
 * administrator has run setup yet, and the honest answer is to say so rather
 * than quietly repair it.
 */

import {
  el, icon, notice, toast, remount,
} from '../util.js';
import { APP, BACKENDS } from '../config.js';
import { connection, markSetupComplete, isConfigured } from '../state.js';
import { clearCache } from '../storage/index.js';
import { parseJoinParams } from '../join.js';
import { navigate } from '../router.js';

export async function renderJoin(root, { query }) {
  const config = parseJoinParams(query);

  if (!config) {
    return remount(root, el('div', { class: 'wizard stack' },
      el('div', { class: 'page-head' },
        el('h1', { class: 'page-title' }, 'That link is incomplete')),
      notice('danger', 'This join link is missing something',
        el('p', {}, 'A join link carries the Google Client ID and the Drive folder it belongs to. '
          + 'This one does not have both, so it was probably truncated somewhere between being '
          + 'sent and being opened — mail clients and chat apps sometimes cut long links.'),
        el('p', {}, 'Ask whoever sent it for the full link, or set this device up by hand.')),
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('button', { type: 'button', class: 'btn', onclick: () => navigate('/setup') },
          icon('settings'), 'Set up manually'))));
  }

  if (config.proxyRejected) {
    return remount(root, el('div', { class: 'wizard stack' },
      el('div', { class: 'page-head' },
        el('h1', { class: 'page-title' }, 'That link is not safe to use')),
      notice('danger', 'The submission server in this link is not a Google address',
        el('p', {}, 'A join link tells this device where to send your feedback and your sign-in. '
          + 'This one names somewhere that is not your detachment\'s Google server, so it has '
          + 'not been used.'),
        el('p', {}, 'If you were sent this link by your detachment, tell them — the link is '
          + 'malformed. If you were not, delete it.')),
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('button', { type: 'button', class: 'btn', onclick: () => navigate('/home') },
          icon('arrowLeft'), 'Back to home'))));
  }

  const current = connection.get();
  const alreadyHere = isConfigured()
    && current.backend === BACKENDS.drive
    && current.folderId === config.folderId;

  if (alreadyHere) {
    return remount(root, el('div', { class: 'wizard stack' },
      el('div', { class: 'page-head' },
        el('h1', { class: 'page-title' }, 'Already set up'),
        el('p', { class: 'page-sub' },
          `This device is connected to ${current.orgName || 'this detachment'} already.`)),
      notice('ok', 'Nothing to do',
        el('p', {}, 'You can go straight to your feedback.')),
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('button', { type: 'button', class: 'btn btn--primary btn--lg', onclick: () => navigate('/student') },
          icon('student'), 'Open my feedback'),
        el('button', { type: 'button', class: 'btn', onclick: () => navigate('/home') },
          'Home'))));
  }

  const viaProxy = Boolean(config.proxyUrl);
  const switching = isConfigured() && current.folderId && current.folderId !== config.folderId;

  /**
   * A link claiming this detachment but naming a different submission server.
   *
   * This is the shape the attack takes in practice: send the whole detachment a
   * link that looks like theirs — right folder, right name — but points the
   * filing at somewhere else. Every device that follows it keeps working, and
   * hands a valid Google token to a stranger on each use.
   *
   * A genuine change of server does happen, when a detachment redeploys the
   * script. It is rare, an administrator knows they did it, and re-running setup
   * is the right way to apply it. Refusing here costs that administrator a
   * couple of minutes and costs an attacker the whole approach.
   */
  const repointing = isConfigured()
    && current.folderId === config.folderId
    && Boolean(current.proxyUrl)
    && current.proxyUrl !== config.proxyUrl;

  if (repointing) {
    return remount(root, el('div', { class: 'wizard stack' },
      el('div', { class: 'page-head' },
        el('h1', { class: 'page-title' }, 'This link does not match your setup')),
      notice('danger', 'It names a different submission server',
        el('p', {}, 'This device is already set up for '
          + `${current.orgName || 'this detachment'}, and this link points the filing of your `
          + 'feedback somewhere other than where it currently goes. It has not been used.'),
        el('p', {}, 'If your detachment has just moved its server, an administrator should say '
          + 'so and you can run setup again. If nobody has told you about a change, do not use '
          + 'this link and tell your cadre where it came from.')),
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('button', { type: 'button', class: 'btn', onclick: () => navigate('/student') },
          icon('student'), 'Open my feedback'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => navigate('/home') },
          'Home'))));
  }
  const status = el('div', {});
  const joinBtn = el('button', {
    type: 'button', class: 'btn btn--primary btn--block btn--lg', onclick: () => join(),
  }, icon('check'), switching ? 'Switch to this detachment' : 'Continue');

  async function join() {
    joinBtn.disabled = true;

    // Through a proxy there is nothing to connect to. The cadet has no Drive
    // access by design, so asking Google for the Drive scope would request a
    // permission they neither need nor can use — and would put the alarming
    // full-Drive consent screen in front of them for no reason. Store the
    // configuration and let the ordinary sign-in gate identify them.
    if (viaProxy) {
      connection.set({
        backend: BACKENDS.drive,
        orgName: config.orgName || 'Detachment',
        folderId: config.folderId,
        folderName: '',
        folderUrl: '',
        clientId: config.clientId,
        proxyUrl: config.proxyUrl,
        connectedAt: new Date().toISOString(),
      });
      markSetupComplete(true);
      // A different folder means every cached record belongs to somewhere else.
      clearCache();
      toast('Ready. Sign in to see your feedback.', 'ok');
      return navigate('/student');
    }

    // Without a proxy there is nothing this device can legitimately reach.
    //
    // The app holds `drive.file`, which grants access to files it created
    // itself. The detachment's folder was created by the administrator's
    // browser, not by this one, so Google will not open it here however
    // correctly the link is formed. Before the proxy existed this screen asked
    // Google for full Drive access instead, which worked and was the reason
    // every cadet could read every response in the folder.
    //
    // So this is refused rather than attempted: a failure here would surface as
    // "folder not found", which reads like a broken link and is not.
    remount(status, notice('danger', 'This detachment has no submission server yet',
      el('p', {}, 'A join link can only set up this device once the detachment has deployed '
        + 'its submission server. Without one there is nothing for a cadet\'s device to '
        + 'connect to — and it would need permission over the whole of your Google Drive '
        + 'to try, which this app does not ask for.'),
      el('p', {}, 'Tell whoever sent you this link that Part 6 of the setup guide is '
        + 'outstanding. It takes about fifteen minutes at their end and nothing at yours.')));
    joinBtn.disabled = false;
  }

  remount(root, el('div', { class: 'wizard stack' },
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' },
        config.orgName ? `Join ${config.orgName}` : `Join your detachment`),
      el('p', { class: 'page-sub' },
        `This sets up ${APP.name} on this device. There is nothing to type.`)),

    switching ? notice('warn', 'This device is set up for a different detachment',
      el('p', {}, `It currently points at ${current.orgName || 'another folder'}. `
        + 'Continuing switches it to this one. Nothing is deleted — the other detachment\'s '
        + 'records stay in their own Drive folder.')) : null,

    el('div', { class: 'card stack' },
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('span', { class: 'role-card__icon' }, icon('cloud'))),

      viaProxy
        ? el('p', {}, 'Next you will sign in with Google, and that is all. '
          + `${APP.name} never asks for access to your Google Drive — your detachment's `
          + 'server handles the filing.')
        : el('p', {}, 'When you continue, Google will ask you to sign in and to let '
          + `${APP.name} use your Drive. Two things worth knowing before you tap it:`),

      // Left as a plain block list on purpose: flex and grid both blockify their
      // children, which silently drops the bullets.
      el('ul', { style: { paddingLeft: '1.25rem', margin: '0', listStyle: 'disc' } },
        el('li', { style: { marginBottom: 'var(--sp-2)' } },
          'Use the Google account your detachment mails you at — that is the one on the roster.'),
        viaProxy ? null : el('li', {},
          'Google will warn that this app has not been verified. That is expected. Choose ',
          el('strong', {}, 'Advanced'), ', then continue.')),

      // Named before the button, not after it. This is the one thing in the
      // link that decides where a cadet's answers and sign-in end up, and it
      // arrived from whoever sent the link.
      viaProxy ? el('div', { class: 'notice notice--info' },
        el('div', {},
          el('strong', { class: 'notice__title' }, 'Your feedback will be sent here'),
          el('p', { class: 'mono', style: { wordBreak: 'break-all', margin: '0 0 var(--sp-2)' } },
            config.proxyUrl),
          el('p', { style: { margin: '0' } },
            'This should be your own detachment\'s server. If you did not get this link '
            + 'from your detachment, do not continue.'))) : null,

      joinBtn,
      status,

      el('p', { class: 'field__hint' },
        'This link does not give anyone access on its own. Whether you can get in is decided by '
        + 'your detachment\'s roster.')),

    el('div', { class: 'row', style: { justifyContent: 'center' } },
      el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => navigate('/home') },
        icon('arrowLeft'), 'Back to home'))));
}
