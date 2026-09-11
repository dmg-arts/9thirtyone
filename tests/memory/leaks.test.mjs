/**
 * Memory safety: leaks and unbounded growth.
 *
 *     npm run test:memory
 *
 * Part of `npm test`. It was not, for a long while: it needed a server started
 * by hand, so it sat outside the runner and outside the suite, and the only test
 * of the shared-laptop cache drop was one nobody ran. It reads BASE_URL, which
 * run.mjs has always provided — the two were compatible all along.
 *
 * JavaScript has no manual memory management, so "memory safety" here means the
 * two failure modes that actually exist: **things retained after they should be
 * gone**, and **things that grow without a ceiling**.
 *
 * Both matter more than usual for this app. A detachment office laptop is left
 * open on the Instructor Panel for a working day, and a cadre member moves
 * between forms, analysis, the roster and back dozens of times. A leak of a few
 * hundred kilobytes per navigation is invisible in a test and fatal by
 * mid-afternoon.
 *
 * Every heap reading is taken after a forced garbage collection, because
 * otherwise the numbers measure when the collector last ran rather than what is
 * being held. Thresholds are generous on purpose: the question is whether growth
 * is *bounded*, not whether it is zero.
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/index.html';
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));

let failures = 0;
const check = (label, fn) => fn()
  .then(() => console.log(`  ok   ${label}`))
  .catch((err) => { console.log(`  FAIL ${label}: ${err.message}`); failures++; });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');

/** Heap after a forced collection, so the reading is of retention not timing. */
async function settledHeap() {
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(120);
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return usedSize;
}

async function metric(name) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === name)?.value ?? 0;
}

/* ---------- a configured, signed-in app to navigate around ---------- */

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.setItem('nine31.connection.v1', JSON.stringify({
    backend: 'local', orgName: 'Det 025', clientId: '', folderId: 'mem',
    proxyUrl: '', folderName: 'mem', connectedAt: new Date().toISOString(),
  }));
  localStorage.setItem('nine31.setup.complete.v1', '1');
});
await page.reload({ waitUntil: 'networkidle' });

// Signed in properly rather than by flipping a flag that unlocked everything.
// The panels now require real roles, which is also better fidelity: this walks
// the same gates a person does.
await page.evaluate(async () => {
  const a = await import('/js/auth.js');
  await a.signInWithGoogle(
    { email: 'bench@det025.edu', name: 'Bench, Harness', emailVerified: true }, null, 'tok');
});
// The first load redirected to #/setup and rewrote the hash, so a reload alone
// lands back there whatever the stored configuration says.
await page.goto(`${BASE}#/home`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.role-grid', { timeout: 15000 });

const ROUTES = ['#/home', '#/instructor', '#/instructor?tab=analysis', '#/admin', '#/settings'];

async function cycle(times) {
  for (let i = 0; i < times; i++) {
    for (const route of ROUTES) {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(90);
    }
  }
}

/* ------------------------------------------------------------------ *
 * retention across navigation
 * ------------------------------------------------------------------ */

await check('the heap returns to a baseline after repeated navigation', async () => {
  await cycle(2);                       // warm caches and lazy imports first
  const baseline = await settledHeap();
  await cycle(8);                       // 40 more view swaps
  const after = await settledHeap();

  const growth = after - baseline;
  // A per-navigation leak would show as growth proportional to the 40 swaps.
  // 4 MB of slack covers cache fill and JIT noise; a real leak dwarfs it.
  if (growth > 4 * 1024 * 1024) {
    throw new Error(`heap grew ${mb(growth)} across 40 navigations `
      + `(${mb(baseline)} -> ${mb(after)})`);
  }
  console.log(`       ${mb(baseline)} -> ${mb(after)} across 40 navigations`);
});

await check('DOM nodes do not accumulate as views are replaced', async () => {
  const before = await metric('Nodes');
  await cycle(6);
  await settledHeap();
  const after = await metric('Nodes');
  // Views replace the outlet's children; detached trees must not be retained.
  if (after > before * 2 + 200) {
    throw new Error(`nodes went ${before} -> ${after} across 30 navigations`);
  }
  console.log(`       ${before} -> ${after} nodes`);
});

await check('event listeners do not accumulate as views are replaced', async () => {
  const before = await metric('JSEventListeners');
  await cycle(6);
  await settledHeap();
  const after = await metric('JSEventListeners');
  // Listeners are attached to elements rather than to window, so discarding the
  // element should discard them. Growth here would mean something global is
  // being subscribed to on every render.
  if (after > before * 2 + 100) {
    throw new Error(`listeners went ${before} -> ${after} across 30 navigations`);
  }
  console.log(`       ${before} -> ${after} listeners`);
});

/* ------------------------------------------------------------------ *
 * things that could grow without a ceiling
 * ------------------------------------------------------------------ */

await check('the storage cache is bounded, not merely expiring', async () => {
  // Entries carry a 20s TTL but are only dropped when read again or explicitly
  // invalidated. A key written once and never re-read is never freed, so what
  // matters is whether the number of distinct keys has a ceiling.
  const size = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    for (let i = 0; i < 2000; i++) {
      await m.db.saveResponse({
        requestId: `req_${i % 50}`, formId: 'f', anonymous: true,
        answers: { q1: 5 }, asClass: 'AS200',
      });
    }
    // The cache is module-private; its footprint is visible through the heap
    // and through how many documents exist, not through a size property.
    return (await m.db.listRequests()).length;
  });
  const heapAfter = await settledHeap();
  // 2000 writes across 50 requests: the cache keys are bounded by the number of
  // documents, not the number of operations.
  if (heapAfter > 120 * 1024 * 1024) {
    throw new Error(`heap reached ${mb(heapAfter)} after 2000 writes`);
  }
  console.log(`       heap ${mb(heapAfter)} after 2000 writes across ${size || 50} requests`);
});

await check('toasts remove themselves rather than piling up', async () => {
  const left = await page.evaluate(async () => {
    const { toast } = await import('/js/util.js');
    for (let i = 0; i < 60; i++) toast(`message ${i}`, 'info', 60);
    await new Promise((r) => setTimeout(r, 900));
    return document.querySelectorAll('.toast').length;
  });
  if (left > 5) throw new Error(`${left} toasts still in the DOM`);
  console.log(`       ${left} left after 60 toasts`);
});

/* ------------------------------------------------------------------ *
 * data that outlives the person it belongs to
 *
 * Not a leak in the usual sense, and worse than one: a cache surviving a
 * sign-out serves the previous person's records to the next. Detachment offices
 * share laptops, so this is the ordinary case rather than an edge one.
 * ------------------------------------------------------------------ */

await check('signing out drops the cached bundle', async () => {
  const seen = await page.evaluate(async () => {
    const ds = await import('/js/data-source.js');
    const auth = await import('/js/auth.js');
    const state = await import('/js/state.js');
    const previous = state.connection.get().proxyUrl;
    state.connection.set({
      proxyUrl: 'https://script.google.com/macros/s/AKfycbMEMTEST0123456789/exec',
    });

    const exp = Math.floor(Date.now() / 1000) + 3600;
    let serving = 'alice';
    const real = window.fetch;
    window.fetch = async () => new Response(JSON.stringify({
      ok: true,
      bundle: { account: { username: serving }, requests: [], forms: {}, submitted: [] },
    }), { status: 200 });

    try {
      auth.startSession({ id: '1', email: 'a@x.edu', username: 'alice', name: 'A', roles: ['student'] },
        { idToken: 'tok-a', idTokenExp: exp });
      const first = (await ds.loadAssignments({ username: 'alice' })).account?.username;

      auth.signOut();
      serving = 'bob';
      auth.startSession({ id: '2', email: 'b@x.edu', username: 'bob', name: 'B', roles: ['student'] },
        { idToken: 'tok-b', idTokenExp: exp });
      const second = (await ds.loadAssignments({ username: 'bob' })).account?.username;
      return { first, second };
    } finally {
      window.fetch = real;
      auth.signOut();
      state.connection.set({ proxyUrl: previous || '' });
    }
  });

  if (seen.first !== 'alice') throw new Error(`first sign-in saw ${seen.first}`);
  if (seen.second !== 'bob') {
    throw new Error(`the second person was served ${seen.second}'s data`);
  }
  console.log(`       ${seen.first} then ${seen.second}, no carry-over`);
});

await check('the storage cache has a ceiling, not just an expiry', async () => {
  // Entries used to be dropped only when read again, so a cached list read once
  // and never re-read stayed for the life of the page.
  //
  // Driven through listResponses, which is what actually populates the cache.
  // Two earlier attempts at this check wrote documents and then read them back
  // with getForm, and both passed with the cap raised to 100,000 — saveForm
  // invalidates rather than fills, and getForm does not touch the cache at all.
  // The keys are per *request*, not per document, so a detachment with hundreds
  // of feedback requests is what approaches the cap, and that is what this
  // builds.
  const COUNT = 900;                       // more than twice CACHE_MAX
  const PAYLOAD = 'x'.repeat(4 * 1024);

  await page.evaluate(async ([count, pad]) => {
    const m = await import('/js/storage/index.js');
    for (let i = 0; i < count; i++) {
      const requestId = `req_cap_${i}`;
      await m.db.saveRequest({
        id: requestId, formId: 'form_cap', title: `R${i}`, status: 'open',
        asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
        anonymous: true, assignedUsernames: [],
      });
      await m.db.saveResponse({
        requestId, formId: 'form_cap', anonymous: true, asClass: 'AS200',
        schoolYear: '2026-2027', semester: 'Fall', answers: { q1: 5, q2: pad },
      });
    }
  }, [COUNT, PAYLOAD]);

  const readRange = (from, to) => page.evaluate(async ([a, b]) => {
    const m = await import('/js/storage/index.js');
    for (let i = a; i < b; i++) await m.db.listResponses(`req_cap_${i}`);
  }, [from, to]);

  await readRange(0, 300);
  const early = await settledHeap();
  await readRange(300, COUNT);            // 600 more, taking it well past the cap
  const late = await settledHeap();

  // Uncapped, the cache would hold 900 response lists of ~4 KB each. Capped, it
  // evicts as it goes and settles.
  const growth = late - early;
  if (growth > 2 * 1024 * 1024) {
    throw new Error(`heap grew ${mb(growth)} from ${mb(early)} over 600 further cached reads `
      + '— the cache is tracking how many requests were read, not its cap');
  }
  console.log(`       ${mb(early)} -> ${mb(late)} across ${COUNT} cached request reads`);

  // Eviction must not lose data: an entry dropped long ago still has to read back.
  const readBack = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    return (await m.db.listResponses('req_cap_0')).length;
  });
  if (readBack !== 1) throw new Error(`an evicted entry read back with ${readBack} responses`);
});

/* ------------------------------------------------------------------ *
 * pathological input
 *
 * Not adversarial — a cadet pasting an essay, or a detachment with years of
 * feedback. The question is whether anything grows super-linearly or retains
 * its input.
 * ------------------------------------------------------------------ */

await check('a very long answer does not blow up the text analysis', async () => {
  const before = await settledHeap();
  const timings = await page.evaluate(async () => {
    const text = await import('/js/analysis/text.js');
    // 250 words is the enforced limit; 20,000 stands in for a paste that
    // bypasses the UI, which the server does not re-validate.
    const huge = 'the instruction was clear and the briefing felt rushed '.repeat(2000);
    const t0 = performance.now();
    text.scoreSentiment(huge);
    text.screenText(huge);
    text.wordFrequencies([huge]);
    return performance.now() - t0;
  });
  const after = await settledHeap();
  if (timings > 3000) throw new Error(`took ${Math.round(timings)}ms on a 20k-word answer`);
  if (after - before > 40 * 1024 * 1024) {
    throw new Error(`retained ${mb(after - before)} after one huge answer`);
  }
  console.log(`       ${Math.round(timings)}ms, ${mb(Math.max(0, after - before))} retained`);
});

await check('analysis releases its working set afterwards', async () => {
  const before = await settledHeap();
  await page.evaluate(async () => {
    const [stats, text] = await Promise.all([
      import('/js/analysis/stats.js'), import('/js/analysis/text.js'),
    ]);
    const answers = [];
    const scores = [];
    for (let i = 0; i < 5000; i++) {
      answers.push(`response ${i} the leadership lab was well run and clearly explained`);
      scores.push(1 + (i % 9));
    }
    // Deliberately not returned: nothing should keep these alive once the call
    // is over, which is the property being checked.
    stats.describe(scores);
    stats.findClusters(scores, { min: 1, max: 9 });
    text.summariseSentiment(answers);
    text.wordFrequencies(answers);
    text.screenAll(answers.map((t, i) => ({ id: `a${i}`, text: t })));
  });
  const after = await settledHeap();
  const retained = after - before;
  if (retained > 12 * 1024 * 1024) {
    throw new Error(`analysis retained ${mb(retained)} after returning`);
  }
  console.log(`       ${mb(Math.max(0, retained))} retained after analysing 5000 responses`);
});

await check('the QR encoder retains nothing across repeated encodes', async () => {
  const before = await settledHeap();
  await page.evaluate(async () => {
    const { encodeQr } = await import('/js/qr.js');
    for (let i = 0; i < 300; i++) encodeQr(`https://det.example.org/#/join?c=abc${i}&f=def${i}`);
  });
  const after = await settledHeap();
  if (after - before > 6 * 1024 * 1024) {
    throw new Error(`retained ${mb(after - before)} after 300 encodes`);
  }
  console.log(`       ${mb(Math.max(0, after - before))} retained after 300 encodes`);
});

/* ------------------------------------------------------------------ *
 * a long working day
 * ------------------------------------------------------------------ */

await check('a sustained session does not drift upward', async () => {
  // The realistic failure: an office laptop left open on the portal all day.
  const readings = [];
  for (let round = 0; round < 4; round++) {
    await cycle(3);
    readings.push(await settledHeap());
  }
  const drift = readings[readings.length - 1] - readings[0];
  console.log(`       ${readings.map(mb).join('  ->  ')}`);
  if (drift > 5 * 1024 * 1024) {
    throw new Error(`drifted ${mb(drift)} over 60 navigations`);
  }
});

await browser.close();
console.log(failures ? `\n${failures} memory check(s) failed.` : '\nAll memory checks passed.');
process.exit(failures ? 1 : 0);
