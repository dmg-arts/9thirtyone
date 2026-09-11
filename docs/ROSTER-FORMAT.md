# Roster file format

What **Database Administration → Import roster CSV** accepts, stated precisely
enough to hand to an assistant along with your own list.

`roster-template.csv` in this folder is the same thing as a working example. The
file **Export CSV** produces is in this format too, so a roster can be exported,
edited in a spreadsheet and imported back.

---

## The prompt

Copy this, attach `roster-template.csv` and your own list — a spreadsheet, an
email, a printout you have typed up, whatever you have — and send both.

> Convert the roster below into a CSV matching the attached template exactly.
>
> - Header row exactly: `name,email,roles,class,section,username`
> - `name` — as `Last, First`. **Quote it**, because it contains a comma.
> - `email` — the Google account they sign in with. One per person, no duplicates.
> - `roles` — space-separated, from: `student`, `instructor`, `cadre`,
>   `commander`, `admin`. Leave blank for cadets. At most **two** people may
>   have `commander`.
> - `class` — one of `AS100`, `AS200`, `AS300`, `AS400`, `FT`, `CADRE`. Use
>   `CADRE` for staff. Leave blank if unknown.
> - `section` — flight or section name. Leave blank if the detachment has none.
> - `username` — leave blank. The app generates one.
>
> Do not invent email addresses. If someone's address is missing, leave the row
> out and list them separately at the end so I can chase it up.
>
> Output the CSV only, in a code block, with no commentary.

That last instruction matters: **do not let an assistant guess an email address.**
The address *is* the identity — it is what a Google sign-in is matched against —
so a plausible-looking guess creates an account the real person can never sign in
to, and one more that has to be found and deleted.

---

## Columns

Only `name` and `email` are required. A file with just those two columns works
and creates cadets, which is the common case for a new intake.

| Column | Required | Also accepted as | Notes |
|---|---|---|---|
| `name` | **yes** | `student`, `full name` | Free text. `Last, First` is conventional; anything readable works. |
| `email` | **yes** | `google account`, `address` | The Google account they sign in with. Must be unique across the roster. |
| `roles` | no | `role` | Space-, comma- or semicolon-separated. Blank means `student`. |
| `class` | no | `as class`, `asclass`, `as level` | Case-insensitive; stored in the app's capitalisation. |
| `section` | no | `flight` | Free text — flight or section name. |
| `username` | no | `user name` | Leave blank and one is generated as `last.first`. |

Column **order does not matter** — the header row is read by name. Extra columns
are ignored. Header matching is case-insensitive.

### `roles`

One or more of:

| Value | What it grants |
|---|---|
| `student` | See feedback assigned to them and submit it once. |
| `instructor` | Create feedback, read responses, run analysis; own results in *By instructor*. |
| `cadre` | Everything an instructor can, plus the Cadre Panel and every instructor's results. |
| `commander` | Sees every space including its own. **Maximum two at once.** |
| `admin` | Add and remove people, maintain the database, delete feedback with a reason. |

Multiple roles on one person are normal — `cadre instructor` is a cadre member
who also teaches. Cadre implies instructor and commander implies cadre for access
purposes, but listing both does no harm.

### `class`

`AS100`, `AS200`, `AS300`, `AS400`, `FT` (Field Training), `CADRE`.

Anything else is refused by name rather than stored, because a value outside this
list would leave the person invisible to every filter in the app — which looks
like the import having lost them.

---

## Quoting

Standard CSV. A field containing a comma, a double quote or a line break must be
wrapped in double quotes, and a literal double quote inside it doubled.

```
"Reyes, Maria",maria.reyes@det025.edu,cadre instructor,CADRE,,
```

`Last, First` names contain a comma, so in practice **every name needs quoting**.
Spreadsheets do this automatically when saving as CSV; an assistant writing the
file by hand may not, so it is worth checking the first line before importing.

---

## What happens on import

- **Rows are added, never overwritten.** Importing the same file twice does not
  duplicate anyone — the second run skips every row as a duplicate email. It also
  means the import cannot be used to *change* existing people; edit those in the
  console.
- **A bad row is skipped, not silently fixed.** The import reports each one with
  the reason: duplicate email, malformed address, unknown role, unknown class, a
  username already in use, or a third commander. Fix those rows and import the
  file again — the ones already added are skipped.
- **Blank `roles` means cadet**, so a plain name/email list behaves the way it
  always has.
- **No passwords are created or sent.** There are none. Being on this list is what
  grants access; the person signs in with the Google account named in `email`.

An empty `name` *and* empty `email` is treated as a blank line and ignored, so
trailing rows from a spreadsheet are harmless.

---

## Getting people out again

**Export CSV**, next to the import button, writes all six columns for everyone on
the roster. That file re-imports cleanly, which makes it a usable backup of the
roster on its own — though a full backup from Instructor Panel → Database covers
feedback as well and is the one to keep.

Before Beta 1.0.4 the importer read only `name`, `email` and `class` and forced
every row to cadet, so re-importing an export quietly demoted the entire staff.
If you are running an older copy, add staff by hand rather than by file.
