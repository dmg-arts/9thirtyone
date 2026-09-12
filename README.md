# 9ThirtyOne

A progressive web app for the cadet ↔ instructor feedback cycle, built for
AFROTC detachments. Every organization owns its own data: the app has no server
and no shared database, and writes only to storage the detachment controls.

- **Cadet** — signs in with their Google account, then sees the feedback
  assigned to them, filtered by school year, semester, class and due date.
- **Instructor Panel** — behind an instructor sign-in. **Create Feedback**
  builds a standardized form; **Feedback Response and Analysis** filters
  responses, runs statistics on the ratings, reads the written answers, and
  screens everything for safety concerns.
- **Cadre Panel** — the same screen, pointed at the restricted folders. Cadre
  see feedback instructors cannot; a commander also sees their own space inside
  it. Not a filtered list: the folders are separate, and the detachment's own
  server decides who may open which.
- **By instructor** — the same records grouped by the person they reflect on, in
  either panel. An instructor sees their own results, cadre see the instructors
  they oversee, a commander sees everyone. `js/people-scope.js` holds the rule
  and is explicit about where it stops being a boundary.
- **Database Administration** — behind an admin sign-in. Keeps the roster of
  Google accounts that may use the app, and what each one is allowed to do.
- **Settings** — where the database lives, plus light/dark, color-vision
  palettes, contrast and text size.

---

## Documentation

`docs/` holds ten things. Start with `WHY.md` — everything else assumes it.

| File | For | Contents |
|---|---|---|
| `WHY.md` | Cadre and commanders | Why this exists: the centralized detachment model and what it costs, the cadet-instructor gap, how the app works in plain English, and the guarantees with their limits. **The argument the other documents are built on.** |
| `STYLE.md` | Anyone writing copy | The content lexicon — terminology, object definitions, voice, and the claims that must not be softened. Applied by hand; there is no build step that reads it. |
| `9ThirtyOne-Setup-Guide.pdf` | Whoever installs it | 25 pages: creating the detachment's Google account, opening the app, the wizard, the submission server, the roster, join links, a verification checklist, and troubleshooting. There is no Cloud setup any more. |
| `9ThirtyOne-User-Introduction.pdf` | Everyone, at rollout | 8 slides: why and how on one slide, then what instructors, cadre and commanders do, what a cadet sees, and a diagram of where an answer actually goes. |
| `9ThirtyOne-Overview.pdf` | A handout, or a projector | The same argument on one landscape page — why, how, both sides of the app, and the data-flow diagram. |
| `9ThirtyOne-How-To-Guide.pdf` | Anyone using it | 19 pages, a chapter per role, every screen with its screenshot, and a closing matrix of what each role cannot reach. |
| `ALPHA-TAGS.md` | The maintainer | The twelve alpha releases of 21–24 Aug 2026, with their commit SHAs and what each shipped. The tags themselves say a name and a line; this says why four of them are one movement. |
| `9ThirtyOne-Introduction.pdf` | Briefing cadre or a commander | 22 slides with speaker notes: why it exists, what it does, how each role uses it, and the anonymity and safety design. |
| `ROSTER-FORMAT.md` | Whoever builds the roster | The CSV the roster importer accepts, column by column, with a prompt written to be handed to an assistant along with the detachment's existing list. |
| `roster-template.csv` | The same person | A worked example of that format, staff and cadets, to attach alongside the prompt. |

`privacy.html` ships alongside the app and deploys to the same domain, which is
where Google's OAuth verification requires it to be.

The five PDFs are rebuilt by the scripts in `tools/docs/` — see the README there.
Every screenshot in them is the live app with seeded data, nothing mocked up, so
the documents cannot quietly drift from what the app does.

---

## Tests

```bash
node tests/unit/analysis.test.mjs   # ~1s, no browser
npm install && npm test             # unit + full browser suite
```

`package.json` exists **only** to pin test tooling and name the commands — the
app itself still has no dependencies and no build step, and nothing in `js/`
imports from `node_modules`. See `tests/README.md` for what is covered and why
those particular things.

The suite is weighted toward guarantees that fail *silently*: anonymity,
one-submission-per-cadet, the disclosure threshold, concurrent writes, schema
migrations and access control. A broken button announces itself; a lost receipt
does not.

---

## Running it

There is no build step and no dependencies — a folder of static files, which is
why one published copy can serve every detachment.

```bash
python3 serve.py            # http://localhost:8000
python3 serve.py --https    # self-signed TLS, for testing on a phone
npm run icons               # regenerate the PNG icon set
```

A service worker, the folder picker, and Google sign-in all require a **secure
context**. `localhost` counts; a bare LAN IP over http does not — hence
`--https` for phone testing.

**Deployment is this repository.** Pushing to `main` publishes
<https://9thirtyone.app/> through GitHub Pages, and that one address is what
every detachment opens. Nothing else to run. `CNAME` at the repo root is what
points Pages at the domain; the apex carries A records and `www` is a CNAME that
redirects to it.

Detachments are not asked to host their own copy. A second copy would mean
another OAuth origin to register with Google and another thing to keep patched,
for no gain — the app holds no data, so a shared address costs a detachment
nothing in privacy or control. The setup guide gives them the address and says
nothing about hosting; keep it that way.

---

## Where the data lives

The app talks to a storage adapter, chosen once during setup. All three present
the identical interface, so the rest of the app does not know which is in use.

| Backend | How it works | Works on |
|---|---|---|
| **Google Drive** *(recommended)* | Drive REST API + OAuth against the detachment's own Google account | Phones, tablets, computers |
| **Synced folder** | File System Access API pointed at the Google Drive for Desktop folder | Desktop Chrome / Edge only |
| **This device only** | IndexedDB in the browser | Anywhere, but nothing syncs |

> **A browser cannot be handed a filesystem path to Google Drive.** There is no
> path to give it on a phone, and web pages have no filesystem access on any
> platform. The Drive backend is therefore the real answer for multi-device use;
> the synced-folder backend is the closest thing to "point it at the folder" and
> works well on a detachment's desktop machines. Start on **This device only** if
> you want to try the app before setting up the Google account — export a backup
> and import it once you connect to Drive, and nothing is lost.

### Folder layout

The chosen folder becomes the database. Each record is one JSON document.

```
9ThirtyOne/
├── config/      org profile and shared settings
├── users/       accounts — cadets, instructors, admins
├── roster/      legacy roster (migrated into users/ automatically)
├── forms/       feedback form definitions
├── requests/    feedback issued to cadets, each with a feedback ID
├── responses/   submitted feedback, one folder per form
├── receipts/    who submitted (kept apart from what they said)
├── reports/     exported reports
└── archive/     closed terms retained for the record
```

### Two things that make this scale

**Roll-up indexes.** Reading a term of feedback one file at a time would mean
thousands of Drive API calls on the landing page. Each form keeps a
`_index.json` of its responses and there is a global `_counts.json`, so the home
screen costs a fixed ~6 reads no matter how much feedback exists. Rebuild them
from Database Administration if a restore ever leaves them stale.

**An offline write queue.** Cadets fill these out on classroom wifi. A
submission made offline is stored in IndexedDB, shown as pending in the header,
and replayed automatically on reconnect — never silently lost.

**Writes that cannot collide.** A submission writes exactly two files, both on
paths nobody else touches: its own response, and its own receipt at
`receipts/<requestId>/<username>.json`. Indexes are never written on the
submission path — they are caches, rebuilt on read when a folder listing shows
they have drifted. A whole flight submitting at once therefore cannot lose
anyone's response or receipt.

Because records are plain JSON in your own Drive, they are readable, greppable,
backed up by Google, and recoverable from the Drive trash for 30 days.

---

## One-time Google setup (Drive backend)

Done once by the detachment, on the account the detachment owns:

1. Sign in to that Google account.
2. In [Google Cloud Console](https://console.cloud.google.com), create a project
   and enable the **Google Drive API**.
3. **OAuth consent screen** → *Internal* if the account is on Google Workspace,
   otherwise *External* and add each cadre member as a test user.
4. **Credentials** → **OAuth client ID** → *Web application*. Add the address the
   app is served from as an **Authorised JavaScript origin**.
5. In Drive, create a folder named `9ThirtyOne` and share it with the cadre who
   need access.
6. In the app's setup wizard, paste the **Client ID** and the **folder link**.

The OAuth client ID is public by design — it identifies the app, it is not a
password. Who can read the data is governed by Google sign-in and the folder's
sharing settings.

---

## The submission server

Optional, and the setting that decides whether "anonymous" means anonymous from
*other cadets*. Deployment instructions are in `tools/proxy/README.md`.

Without it, a cadet's phone writes its own response into Drive, which requires
Editor on the folder, which also grants read. With it, cadets have no Drive
access at all: their device posts to a Google Apps Script running in the
detachment's own account, which verifies their Google ID token **server-side**,
checks the roster, and writes the files as the folder's owner.

That closes the loop `js/google-identity.js` describes — the browser-side token
check "stops mistakes, not attackers", and this is the server-side check it
defers to.

A write-only proxy would not have worked. A cadet with no Drive access cannot
read `requests/` or `forms/` either, so the script also serves a **bundle**:
that cadet's assignments, the forms to render them, and which they have already
answered. No responses, not even their own. One round trip, which matters on a
phone with two bars.

Two further gains that fall out of it:

- **One submission per cadet becomes a rule, not a convention.** The receipt
  check and the write happen under an Apps Script lock, so two taps on a slow
  connection cannot both land. The client alone could never guarantee that.
- **Cadets never see the full-Drive consent screen**, because they are never
  asked for Drive access. The join screen skips the OAuth step entirely when a
  proxy is configured.

Cadre still read Drive directly — analysing responses needs exactly the access
this removes from cadets — so instructors remain inside the trust boundary.
Removing that would need a real backend, which is not what this is.

`js/storage/proxy.js` is the client. Two things in it look wrong and are not:
requests go out as `text/plain` so they stay CORS-simple, because Apps Script
cannot answer a preflight; and refusals arrive as HTTP 200 with `ok: false`,
because Apps Script renders thrown errors as HTML a fetch cannot parse.

---

## Join links

Only the person who sets a detachment up runs the setup wizard. Everyone else
gets a **join link** from Database Administration → *Invite people*:

```
https://det.example.org/app/#/join?c=<client>&f=<folder>&n=<name>
```

**Database Administration → Show QR code** puts the same link on a full screen
as a QR code, for handing out to a room at once — a laptop on a projector, or a
phone held up. `js/qr.js` is a from-scratch encoder (byte mode, error correction
level M, versions 1–20); a CDN script would break offline use and vendoring a
minified library would put unreadable code in a dependency-free codebase.

Its unit tests compare the module matrix against **python-qrcode** for ten
inputs at all eight masks — 80 matrices, bit for bit — because the failure mode
here is a code that looks perfect and does not scan. Masks are forced rather
than auto-chosen: mask *selection* legitimately differs between implementations
and only changes which of eight valid codes you get.

It carries the Google Client ID, the Drive folder, and the submission server if
the detachment has one — so a cadet taps it, signs in once, and lands on their
feedback with nothing typed. The proxy travels in the link because a cadet in
proxy mode has no Drive access and therefore cannot read a shared setting to
discover it. The admin
console offers it three ways: copy, a native share sheet on phones, and a
pre-written mail draft that warns about the unverified-app screen.

**A join link is not a credential**, and the UI says so. The Client ID is public
by design, the folder ID is an address rather than a key, and connecting grants
nothing on its own — the roster still decides who may sign in, and an unknown
email is turned away. It is safe to post wherever the detachment already talks.

Link building and parsing live in `js/join.js`, deliberately DOM-free so the
format is unit-testable and so a QR renderer can consume `buildJoinLink()`
without pulling in a view. The client ID's fixed
`.apps.googleusercontent.com` suffix is stripped in transit, which keeps a
typical link inside 152 characters.

The join screen never calls `db.initialize()`. The wizard does, because the
wizard creates a detachment; a joining device is arriving at a folder that
already exists, and a cadet's phone has no business creating folder structure.
If `config/org.json` is missing, the screen says no administrator has set the
folder up yet rather than quietly repairing it.

---

## Accounts and sign-in

**Everyone signs in with their Google account. This app issues no passwords and
stores no credentials.**

That suits a regional detachment better than anything this app could invent.
Cadets travel in from several affiliated schools, so there is no single
institutional domain to key on — but every cadet already has a Google account,
because that is where the det mails them, whatever their school address says.
The det's drives are already shared to those accounts.

`users/users.json` is therefore a **roster**, not a credential store: email,
name, roles, AS level, section. Nothing in it is secret. Signing in with Google
proves who you are; being on the roster with the right role is what grants
access, and that is an administrator's decision.

Two jobs disappear with the passwords: handing a generated one to every cadet,
and resetting the ones they forget.

### Claiming a new folder

A folder with an empty roster is claimed by **the first Google account to sign
in**, which becomes an administrator and an instructor. After that the roster is
closed and an unknown account is turned away. This is the recovery path that the
old shared built-in credential used to be — a detachment cannot lock itself out,
because `users/users.json` can also be edited directly in Drive by anyone the
folder is shared with.

### Adding people

Database Administration → **Add person** takes a name and the Google account
email. **Import roster CSV** takes the same list the det already uses to mail
cadets: a `name` column and an `email` column, optionally `class`.

Each account also carries a lowercase **username** (`alvarez.mia`), derived from
the name. It is internal: submission receipts are filed under it, so it stays
fixed when someone's email changes and their submission history survives a move
between schools.

### Running without Google

The local and folder storage backends have no Google account behind them, and
Google will not issue a token to a page served from a random port. With
**developer mode** on (Settings → Access) *and* no Client ID configured, the
sign-in screen offers a box that takes an email and trusts it. It says so on the
screen. It disappears the moment a Client ID is set, so it cannot be present in a
Drive-backed installation.

---

## Schema migrations

A detachment's records outlive any single release. `APP.schemaVersion` is the
version this build expects; the version a folder is actually at is stored in
`config/org.json`.

When a device opens a folder written by an older release, the pending migrations
run automatically before any view reads the data, and a toast reports the
upgrade. Database Administration → Schema version shows both numbers and can
re-run them by hand after restoring an old backup.

Migrations are forward-only and idempotent, and a folder written by a *newer*
build refuses to load rather than being silently downgraded. Add one in
`js/migrations.js` alongside every change to a record shape.

---

## Security model — read this

- **Sign-in gates the UI on a shared device. It is not encryption.** Anyone who
  can open the Drive folder can read every record directly, whatever the app
  shows them. Control access through the folder's Drive sharing.
- **No credentials are stored at all.** `users/users.json` holds emails and
  roles, nothing secret. The identity check itself is Google's.
- **The ID token is validated in the browser, which stops mistakes, not
  attackers.** A browser is under the control of whoever is sitting at it. The
  boundary that actually holds is Google Drive sharing: reading or writing the
  det's folder needs an OAuth token issued to an account that has been granted
  access, and Google enforces that.
- **Anonymous feedback is anonymous in the data.** The sign-in identifies the
  cadet well enough to write a *receipt*, then is discarded. The response record
  carries no name, so nothing links an answer to a person. Receipts live in
  `receipts/`, a different folder from `responses/`.
- **Cadet identity is authenticated.** Cadets sign in, so a submission receipt
  records a verified person rather than a typed claim, and nobody can burn a
  classmate's single submission.
- **No device-local flag grants access.** There used to be one — development
  mode made every role check pass, so a box ticked on a page that needs no
  sign-in opened the admin console. It is gone. What remains under Settings →
  Access enables an *email sign-in* for installations with no Google Client ID,
  and that goes through the roster like any other: an address nobody added is
  refused, and the roles are the real ones.
- Nothing is transmitted anywhere except the detachment's own Google Drive.

---

## Anonymity and disclosure control

Anonymity has a hard floor. With *n* responses from a known set of *n*
submitters, the best anyone can do is a 1-in-*n* guess — and at *n*=1 that is a
certainty. Receipts make the submitters known by design, so a single anonymous
response shown beside a completion list identifies its author by elimination.

So **anonymous results are withheld until 3 people have responded**
(`PRIVACY.minResponsesToShow` in `js/config.js`). Below that, the form is
excluded from the statistics, the comments, the individual responses *and the
CSV export* — while the counts stay visible so cadre can still chase the people
who owe feedback. The form creator warns at build time if an anonymous form is
going to fewer people than the threshold, since such a form could never show
results.

The threshold is applied **per form**, not to the running total: a form is the
unit an author can be identified within, and pooling a thin form into a larger
total would not protect it anyway, because the feedback-ID filter can isolate it
again in one click.

Attributed (non-anonymous) feedback is never withheld — the names are already
attached, so withholding would cost visibility and buy nothing.

---

## Concurrent edits

Three different problems, handled three different ways.

**Submissions cannot collide at all.** Each writes only its own response file
and its own receipt file. This is why receipts are one file per cadet rather
than one array per form: a shared array meant read-modify-write races that could
silently drop a receipt, letting that cadet submit twice while showing as
outstanding — and a lost receipt is the one loss nothing can rebuild, because an
anonymous response carries no name to reconstruct it from.

**Indexes repair themselves.** `listResponses()` costs a folder listing plus an
index read; if the counts disagree the index is stale and gets rebuilt from the
response files. Rebuilds are idempotent, so two readers repairing the same index
produce identical content. `responses/_counts.json` is best-effort and can lag
briefly after a burst of submissions — it drives a badge, and a stale badge is a
far better trade than a lost response.

**Records people edit carry a `rev`.** A save states the revision it started
from; if storage has moved on, the write is refused and the form creator shows
both versions with an explicit choice — discard yours, or overwrite theirs.
Account edits use the same revision but retry automatically, expressing the
change rather than a precomputed list, so two admins editing *different*
cadets both succeed instead of one erasing the other.

A per-path lock serialises all of this within one browser tab. That matters more
than it sounds: without it, two operations in the same tab both read the old
revision, both pass the check, and the second overwrites the first — not a rare
window but the normal interleaving, since both reads resolve before either write
starts. Across devices the revision check narrows the window to a single network
round trip, which catches two people editing the same form minutes apart. It
remains a check, not a guarantee: no backend here offers a true
compare-and-swap, which is also why Drive's `If-Match` was not used — it would
not work on the synced-folder or local backends, and cannot help the offline
queue, where a replayed write is stale by construction.

---

## Reuse, rollover and the audit trail

**Question templates.** Save a set of questions from the form creator, then
start any new form from it. Asking the *same* questions each term is the only
thing that makes results comparable across events and years — retyping them
guarantees drift, and drift is invisible until a comparison quietly stops
meaning anything. Copies are independent; editing one never touches the
original.

**Academic year rollover.** Database Administration → *Academic year rollover*
advances every cadet one AS level and deactivates the graduating year in one
step, after showing you exactly who moves where. Graduating cadets are
**deactivated, never deleted** — their feedback stays part of the record and the
account can be reactivated. Done by hand across 150 accounts this is a morning's
work that eventually gets skipped, and once the levels are stale every class
filter is wrong for a year.

**Audit trail.** `audit/` records who deleted, changed or reset what, one file
per entry. Nothing in the app removes an entry — the module exposes no delete,
and a test asserts it never gains one.

**Flagged feedback cannot be casually deleted.** If a response matches the
safety screen, an instructor cannot remove it at all; a database administrator
can, and must give a reason that is recorded against their name. This is a
client-side app, so someone determined could bypass the UI through the browser
console — what it guarantees is that destroying a disclosure takes a deliberate
act rather than an idle click, and that the ordinary path always leaves a
record.

---

## Analysis

Two halves, both running entirely on the device.

### Ratings

Per question: mean, median, mode, range, standard deviation, and a distribution
histogram across every scale point. Plus three things a mean alone hides:

- **Agreement** — an ordinal consensus score (Tastle & Wierman) from 0 to 1.
  Chosen over standard deviation because it is defined for ordinal scales and
  answers the question cadre actually ask: *do they agree?*
- **Split opinion** — 1-D k-means looking for two genuine groups. A mean of 5
  can mean everyone shrugged, or that half the flight thought it was outstanding
  and half thought it was harmful. Same number, opposite situations, and only
  the second needs acting on. When a split is found the app says so and tells
  you the mean describes nobody.
- **Outliers** — by modified z-score against the median and MAD, not the mean
  and standard deviation, because with six responses one extreme rating drags
  the mean toward itself and hides what you are looking for. Also flags
  *respondents* who rate consistently apart from the group, which is usually
  more useful than a single odd answer.

Plus breakdowns by AS level, term or form, with cohorts below the disclosure
threshold suppressed.

**Every routine states its minimum and returns nothing rather than guessing.**
Dispersion needs 5 responses, outliers need 6. A confident-looking number
computed from four data points is worse than no number.

### Written answers

- **Sentiment** — a lexicon with negation, intensifiers and clause breaks, so
  "not helpful" and "extremely helpful" score correctly. Answers are ranked
  most-negative-first, since that is what an instructor should read first.
  Answers the lexicon cannot read are still shown, labelled *Not scored* — never
  hidden.
- **Word cloud** — sized by how many *people* used a word, not how often it
  appears, so one long answer cannot dominate. Backed by a ranked table that
  carries the real numbers and is what a screen reader gets. Select any word to
  read the answers containing it.
- **Safety screen** — every written answer is checked against word lists for
  hazing, sexual harassment, discrimination, violence, self-harm, substance
  concerns and integrity. Matches are shown highlighted, in context.

> **The safety screen is a prompt to read a response, never a finding.** It
> matches words, not meaning — it cannot tell "we discussed hazing prevention"
> from "I was hazed". Equally, a clear screen is not proof that nothing was
> reported; it only means no listed phrase appeared. The lists live in
> `js/analysis/lexicon.js` and are meant to be edited.

**Safety screening deliberately overrides the disclosure threshold.** A
disclosure of hazing or a cadet in crisis cannot wait for a third response to
arrive. On a withheld form the app says a flagged answer exists but keeps the
content behind a click that states plainly that opening it may identify the
author — the privacy cost is made explicit rather than either hidden or
silently paid.

There is no sentiment API, no cloud NLP and no telemetry. That is a deliberate
constraint, not an omission: the feedback must never leave the detachment's own
Drive, which rules out a large model and makes a curated lexicon the honest
choice. The trade is accuracy, and every output is labelled accordingly.

---

## Known limits

Alpha 0.4 was installed and run end to end against real Google Drive, on a Mac
and an iPhone, in August 2026. **That test predates the `drive.file` change in
0.15**, which replaced the folder step entirely — the live install pasted a
folder link, and the app now creates the folder itself. Treat the Drive setup
path as re-tested only once somebody runs it again.

- **The submission server is required for anyone but the folder's owner.** The
  app holds `drive.file`, so a device can only reach files *it* created. The
  owner's browser created the folder; nobody else's did. Without the server
  deployed, join links cannot set up a cadet's device at all — the join screen
  says so rather than failing obscurely. Earlier versions fell back to giving
  every cadet Editor access to the whole folder, which is how a cadet could read
  every response; that fallback is gone.
- **The app is still in Testing, so Google caps it at 100 accounts** and every
  user meets an unverified-app screen. This is *publishing status*, not scope —
  narrowing to `drive.file` removed the reason the app could not be published
  (`auth/drive` is restricted: verification plus a paid annual security
  assessment), but nothing is published until somebody presses the button.
  Doing so needs the homepage, verified domain and branding that the rename will
  provide.
- **Some Google accounts refuse unverified apps outright.** Settled, not a
  mystery: it is a standing Google behaviour, those people need a different
  Google account, and it stops mattering once the app is published.
- **Receipt timing can correlate.** For anonymous feedback, a receipt and a
  response are written seconds apart, the response ID encodes its creation time,
  and both index arrays are in submission order — so someone reading the **raw
  Drive files** could line them up. The disclosure threshold above does not
  address this; it defends the app's own screens. Anyone with raw folder access
  is already inside your trust boundary, so restrict who can read the folder.
- **The first sign-in claims an unclaimed folder.** By design — it is how a new
  detachment gets in without a shared credential. It is only as controlled as
  the folder's Drive sharing, so set that before anyone signs in.
- **Concurrent edits are checked, not locked.** See below.
- **No self-service enrolment.** There is no email out of this app, so someone
  not on the roster is added by an admin rather than requesting access.
- **Sentiment reads words, not meaning.** Sarcasm, quotation and context all
  defeat it. It is a triage aid for deciding what to read first.
- **The safety lexicon is English-only and literal.** It will miss disclosures
  phrased in ways no list anticipates.

---

## Project layout

```
index.html              app shell; resolves theme before first paint
manifest.json           PWA manifest
service-worker.js       precached shell, network-first navigation, never caches Drive
serve.py                dev server (http, or --https for phones)
tools/make_icons.mjs    icon generator, no dependencies
tools/docs/             regenerates the five PDFs from the running app
tools/demo/             the demo detachment, as an importable backup bundle
tools/tuning/           the 600-item synthetic corpus the lexicons were tuned on
docs/                   the five PDFs, WHY.md, STYLE.md, ALPHA-TAGS.md,
                        ROSTER-FORMAT.md and its CSV template
css/styles.css          design system: tokens, themes, color-vision palettes
js/
  app.js                bootstrap, routes, app bar, PWA plumbing
  config.js             constants + the shape of every record
  router.js             hash router with per-route guards
  state.js              device-local settings, connection, cadre session
  util.js               DOM helpers, formatting, stats, crypto, modals, toasts
  forms.js              renders form templates and collects answers
  storage/
    index.js            facade — every view talks to this
    proxy.js            the submission server client
    queue.js            offline write queue, replayed on reconnect
    drive.js            Google Drive REST + OAuth
    folder.js           File System Access API
    local.js            IndexedDB
    idb.js              IndexedDB wrapper
  auth.js               the roster, sessions, roles, sign-in
  google-identity.js    Google Identity Services: the button and the token check
  join.js               join-link building and parsing; DOM-free, unit-tested
  qr.js                 QR encoder and SVG renderer, no dependencies
  data-source.js        one place that decides: proxy bundle, or read Drive direct
  panels.js             the two panels, and which folders each one shows
  people-scope.js       who appears in By instructor, and whose results they see
  spaces.js             how the restricted spaces are described to people
  session.js            the signed-in session and the token proving it
  export-anon.js        the anonymised backup export
  audit.js              the activity log, append-only from the app's side
  migrations.js         forward-only schema upgrades, one entry per version
  analysis/
    stats.js            descriptive stats, agreement, clustering, outliers
    text.js             sentiment, word frequency, safety screening
    lexicon.js          the word lists — meant to be edited
    wordcloud.js        SVG cloud plus its accessible table
  views/
    setup.js            first-run wizard, for whoever creates the detachment
    join.js             the join-link screen everyone else gets instead
    invite.js           the full-screen join QR code
    sign-in.js          the Google sign-in gate, shared by all three roles
    home.js             the three entry points + settings
    student.js          username filter, fill-out, one-submission guard
    instructor.js       panel shell (both panels), forms, cadets, database
    formCreator.js      the standardized form builder
    analysis.js         filtering, statistics, completion tracking
    people.js           the commander's review, grouped by person
    admin.js            roster maintenance, invite links, audit, rollover
    settings.js         storage, appearance, accessibility, access, about
about.html              what the app is, for anyone who lands on it cold
privacy.html            the privacy policy, deployed with the app
terms.html              terms of service
tools/proxy/Code.gs     the submission server each detachment deploys
tests/                  unit, proxy-behaviour, end-to-end, memory and layout suites
```

---

## Accessibility

Both color-vision palettes and status colors are handled together: every status
carries an **icon and a text label** as well as a hue, so no meaning depends on
color alone. Palettes for deuteranopia, protanopia, tritanopia and monochrome
remap the status hues to separable pairs. Also: full keyboard operation, visible
focus rings, a skip link, `prefers-reduced-motion` support, 2.75rem touch
targets, and heading focus on navigation.

---

## Where this is going

Currently shipped: the complete shell and a working end-to-end cycle — issue a
request, fill it out, read it, report on it, back it up.

### The road to beta

**Beta is one detachment, not many: AFROTC Det 752 at Wilkes University.** There
will be no parallel pilots. 145 detachments is the market, not the test. The path
is a successful beta at 752, then a pitch to AFROTC HQ, positioned alongside a
partner's teaching system as a way to train cadet instructors.

Roughly in dependency order. The first item gates several of the others.

1. **Move to a clean GitHub account or organisation**, off the current personal
   one, **and rename the app.** **The rename shipped** — the app is 9ThirtyOne,
   on `9thirtyone.app`, and the repository is already under the `dmg-arts`
   organisation. What remains of this item is only the account tidy-up below.
   Renaming touches the manifest, `APP.name`, cache keys, both generated
   documents and the deck — mechanical, but wide, which is another reason to do
   it in the same pass. This changes the origin, which
   is load-bearing: the OAuth authorised JavaScript origin has to follow it, and
   **every join link and QR code already handed out stops working**, because the
   origin is encoded in them. Regenerate and redistribute after the move.
   - **Settled ahead of the move: the custom domain.** `9thirtyone.app` is live,
     so the origin is now fixed independently of where it is hosted — an account
     move no longer changes it, and this whole item shrinks to moving the repo.
     It does **not** buy `frame-ancestors`: that needs a host which can set
     response headers, and Pages still cannot, custom domain or not. What the
     domain buys is that such a move becomes possible without breaking the
     origin a second time.
   - Also the moment to replace the branch-build deploy with a GitHub Actions
     workflow. Branch builds have silently failed to trigger twice.

2. **Privacy policy. Shipped** — `privacy.html`, dated 3 September 2026, served
   from the app's own domain and linked from every page, along with `terms.html`
   and `about.html`. Kept here because the data model below is the commitment it
   makes, and that is worth being able to point at.

   The data model behind it is settled, and it is deliberately tiny. **The
   maintainer keeps one record per deployment: the administrator's email, the
   organisation's name, and when they started.** Nothing else — no Drive URLs,
   no folder IDs, no access to any detachment's data. The detachment owns its
   Drive and owns its records; the maintainer's role is the source code and
   updating it. No back doors, and nothing retained beyond that one line.

   Still open: whether that record is supplied **manually** by an administrator
   or reported **automatically** by the app. The second would be the first time
   anything left a detachment's own Drive and would contradict the claim made in
   this README, the setup guide and the deck that nothing is transmitted
   anywhere else — so it would need consent at setup and those documents
   rewritten, not just a line in the policy.

   Cadre access disclosure is handled by the cadre panel (item 3), not here.

3. **Cadre panel, and with it the move to proxy-enforced access.** Specified;
   this is the largest change the project has had, and it is deliberately its
   own release. Two roles above instructor:

   - **Cadre** — everything the Instructor Panel does, plus a cadre-only space
     instructors cannot see. A superset of instructor. Not automatically a
     Database admin; the two are separate and may be held together.
   - **Commander** — a superuser with no separate panel, but a locked space
     holding the feedback requests it creates and the responses to them, plus
     visibility into everything else. **Capped at two at any time**, so command
     transitions overlap. The space belongs to the detachment and the
     designation rotates, so a handover moves a role and migrates no data.

   Database admins grant both. Cadre cannot see commander requests; commanders
   see everything; audit log and roster go to Database admins and commanders.

   Commanders also get a **By instructor** tab: the same records, grouped by the
   person they reflect on. Feedback carries `createdBy`, stamped from the
   verified token so nobody can file results under another instructor's name,
   and `subject` — who it is *about* — which defaults to the issuer and can be
   changed when somebody else ran the event.

   The disclosure threshold applies to **each person's total**, not only to each
   form: an instructor with two anonymous responses across two forms has two
   identifiable cadets, and an average would expose them as surely as the
   responses would. An individual form stays withheld below the threshold even
   when the person's total clears it.

   **Enforcement is server-side, through the proxy.** App-level role checks were
   rejected outright: every cadre member needs Drive access today, so anything
   the UI hides is readable by opening Drive — worthless for commander feedback
   about instructors, and unsellable as a security feature. Making it real means
   moving *all* Drive access behind the Apps Script, which also removes
   verification, CASA and the unverified-app warning. Sequenced as three
   landable steps, each leaving a working app:

   1. Proxy serves cadre **reads**. Nothing user-visible; the foundation.
   2. Proxy serves cadre **writes** — at which point Drive OAuth leaves the app
      entirely and the verification problem goes with it.
   3. Roles and locked folders — cadre space, commander space, the cap of two.

   **All three shipped** as 0.7.0, 0.8.0 and 0.9.0.

4. **After-thoughts.** A standing topic rather than a task: the answers to the
   open questions listed below, to be worked through together. Items graduate
   out of here into real work once decided.

5. **Trends and per-instructor baselines**, described below.

### Verification and the Client ID — settled

**One verified Client ID, shared by every detachment.** Decided 24 Aug, reversed,
and reinstated on 3 Sep once brand verification came through. `GOOGLE_CLIENT_ID`
in `js/config.js` is the whole of it: a detachment supplies a Google account and
a Drive folder, and touches the Cloud console not at all.

The app is **published and brand-verified**, so there is no test-user list, no
hundred-account cap, and no unverified-app screen for anyone. Setup dropped from
about 45 minutes to about 25, and Part 2b of the guide — a Cloud project, the
Drive API, a consent screen, every cadet added by hand, a Client ID copied out —
is gone rather than shortened.

The cost is the one the earlier reversal named and it has not gone away: this puts
the maintainer inside the auth path, and a problem with that one registration
reaches every detachment at once where per-detachment clients failed
independently. That is now an accepted risk rather than an open question. A stored
`clientId` still overrides the default, so a detachment that set one up before the
change keeps working and can move when it likes.

**Capacity is gated on publishing status, not on verification.** This was
misunderstood here for a while, so it is worth stating precisely:

- `drive.file` is **non-sensitive** ([Google's Drive scope list][s]), as are
  `openid`, `email` and `profile`. Those are the only scopes this app requests.
- An app using only non-sensitive scopes **does not need verification**
  ([verification help][v]).
- The 100-user cap applies to apps that **present the unverified-app screen**,
  and that screen fires only on sensitive or restricted scopes
  ([Manage App Audience][a]).

So a detachment with several hundred cadets does not need a review. It needs its
project published to Production, which is a switch in the console with nothing
behind it. Google calls the resulting state *Unverified Published*: any Google
user can access, and the only cost is that the consent screen does not show an
app name or logo until **brand verification** — a 2–3 day review that is optional
and buys branding, not capacity.

[s]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[v]: https://support.google.com/cloud/answer/13463073?hl=en
[a]: https://support.google.com/cloud/answer/15549945?hl=en

**The test-user list is what refused two ordinary Gmail accounts** during the
first live install. Publishing removed the list, and with it that whole class of
failure — those two accounts would sign in today without anyone doing anything.

### Removing the verification burden — done

**Decided and implemented.** Both halves of this shipped: all cadre and cadet
Drive access moved behind the proxy, and the scope narrowed to `drive.file`.
What follows is the reasoning, kept because it explains why setup creates the
folder.

The submission server already proved the pattern: Apps Script runs as the folder's
owner, so cadets need no Drive access — only `openid email profile`, which is
non-sensitive. **If cadre reads and writes also went through the proxy, nobody
would need Drive OAuth at all**, and the app would request non-sensitive scopes
only.

That would mean Production, free, uncapped, **no verification, no CASA, and no
unverified-app warning for anyone** — including the accounts that refuse
unverified apps — at any number of detachments. Quota scales, because each
detachment runs its own Apps Script under its own account.

The costs are real: considerably more proxy surface (cadre read *and* write —
forms, requests, roster, rollover, deletions), offline reads get harder because
the Drive adapter currently caches them, and the Drive adapter would survive only
for the self-hosted path. This supersedes the earlier split-client-ID idea rather
than complementing it.

### Known risks, reviewed 11 Sep 2026

Ranked by what would actually hurt, not by how alarming they sound.

1. ~~**Nothing in the proxy has ever executed.**~~ **Addressed.**
   `tests/proxy/behaviour.test.mjs` runs the real `Code.gs` unmodified against an
   in-memory Drive, and `npm run test:proxy` is part of `npm test`: role gating,
   space isolation, the commander cap, the admin floor, the submission lock, the
   anonymisation sweep and the token cache are all pinned as behaviour now. The
   proxy has also been deployed against a real folder and used.

   What that still cannot check is the environment — quotas, lock contention
   across genuinely concurrent executions, and a deployment misconfigured in the
   console. The last of those is the one that has actually bitten: access set to
   anything but *Anyone* answers a sign-in page, which the client now names
   explicitly.

2. ~~**The backup export is where anonymity ends.**~~ **Partly addressed.**
   Deleting an account now permanently anonymises everything that person left:
   responses keep their content and lose their respondent, receipts keep their
   existence — completion counts must still add up — and lose the name. So a
   departed cadet leaves nothing identifying in a backup.

   **And addressed for everyone else by a second export.** *Database → Export
   anonymised* produces a file with no roster, no respondents, no receipt names
   and no detachment name, with timestamps reduced to the month — because a
   receipt written seconds before a response identifies its author by
   elimination, and that survives having the names removed. It is the version to
   keep off-site.

   It is also the file to hand over when the analysis needs improving: the
   sentiment lexicon and safety phrase lists were written by guesswork and need
   real language. Responses the safety screen flags are **excluded by default**,
   since they are the most likely to describe a real incident and to identify
   people by circumstance; including them takes a deliberate tick and is recorded
   in the file.

   What no export can strip is what someone wrote. A cadet who says they are the
   only AS400 in their flight has identified themselves. The file says so in its
   own header rather than relying on the reader remembering.

3. **One hosted copy is a supply-chain target.** With per-detachment deployments,
   compromising one account reached one detachment. With a single hosted copy and
   a single Client ID, compromising the hosting account — or a maintainer's
   laptop — serves JavaScript to every cadet in the programme, in an app that
   legitimately holds their Google ID token. This risk arrived *with* the
   centralisation decision. Hardware-key 2FA, branch protection and never
   deploying from an unattended machine are the controls that matter.

4. **The legal question is unanswered, and is not a technical one.** FERPA
   governs education records at US universities. Feedback by a student about an
   instructor probably is not one, but the roster is personal data, this is a
   federal programme, and Privacy Act or DoD considerations may apply. It needs
   whoever advises AFROTC, and it needs settling before the beta rather than
   after, because the answer could change retention or hosting.

5. **There is no way to delete one person's data.** Removing an account drops the
   roster entry; their responses remain. The privacy policy needs an answer, and
   part of the honest answer is that anonymous responses cannot be deleted for
   one person by design.

6. **A rostered cadet can exhaust the detachment's Apps Script quota** by looping
   the bundle call — roughly 90 minutes of runtime a day, shared by everyone.
   No rate limiting and no detection. Trivial to do, unlikely to happen, cheap
   to add later.

7. **The audit trail protects against everyone except the folder owner**, who is
   now the only account with Drive access. Always true; sharper now.

8. **Sessions last eight hours.** They die with the tab, so a closed browser is
   safe, but a tab left open in a shared office stays signed in all day.

9. **An instructor's counts include spaces they cannot read.** `overview` is open
   to instructors and `readStats` deliberately counts across every space, so the
   totals on an instructor's panel include cadre and commander requests. Counts
   only, never content — but it means an instructor can tell that the commander
   has filed something. Undecided rather than broken: narrowing it costs the
   detachment-wide totals that make the number useful.

10. **An unrecognised space is filed as `shared`.** `spaceOf` falls back to the
    least restricted space when a request names one it does not know. Safe for
    reads, and the wrong direction for writes: a request meant for the
    commander's space, with its space mistyped, lands where every instructor can
    read it. Refusing would be the safer default; changing it needs a check that
    no fielded record relies on the fallback.

Checked and clean: the proxy logs no personal data, there are no runtime
dependencies, hash fragments are not sent in `Referer` so join links do not leak
through it, and the roll-up index files — which do duplicate response content —
are filtered out of every proxy read.

### Carried forward from the pre-review pass, 11 Sep 2026

Found and deliberately not taken. None blocks the beta.

- **The three public pages do not use the design system.** `about.html`,
  `privacy.html` and `terms.html` each carry the same 85 lines of inline CSS,
  byte for byte, and none links `css/styles.css`. Three copies to keep in step by
  hand, in the pages a stranger sees first.
- **The clone is 44 MB** for a project with no build step and no dependencies,
  because fifty-odd PDF revisions and five `.pptx` blobs are in history. Only a
  history rewrite fixes it, which is not worth doing before a review.
- **There is no CI.** Deployment is a push to `main`, and the README notes branch
  builds have silently failed to trigger twice. Nothing in the repository shows
  how the site is published, and nothing runs `npm test` but a person choosing to.
- **Coverage still thin in four places**: the cadet's submission path *through the
  proxy* has no client-side test, no browser test signs in as a genuinely rostered
  cadre account (they edit `sessionStorage.roles` instead, which skips the whole
  roster→session seam), `anonymiseInDrive` — direct mode's deletion sweep — has
  none at all while its proxy twin has seven, and `js/storage/folder.js` has none.
- **The join journey is untested end to end.** Every station on it is covered —
  the link builds and parses, the join screen renders on a device that has never
  been set up, a truncated link is refused, an added account signs in and gets
  its role — but nothing drives the whole road: open a link on an unconfigured
  device, apply it, sign in, see assigned feedback. Found by walking an external
  person through it by hand, which is the only thing that has exercised it.
- **Several unit checks are regexes over source** where the behaviour harness
  could now run the thing instead. `tests/unit/scope.test.mjs` also asserts that
  setup no longer takes a pasted folder link by grepping only `setup.js` — the
  input still exists in `settings.js`, so the guarantee it is named for holds in
  one file rather than across the app.

### Open questions, awaiting decisions

These are the ones actually blocking or shaping work, not idle curiosities.

- **Is the submission server deployed for beta?** Until it is, every cadet needs
  Editor access to the Drive folder and can therefore read every response in it.
  This decides whether feedback can honestly be described as private from other
  cadets.
- **Privacy policy specifics:** contact address, retention period, and how cadre
  access is disclosed to cadets.
- **What the company is called.** No longer blocks anything technical: the
  domain is bought and the privacy policy and terms are published under it. It
  remains open for the publisher line in `NOTICE` and `privacy.html`.
- ~~**Whether the deployment record is collected manually or by the app.**~~
  **Settled: neither.** Nothing is transmitted. The only record is what an
  administrator supplies by contacting support.
- ~~**Why Google refuses to add some accounts as test users.**~~ **Answered:**
  some Google accounts do not permit unverified apps at all. A standing
  limitation, not a fault to chase.
- ~~**Whether all Drive access moves behind the proxy.**~~ **Done.** Cadre and
  cadets reach nothing in Drive; only the folder's owner holds a token, and only
  for files this app created.
- ~~**Whether `drive.file` is non-sensitive or sensitive.**~~ **Answered:
  non-sensitive**, per [Google's Drive scope list][s]. No verification is
  required to publish, at any number of users.

Not yet built:

- **Trends across terms.** Everything today analyses one filtered slice. Asking
  "is this instructor improving year on year" needs a time series the app does
  not yet assemble.
- **Per-instructor baselines.** Comparing a score against that instructor's own
  history, rather than against the flight, needs the trend work first.

### Where the loop closes, and why it is not a feature

Response rates in a second term depend on whether cadets believe the first term
mattered. It would be easy to read that as a missing feature — a "you said, we
did" screen — and to log it as the highest-value thing the app does not do.

**That reading is wrong, and this section exists to stop it being reintroduced.**

A cadet learns their feedback was used by watching the instructor teach
differently. The brief is tighter, the drill sequence changed, the thing that was
confusing last block is explained first this time. That is the loop closing, and
it closes in the room, in front of them, without software involved. No
notification asserting that a change was made carries the same weight as
observing one — and an app that claimed credit for a change it cannot verify
would be worse than silent.

So this is **out of scope by nature rather than deferred by schedule**. The app's
job is to collect feedback honestly, analyse it usefully, and put it in front of
the person who can act on it, to the standard academic feedback practice expects.
It does that. What happens next is instruction, not technology, and the
detachment already has the people for it.

Anyone picking this up should not build a "you said, we did" feature here.

### The rating scale

**Cadets pick a word. The number behind it is what gets averaged, and they
never see it.** `SCALE_ANCHORS` in `js/config.js` defines both at once:

```
1 Detrimental   2 Alarming      3 Unfavorable   4 Minor        5 Neutral
6 Slight        7 Favorable     8 Major         9 Outstanding
```

All nine points are named, so the full 1-9 resolution is actually reachable.
The vocabulary alternates by design: **odd points carry the direction**
(Detrimental -> Unfavorable -> Neutral -> Favorable -> Outstanding) and **even
points carry the magnitude** of the step either side of centre: Minor (4)
mirrors Slight (6), and Major (8) is the strong step on the favourable side.

Point 2 deliberately breaks that symmetry. It was "Significant", the mirror of
Major (8), and out of context that word reads as neutral or even positive - a
cadet scanning the row had only the position to tell them it was the
second-worst option available. **"Alarming" carries its own direction**, so the
harshest end of the scale cannot be picked by mistake. Losing the 2/8 pairing is
the price, and it is worth paying at the end where a misread matters most.

Position in the row supplies direction for the remaining magnitude words: "Major"
between Favorable and Outstanding reads as a large positive. The options are
therefore always rendered in numeric order and never re-sorted, and on a narrow
screen they stack in a single column rather than a grid, so "the next step up"
stays unambiguous.

A visible number would invite people to average it in their heads while
answering, so cadets never see one. Instructors see both: the response viewer
shows the word and its value, the analysis table has a *Reads as* column, and
CSV export emits a numeric column and a word column per question.

This object **drives the UI directly** - one option per entry, so changing the
vocabulary or the number of points needs no code change. Every form records the
anchor set it was built with, so changing the wording later leaves issued
feedback untouched: old responses keep their original words and numbers and stay
comparable among themselves. Forms created before the word scale existed still
render as numbers.

`nearestAnchor()` maps a computed score back to a word for reporting. Ties round
**down**, so a mean is never described more favourably than it earned: a mean of
6.5 reads as "Slight", not "Favorable".

---

## How this was built

Direction, product decisions and the AFROTC domain knowledge are the author's.
The implementation - code, tests, and most of the documentation - was written
with Claude (Anthropic) working from that direction, decision by decision. Most
commits carry a `Co-Authored-By: Claude` trailer, so which changes were written
that way is visible in the history rather than summarised here.

Recorded because it is true and checkable, and because a detachment's IT
reviewer reading this code is entitled to know how it was produced. Copyright
and responsibility sit with the author either way - see [NOTICE](NOTICE).

## Licence

Apache License 2.0 - see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Permissive, with an explicit patent grant. A detachment may deploy it, modify
it, and keep running its own copy indefinitely with no obligation back. That is
the point: the software exists to fix a specific problem for AFROTC units, not
to be sold, and a unit should never be in a position where its feedback records
depend on the goodwill of whoever maintains this.

There are no runtime dependencies to license around - no libraries, no
frameworks, no CDN. The only external code loaded at runtime is Google Identity
Services, which is not distributed here.
