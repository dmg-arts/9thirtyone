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

/**
 * The two places the version is written, and why they are not one place.
 *
 * `js/config.js` is what the running app reports in Settings and stamps into
 * every record it writes. `package.json` is what the PDF builders interpolate
 * into a cover. Nothing connected them, so they drifted: config.js reached
 * 1.0.14 while package.json stayed at 1.0.13, and the covers of three shipped
 * guides went four and eight releases stale without anything going red.
 *
 * Both build scripts already carry a comment saying this exact failure happened
 * once before, when the version was typed into the cover by hand. This is the
 * check that was missing.
 */
check('package.json and js/config.js state the same version', () => {
  const pkg = /"version":\s*"([^"]+)"/.exec(read('package.json'));
  const app = /version:\s*'([^']+)'/.exec(read('js/config.js'));
  if (!pkg) throw new Error('no version in package.json');
  if (!app) throw new Error('no version in js/config.js');
  if (pkg[1] !== app[1]) {
    throw new Error(`package.json says ${pkg[1]}, js/config.js says ${app[1]} `
      + '— the PDF covers are built from package.json');
  }
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

/*
 * The Client ID is written out in three places: the shared default in
 * `js/config.js`, the Script Properties table in the setup guide, and
 * `docs/SETUP-VALUES.md`, which exists so it can be copied rather than retyped.
 * A 72-character string that has to be transcribed by hand is exactly the kind
 * of value that goes wrong silently — a wrong Client ID sets up cleanly and
 * fails at the first cadet submission, by which point nobody is looking at the
 * setup guide any more. So the copy must equal the code, and nothing but a test
 * can keep it so.
 */
check('the paste-able Client ID matches the one in js/config.js', () => {
  const inCode = /'([\w-]+\.apps\.googleusercontent\.com)'/.exec(CONFIG);
  if (!inCode) throw new Error('could not read the Client ID from js/config.js');
  for (const path of ['docs/SETUP-VALUES.md', 'tools/docs/setup-guide.html']) {
    const found = read(path).match(/[\w-]+\.apps\.googleusercontent\.com/g) || [];
    if (!found.length) throw new Error(`${path} no longer states a Client ID`);
    const wrong = found.filter((id) => id !== inCode[1]);
    if (wrong.length) {
      throw new Error(`${path} states ${wrong[0]}; js/config.js has ${inCode[1]}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. counts of things that are in the repository
 * ------------------------------------------------------------------ */

const docsEntries = readdirSync(join(ROOT, 'docs'), { withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.startsWith('.'))
  // `.pages` sources are the author's own working files, kept beside the PDFs
  // they produced and gitignored. They are on his disk and in nobody else's
  // checkout, so counting them would make this check pass here and fail on a
  // fresh clone — the worst shape a test can take.
  .filter((e) => !e.name.endsWith('.pages'));

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
    const text = read(site);
    for (const m of text.matchAll(/(\w+\s+)?\b(two|three|four|five|six)\s+(?:\*\*)?PDFs/gi)) {
      // "the other three PDFs" is a subset, not a total, and a quoted "two PDFs"
      // is usually a document recording what it used to say wrongly — a habit
      // worth keeping rather than one to design around.
      const preceding = (m[1] || '').trim().toLowerCase();
      if (preceding === 'other' || preceding === 'remaining') continue;
      const quoted = text.slice(Math.max(0, m.index - 2), m.index).includes('"');
      if (quoted) continue;
      if (m[2].toLowerCase() !== word) wrong.push(`${site}: "${m[2]} PDFs"`);
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

/**
 * Every document a person outside this repo might read. Distinct from STRINGS,
 * which is `js/` string literals only — the spelling check above cannot see a
 * single word of the prose, which is how `centralized` survived in two
 * cadre-facing documents through fourteen releases.
 */
const USER_DOCS = [
  'docs/WHY.md', 'about.html', 'privacy.html', 'terms.html',
  'tools/docs/overview.html', 'tools/docs/how-to-guide.html',
  'tools/docs/user-introduction.html', 'tools/docs/setup-guide.html',
  'README.md', 'tools/proxy/README.md',
];

check('no document offers the submission server as optional', () => {
  // It stopped being optional when `drive.file` made a join link depend on it:
  // a device that did not create the folder cannot reach it, so without the
  // server there is no way to set anyone else up (setup guide Part 6).
  // Documents went on hedging it for several releases afterwards — privacy.html
  // in two places, README.md in a section opening — and a hedge here is not a
  // style problem. It tells a detachment the step it can least afford to skip
  // is a matter of taste.
  //
  // Literals rather than a window around "optional": that word appears
  // legitimately beside CSV columns and roster fields, and a proximity search
  // flagged every one of them.
  const hedges = [
    'if your organisation deployed one',
    'if your organisation has deployed',
    'where an organisation has deployed',
    'if a detachment deploys',
    'if one is deployed',
    'optional, and the setting',
  ];
  const hits = [];
  for (const doc of USER_DOCS) {
    const text = read(doc).toLowerCase();
    for (const hedge of hedges) {
      if (text.includes(hedge)) hits.push(`"${hedge}" in ${doc}`);
    }
  }
  if (hits.length) throw new Error(hits.join('; '));
});

check('the documents that explain access say the folder is shared with nobody', () => {
  // The positive half of the check above, and the more durable one: banning
  // phrasings only catches the wording that happened to be used last time.
  //
  // This is the claim crawl A found inverted in the setup guide, which had told
  // administrators to "confirm the folder is shared with the right people".
  // Under `drive.file` sharing the folder grants raw Drive access to every
  // response — it does not grant access to the app, which is what a reader
  // would assume it was for. These three documents are where someone decides
  // whether to share it.
  const required = ['privacy.html', 'README.md', 'tools/docs/setup-guide.html'];
  const missing = required.filter((doc) => !/shared with nobody/i.test(read(doc)));
  if (missing.length) {
    throw new Error(`no "shared with nobody" statement in ${missing.join(', ')}`);
  }
});

check('document prose is spelled en-GB', () => {
  // STYLE.md §1. The existing spelling check reads `js/` string literals, so no
  // amount of US spelling in the prose could ever trip it.
  // `centraliz` is a stem: settled Oct 2026 (STYLE.md §1 note 5) as our own
  // description rather than an AFROTC term being quoted.
  // Scoped away from URLs and HTML tokens by excluding the two contexts where a
  // z-spelling is specified by someone else: `autocomplete="organization"` and
  // anything inside a link target.
  const words = ['anonymized', 'organization', 'authorized', 'recognize', 'centraliz',
    'standardiz'];
  const hits = [];
  for (const doc of USER_DOCS) {
    const text = read(doc)
      .replace(/https?:\/\/[^\s"'<>)]+/g, '')
      .replace(/autocomplete="organization"/g, '');
    for (const word of words) {
      const m = new RegExp(`\\w*${word}\\w*`, 'gi').exec(text);
      if (m) hits.push(`"${m[0]}" in ${doc}`);
    }
  }
  if (hits.length) throw new Error(hits.join('; '));
});

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

/* ------------------------------------------------------------------ *
 * 6. documents that promise to date their own changes
 *
 * privacy.html section 11 and terms.html section 13 both say the date at the top
 * of the page moves whenever the document changes. For 32 days privacy.html
 * broke that promise about itself: 7860cf7 added the email disclosure and left
 * "3 September 2026" in place.
 *
 * This is the first check here whose source of truth is git history rather than
 * the code or a built artefact. That is deliberate. The alternative — a committed
 * file of expected hashes — would be a second copy of the expectation, which the
 * header of this file rejects, and would be the first of its kind in the repo.
 * Git already knows when the prose changed and stores nothing extra to say so.
 *
 * It does not contradict the header's "cannot catch a sentence that was true when
 * it was written". This catches an *undated change*, never staleness: a document
 * nobody has touched in a year passes, correctly.
 *
 * The rule is "the stated date must not be older than the day the prose last
 * changed", and the "day" matters. The obvious rule — prose changed since the
 * date last moved — was measured against the real history of both files and
 * produces four false alarms, because the four commits of 31 Aug 2026 each edited
 * prose on the day the date already said 31 August. Those documents were right.
 * ------------------------------------------------------------------ */

const DATE_MARK = /<!--DATE-->([^<]*)<!--\/DATE-->/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/**
 * A document reduced to the words a person reads, so that a change which only a
 * machine can see does not demand a new date.
 *
 * The date itself goes first, or moving it would read as a change to the prose it
 * is supposed to be dating. `<style>` goes too: a colour token is not a policy.
 * Entities are decoded so `&mdash;` and an em dash compare equal, and `&amp;`
 * decodes last so `&amp;mdash;` cannot turn into a dash. Collapsing whitespace at
 * the end is what makes a rewrap invisible.
 */
function prose(html) {
  return html
    .replace(DATE_MARK, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&rsquo;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "14 October 2026" -> "2026-10-14", sortable as a string. */
function statedDate(html, path) {
  const m = DATE_MARK.exec(html);
  if (!m) throw new Error(`${path} has no <!--DATE--> marker`);
  const parts = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(m[1].trim());
  if (!parts) throw new Error(`${path} states "${m[1].trim()}", which is not "D Month YYYY"`);
  const month = MONTHS.indexOf(parts[2].toLowerCase());
  if (month < 0) throw new Error(`${path} names no month: "${parts[2]}"`);
  return `${parts[3]}-${String(month + 1).padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
}

check('the legal pages are dated no earlier than their last change', () => {
  let git = true;
  try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'ignore' }); }
  catch { git = false; }
  if (!git) { console.log('       (not a git checkout — document dates not checked)'); return; }

  const run = (args) => execFileSync('git', args,
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  const today = new Date().toISOString().slice(0, 10);
  const wrong = [];

  for (const path of ['privacy.html', 'terms.html']) {
    const live = read(path);
    const stated = statedDate(live, path);

    // An uncommitted edit has no commit date to compare against, so it is dated
    // today. This is the branch that fires while the change is still being made,
    // which is the only moment the fix is free.
    if (prose(live) !== prose(run(['show', `HEAD:${path}`]))) {
      if (stated < today) {
        wrong.push(`${path} says "${stated}" but its prose has uncommitted changes — date it ${today}`);
      }
      continue;
    }

    // Newest first. The commit that changed the prose is the newest one whose
    // prose differs from the commit before it; `git log -- <path>` lists only
    // commits that touched the file, so the next entry is the right comparison.
    const shas = run(['log', '--format=%H', '--', path]).trim().split('\n');
    let changed = shas[shas.length - 1];
    for (let i = 0; i < shas.length - 1; i++) {
      if (prose(run(['show', `${shas[i]}:${path}`])) !== prose(run(['show', `${shas[i + 1]}:${path}`]))) {
        changed = shas[i];
        break;
      }
    }
    const when = run(['log', '-1', '--format=%ad', '--date=short', changed]).trim();
    if (stated < when) {
      const subject = run(['log', '-1', '--format=%h %s', changed]).trim();
      wrong.push(`${path} says "${stated}" but its prose last changed ${when} (${subject})`);
    }
  }

  if (wrong.length) throw new Error(wrong.join('; '));
});

console.log(failures
  ? `\n${failures} documentation check(s) failed.`
  : '\nThe documents agree with the code.');
process.exit(failures ? 1 : 0);
