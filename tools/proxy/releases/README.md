# Previous proxy versions, kept for the record

`../Code.gs` is the live file — the one that gets pasted, and the one the tests
run. **These are the versions it used to be.**

Normally nothing here matches `Code.gs`, because a snapshot is taken of the
*outgoing* version. There is one deliberate exception, below.

| File | What it is |
|---|---|
| `Code-1.3.1.gs` | **What Det 752 is running right now.** Byte-identical to `v1.3.1-beta.1`. Also the rollback text if 1.4.0 has to come out |
| `Code-1.4.0.gs` | **The file pasted at Det 752 on 9 Nov 2026**, staged early and deliberately identical to `../Code.gs`. Build `a15f3d4d`, 2,602 lines. Staged because the paste is done from a laptop on the detachment's wifi, and `main` still serves 1.3.1 at the raw link the setup guide gives — see below. After the 9th this is simply what they are running, the role `Code-1.3.1.gs` holds today |

**Why a copy of the current file is here at all.** `docs/SETUP-VALUES.md` points
at `raw.githubusercontent.com/.../main/tools/proxy/Code.gs`, and the server half
has not been merged to `main` — so that link serves **1.3.1**, the file being
replaced. Pasting it would look like success: `doGet` would answer `1.3.1`, which
reads as "the deployment has not rolled yet" rather than as the mistake it is.
This snapshot is the unambiguous artefact to send and to paste from.

## The discipline

**Before changing `PROXY_VERSION`, archive the version going out:**

```bash
node tools/proxy/snapshot.mjs     # writes Code-<current PROXY_VERSION>.gs
```

Then bump `PROXY_VERSION` in `Code.gs` and carry on. The archive is of the
*outgoing* version, which is why it runs before the bump and not after.

## Which to paste

- **Anywhere, normally** → `../Code.gs`
- **Det 752, rolling back** → prefer **Deploy → Manage deployments → edit →
  select the previous version**. Two clicks, no paste error, exactly the bytes
  that were running. `Code-1.3.1.gs` is the fallback if the deployment history
  is gone
- **The testbed on this machine** → *nothing*. It matches Det 752's running
  configuration and that is the whole point of it

`tests/unit/proxy.test.mjs` enforces that every file here declares the version
in its own name, and that `Code-1.3.1.gs` still matches the git tag exactly. A
rollback artefact that has quietly drifted is worse than none, because it is
reached for at the moment nobody is in a mood to verify it.
