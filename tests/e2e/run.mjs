/**
 * Starts a server, runs the end-to-end suite against it, and shuts it down.
 *
 *     npm run test:e2e
 *
 * Kept separate from the suite itself so the suite can also be pointed at a
 * server that is already running, which is faster when iterating:
 *
 *     python3 serve.py --port 8123 --no-open &
 *     node tests/e2e/app.test.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const PORT = process.env.PORT || '8123';
const BASE = `http://127.0.0.1:${PORT}/index.html`;

/*
 * Refuse to run against a server we did not start.
 *
 * `ready()` below only asks whether *something* answers on the port. If a stale
 * server from an earlier session is still listening, our own bind fails, that
 * check passes anyway, and the whole suite silently runs against a stranger —
 * which is survivable right up until the stranger exits mid-run and every
 * remaining assertion fails with ERR_CONNECTION_REFUSED.
 */
const portInUse = await fetch(BASE, { signal: AbortSignal.timeout(1500) })
  .then(() => true).catch(() => false);
if (portInUse) {
  console.error(`Something is already serving ${BASE}.`);
  console.error('Stop it first — otherwise this run would test against it rather than');
  console.error("against this working tree, and would not say so.");
  process.exit(1);
}

// Captured, not discarded: a server that cannot bind, or that dies mid-run, used
// to produce no diagnostic at all — only a wall of connection errors inside
// whichever suite happened to be running when it went.
const serverLog = [];
const server = spawn('python3', ['serve.py', '--port', PORT, '--no-open', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => serverLog.push(chunk));
}

let serverExit = null;
server.on('exit', (code, signal) => { serverExit = signal || code; });

/** Everything the server said, for when a failure needs explaining. */
const serverSaid = () => (serverLog.join('').trim() || '(the server printed nothing)');

const shutdown = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

// Wait for the port rather than sleeping a fixed amount.
const ready = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

if (!(await ready())) {
  console.error(`Server never came up on ${BASE}`);
  if (serverExit !== null) console.error(`serve.py exited early: ${serverExit}`);
  console.error(serverSaid());
  shutdown();
  process.exit(1);
}

/** Runs one suite against the server already up, resolving to its exit code. */
const run = (file) => new Promise((done) => {
  const suite = spawn(process.execPath, [resolve(ROOT, file)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, BASE_URL: BASE },
  });
  suite.on('exit', (code) => done(code ?? 1));
});

/**
 * Which suites to run, all sharing this one server.
 *
 * Named on the command line, or all four by default. The layout audit is in
 * here because it needs a server exactly as much as the others do and used to
 * be invoked directly — so `npm test` passed only on a machine that happened to
 * have one running already, and failed on a clean checkout at the last step.
 *
 * The Drive suite intercepts googleapis.com in the browser rather than reaching
 * Google, so it needs nothing beyond this either.
 */
const SUITES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['tests/e2e/app.test.mjs', 'tests/e2e/drive.test.mjs', 'tests/memory/leaks.test.mjs',
     'tests/layout/audit.test.mjs'];

let failed = 0;
for (const file of SUITES) {
  const started = Date.now();
  const code = await run(file);
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  // A full run is several minutes, most of it the layout audit's 17 screens
  // across three viewports and two themes. Printing the cost per suite is what
  // distinguishes "slow" from "wedged" without anyone having to guess.
  console.log(`  ${code === 0 ? 'ok  ' : 'FAIL'} ${file} — ${secs}s`);
  if (code !== 0) {
    failed += 1;
    if (serverExit !== null) {
      console.error(`\n  The server exited (${serverExit}) during this suite, which is`);
      console.error('  the likely cause rather than anything the suite asserted:');
      console.error(`  ${serverSaid().split('\n').join('\n  ')}`);
      break;
    }
  }
}
shutdown();
process.exit(failed ? 1 : 0);
