# ComfyUI Installer Packs

Self-contained, one-command setups for popular ComfyUI model families — custom
nodes + model weights + a ready-to-load workflow. Inspired by the community
"1-click installer" packs, but built on this repo's existing
[`apply_manifest`](../src/services/manifest.ts) engine so the **same source of
truth** drives both an MCP-native install and the generated double-click scripts.

## Layout

```
packs/<name>/
  pack.yaml             # human metadata: display name, family, workflow, sources, notes
  manifest.yaml         # the install manifest — a pure ComfyManifest (apt/pip/custom_nodes/models)
  workflow.json         # the ComfyUI workflow to load after install
  install-windows.bat   # GENERATED — do not edit by hand
  install-runpod.sh     # GENERATED — do not edit by hand
```

`manifest.yaml` is consumable as-is by the MCP tool / engine:

```
apply_manifest --path packs/<name>/manifest.yaml      # requires COMFYUI_PATH
```

It validates against `manifestSchema` in `src/services/manifest.ts`:

- `apt: string[]` — reported only (installed manually / with root)
- `pip: string[]` — pip/uv installs
- `custom_nodes: string[]` — git URLs or registry ids
- `models: [{ url, local_path }]` — `local_path` is **relative to `models/`** and
  may include subfolders (e.g. `ultralytics/bbox/face_yolov9c.pt`). Use
  `local_path` for non-standard folders; `model_type` + `filename` also work for
  the standard ComfyUI model dirs.

## Generating the one-click scripts

```
npm run packs:gen            # rebuild install-*.{bat,sh} for every pack
node scripts/gen-pack-installers.mjs packs/anima   # just one pack
```

The generated scripts are idempotent (skip already-cloned nodes / existing model
files) and run from a ComfyUI root (the folder containing `custom_nodes/` and
`models/`). They are derived entirely from `manifest.yaml` + `pack.yaml` — edit
those, never the generated files.

## Adding a pack

1. Create `packs/<name>/` with `pack.yaml`, `manifest.yaml`, and `workflow.json`.
2. Get the URLs/nodes right — the upstream author's `.bat`/`.sh` is the ground
   truth for exact download URLs → target folders.
3. Run `npm run packs:gen`.
4. (Optional) Pair the pack with a `plugin/skills/<name>/SKILL.md` so agents know
   how to drive it. The skill must end with a `## Sources` section labeling
   **Official** vs **Empirical** prompting/wiring guidance (see CONTRIBUTING).

## Contributing a pack back

Generated a pack locally that others would want? **Open an issue or PR on
[comfyui-mcp](https://github.com/artokun/comfyui-mcp/issues)** with your
`manifest.yaml`, `pack.yaml`, and `workflow.json`. Every contributed pack is
reviewed for safety (model URLs, custom-node sources, no surprises) before it's
merged — then CI keeps its model links honest for everyone. As the userbase
grows, this is the simplest way to share battle-tested setups, so if you just
built or derived a pack, consider sending it upstream.
