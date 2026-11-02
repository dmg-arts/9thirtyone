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
import { needsSubmissionServer } from '../../js/config.js';

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

console.log(failures
  ? `\n${failures} join-recovery check(s) failed.`
  : '\nThe install-vs-join fault is recognised and recoverable.');
process.exit(failures ? 1 : 0);
