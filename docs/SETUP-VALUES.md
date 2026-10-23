# Setup values — the strings you paste

Every value the setup procedure asks you to type, in one place, as selectable
text.

**Why this file exists.** The Setup Guide is a PDF, and GitHub's file viewer
renders PDF pages as images — the text layer is there, but the browser will not
let you select it. So anyone following the guide on GitHub had to retype the
Client ID by hand, which is a 72-character string where one wrong character
fails at the first cadet submission rather than at setup. This file is the
companion: the guide remains the procedure, and this is the strings.

If you are reading the PDF on your own machine rather than on GitHub, its text
*is* selectable and you can copy from there instead.

---

## Script Properties

Project Settings → Script Properties. Both names are case-sensitive.

### `CLIENT_ID`

The same for every detachment. Copy the whole line.

```
536562746421-uf9hu736m0bq0t41s0ck8h9fmu9ggkos.apps.googleusercontent.com
```

### `FOLDER_ID`

Yours, not a shared value. The setup wizard shows it when it creates the folder,
and it is the part of Drive's address after `/folders/`:

```
https://drive.google.com/drive/folders/THIS_PART_IS_THE_FOLDER_ID
```

---

## The script

Paste the whole of `tools/proxy/Code.gs` over an empty project. Use the **Raw**
view, so you copy the script and not the page around it:

```
https://raw.githubusercontent.com/dmg-arts/9thirtyone/main/tools/proxy/Code.gs
```

Project name:

```
9ThirtyOne Server
```

After setting both properties, run this function once from the editor:

```
checkSetUp
```

It confirms the folder is reachable, and — the part that matters — makes Google
ask for the Drive permission the script needs. Setting properties by hand never
prompts for it, and without it the first cadet submission is where you would
find out.

---

## Deployment

Deploy → New deployment → **Web app**, with exactly these two settings:

| Field | Value |
|---|---|
| Execute as | `Me` |
| Who has access | `Anyone` |

**`Anyone`, not `Anyone with a Google account`.** The two sit next to each other
in the list. Cadets reach this endpoint without a Google session, so the stricter
option refuses every submission with an error the app can only report as *could
not reach*.

The address it gives you ends in `/exec`. That goes into the app under
Settings → Submission server, then **Save and test**.

---

## A note on redeploying

When a new version of `Code.gs` is released: **Deploy → Manage deployments →
edit the existing deployment → New version.** Creating a *new* deployment mints
a new `/exec` address, and every device that already stored the old one is
instantly wrong. Saving the file does not change what `/exec` serves.
