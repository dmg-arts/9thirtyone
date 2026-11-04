/**
 * The install-vs-join fault, and that the app stops sending people in circles.
 *
 *     npm run test:unit
 *
 * Det 752's commander pasted the detachment's Drive folder link into Settings
 * on 26 Oct. The app holds `drive.file`, which grants access to files that
 * browser created, and somebody else's browser created that folder — so Drive
 * answered 404 for ever. The app then said "confirm the folder link in
 * Settings", which is the control that caused it. He went round that loop for
 * most of a day.
 *
 * Nothing here can prove the screen reads well. What it can prove is that the
 * shape is recognised, that the advice no longer points at its own cause, and
 * that the recovery is reachable from where the fault surfaces.
 */

import { readFileSync } from 'node:fs';
import { needsSubmissionServer, mayHaveCardReader, proxyVersionAtLeast,
  MINIMUM_PROXY_VERSION } from '../../js/config.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(ROOT + path, 'utf8');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

check('a folder with no submission server is the unsupported state', () => {
  if (!needsSubmissionServer({ backend: 'drive', folderId: '1Nv8h6Ho', proxyUrl: '' })) {
    throw new Error('the commander’s exact configuration was not recognised');
  }
});

check('a properly joined device is not mistaken for it', () => {
  const joined = { backend: 'drive', folderId: '1Nv8h6Ho', proxyUrl: 'https://script.google.com/x/exec' };
  if (needsSubmissionServer(joined)) throw new Error('a working device was flagged as broken');
});

check('setup mid-flight and the local backend are not flagged', () => {
  // The installer legitimately holds a folder with no server, right up until
  // Part 6 of the setup guide. Flagging that would make the wizard accuse
  // itself halfway through.
  if (needsSubmissionServer({ backend: 'drive', folderId: '' })) {
    throw new Error('a half-finished setup was flagged');
  }
  if (needsSubmissionServer({ backend: 'local', folderId: 'x' })) {
    throw new Error('the this-device-only backend was flagged');
  }
  if (needsSubmissionServer(undefined)) throw new Error('an absent connection was flagged');
});

check('the 404 no longer tells people to re-paste the folder link', () => {
  // The loop itself. Re-pasting a correct link produces the same 404 for ever,
  // so naming that control as the cure is worse than saying nothing.
  const drive = read('js/storage/drive.js');
  // Scoped to what is assigned into the message, not the whole file: the
  // comment above that code quotes the old sentence in order to explain why it
  // is gone, and a check that cannot tell a quotation from a regression would
  // have to be weakened until it meant nothing.
  const assigned = [...drive.matchAll(/message \+=[^;]+;/g)].map((m) => m[0]).join('\n');
  if (/Confirm the folder link in Settings/i.test(assigned)) {
    throw new Error('the 404 still points at the control that causes it');
  }
  if (!/created itself/.test(drive)) {
    throw new Error('the 404 no longer explains why the folder cannot be opened');
  }
});

check('the recovery is offered where the fault surfaces, not two screens away', () => {
  // Source-level: the behaviour is a browser concern, but what this guards is
  // somebody simplifying the error panel back to a single generic message.
  const home = read('js/views/home.js');
  if (!/needsSubmissionServer/.test(home)) {
    throw new Error('the home screen no longer tells the two faults apart');
  }
  if (!/joinLinkCard/.test(home)) {
    throw new Error('the error offers no way to paste a join link');
  }
});

check('the join card is shared, not copied', () => {
  // It existed only inside the setup wizard, which is why it could not be
  // offered to a device that was already broken. A second copy would drift.
  const setup = read('js/views/setup.js');
  if (/^function joinLinkCard/m.test(setup)) {
    throw new Error('setup.js has its own copy again');
  }
  if (!/from '\.\/join-card\.js'/.test(setup)) {
    throw new Error('setup.js no longer uses the shared card');
  }
});

/* ------------------------------------------------------------------ *
 * the home screen and the counts it cannot read
 * ------------------------------------------------------------------ */

check('the home screen checks before reading counts, rather than catching after', () => {
  // `overview` is instructor and above, so a cadet — or anyone signed out —
  // was refused and fell into the catch, which paints "Not reachable" and
  // "The database could not be read". Stage 7 made that the first thing every
  // cadet saw, because joining now lands on /home.
  //
  // Source-level on purpose, and worth saying why: the browser suite runs the
  // local backend, where canDoMaintenance() is true and db.stats() is read off
  // the device with no role check. It cannot reach this path at all, so a
  // behavioural test there passes whether the guard exists or not — which is
  // exactly what happened before this check was written.
  const home = read('js/views/home.js');
  const guard = home.indexOf('mayReadCounts');
  const call = home.indexOf('loadOverview()');
  if (guard < 0) throw new Error('the home screen no longer checks who is asking');
  if (call < 0) throw new Error('the counts read has moved — recheck this assertion');
  if (guard > call) {
    throw new Error('the check happens after the read, so a cadet still triggers the refusal');
  }
  if (!/role !== ROLES\.student/.test(home)) {
    throw new Error('the guard is not "holds a role that is not student" — a panel check '
      + 'would wrongly exclude a database administrator, since admin implies no other role');
  }
});

/* ------------------------------------------------------------------ *
 * the CAC stall — stage 9
 * ------------------------------------------------------------------ */

/*
 * Nothing can detect a CAC. This is a population test: Det 752's staff sign in
 * on USAF-issued Windows laptops with readers in the keyboard, CACs are
 * staff-held, and cadets are on phones or Chrome. So the question is only
 * whether the hint is worth offering on this device.
 */
check('the det\u2019s Windows laptops are offered the hint', () => {
  if (!mayHaveCardReader('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0', 0)) {
    throw new Error('a Windows desktop was not offered the hint');
  }
});

check('phones and tablets are not, because nothing is plugged into them', () => {
  for (const [ua, touch, what] of [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari', 5, 'iPhone'],
    ['Mozilla/5.0 (Linux; Android 15) Chrome/155.0', 5, 'Android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/155.0', 10, 'Windows tablet'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/27', 0, 'Mac'],
  ]) {
    if (mayHaveCardReader(ua, touch)) throw new Error(`${what} was offered a CAC hint`);
  }
});

check('the hint says likely, and never claims to have detected anything', () => {
  // A browser cannot see a card. Saying it can would be the kind of wrong that
  // stops people believing the next message too.
  const gate = read('js/views/sign-in.js');
  const shown = gate.slice(gate.indexOf('Sign-in has not come back'), gate.indexOf('STALL_AFTER_MS'));
  if (/detected|we found|your card is/i.test(shown)) {
    throw new Error('the notice claims to have detected a card');
  }
  if (!/If this computer has a CAC reader/.test(gate)) {
    throw new Error('the notice is not phrased conditionally, so a cadet reads it as about them');
  }
  // The other live cause has to stay named: a blocker breaks sign-in too, and
  // a hint that offers only one explanation is wrong half the time.
  if (!/content blocker/i.test(shown)) {
    throw new Error('the notice offers no second possibility');
  }
});

check('the stall watch is cleared on both outcomes, not just success', () => {
  // Left running, it would fire twelve seconds after a sign-in that already
  // failed, contradicting the error still on screen.
  const gate = read('js/views/sign-in.js');
  // Not [^,]* — the handler's own parameter list contains a comma, so that
  // pattern stopped before reaching the call and reported a real property as
  // missing.
  const credential = /onCredential:[\s\S]{0,80}?stopStallWatch/.test(gate);
  const errored = /onError:[\s\S]{0,80}?stopStallWatch/.test(gate);
  if (!credential) throw new Error('a successful sign-in does not stop the watch');
  if (!errored) throw new Error('a failed sign-in does not stop the watch');
});

/* ------------------------------------------------------------------ *
 * the two halves at different versions — phase 2
 * ------------------------------------------------------------------ */

/*
 * On 10 Nov the server is pasted first and the client follows days later, and
 * a server rollback is two clicks where a client rollback is a revert, a cache
 * bump and a wait. The halves therefore sit at different versions by design,
 * and the client has to know which pairings it cannot work with.
 */
check('a server ahead of its client is fine, which is the normal state after a release', () => {
  for (const ahead of ['1.4.0', '1.4.1', '1.5.0', '2.0.0']) {
    if (!proxyVersionAtLeast(ahead)) throw new Error(`${ahead} was rejected`);
  }
});

check('a server behind its client is not, because half the actions do not exist', () => {
  for (const behind of ['1.3.1', '1.2.0', '1.1.0', '0.9', '']) {
    if (proxyVersionAtLeast(behind)) throw new Error(`${behind} was accepted`);
  }
});

check('versions compare as numbers, not as strings', () => {
  // '1.10.0' sorts below '1.9.0' as text. That is the kind of wrong that waits
  // nine releases and then breaks on a day nobody is expecting it.
  if (!proxyVersionAtLeast('1.10.0', '1.9.0')) {
    throw new Error('1.10.0 was treated as older than 1.9.0');
  }
  if (proxyVersionAtLeast('1.9.0', '1.10.0')) {
    throw new Error('1.9.0 was treated as newer than 1.10.0');
  }
});

check('the client says what to do, not that an action is missing', () => {
  const ds = read('js/data-source.js');
  const shown = ds.slice(ds.indexOf('proxyVersionAtLeast(body.version)'), ds.indexOf("status: 'ready'"));
  if (!/submission server/i.test(shown)) {
    throw new Error('the message does not name the submission server');
  }
  if (!/deploy a new version/i.test(shown)) throw new Error('it does not say what to do');
  if (!shown.includes('MINIMUM_PROXY_VERSION')) {
    throw new Error('the message hard-codes a version instead of naming the constant');
  }
});

check('a worker rollover asks before reloading, and the notice does not expire', () => {
  // skipWaiting() plus clients.claim() purges the old cache while tabs are
  // open, and there are live dynamic imports. Reaching one afterwards gets a
  // new build's module into an old build's page — mid-submit, that costs a
  // cadet their answers. Which is also why it asks: a reload during a
  // submission loses exactly what it is protecting.
  const app = read('js/app.js');
  if (!/controllerchange/.test(app)) throw new Error('nothing listens for a worker rollover');
  if (/controllerchange[\s\S]{0,400}?location\.reload\(\)\s*;?\s*\}\s*\)/.test(app)
    && !/Reload now/.test(app)) {
    throw new Error('it reloads on its own instead of asking');
  }
  if (!/toast\([^)]*,\s*'info',\s*0\)/.test(app)) {
    throw new Error('the notice is on a timer, so it hides a condition that is still true');
  }
});

console.log(failures
  ? `\n${failures} join-recovery check(s) failed.`
  : '\nThe install-vs-join fault is recognised and recoverable.');
process.exit(failures ? 1 : 0);
