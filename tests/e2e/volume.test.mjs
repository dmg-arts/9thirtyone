/**
 * The app at the size a real detachment is.
 *
 *     npm run test:volume     (starts its own server)
 *
 * Every other browser suite runs against eight cadets. Det 752 is five staff and
 * forty-five cadets, and the things that break at that size are not the things
 * that break at eight — so this one seeds the real number and asks what the app
 * *spends*, not whether it works.
 *
 * WHAT IT MEASURES, AND WHY NOT SECONDS
 *
 * In proxy mode every read and every submission is an Apps Script execution, and
 * Apps Script allows thirty of them at once across the whole account. A drill
 * night is forty-five people arriving inside a few minutes, so the number that
 * decides whether the evening works is *executions per cadet* — and that is a
 * count, not a duration. Counting it is exact and cannot flake; timing it in a
 * headless browser against a stubbed server would measure the stub.
 *
 * `tests/proxy/load.test.mjs` does the same from the other side: what one
 * execution costs the server. Together they bound the drill night. Neither can
 * reproduce real contention, and neither claims to.
 *
 * Its own suite, and its own browser context, deliberately: `app.test.mjs` is
 * sequential over one shared folder, and seeding fifty accounts into it would
 * change what every step after that point is looking at.
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/index.html';
const errors = [];

const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 1180, height: 950 } });
const page = await ctx.newPage();

// Same narrow allowance as app.test.mjs: the shipped Client ID is real, so
// Google Identity Services initialises and correctly refuses 127.0.0.1.
const EXPECTED_ON_LOCALHOST = [
  /origin is not allowed for the given client ID/i,
  /accounts\.google\.com.*\b403\b|Failed to load resource.*\b403\b/i,
];
const expected = (text) => EXPECTED_ON_LOCALHOST.some((re) => re.test(text));

page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (!expected(m.text())) errors.push(`CONSOLE: ${m.text()}`);
});

const step = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}: ${e.message.split('\n')[0]}`); errors.push(label); }
};

const CADETS = 45;
const STAFF = 5;

await page.goto(BASE, { waitUntil: 'networkidle' });

await step('setup completes', async () => {
  await page.waitForSelector('.wizard');
  await page.fill('.wizard input[type=text]', 'Det 752');
  await page.click('.wizard .btn--primary');
  await page.waitForSelector('.choice-list');
  await page.click('input[value="local"]', { force: true });
  await page.click('.wizard .btn--primary');
  await page.waitForSelector('.notice--warn');
  await page.click('.wizard .btn--primary');
  await page.waitForSelector('.tree');
  await page.click('.wizard .btn--lg');
  await page.waitForSelector('.role-grid', { timeout: 10000 });
});

/* ---------- a detachment the size of the real one ---------- */

await step(`a roster of ${STAFF} staff and ${CADETS} cadets is built`, async () => {
  const built = await page.evaluate(async ([cadets]) => {
    const a = await import('/js/auth.js');
    // The founder claims the empty roster and is handed admin + instructor.
    await a.signInWithGoogle(
      { email: 'capt.reyes@det752.edu', name: 'Reyes, Capt', emailVerified: true,
        exp: Math.floor(Date.now() / 1000) + 3600 }, null, 'test-id-token');

    for (const [email, name, roles] of [
      ['maj.okafor@det752.edu', 'Okafor, Maj', ['commander']],
      ['msgt.lindqvist@det752.edu', 'Lindqvist, MSgt', ['cadre']],
      ['capt.duval@det752.edu', 'Duval, Capt', ['instructor']],
      ['lt.abernathy-crowe@det752.edu', 'Abernathy-Crowe, Lt', ['instructor']],
    ]) await a.createAccount({ email, name, roles, asClass: '' });

    for (let i = 0; i < cadets; i++) {
      await a.createAccount({
        email: `cadet${String(i).padStart(2, '0')}@det752.edu`,
        name: `Cadet${String(i).padStart(2, '0')}, Test`,
        roles: ['student'],
        asClass: ['AS100', 'AS200', 'AS300', 'AS400'][i % 4],
      });
    }

    const ds = await import('/js/data-source.js');
    return (await ds.loadRoster()).length;
  }, [CADETS]);

  if (built !== CADETS + STAFF) throw new Error(`roster holds ${built}, expected ${CADETS + STAFF}`);
});

/* ---------- what one cadet costs on a drill night ---------- */

/**
 * The headline.
 *
 * Every POST here is one of thirty simultaneous executions the whole detachment
 * shares, spent at the exact moment forty-five people are signing in together.
 * This drives the real entry path — `signInWithGoogle`, then the feedback list —
 * rather than seeding a session, because the waste being measured is in how
 * somebody *arrives*, and a seeded session skips precisely that.
 *
 * It was five POSTs before: a `roster` call every cadet is refused by role, a
 * `bundle` fetched to answer who they are and then discarded, and the same
 * bundle fetched again one screen later.
 */
await step('a cadet signing in and reading their list costs one round trip', async () => {
  const posted = await page.evaluate(async () => {
    const key = 'nine31.connection.v1';
    const conn = JSON.parse(localStorage.getItem(key));
    const original = conn.proxyUrl;
    // A local file that really exists — `usingProxy()` only tests truthiness,
    // and an unreachable host would send the app bar's health check to the
    // network for real.
    conn.proxyUrl = `${location.origin}/manifest.json`;
    localStorage.setItem(key, JSON.stringify(conn));

    const state = await import('/js/state.js');
    state.connection.set({ proxyUrl: conn.proxyUrl });

    const bodies = [];
    const real = window.fetch;
    window.fetch = async (url, opts) => {
      if (!opts || opts.method !== 'POST') return real(url, opts);
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (body.action === 'bundle') {
        // The envelope the script actually sends: `{ok, bundle}`, not the
        // bundle at the top level. `fetchBundle` reads `result.bundle`.
        return new Response(JSON.stringify({
          ok: true,
          bundle: {
            account: {
              username: 'cadet00', name: 'Cadet00, Test',
              email: 'cadet00@det752.edu', asClass: 'AS100', section: '', roles: ['student'],
            },
            requests: [], forms: [], submitted: [],
          },
        }), { status: 200 });
      }
      // Anything else is a refusal by role, which is what the server would say.
      return new Response(JSON.stringify({
        ok: false, error: 'That account is not allowed to do this.',
      }), { status: 200 });
    };

    try {
      const auth = await import('/js/auth.js');
      const ds = await import('/js/data-source.js');
      auth.signOut();
      await auth.signInWithGoogle(
        { email: 'cadet00@det752.edu', name: 'Cadet00, Test', emailVerified: true,
          exp: Math.floor(Date.now() / 1000) + 3600 }, 'student', 'test-id-token');
      // Arriving at the feedback list, which is the next thing that happens.
      const session = (await import('/js/session.js')).currentUser();
      await ds.loadAssignments(session);
      // And moving between the list and a form and back.
      await ds.loadAssignments(session);
    } finally {
      window.fetch = real;
      state.connection.set({ proxyUrl: original || '' });
      localStorage.setItem(key, JSON.stringify({ ...conn, proxyUrl: original || '' }));
    }
    return bodies.map((b) => b.action);
  });

  // No cadet should ever spend an execution being told they are not staff.
  if (posted.includes('roster')) {
    throw new Error(`a cadet was made to call roster: ${posted.join(', ')}`);
  }
  if (posted.length > 1) {
    throw new Error(`${posted.length} round trips to sign in and read a list: ${posted.join(', ')}`);
  }
  console.log(`       one cadet arriving: ${posted.length} POST (${posted.join(', ') || 'none'})`);
});

/**
 * The pill is not free in proxy mode.
 *
 * `refreshStatus` runs on every route render. Untimed, forty-five cadets moving
 * between screens spend four or five executions each on a status indicator,
 * competing with the submissions those same executions are needed for.
 */
await step('moving between screens does not re-ask the server if it is alive', async () => {
  const gets = await page.evaluate(async () => {
    const key = 'nine31.connection.v1';
    const conn = JSON.parse(localStorage.getItem(key));
    const original = conn.proxyUrl;
    conn.proxyUrl = `${location.origin}/manifest.json`;
    localStorage.setItem(key, JSON.stringify(conn));
    const state = await import('/js/state.js');
    state.connection.set({ proxyUrl: conn.proxyUrl });

    let count = 0;
    const real = window.fetch;
    window.fetch = async (url, opts) => {
      const isGet = !opts || !opts.method || opts.method === 'GET';
      if (isGet && String(url).includes('manifest.json')) { count += 1; return real(url, opts); }
      if (isGet) return real(url, opts);
      // Reads made by the screens being navigated to. Answered here rather than
      // passed through, or they reach the dev server as a POST it has no method
      // for and the suite fails on a 501 it caused itself.
      return new Response(JSON.stringify({
        ok: true, bundle: { account: null, requests: [], forms: [], submitted: [] },
      }), { status: 200 });
    };

    try {
      const router = await import('/js/router.js');
      // The connection change itself forces one reading, deliberately — it is
      // about a different server than the last answer was. Discount it.
      await new Promise((r) => setTimeout(r, 600));
      count = 0;
      // The screens a cadet actually moves between on a drill night. Settings is
      // left out on purpose: it calls `connectionStatus` itself, because
      // somebody who opened Settings to look at the connection is asking for a
      // fresh answer rather than a cached one. That is a staff action and one at
      // a time, not forty-five people navigating.
      for (const route of ['/home', '/student', '/home', '/student', '/home']) {
        router.navigate(route);
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      window.fetch = real;
      state.connection.set({ proxyUrl: original || '' });
      localStorage.setItem(key, JSON.stringify({ ...conn, proxyUrl: original || '' }));
    }
    return count;
  });

  if (gets > 1) throw new Error(`${gets} health checks across five navigations`);
  console.log(`       five navigations: ${gets} health check`);
});

/**
 * The one refusal worth retrying, and the many that are not.
 *
 * "The server is busy" is what a cadet gets when the script could not take its
 * lock in time, which on a drill night is what forty-five simultaneous
 * submissions produce. It used to end there: a toast, and a cadet whose obvious
 * next move is to press Submit again — the same stampede, arriving twice.
 *
 * Retrying is only safe because the server writes nothing on that path, which
 * `tests/proxy/load.test.mjs` proves rather than assumes. Every other refusal
 * must still go straight to the person: retrying a submission that may have
 * succeeded is how somebody gets told their feedback failed when it is filed.
 */
await step('a busy server is retried once; any other refusal is not', async () => {
  const result = await page.evaluate(async () => {
    const key = 'nine31.connection.v1';
    const conn = JSON.parse(localStorage.getItem(key));
    const original = conn.proxyUrl;
    conn.proxyUrl = `${location.origin}/manifest.json`;
    localStorage.setItem(key, JSON.stringify(conn));
    const state = await import('/js/state.js');
    state.connection.set({ proxyUrl: conn.proxyUrl });

    const proxy = await import('/js/storage/proxy.js');
    const real = window.fetch;
    const run = async (answers) => {
      let n = 0;
      window.fetch = async (url, opts) => {
        if (!opts || opts.method !== 'POST') return real(url, opts);
        const answer = answers[Math.min(n, answers.length - 1)];
        n += 1;
        return new Response(JSON.stringify(answer), { status: 200 });
      };
      let outcome;
      try {
        await proxy.submitViaProxy(conn.proxyUrl, {
          idToken: 'test-id-token', requestId: 'req_llab', formId: 'form_llab',
          answers: { q1: 5 }, schemaVersion: 4,
        });
        outcome = 'accepted';
      } catch (err) {
        outcome = err.message;
      }
      return { attempts: n, outcome };
    };

    try {
      const busyThenOk = await run([
        { ok: false, error: 'The server is busy. Try again in a moment.' },
        { ok: true, responseId: 'res_1', submittedAt: new Date().toISOString() },
      ]);
      const duplicate = await run([
        { ok: false, error: 'You have already submitted this feedback.' },
      ]);
      return { busyThenOk, duplicate };
    } finally {
      window.fetch = real;
      state.connection.set({ proxyUrl: original || '' });
      localStorage.setItem(key, JSON.stringify({ ...conn, proxyUrl: original || '' }));
    }
  });

  if (result.busyThenOk.attempts !== 2) {
    throw new Error(`a busy refusal was tried ${result.busyThenOk.attempts} time(s), expected 2`);
  }
  if (result.busyThenOk.outcome !== 'accepted') {
    throw new Error(`the retry did not go through: ${result.busyThenOk.outcome}`);
  }
  if (result.duplicate.attempts !== 1) {
    throw new Error(`a duplicate refusal was retried ${result.duplicate.attempts} times`);
  }
  if (!/already submitted/i.test(result.duplicate.outcome)) {
    throw new Error(`the cadet was told something else: ${result.duplicate.outcome}`);
  }
  console.log('       busy -> retried once and accepted; already-submitted -> told straight away');
});

/* ---------- the analysis screen at forty-five responses ---------- */

await step('a request with 45 responses is seeded', async () => {
  const count = await page.evaluate(async ([cadets]) => {
    const m = await import('/js/storage/index.js');
    const anchors = { min: 'Never', max: 'Always' };
    const form = await m.db.saveForm({
      id: 'form_llab', name: 'LLab 3 — Drill Block',
      sections: [{ title: 'Drill', items: [
        { id: 'q1', type: 'scale', label: 'Clear instruction', required: true, min: 1, max: 9, anchors },
        { id: 'q2', type: 'text', label: 'What would you change?', required: false },
      ] }],
    });
    await m.db.saveRequest({
      id: 'req_llab', feedbackId: 'FB-2026-0752', title: 'LLab 3 — Drill Block',
      formId: form.id, asClass: '', schoolYear: '2026-2027', semester: 'Fall',
      anonymous: true, status: 'open', assignedUsernames: [],
    });
    for (let i = 0; i < cadets; i++) {
      await m.db.saveResponse({
        requestId: 'req_llab', formId: form.id, anonymous: true,
        asClass: ['AS100', 'AS200', 'AS300', 'AS400'][i % 4],
        schoolYear: '2026-2027', semester: 'Fall',
        answers: { q1: (i % 9) + 1, q2: `Response number ${i} with something to say about drill.` },
      });
      await m.db.addReceipt('req_llab', `cadet${String(i).padStart(2, '0')}`);
    }
    return (await m.db.listResponses('req_llab')).length;
  }, [CADETS]);

  if (count !== CADETS) throw new Error(`${count} responses stored, expected ${CADETS}`);
});

await step('the Analysis screen shows all 45 and still withholds what it must', async () => {
  await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    a.signOut();
    await a.signInWithGoogle(
      { email: 'capt.reyes@det752.edu', name: 'Reyes, Capt', emailVerified: true,
        exp: Math.floor(Date.now() / 1000) + 3600 }, null, 'test-id-token');
  });
  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.section-title:has-text("Completion")', { timeout: 20000 });

  const text = await page.textContent('#view');
  if (!new RegExp(`\\b${CADETS}\\b`).test(text)) {
    throw new Error('the screen never states the number of responses it has');
  }
  // The threshold is not relaxed because the dataset got bigger.
  const cfg = await page.evaluate(async () => (await import('/js/config.js')).PRIVACY.minResponsesToShow);
  if (cfg !== 3) throw new Error(`the disclosure threshold moved: ${cfg}`);
});

/**
 * Typing a filter is one redraw, not one per letter.
 *
 * `draw()` re-screens every text answer for safety terms, rebuilds the word and
 * phrase frequencies, and walks up to twenty-five requests reading receipts —
 * which in proxy mode is up to twenty-five Apps Script executions. Wired
 * straight to `oninput`, "AS200 drill" was eleven of those, ten of them for
 * strings nobody was looking for, their results discarded on arrival.
 *
 * COUNTED AS REDRAWS, AND NOT AS DATABASE READS
 *
 * The first version of this counted calls into the storage adapter and passed
 * with the debounce removed, which makes it worth saying why: the storage layer
 * caches reads for twenty seconds, so every keystroke after the first was served
 * from memory and the adapter never saw them. It measured the cache.
 *
 * The rebuild is the honest unit. It is what the cache is hiding, it is what
 * costs the executions in proxy mode where there is no such cache, and it is
 * exactly what the debounce changes. Counted by watching the results container
 * empty itself, which `draw` does via `remount` — several times per draw, so
 * the figure is a measure of churn rather than a count of draws. What matters
 * is that typing produces none of it: eleven characters made forty-eight of
 * these before the debounce, and none after.
 */
await step('typing a filter redraws when it settles, not once per letter', async () => {
  const { during, settled } = await page.evaluate(async () => {
    const box = document.querySelector('input[type=search]');
    if (!box) throw new Error('no filter box on the Analysis screen');

    // `draw()` opens with remount(results), which empties the container. Each
    // emptying is one redraw.
    const results = document.querySelector('#view .stack-lg');
    if (!results) throw new Error('no results container on the Analysis screen');

    let redraws = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) if (r.removedNodes.length && !r.addedNodes.length) redraws += 1;
    });
    observer.observe(results, { childList: true });

    for (const ch of 'AS200 drill') {
      box.value += ch;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    const during = redraws;

    // Past the quiet period: the answer for what was actually typed.
    await new Promise((r) => setTimeout(r, 700));
    const settled = redraws;

    observer.disconnect();
    return { during, settled };
  });

  if (during > 1) {
    throw new Error(`eleven characters churned the results area ${during} times while still typing`);
  }
  if (settled < 1) {
    throw new Error('typing never redrew anything — the filter is not being applied');
  }
  console.log(`       eleven keystrokes: ${during} result rebuilds while typing, ${settled} once settled`);
});

/* ---------- the demo detachment, which is already this size ---------- */

await step('the demo bundle imports and reports its own size back', async () => {
  const bundle = readFileSync(new URL('../../tools/demo/demo-detachment.json', import.meta.url), 'utf8');
  const result = await page.evaluate(async ([raw]) => {
    const m = await import('/js/storage/index.js');
    const parsed = JSON.parse(raw);
    await m.db.importBundle(parsed, { mode: 'replace' });
    const users = (await m.db.getUsers()).users;
    return {
      users: users.length,
      cadets: users.filter((u) => u.roles?.includes('student')).length,
      responses: (await m.db.listAllResponses()).length,
      expected: {
        users: parsed.users.users.length,
        responses: parsed.responses.length,
      },
    };
  }, [bundle]);

  if (result.users !== result.expected.users) {
    throw new Error(`imported ${result.users} users, bundle holds ${result.expected.users}`);
  }
  if (result.responses !== result.expected.responses) {
    throw new Error(`imported ${result.responses} responses, bundle holds ${result.expected.responses}`);
  }
  console.log(`       demo detachment: ${result.users} users (${result.cadets} cadets), `
    + `${result.responses} responses`);
});

await step('the Instructor Panel renders the imported detachment', async () => {
  await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    a.signOut();
    // The demo bundle carries its own roster, so sign in as somebody on it.
    const ds = await import('/js/data-source.js');
    const admin = (await ds.loadRoster()).find((u) => u.roles?.includes('admin'));
    await a.signInWithGoogle(
      { email: admin.email, name: admin.name, emailVerified: true,
        exp: Math.floor(Date.now() / 1000) + 3600 }, null, 'test-id-token');
  });
  await page.goto(`${BASE}#/instructor`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#view .card, #view table.table', { timeout: 20000 });
  const text = await page.textContent('#view');
  if (/error|could not/i.test(text) && !/no feedback/i.test(text)) {
    throw new Error('the panel reported an error with the demo detachment loaded');
  }
});

await browser.close();

console.log(errors.length
  ? `\n${errors.length} volume check(s) failed:\n  ${errors.join('\n  ')}`
  : '\nThe app holds up at a real detachment’s size.');
process.exit(errors.length ? 1 : 0);
