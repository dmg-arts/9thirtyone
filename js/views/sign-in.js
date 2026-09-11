/**
 * The sign-in screen. One screen for cadets, instructors and administrators.
 *
 * There is nothing to type. A detachment already runs on Google accounts — the
 * det's drives are shared to them, and cadets read det mail through Gmail
 * whatever their school address says — so this app reuses that identity instead
 * of issuing a second one. What differs by role is only which roster entry the
 * signed-in email matches.
 *
 * The roster is the gate. Being able to sign in with Google proves who you are;
 * it does not grant access. Access is your email appearing in `users/users.json`
 * with the role the screen asked for, which is an administrator's decision.
 */

import { el, icon, field, notice, toast, remount } from '../util.js';
import { ROLES, isDirectSignIn } from '../config.js';
import { signInWithGoogle, signInAsDeveloper, hasAnyAccount } from '../auth.js';
import { renderSignInButton } from '../google-identity.js';
import { connection } from '../state.js';
import { navigate } from '../router.js';

// Keyed by every role that can reach this screen. The Cadre Panel calls
// renderLogin with ROLES.cadre and the commander's space with ROLES.commander
// (see panels.js), and while those keys were missing a refusal on either
// rendered an empty paragraph — the person was told no, and not told why.
const SUBTITLES = {
  [ROLES.student]: 'Use the Google account your detachment mails you at.',
  [ROLES.instructor]: 'Sign in with the Google account on your detachment\'s roster.',
  [ROLES.cadre]: 'Sign in with the Google account on your detachment\'s roster.',
  [ROLES.commander]: 'Sign in with the Google account on your detachment\'s roster.',
  [ROLES.admin]: 'Sign in with the Google account on your detachment\'s roster.',
};

const DENIED_HELP = {
  [ROLES.student]: 'Ask your cadre — cadets are added to the roster by an administrator.',
  [ROLES.instructor]: 'Ask your database administrator to give this account the instructor role.',
  [ROLES.cadre]: 'Ask your database administrator to give this account the cadre role.',
  [ROLES.commander]: 'The commander role is held by at most two people and is granted by a '
    + 'database administrator.',
  [ROLES.admin]: 'Ask an existing administrator to add this account.',
};

/**
 * Renders the gate and calls `onSuccess(account)` once the signed-in email
 * matches a roster entry holding `role`.
 *
 * @param {HTMLElement} root
 * @param {string} role      one of ROLES
 * @param {string} title     page heading
 * @param {(account: object) => any} onSuccess
 */
export async function renderLogin(root, role, title, onSuccess) {
  const clientId = connection.get().clientId;
  const buttonHost = el('div', { class: 'row', style: { justifyContent: 'center' } });
  const error = el('div', { class: 'stack-sm', hidden: true });
  const hint = el('div', {});

  // The "ask an administrator for the role" hint belongs under a roster refusal
  // and nowhere else. Stapled under every failure, it sent an expired-token
  // deadlock looking like a missing role — the screen named a cause it had no
  // evidence for, and the real message above it was read as noise.
  const isRosterRefusal = (message) => /roster|does not have|deactivated/i.test(message);

  const fail = (message) => {
    remount(error, notice('danger', 'Not signed in',
      el('p', {}, message),
      isRosterRefusal(message) ? el('p', { class: 'field__hint' }, DENIED_HELP[role]) : null));
    error.hidden = false;
  };

  const finish = (account) => {
    toast(`Signed in as ${account.name}.`, 'ok', 2500);
    onSuccess(account);
  };

  /**
   * Says what is happening when the first attempt times out.
   *
   * People press a button again when it gives them nothing back, and the setup
   * guide asking them not to is no substitute for the screen saying something.
   * An idle Apps Script deployment takes a few seconds to wake, and that wait
   * used to be indistinguishable from a dead button.
   */
  const waking = () => {
    remount(error, notice('info', 'Waking your detachment\'s server',
      el('p', {}, 'It sleeps when nobody has used it for a while, so the first sign-in of '
        + 'the day takes a few seconds. Trying again — no need to press anything.')));
    error.hidden = false;
  };

  async function accept(profile, rawToken = null) {
    error.hidden = true;
    try {
      finish(await signInWithGoogle(profile, role, rawToken, { onSlow: waking }));
    } catch (err) {
      fail(err.message);
    }
  }

  remount(root, el('div', { class: 'wizard stack' },
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, title),
      el('p', { class: 'page-sub' }, SUBTITLES[role] || SUBTITLES[ROLES.admin])),

    el('div', { class: 'card stack' },
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('span', { class: 'role-card__icon' }, icon(role === ROLES.student ? 'student' : 'lock'))),
      buttonHost,
      error,
      el('p', { class: 'field__hint' },
        'This app issues no password of its own. Whether you can get in is decided by your '
        + 'detachment\'s roster, which an administrator keeps.'),
      // Said before the Google account is handed over rather than after, and
      // said in one sentence, because that is the point at which somebody
      // deciding whether to trust this needs the answer.
      el('p', { class: 'field__hint' },
        'Your feedback stays in your detachment\'s own Google Drive. Nothing is sent to '
        + 'whoever makes this app. ',
        el('a', { href: './privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy policy'),
        ' \u00b7 ',
        el('a', { href: './terms.html', target: '_blank', rel: 'noopener' }, 'Terms of service')),
      hint),

    el('div', { class: 'row', style: { justifyContent: 'center' } },
      el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => navigate('/home') },
        icon('arrowLeft'), 'Back to home'))));

  // An empty roster means the first person through the door claims it. Only
  // worth saying on the admin screen — that is where a new detachment starts.
  if (role === ROLES.admin) {
    hasAnyAccount().then((exists) => {
      if (exists) return;
      remount(hint, notice('info', 'This detachment has no roster yet',
        el('p', {}, 'The first Google account to sign in becomes the administrator and can add '
          + 'everyone else. Make sure that is you.')));
    }).catch(() => {});
  }

  if (!clientId) {
    remount(buttonHost, el('div', { class: 'stack' },
      notice('warn', 'Google sign-in is not configured',
        el('p', {}, 'This installation has no Google Client ID, so nobody can sign in yet. '
          + 'Add one in Settings, or re-run setup.'),
        // Worth saying here, because this screen is where someone who has lost a
        // working install lands, and "re-run setup" used to be the advice that
        // stranded them: it made a new empty folder every time. It now looks for
        // the folder first and offers it back, so the sentence above is safe to
        // follow.
        el('p', {}, 'If this detachment already had a folder, setup will find it and offer to '
          + 'use it — it will not start an empty one behind your back.'),
        el('div', { style: { marginTop: 'var(--sp-3)' } },
          el('button', { type: 'button', class: 'btn btn--sm', onclick: () => navigate('/settings') },
            icon('settings'), 'Open Settings'))),
      isDirectSignIn() ? developerSignIn(role, finish, fail) : null));
    return;
  }

  try {
    await renderSignInButton(buttonHost, {
      clientId,
      onCredential: (profile, raw) => accept(profile, raw),
      onError: (err) => fail(err.message),
    });
  } catch (err) {
    remount(buttonHost, notice('danger', 'Could not start Google sign-in', el('p', {}, err.message)));
  }

  // An empty roster means the first person through the door claims it. Only
  // worth saying on the admin screen — that is where a new detachment starts.
  if (role === ROLES.admin) {
    hasAnyAccount().then((exists) => {
      if (exists) return;
      remount(hint, notice('info', 'This detachment has no roster yet',
        el('p', {}, 'The first Google account to sign in becomes the administrator and can add '
          + 'everyone else. Make sure that is you.')));
    }).catch(() => {});
  }
}

/**
 * The developer-mode fallback: type an email, get signed in as it.
 *
 * Shown only when there is no Google Client ID *and* developer mode is on, so
 * it cannot appear in a fielded, Drive-backed installation. It is labelled
 * bluntly on purpose — anyone who sees this box should understand that the
 * screen is not checking anything.
 */
function developerSignIn(role, finish, fail) {
  const input = el('input', {
    class: 'input mono', type: 'email', placeholder: 'you@example.edu',
    autocapitalize: 'off', spellcheck: 'false',
    onkeydown: (e) => { if (e.key === 'Enter') go(); },
  });
  const button = el('button', { type: 'button', class: 'btn btn--block', onclick: () => go() },
    icon('unlock'), 'Sign in without Google');

  async function go() {
    button.disabled = true;
    try {
      finish(await signInAsDeveloper(input.value, role));
    } catch (err) {
      fail(err.message);
    } finally {
      button.disabled = false;
    }
  }

  return el('div', { class: 'card stack', style: { borderStyle: 'dashed' } },
    el('div', { class: 'eyebrow' }, 'Developer mode'),
    el('p', { class: 'field__hint' },
      'This box verifies nothing. It exists so the app can be run and tested away from '
      + 'Google Drive, and it disappears once a Client ID is set.'),
    field('Email', input),
    button);
}
