# Demo run sheet

One file, `demo-detachment.json`, imports a populated detachment into any install on any
backend. Nothing to run at the venue.

## Load it

**Database Administration → Backup and restore → Import → Replace.**

Replace rather than merge, so the demo is the same every time and a bad turn is one import
away from fixed.

> **The bundle contains your account and nobody else's.**
> `david.mark.gaspar@gmail.com` / `david.gaspar`, holding instructor, cadre, commander and
> admin, with the same user id your live folder already has. Replace wipes the roster
> first — importing a roster you are not in leaves a detachment with no administrator and
> no way back in. This one is safe because it carries you.

Expect `cadre/` and `commander/` folders to **appear** in Drive during the import. They are
absent beforehand because nothing has ever been written to those spaces;
`ensurePath` creates them on first write. Not a fault.

## What is in it

| | |
|---|---|
| People | 45 cadets (AS100 14 · AS200 13 · AS300 11 · AS400 7), 4 instructors, 2 cadre, 1 commander, 1 database admin, and you |
| Requests | 6 — four in the shared space, one cadre, one commander; five open, one closed from last Spring |
| Responses | 63, of which the Instructor Panel sees 51 — the cadre and commander ones are genuinely out of its reach |
| Receipts | 18, so "still owes feedback" is a real number rather than none or all |

Written answers are drawn from `tools/tuning/` — 600 labelled synthetic items, already tuned
against the lexicon, so sentiment and the word cloud behave the way the product actually
behaves rather than the way a writer imagined.

## A run that shows the argument

1. **Home.** The doors, and how little is on this screen. A cadet walking up to a shared
   laptop sees only what they can open.
2. **Instructor Panel → Responses & analysis.** 51 responses, mean 6.72. Then scroll to
   *AS200 Leadership Lab — Drill Block 3*, question one. **This is the demo.** Agreement
   0.31, "Sharply divided", and the app saying in words: *two distinct groups, 7 around
   Unfavorable and 8 around Outstanding, and the mean of 5.8 describes nobody.* Three
   unusual ratings named underneath. An average alone would have hidden all of it.
3. **The safety screen**, on the same request. A hazing concern buried inside otherwise
   ordinary feedback — which is how a real one arrives. Say the caveat out loud while it is
   on screen: it matches **words, not meaning**, and a clear screen is never proof that
   nothing was reported.
4. **By instructor.** You hold commander, so you see everyone. Worth naming what an
   instructor would see here instead — their own results — and being careful with the
   words: it narrows the **view**, it is not a wall between instructors.
5. **Cadre Panel.** The same screen pointed at a folder an instructor cannot open at all.
   The integrity flag lives here, which is the point: it is not hidden in the UI, it is in
   a different folder the server will not serve them.
6. **Database Administration.** The roster, 54 accounts, roles and AS levels.
7. **A join link or the QR code**, opened on a phone. This is the cadet half, and the only
   perspective this account cannot show — it holds no `student` role, and a Drive-backed
   install has no way to fake one.

## Resetting

Re-import. Replace mode wipes and rebuilds, so the demo returns to exactly this state.

## Rebuilding the bundle

```bash
python3 serve.py --port 8123 --no-open &
node tools/demo/build-demo-data.mjs tools/demo/demo-detachment.json
```

The generator seeds a throwaway *This device only* install through the app's own writers and
exports what they produced, so record shapes are correct by construction rather than
hand-modelled. Editing the JSON directly is possible and a bad idea.
