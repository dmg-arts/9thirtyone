/**
 * The Google Drive path, against a simulated Drive.
 *
 *     node tests/e2e/drive.test.mjs        (with a server already running)
 *     npm run test:drive
 *
 * WHY THIS EXISTS
 *
 * Every other suite runs on the `local` backend, so the entire Drive path — the
 * setup wizard's connect step, the adapter, the folder the app now creates for
 * itself — was never executed by a test. It could not be: it needs a Google
 * OAuth token, and Google will not issue one to an automated browser.
 *
 * So Google is simulated instead. Two seams, both narrow:
 *
 *   - `window.google.accounts.oauth2` is stubbed before the app loads, so the
 *     adapter's `authorize()` gets a token without a popup. `loadGis()` already
 *     short-circuits when `window.google.accounts` exists, so nothing reaches
 *     accounts.google.com.
 *   - `https://www.googleapis.com/**` is intercepted and served by an in-memory
 *     Drive below.
 *
 * **The fake enforces `drive.file` semantics**, which is the point. It records
 * which files this app created and answers 404 for anything else — exactly as
 * Google does. Without that it would happily serve a hand-made folder and the
 * suite would pass while the real thing failed.
 *
 * WHAT IT CANNOT COVER
 *
 * Whether Google's real API agrees with this model of it. The shapes here come
 * from the Drive v3 reference and from what the adapter already sends, but a
 * green run is evidence the app is internally consistent, not that a live
 * install works. That still needs somebody to run it once against real Drive.
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/index.html';
const ORIGIN = new URL(BASE).origin;
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p));

const errors = [];
const step = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}: ${e.message.split('\n')[0]}`); errors.push(label); }
};

/* ------------------------------------------------------------------ *
 * a Drive that behaves like drive.file
 * ------------------------------------------------------------------ */

function makeDrive() {
  const files = new Map();          // id -> {id,name,mimeType,parents,content,trashed}
  const appCreated = new Set();     // what this app made, and may therefore see
  let seq = 0;
  const FOLDER = 'application/vnd.google-apps.folder';

  /** Something exists but was made elsewhere: Google shows the app nothing. */
  const invisible = (id) => !appCreated.has(id);

  return {
    files,
    appCreated,
    /** Seeds a file the app did NOT create, to prove it stays unreachable. */
    planted(name, mimeType = FOLDER) {
      const id = `planted-${++seq}`;
      files.set(id, { id, name, mimeType, parents: [], trashed: false });
      return id;
    },
    created: () => [...appCreated].map((id) => files.get(id)),

    handle(method, url, body) {
      const u = new URL(url);
      const path = u.pathname
        .replace('/upload/drive/v3', '')
        .replace('/drive/v3', '');

      // --- create -------------------------------------------------------
      if (method === 'POST' && path === '/files') {
        let meta = {};
        let content = '';
        if (u.searchParams.get('uploadType') === 'multipart') {
          // metadata part, then content part
          const parts = String(body).split(/--[^\r\n]+/).filter((p) => p.includes('{') || p.trim());
          const jsons = String(body).match(/\{[\s\S]*?\}(?=\r?\n)/g) || [];
          try { meta = JSON.parse(jsons[0] || '{}'); } catch { meta = {}; }
          content = jsons.slice(1).join('') || (parts.pop() || '').trim();
        } else {
          try { meta = JSON.parse(body || '{}'); } catch { meta = {}; }
        }
        const id = `f-${++seq}`;
        files.set(id, {
          id,
          name: meta.name || 'untitled',
          mimeType: meta.mimeType || 'application/json',
          parents: meta.parents || [],
          content,
          trashed: false,
          createdTime: new Date(Date.now() + seq * 1000).toISOString(),
        });
        appCreated.add(id);          // the app made it, so the app can see it
        return { status: 200, body: { id, name: files.get(id).name } };
      }

      // --- list ---------------------------------------------------------
      if (method === 'GET' && path === '/files') {
        const q = u.searchParams.get('q') || '';
        const parent = /'([^']+)'\s+in\s+parents/.exec(q)?.[1];
        const name = /name\s*=\s*'([^']*)'/.exec(q)?.[1];
        const out = [...files.values()].filter((f) => {
          if (f.trashed) return false;
          if (invisible(f.id)) return false;        // drive.file: unseen
          if (parent && !(f.parents || []).includes(parent)) return false;
          if (name && f.name !== name) return false;
          return true;
        });
        return { status: 200, body: { files: out.map((f) => ({
          id: f.id, name: f.name,
          createdTime: f.createdTime || '2026-01-01T00:00:00Z',
          modifiedTime: '2026-01-01T00:00:00Z',
        })) } };
      }

      // --- get / download / update / trash --------------------------------
      const single = /^\/files\/([^/]+)$/.exec(path);
      if (single) {
        const id = decodeURIComponent(single[1]);
        const file = files.get(id);
        // The behaviour this whole suite exists to pin: present but not ours.
        if (!file || invisible(id)) {
          return { status: 404, body: { error: { code: 404, message: 'File not found: ' + id } } };
        }
        if (method === 'GET' && u.searchParams.get('alt') === 'media') {
          return { status: 200, raw: file.content || '' };
        }
        if (method === 'GET') {
          return { status: 200, body: { id, name: file.name, mimeType: file.mimeType, capabilities: { canEdit: true } } };
        }
        if (method === 'PATCH') {
          let parsed = null;
          try { parsed = JSON.parse(body || ''); } catch { /* raw media */ }
          if (parsed && typeof parsed.trashed === 'boolean') file.trashed = parsed.trashed;
          else file.content = body;
          return { status: 200, body: { id } };
        }
      }

      return { status: 400, body: { error: { code: 400, message: 'unhandled ' + method + ' ' + path } } };
    },
  };
}

/* ------------------------------------------------------------------ *
 * a page wired to it
 * ------------------------------------------------------------------ */

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

async function pageWithDrive() {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 950 } });
  const page = await ctx.newPage();
  const drive = makeDrive();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Stand in for Google Identity Services, before any app code runs.
  await page.addInitScript(() => {
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: ({ callback }) => ({
            requestAccessToken: () => callback({ access_token: 'test-token', expires_in: 3600 }),
          }),
          revoke: (_t, done) => done && done(),
        },
        id: { initialize() {}, renderButton() {}, disableAutoSelect() {} },
      },
    };
  });

  await page.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const result = drive.handle(req.method(), req.url(), req.postData());
    if (result.raw !== undefined) {
      return route.fulfill({ status: result.status, contentType: 'text/plain', body: result.raw });
    }
    return route.fulfill({
      status: result.status,
      contentType: 'application/json',
      body: JSON.stringify(result.body),
    });
  });

  return { page, ctx, drive, pageErrors };
}

/** Drives the wizard to the point where the app has made its folder. */
async function runWizardToDrive(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.wizard');
  await page.fill('.wizard input[type=text]', 'AFROTC Detachment 025');
  await page.click('.wizard .btn--primary');
  await page.waitForSelector('.choice-list');
  await page.click('input[value="drive"]', { force: true });
  await page.click('.wizard .btn--primary');
  // The Client ID stopped being a setup step when the programme moved to one
  // shared verified client, so the field now sits behind a disclosure. This
  // suite still needs it: it points the app at a fake Google, which the real
  // shared client would never reach.
  await page.click('details.disclosure summary');
  await page.waitForSelector('.input.mono', { timeout: 10000 });
  await page.fill('.input.mono', '123456-abcdef.apps.googleusercontent.com');
  // The step looks for an existing folder before it makes one, so the button no
  // longer says "create" — on a fresh fake Drive it finds nothing and creates.
  await page.click('button:has-text("set up the folder")');
  await page.waitForTimeout(1200);
}

/* ------------------------------------------------------------------ *
 * checks
 * ------------------------------------------------------------------ */

await step('the wizard creates the folder itself, with no link to paste', async () => {
  const { page, ctx, drive, pageErrors } = await pageWithDrive();
  try {
    await runWizardToDrive(page);

    const folders = drive.created().filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    const root = folders.find((f) => f.name === '9ThirtyOne');
    if (!root) throw new Error(`no root folder created; got ${JSON.stringify(folders.map((f) => f.name))}`);
    if ((root.parents || []).length) throw new Error('the root was created inside another folder');
    if (pageErrors.length) throw new Error(pageErrors[0]);

    const text = await page.textContent('#view');
    if (!text.includes(root.id)) throw new Error('the folder address is not shown to the administrator');
    const cont = await page.$('button:has-text("Continue")');
    if (await cont.isDisabled()) throw new Error('Continue stayed disabled after the folder was made');
  } finally { await ctx.close(); }
});

/**
 * Re-running setup must not strand the detachment.
 *
 * `createRoot` was an unconditional create, so setup produced a new empty folder
 * every time it was run and left the records in the previous one. The app then
 * reported an empty roster, which reads exactly like the fault that sent someone
 * back to setup — so the cycle repeated. Three folders turned up in one account
 * that way, and the two empty ones looked identical to the real one from Drive.
 */
await step('re-running setup offers the existing folder instead of making another', async () => {
  const { page, ctx, drive, pageErrors } = await pageWithDrive();
  try {
    await runWizardToDrive(page);
    const first = drive.created().find((f) => f.name === '9ThirtyOne');
    if (!first) throw new Error('no root folder was created the first time');

    // Back to the wizard the way a stranded administrator gets there.
    await page.evaluate(() => {
      localStorage.removeItem('nine31.setup.complete.v1');
      localStorage.removeItem('nine31.connection.v1');
    });
    await runWizardToDrive(page);

    const text = await page.textContent('#view');
    if (!/already made a folder/i.test(text)) {
      throw new Error(`setup did not offer the existing folder: ${text.slice(0, 400)}`);
    }
    const roots = drive.created().filter((f) => f.name === '9ThirtyOne');
    if (roots.length !== 1) {
      throw new Error(`a second root was created before anyone chose: ${roots.length} exist`);
    }

    await page.click('button:has-text("Use this one")');
    await page.waitForTimeout(1200);
    if (pageErrors.length) throw new Error(pageErrors[0]);

    const after = drive.created().filter((f) => f.name === '9ThirtyOne');
    if (after.length !== 1) throw new Error(`adopting the folder created another: ${after.length}`);
    if (!(await page.textContent('#view')).includes(first.id)) {
      throw new Error('the wizard adopted a folder other than the one that existed');
    }
    const cont = await page.$('button:has-text("Continue")');
    if (await cont.isDisabled()) throw new Error('Continue stayed disabled after adopting');
  } finally { await ctx.close(); }
});

await step('a second folder is still possible, but only by asking for it', async () => {
  const { page, ctx, drive } = await pageWithDrive();
  try {
    await runWizardToDrive(page);
    await page.evaluate(() => {
      localStorage.removeItem('nine31.setup.complete.v1');
      localStorage.removeItem('nine31.connection.v1');
    });
    await runWizardToDrive(page);
    await page.click('button:has-text("Create a new folder anyway")');
    await page.waitForTimeout(1200);

    const roots = drive.created().filter((f) => f.name === '9ThirtyOne');
    if (roots.length !== 2) {
      throw new Error(`an explicit second folder was not created: ${roots.length} exist`);
    }
  } finally { await ctx.close(); }
});

await step('the folder it made is the one it then uses', async () => {
  const { page, ctx, drive, pageErrors } = await pageWithDrive();
  try {
    await runWizardToDrive(page);
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('.tree', { timeout: 12000 });
    await page.click('.wizard .btn--lg');
    await page.waitForSelector('.role-grid', { timeout: 15000 });

    const root = drive.created().find((f) => f.name === '9ThirtyOne');
    if (!root) throw new Error('no root folder was created');
    if (root.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`the root was created as ${root.mimeType}, not a folder`);
    }
    const inside = drive.created().filter((f) => (f.parents || []).includes(root.id));
    const names = inside.map((f) => f.name);
    for (const expected of ['config', 'users', 'forms', 'requests', 'responses']) {
      if (!names.includes(expected)) {
        throw new Error(`layout is missing ${expected}; created ${JSON.stringify(names)}`);
      }
    }
    if (pageErrors.length) throw new Error(pageErrors[0]);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nine31.connection.v1') || '{}'));
    if (stored.folderId !== root.id) {
      throw new Error(`the app stored "${stored.folderId}" but created "${root.id}"`);
    }
  } finally { await ctx.close(); }
});

await step('records written to Drive can be read back', async () => {
  const { page, ctx, pageErrors } = await pageWithDrive();
  try {
    await runWizardToDrive(page);
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('.tree', { timeout: 12000 });
    await page.click('.wizard .btn--lg');
    await page.waitForSelector('.role-grid', { timeout: 15000 });

    const round = await page.evaluate(async () => {
      const m = await import('/js/storage/index.js');
      await m.db.saveForm({ id: 'form_rt', name: 'Round trip', sections: [] });
      const back = await m.db.getForm('form_rt');
      return back && back.name;
    });
    if (round !== 'Round trip') throw new Error(`read back ${JSON.stringify(round)}`);
    if (pageErrors.length) throw new Error(pageErrors[0]);
  } finally { await ctx.close(); }
});

await step('a folder the app did not create is unreachable, and says why', async () => {
  // The whole reason setup changed. Google hides it; the app must explain that
  // rather than implying the address was mistyped.
  const { page, ctx, drive } = await pageWithDrive();
  try {
    const handmade = drive.planted('9ThirtyOne');
    await runWizardToDrive(page);
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('.tree', { timeout: 12000 });
    await page.click('.wizard .btn--lg');
    await page.waitForSelector('.role-grid', { timeout: 15000 });

    const outcome = await page.evaluate(async (id) => {
      const m = await import('/js/storage/index.js');
      m.db.use('drive', { clientId: '123456-abcdef.apps.googleusercontent.com', folderId: id });
      try {
        const r = await m.adapters.drive.connect({ interactive: true });
        return r.ok ? 'CONNECTED' : `refused: ${r.reason}`;
      } catch (err) { return `threw: ${err.message}`; }
    }, handmade);

    if (outcome === 'CONNECTED') {
      throw new Error('the app reached a folder it never created — the fake is not enforcing drive.file');
    }
    if (!/404|not found/i.test(outcome)) throw new Error(`unexpected failure: ${outcome}`);
  } finally { await ctx.close(); }
});

await step('signing out revokes the Drive token rather than dropping it', async () => {
  const { page, ctx } = await pageWithDrive();
  try {
    await runWizardToDrive(page);
    const revoked = await page.evaluate(async () => {
      let called = false;
      window.google.accounts.oauth2.revoke = (_t, done) => { called = true; if (done) done(); };
      const m = await import('/js/storage/index.js');
      m.adapters.drive.signOut();
      return { called, token: sessionStorage.getItem('nine31.drive.token') };
    });
    if (!revoked.called) throw new Error('the token was discarded locally but left valid at Google');
    if (revoked.token) throw new Error('the token is still in session storage');
  } finally { await ctx.close(); }
});

await browser.close();
console.log('\n' + (errors.length ? `${errors.length} problem(s):` : 'The Drive path holds.'));
for (const e of errors) console.log('  - ' + e);
process.exit(errors.length ? 1 : 0);
