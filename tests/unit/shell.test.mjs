/**
 * The offline shell: what the service worker promises to have cached.
 *
 *     npm run test:unit
 *
 * `service-worker.js` lists every served file by path, and the app loads ES
 * modules directly with no bundler — so a module missing from that list is a
 * module the browser cannot resolve offline. The failure is total rather than
 * partial: the shell paints, the module graph fails to resolve, and the app does
 * not start.
 *
 * That is not hypothetical. `js/people-scope.js` was added on 29 August and was
 * never added here, so offline boot was broken for six releases while the whole
 * suite stayed green. Nothing caught it because nothing looked: the list is data,
 * and data with no test rots silently.
 *
 * This is deliberately a file-existence check rather than a behavioural one. The
 * behaviour — does it actually boot with the network off — belongs in a browser,
 * but the mistake that breaks it is always the same one, and it is catchable here
 * in milliseconds.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
    throw new Error(`not in SHELL, so unreachable offline: ${missing.join(', ')}`);
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

console.log(failures ? `\n${failures} shell check(s) failed.` : '\nThe offline shell is complete.');
process.exit(failures ? 1 : 0);
