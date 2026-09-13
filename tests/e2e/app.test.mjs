/**
 * End-to-end suite: drives the real app in a real browser.
 *
 *     npm run test:e2e        (starts its own server)
 *
 * Covers the guarantees that are expensive to get wrong and easy to break
 * silently — anonymity, one submission per cadet, the disclosure threshold,
 * concurrent writes, schema migrations and access control.
 */


import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/index.html';
const shots = process.argv[2] || null;
const errors = [];

// Prefer Playwright's own browser if it has been installed; otherwise fall back
// to a system Chrome, which is what most people already have.
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 1180, height: 950 } });
const page = await ctx.newPage();
/*
 * Console noise that is expected here and only here.
 *
 * The app now ships a real, verified Google Client ID, so Google Identity
 * Services actually initialises during these runs — and refuses, because
 * 127.0.0.1 is not an authorised origin for a production client and never should
 * be. The refusal is GSI working correctly against a client that is configured
 * correctly; it says nothing about the app.
 *
 * Kept narrow deliberately. A blanket "ignore console errors" would have hidden
 * the real ones this check exists to catch, so this matches the two lines that
 * specific failure produces and nothing else.
 */
const EXPECTED_ON_LOCALHOST = [
  /origin is not allowed for the given client ID/i,
  /accounts\.google\.com.*\b403\b|Failed to load resource.*\b403\b/i,
];
const expected = (text) => EXPECTED_ON_LOCALHOST.some((re) => re.test(text));

page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (!expected(text)) errors.push(`CONSOLE: ${text}`);
});

const step = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}: ${e.message.split('\n')[0]}`); errors.push(label); }
};

/**
 * Signs in as `email`, the way a Google callback would.
 *
 * The real screen hands `signInWithGoogle` a profile decoded from an ID token.
 * Google will not issue one to a headless browser — a deliberate anti-automation
 * measure on their side — so the suite calls the same function with the same
 * shape of profile. Everything after that point is the code under test: roster
 * lookup, role check, bootstrap, session. The only thing not covered here is the
 * token decode itself, which the unit tests cover instead.
 */
const signInAs = (email, name = null, role = null) => page.evaluate(async ([e, n, r]) => {
  const a = await import('/js/auth.js');
  a.signOut();
  // The raw credential matters: proxy reads send it for the server to re-verify,
  // so a session without one cannot talk to the proxy at all. Google supplies it
  // through the sign-in callback; here it is a stand-in with a future expiry.
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const account = await a.signInWithGoogle(
    { email: e, name: n, emailVerified: true, exp }, r, 'test-id-token');
  return { username: account.username, roles: account.roles, name: account.name };
}, [email, name, role]);

/** Same, but returns the error message instead of throwing. */
const signInFails = (email, role = null) => page.evaluate(async ([e, r]) => {
  const a = await import('/js/auth.js');
  a.signOut();
  try { await a.signInWithGoogle({ email: e, emailVerified: true }, r); return 'NO ERROR'; }
  catch (err) { return err.message; }
}, [email, role]);

const ADMIN_EMAIL = 'capt.reyes@det025.edu';
const STUDENT_EMAIL = 'mia.alvarez@gmail.com';

await page.goto(BASE, { waitUntil: 'networkidle' });

await step('setup completes', async () => {
  await page.waitForSelector('.wizard');
  await page.fill('.wizard input[type=text]', 'Det 025');
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

/* ---------- Google identity, first sign-in, and the roster gate ---------- */
await step('the sign-in screen offers Google, not a password box', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.page-title:has-text("Database Administration")', { timeout: 8000 });
  if (await page.$('input[type=password]')) throw new Error('a password box is still on the screen');
  const text = await page.textContent('#view');
  if (!/no password of its own/i.test(text)) throw new Error('no explanation of how access works');
});

await step('an empty roster tells the first arrival they will claim it', async () => {
  await page.waitForSelector('.notice--info:has-text("no roster yet")', { timeout: 8000 });
});

await step('the first Google account to sign in becomes the administrator', async () => {
  const account = await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  for (const role of ['admin', 'instructor']) {
    if (!account.roles.includes(role)) throw new Error(`founder lacks ${role}: ${account.roles}`);
  }
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('table.table', { timeout: 10000 });
  if (!/capt\.reyes@det025\.edu/.test(await page.textContent('#view'))) {
    throw new Error('the founder is not shown on the roster');
  }
});

await step('the bootstrap closes behind them', async () => {
  const msg = await signInFails('stranger@example.com');
  if (!/not on this detachment's roster/i.test(msg)) throw new Error(`message was: ${msg}`);
});

await step('a token with no email is refused', async () => {
  const msg = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    try { await a.signInWithGoogle({ name: 'No Address' }); return 'NO ERROR'; }
    catch (e) { return e.message; }
  });
  if (!/did not provide an email/i.test(msg)) throw new Error(`message was: ${msg}`);
});

/* ---------- roster maintenance ---------- */
await step('a cadet is added to the roster by email', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('table.table', { timeout: 10000 });

  await page.click('.btn--primary:has-text("Add person")');
  await page.waitForSelector('dialog.modal');
  await page.fill('dialog input[type=text]', 'Alvarez, Mia');
  await page.fill('dialog input[type=email]', STUDENT_EMAIL);
  await page.selectOption('dialog select', 'AS200');
  await page.click('dialog .btn--primary');
  await page.waitForTimeout(1200);
  if (!(await page.textContent('#view')).includes(STUDENT_EMAIL)) {
    throw new Error('the cadet is not on the roster');
  }
});

await step('a username is derived so receipts have something stable to key on', async () => {
  const username = await page.evaluate(async ([email]) => {
    const a = await import('/js/auth.js');
    return (await a.findByEmail(email))?.username;
  }, [STUDENT_EMAIL]);
  if (username !== 'alvarez.mia') throw new Error(`username was "${username}"`);
});

await step('the same email cannot be added twice', async () => {
  const msg = await page.evaluate(async ([email]) => {
    const a = await import('/js/auth.js');
    try { await a.createAccount({ email, name: 'Impostor', roles: ['student'] }); return 'NO ERROR'; }
    catch (e) { return e.message; }
  }, [STUDENT_EMAIL.toUpperCase()]);   // upper-cased: matching must be case-insensitive
  if (!/already on the roster/i.test(msg)) throw new Error(`message was: ${msg}`);
});

await step('an account with no email is refused', async () => {
  const msg = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    try { await a.createAccount({ name: 'No Address', roles: ['student'] }); return 'NO ERROR'; }
    catch (e) { return e.message; }
  });
  if (!/enter the google account email/i.test(msg)) throw new Error(`message was: ${msg}`);
});

await step('roles are enforced, not just recorded', async () => {
  const msg = await signInFails(STUDENT_EMAIL, 'instructor');
  if (!/does not have instructor access/i.test(msg)) throw new Error(`message was: ${msg}`);
});

await step('a deactivated account cannot sign in', async () => {
  await page.evaluate(async ([email]) => {
    const a = await import('/js/auth.js');
    const account = await a.findByEmail(email);
    await a.updateAccount(account.id, { active: false });
  }, [STUDENT_EMAIL]);
  const msg = await signInFails(STUDENT_EMAIL, 'student');
  if (!/deactivated/i.test(msg)) throw new Error(`message was: ${msg}`);
  await page.evaluate(async ([email]) => {
    const a = await import('/js/auth.js');
    const all = await a.listAccounts();
    const account = all.find((x) => x.email === email);
    await a.updateAccount(account.id, { active: true });
  }, [STUDENT_EMAIL]);
});

await step('changing an email keeps the username their receipts are filed under', async () => {
  const after = await page.evaluate(async ([email]) => {
    const a = await import('/js/auth.js');
    const account = await a.findByEmail(email);
    const moved = await a.updateAccount(account.id, { email: 'mia.alvarez@wilkes.edu' });
    const back = await a.updateAccount(account.id, { email });
    return { moved: moved.username, back: back.username };
  }, [STUDENT_EMAIL]);
  if (after.moved !== 'alvarez.mia' || after.back !== 'alvarez.mia') {
    throw new Error(`username changed with the email: ${JSON.stringify(after)}`);
  }
});
if (shots) await page.screenshot({ path: `${shots}/m1-admin.png`, fullPage: true });

/* ---------- create feedback with anchors ---------- */
await step('a feedback form is issued', async () => {
  // The form creator is deep-linkable, so it must gate on its own.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${BASE}#/instructor/create/new`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.page-title:has-text("Instructor Panel")', { timeout: 8000 });
  if (await page.$('.qrow')) throw new Error('the form creator opened without a sign-in');

  await signInAs(ADMIN_EMAIL, 'Capt Reyes', 'instructor');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.qrow', { timeout: 10000 });
  const rows = await page.$$('.qrow');
  const texts = ['Instruction was clear', 'Event was organised', 'What should change?'];
  for (let i = 0; i < rows.length; i++) {
    await (await rows[i].$('input.input')).fill(texts[i] || `Q${i}`);
  }
  await page.fill('input[placeholder^="e.g. AS200 Leadership"]', 'AS200 Drill Block 3');
  await page.selectOption('.filters select', 'AS200');
  await page.click('.btn--primary:has-text("Issue to cadets")');
  await page.waitForSelector('.list__item', { timeout: 10000 });
});

/* ---------- cadet sign-in ---------- */
await step('the student page requires a sign-in', async () => {
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${BASE}#/student`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.page-title:has-text("Cadet sign-in")', { timeout: 8000 });
  if (await page.$('.list__item')) throw new Error('feedback was listed without a sign-in');
});

await step('an instructor cannot sign in through the student door', async () => {
  const msg = await signInFails(ADMIN_EMAIL, 'student');
  if (!/does not have student access/i.test(msg)) throw new Error(`message was: ${msg}`);
});

await step('the cadet signs in and sees their feedback', async () => {
  await signInAs(STUDENT_EMAIL, 'Mia Alvarez', 'student');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.list__item', { timeout: 10000 });
});

await step('school year and semester filters are present', async () => {
  const labels = await page.$$eval('.filters .field__label', (n) => n.map((x) => x.textContent.trim()));
  for (const want of ['School year', 'Semester', 'Class', 'Due from', 'Due to']) {
    if (!labels.some((l) => l.startsWith(want))) throw new Error(`missing "${want}" — saw ${labels.join(', ')}`);
  }
});

await step('students choose words, never numbers', async () => {
  await page.click('.list__item');
  await page.waitForSelector('.scale--words', { timeout: 8000 });

  const labels = await page.$$eval(
    '.q[data-qtype=scale] .scale--words .scale__opt span',
    (n) => n.map((x) => x.textContent.trim()));
  const expected = ['Detrimental', 'Alarming', 'Unfavorable', 'Minor', 'Neutral',
    'Slight', 'Favorable', 'Major', 'Outstanding'];
  const firstNine = labels.slice(0, 9);
  if (JSON.stringify(firstNine) !== JSON.stringify(expected)) {
    throw new Error(`scale reads ${JSON.stringify(firstNine)}`);
  }
  // No digit should be visible anywhere in a rating question.
  const digits = labels.filter((l) => /\d/.test(l));
  if (digits.length) throw new Error(`numbers shown to students: ${digits.join(', ')}`);

  // ...but the value carried for the maths is the 1-9 number.
  const values = await page.$$eval(
    '.q[data-qtype=scale]:first-of-type input[type=radio]', (n) => n.map((x) => x.value));
  if (JSON.stringify(values) !== JSON.stringify(['1','2','3','4','5','6','7','8','9'])) {
    throw new Error(`underlying values are ${JSON.stringify(values)}`);
  }
  // The scale must render as one column per point, not wrap into two groups.
  const cols = await page.evaluate(() => {
    const g = document.querySelector('.q[data-qtype=scale] .scale--words');
    return {
      count: g.style.getPropertyValue('--scale-count'),
      columns: getComputedStyle(g).gridTemplateColumns.split(' ').length,
    };
  });
  if (cols.count !== '9') throw new Error(`--scale-count is "${cols.count}"`);
});
if (shots) await page.screenshot({ path: `${shots}/m2-form.png`, fullPage: true });

await step('student submits and is receipted', async () => {
  await page.evaluate(() => {
    for (const q of document.querySelectorAll('.q[data-qtype=scale]')) {
      // 7th option = "Favorable" = 7
      q.querySelectorAll('input[type=radio]')[6]?.click();
    }
    for (const t of document.querySelectorAll('.q[data-qtype=text] textarea')) {
      t.value = 'More reps on the drill sequence.';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.click('.btn--lg:has-text("Submit")');
  await page.waitForSelector('dialog.modal', { timeout: 8000 });
  await page.click('dialog .btn--primary');
  await page.waitForSelector('.empty__title:has-text("Feedback submitted")', { timeout: 10000 });
});

await step('a second submission is blocked at the form', async () => {
  await page.goto(`${BASE}#/student`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.click('.check input[type=checkbox]');
  await page.waitForSelector('.list__item', { timeout: 8000 });
  await page.click('.list__item');
  await page.waitForSelector('.notice--ok:has-text("already submitted")', { timeout: 10000 });
});

await step('anonymity holds: response has no username, receipt does', async () => {
  const r = await page.evaluate(async () => {
    const all = await new Promise((res) => {
      const q = indexedDB.open('nine31');
      q.onsuccess = () => {
        const t = q.result.transaction('docs').objectStore('docs').getAll();
        t.onsuccess = () => res(t.result);
      };
    });
    return {
      responses: JSON.stringify(all.filter((x) => /^responses\/.+\/res_/.test(x.path)).map((x) => x.data)),
      receipts: JSON.stringify(all.filter((x) => x.path.startsWith('receipts/')).map((x) => x.data)),
    };
  });
  if (r.responses.includes('alvarez.mia')) throw new Error('USERNAME LEAKED INTO ANONYMOUS RESPONSE');
  if (!r.receipts.includes('alvarez.mia')) throw new Error('no receipt written');
  // The word the cadet picked must be stored as its number, not as text.
  const answers = JSON.parse(r.responses)[0].answers;
  const rated = Object.values(answers).filter((v) => typeof v === 'number');
  if (!rated.length) throw new Error('no numeric ratings stored');
  if (!rated.every((v) => v === 7)) throw new Error(`expected 7 for Satisfactory, got ${rated.join(',')}`);
});

await step('analysis reports the mean back in words', async () => {
  // One anonymous response is withheld by design now, so add two more from
  // other cadets to clear the disclosure threshold before checking the maths.
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const reqs = await m.db.listRequests();
    const target = reqs.find((r) => r.status === 'open');
    for (const [user, rating] of [['top.up1', 7], ['top.up2', 7]]) {
      await m.db.saveResponse({
        requestId: target.id, formId: target.formId, anonymous: true,
        asClass: target.asClass, schoolYear: target.schoolYear, semester: target.semester,
        answers: Object.fromEntries(
          Object.keys((await m.db.listResponses(target.id))[0].answers).map((k) => [k, rating])),
      });
      await m.db.addReceipt(target.id, user);
    }
  });
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.bar-row', { timeout: 12000 });
  const text = await page.textContent('.stack-lg');
  if (!/Favorable/.test(text)) throw new Error('mean not described in words');
  const bar = await page.textContent('.bar-row__val');
  if (!/·/.test(bar)) throw new Error(`bar value reads "${bar}"`);
});

/* ---------- migrations ---------- */
await step('a v1 folder is migrated forward on load', async () => {
  const result = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    // Simulate a folder written by the previous release.
    await m.db.saveOrg({ schemaVersion: 1 });
    await m.db.adapter.writeDoc('roster/students.json', {
      students: [{ id: 'stu_old', name: 'Legacy, Cadet', asClass: 'AS100', active: true }],
    });
    await m.db.adapter.writeDoc('requests/req_legacy.json', {
      id: 'req_legacy', title: 'Old form', formId: 'form_x', status: 'closed',
      createdAt: '2025-09-01T00:00:00.000Z',
    });
    const before = await m.db.migrationStatus();
    const ran = await m.db.migrate();
    const after = await m.db.migrationStatus();
    const legacyReq = await m.db.getRequest('req_legacy');
    const users = (await m.db.getUsers()).users || [];
    return {
      pendingBefore: before.pending.length,
      from: ran.from, to: ran.to, ran: ran.ran, notes: ran.notes,
      pendingAfter: after.pending.length,
      legacyFeedbackId: legacyReq?.feedbackId || null,
      migratedUser: users.find((u) => u.name === 'Legacy, Cadet') || null,
    };
  });
  if (result.pendingBefore !== 3) throw new Error(`expected 3 pending, saw ${result.pendingBefore}`);
  if (result.from !== 1 || result.to !== 4) throw new Error(`migrated ${result.from}->${result.to}`);
  if (result.pendingAfter !== 0) throw new Error('still pending after migrate');
  if (!/^FB-\d{4}-\d{4}$/.test(result.legacyFeedbackId || '')) {
    throw new Error(`legacy request not stamped: ${result.legacyFeedbackId}`);
  }
  if (!result.migratedUser) throw new Error('roster student not converted to an account');
  // v4 leaves an account with no email flagged rather than deleted: it still
  // carries the username its receipts are filed under, which an admin needs.
  if (!result.migratedUser.needsEmail) throw new Error('emailless account not flagged by v4');
  if ('password' in result.migratedUser) throw new Error('a password field survived v4');
  console.log(`       ${result.ran[0]}`);
  for (const n of result.notes) console.log(`       · ${n}`);
});

await step('migrations are idempotent', async () => {
  const again = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const r = await m.db.migrate();
    return { ran: r.ran.length, from: r.from, to: r.to };
  });
  if (again.ran !== 0) throw new Error(`re-ran ${again.ran} migrations on an up-to-date folder`);
});

await step('a newer folder refuses to be downgraded', async () => {
  const msg = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    await m.db.saveOrg({ schemaVersion: 99 });
    try { await m.db.migrate(); return 'NO ERROR'; }
    catch (e) { return e.message; }
    finally { await m.db.saveOrg({ schemaVersion: 4 }); }
  });
  if (!/newer version/i.test(msg)) throw new Error(`message was: ${msg}`);
});

await step('schema panel reports the version', async () => {
  // Signed in as a student at this point; the admin console needs admin.
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.section-title:has-text("Schema version")', { timeout: 10000 });
  const text = await page.textContent('#view');
  if (!/Up to date/.test(text)) throw new Error('schema panel does not show up-to-date');
});
if (shots) await page.screenshot({ path: `${shots}/m3-schema.png`, fullPage: true });


/* ---------- folded in from the retired suite ---------- */

await step('home shows all three entries', async () => {
  await page.goto(`${BASE}#/home`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.role-grid', { timeout: 8000 });
  const text = await page.textContent('.role-grid');
  for (const want of ['Cadet', 'Instructor Panel', 'Database Administration']) {
    if (!text.includes(want)) throw new Error(`missing "${want}"`);
  }
});

await step('duplicate handles are rejected, case-insensitively', async () => {
  const msg = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    try {
      await a.createAccount({ email: 'other.mia@gmail.com', username: 'ALVAREZ.MIA',
                              name: 'Dup', roles: ['student'] });
      return 'NO ERROR';
    } catch (e) { return e.message; }
  });
  if (!/already in use/i.test(msg)) throw new Error(`message was: ${msg}`);
});

await step('home stats read the index, not every response', async () => {
  const reads = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const adapter = m.db.adapter;
    let count = 0;
    const original = adapter.readDoc.bind(adapter);
    adapter.readDoc = (p) => { count++; return original(p); };
    m.db.use('local');                      // cold cache, as on a fresh load
    await m.db.stats();
    adapter.readDoc = original;
    return count;
  });
  if (reads > 12) throw new Error(`db.stats() made ${reads} reads`);
  console.log(`       db.stats() = ${reads} document reads`);
});

await step('a write made offline is queued, then drains on reconnect', async () => {
  await ctx.setOffline(true);
  const queued = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const adapter = m.db.adapter;
    const real = adapter.writeDoc.bind(adapter);
    adapter.writeDoc = () => Promise.reject(new TypeError('Failed to fetch'));
    const saved = await m.db.saveResponse({
      requestId: 'req_offline_test', formId: 'f1', anonymous: true, answers: { q1: 9 },
    });
    const state = await m.queueState();
    adapter.writeDoc = real;
    return { queued: saved.queued, pending: state.pending };
  });
  if (!queued.queued || queued.pending < 1) throw new Error('write was not queued');

  await ctx.setOffline(false);
  const remaining = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    for (let i = 0; i < 40; i++) {
      const state = await m.queueState();
      if (state.pending === 0) return 0;
      if (!state.draining) await m.flushQueue().catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
    }
    return (await m.queueState()).pending;
  });
  if (remaining !== 0) throw new Error(`${remaining} still queued after reconnect`);
  console.log(`       queued ${queued.pending}, drained to 0`);
});

await step('analysis renders with completion tracking', async () => {
  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.bar-row', { timeout: 12000 });
  await page.waitForSelector('.meter__fill', { timeout: 12000 });
  const text = await page.textContent('.stack-lg');
  if (!/Completion/.test(text)) throw new Error('no completion panel');
  if (!/submitted/.test(text)) throw new Error('no submission counts');
});

/* ---------- the cadre panel ---------- */

/** Rewrites the signed-in session's roles, the way a differently-rostered account would arrive. */
const setRoles = (roles) => page.evaluate((r) => {
  const s = JSON.parse(sessionStorage.getItem('nine31.session.v1'));
  s.roles = r;
  sessionStorage.setItem('nine31.session.v1', JSON.stringify(s));
}, roles);

await step('an instructor cannot open the Cadre Panel', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes', 'instructor');
  await setRoles(['instructor']);
  await page.goto(`${BASE}#/cadre`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const text = await page.textContent('#view');
  // The sign-in gate, not the panel.
  if (/Restricted space/.test(text)) throw new Error('an instructor reached the cadre panel');
});

await step('the two panels show different feedback', async () => {
  // One request in each area, same everything else.
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    for (const [id, title, space] of [
      ['req_shared_x', 'DETACHMENT ITEM', 'shared'],
      ['req_cadre_x', 'CADRE ITEM', 'cadre'],
      ['req_cmdr_x', 'COMMANDER ITEM', 'commander'],
    ]) {
      await m.db.saveRequest({
        id, title, space, status: 'open', formId: null,
        asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
        createdAt: new Date().toISOString(),
      });
    }
  });

  await signInAs(ADMIN_EMAIL, 'Capt Reyes', 'instructor');
  await setRoles(['cadre']);
  await page.goto(`${BASE}#/instructor?tab=requests`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const instructorList = await page.textContent('#view');
  if (!/DETACHMENT ITEM/.test(instructorList)) throw new Error('detachment item missing from Instructor Panel');
  if (/CADRE ITEM/.test(instructorList)) {
    throw new Error('cadre-only feedback is still listed in the Instructor Panel');
  }

  await page.goto(`${BASE}#/cadre?tab=requests`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const cadreList = await page.textContent('#view');
  if (!/CADRE ITEM/.test(cadreList)) throw new Error('cadre item missing from Cadre Panel');
  if (/DETACHMENT ITEM/.test(cadreList)) {
    throw new Error('the Cadre Panel is showing detachment feedback');
  }
  // A cadre member is not a commander.
  if (/COMMANDER ITEM/.test(cadreList)) {
    throw new Error('a cadre member saw the commander area');
  }
});

await step('a commander sees their own area inside the Cadre Panel', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes', 'instructor');
  await setRoles(['commander']);
  await page.goto(`${BASE}#/cadre?tab=requests`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const text = await page.textContent('#view');
  if (!/COMMANDER ITEM/.test(text)) throw new Error('the commander cannot see their own area');
  if (!/CADRE ITEM/.test(text)) throw new Error('the commander lost sight of cadre material');
  if (/DETACHMENT ITEM/.test(text)) throw new Error('detachment feedback leaked into the Cadre Panel');
});

await step('creating from the Cadre Panel files it as cadre', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes', 'instructor');
  await setRoles(['cadre']);
  await page.goto(`${BASE}#/instructor/create/new?panel=cadre`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  // The area picker should already be on the cadre option, not the default.
  const chosen = await page.evaluate(() => {
    const selects = [...document.querySelectorAll('select')];
    const picker = selects.find((s) => [...s.options].some((o) => o.value === 'cadre'));
    return picker ? picker.value : null;
  });
  if (chosen !== 'cadre') throw new Error(`new cadre form defaulted to "${chosen}"`);
  // And the way back leads to the panel it came from.
  const backLinks = await page.$$eval('button', (n) => n.map((b) => b.textContent.trim()));
  if (!backLinks.some((t) => /^Cadre Panel$/.test(t))) {
    throw new Error(`no back link to the Cadre Panel; buttons: ${backLinks.slice(0, 6).join(' | ')}`);
  }
});


/* ---------- join links ---------- */

/* ---------- disconnecting a device ---------- */

/**
 * Disconnect forgets where the records are, not how to sign in.
 *
 * `connection.reset()` restored every field to its fallback, and the fallback for
 * the Client ID is deliberately empty so that device-only installs keep the email
 * sign-in. The cost was that a Drive install which disconnected came back with no
 * Client ID at all, so sign-in offered no Google button and pointed at setup —
 * which, before the wizard learned to look first, made a new empty folder.
 */
await step('disconnecting keeps the Client ID and forgets only the folder', async () => {
  const kept = await page.evaluate(async () => {
    const state = await import('/js/state.js');
    const before = state.connection.get();
    state.connection.set({
      backend: 'drive',
      clientId: 'shared-client.apps.googleusercontent.com',
      folderId: 'folder-abc',
      folderName: '9ThirtyOne',
      folderUrl: 'https://drive.google.com/drive/folders/folder-abc',
    });
    state.disconnectDevice();
    const after = state.connection.get();
    state.connection.replace(before);
    return after;
  });
  if (kept.clientId !== 'shared-client.apps.googleusercontent.com') {
    throw new Error(`the Client ID was discarded: "${kept.clientId}"`);
  }
  for (const field of ['folderId', 'folderName', 'folderUrl']) {
    if (kept[field]) throw new Error(`${field} survived a disconnect as "${kept[field]}"`);
  }
  if (kept.backend) throw new Error('the backend survived a disconnect');
});

await step('a device-only install still disconnects to an empty Client ID', async () => {
  const after = await page.evaluate(async () => {
    const state = await import('/js/state.js');
    const before = state.connection.get();
    state.connection.set({ backend: 'local', clientId: '', folderId: '' });
    state.disconnectDevice();
    const result = state.connection.get();
    state.connection.replace(before);
    return result;
  });
  // The invariant the email sign-in depends on: no Client ID is a real state.
  if (after.clientId !== '') throw new Error(`a Client ID appeared from nowhere: "${after.clientId}"`);
});

/* ---------- session and token expiry ---------- */

/**
 * Two clocks, and neither was tested.
 *
 * The ID token lasts about an hour and the session eight, so they expire at
 * different times and mean different things. `currentIdToken()` returning null
 * on the first is what makes a proxy read fail with "your sign-in has expired"
 * rather than a raw server error — the same seam the proxy-mode lockout lived
 * in. `currentUser()` returning null on the second is the shared-office-laptop
 * guarantee: a tab left open all day stops being signed in.
 */
await step('an expired ID token is withheld while the session survives', async () => {
  const result = await page.evaluate(async () => {
    const s = await import('/js/session.js');
    const key = 'nine31.session.v1';
    const saved = sessionStorage.getItem(key);
    try {
      s.startSession(
        { id: 'usr_x', email: 'x@y.z', username: 'x', name: 'X', roles: ['instructor'] },
        { idToken: 'tok-stale', idTokenExp: Math.floor(Date.now() / 1000) - 60 });
      return { token: s.currentIdToken(), user: s.currentUser()?.username || null };
    } finally {
      if (saved) sessionStorage.setItem(key, saved); else sessionStorage.removeItem(key);
    }
  });
  // Withheld rather than handed over: passing a token the proxy will reject
  // turns a clear "sign in again" into an opaque server refusal.
  if (result.token !== null) throw new Error(`a stale token was handed out: ${result.token}`);
  // But the person is still signed in — only the credential aged out, and the
  // app can re-acquire one without making them start over.
  if (result.user !== 'x') throw new Error(`the session was dropped too: ${result.user}`);
});

await step('a live ID token is handed over', async () => {
  // The negative above is only worth anything beside this.
  const token = await page.evaluate(async () => {
    const s = await import('/js/session.js');
    const key = 'nine31.session.v1';
    const saved = sessionStorage.getItem(key);
    try {
      s.startSession(
        { id: 'usr_x', email: 'x@y.z', username: 'x', name: 'X', roles: ['instructor'] },
        { idToken: 'tok-fresh', idTokenExp: Math.floor(Date.now() / 1000) + 3600 });
      return s.currentIdToken();
    } finally {
      if (saved) sessionStorage.setItem(key, saved); else sessionStorage.removeItem(key);
    }
  });
  if (token !== 'tok-fresh') throw new Error(`expected tok-fresh, got ${token}`);
});

await step('a session past its expiry signs itself out rather than reporting stale', async () => {
  const result = await page.evaluate(async () => {
    const s = await import('/js/session.js');
    const key = 'nine31.session.v1';
    const saved = sessionStorage.getItem(key);
    try {
      // Written directly: startSession always stamps `until` in the future, so
      // the only way to reach this branch is to age the record.
      sessionStorage.setItem(key, JSON.stringify({
        id: 'usr_old', email: 'old@y.z', username: 'old', name: 'Old',
        roles: ['admin'], idToken: 'tok', idTokenExp: Math.floor(Date.now() / 1000) + 3600,
        until: Date.now() - 1000,
      }));
      const user = s.currentUser();
      // Clearing it is the point. Reporting null while leaving the record in
      // place would leave the next reader to make the same judgement, and any
      // one of them forgetting is somebody else's session on a shared laptop.
      return { user, left: sessionStorage.getItem(key), token: s.currentIdToken() };
    } finally {
      if (saved) sessionStorage.setItem(key, saved); else sessionStorage.removeItem(key);
    }
  });
  if (result.user !== null) throw new Error('an expired session still reported a user');
  if (result.left !== null) throw new Error('the expired session was left in sessionStorage');
  // And the token goes with it, even though its own expiry had not passed.
  if (result.token !== null) throw new Error('a token outlived the session holding it');
});

/* ---------- roster import ---------- */

/**
 * The columns Export CSV writes are the columns Import has to read.
 *
 * They were not: import took `name`, `email` and `class` and forced every row to
 * cadet, while export wrote roles, section and username as well. So the obvious
 * thing to do with an exported roster — open it in a spreadsheet, fix a few
 * rows, import it back — silently demoted every instructor, cadre member and
 * commander. Silently is the part worth pinning: nothing failed, so nothing said
 * anything, and the roster looked complete.
 */
await step('an imported roster keeps the roles the file gives it', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('button:has-text("Import roster CSV")', { timeout: 12000 });

  const csv = [
    'name,email,roles,class,section,username',
    '"Vance, Nia",nia.vance@import.test,cadre instructor,CADRE,,',
    '"Idris, Omar",omar.idris@import.test,admin,CADRE,,',
    '"Pike, Lena",lena.pike@import.test,,AS300,Delta,',
  ].join('\n');

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('button:has-text("Import roster CSV")'),
  ]);
  await chooser.setFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForTimeout(1500);

  const found = await page.evaluate(async () => {
    const ds = await import('/js/data-source.js');
    const roster = await ds.loadRoster();
    const pick = (email) => roster.find((a) => a.email === email) || null;
    return {
      vance: pick('nia.vance@import.test'),
      idris: pick('omar.idris@import.test'),
      pike: pick('lena.pike@import.test'),
    };
  });

  for (const [who, account] of Object.entries(found)) {
    if (!account) throw new Error(`${who} was never added`);
  }
  const roles = (a) => [...(a.roles || [])].sort().join(' ');
  if (roles(found.vance) !== 'cadre instructor') {
    throw new Error(`cadre instructor came back as "${roles(found.vance)}"`);
  }
  if (roles(found.idris) !== 'admin') {
    throw new Error(`admin came back as "${roles(found.idris)}"`);
  }
  // A blank roles column still means cadet, so a plain name/email list keeps
  // behaving the way detachments already use it.
  if (roles(found.pike) !== 'student') {
    throw new Error(`a blank roles column came back as "${roles(found.pike)}"`);
  }
  if (found.pike.section !== 'Delta') throw new Error(`section was "${found.pike.section}"`);
  if (found.pike.asClass !== 'AS300') throw new Error(`class was "${found.pike.asClass}"`);
});

await step('a roster row naming something invalid is refused, not downgraded', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('button:has-text("Import roster CSV")', { timeout: 12000 });

  const csv = [
    'name,email,roles,class,section,username',
    '"Quill, Ada",ada.quill@import.test,supervisor,AS100,,',
    '"Rand, Theo",theo.rand@import.test,student,AS-100,,',
  ].join('\n');

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('button:has-text("Import roster CSV")'),
  ]);
  await chooser.setFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForSelector('.modal, [role="dialog"]', { timeout: 8000 });
  const text = await page.textContent('.modal, [role="dialog"]');
  if (!/unknown role/i.test(text)) throw new Error(`no unknown-role reason shown: ${text.slice(0, 300)}`);
  if (!/unknown class/i.test(text)) throw new Error(`no unknown-class reason shown: ${text.slice(0, 300)}`);

  const leaked = await page.evaluate(async () => {
    const ds = await import('/js/data-source.js');
    const roster = await ds.loadRoster();
    return roster.filter((a) => /ada\.quill|theo\.rand/.test(a.email || '')).map((a) => a.email);
  });
  if (leaked.length) throw new Error(`a refused row was added anyway: ${leaked.join(', ')}`);
});

await step('the admin console offers a join link', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.section-title:has-text("Invite people")', { timeout: 12000 });
  const text = await page.textContent('#view');
  // These captures run on the local backend, which no other device can reach,
  // so the card must say so rather than hand out a link that cannot work.
  if (!/Join links need Google Drive storage/.test(text)) {
    throw new Error('the local backend was offered a join link anyway');
  }
});

await step('a join link is built from the live connection', async () => {
  const link = await page.evaluate(async () => {
    const j = await import('/js/join.js');
    return j.buildJoinLink({
      clientId: '724504040762-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com',
      folderId: '1Te9Pc7JgOSUluq3tc0FCK4IqbKm1MTIM',
      orgName: 'Det 025',
      base: 'https://example.org/app/',
    });
  });
  if (!link.startsWith('https://example.org/app/#/join?')) throw new Error(link);
  if (!link.includes('c=724504040762-abcdefghijklmnopqrstuvwxyz012345')) {
    throw new Error('client id suffix was not stripped');
  }
  if (link.includes('.apps.googleusercontent.com')) throw new Error('suffix still present');
});

await step('the join route renders without a session or a configured device', async () => {
  // The whole point: this must work for someone who has never signed in, on a
  // device that has never been set up.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${BASE}#/join?c=724504040762-abcdefghijklmnopqrstuvwxyz012345&f=1Te9Pc7JgOSUluq3tc0FCK4IqbKm1MTIM&n=Det%20025`,
    { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.page-title', { timeout: 10000 });
  const title = await page.textContent('.page-title');
  if (!/Join Det 025/.test(title)) throw new Error(`title read "${title}"`);
  const body = await page.textContent('#view');
  // Not "warns about an unverified app" any more — the app is verified, so that
  // screen is gone and the absence of it is the signal worth teaching.
  if (!/permission/i.test(body)) throw new Error('no mention of the Google consent step');
  if (/Choose Advanced/i.test(body)) throw new Error('still tells the reader to choose Advanced');
});

await step('a truncated join link is refused rather than half-applied', async () => {
  await page.goto(`${BASE}#/join?c=724504040762-abcdefghijklmnopqrstuvwxyz012345`,
    { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.notice--danger', { timeout: 10000 });
  const text = await page.textContent('#view');
  if (!/incomplete|missing something/i.test(text)) throw new Error('a truncated link was accepted');
  // And it must not have touched the device's existing configuration.
  const backend = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('nine31.connection.v1')).backend; }
    catch { return null; }
  });
  if (backend !== 'local') throw new Error(`connection was changed to ${backend}`);
});

await step('a join link for the folder already in use says so', async () => {
  const link = await page.evaluate(() => {
    const conn = JSON.parse(localStorage.getItem('nine31.connection.v1'));
    return `#/join?c=724504040762-abcdefghijklmnopqrstuvwxyz012345&f=${conn.folderId || 'none'}`;
  });
  await page.goto(`${BASE}${link}`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.page-title', { timeout: 10000 });
  // The local backend's folderId is not a Drive id, so this exercises the
  // mismatch path rather than the already-here path — either way it must not
  // silently reconfigure the device.
  const backend = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('nine31.connection.v1')).backend);
  if (backend !== 'local') throw new Error(`connection changed to ${backend} without consent`);
});

/**
 * The suite runs on the local backend, which has no Client ID or folder — so a
 * join link cannot be built and the screen correctly refuses. Supply both, then
 * reload: the connection store caches at module load, so writing storage after
 * the page is up has no effect until it re-reads.
 */
const giveJoinConfig = async () => {
  await page.evaluate(() => {
    const key = 'nine31.connection.v1';
    const conn = JSON.parse(localStorage.getItem(key));
    conn.clientId = '724504040762-rrq3q51dip6rib0g8lof5pq5r6da2g03.apps.googleusercontent.com';
    conn.folderId = '1Te9Pc7JgOSUluq3tc0FCK4IqbKm1MTIM';
    localStorage.setItem(key, JSON.stringify(conn));
  });
  await page.reload({ waitUntil: 'networkidle' });
};

await step('the QR screen renders a scannable code from the live link', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  await page.goto(`${BASE}#/admin/invite`, { waitUntil: 'networkidle' });
  await giveJoinConfig();
  await page.waitForSelector('.qr-screen__code svg', { timeout: 12000 });

  const shape = await page.evaluate(() => {
    const svg = document.querySelector('.qr-screen__code svg');
    const box = svg.getBoundingClientRect();
    const style = getComputedStyle(svg);
    return {
      square: Math.abs(box.width - box.height) < 2,
      wide: box.width > 100,
      // Contrast is a scanning requirement, so the plate must stay white in
      // every theme rather than following the surface token.
      plate: style.backgroundColor,
      viewBox: svg.getAttribute('viewBox'),
      darkModules: svg.querySelector('path').getAttribute('fill'),
    };
  });
  if (!shape.square) throw new Error('the code is not square');
  if (!shape.wide) throw new Error('the code rendered too small to scan');
  if (shape.plate !== 'rgb(255, 255, 255)') throw new Error(`plate is ${shape.plate}`);
  if (shape.darkModules !== '#000000') throw new Error(`modules are ${shape.darkModules}`);

  // The quiet zone is four light modules on every side; without it many
  // scanners cannot find the code's edges at all.
  const [, , w] = shape.viewBox.split(' ').map(Number);
  const size = await page.evaluate(async () => {
    const { encodeQr } = await import('/js/qr.js');
    return encodeQr('x').size;
  });
  if (w <= size) throw new Error(`viewBox ${w} leaves no quiet zone`);
});

await step('the QR screen goes back where it came from', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.goto(`${BASE}#/admin/invite`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.qr-screen__code svg', { timeout: 12000 });
  await page.click('.qr-screen__head .btn');
  await page.waitForTimeout(900);
  const hash = await page.evaluate(() => location.hash);
  if (!hash.startsWith('#/admin') || hash.includes('invite')) {
    throw new Error(`back landed on ${hash}`);
  }
});

await step('the join config is put back so later screens do not call Google', async () => {
  // A real-looking Client ID makes Google Identity initialise against
  // 127.0.0.1, which is not a registered origin — harmless, but it fills the
  // console with errors the suite treats as failures.
  await page.evaluate(() => {
    const key = 'nine31.connection.v1';
    const conn = JSON.parse(localStorage.getItem(key));
    conn.clientId = '';
    localStorage.setItem(key, JSON.stringify(conn));
  });
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  const cleared = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('nine31.connection.v1')).clientId);
  if (cleared) throw new Error('the client id was not cleared');
});

await step('the encoder refuses input it cannot represent', async () => {
  const msg = await page.evaluate(async () => {
    const { encodeQr } = await import('/js/qr.js');
    try { encodeQr('x'.repeat(5000)); return 'NO ERROR'; }
    catch (e) { return e.message; }
  });
  if (!/too long/i.test(msg)) throw new Error(`message was: ${msg}`);
});

/* ---------- proxy read routing ---------- */

await step('cadre reads go to Drive when no proxy is configured', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  const calls = await page.evaluate(async () => {
    const seen = [];
    const real = window.fetch;
    window.fetch = (...args) => { seen.push(String(args[0])); return real(...args); };
    try {
      const ds = await import('/js/data-source.js');
      await ds.loadCatalog();
      await ds.loadRoster();
    } finally { window.fetch = real; }
    return seen.filter((u) => u.includes('script.google.com'));
  });
  if (calls.length) throw new Error(`direct mode called the proxy: ${calls.join(', ')}`);
});

await step('cadre reads go to the proxy when one is configured, with the right actions', async () => {
  const posted = await page.evaluate(async () => {
    const key = 'nine31.connection.v1';
    const conn = JSON.parse(localStorage.getItem(key));
    const original = conn.proxyUrl;
    // A local file that genuinely exists, not a fabricated script.google.com URL.
    // `usingProxy()` only tests truthiness and every proxy call below is stubbed,
    // so the address never needs to look real — and pointing at an unreachable
    // host meant the app bar's health check tried to reach it for real. That went
    // unnoticed for as long as no test rendered the app bar, because
    // refreshStatus() returns early when #conn-indicator is absent.
    conn.proxyUrl = `${location.origin}/manifest.json`;
    localStorage.setItem(key, JSON.stringify(conn));

    const state = await import('/js/state.js');
    state.connection.set({ proxyUrl: conn.proxyUrl });

    const bodies = [];
    const real = window.fetch;
    // Answer as the script would, so the client parses a real shape rather
    // than erroring on the way out.
    window.fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({
        ok: true, catalog: { forms: [], requests: [] }, users: [], entries: [], responses: [],
      }), { status: 200 });
    };
    try {
      const ds = await import('/js/data-source.js');
      await ds.loadCatalog();
      await ds.loadRoster();
      await ds.loadAllResponses();
      await ds.loadAudit(3);
    } finally {
      window.fetch = real;
      state.connection.set({ proxyUrl: original || '' });
    }
    return bodies;
  });

  const actions = posted.map((b) => b.action);
  for (const want of ['catalog', 'roster', 'allResponses', 'audit']) {
    if (!actions.includes(want)) throw new Error(`never posted "${want}" — saw ${actions.join(', ')}`);
  }
  if (!posted.every((b) => b.idToken)) throw new Error('a read went out with no ID token');
  // The whole access model rests on the client never naming a file.
  const named = posted.filter((b) => b.path || b.file || b.folder);
  if (named.length) throw new Error('a read named a path instead of an action');
});

await step('maintenance disappears once a proxy is configured', async () => {
  // The unit suite pins how canDoMaintenance is written; this pins what it does.
  // Backup, restore, import and wipe act on the whole folder, and in proxy mode
  // this device has no storage adapter to act with — the proxy deliberately
  // exposes no action for any of them.
  const result = await page.evaluate(async () => {
    const state = await import('/js/state.js');
    const ds = await import('/js/data-source.js');
    const original = state.connection.get().proxyUrl;

    // fetch is stubbed for the duration. Setting a proxy URL notifies the
    // connection store's subscribers, and anything that refreshes the header
    // then health-checks that address for real — a request to a Google
    // deployment that does not exist, waited out at full timeout, every time.
    const real = window.fetch;
    window.fetch = async () => new Response('{}', { status: 200 });
    try {
      const withoutProxy = ds.canDoMaintenance();
      // A same-origin URL that genuinely exists, not a script.google.com one.
      // `usingProxy()` only tests truthiness, and this test is about the gating,
      // not about talking to a deployment — so pointing at a real local file
      // makes an external request impossible. A fake Apps Script URL left the
      // header health-checking a host it could never reach, and the resulting
      // console error failed the run no matter how the fetch was stubbed: this
      // app is service-worker controlled, so the request passes out of reach of
      // an in-page stub and of page- and context-level routing alike.
      state.connection.set({ proxyUrl: `${location.origin}/manifest.json` });
      const withProxy = ds.canDoMaintenance();
      state.connection.set({ proxyUrl: original || '' });
      return { withoutProxy, withProxy, restored: ds.canDoMaintenance() };
    } finally {
      window.fetch = real;
    }
  });
  if (!result.withoutProxy) throw new Error('maintenance was refused without a proxy configured');
  if (result.withProxy) throw new Error('maintenance stayed available in proxy mode');
  if (!result.restored) throw new Error('the check did not restore the connection');
});

/**
 * The same gate, in the markup this time.
 *
 * The check above exercises `canDoMaintenance()` and nothing else, which is
 * exactly why this went unseen: the Danger zone card rendered unconditionally,
 * so in proxy mode "Delete all records" sat directly beneath a notice saying
 * wipe is unavailable on this device. Clicking it cost two confirmations and the
 * typed word DELETE before failing into an unhandled rejection that said
 * nothing — the worst answer a destructive button can give.
 */
await step('the destructive controls are absent from the page in proxy mode', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');

  const seen = await page.evaluate(async () => {
    const state = await import('/js/state.js');
    const { renderInstructor } = await import('/js/views/instructor.js');
    const root = document.querySelector('#view');
    const original = state.connection.get().proxyUrl;

    // The Database tab has no storage adapter in proxy mode, so it takes its
    // counts from the `overview` action rather than db.stats(). Answer that, or
    // the tab renders its error notice and the assertions below measure that
    // instead of the gating.
    const real = window.fetch;
    window.fetch = async (url, opts) => new Response(
      opts && opts.method === 'POST'
        ? JSON.stringify({
          ok: true,
          org: { orgName: 'Det 025' },
          stats: { requests: 0, openRequests: 0, responses: 0, students: 0, forms: 0 },
        })
        : JSON.stringify({ service: 'nine31-proxy', version: '1.1.0', configured: true }),
      { status: 200 });

    // The router hands views a URLSearchParams, not a plain object.
    const onDatabase = () => ({ query: new URLSearchParams('tab=database') });
    const read = () => ({
      text: root?.textContent || '',
      labels: [...root.querySelectorAll('button')].map((b) => b.textContent),
    });

    try {
      state.connection.set({ proxyUrl: '' });
      await renderInstructor(root, onDatabase());
      await new Promise((r) => setTimeout(r, 400));
      const direct = read();

      state.connection.set({
        proxyUrl: `${location.origin}/manifest.json`,
      });
      await renderInstructor(root, onDatabase());
      await new Promise((r) => setTimeout(r, 400));
      const proxied = read();

      return { direct, proxied };
    } finally {
      // Order matters, and so does the wait. Clearing the proxy first means the
      // header's next health check has nothing to reach; the pause then lets
      // anything the render already started land on the stub. Handing fetch back
      // too early lets one request through to script.google.com for real, and a
      // console error fails the whole suite.
      state.connection.set({ proxyUrl: original || '' });
      await new Promise((r) => setTimeout(r, 1200));
      window.fetch = real;
    }
  });

  const has = (snap, label) => snap.labels.some((l) => (l || '').includes(label));

  // Present without a proxy, or their absence below proves nothing.
  for (const label of ['Delete all records', 'Export backup', 'Import backup']) {
    if (!has(seen.direct, label)) throw new Error(`"${label}" is missing in direct mode`);
  }
  // Gone with one.
  for (const label of ['Delete all records', 'Export backup', 'Import backup']) {
    if (has(seen.proxied, label)) throw new Error(`"${label}" is still on the page in proxy mode`);
  }
  if (/Danger zone/.test(seen.proxied.text)) {
    throw new Error('the Danger zone card is still rendered in proxy mode');
  }
  if (!/Maintenance runs from the folder owner/.test(seen.proxied.text)) {
    throw new Error('no explanation replaced the controls');
  }
});

/* ---------- signing in while the proxy is on ---------- */

/**
 * The two checks above run with a session already established, which is exactly
 * how a total lockout shipped green: they prove proxy *reads* carry a token,
 * never that anyone can obtain one.
 *
 * `startSession` stores the ID token, and it runs only after the roster has
 * approved the sign-in — so the roster read at the top of `signInWithGoogle` had
 * nothing in sessionStorage to authenticate with, and every proxy-mode sign-in
 * failed with "your sign-in has expired" before it had begun. The token is now
 * passed in explicitly (see `resolveIdentity`), and these pin that.
 *
 * Both roles, because they resolve through different actions: `roster` is
 * instructor-and-above, a cadet falls back to `bundle`.
 */
const signInUnderProxy = (email, name, role, answer) => page.evaluate(async ([e, n, r, mode]) => {
  const state = await import('/js/state.js');
  const original = state.connection.get().proxyUrl;
  state.connection.set({
    proxyUrl: `${location.origin}/manifest.json`,
  });

  const a = await import('/js/auth.js');
  a.signOut();

  const bodies = [];
  const real = window.fetch;
  const reply = (payload) => new Response(JSON.stringify(payload), { status: 200 });
  // Answers as the deployed script does: a refusal is ok:false with a message,
  // not an HTTP error, so the fallback has to read the body to know what
  // happened.
  window.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (body.action === 'roster') {
      return mode === 'cadre'
        ? reply({ ok: true, users: [{
          id: 'usr_1', email: e, username: 'capt.reyes', name: n,
          roles: ['instructor', 'admin'], active: true,
        }] })
        : reply({ ok: false, error: 'That account is not allowed to do this.' });
    }
    if (body.action === 'bundle') {
      return reply({ ok: true, bundle: { requests: [], submitted: [], account: {
        id: 'usr_2', email: e, username: 'mia.alvarez', name: n,
        roles: ['student'], asClass: 'AS200', active: true,
      } } });
    }
    return reply({ ok: false, error: 'Unknown action.' });
  };

  try {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const account = await a.signInWithGoogle(
      { email: e, name: n, emailVerified: true, exp }, r, 'test-id-token');
    return { ok: true, username: account.username, roles: account.roles, bodies };
  } catch (err) {
    return { ok: false, error: err.message, bodies };
  } finally {
    window.fetch = real;
    state.connection.set({ proxyUrl: original || '' });
    a.signOut();
  }
}, [email, name, role, answer]);

await step('a cadre member can sign in while the proxy is configured', async () => {
  const result = await signInUnderProxy(ADMIN_EMAIL, 'Capt Reyes', 'instructor', 'cadre');
  if (!result.ok) throw new Error(`sign-in deadlocked in proxy mode: ${result.error}`);
  const roster = result.bodies.find((b) => b.action === 'roster');
  if (!roster) throw new Error('sign-in never asked the proxy who this was');
  if (!roster.idToken) throw new Error('the identity read went out with no token — the deadlock is back');
});

await step('a cadet signs in through the bundle when the roster refuses them', async () => {
  const result = await signInUnderProxy(STUDENT_EMAIL, 'Mia Alvarez', 'student', 'cadet');
  if (!result.ok) throw new Error(`cadet sign-in failed in proxy mode: ${result.error}`);
  if (!result.roles.includes('student')) throw new Error(`roles came back as ${result.roles}`);
  const actions = result.bodies.map((b) => b.action);
  if (!actions.includes('bundle')) throw new Error(`never fell back to bundle — saw ${actions.join(', ')}`);
  if (!result.bodies.every((b) => b.idToken)) throw new Error('an identity read went out with no token');
});

/**
 * A sleeping Apps Script deployment should cost a pause, not a sign-in.
 *
 * Reads are idempotent, so one retry is safe. The transport is deliberately not
 * the place for it: `submitViaProxy` shares `postJson`, and retrying a
 * submission whose first attempt succeeded but whose answer was lost would be
 * refused as a duplicate — telling a cadet their feedback failed when it is
 * already filed.
 */
await step('a first call that times out is retried once, and says so', async () => {
  const result = await page.evaluate(async () => {
    const state = await import('/js/state.js');
    const original = state.connection.get().proxyUrl;
    state.connection.set({
      proxyUrl: `${location.origin}/manifest.json`,
    });
    const a = await import('/js/auth.js');
    a.signOut();

    let calls = 0;
    const real = window.fetch;
    window.fetch = async (url, opts) => {
      calls++;
      // The cold start: the first request never answers. An AbortError is what
      // the timeout produces, and what marks a failure worth repeating.
      if (calls === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const body = JSON.parse(opts.body);
      if (body.action !== 'roster') {
        return new Response(JSON.stringify({ ok: false, error: 'Unknown action.' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, users: [{
        id: 'usr_1', email: 'capt.reyes@det025.edu', username: 'capt.reyes',
        name: 'Capt Reyes', roles: ['instructor', 'admin'], active: true,
      }] }), { status: 200 });
    };

    let slow = 0;
    try {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const account = await a.signInWithGoogle(
        { email: 'capt.reyes@det025.edu', name: 'Capt Reyes', emailVerified: true, exp },
        'instructor', 'test-id-token', { onSlow: () => { slow++; } });
      return { ok: true, username: account.username, calls, slow };
    } catch (err) {
      return { ok: false, error: err.message, calls, slow };
    } finally {
      window.fetch = real;
      state.connection.set({ proxyUrl: original || '' });
      a.signOut();
    }
  });

  if (!result.ok) throw new Error(`a cold start failed the sign-in: ${result.error}`);
  if (result.calls !== 2) throw new Error(`expected exactly one retry, saw ${result.calls} calls`);
  if (result.slow !== 1) throw new Error('the screen was never told the server was waking');
});

/**
 * The screen has to say something while the proxy wakes.
 *
 * For ten seconds it said nothing at all — `accept` hid the error box and
 * awaited — and that silence is what makes someone press the button again, which
 * starts a second request rather than hurrying the first.
 */
await step('a slow sign-in shows elapsed time rather than a dead screen', async () => {
  // Driven through the email sign-in, which reaches the same indicator as the
  // Google button. Google will not issue a credential to a headless browser, so
  // its callback is unreachable here — and both paths run the same roster read,
  // which is why they share the indicator rather than only one having it.
  const result = await page.evaluate(async () => {
    const { renderLogin } = await import('/js/views/sign-in.js');
    const a = await import('/js/auth.js');
    const root = document.querySelector('#view');
    const flag = localStorage.getItem('nine31.directsignin.v1');

    // Hold the roster read open so the wait is observable.
    const ds = await import('/js/data-source.js');
    const realLoad = ds.loadRoster;
    let release;
    const held = new Promise((r) => { release = r; });

    try {
      localStorage.setItem('nine31.directsignin.v1', '1');
      a.signOut();
      await renderLogin(root, 'instructor', 'Instructor Panel', () => {});

      const input = root.querySelector('input[type=email]');
      const button = [...root.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes('Sign in without Google'));
      if (!input || !button) return { error: 'the email sign-in box did not render' };

      // Make the roster read slow by stalling the adapter underneath it.
      const m = await import('/js/storage/index.js');
      const realGetUsers = m.db.getUsers.bind(m.db);
      m.db.getUsers = async () => { await held; return realGetUsers(); };

      input.value = 'capt.reyes@det025.edu';
      button.click();

      await new Promise((r) => setTimeout(r, 2400));
      const during = root.textContent || '';

      release();
      await new Promise((r) => setTimeout(r, 600));
      m.db.getUsers = realGetUsers;
      return { during, after: root.textContent || '' };
    } finally {
      if (flag) localStorage.setItem('nine31.directsignin.v1', flag);
      else localStorage.removeItem('nine31.directsignin.v1');
      a.signOut();
    }
  });

  if (result.error) throw new Error(result.error);
  if (!/Signing in|Waking your detachment/.test(result.during)) {
    throw new Error(`nothing was shown while it waited: ${result.during.slice(0, 200)}`);
  }
  // Elapsed seconds, not a fabricated percentage — an HTTP request to a black box
  // has no progress to report.
  if (!/\(\d+s\)/.test(result.during)) {
    throw new Error(`no elapsed time shown: ${result.during.slice(0, 200)}`);
  }
  if (/%/.test(result.during)) throw new Error('a percentage was shown for an unmeasurable wait');
  // And it clears, or the screen claims to still be signing in afterwards.
  if (/Signing in|Waking your detachment/.test(result.after)) {
    throw new Error('the indicator was left on screen after the sign-in finished');
  }
});

await step('a refusal is not retried — it is a real answer', async () => {
  const result = await page.evaluate(async () => {
    const state = await import('/js/state.js');
    const original = state.connection.get().proxyUrl;
    state.connection.set({
      proxyUrl: `${location.origin}/manifest.json`,
    });
    const a = await import('/js/auth.js');
    a.signOut();

    let calls = 0;
    const real = window.fetch;
    window.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({
        ok: false, error: 'nobody@example.com is not on this detachment\'s roster.',
      }), { status: 200 });
    };
    try {
      await a.signInWithGoogle(
        { email: 'nobody@example.com', emailVerified: true }, 'instructor', 'test-id-token');
      return { threw: false, calls };
    } catch (err) {
      return { threw: true, calls, message: err.message };
    } finally {
      window.fetch = real;
      state.connection.set({ proxyUrl: original || '' });
      a.signOut();
    }
  });

  if (!result.threw) throw new Error('a roster refusal let somebody in');
  // One call, not two: repeating a refusal only makes the same no arrive later.
  if (result.calls !== 1) throw new Error(`a refusal was retried: ${result.calls} calls`);
});

// The steps below expect a signed-in administrator; the two above deliberately
// end signed out.
await signInAs(ADMIN_EMAIL, 'Capt Reyes');

/* ---------- the commander's by-instructor review ---------- */

await step('the By instructor tab is offered to every panel role', async () => {
  // It was commander-only. Reviewing the instructors under you is an oversight
  // function and cadre have one, so the tab is open to all three and what it
  // *contains* is narrowed by tier instead — which is asserted against the
  // proxy payload in tests/proxy/behaviour.test.mjs, not from the pixels here.
  await signInAs(ADMIN_EMAIL, 'Capt Reyes', 'instructor');

  for (const roles of [['instructor'], ['cadre'], ['commander']]) {
    await page.evaluate((next) => {
      const s = JSON.parse(sessionStorage.getItem('nine31.session.v1'));
      s.roles = next;
      sessionStorage.setItem('nine31.session.v1', JSON.stringify(s));
    }, roles);
    await page.goto(`${BASE}#/instructor`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[role=tablist]', { timeout: 12000 });
    const tabs = await page.$$eval('[role=tab]', (n) => n.map((t) => t.textContent));
    if (!tabs.some((t) => /By instructor/.test(t))) {
      throw new Error(`${roles.join('+')} was not offered the tab`);
    }
  }
});

await step('an instructor opening the tab is told it is only their own', async () => {
  // The tab no longer refuses anyone, so the guard that matters moved: the
  // server narrows what comes back, and the screen has to say so rather than
  // presenting one row as though it were the detachment's whole picture.
  await signInAs(ADMIN_EMAIL, 'Capt Reyes', 'instructor');
  await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('nine31.session.v1'));
    s.roles = ['instructor'];
    sessionStorage.setItem('nine31.session.v1', JSON.stringify(s));
  });
  await page.goto(`${BASE}#/instructor?tab=people`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  const text = await page.textContent('#view');
  if (!/grouped by the person/.test(text)) {
    throw new Error('an instructor could not open their own By-instructor view');
  }
  if (!/Your own results/.test(text)) {
    throw new Error('the view did not say whose results these are');
  }
});

await step('by-instructor covers cadre and commanders, not only instructors', async () => {
  // The view is called "By instructor" but its subject is anyone feedback can
  // be about. A detachment reviewing only the instructors would miss exactly
  // the people a commander most needs a picture of.
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const a = await import('/js/auth.js');
    for (const [email, name, roles] of [
      ['cadre.subject@det025.edu', 'Subject, Cadre', ['cadre']],
      ['cmdr.subject@det025.edu', 'Subject, Commander', ['commander']],
      ['admin.subject@det025.edu', 'Subject, Admin', ['admin']],
      ['cadet.subject@gmail.com', 'Subject, Cadet', ['student']],
    ]) {
      try { await a.createAccount({ email, name, roles, asClass: 'AS200' }); }
      catch { /* already there */ }
    }

    await m.db.saveForm({ id: 'form_sub', name: 'S', sections: [
      { title: 'S', items: [{ id: 'q1', type: 'scale', label: 'Rate it', min: 1, max: 9 }] },
    ] });
    // Enough responses about the cadre member to clear the disclosure
    // threshold, so a real average appears rather than "Withheld".
    await m.db.saveRequest({
      id: 'req_sub_cadre', formId: 'form_sub', title: 'About the cadre member',
      status: 'open', asClass: 'AS200', anonymous: true, space: 'shared',
      subject: 'subject.cadre', createdBy: 'subject.cadre',
    });
    for (const v of [8, 7, 9, 8]) {
      await m.db.saveResponse({
        requestId: 'req_sub_cadre', formId: 'form_sub', anonymous: true, answers: { q1: v },
      });
    }

    const s = JSON.parse(sessionStorage.getItem('nine31.session.v1'));
    s.roles = ['commander'];
    sessionStorage.setItem('nine31.session.v1', JSON.stringify(s));
  });

  await page.goto(`${BASE}#/instructor?tab=people`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('table.table', { timeout: 15000 });

  // Cell by cell: the row's textContent concatenates them, so "1 request, 4
  // responses" reads as "14" and any digit assertion on it is a coin toss.
  const rows = await page.$$eval('tbody tr', (trs) => trs.map((t) => ({
    text: t.textContent,
    cells: [...t.querySelectorAll('td')].map((c) => c.textContent.trim()),
  })));
  const find = (who) => rows.find((r) => r.text.includes(who));

  // Every non-student role is a possible subject and is listed, with or
  // without feedback — "nobody has asked about this person" is worth knowing.
  for (const who of ['Subject, Cadre', 'Subject, Commander', 'Subject, Admin']) {
    if (!find(who)) throw new Error(`${who} is missing from the by-instructor list`);
  }
  // Cadets are not subjects of instructional feedback and must not appear.
  if (find('Subject, Cadet')) throw new Error('a cadet was listed as a subject of feedback');

  const cadre = find('Subject, Cadre');
  if (!/Cadre/.test(cadre.text)) throw new Error(`the role is not shown: ${cadre.text}`);
  if (/Withheld/.test(cadre.text)) throw new Error('four responses were withheld');
  // Columns are: person, requests, responses, average.
  if (cadre.cells[2] !== '4') {
    throw new Error(`responses column reads "${cadre.cells[2]}", expected 4`);
  }
});

await step('a person under the threshold is withheld, counting their total', async () => {
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const a = await import('/js/auth.js');
    try {
      await a.createAccount({ email: 'quiet@det025.edu', name: 'Quiet, Instructor',
        roles: ['instructor'] });
    } catch { /* already there */ }

    await m.db.saveForm({ id: 'form_quiet', name: 'Q', sections: [
      { title: 'Q', items: [{ id: 'q1', type: 'scale', label: 'Rate it', min: 1, max: 9 }] },
    ] });
    // Two responses, spread across two separate forms — the case a per-form
    // threshold alone would let through.
    for (const n of [1, 2]) {
      await m.db.saveRequest({
        id: `req_quiet_${n}`, formId: 'form_quiet', title: `Quiet ${n}`,
        status: 'open', asClass: 'AS200', anonymous: true, space: 'shared',
        subject: 'quiet.instructor', createdBy: 'quiet.instructor',
      });
      await m.db.saveResponse({
        requestId: `req_quiet_${n}`, formId: 'form_quiet', anonymous: true,
        answers: { q1: 8 },
      });
    }
    const s = JSON.parse(sessionStorage.getItem('nine31.session.v1'));
    s.roles = ['commander'];
    sessionStorage.setItem('nine31.session.v1', JSON.stringify(s));
  });

  await page.goto(`${BASE}#/instructor?tab=people`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('table.table', { timeout: 15000 });

  const row = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('tbody tr')]
      .find((r) => /Quiet/.test(r.textContent));
    return tr ? tr.textContent : null;
  });
  if (!row) throw new Error('the instructor is not listed');
  if (!/Withheld/.test(row)) throw new Error(`two responses were summarised: ${row}`);
});

await step('opening a withheld person shows no average and no answers', async () => {
  await page.evaluate(() => {
    const tr = [...document.querySelectorAll('tbody tr')].find((r) => /Quiet/.test(r.textContent));
    tr.click();
  });
  await page.waitForTimeout(700);

  // Scoped to the detail panel, not the whole page. Reading `#view` and
  // splitting on the first "Withheld" passed for years because nothing else on
  // screen happened to contain a rating word — until another person on the
  // table below had a real average, and then it failed without anything being
  // wrong. A test that depends on unrelated rows is not testing this.
  const panel = await page.evaluate(() => {
    const section = [...document.querySelectorAll('#view section.card')]
      .find((el) => /fewer than \d+ responses/i.test(el.textContent));
    return section ? section.textContent : null;
  });
  if (!panel) throw new Error('no withholding notice shown');
  if (/Outstanding|Favorable|Major\b|Slight\b|Neutral\b/.test(panel)) {
    throw new Error(`a rating word leaked into the withheld view: ${panel.slice(0, 160)}`);
  }
  // The written answers are the other half of what must not appear.
  if (/answers?\b/i.test(panel) && /"/.test(panel)) {
    throw new Error('a written answer leaked into the withheld view');
  }
});

await step('a person over the threshold is summarised', async () => {
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    for (let i = 0; i < 4; i++) {
      await m.db.saveResponse({
        requestId: 'req_quiet_1', formId: 'form_quiet', anonymous: true,
        answers: { q1: 7 + (i % 2) },
      });
    }
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('table.table', { timeout: 15000 });
  const row = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('tbody tr')].find((r) => /Quiet/.test(r.textContent));
    return tr ? tr.textContent : null;
  });
  if (/Withheld/.test(row)) throw new Error('six responses were still withheld');
  if (!/Favorable|Major|Outstanding/.test(row)) throw new Error(`no rating word shown: ${row}`);
});

await step('the by-instructor fixtures are removed again', async () => {
  // Left in place they would show as legitimately withheld on the analysis
  // screen, and a later test asserts no withheld notice appears there at all.
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    for (const id of ['req_quiet_1', 'req_quiet_2']) await m.db.deleteRequest(id);
    await m.db.deleteForm('form_quiet');
  });
  const left = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    return (await m.db.listRequests()).filter((r) => r.id.startsWith('req_quiet')).length;
  });
  if (left) throw new Error(`${left} fixture requests survived`);
});

/* ---------- anonymised export ---------- */

await step('an anonymised export carries no name, address or username', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  const dump = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const { buildAnonymisedExport } = await import('/js/export-anon.js');

    // An attributed response, so there is a respondent to strip.
    await m.db.saveRequest({
      id: 'req_anon_test', formId: 'form_anon', title: 'Named feedback',
      status: 'open', asClass: 'AS200', anonymous: false, space: 'shared',
    });
    await m.db.saveForm({ id: 'form_anon', name: 'F', sections: [] });
    await m.db.saveResponse({
      requestId: 'req_anon_test', formId: 'form_anon', anonymous: false,
      respondent: { username: 'alvarez.mia', name: 'Alvarez, Mia', asClass: 'AS200' },
      answers: { q1: 7, q2: 'the drill practice was well run' },
    });
    await m.db.addReceipt('req_anon_test', 'alvarez.mia');

    return JSON.stringify(await buildAnonymisedExport());
  });

  for (const secret of ['alvarez.mia', 'Alvarez', 'Mia', ADMIN_EMAIL, 'respondent"']) {
    if (dump.includes(secret)) throw new Error(`"${secret}" survived the anonymised export`);
  }
  if (!dump.includes('drill practice was well run')) {
    throw new Error('the feedback text was lost, which defeats the purpose');
  }
});

await step('the export keeps how many answered, without saying who', async () => {
  const parsed = await page.evaluate(async () => {
    const { buildAnonymisedExport } = await import('/js/export-anon.js');
    return buildAnonymisedExport();
  });
  const request = parsed.requests.find((r) => r.id === 'req_anon_test');
  if (!request) throw new Error('the request is missing from the export');
  if (request.respondents !== 1) throw new Error(`respondents recorded as ${request.respondents}`);
  // The word appears in the metadata describing what was stripped; what must
  // not appear is a receipt *record*.
  if (Array.isArray(parsed.receipts) || (parsed.receipts && typeof parsed.receipts === 'object')) {
    throw new Error('receipt records were exported');
  }
  if (/"username"\s*:\s*"/.test(JSON.stringify(parsed))) {
    throw new Error('a username survived the export');
  }
});

await step('timestamps are reduced to the month, so nothing correlates', async () => {
  // A receipt written seconds before a response identifies its author by
  // elimination, and that survives having the names removed.
  const parsed = await page.evaluate(async () => {
    const { buildAnonymisedExport } = await import('/js/export-anon.js');
    return buildAnonymisedExport();
  });
  const full = JSON.stringify(parsed);
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(full)) {
    throw new Error('a full timestamp survived the export');
  }
  const response = parsed.responses.find((r) => r.requestId === 'req_anon_test');
  if (!/^\d{4}-\d{2}$/.test(response.submittedMonth || '')) {
    throw new Error(`submittedMonth is ${response.submittedMonth}`);
  }
  if (response.id) throw new Error('the response id was exported — it encodes creation time');
});

await step('flagged responses are excluded unless explicitly included', async () => {
  const counts = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const { buildAnonymisedExport } = await import('/js/export-anon.js');
    await m.db.saveResponse({
      requestId: 'req_anon_test', formId: 'form_anon', anonymous: true,
      answers: { q2: 'the flight commander hazed us repeatedly after the lab' },
    });
    const without = await buildAnonymisedExport();
    const withThem = await buildAnonymisedExport({ includeFlagged: true });
    return {
      excludedCount: without.excludedFlaggedCount,
      withoutHasIt: JSON.stringify(without).includes('hazed us repeatedly'),
      withHasIt: JSON.stringify(withThem).includes('hazed us repeatedly'),
      label: without.anonymised.flaggedResponses,
    };
  });
  if (counts.withoutHasIt) throw new Error('a flagged disclosure was exported by default');
  if (!counts.withHasIt) throw new Error('opting in did not include it');
  if (counts.excludedCount < 1) throw new Error('the exclusion was not counted');
  if (!/excluded/i.test(counts.label)) throw new Error('the file does not record the choice');
});

await step('the export says plainly what it is', async () => {
  const parsed = await page.evaluate(async () => {
    const { buildAnonymisedExport } = await import('/js/export-anon.js');
    return buildAnonymisedExport();
  });
  if (parsed.format !== 'nine31-anonymised') throw new Error('no format marker');
  if (!/identify people/i.test(parsed.notice || '')) {
    throw new Error('the file does not warn that free text can still identify people');
  }
  if (!parsed.anonymised?.roster) throw new Error('the file does not record what was stripped');
});

/* ---------- disclosure threshold ---------- */

await step('a lone anonymous response is withheld from analysis', async () => {
  // Fresh admin session, then a form with exactly one response.
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.stack-lg', { timeout: 12000 });

  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const c = await import('/js/config.js');
    const anchors = { ...c.SCALE_ANCHORS };
    const form = await m.db.saveForm({
      id: 'form_thin', name: 'Thin Flight Feedback',
      sections: [{ title: 'Thin', items: [
        { id: 'tq1', type: 'scale', label: 'Secret rating', required: true, min: 1, max: 9, anchors },
        { id: 'tq2', type: 'text', label: 'Secret comment', required: false, rows: 3, wordLimit: 250 },
      ] }],
    });
    await m.db.saveRequest({
      id: 'req_thin', feedbackId: 'FB-2026-9001', title: 'Thin Flight Feedback',
      formId: form.id, asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      anonymous: true, status: 'open', assignedUsernames: [],
    });
    await m.db.saveResponse({
      requestId: 'req_thin', formId: form.id, anonymous: true,
      asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      answers: { tq1: 1, tq2: 'CANARY-SECRET-COMMENT' },
    });
    await m.db.addReceipt('req_thin', 'alvarez.mia');
  });

  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.stack-lg', { timeout: 12000 });
  await page.waitForTimeout(1200);

  const text = await page.textContent('#view');
  if (text.includes('CANARY-SECRET-COMMENT')) throw new Error('WITHHELD COMMENT WAS DISPLAYED');
  if (!/Results withheld/.test(text)) throw new Error('no withheld notice shown');
  if (!/2 more/.test(text)) throw new Error('does not say how many more are needed');
  // The counts must remain, so cadre can still chase people.
  if (!/Completion/.test(text)) throw new Error('completion panel disappeared');
});

await step('the withheld form is excluded from the statistics', async () => {
  // "Secret rating" is a 1; if it leaked into the pooled stats it would appear
  // as a rated question row.
  const questions = await page.$$eval('table.table tbody tr td:first-child',
    (n) => n.map((x) => x.textContent.trim()));
  if (questions.includes('Secret rating')) throw new Error('withheld question appears in the stats table');
});

await step('CSV export cannot be used to bypass the threshold', async () => {
  const csv = await page.evaluate(async () => {
    // Intercept the download rather than writing a file.
    const rows = [];
    const realCreate = URL.createObjectURL;
    let captured = '';
    URL.createObjectURL = (blob) => { rows.push(blob); return realCreate.call(URL, blob); };
    const btns = [...document.querySelectorAll('button')];
    const exportBtn = btns.find((b) => /Export CSV/.test(b.textContent));
    exportBtn.click();
    await new Promise((r) => setTimeout(r, 600));
    URL.createObjectURL = realCreate;
    for (const blob of rows) captured += await blob.text();
    return captured;
  });
  // An export that produced nothing at all would also not contain the canary, so
  // the absence check is only meaningful once there is a file to check.
  if (!csv.length) throw new Error('the export produced no file, so nothing was tested');
  if (csv.includes('CANARY-SECRET-COMMENT')) throw new Error('WITHHELD DATA LEAKED VIA CSV EXPORT');
});

await step('results are released once the threshold is met', async () => {
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    for (const [user, rating] of [['brooks.dan', 5], ['chen.li', 9]]) {
      await m.db.saveResponse({
        requestId: 'req_thin', formId: 'form_thin', anonymous: true,
        asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
        answers: { tq1: rating, tq2: `comment from ${user}` },
      });
      await m.db.addReceipt('req_thin', user);
    }
  });
  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.stack-lg', { timeout: 12000 });
  await page.waitForTimeout(1200);

  const text = await page.textContent('#view');
  if (!text.includes('CANARY-SECRET-COMMENT')) throw new Error('results still withheld at 3 responses');
  if (/Results withheld/.test(text)) throw new Error('still showing the withheld notice');
});

await step('attributed feedback is never withheld', async () => {
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const form = await m.db.saveForm({
      id: 'form_named', name: 'Named Feedback',
      sections: [{ title: 'Named', items: [
        { id: 'nq1', type: 'text', label: 'Comment', required: false, rows: 3, wordLimit: 250 },
      ] }],
    });
    await m.db.saveRequest({
      id: 'req_named', feedbackId: 'FB-2026-9002', title: 'Named Feedback',
      formId: form.id, asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      anonymous: false, status: 'open', assignedUsernames: [],
    });
    await m.db.saveResponse({
      requestId: 'req_named', formId: form.id, anonymous: false,
      respondent: { username: 'alvarez.mia', name: 'Alvarez, Mia' },
      asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      answers: { nq1: 'NAMED-SINGLE-RESPONSE' },
    });
  });
  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.stack-lg', { timeout: 12000 });
  await page.waitForTimeout(1200);
  const text = await page.textContent('#view');
  if (!text.includes('NAMED-SINGLE-RESPONSE')) {
    throw new Error('attributed feedback was withheld — it should not be');
  }
});


/* ---------- concurrency ---------- */

await step('simultaneous submissions never lose a response or a receipt', async () => {
  const result = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const c = await import('/js/config.js');
    const anchors = { ...c.SCALE_ANCHORS };
    const form = await m.db.saveForm({
      id: 'form_race', name: 'Race Test',
      sections: [{ title: 'Race', items: [
        { id: 'rq1', type: 'scale', label: 'Rating', required: true, min: 1, max: 9, anchors },
      ] }],
    });
    await m.db.saveRequest({
      id: 'req_race', feedbackId: 'FB-2026-9500', title: 'Race Test', formId: form.id,
      asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      anonymous: true, status: 'open', assignedUsernames: [],
    });

    // Twelve cadets hitting Submit at the same moment — the end-of-class case.
    const users = Array.from({ length: 12 }, (_, i) => `racer${String(i).padStart(2, '0')}`);
    await Promise.all(users.map(async (u, i) => {
      await m.db.saveResponse({
        requestId: 'req_race', formId: form.id, anonymous: true,
        asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
        answers: { rq1: (i % 9) + 1 },
      });
      await m.db.addReceipt('req_race', u);
    }));

    const responses = await m.db.listResponses('req_race');
    const receipts = await m.db.listReceipts('req_race');
    const missing = users.filter((u) => !receipts.some((r) => r.username === u));
    return { responses: responses.length, receipts: receipts.length, missing };
  });

  if (result.responses !== 12) throw new Error(`${result.responses}/12 responses survived`);
  if (result.receipts !== 12) throw new Error(`${result.receipts}/12 receipts survived — missing ${result.missing.join(', ')}`);
  console.log(`       12 concurrent submissions -> ${result.responses} responses, ${result.receipts} receipts`);
});

await step('a submission writes only paths nobody else touches', async () => {
  const paths = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const adapter = m.db.adapter;
    const written = [];
    const real = adapter.writeDoc.bind(adapter);
    adapter.writeDoc = (p, d) => { written.push(p); return real(p, d); };
    await m.db.saveResponse({
      requestId: 'req_race', formId: 'form_race', anonymous: true, answers: { rq1: 5 },
    });
    await m.db.addReceipt('req_race', 'racer99');
    adapter.writeDoc = real;
    return written;
  });
  // Both paths must be unique to this student. A shared document would be a
  // path with no id or username in it.
  const shared = paths.filter((p) => p.endsWith('_index.json') || p.endsWith('_counts.json'));
  if (shared.length) throw new Error(`submission wrote shared documents: ${shared.join(', ')}`);
  console.log(`       submission wrote: ${paths.join(', ')}`);
});

await step('a stale index self-heals on read', async () => {
  const result = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const c = await import('/js/config.js');
    // Corrupt the index to look like it predates several submissions.
    await m.db.writeRaw(c.INDEXES.responsesFor('req_race'), {
      requestId: 'req_race', count: 1, responses: [], updatedAt: new Date().toISOString(),
    });
    const rows = await m.db.listResponses('req_race');
    const index = await m.db.readRaw(c.INDEXES.responsesFor('req_race'));
    return { rows: rows.length, indexRows: index.responses.length };
  });
  if (result.rows !== 13) throw new Error(`read returned ${result.rows}, expected 13`);
  if (result.indexRows !== 13) throw new Error('the index was not repaired on disk');
  console.log('       stale index detected and rebuilt from the response files');
});

await step('two admins editing different students both succeed', async () => {
  const result = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    await a.createAccount({ email: 'race.one@det025.edu', name: 'Race One', roles: ['student'] });
    await a.createAccount({ email: 'race.two@det025.edu', name: 'Race Two', roles: ['student'] });
    const before = (await a.listAccounts()).length;

    // Both admins read, then both write — the classic lost-update setup.
    const one = await a.findByEmail('race.one@det025.edu');
    const two = await a.findByEmail('race.two@det025.edu');
    await Promise.all([
      a.updateAccount(one.id, { section: 'Alpha' }),
      a.updateAccount(two.id, { section: 'Bravo' }),
    ]);

    const after = await a.listAccounts();
    return {
      before,
      after: after.length,
      one: after.find((u) => u.username === 'race.one')?.section,
      two: after.find((u) => u.username === 'race.two')?.section,
    };
  });
  if (result.after !== result.before) throw new Error(`account count changed ${result.before} -> ${result.after}`);
  if (result.one !== 'Alpha' || result.two !== 'Bravo') {
    throw new Error(`lost update: one=${result.one} two=${result.two}`);
  }
  console.log('       concurrent account edits both retained');
});

await step('editing a form someone else changed raises a conflict', async () => {
  const result = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const req = await m.db.getRequest('req_race');
    const staleRev = Number(req.rev) || 0;

    // Another instructor saves first.
    await m.db.saveRequest({ ...req, title: 'Changed by someone else' }, { expectRev: staleRev });

    // We then save from the revision we loaded before their change.
    try {
      await m.db.saveRequest({ ...req, title: 'My version' }, { expectRev: staleRev });
      return { threw: false };
    } catch (err) {
      return { threw: true, conflict: Boolean(err.conflict), theirs: err.theirs?.title };
    }
  });
  if (!result.threw) throw new Error('the stale save was allowed through');
  if (!result.conflict) throw new Error('error was not flagged as a conflict');
  if (result.theirs !== 'Changed by someone else') throw new Error(`theirs was "${result.theirs}"`);
  console.log('       conflict raised, with the other version attached');
});

/**
 * The same check, one layer up — where the views actually live.
 *
 * The two steps above call `db` directly, and that is exactly why they stayed
 * green through a total failure of this feature: `data-source.saveForm` and
 * `saveRequest` took one parameter and forwarded one, so the `{ expectRev }` the
 * form creator passed was silently dropped and every save was unconditional. The
 * conflict modal in formCreator.js could not be reached, and two cadre editing
 * one form was a last-write-wins overwrite with nothing said.
 *
 * Testing the storage facade proves the mechanism exists. Testing the routing
 * layer proves anything uses it.
 */
await step('the layer the views call passes expectRev through to storage', async () => {
  const result = await page.evaluate(async () => {
    const ds = await import('/js/data-source.js');
    const m = await import('/js/storage/index.js');
    const req = await m.db.getRequest('req_race');
    const staleRev = Number(req.rev) || 0;

    await ds.saveRequest({ ...req, title: 'Saved by someone else' }, { expectRev: staleRev });
    try {
      await ds.saveRequest({ ...req, title: 'Mine, from a stale copy' }, { expectRev: staleRev });
      return { threw: false };
    } catch (err) {
      return { threw: true, conflict: Boolean(err.conflict), theirs: err.theirs?.title };
    }
  });
  if (!result.threw) throw new Error('a stale save through data-source was allowed through');
  if (!result.conflict) throw new Error('the error carried no conflict flag, so the modal stays unreachable');
  if (result.theirs !== 'Saved by someone else') throw new Error(`theirs was "${result.theirs}"`);
});

await step('a save through data-source returns the new revision', async () => {
  // Without this the editor cannot track its own rev, so the *second* save in a
  // session conflicts with the first — the feature would fail closed instead of
  // open, which is quieter but no more correct.
  const revs = await page.evaluate(async () => {
    const ds = await import('/js/data-source.js');
    const m = await import('/js/storage/index.js');
    const fresh = await m.db.getRequest('req_race');
    const before = Number(fresh.rev) || 0;
    const saved = await ds.saveRequest({ ...fresh, title: 'Rev check' }, { expectRev: before });
    return { before, returned: Number(saved?.rev) };
  });
  if (!Number.isFinite(revs.returned)) throw new Error('no revision came back from the save');
  if (revs.returned !== revs.before + 1) {
    throw new Error(`rev went ${revs.before} -> ${revs.returned}, expected ${revs.before + 1}`);
  }
});

await step('a deliberate overwrite still works after re-reading', async () => {
  const title = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const fresh = await m.db.getRequest('req_race');
    await m.db.saveRequest({ ...fresh, title: 'Overwritten on purpose' },
      { expectRev: Number(fresh.rev) || 0 });
    return (await m.db.getRequest('req_race')).title;
  });
  if (title !== 'Overwritten on purpose') throw new Error(`title is "${title}"`);
});

/* ---------- backup and restore ---------- */

/**
 * The disaster-recovery path, which had no test at all.
 *
 * It is also the path the demo data arrives by, and `mode: 'replace'` wipes
 * before it writes — so a fault here does not degrade a detachment's records, it
 * loses them. Worth more than the zero coverage it had.
 *
 * Deliberately self-contained: export, wipe, restore, assert, all inside one
 * step. This suite is sequential and shares one folder, so a step that left the
 * collections empty would break everything after it.
 */
await step('a backup round-trips: export, wipe, restore', async () => {
  const result = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const count = async () => ({
      forms: (await m.db.listForms()).length,
      requests: (await m.db.listRequests()).length,
      responses: (await m.db.listAllResponses()).length,
      users: ((await m.db.getUsers()).users || []).length,
    });

    const before = await count();
    const bundle = await m.db.exportBundle();
    await m.db.wipeData();
    const wiped = await count();
    const counts = await m.db.importBundle(bundle, { mode: 'replace' });
    const after = await count();
    return { before, wiped, after, counts, format: bundle.format, schema: bundle.schemaVersion };
  });

  if (result.format !== 'nine31-bundle') throw new Error(`format was ${result.format}`);
  if (result.schema !== 4) throw new Error(`schemaVersion was ${result.schema}`);

  // The wipe has to actually empty things, or the restore proves nothing.
  if (result.wiped.requests !== 0 || result.wiped.forms !== 0) {
    throw new Error(`wipe left ${result.wiped.requests} requests and ${result.wiped.forms} forms`);
  }
  // And it must not touch the account directory. This is load-bearing: it is why
  // a replace import cannot lock the owner out of their own detachment.
  if (result.wiped.users !== result.before.users) {
    throw new Error(`wipeData changed the roster: ${result.before.users} -> ${result.wiped.users}`);
  }

  for (const key of ['forms', 'requests', 'responses', 'users']) {
    if (result.after[key] !== result.before[key]) {
      throw new Error(`${key} did not come back: ${result.before[key]} -> ${result.after[key]}`);
    }
  }
  // The counts the UI reports come from the bundle, so they must match what was
  // actually written rather than being reported optimistically.
  if (result.counts.requests !== result.before.requests) {
    throw new Error(`reported ${result.counts.requests} requests, restored ${result.after.requests}`);
  }
  console.log(`       ${result.before.requests} requests, ${result.before.responses} responses, `
    + `${result.before.users} accounts — out and back`);
});

await step('a file that is not a backup is refused before anything is wiped', async () => {
  // The order matters more than the message: validation precedes the wipe, so
  // pointing Replace at the wrong JSON file cannot cost a detachment its records.
  const result = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const before = (await m.db.listRequests()).length;
    let message = 'NO ERROR';
    try {
      await m.db.importBundle({ format: 'something-else', requests: [] }, { mode: 'replace' });
    } catch (err) { message = err.message; }
    return { message, before, after: (await m.db.listRequests()).length };
  });
  if (!/not a 9ThirtyOne backup/i.test(result.message)) {
    throw new Error(`unexpected message: ${result.message}`);
  }
  if (result.after !== result.before) {
    throw new Error(`a rejected import still wiped: ${result.before} -> ${result.after}`);
  }
});

await step('a pre-rename backup still restores', async () => {
  // Someone who took a backup before the app was renamed is not going to take it
  // again. Refusing their only copy over a string would be indefensible.
  const ok = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const counts = await m.db.importBundle({
      format: 'top-feedback-bundle',
      schemaVersion: 4,
      forms: [{ id: 'form_oldfmt', name: 'From an old backup', sections: [] }],
    }, { mode: 'merge' });
    const form = await m.db.getForm('form_oldfmt');
    return { counts, restored: form?.name || null };
  });
  if (ok.restored !== 'From an old backup') throw new Error(`form did not restore: ${ok.restored}`);
  if (ok.counts.forms !== 1) throw new Error(`counted ${ok.counts.forms} forms`);
});

await step('legacy receipt arrays migrate to per-student files', async () => {
  const result = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const c = await import('/js/config.js');
    await m.db.saveRequest({
      id: 'req_legacy_rcpt', feedbackId: 'FB-2026-9600', title: 'Legacy Receipts',
      formId: 'form_race', asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      anonymous: true, status: 'closed', assignedUsernames: [],
    });
    // Write the v2 shape directly.
    await m.db.writeRaw(c.INDEXES.legacyReceiptsFor('req_legacy_rcpt'), {
      requestId: 'req_legacy_rcpt',
      receipts: [
        { username: 'old.one', submittedAt: '2026-01-05T10:00:00.000Z' },
        { username: 'old.two', submittedAt: '2026-01-05T10:01:00.000Z' },
      ],
    });
    // Un-migrated folders must still block a double submission.
    const beforeMigration = await m.db.hasSubmitted('req_legacy_rcpt', 'old.one');

    await m.db.saveOrg({ schemaVersion: 2 });
    const ran = await m.db.migrate();

    const perFile = await m.db.readRaw(c.INDEXES.receiptFor('req_legacy_rcpt', 'old.one'));
    const listed = await m.db.listReceipts('req_legacy_rcpt');
    return {
      beforeMigration,
      ran: ran.ran,
      perFileExists: Boolean(perFile),
      listed: listed.map((r) => r.username).sort(),
    };
  });
  if (!result.beforeMigration) throw new Error('legacy receipts were not honoured before migrating');
  if (!result.perFileExists) throw new Error('receipt was not split into its own file');
  if (JSON.stringify(result.listed) !== JSON.stringify(['old.one', 'old.two'])) {
    throw new Error(`listed ${JSON.stringify(result.listed)}`);
  }
  console.log(`       ${result.ran.join(' | ')}`);
});


/* ---------- analysis: quantitative + text ---------- */

await step('a rich form is seeded for analysis', async () => {
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const c = await import('/js/config.js');
    const anchors = { ...c.SCALE_ANCHORS };
    const form = await m.db.saveForm({
      id: 'form_an', name: 'Analysis Sample',
      sections: [{ title: 'Sample', items: [
        { id: 'aq1', type: 'scale', label: 'Instruction was clear', required: true, min: 1, max: 9, anchors },
        { id: 'aq2', type: 'text', label: 'What should change?', required: false, rows: 3, wordLimit: 250 },
      ] }],
    });
    await m.db.saveRequest({
      id: 'req_an', feedbackId: 'FB-2026-9700', title: 'Analysis Sample', formId: form.id,
      asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      anonymous: true, status: 'open', assignedUsernames: [],
    });
    // A deliberately polarised set with one clear outlier and mixed prose.
    const rows = [
      [9, 'Absolutely excellent instruction, very clear and engaging.'],
      [8, 'Great pace and the drill practice was extremely helpful.'],
      [9, 'Outstanding. Learned a lot about leadership.'],
      [2, 'Disorganised and confusing. A waste of time honestly.'],
      [2, 'The briefings were unclear and frustrating.'],
      [1, 'Poor preparation, felt rushed and pointless.'],
      [8, 'Really enjoyed the labs, thorough and well organised.'],
    ];
    for (const [rating, text] of rows) {
      await m.db.saveResponse({
        requestId: 'req_an', formId: form.id, anonymous: true,
        asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
        answers: { aq1: rating, aq2: text },
      });
    }
    for (let i = 0; i < 7; i++) await m.db.addReceipt('req_an', `anstudent${i}`);
  });

  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.hist', { timeout: 15000 });
});

await step('the distribution histogram renders every scale point', async () => {
  const cols = await page.$$eval('.hist', (n) => n[0].querySelectorAll('.hist__col').length);
  if (cols !== 9) throw new Error(`expected 9 columns, saw ${cols}`);
});

await step('a polarised question is called out, not averaged away', async () => {
  const text = await page.textContent('#view');
  if (!/Opinion is split/.test(text)) throw new Error('split not detected in the UI');
  if (!/describes nobody/.test(text)) throw new Error('no explanation of why the mean misleads');
  if (!/Sharply divided|Mixed views/.test(text)) throw new Error('no agreement reading shown');
});

await step('cohort breakdown and rater analysis render', async () => {
  const text = await page.textContent('#view');
  if (!/Breakdown by cohort/.test(text)) throw new Error('no cohort breakdown');
  if (!/Consistently different raters/.test(text)) throw new Error('no rater panel');
});

await step('sentiment tab summarises and ranks answers', async () => {
  const text = await page.textContent('#view');
  if (!/Positive/.test(text) || !/Negative/.test(text)) throw new Error('no sentiment buckets');
  if (!/lexicon count, not comprehension/.test(text)) throw new Error('no accuracy caveat shown');
  // Most negative should be ranked first.
  const first = await page.textContent('.quote');
  if (!/waste of time|pointless|unclear/i.test(first)) {
    throw new Error(`most-negative not first: "${first.slice(0, 60)}"`);
  }
});

await step('word cloud renders and is backed by a table', async () => {
  const tabs = await page.$$('.tabs .tab');
  const cloudTab = await (async () => {
    for (const t of tabs) if ((await t.textContent()).trim() === 'Word cloud') return t;
    return null;
  })();
  if (!cloudTab) throw new Error('no word cloud tab');
  await cloudTab.click();
  await page.waitForSelector('svg.cloud', { timeout: 8000 });
  const words = await page.$$eval('.cloud__word', (n) => n.length);
  if (words < 5) throw new Error(`only ${words} words placed`);
  // The accessible table must carry the same data.
  const rows = await page.$$eval('table.table tbody tr', (n) => n.length);
  if (rows < 5) throw new Error('term table missing or too small');
  const label = await page.getAttribute('svg.cloud', 'aria-label');
  if (!/table below/.test(label || '')) throw new Error('cloud not described for screen readers');
});

await step('selecting a word shows the answers containing it', async () => {
  await page.click('.cloud__word');
  await page.waitForTimeout(500);
  const marks = await page.$$eval('mark', (n) => n.length);
  if (!marks) throw new Error('no highlighted matches shown');
});

await step('a clean safety screen says so honestly', async () => {
  const text = await page.textContent('#view');
  if (!/Safety screen: nothing flagged/.test(text)) throw new Error('no clean-screen notice');
  if (!/not proof that nothing was reported/.test(text)) throw new Error('missing false-negative caveat');
});

await step('safety screen flags a hazing disclosure', async () => {
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    await m.db.saveResponse({
      requestId: 'req_an', formId: 'form_an', anonymous: true,
      asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      answers: { aq1: 1, aq2: 'The senior cadet hazed us and made us do push ups until we cried.' },
    });
    await m.db.addReceipt('req_an', 'anstudent9');
  });
  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.quote--flagged', { timeout: 15000 });

  const text = await page.textContent('#view');
  if (!/Hazing and abuse of authority/.test(text)) throw new Error('category not named');
  if (!/flagged for review/.test(text)) throw new Error('no review prompt');
  if (!/not a finding/.test(text)) throw new Error('missing "not a finding" caveat');
  const marks = await page.$$eval('.quote--flagged mark', (n) => n.map((x) => x.textContent.toLowerCase()));
  if (!marks.some((m) => m.includes('hazed'))) throw new Error(`matched terms not highlighted: ${marks}`);
});

await step('a flag on a withheld form alerts without exposing', async () => {
  const result = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const c = await import('/js/config.js');
    const form = await m.db.saveForm({
      id: 'form_thin2', name: 'Thin Flagged',
      sections: [{ title: 'T', items: [
        { id: 'tq', type: 'text', label: 'Anything to raise?', required: false, rows: 3, wordLimit: 250 },
      ] }],
    });
    await m.db.saveRequest({
      id: 'req_thin2', feedbackId: 'FB-2026-9800', title: 'Thin Flagged', formId: form.id,
      asClass: 'AS100', schoolYear: '2026-2027', semester: 'Fall',
      anonymous: true, status: 'open', assignedUsernames: [],
    });
    await m.db.saveResponse({
      requestId: 'req_thin2', formId: form.id, anonymous: true,
      asClass: 'AS100', schoolYear: '2026-2027', semester: 'Fall',
      answers: { tq: 'CANARY2 I was hazed by the flight commander repeatedly.' },
    });
    await m.db.addReceipt('req_thin2', 'thinstudent');
    return true;
  });
  void result;

  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.quote--flagged, .notice--warn', { timeout: 15000 });
  await page.waitForTimeout(800);

  const text = await page.textContent('#view');
  // The alert must exist...
  if (!/withheld for anonymity/.test(text)) throw new Error('no withheld-but-flagged warning');
  if (!/may identify/.test(text)) throw new Error('privacy cost not stated');
  // ...but the content must not be on screen until asked for.
  if (text.includes('CANARY2')) throw new Error('WITHHELD FLAGGED CONTENT SHOWN WITHOUT CONSENT');

  await page.click('button:has-text("Show anyway")');
  await page.waitForTimeout(500);
  const after = await page.textContent('#view');
  if (!after.includes('CANARY2')) throw new Error('content did not appear after explicit consent');
});

/* ---------- form reuse ---------- */

await step('a form can be saved as a template and reused', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  await page.goto(`${BASE}#/instructor/create/new`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.qrow', { timeout: 12000 });

  const labels = ['Reusable question one', 'Reusable question two', 'Reusable question three'];
  const rows = await page.$$('.qrow');
  for (let i = 0; i < rows.length; i++) {
    await (await rows[i].$('input.input')).fill(labels[i] || `Q${i}`);
  }
  await page.fill('input[placeholder^="e.g. AS200 Leadership"]', 'Template Source Event');

  await page.click('button:has-text("Save as template")');
  await page.waitForSelector('dialog.modal', { timeout: 8000 });
  await page.fill('dialog input[type=text]', 'Standard block feedback');
  await page.click('dialog .btn--primary');
  await page.waitForTimeout(1500);

  // A fresh form should now offer it under "Start from".
  await page.goto(`${BASE}#/instructor/create/new`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.qrow', { timeout: 12000 });
  const text = await page.textContent('#view');
  if (!/Start from/.test(text)) throw new Error('no "Start from" section on a new form');

  const options = await page.$$eval('select option', (n) => n.map((o) => o.textContent));
  if (!options.some((o) => /Template — Standard block feedback/.test(o))) {
    throw new Error(`template not offered: ${options.slice(0, 6).join(' | ')}`);
  }
});

await step('starting from a template copies the questions, not links them', async () => {
  const selects = await page.$$('select');
  await selects[0].selectOption({ label: 'Template — Standard block feedback' });
  await page.waitForTimeout(1200);

  const values = await page.$$eval('.qrow input.input', (n) => n.map((i) => i.value));
  if (values[0] !== 'Reusable question one') {
    throw new Error(`questions not loaded: ${JSON.stringify(values.slice(0, 3))}`);
  }

  // Editing the copy must not touch the stored template.
  const ids = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const forms = await m.db.listForms();
    const tpl = forms.find((f) => f.isTemplate && f.name === 'Standard block feedback');
    return (tpl.sections[0].items || []).map((i) => i.id);
  });
  const draftIds = await page.evaluate(() =>
    [...document.querySelectorAll('.qrow')].length);
  if (!ids.length || !draftIds) throw new Error('template or draft empty');
  console.log(`       template kept ${ids.length} questions; draft has ${draftIds}`);
});

/* ---------- annual rollover ---------- */

await step('the rollover previews who moves where', async () => {
  await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    for (const [who, cls] of [['a', 'AS100'], ['b', 'AS100'], ['c', 'AS400']]) {
      await a.createAccount({ email: `roll.${who}@det025.edu`, name: `Rollover, Cadet ${who.toUpperCase()}`,
                              roles: ['student'], asClass: cls });
    }
  });
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.section-title:has-text("Academic year rollover")', { timeout: 12000 });
  await page.waitForTimeout(800);
  const text = await page.textContent('#view');
  if (!/Currently/.test(text)) throw new Error('no preview table');
  if (!/Graduating/.test(text)) throw new Error('AS400 not shown as graduating');
});

await step('advancing the year moves levels and retires AS400', async () => {
  await page.click('button:has-text("Advance the academic year")');
  await page.waitForSelector('dialog.modal', { timeout: 8000 });
  await page.click('dialog .btn--danger');
  await page.waitForTimeout(2500);

  const after = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    const all = await a.listAccounts();
    const get = (who) => all.find((x) => x.email === `roll.${who}@det025.edu`);
    return {
      a: get('a')?.asClass, b: get('b')?.asClass,
      c: get('c')?.asClass, cActive: get('c')?.active,
    };
  });
  if (after.a !== 'AS200' || after.b !== 'AS200') {
    throw new Error(`AS100 did not advance: ${JSON.stringify(after)}`);
  }
  if (after.cActive !== false) throw new Error('graduating cadet was not deactivated');
  if (after.c !== 'AS400') throw new Error('graduating cadet should keep their level, not be blanked');
  console.log('       AS100 -> AS200, AS400 deactivated but retained');
});

/**
 * A second rollover is the one that would actually hurt.
 *
 * The preview recomputes from the roster as it stands, so the morning after a
 * rollover it offers a fresh and entirely plausible set of moves. Nothing said
 * the year had already been advanced, which invited an administrator who was
 * unsure whether the first run worked to simply run it again — and that moves
 * every cadet up a second level, irreversibly.
 */
await step('a second rollover in the same year is warned about, not offered silently', async () => {
  // The step above has just advanced the year, so the card should now say so.
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.section-title:has-text("Academic year rollover")', { timeout: 12000 });
  await page.waitForTimeout(1500);

  const year = await page.evaluate(async () => (await import('/js/config.js')).currentSchoolYear());
  const text = await page.textContent('#view');
  if (!text.includes(`Already advanced for ${year}`)) {
    throw new Error(`no already-advanced notice for ${year}`);
  }
  // Naming who and when is the point — it is what lets someone tell their own
  // earlier run from somebody else's.
  if (!/capt\.reyes/.test(text)) throw new Error('the notice does not say who ran it');
  if (!/AS100 would become AS300|up a second level/.test(text)) {
    throw new Error('the notice does not say what a second run would do');
  }
});

await step('the second-run warning can be overridden, and only then applies', async () => {
  // Warned, not blocked: a det that restored a backup from before the rollover
  // has to run it again in the same year. Refusing would leave them re-levelling
  // the roster by hand.
  await page.waitForSelector('button:has-text("Advance the academic year")', { timeout: 12000 });

  const before = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    const all = await a.listAccounts();
    return all.find((x) => x.email === 'roll.a@det025.edu')?.asClass;
  });

  await page.click('button:has-text("Advance the academic year")');
  await page.waitForSelector('dialog.modal', { timeout: 8000 });
  const first = await page.textContent('dialog.modal');
  if (!/a second time/i.test(first)) {
    throw new Error(`the extra confirmation did not appear: ${first.slice(0, 140)}`);
  }

  // Cancelling the extra confirmation must change nothing at all.
  await page.click('dialog .btn:not(.btn--danger):not(.btn--primary)');
  await page.waitForTimeout(900);
  const afterCancel = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    const all = await a.listAccounts();
    return all.find((x) => x.email === 'roll.a@det025.edu')?.asClass;
  });
  if (afterCancel !== before) {
    throw new Error(`cancelling the warning still advanced: ${before} -> ${afterCancel}`);
  }
  console.log(`       cancelled at the warning; still ${afterCancel}`);
});

await step('a rollover recorded for a previous year does not suppress this one', async () => {
  // Keyed on the school year, not on "has ever been run". A det in its second
  // year must be able to advance again.
  const suppressed = await page.evaluate(async () => {
    const ds = await import('/js/data-source.js');
    const c = await import('/js/config.js');
    const entries = await ds.loadAudit(12);
    const thisYear = c.currentSchoolYear();
    const rollovers = entries.filter((e) => e.action === 'roster.rollover');
    return {
      thisYear,
      years: [...new Set(rollovers.map((e) => e.detail?.schoolYear))],
      // What the guard asks: is there one for *this* year?
      matchesThisYear: rollovers.some((e) => e.detail?.schoolYear === thisYear),
      matchesLastYear: rollovers.some((e) => e.detail?.schoolYear === '1999-2000'),
    };
  });
  if (!suppressed.matchesThisYear) {
    throw new Error(`no rollover recorded for ${suppressed.thisYear}; years seen: ${suppressed.years}`);
  }
  if (suppressed.matchesLastYear) throw new Error('a fabricated year matched');
  // The school year is stamped on the entry, so the detection cannot be keyed on
  // presence alone — which is what makes a det's second September work.
  if (!suppressed.years.every((y) => /^\d{4}-\d{4}$/.test(String(y)))) {
    throw new Error(`a rollover entry carries no usable school year: ${suppressed.years}`);
  }
});

/* ---------- audit trail ---------- */

await step('destructive actions are recorded with who did them', async () => {
  const entries = await page.evaluate(async () => {
    const a = await import('/js/audit.js');
    return (await a.recent({ months: 2, limit: 200 })).map((e) => ({
      action: e.action, who: e.actor?.username, summary: e.summary,
    }));
  });
  const actions = entries.map((e) => e.action);
  for (const want of ['account.created', 'roster.rollover']) {
    if (!actions.includes(want)) throw new Error(`${want} not recorded — saw ${[...new Set(actions)].join(', ')}`);
  }
  if (!entries.every((e) => e.who)) throw new Error('an entry has no actor');
  console.log(`       ${entries.length} entries, actions: ${[...new Set(actions)].join(', ')}`);
});

await step('the activity log is visible in the admin console', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.section-title:has-text("Activity log")', { timeout: 12000 });
  await page.waitForTimeout(1500);
  const text = await page.textContent('#view');
  if (!/Academic year advanced|Account created/.test(text)) {
    throw new Error('no entries rendered in the activity log');
  }
});

await step('the audit module exposes no way to delete an entry', async () => {
  const exported = await page.evaluate(async () => Object.keys(await import('/js/audit.js')));
  const destructive = exported.filter((k) => /delete|remove|clear|wipe|purge/i.test(k));
  if (destructive.length) throw new Error(`audit exposes ${destructive.join(', ')}`);
});

/* ---------- flagged responses are protected ---------- */

await step('an instructor cannot delete flagged feedback', async () => {
  await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const c = await import('/js/config.js');
    const anchors = { ...c.SCALE_ANCHORS };
    const form = await m.db.saveForm({
      id: 'form_prot', name: 'Protected',
      sections: [{ title: 'P', items: [
        { id: 'pq1', type: 'scale', label: 'Rating', required: true, min: 1, max: 9, anchors },
        { id: 'pq2', type: 'text', label: 'Anything to raise?', required: false, rows: 3, wordLimit: 250 },
      ] }],
    });
    await m.db.saveRequest({
      id: 'req_prot', feedbackId: 'FB-2026-9900', title: 'Protected Form', formId: form.id,
      asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
      anonymous: true, status: 'open', assignedUsernames: [],
    });
    // Three responses so results are not withheld, one of them flagged.
    for (const [rating, text] of [[7, 'All fine.'], [8, 'Good session.'],
      [2, 'PROTECTED-CANARY the flight commander hazed us repeatedly.']]) {
      await m.db.saveResponse({
        requestId: 'req_prot', formId: form.id, anonymous: true,
        asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
        answers: { pq1: rating, pq2: text },
      });
    }
    // Sign in as an instructor who is NOT an admin.
    const a = await import('/js/auth.js');
    await a.createAccount({ email: 'plain.instructor@det025.edu', name: 'Plain Instructor',
                            roles: ['instructor'] });
    a.signOut();
    await a.signInWithGoogle({ email: 'plain.instructor@det025.edu', emailVerified: true }, 'instructor');
  });

  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.list__item', { timeout: 15000 });

  // Open the flagged response from the individual list.
  const items = await page.$$('.list__item');
  let opened = false;
  for (const item of items) {
    await item.click();
    await page.waitForSelector('dialog.modal', { timeout: 8000 });
    const body = await page.textContent('dialog.modal');
    if (/PROTECTED-CANARY/.test(body)) { opened = true; break; }
    await page.click('dialog .btn:has-text("Close")');
    await page.waitForTimeout(300);
  }
  if (!opened) throw new Error('could not open the flagged response');

  await page.click('dialog .btn--danger');
  // Scope every read to the refusal dialog itself. util.js removes a dialog on its
  // asynchronous `close` event, so the detail dialog this one replaced can still be
  // in the DOM — and a bare `dialog.modal` returns whichever comes first, which was
  // intermittently the stale one. The wait passed and the read then missed.
  const REFUSAL = 'dialog.modal:has-text("cannot be deleted")';
  await page.waitForSelector(REFUSAL, { timeout: 8000 });
  const refusal = await page.textContent(REFUSAL);
  if (!/cannot be deleted/.test(refusal)) throw new Error('deletion was not refused');
  if (!/database administrator/i.test(refusal)) throw new Error('no route to escalate offered');
  await page.click(`${REFUSAL} .btn`);
  await page.waitForTimeout(400);

  const still = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const rows = await m.db.listResponses('req_prot');
    return rows.some((r) => String(r.answers?.pq2 || '').includes('PROTECTED-CANARY'));
  });
  if (!still) throw new Error('THE FLAGGED RESPONSE WAS DELETED');
});

await step('an admin can delete it, but only with a recorded reason', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes', 'admin');
  await page.goto(`${BASE}#/instructor?tab=analysis`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.list__item', { timeout: 15000 });

  const items = await page.$$('.list__item');
  for (const item of items) {
    await item.click();
    await page.waitForSelector('dialog.modal', { timeout: 8000 });
    if (/PROTECTED-CANARY/.test(await page.textContent('dialog.modal'))) break;
    await page.click('dialog .btn:has-text("Close")');
    await page.waitForTimeout(300);
  }
  await page.click('dialog .btn--danger');
  await page.waitForSelector('dialog.modal:has-text("Delete flagged feedback")', { timeout: 8000 });
  await page.fill('dialog textarea', 'Duplicate of a report already referred to the commander.');
  await page.click('dialog .btn--danger');
  await page.waitForTimeout(2500);

  const gone = await page.evaluate(async () => {
    const m = await import('/js/storage/index.js');
    const rows = await m.db.listResponses('req_prot');
    return !rows.some((r) => String(r.answers?.pq2 || '').includes('PROTECTED-CANARY'));
  });
  if (!gone) throw new Error('admin deletion did not take effect');

  const logged = await page.evaluate(async () => {
    const a = await import('/js/audit.js');
    const rows = await a.recent({ months: 2, limit: 200 });
    return rows.find((e) => e.action === 'response.deleted' && e.reason);
  });
  if (!logged) throw new Error('the deletion was not recorded with a reason');
  if (!/FLAGGED/.test(logged.summary)) throw new Error('the record does not note it was flagged');
  console.log(`       recorded: "${logged.summary}" by ${logged.actor.username}`);
});
const DESKTOP = { width: 1180, height: 950 };

await step('mobile: anchored scale does not overflow', async () => {
  // Restored in a finally, not after the assertion. This step used to leave the
  // viewport at phone width on its way out, and nothing set it back until the
  // very last step of the file — so every check in between, including all four
  // access-toggle ones, silently ran on a 390px screen. A responsive rule that
  // hid any of those controls would have read as the control being broken.
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}#/student`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) throw new Error(`${over}px overflow`);
    if (shots) await page.screenshot({ path: `${shots}/m4-mobile.png`, fullPage: true });
  } finally {
    await page.setViewportSize(DESKTOP);
  }
});
/* ---------- signing in without Google ---------- */

/** The access toggle specifically, not the first checkbox on the page. */
const ACCESS_TOGGLE = 'section:has(> .section-title:text-is("Access")) input[type=checkbox]';

const setFlag = (on) => page.evaluate((v) => {
  if (v) localStorage.setItem('nine31.directsignin.v1', '1');
  else localStorage.removeItem('nine31.directsignin.v1');
}, on);

await step('the access flag grants no roles by itself', async () => {
  // This is the whole point of 0.16. The flag used to make every role check
  // pass, so ticking one box on a page that needs no sign-in opened the admin
  // console. It now enables an extra way to *sign in*, and nothing else.
  await page.evaluate(() => sessionStorage.clear());
  await setFlag(true);
  await page.goto(`${BASE}#/home`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const roles = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    return {
      admin: a.hasRole('admin'),
      commander: a.hasRole('commander'),
      instructor: a.hasRole('instructor'),
      active: a.activeRoles(),
    };
  });
  for (const [role, held] of Object.entries(roles)) {
    if (role === 'active') continue;
    if (held) throw new Error(`the flag alone granted ${role}`);
  }
  if (roles.active.length) throw new Error(`activeRoles returned ${roles.active.join(',')}`);
});

await step('with the flag on, the panels still refuse a signed-out visitor', async () => {
  // The flag is cleared in a finally. Left as the last statement of the step, an
  // assertion failure above it skipped the cleanup — and because step() catches,
  // the run continued with direct sign-in still enabled, turning one failure
  // into a cascade of unrelated ones.
  try {
    for (const path of ['/instructor', '/cadre', '/admin']) {
      await page.goto(`${BASE}#${path}`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      const text = await page.textContent('#view');
      // The sign-in gate, not the panel.
      if (/Feedback requests|Restricted space|Invite people/.test(text)) {
        throw new Error(`${path} opened without a sign-in`);
      }
    }
  } finally {
    await setFlag(false);
  }
});

await step('a passer-by cannot switch it on once the detachment has an admin', async () => {
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.section-title:has-text("Access")', { timeout: 12000 });

  const toggle = await page.$(ACCESS_TOGGLE);
  if (!toggle) throw new Error('the access toggle is gone entirely');
  if (!(await toggle.isDisabled())) throw new Error('a signed-out visitor can still enable it');
  if (!/Locked/.test(await page.textContent('#view'))) {
    throw new Error('nothing explains why it cannot be enabled');
  }
});

await step('an administrator can turn it on, and anyone can turn it off', async () => {
  await signInAs(ADMIN_EMAIL, 'Capt Reyes');
  await page.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.section-title:has-text("Access")', { timeout: 12000 });

  const toggle = await page.$(ACCESS_TOGGLE);
  if (await toggle.isDisabled()) throw new Error('an admin was locked out of their own toggle');
  await toggle.click();
  await page.waitForSelector('dialog.modal', { timeout: 8000 });
  await page.click('dialog .btn--danger');
  await page.waitForTimeout(900);
  if (!(await page.evaluate(() => localStorage.getItem('nine31.directsignin.v1') === '1'))) {
    throw new Error('an admin could not enable it');
  }

  // Off is never gated: the safe direction should not need a credential.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector(ACCESS_TOGGLE, { timeout: 12000 });
  const off = await page.$(ACCESS_TOGGLE);
  if (await off.isDisabled()) throw new Error('it could not be turned off');
  await off.click();
  await page.waitForTimeout(900);
  if (await page.evaluate(() => localStorage.getItem('nine31.directsignin.v1') === '1')) {
    throw new Error('it survived being switched off');
  }
});

await step('the email sign-in still honours the roster', async () => {
  // It is a different way to say who you are, not a way to skip being anybody.
  await setFlag(true);
  await page.goto(`${BASE}#/home`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });

  const outcome = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    a.signOut();
    try {
      await a.signInAsDeveloper('nobody@example.com');
      return 'ADMITTED';
    } catch (err) { return err.message; }
  });
  if (outcome === 'ADMITTED') throw new Error('an address not on the roster was let in');
  if (!/not on this detachment/i.test(outcome)) throw new Error(`unexpected refusal: ${outcome}`);

  const roles = await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    a.signOut();
    const account = await a.signInAsDeveloper('capt.reyes@det025.edu');
    return account.roles;
  });
  try {
    if (!roles.includes('admin')) throw new Error(`got roles ${roles.join(',')} for a real account`);
  } finally {
    await setFlag(false);
  }
});

/* ---------- every route renders ---------- */

/**
 * Visits each route and checks it drew something.
 *
 * The suite exercised routes it had a scenario for, which left Settings never
 * visited — and Settings had been calling an unimported `connectionStatus()`
 * since 0.8. It threw the moment the page loaded, and shipped through three
 * releases because nothing here ever opened it.
 *
 * This does not test what a page *does*. It tests that opening it does not
 * explode, which is the failure that actually reached a user.
 */
await step('every route renders without throwing', async () => {
  await page.setViewportSize(DESKTOP);
  await signInAs(ADMIN_EMAIL);

  // Routes taking an id are visited with one that does not exist: a page that
  // cannot find its record should say so, not crash.
  const paths = [
    '/home', '/student', '/student/fill/nope', '/instructor',
    '/instructor/create/nope', '/admin', '/admin/invite', '/settings',
    '/cadre', '/setup?rerun=1',
  ];

  const broken = [];
  for (const path of paths) {
    const before = errors.length;
    await page.goto(`${BASE}#${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    const body = await page.textContent('#view').catch(() => '');
    // The router's own crash screen. Reaching it means the view threw.
    if (/Something went wrong/i.test(body)) broken.push(`${path}: crash screen`);
    else if (!body || !body.trim()) broken.push(`${path}: rendered nothing`);
    else if (errors.length > before) broken.push(`${path}: ${errors[before]}`);
  }

  if (broken.length) throw new Error(broken.join('; '));
});

await browser.close();
console.log('\n' + (errors.length ? `${errors.length} problem(s):` : 'No runtime errors.'));
for (const e of [...new Set(errors)]) console.log('  - ' + e);
process.exit(errors.length ? 1 : 0);
