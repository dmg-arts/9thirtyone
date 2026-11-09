/**
 * Where the staff screens spend their round trips.
 *
 *     node tools/proxy/profile.mjs
 *
 * Written for phase 1.1 of the 1.4 plan, to settle a choice that was about to
 * be made on instinct: stage 0 memoises the roster, stage 2b batches across
 * folders, and nobody knew which of them the 13 s of `allResponses` and the
 * 18.5 s of `people` actually belonged to. Guessing is how the 7x projection
 * turned out to be 2.2x.
 *
 * Round trips, not milliseconds. The fake Drive answers instantly, so wall
 * clock here is meaningless — but a round trip is a round trip, and staging
 * measured what one costs: roughly 300-500 ms for a DriveApp call, and a REST
 * batch being one list plus one concurrent fetch however many documents ride
 * in it. Multiply the counts below by those and the shape is the real shape.
 *
 * Categories, because the total is not the useful part:
 *
 *   drive-path    DriveApp getFoldersByName — walking a path segment by segment
 *   drive-list    DriveApp getFiles/getFolders — enumerating a folder
 *   drive-read    DriveApp getBlob — a document read that did not go through REST
 *   rest-list     files?q= — one per folder scanned
 *   rest-media    files/{id}?alt=media — one per document, inside a batch
 *   rest-batch    fetchAll calls — the thing concurrency actually buys
 */

import { createProxy, validToken, seedRoster, account, ops, resetOps, net } from '../../tests/proxy/harness.mjs';

const cadet = (i) => `cadet${String(i).padStart(2, '0')}`;

function build({ cadets, requests }) {
  const people = [
    account('instructor', 'instructor@x.edu', ['instructor']),
    account('cadre', 'cadre@x.edu', ['cadre']),
    account('commander', 'commander@x.edu', ['commander']),
    account('teach', 'teach@x.edu', ['instructor']),
  ];
  for (let i = 0; i < cadets; i++) people.push(account(cadet(i), `cadet${i}@x.edu`, ['student']));

  const tokens = {};
  for (const p of people) tokens[`tok-${p.username}`] = validToken(p.email);
  const proxy = createProxy({ tokens });
  seedRoster(proxy.root, people);

  for (let r = 0; r < requests; r++) {
    proxy.root.put(['requests'], `req_${r}.json`, {
      id: `req_${r}`, formId: `form_${r}`, title: `Request ${r}`, status: 'open',
      asClass: 'AS200', anonymous: true, space: 'shared', assignedUsernames: [],
      subject: 'teach',
    });
    // A form per request, not one shared form. The original fixture gave every
    // request `form_1`, which hid a per-form read that grew with the term.
    proxy.root.put(['forms'], `form_${r}.json`, { id: `form_${r}`, name: `F${r}`, sections: [] });
  }
  // Responses spread across the requests, as a real term produces them.
  for (let i = 0; i < cadets; i++) {
    const r = i % requests;
    proxy.root.put(['responses', `req_${r}`], `${cadet(i)}.json`, {
      id: `resp_${i}`, requestId: `req_${r}`, answers: { q1: 7 },
    });
  }
  return proxy;
}

/** Counts round trips by category, by wrapping the bindings the script uses. */
function instrument(proxy) {
  const tally = {
    'drive-path': 0, 'drive-list': 0, 'drive-read': 0,
    'rest-list': 0, 'rest-media': 0, 'rest-batch': 0,
  };

  const realFetch = proxy.sandbox.UrlFetchApp.fetch;
  proxy.sandbox.UrlFetchApp.fetch = function (url, options) {
    const u = String(url);
    if (u.indexOf('/drive/v3/files?') >= 0) tally['rest-list'] += 1;
    else if (u.indexOf('alt=media') >= 0) tally['rest-media'] += 1;
    return realFetch.call(this, url, options);
  };
  const realAll = proxy.sandbox.UrlFetchApp.fetchAll;
  proxy.sandbox.UrlFetchApp.fetchAll = function (reqs) {
    tally['rest-batch'] += 1;
    return realAll.call(this, reqs);
  };

  // DriveApp comes back as folder objects, so wrap the prototype through one.
  const sample = proxy.sandbox.DriveApp.getFolderById('folder-1');
  const proto = Object.getPrototypeOf(sample);
  for (const [name, key] of [
    ['getFoldersByName', 'drive-path'], ['getFilesByName', 'drive-path'],
    ['getFolders', 'drive-list'], ['getFiles', 'drive-list'],
  ]) {
    const real = proto[name];
    proto[name] = function (...args) { tally[key] += 1; return real.apply(this, args); };
  }
  return tally;
}

function profile(label, shape, action, token) {
  const proxy = build(shape);
  const tally = instrument(proxy);
  resetOps();
  const out = proxy.post({ action, idToken: token });
  if (!out.ok) throw new Error(`${action} refused: ${out.error}`);
  const n = net();
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  console.log(`\n${label}  —  ${shape.cadets} responses across ${shape.requests} requests`);
  for (const [key, value] of Object.entries(tally)) {
    if (!value) continue;
    const bar = '#'.repeat(Math.min(40, value));
    console.log(`  ${key.padEnd(11)} ${String(value).padStart(4)}  ${bar}`);
  }
  console.log(`  ${'TOTAL'.padEnd(11)} ${String(total).padStart(4)}   (ops ${ops()}, `
    + `rest batches ${n.batches}, rest requests ${n.calls})`);
  return tally;
}

console.log('Round trips by category. Multiply by ~0.3-0.5s (DriveApp) to read as time.');

for (const shape of [{ cadets: 20, requests: 6 }, { cadets: 63, requests: 6 }, { cadets: 63, requests: 20 }]) {
  profile('allResponses (instructor)', shape, 'allResponses', 'tok-instructor');
}
for (const shape of [{ cadets: 63, requests: 6 }, { cadets: 63, requests: 20 }]) {
  profile('people (cadre)', shape, 'people', 'tok-cadre');
}
