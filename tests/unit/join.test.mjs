/**
 * Unit checks for join links.
 *
 *     npm run test:unit
 *
 * A malformed join link fails in a cadet's hands, on their phone, where nobody
 * can see the error and the only feedback anyone gets is "it didn't work". So
 * the round trip is checked directly: whatever `buildJoinLink` produces must
 * come back out of `parseJoinParams` unchanged, and anything malformed must be
 * refused loudly at the point of creation rather than quietly at the point of use.
 */

import {
  shortenClientId, expandClientId, buildJoinLink, parseJoinParams, joinMailto, appBaseUrl,
  shortenProxyUrl, expandProxyUrl,
} from '../../js/join.js';
import { validateProxyUrl } from '../../js/storage/proxy.js';

const CLIENT = '724504040762-rrq3q51dip6rib0g8lof5pq5r6da2g03.apps.googleusercontent.com';
const FOLDER = '1Te9Pc7JgOSUluq3tc0FCK4IqbKm1MTIM';
const BASE = 'https://9thirtyone.app/';

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

/** Parses a built link the way the router would, via URLSearchParams. */
const paramsOf = (link) => new URLSearchParams(link.slice(link.indexOf('?') + 1));

const refuses = (label, config, pattern) => check(label, () => {
  let message = 'NO ERROR';
  try { buildJoinLink(config); } catch (e) { message = e.message; }
  if (!pattern.test(message)) throw new Error(`message was: ${message}`);
});

/* ---------- the client id suffix ---------- */

check('the fixed client-id suffix is dropped', () => {
  const short = shortenClientId(CLIENT);
  if (short !== '724504040762-rrq3q51dip6rib0g8lof5pq5r6da2g03') {
    throw new Error(`got ${short}`);
  }
});

check('shortening is idempotent', () => {
  if (shortenClientId(shortenClientId(CLIENT)) !== shortenClientId(CLIENT)) {
    throw new Error('a second pass changed it');
  }
});

check('expanding restores the full client id', () => {
  if (expandClientId(shortenClientId(CLIENT)) !== CLIENT) throw new Error('round trip lost data');
});

check('expanding tolerates an already-full client id', () => {
  // A link built by an older release, or hand-edited, may carry the long form.
  if (expandClientId(CLIENT) !== CLIENT) throw new Error('suffix was doubled');
});

check('an empty client id expands to empty, not to a bare suffix', () => {
  if (expandClientId('') !== '') throw new Error('invented a client id from nothing');
});

/* ---------- the round trip ---------- */

check('a built link parses back to what went in', () => {
  const link = buildJoinLink({ clientId: CLIENT, folderId: FOLDER, orgName: 'Det 025', base: BASE });
  const out = parseJoinParams(paramsOf(link));
  if (out.clientId !== CLIENT) throw new Error(`client id came back as ${out.clientId}`);
  if (out.folderId !== FOLDER) throw new Error(`folder id came back as ${out.folderId}`);
  if (out.orgName !== 'Det 025') throw new Error(`org name came back as ${out.orgName}`);
});

check('the link points at the join route', () => {
  const link = buildJoinLink({ clientId: CLIENT, folderId: FOLDER, base: BASE });
  if (!link.startsWith(`${BASE}#/join?`)) throw new Error(link);
});

check('an org name with spaces and punctuation survives', () => {
  const name = 'Det 025 — Wilkes & Misericordia';
  const link = buildJoinLink({ clientId: CLIENT, folderId: FOLDER, orgName: name, base: BASE });
  // A raw space is the one that actually bites: chat clients and mail wrap or
  // truncate the link at it. The & separators between parameters are fine.
  if (/ /.test(link)) throw new Error('a raw space survived into the link');
  if (parseJoinParams(paramsOf(link)).orgName !== name) throw new Error('name did not survive');
});

check('the org name is optional', () => {
  const link = buildJoinLink({ clientId: CLIENT, folderId: FOLDER, base: BASE });
  if (link.includes('n=')) throw new Error('an empty name was still written into the link');
  if (parseJoinParams(paramsOf(link)).orgName !== '') throw new Error('org name not empty');
});

check('the link stays short enough to be worth a QR code later', () => {
  const link = buildJoinLink({ clientId: CLIENT, folderId: FOLDER, orgName: 'Det 025', base: BASE });
  // Byte-mode QR at error correction M holds 152 bytes at version 8. Staying
  // under that keeps the code coarse enough to scan off a projector.
  if (link.length > 152) throw new Error(`link is ${link.length} chars`);
});

/* ---------- refusals, at build time ---------- */

refuses('a missing client id is refused', { folderId: FOLDER, base: BASE }, /no Google Client ID/i);
refuses('a missing folder id is refused', { clientId: CLIENT, base: BASE }, /no Drive folder/i);
refuses('a malformed client id is refused',
  { clientId: 'not a client id!', folderId: FOLDER, base: BASE }, /does not look valid/i);
refuses('a folder link pasted where an id belongs is refused',
  { clientId: CLIENT, folderId: 'https://drive.google.com/drive/folders/abc', base: BASE },
  /does not look valid/i);

/* ---------- refusals, at parse time ---------- */

check('a link with no folder is rejected', () => {
  if (parseJoinParams(new URLSearchParams('c=abc123')) !== null) throw new Error('accepted');
});

check('a link with no client is rejected', () => {
  if (parseJoinParams(new URLSearchParams(`f=${FOLDER}`)) !== null) throw new Error('accepted');
});

check('an empty query is rejected rather than treated as a default', () => {
  if (parseJoinParams(new URLSearchParams('')) !== null) throw new Error('accepted');
});

check('a truncated link is rejected', () => {
  // Mail clients and chat apps cut long links; this is the realistic failure.
  const link = buildJoinLink({ clientId: CLIENT, folderId: FOLDER, base: BASE });
  const cut = link.slice(0, link.indexOf('&f='));
  if (parseJoinParams(paramsOf(cut)) !== null) throw new Error('a truncated link was accepted');
});

check('junk in the parameters is rejected, not passed to Google', () => {
  const bad = new URLSearchParams({ c: 'a b c', f: FOLDER });
  if (parseJoinParams(bad) !== null) throw new Error('accepted a malformed client id');
});

/* ---------- the submission proxy ---------- */

const PROXY = 'https://script.google.com/macros/s/AKfycbwEXAMPLEdeploymentid0123456789/exec';

check('a proxy url reduces to its deployment id and back', () => {
  const short = shortenProxyUrl(PROXY);
  if (short.includes('/')) throw new Error(`still a url: ${short}`);
  if (expandProxyUrl(short) !== PROXY) throw new Error('round trip lost data');
});

check('expanding tolerates a full url', () => {
  if (expandProxyUrl(PROXY) !== PROXY) throw new Error('a full url was mangled');
});

check('an empty proxy expands to empty, not to a bare prefix', () => {
  if (expandProxyUrl('') !== '') throw new Error('invented a url from nothing');
});

check('the proxy rides along in the link and comes back whole', () => {
  const link = buildJoinLink({ clientId: CLIENT, folderId: FOLDER, proxyUrl: PROXY, base: BASE });
  const out = parseJoinParams(paramsOf(link));
  if (out.proxyUrl !== PROXY) throw new Error(`proxy came back as ${out.proxyUrl}`);
});

check('a link without a proxy reports no proxy rather than a broken one', () => {
  const link = buildJoinLink({ clientId: CLIENT, folderId: FOLDER, base: BASE });
  if (link.includes('p=')) throw new Error('an empty proxy was written into the link');
  if (parseJoinParams(paramsOf(link)).proxyUrl !== '') throw new Error('invented a proxy');
});

check('a link carrying a proxy is still short enough to be worth a QR code', () => {
  const link = buildJoinLink({
    clientId: CLIENT, folderId: FOLDER, orgName: 'Det 025', proxyUrl: PROXY, base: BASE,
  });
  // Version 11 at error correction M holds 254 bytes. Past that a projected
  // code gets too dense for a phone at the back of a room.
  if (link.length > 254) throw new Error(`link is ${link.length} chars`);
});

check('the /dev deployment url is refused with the reason', () => {
  const dev = PROXY.replace('/exec', '/dev');
  const problem = validateProxyUrl(dev);
  if (!problem || !/test URL/i.test(problem)) throw new Error(`message was: ${problem}`);
});

check('a non-Apps-Script url is refused', () => {
  const problem = validateProxyUrl('https://example.com/submit');
  if (!problem || !/Apps Script/i.test(problem)) throw new Error(`message was: ${problem}`);
});

check('a valid exec url is accepted', () => {
  const problem = validateProxyUrl(PROXY);
  if (problem) throw new Error(`rejected a valid url: ${problem}`);
});

check('an http url is refused', () => {
  const problem = validateProxyUrl(PROXY.replace('https://', 'http://'));
  if (!problem) throw new Error('accepted an insecure url');
});

/* ---------- the mail draft ---------- */

check('the mail draft carries the link and encodes its body', () => {
  const link = buildJoinLink({ clientId: CLIENT, folderId: FOLDER, base: BASE });
  const href = joinMailto({ link, orgName: 'Det 025' });
  if (!href.startsWith('mailto:?subject=')) throw new Error(href.slice(0, 40));
  if (!decodeURIComponent(href).includes(link)) throw new Error('link missing from the body');
  if (/\n/.test(href)) throw new Error('raw newlines would break the mailto');
});

check('the mail draft warns about the unverified-app screen', () => {
  // Cadets meet that screen before they ever see the app; an invitation that
  // does not mention it generates support questions by design.
  const body = decodeURIComponent(joinMailto({ link: 'https://x/#/join?c=a&f=b' }));
  // The invitation used to promise an unverified-app warning and tell the reader
  // to choose Advanced. The app is published and brand verified, so that screen
  // does not appear — and this assertion was holding the stale copy in place.
  // What it checks now is the inverse, which is the more useful thing to tell a
  // cadet: seeing that warning means they are not on the real address.
  if (/Choose Advanced/i.test(body)) {
    throw new Error('the invitation still tells the reader to choose Advanced');
  }
  if (!/permission/i.test(body)) throw new Error('the invitation does not mention the consent step');
  if (!/NOT see a warning/i.test(body)) {
    throw new Error('the invitation does not say an unverified warning means the wrong address');
  }
});

/* ---------- base url ---------- */

check('the base url drops any route, at the domain root', () => {
  // Where the app actually lives since the move to its own domain.
  const fake = { origin: 'https://9thirtyone.app', pathname: '/' };
  if (appBaseUrl(fake) !== BASE) throw new Error(appBaseUrl(fake));
});

check('the base url still keeps a subpath when there is one', () => {
  // Kept after the move to 9thirtyone.app, where the app sits at the root and this
  // case stopped being the live one. appBaseUrl still supports it — a copy served
  // from a subdirectory would produce join links that 404 without it — so the
  // guard outlives the deployment that motivated it.
  const fake = { origin: 'https://example.org', pathname: '/9thirtyone/' };
  if (appBaseUrl(fake) !== 'https://example.org/9thirtyone/') throw new Error(appBaseUrl(fake));
});

/* ---------- the submission server named in a link ---------- */

/**
 * The `p` parameter says where a cadet's answers and their Google ID token get
 * sent. It used to accept any `https://` address, so a hand-written link could
 * name an attacker's server and every device that followed it would hand over a
 * valid token on each use.
 */

check('a link cannot name an address outside Apps Script', () => {
  for (const bad of [
    'https://evil.example.com/collect',
    'http://script.google.com/macros/s/AAA/exec',
    'https://script.google.com.evil.example/macros/s/AAA/exec',
    'https://script.google.com/macros/s/AAA/dev',
    'javascript:alert(1)',
  ]) {
    const parsed = parseJoinParams(new URLSearchParams(`c=1-a&f=F&p=${encodeURIComponent(bad)}`));
    if (parsed.proxyUrl) throw new Error(`accepted ${bad}`);
    if (!parsed.proxyRejected) throw new Error(`silently dropped ${bad}`);
  }
});

check('a rejected server is refused rather than dropped', () => {
  // Dropping it would fall back to direct Drive, which asks the cadet for full
  // access to their Google account — a worse outcome than refusing the link.
  const parsed = parseJoinParams(new URLSearchParams('c=1-a&f=F&p=https://evil.example.com/x'));
  if (parsed.proxyRejected !== true) throw new Error('a bad server did not raise the flag');
});

check('an ordinary deployment id still works', () => {
  const parsed = parseJoinParams(new URLSearchParams('c=1-a&f=F&p=AKfycbwABC-123_x'));
  if (parsed.proxyUrl !== 'https://script.google.com/macros/s/AKfycbwABC-123_x/exec') {
    throw new Error(parsed.proxyUrl);
  }
  if (parsed.proxyRejected) throw new Error('refused a valid deployment');
});

check('a link with no server at all is still a valid link', () => {
  const parsed = parseJoinParams(new URLSearchParams('c=1-a&f=F'));
  if (parsed.proxyUrl !== '') throw new Error('invented a server');
  if (parsed.proxyRejected) throw new Error('refused a link that never named one');
});

check('the builder and the parser agree about what is valid', () => {
  // These disagreed: the builder refused an off-Google address while the parser
  // accepted it, so the only thing enforcing the rule was the code an attacker
  // was never going to run.
  let builderRefused = false;
  try {
    buildJoinLink({ clientId: 'x-abc', folderId: 'y', proxyUrl: 'https://evil.example.com/x' });
  } catch { builderRefused = true; }
  const parserRefused = parseJoinParams(
    new URLSearchParams('c=x-abc&f=y&p=https://evil.example.com/x')).proxyRejected;
  if (builderRefused !== parserRefused) {
    throw new Error(`builder refused: ${builderRefused}, parser refused: ${parserRefused}`);
  }
});

console.log(failures ? `\n${failures} join check(s) failed.` : '\nAll join checks passed.');
process.exit(failures ? 1 : 0);
