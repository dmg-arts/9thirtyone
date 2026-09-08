/**
 * Builds the demo detachment as an importable backup bundle.
 *
 *     python3 serve.py --port 8123 --no-open &
 *     node tools/demo/build-demo-data.mjs tools/demo/demo-detachment.json
 *
 * WHY A BUNDLE RATHER THAN A SEEDING SCRIPT
 *
 * A live demo should not depend on node, playwright and a local server being
 * healthy in an unfamiliar room. `db.exportBundle()` is the app's own backup
 * format, so this writes one file that imports through *Database
 * Administration → Backup and restore* on any install and any backend. Nothing
 * to run at the venue, and re-importing resets the demo mid-flight.
 *
 * WHY IT DRIVES A BROWSER TO BUILD IT
 *
 * The records could be hand-written as JSON. They should not be: ids, usernames,
 * receipt paths and index entries all have shapes the app decides, and a bundle
 * assembled from the outside is a guess at them that fails later and quietly.
 * This seeds a throwaway *This device only* install through `auth.createAccount`
 * and `db.save*` — the app's own writers — then exports what they produced.
 *
 * WHERE THE WRITTEN ANSWERS COME FROM
 *
 * `tools/tuning/**\/*.jsonl`: 600 labelled synthetic items, already tuned against
 * the lexicon. Using them means sentiment, the word cloud and the safety screen
 * behave in the demo the way they behave in the product. Inventing feedback
 * would demo the writer's imagination instead.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/index.html';
const OUT = process.argv[2] || 'tools/demo/demo-detachment.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

/* ------------------------------------------------------------------ *
 * the corpus
 * ------------------------------------------------------------------ */

function corpus() {
  const dir = path.join(ROOT, 'tools/tuning');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  }(dir));
  const rows = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch { /* skip a bad line, not the file */ }
    }
  }
  if (rows.length < 100) throw new Error(`corpus too small: ${rows.length} items`);
  return rows;
}

const isClean = (r) => !r.safety || r.safety === 'clean'
  || (Array.isArray(r.safety) && r.safety.length === 0);
const hasFlag = (r, cat) => Array.isArray(r.safety) ? r.safety.includes(cat)
  : String(r.safety || '').includes(cat);

/**
 * Two flagged answers, chosen rather than sampled.
 *
 * `hazing` and `integrity` at the lower of the two intensities: on-point for
 * AFROTC, and both sit inside otherwise ordinary feedback — which is the honest
 * demonstration, because that is how a real disclosure arrives. Self-harm,
 * sexual and violence items exist in the corpus and are deliberately left out:
 * a simulated one on a projector in front of a room is not worth the demo.
 */
function flagged(rows) {
  const pick = (cat) => rows
    .filter((r) => hasFlag(r, cat) && String(r.intensity) === '2')
    .sort((a, b) => a.text.length - b.text.length)[0];
  const out = [pick('hazing'), pick('integrity')].filter(Boolean);
  if (out.length !== 2) throw new Error('could not find both flagged samples');
  return out;
}

/** Deterministic shuffle, so a rebuild produces the same demo. */
function seeded(n) {
  let s = n;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/* ------------------------------------------------------------------ *
 * the detachment
 * ------------------------------------------------------------------ */

const SURNAMES = ['Alvarez', 'Brooks', 'Chen', 'Diaz', 'Ellis', 'Ford', 'Grant', 'Hall',
  'Iqbal', 'Jensen', 'Kowalski', 'Lopez', 'Moreau', 'Nakamura', 'Osei', 'Petrov',
  'Quinn', 'Rossi', 'Silva', 'Tanaka', 'Ubaldi', 'Vargas', 'Whitfield', 'Xu',
  'Yates', 'Zhao', 'Abbott', 'Byrne', 'Costa', 'Duarte', 'Erikson', 'Faulkner',
  'Gallagher', 'Haddad', 'Ito', 'Joubert', 'Keller', 'Lindgren', 'Mbeki', 'Novak',
  'Okonkwo', 'Pereira', 'Ramos', 'Sinclair', 'Toledo'];
const FORENAMES = ['Mia', 'Dan', 'Li', 'Sam', 'Jo', 'Kim', 'Ade', 'Rae', 'Nur', 'Tom',
  'Eve', 'Raj', 'Ana', 'Ben', 'Zoe', 'Ivan', 'Mae', 'Omar', 'Pia', 'Sean',
  'Tess', 'Uma', 'Vic', 'Wren', 'Xan', 'Yuki', 'Zara', 'Cole', 'Dara', 'Esme',
  'Finn', 'Gia', 'Hugo', 'Ines', 'Jude', 'Kai', 'Lena', 'Milo', 'Nina', 'Otto',
  'Perry', 'Rosa', 'Suri', 'Theo', 'Vera'];

/** The account that owns the live testbed. Without it a replace-import locks it out. */
const OWNER = {
  id: 'usr_mtt534rs9duus2',
  email: 'david.mark.gaspar@gmail.com',
  username: 'david.gaspar',
  name: 'David Gaspar',
  roles: ['instructor', 'cadre', 'commander', 'admin'],
  asClass: '', section: '', active: true,
};

const STAFF = [
  { email: 'ana.lindqvist@det025.edu', name: 'Lindqvist, Ana', roles: ['instructor'] },
  { email: 'ray.donnelly@det025.edu',  name: 'Donnelly, Ray',  roles: ['instructor'] },
  { email: 'tess.varga@det025.edu',    name: 'Varga, Tess',    roles: ['instructor'] },
  { email: 'noor.haddad@det025.edu',   name: 'Haddad, Noor',   roles: ['instructor'] },
  { email: 'sam.okafor@det025.edu',    name: 'Okafor, Sam',    roles: ['cadre', 'instructor'] },
  { email: 'jean.moreau@det025.edu',   name: 'Moreau, Jean',   roles: ['cadre', 'instructor'] },
  { email: 'maria.reyes@det025.edu',   name: 'Reyes, Maria',   roles: ['commander', 'cadre', 'instructor'] },
  { email: 'dee.novak@det025.edu',     name: 'Novak, Dee',     roles: ['admin'] },
];

const AS_MIX = [['AS100', 14], ['AS200', 13], ['AS300', 11], ['AS400', 7]];

function cadets() {
  const out = [];
  let i = 0;
  for (const [asClass, n] of AS_MIX) {
    for (let k = 0; k < n; k++, i++) {
      const sur = SURNAMES[i % SURNAMES.length];
      const fore = FORENAMES[(i * 7) % FORENAMES.length];
      out.push({
        email: `${fore}.${sur}${i}`.toLowerCase() + '@gmail.com',
        name: `${sur}, ${fore}`,
        roles: ['student'],
        asClass,
        section: ['Alpha', 'Bravo', 'Charlie'][i % 3],
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * build
 * ------------------------------------------------------------------ */

const rows = corpus();
const clean = rows.filter(isClean);
const flags = flagged(rows);

console.log(`corpus: ${rows.length} items (${clean.length} clean), 2 flagged chosen`);
console.log(`  hazing    — ${flags[0].text.slice(0, 72)}…`);
console.log(`  integrity — ${flags[1].text.slice(0, 72)}…`);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  // A throwaway *This device only* install: no Google, no network, and the
  // bundle it exports is backend-agnostic.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.wizard');
  await page.fill('.wizard input[type=text]', 'AFROTC Detachment 025');
  await page.click('.wizard .btn--primary');
  await page.waitForSelector('.choice-list');
  await page.click('input[value="local"]', { force: true });
  await page.click('.wizard .btn--primary');
  await page.waitForSelector('.notice--warn');
  await page.click('.wizard .btn--primary');
  await page.waitForSelector('.tree');
  await page.click('.wizard .btn--lg');
  await page.waitForSelector('.role-grid', { timeout: 15000 });

  const bundle = await page.evaluate(async (input) => {
    const a = await import('/js/auth.js');
    const m = await import('/js/storage/index.js');
    const c = await import('/js/config.js');
    const anchors = { ...c.SCALE_ANCHORS };

    // The first account through the door claims the roster and is handed
    // [admin, instructor] whatever it asks for, so the owner goes first and its
    // roles are corrected at the end.
    const founder = await a.signInWithGoogle(
      { email: input.owner.email, name: input.owner.name, emailVerified: true }, null, 'tok');

    for (const s of input.staff) await a.createAccount(s);
    for (const s of input.cadets) await a.createAccount(s);

    const byEmail = {};
    for (const s of [...input.staff, ...input.cadets]) {
      byEmail[s.email] = (await a.findByEmail(s.email)).username;
    }

    const items = (extra = []) => ([
      { id: 'q1', type: 'scale', label: 'Instruction was clear and well paced', required: true, min: 1, max: 9, anchors },
      { id: 'q2', type: 'scale', label: 'The event was well organised', required: true, min: 1, max: 9, anchors },
      { id: 'q3', type: 'scale', label: 'I can apply what I learned', required: true, min: 1, max: 9, anchors },
      ...extra,
      { id: 'q4', type: 'text', label: 'What should change next time?', required: false, rows: 4, wordLimit: 250 },
    ]);

    const made = [];
    for (const r of input.requests) {
      const form = await m.db.saveForm({
        id: `form_${r.id}`, name: r.title, space: r.space,
        sections: [{ title: r.title, items: items() }],
      });
      await m.db.saveRequest({
        id: r.id, feedbackId: r.feedbackId, title: r.title, eventName: r.title,
        formId: form.id, space: r.space, subject: byEmail[r.subjectEmail] || '',
        asClass: r.asClass, schoolYear: r.schoolYear, semester: r.semester,
        anonymous: true, status: r.status, assignedUsernames: [],
        instructions: 'Answer honestly — your name is never stored with your answers.',
      });
      made.push(r.id);
    }

    for (const resp of input.responses) {
      await m.db.saveResponse({
        requestId: resp.requestId, formId: `form_${resp.requestId}`, anonymous: true,
        space: resp.space, asClass: resp.asClass,
        schoolYear: resp.schoolYear, semester: resp.semester,
        answers: { q1: resp.v1, q2: resp.v2, q3: resp.v3, q4: resp.text },
      });
    }

    for (const [requestId, emails] of Object.entries(input.receipts)) {
      for (const email of emails) await m.db.addReceipt(requestId, byEmail[email]);
    }

    // Owner stops being merely the bootstrap admin and takes its real roles.
    await a.updateAccount(founder.id, { roles: input.owner.roles });
    a.signOut();

    return m.db.exportBundle();
  }, buildInput());

  if (errors.length) throw new Error(`page errors during seed:\n  ${errors.join('\n  ')}`);

  const owner = (bundle.users?.users || []).find((u) => u.email === OWNER.email);
  if (!owner) throw new Error('the owner account is missing from the bundle');
  owner.id = OWNER.id;

  fs.mkdirSync(path.dirname(path.resolve(ROOT, OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, OUT), JSON.stringify(bundle, null, 2));

  const kb = (fs.statSync(path.resolve(ROOT, OUT)).size / 1024).toFixed(0);
  console.log(`\nwrote ${OUT} — ${kb} KB`);
  console.log(`  users     ${bundle.users?.users?.length ?? 0}`);
  console.log(`  forms     ${bundle.forms?.length ?? 0}`);
  console.log(`  requests  ${bundle.requests?.length ?? 0}`);
  console.log(`  responses ${bundle.responses?.length ?? 0}`);
  console.log(`  receipts  ${Object.values(bundle.receipts || {}).reduce((n, r) => n + r.length, 0)}`);
} finally {
  await browser.close();
}

/* ------------------------------------------------------------------ *
 * the shape of the demo
 * ------------------------------------------------------------------ */

function buildInput() {
  const rand = seeded(931);
  const people = cadets();
  const as200 = people.filter((p) => p.asClass === 'AS200');
  const as300 = people.filter((p) => p.asClass === 'AS300');

  const requests = [
    { id: 'req_llab3',   feedbackId: 'FB-2026-0007', title: 'AS200 Leadership Lab — Drill Block 3',
      space: 'shared', subjectEmail: 'ana.lindqvist@det025.edu', asClass: 'AS200',
      schoolYear: '2026-2027', semester: 'Fall', status: 'open' },
    { id: 'req_ftx',     feedbackId: 'FB-2026-0011', title: 'Field Training Exercise — September',
      space: 'shared', subjectEmail: 'ray.donnelly@det025.edu', asClass: 'AS300',
      schoolYear: '2026-2027', semester: 'Fall', status: 'open' },
    { id: 'req_as100',   feedbackId: 'FB-2026-0004', title: 'AS100 Foundations — Weeks 1–4',
      space: 'shared', subjectEmail: 'tess.varga@det025.edu', asClass: 'AS100',
      schoolYear: '2026-2027', semester: 'Fall', status: 'open' },
    { id: 'req_spring',  feedbackId: 'FB-2026-0002', title: 'AS200 Leadership Lab — Spring review',
      space: 'shared', subjectEmail: 'noor.haddad@det025.edu', asClass: 'AS200',
      schoolYear: '2025-2026', semester: 'Spring', status: 'closed' },
    { id: 'req_cadre',   feedbackId: 'FB-2026-0014', title: 'Cadre climate check — Fall term',
      space: 'cadre', subjectEmail: 'sam.okafor@det025.edu', asClass: 'AS300',
      schoolYear: '2026-2027', semester: 'Fall', status: 'open' },
    { id: 'req_cmdr',    feedbackId: 'FB-2026-0015', title: "Commander's assessment — AS400 leadership",
      space: 'commander', subjectEmail: 'maria.reyes@det025.edu', asClass: 'AS400',
      schoolYear: '2026-2027', semester: 'Fall', status: 'open' },
  ];

  const pool = clean.slice();
  const takeText = (asClass) => {
    const i = pool.findIndex((r) => r.asClass === asClass);
    const j = i >= 0 ? i : Math.floor(rand() * pool.length);
    return pool.splice(j, 1)[0].text;
  };

  const responses = [];
  const add = (req, v1, v2, v3, text) => responses.push({
    requestId: req.id, space: req.space, asClass: req.asClass,
    schoolYear: req.schoolYear, semester: req.semester, v1, v2, v3, text,
  });

  const [llab, ftx, as100, spring, cadre, cmdr] = requests;

  // Drill Block 3 — deliberately POLARISED on q1 so split detection fires, and
  // carrying the hazing flag. A mean near the middle that describes nobody is
  // the whole argument for the analysis, so the demo needs one.
  for (const v of [9, 9, 8, 9, 8, 9, 8, 9]) add(llab, v, 7 + (v % 2), 8, takeText('AS200'));
  for (const v of [2, 3, 2, 3, 2, 3]) add(llab, v, 4, 3, takeText('AS200'));
  add(llab, 3, 4, 3, flags[0].text);

  // FTX — one lone OUTLIER against an otherwise agreeing group. Needs ≥6.
  for (const v of [7, 8, 7, 8, 7, 8, 7, 8, 7, 8, 7, 8]) add(ftx, v, 7, 8, takeText('AS300'));
  add(ftx, 1, 2, 2, takeText('AS300'));

  // AS100 — unremarkable and positive, so not every screen is a problem.
  for (const v of [8, 7, 9, 8, 7, 8, 9, 7, 8, 8, 9, 7, 8]) add(as100, v, 8, 8, takeText('AS100'));

  // Last spring, closed — gives the filters and the archive something real.
  for (const v of [6, 7, 5, 6, 7, 6, 5, 7, 6, 6]) add(spring, v, 6, 6, takeText('AS200'));

  // Cadre space — carries the integrity flag, so the flag a cadre member sees
  // is one an instructor genuinely cannot reach.
  for (const v of [7, 8, 6, 7, 8]) add(cadre, v, 7, 7, takeText('AS300'));
  add(cadre, 4, 5, 4, flags[1].text);

  // Commander space.
  for (const v of [8, 7, 9, 8, 7, 8]) add(cmdr, v, 8, 8, takeText('AS400'));

  // Receipts on a subset, so "still owes feedback" is a real number rather
  // than none or all.
  const receipts = {
    req_llab3: as200.slice(0, 10).map((p) => p.email),
    req_ftx: as300.slice(0, 8).map((p) => p.email),
  };

  return { owner: OWNER, staff: STAFF, cadets: people, requests, responses, receipts };
}
