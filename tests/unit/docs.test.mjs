/**
 * Documentation against the code it describes.
 *
 *     npm run test:unit
 *
 * Written after a week in which several documents turned out to state things that
 * had quietly stopped being true: a setup procedure removed from the product, a
 * disclosure threshold restated in eight places, a folder tree drawn three
 * different ways, and an instruction telling cadets to click past a warning that
 * no longer appears.
 *
 * WHAT THIS CANNOT DO, said plainly so nobody reads green as correct:
 *
 *   - **It cannot check a claim about the world.** "Installed and run on macOS,
 *     iPhone and Windows" is either true or it is not, and no program knows which.
 *   - **It cannot catch a sentence that was true when it was written.** The join
 *     copy telling cadets to expect an unverified-app warning was correct for
 *     months. What caught it was a person reading old words and knowing they had
 *     expired. Nothing here would have fired.
 *   - **It cannot detect contradiction in general.** Every disagreement that
 *     prompted this file needed a human to know which side was authoritative:
 *     "25 minutes" against "about an hour" is only a bug once you know which is
 *     right. What it can do is compare prose against a value in the code, which is
 *     a much narrower thing that happens to cover most of the damage.
 *
 * So this catches divergence from code, and reintroduction. It does not catch
 * prose going stale on its own, and a green run is not a reviewed document.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

/* ------------------------------------------------------------------ *
 * string literals
 *
 * The banned-phrase checks run against what the app *says*, never against its
 * source text. Grepping the file would flag `getDirectoryHandle` for the word
 * "Handle" and every URL for "//". A small scanner is the honest way: it walks
 * the file once, tracks whether it is inside a string, a comment or neither, and
 * returns only the string contents.
 * ------------------------------------------------------------------ */

function stringLiterals(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let value = '';
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { value += source[i + 1] ?? ''; i += 2; continue; }
        value += source[i];
        i++;
      }
      i++;
      out.push(value);
    } else i++;
  }
  return out;
}

/** Every string the app could put in front of a person. */
function appStrings() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) files.push(path);
    }
  };
  walk('js');
  return files.flatMap((path) => stringLiterals(read(path)).map((text) => ({ path, text })));
}

const STRINGS = appStrings();
const saying = (phrase) => STRINGS.filter(
  (s) => s.text.toLowerCase().includes(phrase.toLowerCase()));

/* ------------------------------------------------------------------ *
 * 1. numbers stated in prose that come from the code
 * ------------------------------------------------------------------ */

const CONFIG = read('js/config.js');
const numberFrom = (pattern, label) => {
  const m = pattern.exec(CONFIG);
  if (!m) throw new Error(`could not read ${label} from js/config.js`);
  return Number(m[1]);
};

const THRESHOLD = numberFrom(/minResponsesToShow:\s*(\d+)/, 'minResponsesToShow');
const COMMANDERS = numberFrom(/MAX_COMMANDERS\s*=\s*(\d+)/, 'MAX_COMMANDERS');

const WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
  7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 12: 'twelve' };

check('every document states the disclosure threshold as the code has it', () => {
  // The product's central privacy promise, and STYLE.md §4 forbids softening it.
  // Matched in context rather than as a bare digit: a repo-wide search for "3"
  // would be noise, and a document that stopped stating the number at all is a
  // different failure, caught by the site list below.
  const word = WORDS[THRESHOLD];
  const sites = [
    'docs/WHY.md', 'docs/STYLE.md', 'about.html', 'privacy.html', 'terms.html',
    'tools/docs/overview.html', 'tools/docs/how-to-guide.html',
    'tools/docs/user-introduction.html', 'tools/docs/setup-guide.html',
  ];
  const wrong = [];
  for (const site of sites) {
    const text = read(site);
    const near = [...text.matchAll(/(\w+)[\s<>/a-z"=]{0,40}responses?\b/gi)]
      .map((m) => m[1].toLowerCase())
      .filter((w) => w in Object.fromEntries(Object.values(WORDS).map((v) => [v, 1]))
        || /^\d+$/.test(w));
    const stated = near.filter((w) => w !== word && w !== String(THRESHOLD));
    if (!text.toLowerCase().includes(`${word} response`)
        && !text.toLowerCase().includes(`${word} people`)
        && !text.toLowerCase().includes(`${word}</strong> response`)) {
      wrong.push(`${site}: does not state "${word}"`);
    } else if (stated.length) {
      // A different number next to the word "responses" is the drift worth seeing.
      const suspicious = stated.filter((w) => w !== 'no' && w !== 'the');
      if (suspicious.length) wrong.push(`${site}: also says "${suspicious[0]} responses"`);
    }
  }
  if (wrong.length) throw new Error(wrong.join('; '));
});

check('the commander cap in prose matches MAX_COMMANDERS', () => {
  const word = WORDS[COMMANDERS];
  const sites = ['docs/WHY.md', 'docs/ROSTER-FORMAT.md', 'README.md',
    'tools/docs/setup-guide.html', 'tools/proxy/README.md'];
  const wrong = sites.filter((site) => {
    const t = read(site).toLowerCase();
    return !(t.includes(`at most ${word}`) || t.includes(`maximum ${word}`)
      || t.includes(`cap of ${word}`) || t.includes(`capped at ${word}`)
      || t.includes(`${word} commanders`));
  });
  if (wrong.length) throw new Error(`no "${word}" commander cap in: ${wrong.join(', ')}`);
});

check('the session length in prose matches SESSION_MS', () => {
  const ms = /SESSION_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*60/.exec(read('js/session.js'));
  if (!ms) throw new Error('could not read SESSION_MS from js/session.js');
  const hours = Number(ms[1]);
  const word = WORDS[hours] || String(hours);
  if (!read('README.md').toLowerCase().includes(`sessions last ${word} hours`)) {
    throw new Error(`README does not say sessions last ${word} hours`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. counts of things that are in the repository
 * ------------------------------------------------------------------ */

const docsEntries = readdirSync(join(ROOT, 'docs'), { withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.startsWith('.'));

check('the README states how many things are in docs/', () => {
  const readme = read('README.md');
  const m = /`docs\/` holds (\w+) things/.exec(readme);
  if (!m) throw new Error('the README no longer states a docs/ count');
  const words = Object.fromEntries(Object.entries({
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  }));
  const claimed = words[m[1]] ?? Number(m[1]);
  if (claimed !== docsEntries.length) {
    throw new Error(`README says ${m[1]} (${claimed}); docs/ holds ${docsEntries.length}`);
  }
});

check('every document agrees how many PDFs there are', () => {
  const pdfs = docsEntries.filter((e) => e.name.endsWith('.pdf')).length;
  const word = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' }[pdfs];
  const wrong = [];
  for (const site of ['README.md', 'tools/docs/README.md', '.gitignore']) {
    for (const m of read(site).matchAll(/\b(two|three|four|five|six)\s+(?:\*\*)?PDFs/gi)) {
      if (m[1].toLowerCase() !== word) wrong.push(`${site}: "${m[1]} PDFs"`);
    }
  }
  if (wrong.length) throw new Error(`${pdfs} PDFs exist, but ${wrong.join('; ')}`);
});

check('stated PDF page counts match the built files', () => {
  let pdfinfo = true;
  try { execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' }); } catch { pdfinfo = false; }
  if (!pdfinfo) { console.log('       (pdfinfo not installed — page counts not checked)'); return; }

  const pages = (file) => Number(
    /Pages:\s*(\d+)/.exec(execFileSync('pdfinfo', [join(ROOT, file)], { encoding: 'utf8' }))[1]);
  const readme = read('README.md');
  const claims = [
    ['docs/9ThirtyOne-Setup-Guide.pdf', /`9ThirtyOne-Setup-Guide\.pdf`[^|]*\|[^|]*\| (\d+) pages/],
    ['docs/9ThirtyOne-How-To-Guide.pdf', /`9ThirtyOne-How-To-Guide\.pdf`[^|]*\|[^|]*\| (\d+) pages/],
    ['docs/9ThirtyOne-Introduction.pdf', /`9ThirtyOne-Introduction\.pdf`[^|]*\|[^|]*\| (\d+) slides/],
    ['docs/9ThirtyOne-User-Introduction.pdf', /`9ThirtyOne-User-Introduction\.pdf`[^|]*\|[^|]*\| (\d+) slides/],
  ];
  const wrong = [];
  for (const [file, pattern] of claims) {
    const m = pattern.exec(readme);
    if (!m) { wrong.push(`${file}: the README no longer states a page count`); continue; }
    const actual = pages(file);
    if (Number(m[1]) !== actual) wrong.push(`${file}: README says ${m[1]}, file has ${actual}`);
  }
  if (wrong.length) throw new Error(wrong.join('; '));
});

check('the project layout lists every module that exists', () => {
  const readme = read('README.md');
  const modules = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith('.js')) modules.push(entry.name);
    }
  };
  walk('js');
  const missing = modules.filter((name) => !readme.includes(name));
  if (missing.length) {
    throw new Error(`absent from the layout block: ${missing.sort().join(', ')}`);
  }
});

/* ------------------------------------------------------------------ *
 * 3. the folder tree, against the constant that decides it
 * ------------------------------------------------------------------ */

check('every drawing of the folder tree matches DB_LAYOUT.folders', () => {
  const block = CONFIG.slice(CONFIG.indexOf('folders: {'), CONFIG.indexOf('};', CONFIG.indexOf('folders: {')));
  const real = [...block.matchAll(/^\s+\w+:\s*'([^']+)'/gm)].map((m) => m[1]).sort();
  // Created on first write, so absent from a fresh folder. Allowed to appear in a
  // drawing, never required — see ensurePath in js/storage/drive.js.
  const LAZY = ['cadre', 'commander'];

  const drawn = (text, from) => {
    const tree = text.slice(text.indexOf('9ThirtyOne/', from));
    return [...tree.slice(0, tree.indexOf('archive/') + 20).matchAll(/[├└]──\s+(\w+)\//g)]
      .map((m) => m[1]);
  };

  const wrong = [];
  for (const [label, text] of [
    ['README.md', read('README.md')],
    ['tools/docs/setup-guide.html', read('tools/docs/setup-guide.html')],
    ['FOLDER_TREE_PREVIEW', CONFIG],
  ]) {
    const names = drawn(text, 0);
    if (!names.length) { wrong.push(`${label}: no tree found`); continue; }
    const missing = real.filter((f) => !names.includes(f));
    const extra = names.filter((f) => !real.includes(f) && !LAZY.includes(f));
    if (missing.length) wrong.push(`${label} omits ${missing.join(', ')}`);
    if (extra.length) wrong.push(`${label} invents ${extra.join(', ')}`);
  }
  if (wrong.length) throw new Error(wrong.join('; '));
});

check('responses are described as one folder per request, not per form', () => {
  // INDEXES.responsesFor is keyed by requestId. Both documents said "form".
  const wrong = ['README.md', 'tools/docs/setup-guide.html', 'js/config.js']
    .filter((site) => /responses\/[^\n]*one folder per form/.test(read(site)));
  if (wrong.length) throw new Error(`says "per form": ${wrong.join(', ')}`);
});

check('every symbol a document cites still exists in the file it names', () => {
  // STYLE.md used to cite code by line number — `js/storage/drive.js:36` — and two
  // of the three had drifted, one of them the same day, because a constant was
  // deleted from the file it named. Line numbers move under any edit above them;
  // a symbol only moves when someone renames it, which is exactly when the
  // citation should be revisited.
  //
  // So: cite `SYMBOL` in `path`, and this checks the symbol is really there.
  const docs = ['README.md', 'docs/STYLE.md', 'docs/WHY.md', 'docs/ROSTER-FORMAT.md',
    'tools/docs/README.md', 'tools/proxy/README.md'];
  const wrong = [];
  for (const doc of docs) {
    const text = read(doc);
    for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`[^.`\n]{0,40}?\bin `((?:js|tools|tests)\/[^`]+)`/g)) {
      const [, symbol, path] = m;
      const full = join(ROOT, path);
      if (!existsSync(full)) { wrong.push(`${doc}: ${path} does not exist`); continue; }
      // `tools/docs/` and the like are directories; a symbol is not in a directory.
      if (statSync(full).isDirectory()) continue;
      const bare = symbol.split('.').pop();
      if (!new RegExp(`\\b${bare}\\b`).test(read(path))) {
        wrong.push(`${doc}: "${symbol}" is not in ${path}`);
      }
    }
  }
  if (wrong.length) throw new Error(wrong.join('; '));
});

check('no document cites code by line number', () => {
  // They cannot be kept true. Any edit above the cited line silently invalidates
  // them, and nothing in a review catches that.
  const docs = ['README.md', 'docs/STYLE.md', 'docs/WHY.md', 'docs/ROSTER-FORMAT.md',
    'docs/ALPHA-TAGS.md', 'tools/docs/README.md', 'tools/proxy/README.md',
    'tools/docs/setup-guide.html', 'tools/docs/how-to-guide.html'];
  const wrong = [];
  for (const doc of docs) {
    for (const m of read(doc).matchAll(/\b([a-zA-Z0-9_/.-]+\.(?:js|gs|mjs)):(\d+)/g)) {
      wrong.push(`${doc}: ${m[0]} — cite the symbol instead`);
    }
  }
  if (wrong.length) throw new Error(wrong.join('; '));
});

/* ------------------------------------------------------------------ *
 * 4. terms the app must not use, and spellings it must
 * ------------------------------------------------------------------ */

check('the app avoids the terms STYLE.md bans', () => {
  // Only the rows that are unambiguous literals. The rest of that table is
  // conditional on meaning — "Form, when what is meant is one issued instance" —
  // and enforcing those produces about seven false alarms for every real one.
  const banned = ['Submission proxy', 'Affiliated schools', 'Dashboard', 'User list',
    'Privacy threshold', 'anonymity cutoff', 'Invite link', 'Teaching on Purpose'];
  const hits = banned.flatMap((phrase) =>
    saying(phrase).map((s) => `"${phrase}" in ${s.path}`));
  if (hits.length) throw new Error(hits.join('; '));
});

check('user-visible strings are spelled en-GB', () => {
  // STYLE.md §1 Spelling. Scoped to strings, so `organization` inside a URL or an
  // identifier cannot trip it.
  // js/analysis/lexicon.js is exempt, and not as a convenience: it holds the words
  // the safety screen matches *against what a cadet wrote*. Cadets type US
  // spellings, so "unauthorized" belongs in that list. It is input, not output —
  // the only file in js/ where that is true.
  // Spelled by a specification rather than by us. `autocomplete="organization"` is
  // an HTML token; changing it would break the browser's field matching. Exact
  // matches only, so it cannot hide a sentence that happens to contain the word.
  const SPEC_TOKENS = new Set(['organization']);

  const hits = ['anonymized', 'organization', 'authorized', 'recognize']
    .flatMap((word) => saying(word)
      .filter((s) => s.path !== 'js/analysis/lexicon.js')
      .filter((s) => !SPEC_TOKENS.has(s.text.trim()))
      .map((s) => `"${word}" in ${s.path}: ${s.text.slice(0, 60)}`));
  if (hits.length) throw new Error(hits.join('; '));
});

/* ------------------------------------------------------------------ *
 * 5. instructions the app must no longer give
 * ------------------------------------------------------------------ */

check('the app does not instruct anyone past a warning that no longer appears', () => {
  // The join mail and the join screen told every cadet to expect an unverified-app
  // warning and to choose Advanced. The app has been published and brand verified
  // since; that screen is gone, so the instruction sent people hunting for a
  // control that does not exist — and taught the habit of clicking past warnings.
  //
  // Scoped to strings in js/ on purpose. The same phrases in the documents are
  // almost all legitimate: "the unverified-app screen no longer applies" is a
  // negation, and a denylist cannot tell that from an instruction. Documents
  // narrate history. The app only ever instructs.
  const retired = ['not been verified', 'Choose Advanced', 'unverified app',
    'paste the folder link', 'add each cadre member as a test user'];
  const hits = retired.flatMap((phrase) =>
    saying(phrase).map((s) => `"${phrase}" in ${s.path}`));
  if (hits.length) throw new Error(hits.join('; '));
});

console.log(failures
  ? `\n${failures} documentation check(s) failed.`
  : '\nThe documents agree with the code.');
process.exit(failures ? 1 : 0);
