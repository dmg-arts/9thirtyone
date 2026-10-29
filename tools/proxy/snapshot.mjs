/**
 * Archives the version going out, before PROXY_VERSION is bumped.
 *
 *     node tools/proxy/snapshot.mjs     # then edit PROXY_VERSION
 *
 * Run it BEFORE the bump, not after: the point is to keep the version being
 * replaced, so there is always a copy of what a detachment is actually running
 * without digging a tag out of git under pressure.
 *
 * The version is read out of the file rather than taken as an argument, so the
 * name cannot disagree with the contents — which is the only failure this
 * guards, and a silent one.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, 'Code.gs'), 'utf8');

const found = /var PROXY_VERSION = '([^']+)'/.exec(source);
if (!found) {
  console.error('Code.gs declares no PROXY_VERSION — refusing to name a snapshot after nothing.');
  process.exit(1);
}

const out = join(HERE, 'releases', `Code-${found[1]}.gs`);
mkdirSync(join(HERE, 'releases'), { recursive: true });
writeFileSync(out, source);
console.log(`wrote releases/Code-${found[1]}.gs — ${source.split('\n').length} lines`);
