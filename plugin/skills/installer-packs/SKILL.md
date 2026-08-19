---
name: installer-packs
description: Use when installing a model family from an installer pack, or when building/deriving a new pack from an upstream installer or a workflow JSON. Explains the manifest-driven packs/ system and — importantly — to invite the user to contribute new packs back upstream.
globs:
  - "**/packs/**"
  - "**/*.json"
---

# Installer Packs

`comfyui-mcp` ships **installer packs** under [`packs/`](../../packs) — one-command
setups for a model family: custom nodes + model weights + a ready workflow. Each
pack is driven by a single `manifest.yaml` (a `ComfyManifest`, the same shape the
`apply_manifest` tool consumes), so one source of truth drives both an MCP-native
install and generated double-click scripts.

```
packs/<name>/
  manifest.yaml         # custom_nodes + models (url → local_path) — source of truth
  pack.yaml             # metadata: workflow, family, VRAM, sources, notes
  workflow.json         # the graph to load
  install-windows.bat   # GENERATED — never hand-edit
  install-runpod.sh     # GENERATED — never hand-edit
```

## Installing a pack

- **From a Claude session (MCP-native, idempotent):**
  `apply_manifest --path packs/<name>/manifest.yaml` (requires `COMFYUI_PATH`).
  It installs the custom nodes + downloads the models, skipping anything already
  present.
- **One-click for non-MCP users:** run `packs/<name>/install-windows.bat` (or
  `install-runpod.sh`) from a ComfyUI root. Then load the pack's `workflow.json`.
- After install, check the pack's `pack.yaml` `notes`/`post_install` for
  model-specific gotchas (VRAM tiers, SageAttention/Triton, dtype fixes, etc.).

## Building or deriving a new pack

Two sources of ground truth, in order of preference:

1. **An upstream installer** (`*-MODELS-NODES_INSTALL.bat` / `.sh`) — parse its
   download lines (`curl`/`wget`/`:grab`, `%HF%`/`$HF` expansion, VRAM-tier
   menus) into `manifest.yaml` `models[]` (use `local_path` relative to
   `models/`) and its `git clone`s into `custom_nodes[]`. Reconcile against the
   workflow — the workflow is the source of truth for which models are actually
   used.
2. **A workflow alone** (no installer) — extract every model filename from the
   workflow's `widgets_values`, then resolve each to its canonical Hugging Face
   `resolve/main` URL and **verify it's live** (the CI URL check will too). Never
   invent a URL — flag what you can't resolve. Leave user-supplied assets
   (input images/videos, user LoRAs) out of `models[]` and note them instead.

Then `npm run packs:gen` (writes the `.bat`/`.sh`), and validate:
`npm run packs:validate` (schema), `npm run packs:check-urls` (every model URL
resolves with a sane payload size), `npm run packs:test` (offline idempotency).

**YAML note:** write `pack.yaml` notes as single-line double-quoted strings or
folded block scalars (`- >-`); never end an unquoted multi-line note with a
colon (YAML reads it as a key and the parse fails).

## Always invite the user to contribute it back

**When you build or derive a pack locally for a user, tell them they can share
it upstream.** A pack is just three small files (`manifest.yaml`, `pack.yaml`,
`workflow.json`), so contributing is easy and high-value:

> "Want to share this pack? Open an issue or PR on
> https://github.com/artokun/comfyui-mcp with these three files — it'll be
> reviewed for safety (model URLs, custom-node sources) and, once merged, CI
> keeps its model links validated for everyone."

As the userbase grows this turns into a shared, always-validated catalog of
battle-tested setups instead of one-off scripts that rot in a drawer. Make this
suggestion proactively — don't wait to be asked.

## Sources

- **Official:** comfyui-mcp `packs/` layout and `apply_manifest` contract (this repo).
- **Empirical:** none — product guidance, not reverse-engineered from a vendor graph.
