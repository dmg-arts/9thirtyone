# 9ThirtyOne Content Lexicon

*Source of truth for terminology and voice: what the setup guide, README, `privacy.html`, the introduction deck and the app's own screens are checked against, so they stop independently rewording the same facts. This file is meant to be read mechanically, not argued with.*

*Applied by hand. There is no build step that reads it and no shared copy module — if the same wording drifts apart again in more than a couple of places, that is the argument for building one, and `ROLE_LABELS` in `js/config.js` is where it would start.*

*Why the app exists, and for whom, is `WHY.md`. This file governs the words; that one governs the argument.*

---

## 1. Term table

| Preferred | Never use | Scope |
|---|---|---|
| Cadet | "Student" | Visible text only³ |
| Submission server | "Submission proxy" | Visible text only¹ |
| Cadre | "Instructor" as a stand-in for cadre; any cadet described as cadre | Visible text only |
| AS / Aerospace Studies | — | Visible text only |
| LLAB / Leadership Laboratory | — | Visible text only |
| Crosstown universities | "Affiliated schools" | Visible text only |
| Det Google Account | "The detachment's account" (ambiguous with a personal one) | Visible text only |
| Space | "Area," "folder," for what a role can or can't reach | Visible text only |
| Panel | "Dashboard" — and never for what should say *space* | Visible text only |
| Roster | "User list" | Identifiers too² |
| Disclosure threshold | "Privacy threshold," "anonymity cutoff" | Visible text only |
| Anonymised export | "The archive" — different object, see §2 | Visible text only |
| Join link | "Invite link" | Visible text only |
| Username | "Handle" | Already consistent⁴ |
| Feedback request | "Form," when what's meant is one issued instance rather than the template | Visible text only |
| Teaching on Purpose | — | Visible text only; pitch-level material only, see §5 |

¹ `proxy.js` and other code identifiers may keep "proxy" — this row governs what a person reads, not the file that implements it.
² "Roster" the term maps to the `users/` folder, which holds the live data. `roster/` is the legacy folder migrated into `users/` on setup — a consistency pass should not rename `users/` toward `roster/`; that direction is backwards.
³ AFROTC's own word, and the one the beta detachment uses. Visible text only: `ROLES.student`, the `/student` route, `students.json`, `js/views/student.js` and `nine31.student.prefs.v1` are stored or addressed identifiers and do not move — only `ROLE_LABELS.student` changes, which is the seam that exists for exactly this. The gap between the id and the label is deliberate; there is a comment in `js/config.js` saying so.
⁴ This row previously ran the other way — "Handle" preferred, "Username" banned — on the reasoning that username is ambiguous with the sign-in identity. Reversed by decision: the sign-in identity is the *email*, and the app, the roster, the setup guide and the on-disk field have all said `username` from the beginning. Keeping "handle" would have meant a migration across ~344 sites to introduce an ambiguity nobody had reported. The few identity-sense uses of "handle" that existed were changed to username instead.


### Spelling

**en-GB, everywhere a person reads it** — *anonymised*, *organisation*, *authorised*,
*recognise*. The app's own strings already are (`js/views/instructor.js` "Export anonymised
records", `js/export-anon.js` `nine31-anonymised`), as are `privacy.html`, `terms.html`,
`about.html` and all four documents in `tools/docs/`.

Recorded because this file itself drifted: it prescribed *"Anonymized export"* while
everything it governs said *anonymised*. Code identifiers are exempt — they are addressed,
not read.

---

## 2. Object definitions

**Cadet** — A member of the detachment, from any of the schools it serves, who answers feedback requests. The word for a person; the stored role id behind them is still `student` and does not move (§1, note 3). An upperclassman cadet may also instruct, which is a job rather than a different kind of account.

**Detachment** — An AFROTC unit at a host institution, serving cadets from that school and its Crosstown affiliates. The organisational and Drive-ownership boundary the whole app is scoped to: one detachment, one Det Google Account, one 9ThirtyOne folder.

**Space** — A restricted area of the detachment's data that only certain roles can reach. The cadre space and the commander space are separate folders, not filtered views, enforced by the submission server rather than by what a screen chooses to show.

**Panel** — The screen a role works from: the Instructor Panel (detachment-wide feedback) and the Cadre Panel (the same screen, pointed at the restricted spaces). A panel is what you're looking at; a space is what it's showing you.

**Form** — A reusable template of questions an instructor builds once and can issue again without retyping it, so results stay comparable across terms and years.

**Feedback request** — One instance of a form issued to a specific cadet or group, carrying its own ID and due date. This is what a cadet actually opens and fills out.

**Response** — What a cadet submits against a feedback request: ratings and written answers, stored as its own file.

**Receipt** — The record that a specific cadet submitted, kept in a file separate from what they said. This is what lets completion be tracked without attributing content to a person.

**Roster** — The list of who may sign in and what they're allowed to do. Not a credential store — nothing in it is secret — and edited by an administrator, never by the person it describes.

**Safety screen** — The automatic check of every written answer against word lists for hazing, harassment, discrimination, violence, self-harm, and substance and integrity concerns. It matches words, never meaning.

**Disclosure threshold** — The minimum number of responses (3) required before anonymous results become visible at all. Below it, only the completion count shows.

**Join link** — The link that sets up a new device without running the setup wizard. It carries the Client ID, the folder, and the submission server, so a cadet signs in once and lands on their feedback with nothing typed.

**Submission server** — The Apps Script running inside the detachment's own Google account that files a cadet's feedback for them, so their device never needs its own Drive access. Called "proxy" only in code and developer-facing text describing the technical pattern — see §1.

---

## 3. Voice rules — before / after

> A rewritten sentence teaches more than a paragraph of adjectives.

- **Before:** "Cadet/Student feedback is fully anonymized."
**After:** "Anonymous results are held back until enough people have answered that no one response can be picked out — below that line, only the completion count shows."

- **Before:** "9ThirtyOne does not collect user data, nor is it stored on the user's device."
**After:** "The app collects no data from individual users — cadets, instructors, cadre. What briefly touches the device is only what's needed to work offline, queued locally and cleared once it syncs."

- **Before:** "Works for detachments with affiliated schools."
**After:** "Built for a detachment answering to several Crosstown universities, with no single school's IT system to rely on."

- **Before:** "The submission proxy keeps things anonymous."
**After:** "The submission server is what makes 'anonymous' mean anonymous from other cadets, not just from the screen you're looking at."

- **Before:** "Feedback is collected safely and securely."
**After:** "Every written answer is checked against word lists for hazing, harassment, and other safety concerns — a match is flagged for cadre to read now, even before enough responses exist to normally show anything."

- **Before:** "This app has no vendor and no server."
**After:** "There's no vendor to depend on and no server of ours — everything runs inside the Google account the detachment already owns."

---

## 4. Non-negotiable claims

**Locked — from the repo, do not soften:**

1. **The safety screen matches words, not meaning.** A clear screen is never proof nothing was reported; a match is never proof something was.
2. **There is no channel by which individual user data reaches the app's publisher.** Never hedge this to "we try not to collect data" or similar — it's a property of the design, not a policy.
3. **Anonymous results are withheld below exactly three responses.** Not "enough," not "several" — the number is a verifiable engineering guarantee, and vaguing it up loses the thing that makes it checkable.

4. **Removing names cannot change what someone wrote.** (`privacy.html`, "What anonymity cannot do") — distinct from claim 3; worth protecting separately because it is the caveat that keeps claim 3 honest.
5. **The app can only reach files it created itself.** The `drive.file` scope, `js/storage/drive.js:36`. A specific, checkable security claim — generalizing it to "the app only accesses what it needs" quietly loses the thing that makes it verifiable. Note it is *narrower* than "only the Drive owner can see the folder", which is not true anyway: cadre and instructors hold Drive access too.

**Overclaim guard — the one place our copy has been wrong rather than vague:**

6. **"No external dependencies" needs its exception stated.** The app bundles nothing: no third-party script tags, no build step, nothing in `js/` imported from `node_modules` (`package.json` pins test tooling only). But it injects Google's Identity Services script at runtime from `https://accounts.google.com/gsi/client` (`js/google-identity.js:28`, `js/storage/drive.js:21`), because Google sign-in requires it.

   > Say: no third-party dependencies, no build step, no vendor libraries — the only external code is Google's own sign-in script, loaded from Google.

   Never say "no outside libraries" flat. A detachment's IT reviewer disproves it in five minutes and then has reason to doubt claims 1–5, which are true and matter far more.

---

## 5. Out of scope

- **README's own developer-facing rationale.** Written for future maintainers; not a target for voice-matching against user-facing copy. Its job is precision for engineers, not warmth for cadre.
- **Teaching on Purpose / the seminar business.** Belongs in pitch-level material only — the intro deck, a cadre/commander briefing, an eventual AFROTC HQ conversation. Never the setup guide, README, or privacy.html.
- **The maintainer receiving anything about a deployment.** No longer an open question: **nothing is transmitted.** The app reports no deployment, and the only record that exists is what an administrator supplies by contacting support, which `privacy.html` §5 already describes. Copy may state this flatly — it is a property of the design, not a policy. Do not reintroduce it as a trade-off to be weighed.
- **The engineering constants themselves** (the "3" in the disclosure threshold, the `drive.file` scope, the safety-screen word lists). This lexicon governs how they're described, never what they are.
- **The safety-screen patterns.** `js/analysis/lexicon.js` uses "cadet" *inside* its matching regexes and stopword list. Those were tuned to 100% precision and 80% holdout recall against a 600-sample corpus; rewording them changes what the screen detects and invalidates the results in `tools/tuning/README.md`. The `note:` fields in that file *are* in scope — they render to whoever reviews a flag.
- **The product name.** Still being decided, and a second rename is expected before the move to a clean host. Everything here uses "9ThirtyOne" as a token, not a commitment: write copy so the name can be swapped without restructuring a paragraph around it.
