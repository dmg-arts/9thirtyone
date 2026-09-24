# Regenerating the documents

Five of the six **PDFs** in `docs/` are generated from the running app, so every
screenshot shows real behaviour with seeded data rather than a mock-up. The four
Markdown files beside them — `WHY.md`, `STYLE.md`, `ALPHA-TAGS.md` and
`ROSTER-FORMAT.md` — are written by hand and are not built by anything here.

So is the USER Installation Guide, which is written in Pages and added by hand
with its `.pages` source beside it. Nothing in this directory rebuilds it, and
running everything here will not reproduce it.

These scripts are for maintainers and are **not** needed to run 9ThirtyOne.
They have dependencies the app itself does not: Playwright with a Chrome
binary, and `python-pptx`.

## 1. Screenshots

Start the dev server, then drive the app through a scripted session:

```bash
python3 serve.py --port 8123 --no-open &
npm install playwright                     # once
node tools/docs/capture-screenshots.mjs ./shots
```

The script completes the setup wizard, signs in a founding instructor the way
Google's callback does, seeds a detachment with eight cadets and a form with a
deliberately polarised set of responses, and captures each screen.

For the sign-in screenshot it temporarily sets a Client ID so Google's own button
renders — these captures run on the local backend, which has none — and clears it
straight afterwards. Everything else is real behaviour with seeded data.

## 1b. Every screen, from every role's point of view

```bash
python3 serve.py --port 8123 --no-open &
node tools/docs/capture-perspectives.mjs docs/screens
```

48 images into `docs/screens/`, which is **gitignored** — regenerate rather than
trusting a copy. Six folders: signed out, then one per role.

It clears only the folders it writes. Anything else you keep in there is left
alone: it used to empty the whole directory, which destroyed a contact-sheet PDF
somebody had put there, and since the folder is gitignored there was nothing to
restore from.

Each also visits the screens its role should *not* reach, kept under `refused/`,
and **the run fails if one of them opens**. That makes the folder a check rather
than a gallery: a screenshot of the Cadre Panel proves cadre can open it and
says nothing about whether an instructor can, which is the half worth knowing.

Two traps, both already hit:

- The first account to sign in claims an empty roster and is handed
  `[admin, instructor]` whatever roles were requested. Seeding a "commander"
  first therefore produced an administrator, and her By-instructor screenshot
  was the fallback tab. Roles are corrected after everyone is created.
- A refused *tab* is not a refused *panel*. Asking for `?tab=people` without the
  role lands on the panel's default tab, which is correct and shows ordinary
  panel content, so those entries name their own tell in `REFUSAL_TELL`.

## 2. The setup guide (PDF)

`setup-guide.html` is written print-first — page breaks, running footer,
Letter margins — and Chrome is the renderer those rules were tuned against:

```bash
node tools/docs/build-guide.mjs ./shots docs/9ThirtyOne-Setup-Guide.pdf
```

It inlines the two screenshot placeholders (`SHOT_SETUP_STORAGE`,
`SHOT_SETUP_FOLDERS`) as data URIs and prints through Chrome's own engine.

Two layout rules to know before editing the HTML. `ol.steps > li > strong` is a
**block-level step heading**, so a bold phrase in the middle of a sentence breaks
onto its own line — lead with it, or use `<em>`. And check the result: run
`pdftoppm -png` over the pages you changed and look at them. The last two
regressions in this document were both invisible in the source.

## 2b. The other three PDFs

`build-doc.mjs` is the generalised sibling of `build-guide.mjs`: it takes any
print-first HTML and renders it, so a 16:9 deck and a Letter guide share one
script. Geometry comes from each document's own `@page { size: ... }` rule rather
than from a flag, which is why one script can do both.

```bash
node tools/docs/build-doc.mjs tools/docs/how-to-guide.html       docs/9ThirtyOne-How-To-Guide.pdf
node tools/docs/build-doc.mjs tools/docs/user-introduction.html  docs/9ThirtyOne-User-Introduction.pdf
node tools/docs/build-doc.mjs tools/docs/overview.html           docs/9ThirtyOne-Overview.pdf
```

Placeholders it resolves: `SHOT[path]` (against `docs/screens/` then `shots/`),
`APP_ICON`, and `APP_VERSION` from `package.json`. An unresolved placeholder
throws rather than shipping a broken image — a missing screenshot in a thirty-page
PDF is not something anyone notices before it goes out.

This section did not exist for some time, which is the direct reason this README
undercounted the PDFs in `docs/` for months: the script that builds three of
them was undocumented, so they were invisible to anyone reading here.

## 3. The introduction deck (PDF)

```bash
python3 -m venv .venv && .venv/bin/pip install python-pptx
brew install --cask libreoffice                # once
.venv/bin/python tools/docs/build-deck.py ./shots docs/9ThirtyOne-Introduction.pdf
```

Slide layouts, colours and speaker notes all live in that one file. It uses the
app's own palette so the deck and the product read as one thing.

**Everything in `docs/` ships as PDF.** The deck is *drawn* with python-pptx,
because that library is what lays out slides, but the .pptx it produces will not
open in Keynote — so it is written to a temp directory, LibreOffice renders it,
and only the PDF is kept. Do not commit a .pptx; a deck that opens in one vendor's
software is a deck that fails in the room where it is presented.

The conversion substitutes Carlito for Calibri, which is metric-compatible, so
boxes land where `audit()` said they would. That audit still runs against the
intermediate before conversion, so an overflow fails the build rather than
reaching the PDF.

## Keeping them honest

The guide, the deck, `WHY.md` and `privacy.html` all state how sign-in works, the
three-response disclosure threshold, and the limits of the safety screen. If any
of those change in `js/config.js`, update all four in the same commit — a setup
guide that contradicts the app is worse than none.

`WHY.md` is the argument the other three are built on, and `STYLE.md` §4 lists
the claims none of them may soften. Read both before rewording anything a
detachment relies on.
