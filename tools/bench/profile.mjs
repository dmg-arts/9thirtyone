/**
 * Performance and memory profile.
 *
 *     python3 serve.py --port 8123 --no-open &
 *     node tools/bench/profile.mjs
 *
 * Answers two questions the project actually has, rather than producing a
 * benchmark for its own sake:
 *
 *   1. **Does this work on a cadet's cheap phone?** Every cadet reaches this on
 *      whatever handset they own, over campus wifi or cellular. So payload and
 *      cold start are measured, and the heavy screens are measured again under
 *      CPU throttling that stands in for a low-end Android.
 *   2. **Does it stay usable as feedback accumulates?** A detachment runs for
 *      years. Analysis reads every response across every form, so its cost is
 *      measured at increasing volumes to see where the curve bends.
 *
 * Numbers are from one machine and are only meaningful relative to each other
 * and to the thresholds below. What matters is the shape, not the absolutes.
 */

import { chromium } from 'playwright';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/index.html';
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));

/**
 * What counts as a problem.
 *
 * 100ms is roughly the limit for an interaction to feel instant; 1s is where a
 * person notices they are waiting. Cold start on cellular is judged more
 * loosely because it happens once.
 */
const BUDGET = {
  coldStartMs: 3000,
  interactionMs: 1000,
  heapMb: 100,
};

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const ms = (n) => `${Math.round(n)}ms`;

const rows = [];
const record = (area, metric, value, budget = null) => {
  const over = budget !== null && value > budget;
  rows.push({ area, metric, value, budget, over });
  return over;
};

/* ------------------------------------------------------------------ *
 * payload
 * ------------------------------------------------------------------ */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else out.push({ path, size: stat.size });
  }
  return out;
}

function payload() {
  const files = [...walk('js'), { path: 'css/styles.css', size: statSync('css/styles.css').size },
    { path: 'index.html', size: statSync('index.html').size }];
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const biggest = files.sort((a, b) => b.size - a.size).slice(0, 5);
  return { total, count: files.length, biggest };
}

/* ------------------------------------------------------------------ *
 * the browser side
 * ------------------------------------------------------------------ */

const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  args: ['--enable-precise-memory-info'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');

const heap = async () => {
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return usedSize;
};

const cpuMetrics = async () => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    scriptSeconds: get('ScriptDuration'),
    layoutSeconds: get('LayoutDuration'),
    recalcSeconds: get('RecalcStyleDuration'),
    nodes: get('Nodes'),
    listeners: get('JSEventListeners'),
  };
};

/* ---------- cold start ---------- */

let transferred = 0;
page.on('response', async (response) => {
  if (new URL(response.url()).origin !== new URL(BASE).origin) return;
  try {
    const body = await response.body();
    transferred += body.length;
  } catch { /* redirects and cached entries have no body */ }
});

const startedAt = Date.now();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.wizard, .role-grid', { timeout: 15000 });
const coldMs = Date.now() - startedAt;

const timing = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
    loadEvent: nav.loadEventEnd - nav.startTime,
    scripts: performance.getEntriesByType('resource')
      .filter((r) => r.name.endsWith('.js')).length,
  };
});

record('Cold start', 'Time to first screen', coldMs, BUDGET.coldStartMs);
record('Cold start', 'DOMContentLoaded', timing.domContentLoaded);
record('Cold start', 'Heap after load', await heap());
record('Cold start', 'Modules fetched', timing.scripts);
record('Cold start', 'Bytes over the wire', transferred);

/* ---------- get past setup so the real screens can be measured ---------- */

await page.evaluate(() => {
  localStorage.setItem('nine31.connection.v1', JSON.stringify({
    backend: 'local', orgName: 'Det 025', clientId: '', folderId: 'bench',
    proxyUrl: '', folderName: 'bench', connectedAt: new Date().toISOString(),
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

/* ---------- pure compute, isolated from storage ---------- */

/**
 * The analysis pipeline on synthetic answers.
 *
 * Storage is excluded on purpose: this is the part that runs on the phone in
 * the reader's hand, and it is the part that grows with the detachment.
 */
const computeAt = async (n) => page.evaluate(async (count) => {
  const [stats, text] = await Promise.all([
    import('/js/analysis/stats.js'),
    import('/js/analysis/text.js'),
  ]);

  const WORDS = ('the instruction was clear and well paced the briefing felt rushed '
    + 'leadership lab was disorganised but the drill practice helped a lot i learned '
    + 'more about followership than expected the cadre were supportive throughout')
    .split(' ');
  const answers = [];
  const scores = [];
  for (let i = 0; i < count; i++) {
    const length = 25 + (i % 60);
    const words = [];
    for (let w = 0; w < length; w++) words.push(WORDS[(i * 7 + w) % WORDS.length]);
    answers.push({ id: `a${i}`, text: words.join(' ') });
    scores.push(1 + (i % 9));
  }

  const time = (fn) => {
    const t0 = performance.now();
    const out = fn();
    return { ms: performance.now() - t0, out };
  };

  // The real entry points the analysis screen calls, with the shapes they
  // actually take: strings for the text passes, raw numbers for the maths.
  const points = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const strings = answers.map((a) => a.text);

  const describe = time(() => {
    stats.describe(scores);
    stats.histogram(scores, points);
    stats.consensus(scores, 1, 9);
    stats.findClusters(scores, { min: 1, max: 9 });
    stats.findOutliers(scores);
  });
  const sentiment = time(() => text.summariseSentiment(strings));
  const safety = time(() => text.screenAll(answers));
  const words = time(() => text.wordFrequencies(strings));

  return {
    describe: describe.ms,
    sentiment: sentiment.ms,
    safety: safety.ms,
    cloud: words.ms,
    total: describe.ms + sentiment.ms + safety.ms + words.ms,
  };
}, n);

// 45 is one drill night at Det 752: a form issued to the whole cadet wing, all
// of it answered the same evening. It is the smallest number here and the only
// one drawn from a real detachment rather than chosen to find the curve —
// everything above it is headroom, and 10000 is well past a detachment's
// lifetime, included to find where the curve bends rather than to describe a
// realistic load.
for (const n of [45, 100, 500, 2000, 10000]) {
  const before = await heap();
  const result = await computeAt(n);
  const after = await heap();
  record(`Analysis maths (${n} responses)`, 'Statistics', result.describe);
  record(`Analysis maths (${n} responses)`, 'Sentiment', result.sentiment);
  record(`Analysis maths (${n} responses)`, 'Safety screen', result.safety);
  record(`Analysis maths (${n} responses)`, 'Word cloud', result.cloud);
  record(`Analysis maths (${n} responses)`, 'All four together', result.total,
    BUDGET.interactionMs);
  record(`Analysis maths (${n} responses)`, 'Heap growth', Math.max(0, after - before));
}

/* ---------- the QR encoder ---------- */

const qr = await page.evaluate(async () => {
  const { encodeQr } = await import('/js/qr.js');
  const link = 'https://det.example.org/app/#/join?c=724504040762-abcdefghijklmnop'
    + '&f=1Te9Pc7JgOSUluq3tc0FCK4IqbKm1MTIM&p=AKfycbwEXAMPLEdeployment&n=Det+025';
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) encodeQr(link);
  return (performance.now() - t0) / 20;
});
record('QR encoder', 'One join-link code', qr, 100);

/* ---------- under a slow phone ---------- */

/**
 * 4x throttling approximates a mid-range Android; 6x a cheap one. The heavy
 * screen is the one cadre stare at, but a cadet's phone renders the form, so
 * both are worth knowing.
 */
for (const rate of [4, 6]) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  const result = await computeAt(500);
  record(`Throttled ${rate}x (500 responses)`, 'All four together', result.total,
    BUDGET.interactionMs);
  // And the same phone on the evening it actually happens. A cadet reads the
  // form on this hardware; a cadre member opens Analysis on it in the car park
  // afterwards with one night's answers in hand.
  const night = await computeAt(45);
  record(`Throttled ${rate}x (45 responses)`, 'All four together', night.total,
    BUDGET.interactionMs);
}
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

/* ---------- steady state ---------- */

const cpu = await cpuMetrics();
record('Steady state', 'Total script time', cpu.scriptSeconds * 1000);
record('Steady state', 'Layout + style time', (cpu.layoutSeconds + cpu.recalcSeconds) * 1000);
record('Steady state', 'DOM nodes', cpu.nodes);
record('Steady state', 'Event listeners', cpu.listeners);
record('Steady state', 'Heap at rest', await heap(), BUDGET.heapMb * 1024 * 1024);

await browser.close();

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

const bundle = payload();

console.log('\n9ThirtyOne — performance profile');
console.log('='.repeat(64));
console.log(`\nSource: ${bundle.count} files, ${(bundle.total / 1024).toFixed(0)} KB unminified`);
for (const f of bundle.biggest) {
  console.log(`  ${(f.size / 1024).toFixed(0).padStart(4)} KB  ${f.path}`);
}

let area = null;
let over = 0;
console.log('');
for (const row of rows) {
  if (row.area !== area) { area = row.area; console.log(`\n${area}`); }
  let shown;
  if (/Heap|Bytes/.test(row.metric)) shown = `${mb(row.value)} MB`;
  else if (/time|Statistics|Sentiment|Safety|cloud|together|code|DOMContentLoaded|screen/i.test(row.metric)
           && !/nodes|listeners|Modules/i.test(row.metric)) shown = ms(row.value);
  else shown = String(Math.round(row.value));
  const flag = row.over ? '  OVER BUDGET' : '';
  if (row.over) over++;
  console.log(`  ${row.metric.padEnd(26)} ${shown.padStart(12)}${flag}`);
}

console.log(`\n${'='.repeat(64)}`);
console.log(over ? `${over} measurement(s) over budget.` : 'Everything inside budget.');

// Scaling is the useful part: absolutes vary by machine, the shape does not.
const totals = rows.filter((r) => r.metric === 'All four together' && /^Analysis/.test(r.area));
if (totals.length > 1) {
  console.log('\nHow analysis scales with volume');
  let previous = null;
  for (const row of totals) {
    const n = Number(row.area.match(/\((\d+)/)[1]);
    const perThousand = (row.value / n) * 1000;
    const note = previous
      ? `  (${(row.value / previous.value).toFixed(1)}x the work for ${(n / previous.n).toFixed(0)}x the data)`
      : '';
    console.log(`  ${String(n).padStart(6)} responses  ${ms(row.value).padStart(8)}`
      + `  =  ${ms(perThousand)}/thousand${note}`);
    previous = { value: row.value, n };
  }
}
process.exit(0);
