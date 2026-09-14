# Why 9ThirtyOne exists

*For cadre and commanders. What problem this solves, what it does, and what it
asks of a detachment.*

*Companion document: `STYLE.md`, the content lexicon. This one governs the
argument; that one governs the words.*

---

## 1. The problem is structural, not technical

AFROTC runs a **centralized detachment model**. One host facility serves cadets
from several Crosstown universities across a geographic area. That is the whole
point of the model, and it is also the reason none of the ordinary tooling fits.

A detachment cannot operate through any single university's IT system. It has
cadets at schools that system has never heard of. So detachments do the sensible
thing and stand up a **Det Google Account** to centralize communications — which
solves the mail problem and creates a second one. A university IT system comes
with a suite of educational tools attached: a course platform, a survey tool, a
gradebook, somewhere for evaluations to live. A Google account comes with none of
that. The detachment gets the communications and loses the tooling.

Four consequences follow, and they compound:

- **AFROTC has no feedback system standardized across detachments** that captures
  the AFROTC program itself. Nothing rolls up, because nothing has a common shape.
- **Aerospace Studies runs through the host university's system**, with varying
  degrees of return. Whatever AS100 evaluation exists at one school is not what
  exists at another, and neither belongs to the detachment.
- **Leadership Laboratory has no feedback capture at all.** LLAB is where cadets
  lead cadets. It is the part of the program most worth measuring and the part
  with the least instrumentation.
- **Upperclassmen improvise.** A cadet builds something in a consumer form tool
  to get feedback on a lab. It works, sometimes well — and it has no oversight, no
  archive, and no continuity past the term that cadet graduates.

That last one is the sharpest. It is not a tooling gap; it is a **records and
oversight gap** that a tooling gap produced. Feedback about a detachment's own
cadets, collected on a personal account, read by whoever set it up, gone at
graduation.

9ThirtyOne is built to run inside the Google processes a detachment already has,
because that is the only place it can run.

## 2. The second problem: instructing without a path to instruct

AFROTC requires upperclassmen to act as instructors for lowerclassmen. It does
not provide a formal certification process for doing it.

So a cadet is put in front of a class with the responsibility of an instructor and
none of the apparatus: no baseline, no structured feedback on their teaching, no
record of improvement across a term, nothing to show they got better at it.
Professional cadre are accountable for the outcome and are working without
instruments.

This is where feedback stops being an administrative chore and becomes the actual
training tool. A cadet instructor who can see how a block landed — and see it
again next term, measured the same way — is being developed. One who cannot is
being assigned. The apparatus is what makes the difference, and pairing it with
structured instruction on *how* to teach is what turns feedback into a
certification path rather than a survey. That pairing is the point; 9ThirtyOne is
the instrument half of it.

## 3. What it is

A free and open-source feedback management system that runs anywhere, covering the
whole cycle: **build a form, issue it, collect responses, analyse them, keep the
record.**

Concretely, day to day:

- An instructor or cadet instructor builds a **form** — a reusable set of
  questions — and issues it as a **feedback request** to a class, an event, or
  named cadets, with an open date and a due date.
- Cadets open a link, sign in with the Google account the detachment already mails
  them at, and answer. Once each. On a phone, offline, in the field if that is
  where they are.
- Whoever owns that feedback opens a **panel** and gets the ratings analysed
  rather than stacked: distributions rather than averages, questions where the
  room genuinely split called out instead of averaged into the middle, written
  answers grouped and searchable.
- Every written answer is screened for safety concerns, and a match is put in
  front of cadre quickly.
- It all stays in the detachment's own Drive folder, term after term, as a record
  that outlasts the cadets who created it.

## 4. How it works, in plain English

Four things are worth understanding, because together they are why the privacy
claims later in this document are engineering facts rather than promises.

**It is a web page, not an installation.** 9ThirtyOne is a progressive web app: a
browser opens it, and it can be added to a phone's home screen like an app. There
is no software to install on a detachment machine, no server to maintain, and no
account with anyone. Google Drive cannot host a web page — it has not been able to
since 2016 — so the app is served from a web host and the *data* lives in Drive.
Those are two separate things, and keeping them separate is what lets the
detachment own the half that matters.

**The database is a Drive folder.** Everything — forms, feedback requests,
responses, receipts, the roster, the activity log — is ordinary files in one
folder in the Det Google Account. Readable in Drive with no special software. If
the detachment stopped using 9ThirtyOne tomorrow, every response would still be
sitting there. That is not an export feature; it is the storage format.

**The app can only reach files it made.** It asks Google for a permission called
`drive.file`, which covers *files the app created itself* and nothing else. The
rest of the account was never granted — not withheld by policy, never granted. The
app cannot ask for more, and could not reach the rest of that Drive even if it
were compromised entirely.

**The submission server is what makes anonymity mean anonymity.** This is a small
script the detachment deploys inside its *own* Google account. Without it, every
cadet would need direct access to the Drive folder to file an answer — and anyone
with folder access can read the folder, so "anonymous" would mean anonymous from
the screen while being readable by any cadet who opened Drive. With it, cadets get
**no Drive access at all**: they send an answer to the detachment's own script,
which verifies them and writes the file. Nobody can read, alter, or delete anyone
else's feedback, because nobody but the server can reach where it lives.

The same mechanism carries the **join link**. Because the link holds the
configuration — the Client ID, the folder, the server — a cadet taps it, signs in,
and is done. No setup wizard, nothing pasted, nothing explained.

Two smaller things worth knowing: it works **offline** — answers written with no
signal are held on the device and sent when the connection returns — and it has
**no third-party dependencies, no build step, and no vendor libraries.** The only
external code it loads is Google's own sign-in script, from Google.

## 5. Who sees what

Access is not a filter on a screen. The cadre and commander **spaces** are
separate folders, and the detachment's own submission server decides who may open
which. A space somebody may not reach is never returned to them at all.

- **Cadets** see the feedback requests addressed to them, and never see anyone's
  responses — including their own, once submitted.
- **Instructors** see the detachment's ordinary feedback.
- **Cadre** see all of that plus a cadre space instructors cannot reach.
- **Commanders** see every space, plus one only they can read. **At most two at
  a time**, so a change of command overlaps rather than cutting over. The space
  belongs to the detachment, so a handover moves the designation and migrates
  nothing.
- **Database administrators** maintain the roster and the database. That is a
  separate job from reading feedback, so the role grants no panel access by
  itself.

There is also a view of feedback **grouped by the person it reflects on**, for
reviewing how instruction is going rather than how one event went. It follows the
same chain: an instructor is shown their own results, cadre are shown the
instructors they oversee, and a commander is shown everyone. The narrowing is
done by the submission server before anything reaches the screen.

## 6. What it asks of a detachment

- The **Det Google Account** you already have.
- Nothing at Google beyond that account. Sign-in runs through one verified
  application registered for the whole programme, so there is no Cloud project to
  create and no list of cadets to authorise. About 25 minutes, once, following the
  setup guide.
- One **Drive folder**, which the app creates itself.
- The **submission server**, deployed into that same account. Most of the 25
  minutes is this, and it is what makes everything above about anonymity true.

Not a server. Not a vendor. Not a licence, a subscription, or a budget line. No
IT ticket at any of the universities involved.

## 7. The guarantees, and their limits

Stated as narrowly as possible, because a narrow claim is one a detachment's IT
reviewer can check.

**Nothing reaches the people who publish this software.** There is no server of
ours, no database of ours, and no account with us. This is a property of the
design, not a policy — there is no channel for data to travel down.

**Anonymous results are withheld below three responses.** Not "enough", not
"several" — three. Below that line only the count of who has taken part is shown,
so a single answer cannot be picked out by elimination.

**Taking part is recorded separately from what was said.** A receipt lives in a
different file from the response, which is what lets the app say two cadets still
owe feedback without attaching anyone's answers to their name.

And the three limits that keep those honest:

**Removing names cannot change what someone wrote.** An answer describing a role
only one person holds, or an incident only one person witnessed, identifies its
author no matter what fields were stored. Treat anonymous feedback as feedback,
not as statistics.

**The safety screen matches words, never meaning.** It checks written answers
against word lists for hazing, harassment, discrimination, violence, self-harm,
substance misuse and integrity concerns. It cannot read context, sarcasm, or
quotation. It raises some matches that are nothing, and **a clear screen is never
proof that nothing was reported.** It is there to get a real disclosure in front
of a person faster, not to decide whether one happened. A match means read that
answer now and follow the detachment's own reporting procedures.

A deliberate exception worth stating plainly: **the safety screen is not subject
to the three-response threshold.** A flagged answer can reach cadre immediately,
including on a form whose results are otherwise withheld. A disclosure that needs
a person to see it should not wait for two more cadets to answer.

**Sign-in is not encryption.** Anyone with access to the Drive folder can read
every record in it directly, whatever the app chooses to show them. Folder sharing
is the real access control — which is exactly why the submission server exists,
and why cadets are given no folder access at all.
