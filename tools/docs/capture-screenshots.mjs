import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://127.0.0.1:8123/index.html';
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const ctx = await browser.newContext({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

/**
 * Re-encode the QR and the link beside it against the real published address.
 *
 * The capture has to run against a local server, because that is where the
 * seeded detachment is — so the join link the app builds points at
 * 127.0.0.1. Harmless on screen, not harmless in a printed guide or on a
 * projector, where somebody scans it. Found on 16 Oct, confirmed by reading the
 * encoded value rather than looking at the picture.
 *
 * Only the encoded text changes: the screen, the layout and the styling are the
 * real ones, rendered by the real view.
 */
async function realiseJoinLink(page, base = 'https://9thirtyone.app/') {
  const shown = await page.evaluate(async (realBase) => {
    const { buildJoinLink } = await import('/js/join.js');
    const { renderQrSvg } = await import('/js/qr.js');
    const conn = JSON.parse(localStorage.getItem('nine31.connection.v1') || '{}');
    const link = buildJoinLink({
      clientId: conn.clientId, folderId: conn.folderId,
      orgName: conn.orgName, proxyUrl: conn.proxyUrl, base: realBase,
    });
    // Both of them. The first attempt replaced only input values and missed the
    // caption, which is a <code class="qr-screen__link"> — so the QR encoded the
    // real address while the text under it still read 127.0.0.1. A code and a
    // caption that disagree is worse than either being wrong alone.
    for (const input of document.querySelectorAll('input')) {
      if (typeof input.value === 'string' && input.value.includes('#/join')) input.value = link;
    }
    for (const node of document.querySelectorAll('.qr-screen__link, code, .mono')) {
      if ((node.textContent || '').includes('#/join')) node.textContent = link;
    }
    const host = document.querySelector('.qr-screen__code');
    if (host) { host.textContent = ''; host.append(renderQrSvg(link)); }
    return link;
  }, base);
  if (!shown || !shown.startsWith(base)) {
    throw new Error(`join link was not re-encoded against ${base}: got ${shown}`);
  }
  // Assert against the *rendered page*, not against what buildJoinLink returned.
  // The first version checked the latter, passed, and shipped a screenshot whose
  // visible caption still said 127.0.0.1 — it was verifying its own input.
  const onScreen = await page.textContent('#view');
  if (/127\.0\.0\.1|localhost/.test(onScreen)) {
    throw new Error('the captured screen still shows the capture server');
  }
  return shown;
}

page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

const shot = async (name, opts = {}) => {
  await page.waitForTimeout(600);
  // Drop any lingering toasts so they never land in a published screenshot.
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  console.log('  captured', name);
};

/**
 * Signs in the way Google's callback does, with an already-decoded profile.
 * Google will not issue a token to an automated browser, and these captures run
 * against the local backend where there is no Client ID at all.
 */
const signInAs = (email, role = null) => page.evaluate(async ([e, r]) => {
  const a = await import('/js/auth.js');
  a.signOut();
  await a.signInWithGoogle({ email: e, emailVerified: true }, r);
}, [email, role]);

/* ---------- setup wizard ---------- */
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.wizard');
await shot('setup-1-org');

await page.fill('.wizard input[type=text]', 'AFROTC Detachment 025');
await page.click('.wizard .btn--primary');
await page.waitForSelector('.choice-list');
await shot('setup-2-storage');

await page.click('input[value="local"]', { force: true });
await page.click('.wizard .btn--primary');
await page.waitForSelector('.notice--warn');
await page.click('.wizard .btn--primary');
await page.waitForSelector('.tree');
await shot('setup-3-folders');

await page.click('.wizard .btn--lg');
await page.waitForSelector('.role-grid', { timeout: 12000 });

/* ---------- seed a realistic detachment ---------- */
await page.evaluate(async () => {
  const a = await import('/js/auth.js');
  const m = await import('/js/storage/index.js');
  const c = await import('/js/config.js');

  // The founder signs in first and claims the empty roster, exactly as a real
  // detachment starts. Doing it in this order also means the activity log shows
  // who added each cadet, rather than a page of "unknown".
  await a.signInWithGoogle({ email: 'maria.reyes@det025.edu', name: 'Reyes, Maria', emailVerified: true });

  const cadets = [
    ['mia.alvarez@gmail.com', 'Alvarez, Mia'], ['dan.brooks@gmail.com', 'Brooks, Dan'],
    ['li.chen@gmail.com', 'Chen, Li'], ['sam.diaz@gmail.com', 'Diaz, Sam'],
    ['jo.ellis@gmail.com', 'Ellis, Jo'], ['kim.ford@gmail.com', 'Ford, Kim'],
    ['ade.grant@gmail.com', 'Grant, Ade'], ['rae.hall@gmail.com', 'Hall, Rae'],
  ];
  for (const [email, n] of cadets) {
    await a.createAccount({ email, name: n, roles: ['student'], asClass: 'AS200' });
  }

  const anchors = { ...c.SCALE_ANCHORS };
  const form = await m.db.saveForm({
    id: 'form_demo', name: 'AS200 Leadership Lab — Drill Block 3',
    sections: [{ title: 'AS200 Leadership Lab — Drill Block 3', items: [
      { id: 'q1', type: 'scale', label: 'Instruction was clear and well paced', required: true, min: 1, max: 9, anchors },
      { id: 'q2', type: 'scale', label: 'The event was well organised', required: true, min: 1, max: 9, anchors },
      { id: 'q3', type: 'scale', label: 'I can apply what I learned', required: true, min: 1, max: 9, anchors },
      { id: 'q4', type: 'text', label: 'What should change next time?', required: false, rows: 4, wordLimit: 250 },
    ] }],
  });
  await m.db.saveRequest({
    id: 'req_demo', feedbackId: 'FB-2026-0001', title: 'AS200 Leadership Lab — Drill Block 3',
    eventName: 'AS200 Leadership Lab — Drill Block 3', formId: form.id,
    asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
    anonymous: true, status: 'open', assignedUsernames: [],
    instructions: 'Answer honestly — your name is never stored with your answers.',
  });

  const rows = [
    [9, 8, 9, 'Absolutely excellent instruction. Very clear and the drill practice was engaging.'],
    [8, 7, 8, 'Great pace overall. The labs were thorough and well organised.'],
    [9, 9, 8, 'Outstanding block. Learned a lot about leadership under pressure.'],
    [3, 2, 3, 'Disorganised and confusing. Honestly a waste of time.'],
    [2, 3, 2, 'The briefings were unclear and frustrating. Nobody knew the plan.'],
    [8, 8, 7, 'Really enjoyed the drill sequence. More reps would help.'],
    [7, 7, 8, 'Solid instruction, though the room was cold and we started late.'],
  ];
  for (const [v1, v2, v3, text] of rows) {
    await m.db.saveResponse({
      requestId: 'req_demo', formId: form.id, anonymous: true,
      asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      answers: { q1: v1, q2: v2, q3: v3, q4: text },
    });
  }
  for (const [email] of cadets.slice(0, 7)) {
    await m.db.addReceipt('req_demo', (await a.findByEmail(email)).username);
  }
});

/* ---------- home ---------- */
await page.goto(`${BASE}#/home`, { waitUntil: 'networkidle' });
await page.waitForSelector('.role-grid');
await shot('home');

/* ---------- student ---------- */
await page.evaluate(() => sessionStorage.clear());
await page.goto(`${BASE}#/student`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
// A real installation has a Client ID, so Google's own button is what a cadet
// sees. These captures run on the local backend, which has none — so one is set
// just for this screenshot and removed straight after. It is not a working
// client; only the rendered button is wanted.
await page.evaluate(() => import('/js/state.js').then(({ connection }) =>
  connection.set({ clientId: '000000000000-nine31demo.apps.googleusercontent.com' })));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.page-title:has-text("Cadet sign-in")');
await page.waitForTimeout(2500);
await shot('student-signin');
await page.evaluate(() => import('/js/state.js').then(({ connection }) =>
  connection.set({ clientId: '' })));

await signInAs('rae.hall@gmail.com', 'student');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.list__item', { timeout: 12000 });
await shot('student-list');

await page.click('.list__item');
await page.waitForSelector('.scale--words', { timeout: 12000 });
await shot('student-form', { fullPage: true });

// Mobile view of the same form.
await page.setViewportSize({ width: 420, height: 900 });
await page.waitForTimeout(700);
await shot('student-mobile', { fullPage: true });
await page.setViewportSize({ width: 1240, height: 900 });

/* ---------- instructor ---------- */
await signInAs('maria.reyes@det025.edu', 'instructor');
await page.goto(`${BASE}#/instructor`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[role=tablist]', { timeout: 12000 });
await shot('instructor-panel');

/* ---------- cadre panel ---------- */
// The same screen pointed at the restricted folders. Captured as a commander so
// the commander's own space appears alongside the cadre one, badged — which is
// the whole point of the picture.
await page.evaluate(async () => {
  const m = await import('/js/storage/index.js');
  const c = await import('/js/config.js');
  const anchors = { ...c.SCALE_ANCHORS };
  const form = await m.db.saveForm({
    id: 'form_cadre', name: 'Cadre climate check', space: 'cadre',
    sections: [{ title: 'Cadre climate check', items: [
      { id: 'c1', type: 'scale', label: 'Workload is distributed fairly across cadre', required: true, min: 1, max: 9, anchors },
    ] }],
  });
  for (const [id, title, space, fid] of [
    ['req_cadre', 'Cadre climate check — Fall term', 'cadre', 'FB-2026-0014'],
    ['req_cmdr', 'Commander\u2019s assessment — AS400 leadership', 'commander', 'FB-2026-0015'],
  ]) {
    await m.db.saveRequest({
      id, feedbackId: fid, title, eventName: title, formId: form.id, space,
      asClass: 'AS300', schoolYear: '2026-2027', semester: 'Fall',
      anonymous: true, status: 'open', assignedUsernames: [],
    });
  }
  const s = JSON.parse(sessionStorage.getItem('nine31.session.v1'));
  s.roles = ['commander', 'instructor'];
  sessionStorage.setItem('nine31.session.v1', JSON.stringify(s));
});
await page.goto(`${BASE}#/cadre`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[role=tablist]', { timeout: 12000 });
await shot('cadre-panel');

// Back to an ordinary instructor for everything that follows.
await signInAs('maria.reyes@det025.edu', 'instructor');
await page.goto(`${BASE}#/instructor`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[role=tablist]', { timeout: 12000 });

await page.goto(`${BASE}#/instructor/create/new`, { waitUntil: 'networkidle' });
await page.waitForSelector('.qrow', { timeout: 12000 });
await page.fill('input[placeholder^="e.g. AS200 Leadership"]', 'AS200 Field Training Prep — Week 4');
await page.evaluate(() => {
  const rows = document.querySelectorAll('.qrow input.input');
  const texts = ['The brief prepared me for the exercise', 'Cadre feedback during the exercise was useful',
    'What would you change about the exercise?'];
  rows.forEach((r, i) => { if (texts[i]) { r.value = texts[i]; r.dispatchEvent(new Event('input', { bubbles: true })); } });
});
await shot('form-creator', { fullPage: true });

/* ---------- analysis ---------- */
await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
await page.waitForSelector('.hist', { timeout: 15000 });
await shot('analysis-ratings', { fullPage: true });

// Just the first question card, for a tighter slide image.
const card = await page.$('.card:has(.hist)');
if (card) { await card.screenshot({ path: `${OUT}/analysis-question.png` }); console.log('  captured analysis-question'); }

for (const t of await page.$$('.tabs .tab')) {
  if ((await t.textContent()).trim() === 'Word cloud') { await t.click(); break; }
}
await page.waitForSelector('svg.cloud', { timeout: 12000 });
await shot('analysis-cloud', { fullPage: true });
const cloud = await page.$('.card:has(svg.cloud)');
if (cloud) { await cloud.screenshot({ path: `${OUT}/wordcloud.png` }); console.log('  captured wordcloud'); }

/* ---------- safety screen ---------- */
await page.evaluate(async () => {
  const m = await import('/js/storage/index.js');
  await m.db.saveResponse({
    requestId: 'req_demo', formId: 'form_demo', anonymous: true,
    asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
    answers: { q1: 2, q2: 2, q3: 2,
      q4: 'A senior cadet hazed the new flight members and made us do push ups until we cried.' },
  });
  await m.db.addReceipt('req_demo', 'grant.ade');
});
await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
// Same hash as the current URL is a same-document navigation and will not
// re-render, so force a reload.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.quote--flagged', { timeout: 15000 });
const safety = await page.$('section:has(.quote--flagged)');
if (safety) { await safety.screenshot({ path: `${OUT}/safety.png` }); console.log('  captured safety'); }

/* ---------- the commander's by-instructor view ---------- */

// Seeded with a spread that shows the interesting cases together: somebody with
// plenty of feedback, somebody with a weaker picture, and somebody under the
// disclosure threshold so the withholding is visible rather than described.
await page.evaluate(async () => {
  const m = await import('/js/storage/index.js');
  const a = await import('/js/auth.js');
  for (const [name, email, roles] of [
    ['Okafor, Sam', 'sam.okafor@det025.edu', ['cadre']],
    ['Lindqvist, Ana', 'ana.lindqvist@det025.edu', ['instructor']],
    ['Vance, Robert', 'robert.vance@det025.edu', ['commander']],
  ]) { try { await a.createAccount({ name, email, roles }); } catch { /* already there */ } }

  const seed = async (subject, batches) => {
    for (let i = 0; i < batches.length; i++) {
      const id = `req_${subject.replace('.', '')}_${i}`;
      await m.db.saveRequest({
        id, formId: 'form_demo', title: `Leadership Lab ${i + 1}`,
        eventName: `Leadership Lab ${i + 1}`, status: 'open', asClass: 'AS200',
        schoolYear: '2026-2027', semester: 'Fall', anonymous: true, space: 'shared',
        subject, createdBy: subject, assignedUsernames: [],
      });
      for (const score of batches[i]) {
        await m.db.saveResponse({
          requestId: id, formId: 'form_demo', anonymous: true, asClass: 'AS200',
          schoolYear: '2026-2027', semester: 'Fall',
          answers: { q1: score, q2: 'the drill sequence was clear and well paced' },
        });
      }
    }
  };
  await seed('reyes.maria', [[8, 7, 9, 8, 7, 8], [9, 8, 8, 7]]);
  await seed('okafor.sam', [[4, 3, 5, 6, 4, 5, 4]]);
  await seed('lindqvist.ana', [[9, 8]]);

  const s = JSON.parse(sessionStorage.getItem('nine31.session.v1'));
  s.roles = ['commander'];
  sessionStorage.setItem('nine31.session.v1', JSON.stringify(s));
});
await page.goto(`${BASE}#/instructor?tab=people`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('table.table', { timeout: 15000 });
await shot('people-list');

await page.evaluate(() =>
  [...document.querySelectorAll('tbody tr')].find((r) => /Reyes/.test(r.textContent)).click());
await page.waitForTimeout(700);
await shot('people-detail', { fullPage: true });

/* ---------- the join QR code ---------- */

// Needs a Client ID to build a link from, and the admin role: commander implies
// instructor but deliberately not admin, since keeping the roster is a separate
// job from running the portal.
await page.evaluate(async () => {
  const { connection } = await import('/js/state.js');
  const session = JSON.parse(sessionStorage.getItem('nine31.session.v1'));
  session.roles = ['admin', 'instructor'];
  sessionStorage.setItem('nine31.session.v1', JSON.stringify(session));
  connection.set({
    clientId: '000000000000-nine31demo.apps.googleusercontent.com',
    folderId: '1DemoFolderIdForTheScreenshotsOnly',
  });
});
await page.goto(`${BASE}#/admin/invite`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.qr-screen__code svg', { timeout: 15000 });
await realiseJoinLink(page);
await page.waitForTimeout(400);
await shot('qr-desktop');
await page.evaluate(async () => {
  const { connection } = await import('/js/state.js');
  connection.set({ clientId: '', folderId: 'demo' });
});

/* ---------- admin ---------- */
await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
await page.waitForSelector('table.table', { timeout: 12000 });
await shot('admin', { fullPage: true });

await browser.close();
console.log('\nAll screenshots captured to', OUT);
