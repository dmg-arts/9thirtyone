/**
 * Layout audit: drives every screen at every width and looks for the visual
 * faults that source review does not catch.
 *
 *     npm run test:layout                    (checks only)
 *     SHOTS=./shots npm run test:layout      (also writes a screenshot of every screen)
 *
 * An environment variable rather than an argument: run.mjs spawns each suite
 * with no arguments of its own, so the documented `-- ./shots` form reached
 * run.mjs instead and was taken as the name of a second suite to run.
 *
 * WHY THIS EXISTS
 *
 * Every layout regression in this project so far has been invisible in the
 * source and obvious on screen: an `<svg>` with no size rule rendering at the
 * 300x150 replaced-element default, a bold phrase turning into its own line
 * because the selector made it block-level, a nine-point scale running off the
 * side of a phone. `node --check` cannot see any of it, and the e2e suite only
 * notices when an assertion happens to sit on the broken thing.
 *
 * So this measures the rendered page instead of reading the code:
 *
 *   - the document scrolling sideways, and which element is doing it;
 *   - anything painted outside the viewport that is not in a scroller;
 *   - `<svg>` at exactly 300x150, which always means a missing size rule;
 *   - text clipped by its own container;
 *   - interactive controls overlapping each other;
 *   - touch targets too small to hit on a phone;
 *   - text that does not contrast with what is behind it, in both themes.
 *
 * WHAT IT CANNOT DO
 *
 * It has no opinion about whether a screen looks *good* — spacing, rhythm and
 * emphasis are not measurable here. Take the screenshots and look at them. The
 * checks below only catch the faults that are unambiguous enough to fail a
 * build over.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123/index.html';
const SHOTS = process.env.SHOTS || process.argv[2] || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p));

/** Phone, small tablet, laptop. The three shapes the app is actually used in. */
const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1280, height: 900 },
];

const THEMES = ['light', 'dark'];

const findings = [];
const report = (screen, viewport, theme, kind, detail) =>
  findings.push({ screen, viewport, theme, kind, detail });

/* ------------------------------------------------------------------ *
 * the checks, run inside the page
 * ------------------------------------------------------------------ */

/**
 * Everything below runs in the browser against the real computed styles.
 * Written as one function so it is one round trip per screen.
 */
const AUDIT = () => {
  const out = [];
  const add = (kind, detail) => out.push({ kind, detail });

  const vw = document.documentElement.clientWidth;
  const describe = (node) => {
    const id = node.id ? `#${node.id}` : '';
    const cls = typeof node.className === 'string' && node.className
      ? `.${node.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    const text = (node.textContent || '').trim().slice(0, 40).replace(/\s+/g, ' ');
    return `${node.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  };

  const visible = (node, rect, style) =>
    rect.width > 0 && rect.height > 0
    && style.visibility !== 'hidden' && style.display !== 'none'
    && Number(style.opacity) !== 0;

  /** True when some ancestor scrolls horizontally on purpose. */
  const inScroller = (node) => {
    for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
    return false;
  };

  /* ---- 1. the page itself scrolling sideways ---- */
  const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (overflow > 1) add('page-scrolls-sideways', `${overflow}px wider than the viewport`);

  const all = [...document.querySelectorAll('body *')];

  /* ---- 2. painted outside the viewport ---- *
   * One too-wide element drags every ancestor out with it, so reporting each
   * one gives hundreds of lines describing a single bug. Only the innermost
   * offenders — those with no overflowing descendant of their own — are worth
   * naming, because that is where the fix goes.
   */
  const over = [];
  for (const node of all) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (!visible(node, rect, style)) continue;
    if (style.position === 'fixed') continue;       // drawers and toasts may sit off-screen
    if (inScroller(node)) continue;                 // a wide table inside its own scroller is fine
    if (rect.right > vw + 1 || rect.left < -1) over.push({ node, rect });
  }
  const overSet = new Set(over.map((o) => o.node));
  for (const { node, rect } of over) {
    if ([...node.children].some((child) => overSet.has(child))) continue;
    if (rect.right > vw + 1) {
      add('past-right-edge', `${describe(node)} ends ${Math.round(rect.right - vw)}px past the edge`);
    } else {
      add('past-left-edge', `${describe(node)} starts ${Math.round(-rect.left)}px off-screen`);
    }
  }

  /* ---- 3. svg at the replaced-element default ---- */
  for (const svg of document.querySelectorAll('svg')) {
    const rect = svg.getBoundingClientRect();
    if (Math.round(rect.width) === 300 && Math.round(rect.height) === 150) {
      add('svg-unsized', `${describe(svg.parentElement || svg)} contains an svg at the 300x150 default`);
    }
  }

  /* ---- 4. text clipped by its own box ---- */
  for (const node of all) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (!visible(node, rect, style)) continue;
    if (node.children.length) continue;                       // measure leaves only
    if (!(node.textContent || '').trim()) continue;
    // Screen-reader-only text is clipped deliberately — that is the technique.
    if (node.closest('.visually-hidden, .sr-only')) continue;
    if (style.overflowX !== 'hidden' && style.overflowY !== 'hidden') continue;
    if (style.textOverflow === 'ellipsis') continue;          // deliberate truncation
    if (node.scrollWidth > node.clientWidth + 2) {
      add('text-clipped-x', `${describe(node)} is ${node.scrollWidth - node.clientWidth}px too wide for its box`);
    } else if (node.scrollHeight > node.clientHeight + 2) {
      add('text-clipped-y', `${describe(node)} is ${node.scrollHeight - node.clientHeight}px too tall for its box`);
    }
  }

  /* ---- 5. controls sitting on top of each other ---- */
  const controls = [...document.querySelectorAll('button, a[href], input, select, textarea')]
    .map((node) => ({ node, rect: node.getBoundingClientRect(), style: getComputedStyle(node) }))
    .filter(({ node, rect, style }) => visible(node, rect, style) && style.position !== 'fixed');

  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const b = controls[j];
      if (a.node.contains(b.node) || b.node.contains(a.node)) continue;  // nesting is not overlap
      const dx = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const dy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      // A few pixels is a border touching; a real collision covers area.
      if (dx > 4 && dy > 4) {
        add('controls-overlap', `${describe(a.node)} overlaps ${describe(b.node)} by ${Math.round(dx)}x${Math.round(dy)}px`);
      }
    }
  }

  /* ---- 6. touch targets, phone only (the caller filters) ---- *
   * A 17px checkbox inside a label is not a 17px target: the label takes the
   * tap too. Measure what a finger can actually hit, not the box that paints.
   */
  const target = (node) => {
    const own = node.getBoundingClientRect();
    const label = node.closest('label')
      || (node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : null);
    if (!label) return own;
    const l = label.getBoundingClientRect();
    return { width: Math.max(own.width, l.width), height: Math.max(own.height, l.height) };
  };
  // 24x24 is the WCAG 2.5.8 (AA) minimum. Apple asks for 44x44, which is
  // comfort rather than conformance — held to the standard, not the preference.
  /**
   * A link inside a sentence is exempt from 2.5.8 — the success criterion says
   * so explicitly, because its size is constrained by the line-height of the
   * text around it and enlarging it would break the paragraph. Detected by
   * asking whether the element sits inline next to other text, not by tag.
   */
  const inlineInProse = (node) => {
    if (getComputedStyle(node).display !== 'inline') return false;
    const parent = node.parentElement;
    if (!parent) return false;
    return [...parent.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  };

  for (const { node } of controls) {
    if (node.type === 'hidden') continue;
    if (inlineInProse(node)) continue;
    const box = target(node);
    if (box.height < 24 || box.width < 24) {
      add('small-target', `${describe(node)} is ${Math.round(box.width)}x${Math.round(box.height)}px (WCAG 2.5.8 asks 24x24)`);
    }
  }

  /* ---- 7. text that does not contrast with its background ---- */
  const parse = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!m) return null;
    const [r, g, b, a = '1'] = m[1].split(',').map((n) => parseFloat(n));
    return { r, g, b, a: Number(a) };
  };
  const luminance = ({ r, g, b }) => {
    const f = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  /**
   * The first opaque colour actually painted behind this node.
   *
   * Ancestry is not enough. An absolutely-positioned label can sit outside the
   * box it descends from — the count above a histogram bar is a child of the
   * bar but is painted on the page above it — and reading the ancestor's
   * background there reports a collision that nobody can see. So an ancestor
   * only counts if it really covers this node's centre.
   */
  const behind = (node) => {
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let p = node; p; p = p.parentElement) {
      const box = p.getBoundingClientRect();
      const covers = cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
      if (!covers && p !== node) continue;
      const c = parse(getComputedStyle(p).backgroundColor);
      if (c && c.a > 0.85) return c;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };

  const seen = new Set();
  for (const node of all) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (!visible(node, rect, style)) continue;
    // Its *own* text, not a descendant's. `<button><svg/>Save</button>` has an
    // element child, so requiring childless nodes skipped every icon button —
    // which is most of the primary buttons in the app.
    const text = [...node.childNodes]
      .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!text) continue;

    const fg = parse(style.color);
    if (!fg || fg.a < 0.5) continue;
    const bg = behind(node);
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;

    if (ratio < need) {
      const key = `${describe(node)}|${style.color}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add('low-contrast', `${describe(node)} is ${ratio.toFixed(2)}:1 (needs ${need}:1) — ${style.color} on rgb(${bg.r},${bg.g},${bg.b})`);
    }
  }

  /* ---- 8. the body must paint its own ground ---- */
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
  if (!bodyBg || bodyBg.a < 0.99) add('body-transparent', 'body has no opaque background of its own');

  return out;
};

/* ------------------------------------------------------------------ *
 * driving the app
 * ------------------------------------------------------------------ */

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

/*
 * Close the browser even when something throws on the way to the close below.
 *
 * app.test.mjs and drive.test.mjs wrap every assertion in a step() that catches,
 * so they always reach their own browser.close(). This file does not: the audit
 * loop calls page.goto directly, so a single navigation failure throws straight
 * past the close and leaves Chrome running.
 *
 * A leaked Chrome matters more than it sounds. run.mjs spawns suites with
 * stdio 'inherit', so the orphan holds the run's output stream open and the whole
 * thing looks like it is hanging rather than like it failed. That is exactly how
 * this was misread three times as a dying server before anyone measured it.
 */
const closeBrowser = async () => {
  try { await browser.close(); } catch { /* already gone */ }
};
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.once(event, async (err) => {
    console.error(`\n${event}: ${err?.message || err}`);
    await closeBrowser();
    process.exit(1);
  });
}

/** Completes setup and seeds a detachment with enough data for every screen. */
async function seed(page) {
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
  await page.waitForSelector('.role-grid', { timeout: 12000 });

  await page.evaluate(async () => {
    const a = await import('/js/auth.js');
    const m = await import('/js/storage/index.js');
    const c = await import('/js/config.js');
    await a.signInWithGoogle(
      { email: 'maria.reyes@det025.edu', name: 'Reyes, Maria', emailVerified: true }, null, 'tok');

    const cadets = [
      ['mia.alvarez@gmail.com', 'Alvarez, Mia'], ['dan.brooks@gmail.com', 'Brooks, Dan'],
      ['li.chen@gmail.com', 'Chen, Li'], ['sam.diaz@gmail.com', 'Diaz, Sam'],
      ['jo.ellis@gmail.com', 'Ellis, Jo'], ['kim.ford@gmail.com', 'Ford, Kim'],
      ['ade.grant@gmail.com', 'Grant, Ade'], ['rae.hall@gmail.com', 'Hall, Rae'],
    ];
    for (const [email, n] of cadets) {
      await a.createAccount({ email, name: n, roles: ['student'], asClass: 'AS200' });
    }
    // A long name, because names are the thing that breaks a row.
    await a.createAccount({
      email: 'maximilian.oyelaran-fitzgerald@det025.edu',
      name: 'Oyelaran-Fitzgerald, Maximilian', roles: ['instructor'], asClass: '',
    });

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
    for (const [id, title, space, fid] of [
      ['req_demo', 'AS200 Leadership Lab — Drill Block 3', 'shared', 'FB-2026-0001'],
      ['req_cadre', 'Cadre climate check — Fall term', 'cadre', 'FB-2026-0002'],
      ['req_cmdr', 'Commander’s assessment — AS400 cadre performance review', 'commander', 'FB-2026-0003'],
    ]) {
      await m.db.saveRequest({
        id, feedbackId: fid, title, eventName: title, formId: form.id,
        asClass: 'AS200', schoolYear: '2026-2027', semester: 'Fall',
        anonymous: true, status: 'open', assignedUsernames: [],
        instructions: 'Answer honestly — your name is never stored with your answers.',
      });
    }

    const rows = [
      [9, 8, 9, 'Absolutely excellent instruction. Very clear and the drill practice was engaging.'],
      [8, 7, 8, 'Great pace overall. The labs were thorough and well organised.'],
      [9, 9, 8, 'Outstanding block. Learned a lot about leadership under pressure.'],
      [3, 2, 3, 'Disorganised and confusing. Honestly a waste of time.'],
      [2, 3, 2, 'The briefings were unclear and frustrating. Nobody knew the plan.'],
      [8, 8, 7, 'Really enjoyed the drill sequence. More reps would help.'],
      [7, 7, 8, 'Solid instruction, though the room was cold and we started late. '
        + 'A much longer answer than anyone expects, written by a cadet who had a great deal to '
        + 'say about the organisation of the block and wanted every bit of it recorded.'],
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
}

/** Every screen worth looking at, and how to get there. */
const SCREENS = [
  { name: 'home', path: '/home' },
  { name: 'student-list', path: '/student' },
  { name: 'student-form', path: '/student/fill/req_demo' },
  { name: 'instructor-requests', path: '/instructor?tab=requests' },
  { name: 'instructor-analysis', path: '/instructor?tab=analysis', settle: 2500 },
  { name: 'instructor-students', path: '/instructor?tab=students' },
  { name: 'instructor-database', path: '/instructor?tab=database', settle: 1800 },
  { name: 'instructor-people', path: '/instructor?tab=people', settle: 1800 },
  { name: 'cadre-requests', path: '/cadre?tab=requests' },
  { name: 'cadre-analysis', path: '/cadre?tab=analysis', settle: 2500 },
  { name: 'form-creator', path: '/instructor/create/new', settle: 1800 },
  { name: 'form-editor', path: '/instructor/create/req_demo', settle: 1800 },
  { name: 'admin', path: '/admin', settle: 1800 },
  { name: 'admin-invite', path: '/admin/invite', settle: 1500 },
  { name: 'settings', path: '/settings', settle: 1500 },
  { name: 'setup', path: '/setup?rerun=1', settle: 1200 },
  { name: 'join', path: '/join', settle: 1200 },
];

for (const viewport of WIDTHS) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: theme,
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await seed(page);
    // Everything below runs as a commander, so the restricted screens render.
    await page.evaluate((t) => {
      const s = JSON.parse(sessionStorage.getItem('nine31.session.v1'));
      s.roles = ['commander', 'admin'];
      sessionStorage.setItem('nine31.session.v1', JSON.stringify(s));
      const saved = JSON.parse(localStorage.getItem('nine31.settings.v1') || '{}');
      localStorage.setItem('nine31.settings.v1', JSON.stringify({ ...saved, theme: t }));
    }, theme);

    for (const screen of SCREENS) {
      await page.goto(`${BASE}#${screen.path}`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(screen.settle || 900);
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

      const results = await page.evaluate(AUDIT);
      for (const { kind, detail } of results) {
        // Touch-target size only matters where there is a touch.
        if (kind === 'small-target' && viewport.name !== 'phone') continue;
        report(screen.name, viewport.name, theme, kind, detail);
      }

      if (SHOTS) {
        await page.screenshot({
          path: `${SHOTS}/${screen.name}-${viewport.name}-${theme}.png`,
          fullPage: true,
        });
      }
    }

    for (const message of pageErrors) {
      report('(any)', viewport.name, theme, 'page-error', message);
    }
    await ctx.close();
  }
}

await browser.close();

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

/** Faults serious enough to fail the build rather than merely be listed. */
const FAILING = new Set([
  'page-scrolls-sideways', 'past-right-edge', 'past-left-edge',
  'svg-unsized', 'controls-overlap', 'text-clipped-x', 'text-clipped-y',
  'body-transparent', 'page-error',
]);

const byKind = new Map();
for (const f of findings) {
  if (!byKind.has(f.kind)) byKind.set(f.kind, []);
  byKind.get(f.kind).push(f);
}

if (!findings.length) {
  console.log('\nNo layout faults found.');
} else {
  for (const [kind, group] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${FAILING.has(kind) ? 'FAIL' : 'note'}  ${kind} (${group.length})`);
    // The same fault usually repeats across widths and themes; show it once
    // with where it appears, so the list stays readable.
    const unique = new Map();
    for (const f of group) {
      const key = `${f.screen}|${f.detail}`;
      if (!unique.has(key)) unique.set(key, { ...f, where: [] });
      unique.get(key).where.push(`${f.viewport}/${f.theme}`);
    }
    for (const f of [...unique.values()].slice(0, 12)) {
      console.log(`      ${f.screen} [${f.where.join(', ')}]`);
      console.log(`        ${f.detail}`);
    }
    if (unique.size > 12) console.log(`      … and ${unique.size - 12} more`);
  }
}

if (SHOTS) console.log(`\nScreenshots in ${SHOTS}/`);

const failed = findings.filter((f) => FAILING.has(f.kind));
console.log(failed.length
  ? `\n${failed.length} layout fault(s) that should fail a build.`
  : '\nNothing that should fail a build.');
process.exit(failed.length ? 1 : 0);
