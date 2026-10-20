/**
 * Renders the request-flow diagram: a static image and a looping GIF.
 *
 *     node tools/docs/build-flow-gif.mjs
 *
 * Both come from one source, tools/docs/flow-diagram.html, so the picture on a
 * slide and the picture in a handout cannot disagree. Needs ffmpeg.
 *
 * The diagram answers "why does it take a moment", which is a different question
 * from the data-flow diagram in overview.html — that one answers "where does my
 * answer go". It exists because the honest explanation of the delay is also the
 * best argument for the design: a cadet's phone is never given the detachment's
 * Drive, so the server does every read and write on its behalf, one file at a
 * time. "It is slow because it is protecting you" survives being repeated by a
 * cadet to another cadet. "Dave said it is kind of slow" does not.
 *
 * Frames are driven by hand rather than captured while the animation runs: a
 * paused animation with a negative delay sits at an exact point in its cycle, so
 * each frame lands where it was meant to instead of wherever the screenshot
 * happened to catch it.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = 'tools/docs/flow-diagram.html';
const OUT_DIR = process.argv[2] || 'docs/graphics';
const WIDTH = 1600;
const SECONDS = 5;        // one lap, matched to a spoken beat per station
const FPS = 15;           // plenty for a single moving dot, and keeps it small

mkdirSync(OUT_DIR, { recursive: true });
const frames = mkdtempSync(join(tmpdir(), 'flow-'));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });

try {
  // --- static ---
  const still = await browser.newContext({
    viewport: { width: WIDTH, height: 560 }, deviceScaleFactor: 2,
  });
  const sp = await still.newPage();
  await sp.goto(`file://${process.cwd()}/${SRC}`, { waitUntil: 'networkidle' });
  const height = await sp.evaluate(
    () => Math.ceil(document.querySelector('.stage').getBoundingClientRect().bottom) + 24);
  await sp.setViewportSize({ width: WIDTH, height });
  await sp.screenshot({ path: join(OUT_DIR, 'request-flow.png') });
  await still.close();

  // --- frames ---
  const motion = await browser.newContext({
    viewport: { width: WIDTH, height }, deviceScaleFactor: 1,
  });
  const mp = await motion.newPage();
  await mp.goto(`file://${process.cwd()}/${SRC}`, { waitUntil: 'networkidle' });
  await mp.addStyleTag({
    content: '.run #pulse, .run #checks, .run #tolls { animation-play-state: paused !important; }',
  });
  await mp.evaluate(() => document.body.classList.add('run'));

  const total = SECONDS * FPS;
  for (let i = 0; i < total; i += 1) {
    await mp.evaluate((delay) => {
      for (const el of document.querySelectorAll('#pulse, #checks, #tolls')) {
        el.style.animationDelay = `-${delay}s`;
      }
    }, (i / total) * SECONDS);
    await mp.screenshot({ path: join(frames, `f${String(i).padStart(3, '0')}.png`) });
  }
  await motion.close();

  // --- gif ---
  // A shared 64-colour palette with dithering off: the source is flat vector, so
  // dithering only adds noise and bytes to areas that are a single colour.
  execFileSync('ffmpeg', [
    '-y', '-framerate', String(FPS), '-i', join(frames, 'f%03d.png'),
    '-vf', `fps=${FPS},scale=1200:-1:flags=lanczos,split[s0][s1];`
         + '[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=none',
    '-loop', '0', join(OUT_DIR, 'request-flow.gif'),
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

  console.log(`request-flow.png and request-flow.gif (${SECONDS}s, ${total} frames) -> ${OUT_DIR}`);
} finally {
  await browser.close();
  rmSync(frames, { recursive: true, force: true });
}
