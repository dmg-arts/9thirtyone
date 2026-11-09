/**
 * The offline shell: what the service worker promises to have cached.
 *
 *     npm run test:unit
 *
 * `service-worker.js` lists every served file by path, and the app loads ES
 * modules directly with no bundler — so a module missing from that list has no
 * *guarantee* of being there offline.
 *
 * Worth being precise about the size of that, because it is easy to overstate.
 * `SHELL` is the precache, written at install. The fetch handler also caches any
 * same-origin file it successfully fetches, so a module left out of the list
 * still lands in the cache on the first online load that requests it — which for
 * `js/people-scope.js`, imported by `data-source.js`, is every load. Offline
 * reloads therefore worked in practice, and did while it was missing.
 *
 * The gap is the window after an update. `activate` deletes the previous cache,
 * so a freshly activated worker holds exactly `SHELL` and nothing else; anything
 * omitted is absent until one online load repopulates it. A device that goes
 * offline inside that window cannot resolve the module, and the failure is total
 * rather than partial — the shell paints and the app does not start.
 *
 * `js/people-scope.js` was added on 29 August and never added here, so that
 * window existed for six releases with the whole suite green. Nothing caught it
 * because nothing looked: the list is data, and data with no test rots silently.
 *
 * This is deliberately a file-existence check rather than a behavioural one. The
 * behaviour — does it actually boot with the network off — belongs in a browser,
 * but the mistake that breaks it is always the same one, and it is catchable here
 * in milliseconds.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SOURCE = readFileSync(new URL('../../service-worker.js', import.meta.url), 'utf8');
const ROOT = new URL('../../', import.meta.url).pathname;

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

/**
 * Scoped to the SHELL array. Matching './…' across the whole file would also
 * catch the navigation fallback and any path named in a comment, and a check
 * that quietly passes on the wrong text is worse than no check.
 */
const SHELL_BLOCK = SOURCE.slice(
  SOURCE.indexOf('const SHELL = ['),
  SOURCE.indexOf('];', SOURCE.indexOf('const SHELL = [')));

const listed = new Set(
  [...SHELL_BLOCK.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean));

/** Every .js under js/, recursively, as repo-relative paths. */
function modules(dir = 'js') {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...modules(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out.sort();
}

check('every module under js/ is precached', () => {
  const missing = modules().filter((path) => !listed.has(path));
  if (missing.length) {
    throw new Error('not precached, so absent from a freshly activated cache until '
      + `an online load fetches it: ${missing.join(', ')}`);
  }
});

check('every precached path exists on disk', () => {
  // A stale entry is the quieter half of the same fault: install() catches per
  // URL, so a path that no longer exists fails silently and forever.
  const ghosts = [...listed].filter((path) => !existsSync(join(ROOT, path)));
  if (ghosts.length) throw new Error(`listed but absent: ${ghosts.join(', ')}`);
});

check('the served pages are precached', () => {
  const pages = ['index.html', 'about.html', 'privacy.html', 'terms.html', 'manifest.json'];
  const missing = pages.filter((page) => !listed.has(page));
  if (missing.length) throw new Error(`served but not cached: ${missing.join(', ')}`);
});

check('the icons the app declares are precached', () => {
  // index.html and manifest.json name these; without them a first offline launch
  // has no icon, which is the most visible part of an installed app.
  const declared = new Set();
  for (const file of ['index.html', 'manifest.json']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/icons\/[A-Za-z0-9._-]+/g)) declared.add(m[0]);
  }
  const missing = [...declared].filter((path) => !listed.has(path));
  if (missing.length) throw new Error(`declared but not cached: ${missing.join(', ')}`);
});

check('the cache version is a version, and rolls', () => {
  const m = /const CACHE_VERSION = '([^']+)'/.exec(SOURCE);
  if (!m) throw new Error('CACHE_VERSION is not declared as a literal');
  if (!/^v\d+$/.test(m[1])) throw new Error(`CACHE_VERSION is "${m[1]}", expected vN`);
});

/* ------------------------------------------------------------------ *
 * the bump, enforced
 * ------------------------------------------------------------------ */

/**
 * A shipped `SHELL` change on an unchanged `CACHE_VERSION` is the most
 * expensive mistake this repo can make, and the only one that is invisible
 * while it is happening.
 *
 * `activate` purges the old cache only when the cache *name* changes, and the
 * name is built from CACHE_VERSION. Ship a changed module without a bump and
 * stale-while-revalidate serves the old file once more before replacing it, so
 * clients run a mixed build: new HTML (navigations are network-first) against
 * old JS. Meanwhile `updateButton()` decides on `updatefound`, which never
 * fires, so Settings reports "You are on the latest version" — the opposite of
 * the truth. Nobody reports it because every screen says it is fine.
 *
 * So this compares the working tree against the last release tag: if any path
 * the worker precaches has moved, CACHE_VERSION must have moved too. It is
 * deliberately not "a bump in every commit" — the artifact is what ships, and
 * one bump anywhere in a release satisfies the invariant for the whole release.
 */
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

check('a changed SHELL path since the last release carries a CACHE_VERSION bump', () => {
  let tag;
  try {
    // Release tags only. A lightweight tag on a scratch commit would silently
    // become the baseline and make this check compare against nothing.
    tag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
  } catch {
    // No git, or no tags yet: say so rather than passing. A check that cannot
    // run is not a check that passed, and this one is too easy to lose.
    throw new Error('no release tag found, so the bump cannot be verified against one');
  }

  const released = /const CACHE_VERSION = '([^']+)'/.exec(git('show', `${tag}:service-worker.js`));
  if (!released) throw new Error(`${tag} has no CACHE_VERSION to compare against`);

  const current = /const CACHE_VERSION = '([^']+)'/.exec(SOURCE);

  // Tracked changes plus untracked additions: a brand new module added to SHELL
  // but not yet `git add`ed is invisible to diff, and is exactly the kind of
  // file that arrives with a release.
  const changed = new Set([
    ...git('diff', '--name-only', tag, '--').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean));

  const moved = [...listed].filter((path) => changed.has(path));
  // The worker itself is not in its own SHELL list, and a change to it rolls
  // every client as surely as a changed module does.
  if (changed.has('service-worker.js')) moved.push('service-worker.js');

  if (moved.length && current[1] === released[1]) {
    throw new Error(
      `${moved.length} precached path(s) changed since ${tag} but CACHE_VERSION is still `
      + `"${released[1]}". Clients would run a mixed build and Settings would call it current. `
      + `Changed: ${moved.slice(0, 6).join(', ')}${moved.length > 6 ? ', …' : ''}`);
  }
});

console.log(failures ? `\n${failures} shell check(s) failed.` : '\nThe offline shell is complete.');
process.exit(failures ? 1 : 0);
