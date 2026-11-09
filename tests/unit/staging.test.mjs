/**
 * The staging marker, and the guarantee that production never wears it.
 *
 *     npm run test:unit
 *
 * 1.4 is built against a staging origin because the things it changes — a
 * submit-time screen, a new route, real latency — can only be judged on a real
 * phone. A phone means the staging build gets *installed*: an icon, no address
 * bar, and from that moment pixel-identical to the detachment's live app.
 *
 * Two failures matter, and they are not symmetrical.
 *
 *   - **Staging unmarked** is the expensive one. Someone reads a stale staging
 *     screen as live data, or worse, acts on it. `isStagingHost` is therefore
 *     written to mark anything it does not recognise.
 *   - **Production marked** is merely embarrassing, but it is the one a
 *     refactor can cause silently, because nobody runs the suite against
 *     `9thirtyone.app`. Hence this file.
 */

import { readFileSync } from 'node:fs';
import { isStagingHost } from '../../js/config.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(ROOT + path, 'utf8');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

check('the production host is never staging', () => {
  // The CNAME is the authority on what production is, so read it rather than
  // restating it — a domain change would otherwise leave this test asserting
  // something true about a host nobody serves any more.
  const cname = read('CNAME').trim();
  if (!cname) throw new Error('CNAME is empty, so production has no known hostname');
  if (isStagingHost(cname)) throw new Error(`${cname} is the production host and is marked staging`);
  if (isStagingHost(`www.${cname}`)) throw new Error(`www.${cname} is marked staging`);
});

check('local development and the browser suite are not marked', () => {
  // The e2e suite runs on 127.0.0.1. A ribbon there would be harmless but it
  // would also mean the suite never exercises the appbar production renders.
  for (const host of ['localhost', '127.0.0.1', '']) {
    if (isStagingHost(host)) throw new Error(`${host || '(empty)'} is marked staging`);
  }
});

check('the staging host is marked', () => {
  if (!isStagingHost('staging.9thirtyone.app')) throw new Error('staging is not marked');
});

check('an unrecognised host is marked rather than trusted', () => {
  // The fail-safe direction. A host nobody listed must not pass for production.
  for (const host of ['9thirtyone.app.evil.test', 'dmg-arts.github.io', 'preview.example']) {
    if (!isStagingHost(host)) throw new Error(`${host} passed as production`);
  }
});

check('the case of a hostname does not decide it', () => {
  const cname = read('CNAME').trim();
  if (isStagingHost(cname.toUpperCase())) throw new Error('an upper-case production host is marked staging');
});

check('the ribbon is rendered only behind the check', () => {
  // Source-level, because the mistake this guards is someone mounting the
  // ribbon unconditionally while refactoring the appbar — which no amount of
  // testing isStagingHost in isolation would catch.
  const app = read('js/app.js');
  if (!/isStagingHost\(\)\s*\n?\s*\?/.test(app)) {
    throw new Error('the staging ribbon is no longer gated on isStagingHost()');
  }
});

console.log(failures ? `\n${failures} staging check(s) failed.` : '\nStaging is marked and production is not.');
process.exit(failures ? 1 : 0);
