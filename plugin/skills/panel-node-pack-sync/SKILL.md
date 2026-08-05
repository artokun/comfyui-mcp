---
name: panel-node-pack-sync
description: Keep the ComfyUI sidebar panel node-pack (comfyui-agent-panel) in step with the orchestrator after comfyui-mcp updates. Use this whenever the orchestrator was just updated (self_update, npm i -g comfyui-mcp, a new version in the ENVIRONMENT line), when a panel/bridge command fails in a way that smells like version drift ("panel is too old", a graph_/ui_ command the panel doesn't implement, a feature that works in the docs but not in the sidebar), or when the user asks to update/pin/unpin the panel. It checks the installed panel version against what THIS orchestrator build needs, RESPECTS an explicit version pin (warn-only, never move a pinned user), offers a clear way to unset the pin, runs the sync through the verified install_panel path, and reports the version RE-READ from disk. Never claim a sync that did not happen.
---

# Keep the panel node-pack in sync with the orchestrator

The orchestrator (`comfyui-mcp`, from npm) and the sidebar panel
(`comfyui-agent-panel` on the Comfy Registry, repo `comfyui-mcp-panel`) ship
**separately**. Updating one does not update the other. A new orchestrator
driving an old panel fails in confusing ways — a bridge command the panel simply
doesn't implement, a feature that exists in the docs but not in the sidebar — and
those failures are hard for a user to diagnose. This skill closes that gap.

## The two rules that outrank everything else here

1. **Never report a sync that did not happen.** This whole feature sits on top of
   the fabricate-success fixes (#639/#641): ComfyUI-Manager reports its queue
   "drained" even when it never enqueued anything, and a `.bak`-style copy in
   `custom_nodes` can shadow the real panel in the browser. So the only version
   you may ever tell the user is the one **read back from disk after the fact**.
   If the tool throws, the sync FAILED — say so plainly. Do not soften it, do not
   retry it into a success, do not report the version you *intended* to install.

2. **Never move a pinned user.** A pin is a promise. If the user pinned the
   panel, you **warn and stop**. You do not unpin for them, you do not "just this
   once", you do not sync anyway because the new version is obviously better.
   Offer to clear the pin, and act only if they say yes.

## Step 1 — Look before you touch anything

```
install_panel(action='status')
```

This never errors. Read these fields:

| Field | Meaning |
|---|---|
| `installedVersion` | The panel version on disk (from its `pyproject.toml`). |
| `sync.requiredPanelVersion` | The highest panel version **this** orchestrator build needs. |
| `sync.decision` | What to do — the whole decision is made for you (Step 2). |
| `sync.summary` | Plain-language explanation, safe to paraphrase to the user. |
| `pin` | The active pin: `{ pinned, version, source: "env"\|"settings", reason }`. |
| `shadows` | `.bak`-style copies that shadow the real panel in the browser. |
| `isDevSymlink` | A developer's symlinked checkout — never ours to modify. |

Do not compute the comparison yourself. `sync.decision` already accounts for the
pin, shadow copies, dev symlinks, remote/cloud mode, and unreadable versions.

## Step 2 — Act on `sync.decision`

| `decision` | What it means | What you do |
|---|---|---|
| `meets-floor` | Panel clears the **minimum** the orchestrator needs. It is **not** a statement that a newer panel does not exist — nothing on this path knows the newest published version, and most panel fixes ship without raising the floor (#806). | Nothing, unless the user is chasing a bug. Say "meets the minimum (X ≥ Y)", never "up to date". If they are debugging, add that a newer panel may carry the fix and that the latest is published in the pack's `pyproject.toml`. |
| `sync` | Behind, not pinned, nothing ambiguous. | Step 3 — sync it. |
| `pinned-warn` | Behind, **but pinned**. | Step 4 — warn only. **Do not sync.** |
| `blocked` | A shadow copy, or a pin we couldn't read. | Step 5 — get it unblocked first. |
| `unknown` | The installed version isn't comparable (`nightly`, `dev`, unreadable) **and nothing is pinned**. | Report it, don't guess. Offer a deliberate `install_panel(action='update')` and let the user decide. (If they *were* pinned you'd have got `pinned-warn` instead, so `unknown` never means "quietly ignore a pin".) |
| `dev-install` | Symlinked dev checkout. | Tell them to `git pull` their own checkout. Change nothing. |
| `not-applicable` | Remote/cloud, or no local ComfyUI. | Explain the panel is managed on the ComfyUI host. |

## Step 3 — Sync (`decision: "sync"`)

```
install_panel(action='sync')
```

That single call re-checks the decision at execution time (the pin may have been
set a second ago), runs the update through the hardened, verified path, and
re-reads the pack from disk afterwards. Read the result:

- `synced: true` → it really moved. Report **`verifiedVersion`** — that is the
  version observed on disk after the op, not the one we asked for. Then tell the
  user **ComfyUI must be RESTARTED** to load it (`restartRequired: true`); this
  never auto-restarts. Now read `stillBehind`, which is **tri-state**:
  - `false` → the panel provably meets what the orchestrator needs. Done.
  - `true` → the update applied but did **not** close the gap. Say so; do not
    round it up to "you're current now".
  - **`null`** → it landed, but the resulting version (e.g. `nightly`) can't be
    compared, so whether the mismatch is fixed is **unknown**. Say exactly that.
    `null` is not `false` — never report it as "you're fine".
- `synced: false` → nothing was changed. `decision` says why (`pinned-warn`,
  `meets-floor`, `blocked`, …). This is a normal outcome, not a failure.
- **The tool errored** → the sync FAILED. The error text names the cause
  (ComfyUI-Manager's stale-3.x silent no-op, a shadow copy, an unverifiable
  post-state) and the fix. Relay it. **Never** describe a failed sync as
  "completed with warnings" or "probably fine after a restart".

For a user who is on Comfy Desktop, restart via the Manager reboot endpoint
rather than killing the process.

## Step 4 — Pinned (`decision: "pinned-warn"`) — WARN, DO NOT SYNC

The user deliberately held the panel where it is. Tell them three things and then
**stop**:

1. A newer panel that matches their orchestrator exists (`requiredPanelVersion`).
2. They are pinned (say to what, and *where* the pin lives — `pin.source`).
3. How to get off it, if they want to.

> Your orchestrator (comfyui-mcp 0.48.32) expects panel 0.11.28+, and you're on
> 0.11.3 — but you've pinned the panel to 0.11.3, so I haven't changed anything.
> Want me to clear the pin and update? I'd unpin and then sync; ComfyUI needs a
> restart afterwards.

Only if they say yes:

```
install_panel(action='unpin')      # clears the persisted pin
install_panel(action='sync')       # then Step 3
```

**If `pin.source` is `"env"`**, `unpin` cannot clear it — the pin comes from the
`COMFYUI_MCP_PANEL_PIN` environment variable. Tell the user to unset it (or set
it to `off`) in their environment or `~/.comfyui-mcp/.env` and restart the
orchestrator. Do not edit their environment for them, and do not report them as
unpinned — `install_panel(action='unpin')` returns the still-active pin in that
case, and its `note` says exactly this.

## Step 5 — Blocked

- **Shadow copy** (`shadows` non-empty): a dir like
  `.comfyui-agent-panel.bak-0.11.28` in `custom_nodes` is *also* served as a web
  extension, and a dot-prefixed name wins by sort order — so the browser may be
  loading the old panel no matter what the disk says. Nothing can be verified
  until it's gone. Tell the user to move it **out of** `custom_nodes` (not just
  rename it) and hard-refresh the ComfyUI tab, then re-run Step 1.
- **Unreadable pin**: `~/.comfyui-mcp/panel-settings.json` exists but couldn't be
  parsed, so we cannot prove the user *isn't* pinned — and we refuse to move them
  on a guess. Ask them to fix or delete that file (or set
  `COMFYUI_MCP_PANEL_PIN=off`), then re-run Step 1.

## Pinning on request

If the user wants to stay on their current panel (they're mid-project, a newer
panel regressed something, they're testing):

```
install_panel(action='pin', version='<installedVersion from status>', reason='<why>')
```

`version` is required — never invent one. Pass the `installedVersion` from
Step 1 to pin them where they already are. A pin **records intent only**: it does
not change what is installed.

While it's set, everything that could move the panel refuses — not just
`install_panel`. The panel is an ordinary custom node pack, so the generic node
tools are a second door into the same operation, and they are guarded too:

- `install_custom_node` / `update_custom_node` / `reinstall_custom_node`
  targeting the panel by **any** spelling — the registry id, the repo name, or a
  git URL including ref-carrying forms like `…/comfyui-mcp-panel.git@v0.11.28`
  and `…/comfyui-mcp-panel/tree/main`. These also **route through the verified
  path** automatically, so the version they report is re-read from disk like
  `sync`'s.
- **`id="all"`, and `update_all`** — a bulk update moves the panel along with
  everything else. ComfyUI-Manager can't update everything-except-one-pack, so
  while pinned these refuse outright. If the user wants the rest updated, either
  unpin first or update the other packs individually by id. Say that plainly
  rather than quietly unpinning to make `all` work.
- `fix_custom_node`, `panel_install_node` and `panel_update_node` **refuse** a
  panel target outright — pinned or not. They report success as soon as the
  ComfyUI-Manager queue drains, which proves nothing, and there's no verified
  equivalent to route them into. Use `install_panel` instead; don't work around
  the refusal.

Prefer `install_panel` throughout — it's the one with `status`, `sync` and the
pin.

## When to run this at all

- Right after the orchestrator updates (`self_update`, a fresh `npm i -g`, or a
  version in the ENVIRONMENT line that's newer than last you saw).
- When a panel/bridge command fails in a way that smells like version drift —
  "panel is too old", a `graph_*`/`ui_*` command the panel doesn't implement, a
  documented sidebar feature that isn't there.
- Whenever the user asks to update, pin, or unpin the panel.

Be proportionate: this is a one-line check. If `decision` is `meets-floor` and the
user didn't ask, don't narrate it — just carry on with what they actually wanted.
The exception is a user who is DEBUGGING the panel: `meets-floor` is exactly the
state that hides a shipped fix behind an unchanged floor, so there it is worth the
sentence.

## Absolute rules

- **A sync that didn't move bytes is a FAILURE.** Report the thrown error, never
  a success.
- **Report `verifiedVersion`** (re-read from disk), never the target version,
  never `nightly`.
- **A pin is never overridden**, not even "temporarily". Unpin requires the
  user's explicit yes.
- **Never touch a dev symlink** — it's someone's working repo.
- **Always say a restart is required** after a sync lands; nothing here
  auto-restarts ComfyUI.
