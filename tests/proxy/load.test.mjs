/**
 * What the proxy costs, at the size a real detachment actually is.
 *
 *     npm run test:proxy
 *
 * `behaviour.test.mjs` asks whether the script is correct. This asks what it
 * costs, because correctness is not the thing that breaks on a drill night.
 *
 * WHY COUNTING OPERATIONS IS THE RIGHT MEASUREMENT
 *
 * The binding limit on Apps Script is not money and not UrlFetch quota — it is
 * **30 simultaneous executions**. Two things fill those slots: how many calls
 * each cadet makes, and how long each call runs. And `submit` holds one
 * script-wide lock across all of its Drive work, so every submission in the
 * detachment serialises behind it: at N seconds of held time the (20/N)th
 * simultaneous submitter is refused by `waitLock(20000)`.
 *
 * None of that can be reproduced offline — this harness says so itself, and it
 * is right. What *can* be measured exactly, with no clock and no flakiness, is
 * the number of Drive round trips, which is what the held time is made of. So
 * these are budgets on operation counts, not on milliseconds. A test that
 * asserted seconds against an in-memory Map would be measuring nothing.
 *
 * ABOUT THE CEILINGS
 *
 * They are set just above what the script costs today, so they catch a change
 * that makes things worse rather than describing a target. Two of them are
 * higher than they should be and are marked as such below; both want a change
 * to `Code.gs`, which means every detachment redeploying, and that is a
 * decision rather than a fix.
 */

import {
  createProxy, validToken, seedRoster, account, ops, resetOps,
} from './harness.mjs';

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

/** Beta scale: five staff and forty-five cadets, one open request. */
function detachment(cadets = 45) {
  const people = [
    account('instructor', 'instructor@x.edu', ['instructor']),
    account('cadre', 'cadre@x.edu', ['cadre']),
    account('commander', 'commander@x.edu', ['commander']),
    account('admin', 'admin@x.edu', ['admin']),
    account('teach', 'teach@x.edu', ['instructor']),
  ];
  for (let i = 0; i < cadets; i++) {
    people.push(account(cadet(i), `cadet${i}@x.edu`, ['student']));
  }

  const tokens = {};
  for (const person of people) tokens[`tok-${person.username}`] = validToken(person.email);

  const proxy = createProxy({ tokens });
  seedRoster(proxy.root, people);
  proxy.root.put(['requests'], 'req_llab.json', {
    id: 'req_llab', formId: 'form_1', title: 'LLab 3 — Drill Block', status: 'open',
    asClass: 'AS200', anonymous: true, space: 'shared', assignedUsernames: [],
  });
  proxy.root.put(['forms'], 'form_1.json', { id: 'form_1', name: 'Drill Block', sections: [] });
  return proxy;
}

const cadet = (i) => `cadet${String(i).padStart(2, '0')}`;
const as = (username) => `tok-${username}`;

const submit = (proxy, username) => proxy.post({
  action: 'submit', idToken: as(username),
  requestId: 'req_llab', formId: 'form_1', answers: { q1: 7 },
});

/* ---------- correctness at volume ---------- */

check('forty-five cadets submit, and forty-five submissions survive', () => {
  const proxy = detachment();
  let accepted = 0;
  for (let i = 0; i < 45; i++) if (submit(proxy, cadet(i)).ok) accepted += 1;
  if (accepted !== 45) throw new Error(`${accepted}/45 were accepted`);

  // Counted from the store rather than from the answers, because the failure
  // this is really watching for is two cadets being handed the same filename.
  // That is not hypothetical: it is what this harness did until the fake
  // getUuid was given its counter in the leading characters, and at eight
  // cadets it looked exactly like success.
  const files = proxy.root.snapshot();
  const responses = Object.keys(files).filter((p) => p.startsWith('responses/'));
  const receipts = Object.keys(files).filter((p) => p.startsWith('receipts/'));
  if (responses.length !== 45) throw new Error(`${responses.length} response files, not 45`);
  if (receipts.length !== 45) throw new Error(`${receipts.length} receipt files, not 45`);

  const ids = new Set(responses.map((p) => files[p].id));
  if (ids.size !== 45) throw new Error(`${ids.size} distinct response ids among 45 responses`);
});

check('a cadet who submits twice is refused the second time', () => {
  const proxy = detachment();
  if (!submit(proxy, cadet(0)).ok) throw new Error('the first submission was refused');
  const second = submit(proxy, cadet(0));
  if (second.ok) throw new Error('the second submission was accepted');
  if (!/already submitted/i.test(second.error)) throw new Error(second.error);
});

/**
 * The property that licenses retrying a busy submission on the client.
 *
 * A retry is normally the wrong answer for a submission: an attempt that
 * succeeded but whose answer was lost comes back as "you have already
 * submitted", which tells a cadet their feedback failed when it is already
 * filed. That reasoning is in `data-source.js`, and it holds.
 *
 * It does not hold for *this* refusal. Failing to take the lock happens before
 * anything is written, so there is provably nothing to duplicate — and the
 * client may therefore retry this one message and no other. This test is what
 * makes that claim true rather than assumed, so it guards a client behaviour
 * from the server side.
 */
check('a submission refused for a busy lock writes absolutely nothing', () => {
  const proxy = detachment();
  const before = JSON.stringify(proxy.root.snapshot());

  proxy.holdLock();
  const refused = submit(proxy, cadet(0));
  proxy.releaseLock();

  if (refused.ok) throw new Error('the submission went through while the lock was held');
  if (!/busy/i.test(refused.error)) throw new Error(`refused for another reason: ${refused.error}`);

  const after = JSON.stringify(proxy.root.snapshot());
  if (before !== after) throw new Error('a refused submission left something behind');

  // And the cadet is still able to submit once the lock frees, which is the
  // other half of what a retry needs.
  if (!submit(proxy, cadet(0)).ok) throw new Error('the retry after the lock freed was refused');
});

/* ---------- what it costs ---------- */

check('the submit critical section stays small enough to let a flight through', () => {
  const proxy = detachment();
  submit(proxy, cadet(0));
  const held = proxy.lockedOps.at(-1);

  // Every submission in the detachment queues behind this. Thirteen Drive round
  // trips is roughly a second and a half on a real deployment, which is about
  // as much as a forty-five-cadet flight can absorb inside waitLock's twenty.
  if (held > 16) throw new Error(`${held} Drive operations under the lock, budget 16`);
  console.log(`       submit holds the lock for ${held} Drive operations`);
});

check('one cadet’s whole drill night is two posts and one token verification', () => {
  const proxy = detachment();
  resetOps();
  proxy.fetches.length = 0;

  // The sequence the client sends: read what I have been assigned, then answer
  // it. Anything more is a simultaneous-execution slot taken from someone else.
  proxy.post({ action: 'bundle', idToken: as(cadet(1)) });
  submit(proxy, cadet(1));

  const cost = ops();
  if (cost > 40) throw new Error(`${cost} Drive operations for one cadet, budget 40`);

  // One verification, not two: the script caches a verified token by its own
  // digest, and that cache is the only thing standing between a public endpoint
  // and a detachment's daily UrlFetch quota.
  if (proxy.fetches.length !== 1) {
    throw new Error(`${proxy.fetches.length} tokeninfo calls for one cadet's session`);
  }
  console.log(`       one cadet: ${cost} Drive operations, ${proxy.fetches.length} token verification`);
});

check('a whole flight submitting costs what forty-five of one cadet costs', () => {
  const proxy = detachment();
  resetOps();
  for (let i = 0; i < 45; i++) submit(proxy, cadet(i));
  const cost = ops();

  // Linear, not quadratic. A shared index or a counter updated per submission
  // would show up here as a cost that climbs with the number already filed, and
  // the storage layer deliberately has neither.
  if (cost > 45 * 20) throw new Error(`${cost} operations for 45 submissions — worse than linear`);
  console.log(`       45 submissions: ${cost} Drive operations, ${Math.round(cost / 45)} each`);
});

/* ---------- two costs that are higher than they should be ---------- */

/**
 * Pinned at today's number rather than at a good one.
 *
 * `doPost` reads the roster to find the caller before it checks whether the
 * caller may do anything, so an action refused on role still costs a full
 * `users.json` download. It cannot simply be reordered — the role check needs
 * the roles, which is what the read returns. The fix is to memoise the read for
 * the life of the execution, and that is a `Code.gs` change, which means every
 * detachment redeploying.
 *
 * Worth knowing it is cheap in absolute terms: three operations. It is here so
 * that if a refusal ever starts costing more, somebody finds out.
 */
check('a refused action costs one roster read and no more', () => {
  const proxy = detachment();
  resetOps();
  const refused = proxy.post({ action: 'roster', idToken: as(cadet(0)) });
  if (refused.ok) throw new Error('a cadet was allowed to read the roster');
  const cost = ops();
  if (cost > 4) throw new Error(`${cost} operations to refuse one cadet, budget 4`);
  console.log(`       a refusal costs ${cost} operations — a full users.json read`);
});

/**
 * The one that actually gets expensive, also pinned rather than fixed.
 *
 * `requestInPeopleScope` calls `findByUsername` for each request it evaluates,
 * and `findByUsername` re-reads the whole roster every time. At twenty requests
 * that is twenty downloads of a fifty-four-person `users.json` inside a single
 * execution, and it grows with the term.
 *
 * It only bites on the middle tier — a cadre looking at instructors. A
 * commander is 'all' and returns before the read; an instructor is 'own' and
 * never reaches it. So it is a staff-side cost, not a drill-night one, which is
 * why it is documented here rather than fixed in a hurry.
 */
check('By-instructor grows linearly with requests, and is watched for growing faster', () => {
  const cost = (requests) => {
    const proxy = detachment(1);
    for (let i = 0; i < requests; i++) {
      proxy.root.put(['requests'], `req_${i}.json`, {
        id: `req_${i}`, formId: 'form_1', title: `R${i}`, status: 'open',
        asClass: 'AS200', anonymous: false, space: 'shared',
        assignedUsernames: [], subject: 'teach',
      });
    }
    resetOps();
    const out = proxy.post({ action: 'people', idToken: as('cadre') });
    if (!out.ok) throw new Error(`the people action was refused: ${out.error}`);
    return ops();
  };

  const [five, twenty] = [cost(5), cost(20)];
  const perRequest = (twenty - five) / 15;

  // Five per request, three of which are the roster being downloaded again.
  if (perRequest > 6) {
    throw new Error(`${perRequest} operations per request, budget 6 — the roster read may have grown`);
  }
  console.log(`       By-instructor: ${perRequest} operations per request, `
    + `${Math.round((3 / perRequest) * 100)}% of it re-reading the roster`);
});

console.log(failures
  ? `\n${failures} load check(s) failed.`
  : '\nThe proxy costs what it should at a detachment’s real size.');
process.exit(failures ? 1 : 0);
