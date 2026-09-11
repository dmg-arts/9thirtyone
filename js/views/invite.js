/**
 * The join QR code, full screen.
 *
 * Its purpose is to be pointed at by a room. An instructor opens it on a laptop
 * plugged into a projector, or holds up a phone, and cadets scan it — which is
 * the fastest way to get a 180-character URL into thirty phones without anyone
 * typing.
 *
 * Three things it has to get right, all of them scanning requirements rather
 * than aesthetics:
 *
 *   - **Size.** The code scales to whichever of the viewport's dimensions is
 *     smaller, so it fills a phone held in portrait and a projector in landscape
 *     without either cropping it or leaving it postage-stamp sized.
 *   - **Contrast.** Absolute black on absolute white, never the theme's colours.
 *     A QR code rendered in dark mode is a QR code that does not scan.
 *   - **The quiet zone.** Four light modules all the way round, which the
 *     encoder includes. Scanners use it to find the code's edges, and its
 *     absence is the most common reason a code that looks fine fails.
 */

import { el, icon, notice, toast, remount } from '../util.js';
import { ROLES } from '../config.js';
import { connection } from '../state.js';
import { hasRole } from '../auth.js';
import { buildJoinLink } from '../join.js';
import { renderQrSvg } from '../qr.js';
import { renderLogin } from './sign-in.js';
import { navigate, back } from '../router.js';

export async function renderInvite(root) {
  if (!hasRole(ROLES.admin)) {
    return renderLogin(root, ROLES.admin, 'Database Administration',
      () => renderInvite(root));
  }

  const conn = connection.get();
  const goBack = () => back('/admin');

  let link;
  try {
    link = buildJoinLink({
      clientId: conn.clientId,
      folderId: conn.folderId,
      orgName: conn.orgName,
      proxyUrl: conn.proxyUrl,
    });
  } catch (err) {
    return remount(root, el('div', { class: 'wizard stack' },
      el('div', { class: 'page-head' },
        el('h1', { class: 'page-title' }, 'No join link yet')),
      notice('warn', 'This installation cannot make a join link', el('p', {}, err.message)),
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('button', { type: 'button', class: 'btn', onclick: goBack },
          icon('arrowLeft'), 'Back'))));
  }

  let code;
  try {
    code = renderQrSvg(link, { title: `Join ${conn.orgName || 'this detachment'}` });
  } catch (err) {
    return remount(root, el('div', { class: 'wizard stack' },
      el('div', { class: 'page-head' },
        el('h1', { class: 'page-title' }, 'Could not draw the code')),
      notice('danger', 'The join link could not be encoded', el('p', {}, err.message)),
      el('div', { class: 'row', style: { justifyContent: 'center' } },
        el('button', { type: 'button', class: 'btn', onclick: goBack },
          icon('arrowLeft'), 'Back'))));
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Join link copied.', 'ok');
    } catch {
      toast('Could not copy — the link is written below the code.', 'warn', 6000);
    }
  };

  remount(root, el('div', { class: 'qr-screen' },
    el('div', { class: 'qr-screen__head' },
      el('button', {
        type: 'button', class: 'btn btn--ghost', onclick: goBack,
      }, icon('arrowLeft'), 'Back'),
      el('div', { class: 'qr-screen__title' },
        el('div', { class: 'eyebrow' }, 'Scan to join'),
        el('h1', {}, conn.orgName || 'This detachment'))),

    el('div', { class: 'qr-screen__code' }, code),

    el('div', { class: 'qr-screen__foot' },
      el('p', { class: 'qr-screen__hint' },
        'Point a phone camera at this. No app needed — the camera offers to open it.'),
      el('code', { class: 'qr-screen__link' }, link),
      el('div', { class: 'row row--wrap', style: { justifyContent: 'center' } },
        el('button', { type: 'button', class: 'btn btn--sm', onclick: copy },
          icon('copy'), 'Copy link'),
        el('button', {
          type: 'button', class: 'btn btn--sm', onclick: () => navigate('/admin'),
        }, icon('users'), 'Roster')))));
}
