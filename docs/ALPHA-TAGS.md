# The alpha releases

Twelve annotated tags marked the alpha releases between 21 and 24 August 2026. All twelve
are on the remote, alongside the beta tags listed at the end of this file.

This file is not a rescue: nothing here is at risk. It exists because a tag is a poor place
to record *why* a release mattered. `git tag -l` gives twelve names and a one-line message
each; it does not tell you that four of them are a single movement, or what that movement
was for. The table below does.

**The commit SHAs are the durable part.** Every one is reachable from `main`, so
`git show <sha>` works whether or not a tag still exists anywhere.

## The releases

| Tag | Date | Commit | What shipped |
|---|---|---|---|
| `v0.4.0-alpha` | 2026-08-21 | `4639ec4` | First verified live installation; setup guide reworked from what it found |
| `v0.4.1-alpha` | 2026-08-23 | `29ad1b9` | Join links — cadets stop running the setup wizard |
| `v0.5.0-alpha` | 2026-08-23 | `3b7cea8` | The submission proxy — cadets stop needing Drive access |
| `v0.6.0-alpha` | 2026-08-23 | `3019acd` | Join QR code |
| `v0.6.1-alpha` | 2026-08-24 | `5a5796a` | "Check for updates" reports what it found |
| `v0.6.2-alpha` | 2026-08-24 | `6b103c5` | Dead code removed; Content Security Policy added |
| `v0.7.0-alpha` | 2026-08-24 | `05b7165` | Cadre **reads** move behind the proxy |
| `v0.8.0-alpha` | 2026-08-24 | `74084eb` | Cadre **writes** move behind the proxy, and Drive leaves the app |
| `v0.9.0-alpha` | 2026-08-24 | `7bc7a0c` | The cadre panel, and locked areas that are actually locked |
| `v0.9.1-alpha` | 2026-08-24 | `6678766` | Proxy executed in tests; records anonymised on deletion |
| `v0.10.0-alpha` | 2026-08-24 | `030a496` | Anonymised export |
| `v0.11.0-alpha` | 2026-08-24 | `2ae3aec` | Feedback reviewed by the person it reflects on |

## What the arc was

Four days, and one argument running through them. `0.4.0` was the first time the code
touched real Google Drive, and it exposed that every device ran the full setup wizard —
a cadet would have had to paste an OAuth Client ID on a phone before answering a form.
`0.4.1` answered that with join links.

`0.5.0` through `0.8.0` are one movement: the submission proxy arrives for cadets, then
takes over cadre reads, then cadre writes, until Drive access leaves the app entirely.
That was not tidying. Role checks in a browser cannot lock anything while every cadre
member holds Drive access to the same folder, so `0.9.0`'s locked areas were only
possible once the proxy owned the boundary — and narrowing the scope to `drive.file` as a
side effect removed Google verification and CASA from the cost sheet — see
[README.md](../README.md), under *Verification and the Client ID*.

Full SHAs, if the short ones ever collide:

```
4639ec449c30e3d8b44676eb4046a05274d3cf91  v0.4.0-alpha
29ad1b9dc76d005383b419588b22fd9015b5593b  v0.4.1-alpha
3b7cea8e74d48e6da1b259fc6afd627d79e81279  v0.5.0-alpha
3019acdd1adeb5d9d869ad1f96e7b8a99c16a3ac  v0.6.0-alpha
5a5796ac0c9cd716970275ec464d3a3b8eb6d0b0  v0.6.1-alpha
6b103c5a3445b8cadb902788b668d33a733e46e1  v0.6.2-alpha
05b716558ed7fcad94f99486ff93567feac219dd  v0.7.0-alpha
74084eb1b003984d3d73cebf3ef51b6757f4f3bd  v0.8.0-alpha
7bc7a0c4e161cb9a63b73be2f7170972627f7b42  v0.9.0-alpha
667876678d1fb06b2d802319e78a2c7cd7a02c64  v0.9.1-alpha
030a496f66304e21639559c06200c75fa9a08b4e  v0.10.0-alpha
2ae3aec45312474a6e18615f4ba73ab01ea86ce2  v0.11.0-alpha
```

## Recreating them, if the tags are ever lost

```bash
# one of them
git tag -a v0.9.0-alpha 7bc7a0c -m "Cadre panel and locked areas"

# all twelve, from the table above
git tag -a v0.4.0-alpha  4639ec4 -m "Alpha 0.4 — first verified live installation"
git tag -a v0.4.1-alpha  29ad1b9 -m "Join links"
git tag -a v0.5.0-alpha  3b7cea8 -m "Submission proxy"
git tag -a v0.6.0-alpha  3019acd -m "Join QR code"
git tag -a v0.6.1-alpha  5a5796a -m "Update check reports its outcome"
git tag -a v0.6.2-alpha  6b103c5 -m "Dead code removal and CSP"
git tag -a v0.7.0-alpha  05b7165 -m "Cadre reads through the proxy"
git tag -a v0.8.0-alpha  74084eb -m "Cadre writes through the proxy"
git tag -a v0.9.0-alpha  7bc7a0c -m "Cadre panel and locked areas"
git tag -a v0.9.1-alpha  6678766 -m "Proxy executed in tests; anonymise on deletion"
git tag -a v0.10.0-alpha 030a496 -m "Anonymised export"
git tag -a v0.11.0-alpha 2ae3aec -m "By-instructor review"
```

All twelve exist as real tags locally and on the remote at the time of writing. If they
are ever pruned from both, this file is what they were.

---

## The beta releases

Tagged as they shipped, except 1.0.3 to 1.0.5, and then 1.0.6 and 1.0.12 to 1.0.15 —
all of which went out as commits and were tagged afterwards, once the gap was noticed.
A file whose purpose is release provenance stopping three releases short is the kind of
thing that only shows up when someone goes looking.

It happened again, and worse. On 15 Oct 2026 this table still ended at 1.0.5 while the
app was on 1.0.15: **ten releases unrecorded**, in the file whose entire job is to record
them. Five of them had no tag either. Both were fixed in the same pass, which is why the
retroactive list above is longer than it was. The lesson the first gap was supposed to
teach did not take, because nothing enforces this file — no test reads it, and the version
check in `tests/unit/docs.test.mjs` ties `package.json` to `js/config.js` and stops there.
Treat a release as unfinished until it appears below.

| Tag | Commit | What it was |
|---|---|---|
| `v1.0.0-beta.1` | — | First beta: brand verified, in production, one shared Client ID for every detachment. |
| `v1.0.1-beta.1` | — | The setup wizard matched to the written instructions. |
| `v1.0.2-beta.1` | — | Proxy configured through Script Properties rather than by editing code. |
| `v1.0.3-beta.1` | `86ac7a8` | Proxy mode could never sign anybody in — the roster read needed a session that sign-in had not yet created. |
| `v1.0.4-beta.1` | `49c5e92` | Roster import reads the columns the export writes, instead of demoting every staff member to cadet. |
| `v1.0.5-beta.1` | `37da2aa` | Setup looks for an existing folder before making another. |
| `v1.0.6-beta.1` | `ce4f3b8` | The documents reconciled with the app and with each other, by hand. |
| `v1.0.7-beta.1` | `9c8bc75` | A second rollover, a button that could not work, and two clocks disagreeing. |
| `v1.0.8-beta.1` | `6d162e5` | The sign-in screen says what it is waiting for instead of sitting blank. |
| `v1.0.9-beta.1` | `388bc22` | Stopped telling cadets to click past an unverified-app warning that no longer appears. |
| `v1.0.10-beta.1` | `4411703` | A test for documents that had stopped being true, and the drift it immediately found. |
| `v1.0.11-beta.1` | `11897f4` | Measured the proxy's cold start, then hid it behind the sign-in popup. |
| `v1.0.12-beta.1` | `8654995` | Counted what a drill night costs in Apps Script executions, then spent less of it. |
| `v1.0.13-beta.1` | `1f27c4a` | A diagnostics file that describes the installation rather than the browser, because no detachment's Drive is reachable from here. |
| `v1.0.14-beta.1` | `ce63db8` | A real measurement, and the four things it said were wrong — including a consent dialog on a cadre member's own panel. |
| `v1.0.15-beta.1` | `e097391` | A 60-second client timeout. Runway, not a fix: the two staff analysis screens cross the usable ceiling at roughly sixty stored responses. |
| `v1.0.16-beta.1` | `2c543bf` | The cold-start retry gets the full timeout it already claimed — 1.0.15 raised the transport ceiling and left a second copy of the old number behind. |

---

## 1.1 and 1.2 do not exist, and that is deliberate

The app goes **1.0.16 straight to 1.3.0**. Nothing was lost; the two numbers were
never used.

There are two version lines in this project and they had drifted apart. The app was
on 1.0.16 while `PROXY_VERSION` in `tools/proxy/Code.gs` was on 1.3.0, so a
diagnostics file showed two unrelated numbers side by side and every conversation
about "1.3.0" had to say which one it meant. From the Det 752 deployment they are
aligned on purpose:

> **The minor version is shared and means "these were designed together".
> The patch belongs to the app alone.** App 1.4.x expects proxy 1.4.0.

That matters because the analysis work is **one** proxy deployment lighting up
**three** client releases: the app will run 1.4.0, then 1.4.1, then 1.4.2 against a
proxy that stays at 1.4.0. The minors matching is the claim; the patch drifting is
normal and expected.

**The one legitimate divergence**, recorded so nobody chases it as a fault: a client
rollback without a server rollback is supported by design — the old `people` action
is kept alive across the analysis release precisely so that rolling back static
files needs no re-paste of `Code.gs`. When that happens the app returns to 1.3.x
while the proxy stays 1.4.0. That is the system working, not a mismatch.

## The deployment releases

| Tag | Commit | What it was |
|---|---|---|
| `v1.3.0-beta.1` | — | **The build Det 752 installs, 23 Oct 2026.** Identical code to 1.0.16; the number is a release designation, not a change. Paired with `PROXY_VERSION 1.3.0`, which carries the email notification shipped dark. |
