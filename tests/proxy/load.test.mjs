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
  createProxy, validToken, seedRoster, account, ops, resetOps, net,
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

/*
 * The baseline stage 2 will be judged against, recorded before it is moved.
 *
 * Stage 2 replaces sequential `getFilesByName` reads with batched Drive REST
 * calls over `UrlFetchApp`. That will make `ops()` fall sharply, and `ops()`
 * alone cannot tell a genuine saving from the same work relocated onto a
 * surface it does not count. So both numbers are pinned here while the old
 * implementation is still the one running: afterwards, a drop in operations is
 * only real if these have not blown up to pay for it.
 *
 * The assertions are ceilings rather than equalities. An exact count would fail
 * on every unrelated change and be relaxed until it meant nothing.
 */
/*
 * The cost stage 2 moved, held to a shape rather than a number.
 *
 * Before stage 2 this asserted one outbound request per cadet, because every
 * read was Apps Script's own Drive binding and the only thing leaving the
 * script was one tokeninfo verification. Stage 2 reads through Drive REST, so
 * outbound calls are now the main cost and an exact count would be rewritten
 * every time a folder is added — until it meant nothing.
 *
 * What matters is that a cadet's outbound cost is **flat in the size of the
 * detachment**. One list call plus one fetchAll per folder read is O(folders);
 * a regression to one call per document would be O(responses), invisible in
 * ops() and fatal at a real detachment's scale. So the test grows the data and
 * asserts the call count does not follow.
 */
check('reading every response is a fixed number of outbound calls, not one per document', () => {
  // THE stage 2 invariant, and the only one ops() cannot see.
  //
  // allResponses is the screen that took 49.1s client-side on 15 Oct and ~50s
  // measured server-side against real Drive on 28 Oct. Stage 2 makes it one
  // list call plus one fetchAll per folder, so the outbound cost is O(folders)
  // and flat in the amount of feedback. A regression to one fetch per document
  // is O(responses) — identical in ops(), identical in behaviour, and fatal at
  // a detachment's real size.
  //
  // An earlier version of this test used a cadet's bundle and proved nothing:
  // a cadet bundle deliberately carries no responses, so growing the response
  // count could not move the number either way. It passed against a
  // deliberately regressed build, which is the only reason it was caught.
  const cost = (responses) => {
    const proxy = detachment(responses + 2);
    for (let i = 0; i < responses; i++) submit(proxy, cadet(i));
    resetOps();
    const out = proxy.post({ action: 'allResponses', idToken: as('instructor') });
    if (!out.ok) throw new Error(`allResponses was refused: ${out.error}`);
    const n = net();
    return { batches: n.batches, calls: n.calls, ops: ops(), rows: (out.responses || []).length };
  };

  const small = cost(5);
  const large = cost(40);

  if (large.rows <= small.rows) {
    throw new Error(`the larger detachment returned ${large.rows} responses, not more than ${small.rows} `
      + '— the test is not reading what it thinks it is');
  }

  // Batches flat: one list plus one fetchAll per folder, whatever is in them.
  if (large.batches > small.batches) {
    throw new Error(`round trips grew with the data: ${small.batches} at ${small.rows} responses `
      + `-> ${large.batches} at ${large.rows}. That is a per-document loop, and ops() cannot see it.`);
  }

  // Requests do grow, and that is the quota cost stage 2 moved onto UrlFetch.
  // Asserted as a shape, not a budget: roughly one per document, never more.
  if (large.calls > large.rows * 2 + 20) {
    throw new Error(`${large.calls} requests for ${large.rows} responses — more than one per document`);
  }

  console.log(`       allResponses: ${small.batches} round trips at ${small.rows} responses, `
    + `${large.batches} at ${large.rows} — flat; requests ${small.calls} -> ${large.calls}`);
});

/*
 * Stage 2c, held to the shape it fixed.
 *
 * readFolderDocs resolves a path from the root with one DriveApp lookup per
 * segment. Called once per request folder, that made path-walking 43% of
 * allResponses and — worse — made it grow with the number of requests a
 * detachment accumulates over a term: 15 lookups at 6 requests, 43 at 20.
 *
 * The callers already held those folders. Now they pass them. The assertion is
 * that the Apps Script surface stays flat as requests multiply, because that is
 * the property that was missing, not the absolute number.
 */
check('reading every response does not walk more paths as requests accumulate', () => {
  const cost = (requests) => {
    const proxy = detachment(12);
    for (let r = 0; r < requests; r++) {
      proxy.root.put(['requests'], `req_${r}.json`, {
        id: `req_${r}`, formId: 'form_1', title: `R${r}`, status: 'open',
        asClass: 'AS200', anonymous: true, space: 'shared', assignedUsernames: [],
      });
      proxy.root.put(['responses', `req_${r}`], 'cadet00.json',
        { id: `resp_${r}`, requestId: `req_${r}`, answers: { q1: 7 } });
    }
    resetOps();
    const out = proxy.post({ action: 'allResponses', idToken: as('instructor') });
    if (!out.ok) throw new Error(`allResponses was refused: ${out.error}`);
    return ops();
  };

  const [six, twenty] = [cost(6), cost(20)];
  if (twenty > six) {
    throw new Error(`Apps Script calls grew with requests: ${six} at 6 -> ${twenty} at 20. `
      + 'That is readFolderDocs re-resolving a path its caller already holds.');
  }
  console.log(`       allResponses: ${six} Apps Script calls at 6 requests, ${twenty} at 20 — flat`);
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
