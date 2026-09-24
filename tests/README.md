# Tests

The app itself has **no dependencies and no build step** — that has not changed.
`package.json` exists only to pin the test tooling and give the commands names.
Nothing in `js/` imports anything from `node_modules`.

## Running them

```bash
npm run test:unit                     # ~1 second, no browser needed
npm install                           # once, for the browser suite
npm test                              # both
```

`npm test` runs the unit suites, the two proxy suites, then the browser ones —
app, Drive, volume, memory and the layout audit — against one server it starts
and stops itself.

Four of the unit suites check things that are not application logic, and are worth
naming because they are easy to overlook when adding a test:

| Suite | What it guards |
|---|---|
| `shell.test.mjs` | The service worker precaches every module. A module missing from that list has no guarantee of being there offline. |
| `csv.test.mjs` | `toCsv` escaping, and that free text cannot become a spreadsheet formula. |
| `docs.test.mjs` | The documents against the code they describe. It states its own limits in its header; read them before trusting a green run. |
| `imports.test.mjs` | Nothing in `js/` reaches into `node_modules`. |

`npm run test:e2e` starts its own server on port 8123, runs **both** browser
suites against it, and shuts it down afterwards. When iterating it is faster to
leave one running:

```bash
python3 serve.py --port 8123 --no-open &
node tests/e2e/app.test.mjs      # the app, on the local backend
node tests/e2e/drive.test.mjs    # the Google Drive path, against a fake Drive
```

### The volume suite

Every other browser suite runs against eight cadets. `tests/e2e/volume.test.mjs`
seeds five staff and forty-five, which is Det 752, and asks what the app
**spends** rather than whether it works.

```bash
npm run test:volume
```

It counts round trips, not seconds. In proxy mode every read and every
submission is an Apps Script execution, and Apps Script allows thirty of them at
once across the whole account — so the number that decides whether a drill night
works is executions per cadet, which is a count and cannot flake. Timing it in a
headless browser against a stubbed server would be timing the stub.

`tests/proxy/load.test.mjs` is the same question from the other side: what one
execution costs the server, including how much Drive work it does while holding
the script lock that every submission in the detachment queues behind. Together
they bound the evening. Neither reproduces real contention, and neither claims
to — see the note at the end of that file for what still needs a live rehearsal.

The layout audit can be pointed at the same size, which is where a roster table
with one button per row gets interesting:

```bash
AUDIT_CADETS=45 npm run test:layout
```

### The Drive suite

Every other suite runs on the `local` backend, which left the entire Drive path
untested — it needs an OAuth token, and Google will not issue one to an
automated browser.

`tests/e2e/drive.test.mjs` simulates Google instead, at two narrow seams: the
GIS token client is stubbed before the app loads, and `googleapis.com` is served
by an in-memory Drive. That fake **enforces `drive.file` semantics** — it tracks
which files the app created and returns 404 for everything else, exactly as
Google does. That is the point of it: without that rule it would happily serve a
hand-made folder and the suite would pass while a real install failed.

It cannot tell you whether Google's real API agrees with this model of it. A
green run means the app is internally consistent; a live install still needs
running once by hand.

## What is covered, and why these things

The suite is deliberately weighted toward guarantees that **fail silently**.
A broken button is obvious the first time someone clicks it; a lost receipt or
a leaked username is not, and may not surface for a term.

| Area | What is asserted |
|---|---|
| Anonymity | A stored response contains no username while its receipt does. A canary string in a withheld response is absent from the page *and* the CSV export, then present once the threshold is met. |
| One submission per cadet | A second attempt is refused at the form. |
| Disclosure threshold | Anonymous results stay hidden below three responses; attributed feedback is never withheld. |
| Concurrent writes | Twelve simultaneous submissions produce twelve responses and twelve receipts. A submission writes only paths unique to that cadet. Two admins editing different accounts both succeed. |
| Self-healing indexes | A deliberately corrupted index is rebuilt from the response files on the next read. |
| Schema migrations | A fabricated v1 folder migrates forward, is idempotent on a second run, and a folder claiming a newer version refuses to load. |
| Access control | Every gated route rejects a signed-out session and an account without the role, including deep links. |
| Google identity | A malformed, expired, unverified or misdirected ID token is refused; a valid one yields a lowercased email and an intact non-ASCII name. |
| The roster | An empty folder is claimed by the first sign-in and closes behind it; an unknown email is turned away; a deactivated account cannot sign in; changing someone's email leaves the username their receipts are filed under alone. |
| Offline queue | A write that fails is queued and drains on reconnect. |
| Read amplification | `db.stats()` stays under a fixed number of document reads regardless of how much feedback exists. |
| The offline shell | Every module under `js/` is precached, every precached path exists, and the icons the app declares are cached with it. |
| Backup and restore | A bundle round-trips through export, wipe and replace-import with every count intact. A file that is not a backup is refused *before* anything is wiped. A wipe leaves the account directory alone, which is what stops a replace import locking the owner out. |
| CSV exports | Commas, quotes and newlines survive a round trip; a leading `=`, `+`, `-` or `@` is defused, so a cadet's answer cannot run as a formula in the spreadsheet the cadre member opens. |
| The academic year | A second rollover in the same year is warned about, names who ran the first, and can still be overridden — a detachment that restored a backup has to run it again. |
| Session and token expiry | An expired ID token is withheld while the session survives; a session past its own expiry signs itself out rather than reporting stale. |
| Administrators | The last one cannot be deleted or demoted, and a refused deletion anonymises nothing on its way out. |
| Documentation | Prose is checked against the code it describes — constants, repo counts, the folder tree, symbol citations, banned terms and retired instructions. |
| Analysis | The scale renders words and never digits; the mean is reported back in words; statistics refuse to compute below their minimum sample. |

The unit files additionally check the maths, the lexicons and the token decoder
directly: a polarised set is detected as split, a lone dissenter is flagged,
benign text is *not* flagged, negation flips sentiment, and a clause break stops
a negation reaching across it.

**Why sign-in is split across the two suites.** Google will not issue an ID
token to an automated browser — that is an anti-automation measure on their side,
not a gap in the app. So `tests/unit/identity.test.mjs` covers the decode and its
refusals with fabricated tokens, and the browser suite calls `signInWithGoogle`
with an already-decoded profile, exactly as the real callback does. The one thing
neither can cover is a real click on Google's button; that has to be done by
hand, once, against a real Client ID.

## The proxy

```bash
npm run test:proxy
```

`tests/unit/proxy.test.mjs` reads the script and checks the *shape* of its access
model. `tests/proxy/behaviour.test.mjs` **runs it** — the real `Code.gs`,
unmodified, inside a simulated Apps Script environment with an in-memory Drive.

The distinction is the point. Source checks catch a missing guard. They do not
catch a wrong argument order, an id that escapes its folder, or a role that
reaches a space through a path nobody thought about — and Apps Script has no
type checking to catch them either.

What it cannot check is the environment: real quotas, real lock contention
across concurrent executions, or a deployment misconfigured in the console.
**A real deployment still has to happen.** This means that deployment will be
checking those things rather than discovering the logic was wrong.

## Memory

```bash
npm run test:memory
```

Part of `npm test` since it was wired into the runner. It used to want a server
started by hand, which is the only reason it sat outside the suite — and the only
test of the sign-out cache drop sat outside with it.

JavaScript has no manual memory management, so this checks the two failure modes
that do exist: **retention past the point something should be gone**, and
**growth without a ceiling**. Every heap reading is taken after a forced
collection, or the number measures when the collector last ran rather than what
is held.

It matters more here than usual because a detachment office laptop sits open on
the Instructor Panel all day while someone moves between screens dozens of
times. A few hundred kilobytes leaked per navigation is invisible in a test and
fatal by mid-afternoon.

The most valuable check is not a leak at all. **A cache that survives a sign-out
serves the previous person's records to the next one**, and shared laptops make
that the ordinary case rather than an edge one. That test exists because the bug
did: the cadet bundle outlived `sessionStorage`, so signing out and back in as
someone else showed the first person's feedback.

## Performance

```bash
npm run bench
```

Reports payload, cold start, heap, and how analysis scales with volume — under
normal CPU and throttled to stand in for a cheap Android. Absolute numbers are
one machine's; the shape is the point.

## When you change something

- Touched `js/analysis/` → run the unit file first, it is instant.
- Touched storage, auth or a view → run the full suite. The concurrency and
  anonymity assertions are the ones worth waiting for.
- Changed the disclosure threshold or the scale wording → the tests assert the
  current values and will fail. Update them in the same commit, and update
  `docs/` too.
