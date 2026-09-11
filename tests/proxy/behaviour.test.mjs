/**
 * The proxy, executed.
 *
 *     npm run test:proxy
 *
 * `tests/unit/proxy.test.mjs` reads the script and checks the shape of its
 * access model. This runs it. The distinction matters: source checks catch a
 * missing guard, and miss a wrong argument order, an id that escapes its folder,
 * or a role that reaches a space through a path nobody thought about.
 *
 * The real `tools/proxy/Code.gs` runs unmodified against an in-memory Drive.
 * What this cannot check is the environment — quotas, real lock contention
 * across concurrent executions, a deployment misconfigured in the console. A
 * real deployment still has to happen; this means it will be checking those
 * rather than discovering the logic was wrong.
 */

import { createProxy, validToken, seedRoster, account } from './harness.mjs';

const CID = 'test-client.apps.googleusercontent.com';

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

/** A detachment with one of everything, and a token per person. */
function detachment(extraAccounts = []) {
  const people = [
    account('cadet', 'cadet@x.edu', ['student']),
    account('instructor', 'instructor@x.edu', ['instructor']),
    account('cadre', 'cadre@x.edu', ['cadre']),
    account('commander', 'commander@x.edu', ['commander']),
    account('admin', 'admin@x.edu', ['admin']),
    ...extraAccounts,
  ];
  const tokens = {};
  for (const person of people) tokens[`tok-${person.username}`] = validToken(person.email);

  const proxy = createProxy({ tokens });
  seedRoster(proxy.root, people);

  // One request in each space, all addressed to every AS200 cadet.
  for (const [space, segments] of [
    ['shared', ['requests']],
    ['cadre', ['cadre', 'requests']],
    ['commander', ['commander', 'requests']],
  ]) {
    proxy.root.put(segments, `req_${space}.json`, {
      id: `req_${space}`, formId: 'form_1', title: `${space} feedback`,
      status: 'open', asClass: 'AS200', anonymous: true, space,
      assignedUsernames: [],
    });
  }
  proxy.root.put(['forms'], 'form_1.json', { id: 'form_1', name: 'Form', sections: [] });
  return proxy;
}

const as = (person) => `tok-${person}`;
const ids = (result) => (result.catalog?.requests || []).map((r) => r.id).sort();

/* ------------------------------------------------------------------ *
 * identity
 * ------------------------------------------------------------------ */

check('a request with no token is refused', () => {
  const proxy = detachment();
  const out = proxy.post({ action: 'catalog' });
  if (out.ok) throw new Error('accepted');
  if (!/sign-in/i.test(out.error)) throw new Error(out.error);
});

check('a token Google will not verify is refused', () => {
  const proxy = detachment();
  const out = proxy.post({ action: 'catalog', idToken: 'made-up' });
  if (out.ok) throw new Error('accepted an unverifiable token');
});

check('a token for another application is refused', () => {
  const proxy = createProxy({ tokens: { bad: { ...validToken('x@x.edu'), aud: 'someone-else' } } });
  seedRoster(proxy.root, [account('x', 'x@x.edu', ['admin'])]);
  const out = proxy.post({ action: 'catalog', idToken: 'bad' });
  if (out.ok) throw new Error('accepted a token minted for a different client');
  if (!/different application/i.test(out.error)) throw new Error(out.error);
});

check('an expired token is refused', () => {
  const expired = { ...validToken('x@x.edu'), exp: String(Math.floor(Date.now() / 1000) - 60) };
  const proxy = createProxy({ tokens: { old: expired } });
  seedRoster(proxy.root, [account('x', 'x@x.edu', ['admin'])]);
  const out = proxy.post({ action: 'catalog', idToken: 'old' });
  if (out.ok) throw new Error('accepted an expired token');
  if (!/expired/i.test(out.error)) throw new Error(out.error);
});

check('an unverified email is refused', () => {
  const unverified = { ...validToken('x@x.edu'), email_verified: 'false' };
  const proxy = createProxy({ tokens: { u: unverified } });
  seedRoster(proxy.root, [account('x', 'x@x.edu', ['admin'])]);
  const out = proxy.post({ action: 'catalog', idToken: 'u' });
  if (out.ok) throw new Error('accepted an unverified address');
});

check('an address not on the roster is refused', () => {
  const proxy = createProxy({ tokens: { ghost: validToken('ghost@x.edu') } });
  seedRoster(proxy.root, [account('x', 'x@x.edu', ['admin'])]);
  const out = proxy.post({ action: 'catalog', idToken: 'ghost' });
  if (out.ok) throw new Error('accepted someone not on the roster');
  if (!/roster/i.test(out.error)) throw new Error(out.error);
});

check('a deactivated account is refused', () => {
  const proxy = createProxy({ tokens: { off: validToken('off@x.edu') } });
  seedRoster(proxy.root, [account('off', 'off@x.edu', ['admin'], { active: false })]);
  const out = proxy.post({ action: 'catalog', idToken: 'off' });
  if (out.ok) throw new Error('accepted a deactivated account');
  if (!/deactivated/i.test(out.error)) throw new Error(out.error);
});

/* ------------------------------------------------------------------ *
 * role gating
 * ------------------------------------------------------------------ */

check('a cadet cannot read the catalogue', () => {
  const proxy = detachment();
  if (proxy.post({ action: 'catalog', idToken: as('cadet') }).ok) {
    throw new Error('a cadet read the instructor catalogue');
  }
});

check('a cadet cannot read anyone\'s responses', () => {
  const proxy = detachment();
  for (const action of ['responses', 'allResponses']) {
    if (proxy.post({ action, idToken: as('cadet'), requestId: 'req_shared' }).ok) {
      throw new Error(`a cadet called ${action}`);
    }
  }
});

check('an instructor cannot read the audit log', () => {
  const proxy = detachment();
  if (proxy.post({ action: 'audit', idToken: as('instructor') }).ok) {
    throw new Error('an instructor read the audit log');
  }
});

check('an instructor cannot change the roster', () => {
  const proxy = detachment();
  for (const action of ['accountCreate', 'accountUpdate', 'accountDelete', 'rollover']) {
    if (proxy.post({ action, idToken: as('instructor'), account: {}, id: 'x' }).ok) {
      throw new Error(`an instructor called ${action}`);
    }
  }
});

check('cadre inherit instructor access without holding the role', () => {
  const proxy = detachment();
  if (!proxy.post({ action: 'catalog', idToken: as('cadre') }).ok) {
    throw new Error('a cadre-only account could not read the catalogue');
  }
});

check('an unknown action is refused', () => {
  const proxy = detachment();
  if (proxy.post({ action: 'dropDatabase', idToken: as('admin') }).ok) {
    throw new Error('an unknown action was accepted');
  }
});

/* ------------------------------------------------------------------ *
 * locked spaces
 * ------------------------------------------------------------------ */

check('an instructor sees only shared feedback', () => {
  const proxy = detachment();
  const seen = ids(proxy.post({ action: 'catalog', idToken: as('instructor') }));
  if (seen.join() !== 'req_shared') throw new Error(`saw ${seen.join(', ')}`);
});

check('cadre see shared and cadre feedback, not the commander\'s', () => {
  const proxy = detachment();
  const seen = ids(proxy.post({ action: 'catalog', idToken: as('cadre') }));
  if (seen.join() !== 'req_cadre,req_shared') throw new Error(`saw ${seen.join(', ')}`);
});

check('the commander sees everything', () => {
  const proxy = detachment();
  const seen = ids(proxy.post({ action: 'catalog', idToken: as('commander') }));
  if (seen.join() !== 'req_cadre,req_commander,req_shared') throw new Error(`saw ${seen.join(', ')}`);
});

check('an instructor naming a commander request gets nothing', () => {
  // Naming an id you cannot see must not reach past the space check.
  const proxy = detachment();
  const out = proxy.post({ action: 'responses', idToken: as('instructor'), requestId: 'req_commander' });
  if (out.ok) throw new Error('an instructor read commander responses');
  if (!/not available/i.test(out.error)) throw new Error(out.error);
});

check('an instructor cannot delete a commander request', () => {
  const proxy = detachment();
  const out = proxy.post({ action: 'deleteRequest', idToken: as('instructor'), requestId: 'req_commander' });
  if (out.ok) throw new Error('an instructor deleted a commander request');
  if (proxy.root.read(['commander', 'requests'], 'req_commander.json') === null) {
    throw new Error('the commander request was removed anyway');
  }
});

check('an instructor cannot file feedback into a locked space', () => {
  const proxy = detachment();
  const out = proxy.post({
    action: 'saveRequest', idToken: as('instructor'),
    request: { id: 'req_sneak', formId: 'form_1', space: 'commander' },
  });
  if (out.ok) throw new Error('an instructor filed into the commander space');
  if (proxy.root.read(['commander', 'requests'], 'req_sneak.json')) {
    throw new Error('the request landed in the commander space anyway');
  }
});

check('feedback cannot be moved between spaces once it exists', () => {
  // Moving it would carry its responses somewhere they were never readable.
  const proxy = detachment();
  const out = proxy.post({
    action: 'saveRequest', idToken: as('commander'),
    request: { id: 'req_shared', formId: 'form_1', space: 'commander' },
  });
  if (out.ok) throw new Error('a request was moved between spaces');
  if (!/cannot be moved/i.test(out.error)) throw new Error(out.error);
});

check('an unknown space falls back to shared rather than creating one', () => {
  const proxy = detachment();
  proxy.post({
    action: 'saveRequest', idToken: as('commander'),
    request: { id: 'req_odd', formId: 'form_1', space: 'nonsense' },
  });
  if (!proxy.root.read(['requests'], 'req_odd.json')) {
    throw new Error('it did not land in the shared space');
  }
  if (proxy.root.read(['nonsense', 'requests'], 'req_odd.json')) {
    throw new Error('a folder was created from a made-up space name');
  }
});

/* ------------------------------------------------------------------ *
 * cadets and the spaces
 * ------------------------------------------------------------------ */

check('a cadet is offered requests from every space', () => {
  // A commander's request is still meant to be answered.
  const proxy = detachment();
  const bundle = proxy.post({ action: 'bundle', idToken: as('cadet') }).bundle;
  const seen = bundle.requests.map((r) => r.id).sort();
  if (seen.join() !== 'req_cadre,req_commander,req_shared') throw new Error(`saw ${seen.join(', ')}`);
});

check('a cadet bundle carries no responses at all', () => {
  const proxy = detachment();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_shared', answers: { q1: 5 } });
  const bundle = proxy.post({ action: 'bundle', idToken: as('cadet') }).bundle;
  if ('responses' in bundle) throw new Error('the bundle contains a responses key');
  if (JSON.stringify(bundle).includes('res_')) throw new Error('a response id leaked into the bundle');
});

check('an answer is filed in its request\'s own space', () => {
  const proxy = detachment();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_commander', answers: { q1: 9 } });
  const shared = proxy.root.snapshot();
  const inCommander = Object.keys(shared).some((k) => k.startsWith('commander/responses/'));
  const inShared = Object.keys(shared).some((k) => /^responses\//.test(k));
  if (!inCommander) throw new Error('the answer did not land in the commander space');
  if (inShared) throw new Error('the answer also landed in the shared space');
});

check('an instructor cannot read a cadet\'s answer to a commander request', () => {
  const proxy = detachment();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_commander', answers: { q1: 9 } });
  const out = proxy.post({ action: 'allResponses', idToken: as('instructor') });
  if (!out.ok) throw new Error(out.error);
  if (out.responses.length) throw new Error(`instructor received ${out.responses.length} responses`);
});

check('the commander can read it', () => {
  const proxy = detachment();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_commander', answers: { q1: 9 } });
  const out = proxy.post({ action: 'allResponses', idToken: as('commander') });
  if (out.responses.length !== 1) throw new Error(`commander received ${out.responses.length}`);
});

/* ------------------------------------------------------------------ *
 * submissions
 * ------------------------------------------------------------------ */

check('one submission per cadet per form', () => {
  const proxy = detachment();
  const first = proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_shared', answers: { q1: 5 } });
  const second = proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_shared', answers: { q1: 1 } });
  if (!first.ok) throw new Error(first.error);
  if (second.ok) throw new Error('a second submission was accepted');
});

check('an anonymous form stores no respondent, whatever the client sends', () => {
  const proxy = detachment();
  proxy.post({
    action: 'submit', idToken: as('cadet'), requestId: 'req_shared',
    answers: { q1: 5 },
    respondent: { username: 'cadet', name: 'Cadet' },   // ignored on purpose
  });
  const stored = Object.entries(proxy.root.snapshot())
    .find(([k]) => k.startsWith('responses/req_shared/'))[1];
  if (stored.respondent !== null) throw new Error('a respondent was stored on an anonymous form');
  if (JSON.stringify(stored).includes('cadet')) throw new Error('the cadet is identifiable in the record');
});

check('an attributed form does store the respondent', () => {
  const proxy = detachment();
  proxy.root.put(['requests'], 'req_named.json', {
    id: 'req_named', formId: 'form_1', status: 'open', asClass: 'AS200',
    anonymous: false, space: 'shared', assignedUsernames: [],
  });
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_named', answers: { q1: 5 } });
  const stored = Object.entries(proxy.root.snapshot())
    .find(([k]) => k.startsWith('responses/req_named/'))[1];
  if (stored.respondent?.username !== 'cadet') throw new Error('no respondent recorded');
});

check('a closed request refuses submissions', () => {
  const proxy = detachment();
  proxy.root.put(['requests'], 'req_shut.json', {
    id: 'req_shut', formId: 'form_1', status: 'closed', asClass: 'AS200', space: 'shared',
  });
  const out = proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_shut', answers: {} });
  if (out.ok) throw new Error('a closed request accepted a submission');
});

check('a cadet cannot answer a request addressed to someone else', () => {
  const proxy = detachment();
  proxy.root.put(['requests'], 'req_other.json', {
    id: 'req_other', formId: 'form_1', status: 'open', space: 'shared',
    assignedUsernames: ['somebody-else'],
  });
  const out = proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_other', answers: {} });
  if (out.ok) throw new Error('answered a request assigned to somebody else');
});

/* ------------------------------------------------------------------ *
 * ids that try to escape
 * ------------------------------------------------------------------ */

check('an id containing a path is refused', () => {
  const proxy = detachment();
  for (const bad of ['../users', 'a/b', '../../users/users', './x', 'x\\y']) {
    const out = proxy.post({ action: 'responses', idToken: as('admin'), requestId: bad });
    if (out.ok) throw new Error(`accepted the id ${JSON.stringify(bad)}`);
  }
});

check('a record id containing a path is refused', () => {
  const proxy = detachment();
  const out = proxy.post({
    action: 'saveForm', idToken: as('instructor'),
    form: { id: '../users/users', name: 'escape' },
  });
  if (out.ok) throw new Error('accepted a form id containing a path');
  const roster = proxy.root.read(['users'], 'users.json');
  if (!roster?.users?.length) throw new Error('the roster was overwritten');
});

check('an over-long id is refused', () => {
  const proxy = detachment();
  const out = proxy.post({ action: 'responses', idToken: as('admin'), requestId: 'a'.repeat(200) });
  if (out.ok) throw new Error('accepted a 200-character id');
});

/* ------------------------------------------------------------------ *
 * deletions and the audit trail
 * ------------------------------------------------------------------ */

check('deleting a response needs an administrator', () => {
  const proxy = detachment();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_shared', answers: { q1: 5 } });
  const id = Object.keys(proxy.root.snapshot())
    .find((k) => k.startsWith('responses/req_shared/')).split('/').pop().replace('.json', '');

  const out = proxy.post({
    action: 'deleteResponse', idToken: as('instructor'),
    requestId: 'req_shared', responseId: id, reason: 'tidying up',
  });
  if (out.ok) throw new Error('an instructor deleted a response');
});

check('deleting a response needs a recorded reason', () => {
  const proxy = detachment();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_shared', answers: { q1: 5 } });
  const id = Object.keys(proxy.root.snapshot())
    .find((k) => k.startsWith('responses/req_shared/')).split('/').pop().replace('.json', '');

  const out = proxy.post({
    action: 'deleteResponse', idToken: as('admin'),
    requestId: 'req_shared', responseId: id, reason: '',
  });
  if (out.ok) throw new Error('deleted without a reason');
  if (!/reason/i.test(out.error)) throw new Error(out.error);
});

check('a recorded deletion names the account that did it, from the token', () => {
  const proxy = detachment();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_shared', answers: { q1: 5 } });
  const id = Object.keys(proxy.root.snapshot())
    .find((k) => k.startsWith('responses/req_shared/')).split('/').pop().replace('.json', '');

  proxy.post({
    action: 'deleteResponse', idToken: as('admin'),
    requestId: 'req_shared', responseId: id, reason: 'duplicate submission',
  });
  const entry = Object.entries(proxy.root.snapshot()).find(([k]) => k.startsWith('audit/'))?.[1];
  if (!entry) throw new Error('nothing was written to the audit trail');
  if (entry.actor?.username !== 'admin') throw new Error(`actor recorded as ${entry.actor?.username}`);
  if (entry.reason !== 'duplicate submission') throw new Error('the reason was not recorded');
});

check('a client cannot forge the actor on an audit entry', () => {
  const proxy = detachment();
  proxy.post({
    action: 'recordAudit', idToken: as('instructor'),
    entry: { action: 'x', summary: 'y', actor: { username: 'somebody-else' } },
  });
  const entry = Object.entries(proxy.root.snapshot()).find(([k]) => k.startsWith('audit/'))[1];
  if (entry.actor.username !== 'instructor') {
    throw new Error(`actor recorded as ${entry.actor.username}`);
  }
});

check('deleting a request takes its responses and receipts with it', () => {
  const proxy = detachment();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_shared', answers: { q1: 5 } });
  proxy.post({ action: 'deleteRequest', idToken: as('instructor'), requestId: 'req_shared' });

  const left = Object.keys(proxy.root.snapshot());
  if (left.some((k) => k.startsWith('responses/req_shared/'))) throw new Error('responses survived');
  if (left.some((k) => k.startsWith('receipts/req_shared/'))) throw new Error('receipts survived');
  if (left.includes('requests/req_shared.json')) throw new Error('the request survived');
});

/* ------------------------------------------------------------------ *
 * who feedback is about
 *
 * A commander reviews instructors by this attribution, so it has to mean
 * something. Who *issued* it comes from the verified token; who it is *about* is
 * a deliberate choice, but must name somebody real.
 * ------------------------------------------------------------------ */

check('the creator is taken from the token, not the request body', () => {
  const proxy = detachment();
  proxy.post({
    action: 'saveRequest', idToken: as('instructor'),
    request: { id: 'req_who', formId: 'form_1', createdBy: 'commander' },
  });
  const stored = proxy.root.read(['requests'], 'req_who.json');
  if (stored.createdBy !== 'instructor') {
    throw new Error(`createdBy recorded as ${stored.createdBy}`);
  }
});

check('the subject defaults to whoever issued it', () => {
  const proxy = detachment();
  proxy.post({
    action: 'saveRequest', idToken: as('cadre'),
    request: { id: 'req_default', formId: 'form_1' },
  });
  const stored = proxy.root.read(['requests'], 'req_default.json');
  if (stored.subject !== 'cadre') throw new Error(`subject is ${stored.subject}`);
});

check('the subject can name somebody else on the roster', () => {
  // An administrator issuing forms for an event somebody else ran.
  const proxy = detachment();
  proxy.post({
    action: 'saveRequest', idToken: as('admin'),
    request: { id: 'req_behalf', formId: 'form_1', subject: 'instructor' },
  });
  const stored = proxy.root.read(['requests'], 'req_behalf.json');
  if (stored.subject !== 'instructor') throw new Error(`subject is ${stored.subject}`);
  if (stored.createdBy !== 'admin') throw new Error('the issuer was not kept separately');
});

check('a subject who is not on the roster is refused', () => {
  const proxy = detachment();
  const out = proxy.post({
    action: 'saveRequest', idToken: as('admin'),
    request: { id: 'req_ghost', formId: 'form_1', subject: 'nobody-at-all' },
  });
  if (out.ok) throw new Error('accepted feedback about somebody who does not exist');
  if (proxy.root.read(['requests'], 'req_ghost.json')) throw new Error('it was written anyway');
});

check('editing a request does not reassign who issued it', () => {
  // Otherwise the last person to touch a form would inherit its results.
  const proxy = detachment();
  proxy.post({
    action: 'saveRequest', idToken: as('instructor'),
    request: { id: 'req_edit', formId: 'form_1' },
  });
  proxy.post({
    action: 'saveRequest', idToken: as('admin'),
    request: { id: 'req_edit', formId: 'form_1', title: 'renamed' },
  });
  const stored = proxy.root.read(['requests'], 'req_edit.json');
  if (stored.createdBy !== 'instructor') {
    throw new Error(`createdBy became ${stored.createdBy} after an edit by somebody else`);
  }
});

/* ------------------------------------------------------------------ *
 * the roster
 * ------------------------------------------------------------------ */

check('an account can be added, and duplicates refused', () => {
  const proxy = detachment();
  const first = proxy.post({
    action: 'accountCreate', idToken: as('admin'),
    account: { id: 'usr_new', username: 'new', email: 'New@X.edu', roles: ['student'] },
  });
  if (!first.ok) throw new Error(first.error);

  const again = proxy.post({
    action: 'accountCreate', idToken: as('admin'),
    account: { id: 'usr_other', username: 'other', email: 'new@x.edu', roles: ['student'] },
  });
  if (again.ok) throw new Error('the same address was added twice');
});

check('an email is stored lowercased so matching is stable', () => {
  const proxy = detachment();
  proxy.post({
    action: 'accountCreate', idToken: as('admin'),
    account: { id: 'usr_c', username: 'c', email: 'MiXeD@Case.EDU', roles: ['student'] },
  });
  const roster = proxy.root.read(['users'], 'users.json').users;
  const stored = roster.find((u) => u.id === 'usr_c');
  if (stored.email !== 'mixed@case.edu') throw new Error(`stored as ${stored.email}`);
});

check('at most two commanders', () => {
  const proxy = detachment([account('second', 'second@x.edu', ['commander'])]);
  const out = proxy.post({
    action: 'accountCreate', idToken: as('admin'),
    account: { id: 'usr_third', username: 'third', email: 'third@x.edu', roles: ['commander'] },
  });
  if (out.ok) throw new Error('a third commander was allowed');
  if (!/2 commanders/i.test(out.error)) throw new Error(out.error);
});

check('promoting a third person to commander is refused too', () => {
  const proxy = detachment([account('second', 'second@x.edu', ['commander'])]);
  const out = proxy.post({
    action: 'accountUpdate', idToken: as('admin'),
    id: 'usr_instructor', patch: { roles: ['commander'] },
  });
  if (out.ok) throw new Error('a third commander was promoted');
});

check('a deactivated commander does not count against the cap', () => {
  // Otherwise a departed commander would block their own replacement.
  const proxy = detachment([
    account('second', 'second@x.edu', ['commander'], { active: false }),
  ]);
  const out = proxy.post({
    action: 'accountCreate', idToken: as('admin'),
    account: { id: 'usr_third', username: 'third', email: 'third@x.edu', roles: ['commander'] },
  });
  if (!out.ok) throw new Error(out.error);
});

check('the rollover advances students and retires the top year', () => {
  const proxy = detachment([
    account('junior', 'junior@x.edu', ['student'], { asClass: 'AS100' }),
    account('senior', 'senior@x.edu', ['student'], { asClass: 'AS400' }),
  ]);
  const out = proxy.post({
    action: 'rollover', idToken: as('admin'),
    moves: { AS100: 'AS200', AS400: null }, deactivate: true,
  });
  if (!out.ok) throw new Error(out.error);

  const roster = proxy.root.read(['users'], 'users.json').users;
  const junior = roster.find((u) => u.username === 'junior');
  const senior = roster.find((u) => u.username === 'senior');
  if (junior.asClass !== 'AS200') throw new Error(`junior is ${junior.asClass}`);
  if (senior.active !== false) throw new Error('the graduating cadet was not deactivated');
  if (senior.asClass !== 'AS400') throw new Error('the graduating cadet lost their level');
});

check('the rollover leaves staff alone', () => {
  const proxy = detachment();
  proxy.post({
    action: 'rollover', idToken: as('admin'),
    moves: { AS200: 'AS300' }, deactivate: true,
  });
  const roster = proxy.root.read(['users'], 'users.json').users;
  const instructor = roster.find((u) => u.username === 'instructor');
  if (instructor.asClass !== 'AS200') throw new Error('an instructor was advanced');
});

/* ------------------------------------------------------------------ *
 * deletion means permanently anonymised
 *
 * Removing a roster entry alone would leave the person's name on every
 * attributed response and their username on every receipt — so "delete this
 * person" would mean "stop them signing in" and nothing more. And a backup
 * export would carry all of it out of the folder on a laptop.
 * ------------------------------------------------------------------ */

/** A detachment where the cadet has answered an attributed form. */
function withNamedAnswer() {
  const proxy = detachment();
  proxy.root.put(['requests'], 'req_named.json', {
    id: 'req_named', formId: 'form_1', status: 'open', asClass: 'AS200',
    anonymous: false, space: 'shared', assignedUsernames: [],
  });
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_named', answers: { q1: 5 } });
  return proxy;
}

check('deleting an account strips the respondent from their answers', () => {
  const proxy = withNamedAnswer();
  const before = Object.entries(proxy.root.snapshot())
    .find(([k]) => k.startsWith('responses/req_named/'))[1];
  if (before.respondent?.username !== 'cadet') throw new Error('the fixture is not attributed');

  const out = proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_cadet' });
  if (!out.ok) throw new Error(out.error);

  const after = Object.entries(proxy.root.snapshot())
    .find(([k]) => k.startsWith('responses/req_named/'))[1];
  if (after.respondent !== null) throw new Error('the respondent survived');
  if (after.anonymous !== true) throw new Error('the response is not marked anonymous');
  if (!after.anonymisedAt) throw new Error('no record of when it was anonymised');
});

check('the answer itself is kept — this removes the person, not the feedback', () => {
  const proxy = withNamedAnswer();
  proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_cadet' });
  const after = Object.entries(proxy.root.snapshot())
    .find(([k]) => k.startsWith('responses/req_named/'))[1];
  if (after.answers?.q1 !== 5) throw new Error('the feedback was destroyed');
});

check('the username survives nowhere in the folder afterwards', () => {
  const proxy = withNamedAnswer();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_commander', answers: { q1: 3 } });
  proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_cadet' });

  const dump = proxy.root.snapshot();
  for (const [path, value] of Object.entries(dump)) {
    if (path.startsWith('audit/')) continue;   // the audit line records the removal on purpose
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (/\bcadet\b/.test(text)) throw new Error(`"cadet" still appears in ${path}`);
    if (text.includes('cadet@x.edu')) throw new Error(`their address still appears in ${path}`);
  }
});

check('receipts keep their count but lose the name', () => {
  // Completion tracking must still add up, or removing someone would silently
  // rewrite history about who took part.
  const proxy = withNamedAnswer();
  const before = Object.keys(proxy.root.snapshot()).filter((k) => k.startsWith('receipts/req_named/'));
  if (before.length !== 1) throw new Error(`expected one receipt, found ${before.length}`);

  proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_cadet' });

  const after = Object.entries(proxy.root.snapshot())
    .filter(([k]) => k.startsWith('receipts/req_named/'));
  if (after.length !== 1) throw new Error(`receipt count changed to ${after.length}`);
  const [name, value] = after[0];
  if (/cadet/.test(name)) throw new Error(`the receipt is still named ${name}`);
  if (value.username !== null) throw new Error('the receipt still carries a username');
  if (value.removed !== true) throw new Error('the receipt is not marked removed');
});

check('records are anonymised in every space, not only reachable ones', () => {
  // An administrator cannot read the commander space, but a person deleted from
  // the roster must not survive in it.
  const proxy = detachment();
  proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_commander', answers: { q1: 8 } });
  proxy.root.put(['commander', 'responses', 'req_commander'], 'res_named.json', {
    id: 'res_named', requestId: 'req_commander', anonymous: false,
    respondent: { username: 'cadet', name: 'cadet' }, answers: { q1: 2 },
  });

  proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_cadet' });

  const stored = proxy.root.read(['commander', 'responses', 'req_commander'], 'res_named.json');
  if (stored.respondent !== null) throw new Error('a commander-space response kept its respondent');
});

check('the deletion is recorded with what it anonymised', () => {
  const proxy = withNamedAnswer();
  proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_cadet' });
  const entry = Object.entries(proxy.root.snapshot()).find(([k]) => k.startsWith('audit/'))[1];
  if (entry.actor.username !== 'admin') throw new Error('the wrong actor was recorded');
  if (!entry.detail || entry.detail.responsesAnonymised < 1) {
    throw new Error('the audit entry does not say what was anonymised');
  }
  if (entry.severe !== true) throw new Error('an irreversible deletion is not marked severe');
});

check('deleting a non-existent account is refused rather than silently succeeding', () => {
  const proxy = detachment();
  const out = proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_nobody' });
  if (out.ok) throw new Error('accepted a deletion of nobody');
});

/**
 * The detachment must always be able to administer itself.
 *
 * The console refuses to remove or demote the last administrator, and for a
 * public endpoint that refusal is worth whatever the client chooses to honour.
 * A roster with people and no admin is not self-healing the way an empty one is:
 * the first-arrival bootstrap only fires on an empty roster, so the only way
 * back is hand-editing users.json in Drive.
 */
check('the last administrator cannot be deleted', () => {
  const proxy = detachment();
  const out = proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_admin' });
  if (out.ok) throw new Error('the only administrator was deleted');
  if (!/no administrator/i.test(out.error || '')) {
    throw new Error(`refused, but not for that reason: ${out.error}`);
  }
  const roster = proxy.root.read(['users'], 'users.json').users;
  if (!roster.some((u) => u.id === 'usr_admin')) throw new Error('removed anyway');
});

check('the last administrator cannot demote themselves', () => {
  const proxy = detachment();
  const out = proxy.post({
    action: 'accountUpdate', idToken: as('admin'), id: 'usr_admin',
    patch: { roles: ['instructor'] },
  });
  if (out.ok) throw new Error('the only administrator dropped the role');
  const roster = proxy.root.read(['users'], 'users.json').users;
  const admin = roster.find((u) => u.id === 'usr_admin');
  if (!(admin.roles || []).includes('admin')) throw new Error('the role was dropped anyway');
});

check('an administrator can be deleted once another one exists', () => {
  // The floor is one, not "never" — a handover has to be possible.
  const proxy = detachment([account('admin2', 'admin2@x.edu', ['admin'])]);
  const out = proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_admin' });
  if (!out.ok) throw new Error(`a spare administrator did not permit the deletion: ${out.error}`);
  const roster = proxy.root.read(['users'], 'users.json').users;
  if (roster.some((u) => u.id === 'usr_admin')) throw new Error('not actually removed');
});

check('a refused deletion does not anonymise anything first', () => {
  // The sweep is irreversible, so the refusal has to happen before it. Checking
  // afterwards would leave the records scrubbed and the account still present —
  // the worst of both.
  const proxy = withNamedAnswer();
  const out = proxy.post({ action: 'accountDelete', idToken: as('admin'), id: 'usr_admin' });
  if (out.ok) throw new Error('the only administrator was deleted');

  // The admin's own name is not in the records; the cadet's is. What matters is
  // that the sweep did not run at all, so nothing was rewritten.
  const dump = proxy.root.snapshot();
  const named = Object.entries(dump)
    .filter(([path]) => path.startsWith('responses/'))
    .some(([, value]) => /\bcadet\b/.test(JSON.stringify(value)));
  if (!named) throw new Error('records were anonymised despite the deletion being refused');
});

check('an instructor cannot delete an account', () => {
  const proxy = withNamedAnswer();
  const out = proxy.post({ action: 'accountDelete', idToken: as('instructor'), id: 'usr_cadet' });
  if (out.ok) throw new Error('an instructor deleted an account');
  const roster = proxy.root.read(['users'], 'users.json').users;
  if (!roster.some((u) => u.id === 'usr_cadet')) throw new Error('the account was removed anyway');
});

/* ------------------------------------------------------------------ *
 * failure modes
 * ------------------------------------------------------------------ */

check('an unconfigured deployment says so rather than throwing', () => {
  const proxy = createProxy({ configured: false });
  const out = proxy.post({ action: 'catalog', idToken: 'x' });
  if (out.ok) throw new Error('an unconfigured proxy served a request');
  if (!/not been configured/i.test(out.error)) throw new Error(out.error);
  const health = proxy.get();
  if (health.configured !== false) throw new Error('doGet claims it is configured');
});

check('a body that is not JSON is refused rather than throwing', () => {
  const proxy = detachment();
  for (const junk of ['not json at all', '{"unclosed":', '', '<html></html>']) {
    const out = proxy.postRaw(junk);
    if (out.ok) throw new Error(`accepted ${JSON.stringify(junk)}`);
    if (!/JSON|Empty/i.test(out.error)) throw new Error(`unhelpful message: ${out.error}`);
  }
});

check('a refusal never carries a stack trace', () => {
  // The endpoint is public; an internal error message is an information gift.
  //
  // This used to send one submission with the answers omitted and `return` if it
  // came back ok — which it does, because the script tolerates that. So the
  // assertion below had never once executed. Several refusals are provoked
  // instead, and the test fails if none of them is a refusal, so it cannot go
  // quietly vacuous a second time.
  const proxy = detachment();
  const refusals = [
    proxy.post({ action: 'submit', idToken: as('cadet'), answers: { q1: 1 } }),
    proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_nope', answers: { q1: 1 } }),
    proxy.post({ action: 'nonsense', idToken: as('cadet') }),
    proxy.post({ action: 'roster', idToken: as('cadet') }),
    proxy.post({ action: 'roster', idToken: 'tok-forged' }),
  ];

  const refused = refusals.filter((out) => out && out.ok === false);
  if (refused.length !== refusals.length) {
    throw new Error(`only ${refused.length} of ${refusals.length} were refused — `
      + 'this check is only worth anything if it has refusals to inspect');
  }
  for (const out of refused) {
    if (/\bat \w+ \(|Error:|\.gs:\d/.test(out.error)) {
      throw new Error(`a stack trace reached the caller: ${out.error}`);
    }
    if (!out.error) throw new Error('a refusal came back with no reason at all');
  }
});

check('an oversized body is refused', () => {
  const proxy = detachment();
  const out = proxy.post({
    action: 'submit', idToken: as('cadet'), requestId: 'req_shared',
    answers: { q1: 'x'.repeat(200 * 1024) },
  });
  if (out.ok) throw new Error('accepted a body over the size limit');
  if (!/too large/i.test(out.error)) throw new Error(out.error);
});

check('lock contention is reported, not swallowed', () => {
  const proxy = detachment();
  proxy.holdLock();
  const out = proxy.post({ action: 'submit', idToken: as('cadet'), requestId: 'req_shared', answers: {} });
  proxy.releaseLock();
  if (out.ok) throw new Error('a submission proceeded while the lock was held');
  if (!/busy/i.test(out.error)) throw new Error(out.error);
});

/* ---------- form questions are space-scoped ---------- */

/**
 * Forms lived in one flat folder while requests were already separated, so a
 * commander-only request kept its *questions* somewhere every instructor could
 * read. The questions are the sensitive part: "describe the complaint against
 * Capt Reyes" is the disclosure, not the answer to it.
 */

check('an instructor cannot read a commander-only form', () => {
  const proxy = detachment();
  proxy.post({ action: 'saveForm', idToken: as('commander'), form: {
    id: 'form_locked', name: 'Review', space: 'commander',
    sections: [{ title: 't', items: [{ id: 'q1', type: 'text', label: 'SECRET-QUESTION' }] }] } });

  const seen = proxy.post({ action: 'catalog', idToken: as('instructor') });
  if (JSON.stringify(seen.catalog.forms).includes('SECRET-QUESTION')) {
    throw new Error('the questions of a commander-only form reached an instructor');
  }
});

check('an instructor cannot delete a form they cannot see', () => {
  const proxy = detachment();
  proxy.post({ action: 'saveForm', idToken: as('commander'), form: {
    id: 'form_locked', name: 'Review', space: 'commander', sections: [] } });

  const out = proxy.post({ action: 'deleteForm', idToken: as('instructor'), formId: 'form_locked' });
  if (out.ok) throw new Error('an instructor deleted a commander-only form');

  const still = proxy.post({ action: 'catalog', idToken: as('commander') });
  if (!still.catalog.forms.some((f) => f.id === 'form_locked')) {
    throw new Error('the form went anyway');
  }
});

check('a form cannot be pulled out of its space by overwriting it', () => {
  const proxy = detachment();
  proxy.post({ action: 'saveForm', idToken: as('commander'), form: {
    id: 'form_locked', name: 'Review', space: 'commander', sections: [] } });

  const out = proxy.post({ action: 'saveForm', idToken: as('instructor'), form: {
    id: 'form_locked', name: 'hijacked', space: 'shared', sections: [] } });
  if (out.ok) throw new Error('a form was moved into the shared area by an instructor');
});

check('a cadet still gets the form for a request in any space', () => {
  // The scoping must not break the one reader who legitimately spans spaces.
  const proxy = detachment();
  proxy.post({ action: 'saveForm', idToken: as('commander'), form: {
    id: 'form_c', name: 'Commander form', space: 'commander',
    sections: [{ title: 't', items: [{ id: 'q1', type: 'text', label: 'Q' }] }] } });
  proxy.post({ action: 'saveRequest', idToken: as('commander'), request: {
    id: 'req_c', title: 'Commander ask', space: 'commander', formId: 'form_c',
    status: 'open', asClass: 'AS200' } });

  const bundle = proxy.post({ action: 'bundle', idToken: as('cadet') }).bundle;
  if (!bundle.requests.some((r) => r.id === 'req_c')) throw new Error('the request was not offered');
  if (!bundle.forms.form_c) throw new Error('the cadet was offered a request with no form to answer');
});

/* ---------- roster changes record themselves ---------- */

check('granting a role is recorded by the server, not by the client', () => {
  // The client writes an audit entry too, but the client is the thing being
  // guarded against — an attacker calling the API directly simply would not.
  const proxy = detachment();
  const admin = proxy.post({ action: 'roster', idToken: as('admin') })
    .users.find((u) => u.username === 'admin');

  proxy.post({ action: 'accountUpdate', idToken: as('admin'), id: admin.id,
    patch: { roles: ['admin', 'commander'] } });

  const entries = proxy.post({ action: 'audit', idToken: as('admin'), months: 2 }).entries;
  const logged = entries.find((e) => e.action === 'account.roles.changed');
  if (!logged) throw new Error('a role grant left no server-side trace');
  if (!logged.severe) throw new Error('a role grant was not marked severe');
  if (logged.actor.username !== 'admin') throw new Error('the actor was not taken from the token');
  if (!/commander/.test(logged.summary)) throw new Error(logged.summary);
});

check('creating an account is recorded', () => {
  const proxy = detachment();
  proxy.post({ action: 'accountCreate', idToken: as('admin'),
    account: { id: 'usr_new', username: 'new', email: 'new@det.edu', roles: ['student'] } });
  const entries = proxy.post({ action: 'audit', idToken: as('admin'), months: 2 }).entries;
  if (!entries.some((e) => e.action === 'account.created')) {
    throw new Error('an account appeared on the roster with no record of who added it');
  }
});

/* ---------- the endpoint is public, so junk must be cheap ---------- */

check('a token that cannot be real costs no call to Google', () => {
  // Every post used to spend one UrlFetch whatever it carried, and Apps Script
  // allows a fixed number per day — so a stranger could take a detachment
  // offline until midnight by posting nonsense at the public URL.
  const proxy = detachment();
  const before = proxy.fetches.length;
  for (const junk of ['made-up', '', '...', 'a.b.c', 'x'.repeat(400)]) {
    proxy.post({ action: 'catalog', idToken: junk });
  }
  if (proxy.fetches.length !== before) {
    throw new Error(`${proxy.fetches.length - before} network call(s) spent on unusable tokens`);
  }
});

check('a token for another application costs no call either', () => {
  const proxy = createProxy({ tokens: { other: { ...validToken('x@x.edu'), aud: 'someone-else' } } });
  seedRoster(proxy.root, [account('x', 'x@x.edu', ['instructor'])]);
  const before = proxy.fetches.length;
  const out = proxy.post({ action: 'catalog', idToken: 'other' });
  if (out.ok) throw new Error('accepted a token minted for another client');
  if (proxy.fetches.length !== before) throw new Error('spent a call on a token it could reject locally');
});

check('one token verified repeatedly is verified once', () => {
  const proxy = detachment();
  proxy.post({ action: 'catalog', idToken: as('instructor') });
  const after = proxy.fetches.length;
  for (let i = 0; i < 4; i++) proxy.post({ action: 'catalog', idToken: as('instructor') });
  if (proxy.fetches.length !== after) {
    throw new Error(`re-verified a cached token ${proxy.fetches.length - after} time(s)`);
  }
});

check('the local pre-check never replaces the real one', () => {
  // A token Google has never heard of is well-formed enough to pass every local
  // check. It must still be refused.
  const forged = { ...validToken('ghost@det.edu') };
  const proxy = createProxy({ tokens: {} });   // UrlFetchApp knows no tokens
  seedRoster(proxy.root, [account('ghost', 'ghost@det.edu', ['admin'])]);

  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const jwt = `${b64({ alg: 'RS256' })}.${b64(forged)}.${Buffer.from('sig').toString('base64url')}`;

  const out = proxy.post({ action: 'roster', idToken: jwt });
  if (out.ok) throw new Error('a locally well-formed but unverified token was accepted');
});

/* ------------------------------------------------------------------ *
 * the By-instructor tiers
 *
 * An instructor sees their own results, cadre see the instructors they
 * oversee, a commander sees everyone. The narrowing happens in `readPeople`
 * before anything is returned, so these assert the *payload* — a check on what
 * the screen renders would pass just as happily with a client-side filter over
 * everybody's records, which is the thing this must not be.
 * ------------------------------------------------------------------ */

/** Two instructors, a cadre member and a commander, each with feedback about them. */
function oversight(extraAccounts = [], extraRequests = []) {
  const people = [
    account('teachone', 'one@x.edu', ['instructor']),
    account('teachtwo', 'two@x.edu', ['instructor']),
    account('cadre', 'cadre@x.edu', ['cadre']),
    account('commander', 'commander@x.edu', ['commander']),
    ...extraAccounts,
  ];
  const tokens = {};
  for (const person of people) tokens[`tok-${person.username}`] = validToken(person.email);
  const proxy = createProxy({ tokens });
  seedRoster(proxy.root, people);

  // subject is who the feedback is about; createdBy is who issued it.
  for (const [id, subject, createdBy] of [
    ['req_one', 'teachone', 'teachone'],
    ['req_two', 'teachtwo', 'teachtwo'],
    ['req_cadre_subject', 'cadre', 'commander'],
    ['req_issued_by_one', 'teachtwo', 'teachone'],
    ...extraRequests,
  ]) {
    proxy.root.put(['requests'], `${id}.json`, {
      id, formId: 'form_1', title: id, status: 'open', asClass: 'AS200',
      anonymous: true, space: 'shared', subject, createdBy, assignedUsernames: [],
    });
  }
  proxy.root.put(['forms'], 'form_1.json', { id: 'form_1', name: 'Form', sections: [] });
  return proxy;
}

const peopleIds = (proxy, who) =>
  (proxy.post({ action: 'people', idToken: as(who) }).people?.requests || [])
    .map((r) => r.id).sort().join(',');

const peopleStaff = (proxy, who) =>
  (proxy.post({ action: 'people', idToken: as(who) }).people?.staff || [])
    .map((a) => a.username).sort().join(',');

check('an instructor gets only what is about them, or what they issued', () => {
  const seen = peopleIds(oversight(), 'teachone');
  if (seen !== 'req_issued_by_one,req_one') throw new Error(`saw ${seen}`);
});

check('an instructor does not get another instructor\'s results', () => {
  const seen = peopleIds(oversight(), 'teachone');
  if (seen.includes('req_two')) throw new Error('req_two came back');
});

check('cadre get every instructor, and themselves', () => {
  const seen = peopleIds(oversight(), 'cadre');
  // req_cadre_subject is about the cadre member, so it is theirs to see.
  if (seen !== 'req_cadre_subject,req_issued_by_one,req_one,req_two') {
    throw new Error(`saw ${seen}`);
  }
});

check('a commander gets everything, cadre subjects included', () => {
  const seen = peopleIds(oversight(), 'commander');
  if (seen !== 'req_cadre_subject,req_issued_by_one,req_one,req_two') {
    throw new Error(`saw ${seen}`);
  }
});

check('cadre are not treated as instructor subjects by another cadre member', () => {
  // The trap: ROLE_IMPLIES makes cadre imply instructor, so a tier computed on
  // effective roles would hand every cadre member each other's results. Two
  // cadre, and neither may see the other.
  const proxy = oversight(
    [account('cadretwo', 'cadretwo@x.edu', ['cadre'])],
    [['req_cadre_two', 'cadretwo', 'commander']],
  );

  const seen = peopleIds(proxy, 'cadre');
  if (seen.includes('req_cadre_two')) throw new Error('a cadre member saw another cadre member');
});

check('the staff list is narrowed too, so it cannot enumerate the excluded', () => {
  const proxy = oversight();
  if (peopleStaff(proxy, 'teachone') !== 'teachone') {
    throw new Error(`instructor saw staff: ${peopleStaff(proxy, 'teachone')}`);
  }
  if (peopleStaff(proxy, 'cadre') !== 'cadre,teachone,teachtwo') {
    throw new Error(`cadre saw staff: ${peopleStaff(proxy, 'cadre')}`);
  }
  if (peopleStaff(proxy, 'commander') !== 'cadre,commander,teachone,teachtwo') {
    throw new Error(`commander saw staff: ${peopleStaff(proxy, 'commander')}`);
  }
});

check('a cadet cannot call the people action at all', () => {
  const proxy = detachment();
  const out = proxy.post({ action: 'people', idToken: as('cadet') });
  if (out.ok) throw new Error('a cadet reached the By-instructor data');
});

console.log(failures ? `\n${failures} behaviour check(s) failed.` : '\nAll proxy behaviour checks passed.');
process.exit(failures ? 1 : 0);
