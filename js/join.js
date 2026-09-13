/**
 * Join links — how a device gets pointed at a detachment's folder.
 *
 * Without this, every device runs the full setup wizard: choose a backend, paste
 * an OAuth Client ID, paste a Drive folder link. That is a reasonable thing to
 * ask of the one administrator who sets the detachment up. It is not a
 * reasonable thing to ask of a hundred cadets on their phones, and the first
 * live install made that obvious — the same values were pasted three times in
 * one evening on three devices.
 *
 * A join link carries the configuration instead:
 *
 *     https://det.example.org/app/#/join?c=<client>&f=<folder>&n=<name>
 *
 * The cadet taps it, approves Drive access once, and lands signed in. Nothing
 * is typed.
 *
 * WHAT A JOIN LINK IS NOT. It is not a credential. The Client ID is designed to
 * be public and ships in the page source of every app that uses one; the folder
 * ID is an address rather than a key, and reaching the folder still needs Google
 * to have granted that account access. Being able to connect grants nothing on
 * its own — the roster decides who may sign in and as what.
 *
 * WHAT A JOIN LINK IS, THOUGH, AND THIS PART MATTERS
 *
 * The `p` parameter names the **submission server**: the address this device
 * will send every answer to, along with the Google ID token proving who sent
 * it. That is not an address in the harmless sense. A link carrying somebody
 * else's `p` points a cadet's device at somebody else's server, which then holds
 * a valid token for that cadet and can replay it against the real one.
 *
 * An earlier version of this comment said a join link was "safe to post
 * anywhere". That was written before `p` existed and it was wrong afterwards.
 * A join link should be treated the way a detachment treats any other
 * instruction it issues: it is fine to send through the channels the det
 * already uses, and it should not be followed from a source nobody recognises.
 *
 * So `p` is parsed strictly here — only an Apps Script deployment, never an
 * arbitrary address — and `views/join.js` refuses to re-point a device that is
 * already configured. Neither stops somebody who follows a crafted link on a
 * fresh device, and nothing in the link can: it is unauthenticated data, and no
 * check the client performs against an attacker's own endpoint can be trusted.
 * What they do is remove the silent cases.
 *
 * This module is deliberately DOM-free so the link format is unit-testable, and
 * so a future QR renderer can consume `buildJoinLink()` without dragging a view
 * along with it.
 */

import { isProxyUrl } from './storage/proxy.js';

/** Every Google browser client ID ends this way, so it is not worth carrying. */
const CLIENT_SUFFIX = '.apps.googleusercontent.com';

/** Every Apps Script web app URL has this shape, so only the id travels. */
const PROXY_PREFIX = 'https://script.google.com/macros/s/';
const PROXY_SUFFIX = '/exec';

/** Drive file and folder ids, and Google's client id body. */
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Drops the fixed suffix from a client ID.
 *
 * Saves 27 characters in every link. That is invisible in a pasted URL and
 * matters quite a lot to a QR code, where length drives the module count and
 * therefore how close someone has to hold a phone to a projector screen.
 */
export function shortenClientId(clientId) {
  const value = String(clientId || '').trim();
  return value.endsWith(CLIENT_SUFFIX) ? value.slice(0, -CLIENT_SUFFIX.length) : value;
}

/** Puts the suffix back, tolerating a link that carried the full form anyway. */
export function expandClientId(short) {
  const value = String(short || '').trim();
  if (!value) return '';
  return value.endsWith(CLIENT_SUFFIX) ? value : value + CLIENT_SUFFIX;
}

/** Reduces a deployed Apps Script URL to its deployment id. Saves ~40 characters. */
export function shortenProxyUrl(url) {
  const value = String(url || '').trim();
  if (value.startsWith(PROXY_PREFIX) && value.endsWith(PROXY_SUFFIX)) {
    return value.slice(PROXY_PREFIX.length, -PROXY_SUFFIX.length);
  }
  return value;
}

/**
 * Rebuilds the full URL from a deployment id.
 *
 * Returns `''` for anything that is not a bare deployment id or a real Apps
 * Script web app address. It used to return any `https://` string unchanged,
 * which meant a hand-written link could name any host at all as the place to
 * send a cadet's answers and their sign-in token.
 */
export function expandProxyUrl(short) {
  const value = String(short || '').trim();
  if (!value) return '';
  const full = ID_PATTERN.test(value) ? PROXY_PREFIX + value + PROXY_SUFFIX : value;
  return isProxyUrl(full) ? full : '';
}

/**
 * The address the app is served from, without any route on the end.
 *
 * Built from wherever the app currently runs rather than stored, so a
 * detachment that moves hosts gets correct links immediately and nobody has to
 * remember to update a setting.
 */
export function appBaseUrl(loc = window.location) {
  return `${loc.origin}${loc.pathname}`;
}

/**
 * Builds a join link.
 *
 * @param {{clientId: string, folderId: string, orgName?: string, base?: string}} config
 * @returns {string}
 * @throws if the client ID or folder ID is missing or malformed — a broken join
 *         link fails in a cadet's hands, where nobody can debug it.
 */
export function buildJoinLink({ clientId, folderId, orgName = '', proxyUrl = '', base = null }) {
  const client = shortenClientId(clientId);
  const folder = String(folderId || '').trim();

  if (!client) throw new Error('This installation has no Google Client ID, so it cannot make a join link.');
  if (!folder) throw new Error('This installation has no Drive folder, so it cannot make a join link.');
  if (!ID_PATTERN.test(client)) throw new Error('That Google Client ID does not look valid.');
  if (!ID_PATTERN.test(folder)) throw new Error('That Drive folder ID does not look valid.');

  const params = new URLSearchParams({ c: client, f: folder });
  if (String(orgName || '').trim()) params.set('n', String(orgName).trim());

  // Carried in the link because a cadet in proxy mode has no Drive access and
  // therefore cannot read a shared setting to discover it.
  const proxy = shortenProxyUrl(proxyUrl);
  if (proxy) {
    if (!ID_PATTERN.test(proxy)) throw new Error('That submission server URL does not look valid.');
    params.set('p', proxy);
  }

  return `${base || appBaseUrl()}#/join?${params.toString()}`;
}

/**
 * Reads the configuration back out of a join link's query parameters.
 *
 * Takes the router's own `URLSearchParams`, so it never has to re-parse a hash
 * and cannot disagree with the router about what the route was.
 *
 * @returns {{clientId: string, folderId: string, orgName: string, proxyUrl: string}|null}
 *          null when the link is missing either required value.
 */
export function parseJoinParams(query) {
  const client = expandClientId(query.get('c') || '');
  const folder = String(query.get('f') || '').trim();
  const orgName = String(query.get('n') || '').trim();
  const rawProxy = String(query.get('p') || '').trim();
  const proxyUrl = expandProxyUrl(rawProxy);

  if (!client || !folder) return null;
  if (!ID_PATTERN.test(shortenClientId(client)) || !ID_PATTERN.test(folder)) return null;

  // A `p` that will not parse is refused outright rather than dropped. Dropping
  // it would silently fall back to direct Drive mode, which asks the cadet for
  // full access to their Google Drive — turning a malformed link into a much
  // more alarming permission prompt than the one they were expecting.
  if (rawProxy && !proxyUrl) {
    return { clientId: client, folderId: folder, orgName, proxyUrl: '', proxyRejected: true };
  }

  return { clientId: client, folderId: folder, orgName, proxyUrl, proxyRejected: false };
}

/**
 * A pre-addressed mail draft, for detachments that hand out access by email.
 *
 * The body is plain text on purpose: it has to survive every mail client a
 * regional detachment might be using, and a cadet reading it on a phone should
 * understand what they are being asked to do before they tap anything.
 */
export function joinMailto({ link, orgName = '', appName = '9ThirtyOne' }) {
  const who = orgName || 'your detachment';
  const subject = `${appName} — join ${who}`;
  const body = [
    `You have been added to the ${who} feedback roster.`,
    '',
    'Open this link on the phone or laptop you will use:',
    '',
    link,
    '',
    'It will ask you to sign in with Google. Use the account this message',
    'was sent to — that is the one on the roster.',
    '',
    'Google will ask your permission before the app can do anything.',
    'Accept it.',
    '',
    'You should NOT see a warning that the app is unverified. If you do, you',
    'are not on the real address — check the link and ask your cadre.',
    '',
    'Nothing to install and nothing to type.',
  ].join('\n');

  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
