/**
 * Stamps Code.gs with a fingerprint of its own contents.
 *
 *     node tools/proxy/stamp.mjs
 *
 * `doGet` reports it alongside PROXY_VERSION, so a redeploy is verifiable even
 * when the version has not moved — which is every build between releases, and
 * is why "I pasted it" and "it is deployed" looked identical on 29 Oct.
 *
 * The marker is excluded from its own hash, by normalising the BUILD line
 * before hashing. Otherwise writing the value would change the content it was
 * computed from and no fixed point would exist.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'Code.gs');
const LINE = /^var BUILD = '[^']*';$/m;

export function fingerprint(source) {
  if (!LINE.test(source)) return null;
  const normalised = source.replace(LINE, "var BUILD = '';");
  return createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 8);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const source = readFileSync(FILE, 'utf8');
  const stamp = fingerprint(source);
  if (!stamp) {
    console.error('Code.gs has no `var BUILD = \'…\';` line to stamp.');
    process.exit(1);
  }
  const current = /^var BUILD = '([^']*)';$/m.exec(source)[1];
  if (current === stamp) {
    console.log(`already stamped ${stamp}`);
  } else {
    writeFileSync(FILE, source.replace(LINE, `var BUILD = '${stamp}';`));
    console.log(`stamped ${current || '(empty)'} -> ${stamp}`);
  }
}
