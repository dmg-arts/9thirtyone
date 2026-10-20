/**
 * A contact sheet of every captured screen, for picking images from.
 *
 *     node tools/docs/capture-perspectives.mjs docs/screens
 *     node tools/docs/build-contact-sheet.mjs
 *
 * Written because the sheet that used to live at docs/screens/*.pdf was made by
 * hand and nothing could rebuild it — so it aged silently against an app that
 * changed under it, and the capture script carries a comment warning people not
 * to delete it. A generated sheet is reproducible and cannot drift: rerun the
 * capture, rerun this, and the sheet is true again.
 *
 * Every image is labelled with the path you would hand to someone, so a person
 * choosing slides can name what they want rather than describing it.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC = process.argv[2] || 'docs/screens';
const OUT = process.argv[3] || 'docs/screens/9thirtyone-screens.pdf';

const groups = readdirSync(SRC, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let body = '';
let total = 0;
for (const group of groups) {
  const dir = join(SRC, group);
  const walk = (rel) => readdirSync(join(dir, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(rel, e.name))
      : (e.name.endsWith('.png') ? [join(rel, e.name)] : [])));
  const shots = walk('.').map((p) => p.replace(/^\.\//, '')).sort();
  if (!shots.length) continue;

  body += `<section><h2>${group}</h2>\n`;
  for (const shot of shots) {
    total += 1;
    body += `  <figure><img src="SHOT[${group}/${shot}]" alt="${group}/${shot}">`
      + `<figcaption>${group}/${shot}</figcaption></figure>\n`;
  }
  body += '</section>\n';
}

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>9ThirtyOne — screens</title>
<style>
  @page { size: Letter landscape; margin: 12mm; @bottom-center { content: counter(page); } }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
         color: #14181f; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  section { page-break-before: always; }
  section:first-of-type { page-break-before: auto; }
  h2 { font-size: 15pt; margin: 0 0 4mm; padding-bottom: 2mm;
       border-bottom: 2px solid #1c4f8b; font-family: "SF Mono", Menlo, monospace; }
  /* Two to a page. Unconstrained, a 1240x900 capture is taller than a landscape
     page once its caption is added, so every figure took a page and left most of
     the next one blank — 104 pages for 48 screens. */
  figure { margin: 0 0 5mm; page-break-inside: avoid; text-align: center; }
  img { max-height: 76mm; max-width: 100%; width: auto;
        border: 1px solid #d8dee8; border-radius: 2mm; display: inline-block; }
  figcaption { font-size: 8pt; font-family: "SF Mono", Menlo, monospace;
               color: #4d5866; margin-top: 1.5mm; }
</style></head>
<body>
<h1 style="font-size:20pt;margin:0 0 2mm">9ThirtyOne — captured screens</h1>
<p style="margin:0 0 6mm;color:#4d5866;font-size:10pt">${total} screens, by role.
Captions are the paths to ask for.</p>
${body}</body></html>`;

const tmp = 'tools/docs/.contact-sheet.html';
writeFileSync(tmp, html);
execFileSync('node', ['tools/docs/build-doc.mjs', tmp, OUT], { stdio: 'inherit' });
console.log(`contact sheet: ${total} screens -> ${OUT}`);
