# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## Unreleased

## [0.21.0] - 2026-06-29

### Added — Comfy MCP parity

Closes the capability gap with Comfy's official cloud MCP (we stay local-first + far broader):

- **`run_workflow_url`** — fetch a workflow from a shared / registry / raw-JSON URL, validate it
  (API or UI format, auto-converted), then load it or run it (`run: true`). SSRF-hardened: the host
  is DNS-resolved and every resolved address is checked against private/loopback/link-local/metadata
  ranges, redirects are rejected, and only http/https with bounded size/timeout is fetched.
- **`rerun_generation`** — re-enqueue the exact workflow behind a prior generation (newest if no
  `prompt_id`), with optional input overrides — reproducibility in one call.
- **`generate_video`** — one-call LTX-2.3 text/image-to-video on our render-verified pack stack
  (encodes the i2v strength gotcha; needs the LTX pack/models).
- **`remove_background`** — one-call BiRefNet/RMBG cutout (needs ComfyUI-RMBG).
- **`upscale_image`** — one-call model upscale (`UpscaleModelLoader` + `ImageUpscaleWithModel`).
- **Remote / hosted connector** — token auth (`Authorization: Bearer` **or** `X-API-Key`,
  constant-time) on the Streamable-HTTP `/mcp` transport, plus a one-command public tunnel
  (`npx -y comfyui-mcp --tunnel`, via the bundled `cloudflared`) that prints a paste-ready Claude
  Desktop Custom Connector URL + token. Binding `/mcp` to a non-loopback host without a token is now
  a hard error (escape hatch: `--allow-unauthenticated-non-loopback`). Browser OAuth is a tracked
  follow-up; `generate_3d` is tracked separately (needs a new 3D pack + mesh output type).

## [0.20.9] - 2026-06-27

### Added

- **`analyze_color` tool** — palette / contrast / color statistics for a generated
  image (dominant colors, average + luminance stats, contrast checks) so the agent
  can reason about an image's color without a vision round-trip.
- **Queue/render wedge watchdog** — three guards against the "stuck render + blind
  re-queue" failure where a wedged high-res sampler step let the agent stack jobs
  behind a zombie it couldn't see or kill:
  - **`panel_run` backpressure** — appends a QUEUE WARNING to the tool result when a
    render is already running, so the agent stops stacking behind it.
  - **Passive `QueueMonitor`** — a best-effort WS to ComfyUI tracking the running
    prompt / node / progress; a stuck step (the same progress value re-emitted) trips
    a one-line STALL/BACKLOG note prepended to the agent's next turn, deduped per
    episode. Threshold via `COMFYUI_MCP_STALL_S` (default 180s).
  - **`cancel_job` escalation** — interrupt → verify it actually stopped → escalate to
    `/free` → report WEDGED and suggest `restart_comfyui` if it still won't die. A new
    `clear_pending` also drops all pending jobs in the same call.
  All best-effort and fail-safe: if the watchdog WS never opens, nothing changes.

### Changed

- **Stall-warning threshold is now live-tunable.** A `set_config` bridge frame lets the
  panel change the stall threshold without a reconnect (precedence: live value →
  `COMFYUI_MCP_STALL_S` → 180s default; clamped 15–3600s).

### Fixed

- **Clone fallback fails fast instead of hanging on a credential prompt.** A custom-node
  install of a missing/private git URL used to block for minutes on a username/password
  prompt; git network ops now run non-interactively (`GIT_TERMINAL_PROMPT=0` +
  `GIT_ASKPASS`), failing in ~1s, with a tightened 180s clone timeout.

## [0.20.8] - 2026-06-27

### Fixed

- **Custom-node installs no longer silently no-op.** `install_custom_node` /
  `apply_manifest` passed the full git URL as the Manager's `id`, but ComfyUI-Manager
  keys its node DB by repo-name / CNR id (never a URL), so `resolve_node_spec`
  matched nothing and the queue reported "done" without cloning — a false success.
  Install is now **registry-first with a clone fallback**: git URLs are looked up the
  way the Manager UI does (repo name, `selected_version` `nightly`, `channel` `dev`,
  `mode` `cache`); the result is **verified** against `/v2/customnode/installed`
  (reflects on-disk packs, so it sees a freshly-installed node before a reboot); and
  only when the Manager genuinely can't resolve the pack (an unregistered repo) does
  it fall back to a direct `git clone` (+ best-effort `pip install -r requirements.txt`
  via the ComfyUI venv) — which is what the Manager does internally. A non-URL id that
  doesn't install is reported as a hard failure rather than a false success.
- **`update_all` now applies its `mode`.** It sent `mode`/`client_id` in the request
  body, but ComfyUI-Manager reads `update_all` params from the query string only, so
  they were silently ignored. They're now sent as query params.

### Security

- Hardened the custom-node install path against git-option injection (a URL starting
  with `-`) and path traversal (a repo name resolving outside `custom_nodes`, e.g.
  `..`). The git URL is validated up front (before cm-cli / Manager / clone), and the
  repo name + a `custom_nodes` containment check guard every on-disk use
  (`runGitCheckout`, the clone fallback); `git clone`/`checkout` use `--end-of-options`.



## [0.20.7] - 2026-06-27

### Fixed

- **`get_history` (no `prompt_id`) no longer returns the previous run.** It took the
  last entry in `/history`'s object iteration order, which isn't guaranteed
  newest-last and can be read before ComfyUI commits the just-finished prompt — so it
  lagged one run behind. It now selects by ComfyUI's monotonic queue number
  (`prompt[0]`), and the description steers callers to pass a `prompt_id` (or use the
  run-finished event) when naming a just-produced output. This was also the source of
  the panel's stale "Run finished" card — the panel's own event path is correct; the
  off-by-one only appeared when "the latest output" was resolved via `get_history`.
- **`apply_manifest` no longer reports a custom-node install as "applied" when nothing
  was installed.** ComfyUI-Manager drains a git-URL install task as "done" even when
  the repo isn't in its registry and nothing is cloned. `apply_manifest` now verifies
  the node is actually present afterward (via Manager's on-disk
  `/v2/customnode/installed`, which sees a freshly-cloned node even before a reboot)
  and reports "failed" with a clear message when it isn't.

## [0.20.6] - 2026-06-27

### Fixed

- **`list_output_images` now finds outputs in subfolders.** It did a flat scan of
  the output directory, so it silently missed files ComfyUI writes into subfolders —
  SaveVideo / VHS with a path-containing `filename_prefix` land at
  `output/video/clip_00001.mp4`. A finished video then looked "not found" even though
  the output directory resolved correctly. The scan is now recursive; each result
  carries its `subfolder` (`""` at top level), the pattern filter matches the
  subfolder-relative path (`video/clip`), and the listing shows the location — pass
  `{ filename, subfolder }` straight to `stage_output_as_input` / `get_image`.

## [0.20.4] - 2026-06-27

### Fixed

- **"Send now" / interrupt no longer wedges the agent.** Interrupting a turn used to
  force the turn gate open synchronously, which fed the next batch (the re-queued
  turn + the new message) into the backend before the aborted turn had settled — the
  SDK accepted the message into the session but started no turn on it, so it sat
  wedged until the slow idle watchdog (or the user's next message) nudged it. Now the
  aborted turn's `result` event drives the gate release at the right moment, with a
  bounded fallback (`COMFYUI_MCP_INTERRUPT_RELEASE_MS`, default 1500ms, keyed to the
  interrupted turn) that releases only if no result ever arrives — so an interrupt can
  never stop cold and can never run the gate ahead. The fallback is cleared on turn
  completion and on session restart (so a stale timer from a dead session can't
  force-release the next session's first turn).

## [0.20.3] - 2026-06-27

### Fixed

- **`list_output_images` now lists video outputs too.** It scans video/animation
  extensions (`.mp4 .webm .mov .mkv .m4v .avi .gif .webp`) in addition to images and
  tags each entry `kind: "image" | "video"`. This lets the agent confirm a VHS /
  LTX / WAN video render even when ComfyUI's `/history` shows the prompt done but
  lists no output (VHS_VideoCombine writes the file but often doesn't register in
  history). Guidance added: verify a video render via `list_output_images`, not
  `/history`. (#73)

### Internal

- Added a deterministic regression guard for the turn-gate drain invariant — a
  completed turn opens the gate and the next queued batch is delivered even if no
  further message arrives. (Investigation found no gate deadlock; the reported
  "stuck thinking" was a panel-side hidden-tab render issue, fixed in
  comfyui-agent-panel 0.4.3.) (#74)

## [0.20.2] - 2026-06-26

### Added

- **Subgraph I/O + unpack panel tools** — `panel_expose_subgraph_output` /
  `panel_expose_subgraph_input` let the agent wire an interior node to the
  subgraph boundary rails from inside a subgraph; `panel_unpack_subgraph` expands
  (dissolves) a subgraph back into its parent. `panel_get_graph` now reports the
  boundary rails' ids + slots when viewing a subgraph.
- **Agent guidance** — wire subgraph I/O via the expose tools (not a guessed rail
  id) and read `rails`; use `panel_unpack_subgraph` to dissolve; and **bypass
  completed pipeline stages** with `panel_set_node_mode` before queuing the next so
  finished work isn't re-run.

### Fixed

- **LTX i2v strength gotcha** — the `ltxv2-video` skill now flags that
  `LTXVImgToVideo.strength = 1.0` pins every frame to the start image (a frozen i2v
  with no motion); keep the verified ~0.6 for proper motion.

## [0.20.1] - 2026-06-26

### Added

- **`stage_output_as_input` tool** — pipe one stage's output into the next stage's
  loader (`LoadImage` / `VHS_LoadVideo` / `LoadAudio`) in one step. Fetches the output
  via the server `/view` API and re-registers it as an input via `/upload`, returning
  the input filename — so it works with **custom input/output dirs** (no filesystem
  guessing, which previously failed a render with "Invalid image file"). (#71)
- **`panel_set_node_mode` tool** — set a live-canvas node to `active` / `bypass` / `mute`
  (undo-able), and the live graph read (`panel_get_graph`) now reports each node's mode.
  Closes the gap where the agent couldn't enable a bypassed path (e.g. the KREA
  Ideogram-JSON builder) and silently rendered the wrong result. (#69)
- Agent guidance (system prompt + skills): inspect node modes and un-bypass the intended
  path before running; verify the rendered output matches the request before declaring
  success; stage outputs via the API, never by guessing filesystem paths. (#69, #71)

### Fixed

- **Reasoning-effort dropdown now works for Codex/ChatGPT models.** Codex model metadata
  now advertises `supportedEffortLevels` (none–xhigh) — the backend already applied
  effort, it just wasn't reported, so the panel hid the picker. (#67)
- **`apply_manifest` no longer re-downloads a model you already have.** The
  already-exists check now looks across **all** ComfyUI model roots (extra model paths,
  custom base dir) instead of a single computed path, with exact matching for nested
  `local_path` targets. (#68)
- Added `resolveInputDir` (mirrors `resolveOutputDir`) so path-based tools honor a custom
  `--input-directory`. (#71)

## [0.20.0] - 2026-06-26

### Added

- **`install_panel` tool + on-load install-if-missing of the ComfyUI Agent panel.**
  The orchestrator installs/updates the `comfyui-agent-panel` custom node (nightly) on
  start if it's missing, using the same path resolution as `install_custom_node`. Fully
  **dev-safe**: a linked dev checkout (a `mklink /J` junction into `custom_nodes`) is
  detected and never clobbered. Opt out with `COMFYUI_MCP_PANEL_AUTOINSTALL=0`. (#62)
- **Server self-update on start.** The orchestrator checks npm for a newer
  `comfyui-mcp` and updates itself in place, then asks you to reconnect. Install-mode is
  classified safely (global / local / npx / linked) and **a linked dev install is never
  updated**; ambiguous layouts (pnpm, nested `node_modules`) safe-fail to no-op. Opt out
  with `COMFYUI_MCP_AUTOUPDATE=0`. (#63)

## [0.19.1] - 2026-06-25

### Fixed

- **Tool robustness** (live-tested): `convert_image` / `list_output_images` now honor
  ComfyUI's `--output-directory` / `--base-directory` redirect (resolved from
  `/system_stats` argv) instead of assuming `<COMFYUI_PATH>/output`;
  `verify_workflow_lock` reports "no lock" gracefully instead of crashing; the whole
  Manager snapshot family (`list`/`save`/`restore_node_snapshot`) degrades gracefully
  on builds without the `/snapshot/*` endpoints; registry versions render as strings
  (no more `[object Object]`); `generate_node_skill` works on a bare registry id.
- **Models / queue**: `remove_model` resolves across `extra_model_paths` roots (e.g.
  a model on another drive), with a cross-platform absolute-path guard (rejects
  posix-absolute, Windows drive-letter `E:\`, and UNC paths on all hosts);
  `verify_custom_node` infers class types for re-exporting packs; `move_queued_job`
  reports a real (non-negative) queue count.
- **v3 dynamic-combo API nodes** (e.g. Nano Banana 2) serialize their dotted
  `model.<nested>` widgets into the API/prompt format, so `generate_with_api_node`
  and the UI→API conversion no longer 400.
- **`request_secret` reaches the built-in comfyui MCP server**: tool secrets
  (`CIVITAI_API_TOKEN` / `HUGGINGFACE_TOKEN` / `HF_TOKEN`, allowlisted) persist to a
  0600 store and inject into the server's spawn env on both backends, with an
  in-process respawn so a saved token applies without fighting reloads (downloads no
  longer stay 401).

## [0.19.0] - 2026-06-25

### Added

- **Multi-provider panel agent: Claude + ChatGPT/Codex at full parity.** The panel
  orchestrator is now driven through a provider-neutral **`AgentBackend`** port
  (dependency injection), so the same panel/orchestrator runs on **either** the
  Claude Agent SDK **or** OpenAI Codex — selected by the panel's backend picker
  ("pick a provider, not a port"), each on its own loopback bridge port. Both run
  on the user's own subscription (claude.ai OAuth / ChatGPT login), no API keys.
  - **`ClaudeBackend`** — the Agent SDK over a persistent streaming session
    (`@anthropic-ai/claude-agent-sdk`, optional dep).
  - **`CodexBackend`** — Codex over the `codex app-server` JSON-RPC protocol
    (`@openai/codex`, optional dep), with interrupt via `turn/interrupt` and models
    via `config/read`. A capability matrix degrades the panel gracefully
    (conversation-rollback is Claude-only for now — the app-server resumes whole
    threads only).
  - **Provider switch + effort persistence** — switching providers starts a fresh
    session; the chosen reasoning effort is preserved by mapping to the nearest
    valid level for the target backend.
- **Full Codex tool parity with Claude.** The `panel_*` live-canvas tools live in
  one shared definition list, registered onto both the in-process Claude SDK MCP
  server **and** a `@modelcontextprotocol/sdk` server over a loopback
  **streamable-HTTP MCP** the orchestrator hosts for Codex (routed by tab id). The
  headless `comfyui` MCP is injected into both backends (in-process for Claude;
  declared via `codex app-server -c mcp_servers` for Codex). The shared list means
  the surface — including the destructive-confirm gating for `panel_clear` /
  `panel_restart_comfyui` — is identical across providers.
- **Knowledge parity across backends.** New `list_skills` / `read_skill` /
  `list_packs` / `read_pack_workflow` / `list_workflow_templates` tools expose the
  bundled model-family + workflow skills, one-command installer packs, and the
  connected server's official workflow templates to any MCP client (so the Codex
  backend has the same expertise Claude loads natively), with steering toward
  packs over hand-built graphs.
- **One-shot `panel_load_workflow` + `graph_load`.** Load a full workflow onto the
  live canvas in a single call — by bundled `pack` name (read server-side, so the
  large graph never shuttles through the conversation) or by graph JSON — replacing
  the current graph and capturing it as an undo point.
- **API-node-vs-local-GPU awareness (`check_workflow_runtime`).** Classifies a
  workflow as **local** (the user's own GPU, free) or **api** / **mixed** /
  **unknown** (hosted API nodes that consume **paid** credits), using the same
  signal as `list_api_nodes`. Bundled packs are local/free; the agent is steered to
  **ASK before spending paid API credits** on any ad-hoc or generated workflow.
- **Live environment block in the system prompt.** The orchestrator gathers the
  machine once at startup (OS/GPU/VRAM/CUDA/torch/ComfyUI/python · Triton &
  SageAttention presence · local-vs-cloud · backend) — every probe hard-timed-out
  so session start never hangs — and prepends it to the prompt for both backends,
  so the agent picks models/precision and the sdpa-vs-acceleration path knowingly.
- **`panel_show_media`** — the agent can DISPLAY an image/video on demand (a disk
  path it made/downloaded, or a ComfyUI output ref) as a media card in chat
  (guarded disk read), instead of describing it in text.
- **`panel_free_vram`** — unload models + free VRAM (ComfyUI `/free`) so the agent
  can unwedge a stuck/OOM ComfyUI before retrying or restarting.
- **`strip_workflow` / `slice_workflow`** (+ `panel_*` variants) — de-virtualize any
  workflow file (Get/Set/Reroute, bypassed/muted, subgraphs) and un-chunk rgthree
  toggled pipelines.
- **Skills**: `video-extend` (Pusa 2.2 temporal flowmatching) and
  `triton-sageattention` (per-OS install with pinned wheels + sdpa fallback). Four
  new SEO blog posts (multi-provider flagship, self-healing agent, video upscale,
  Pusa extend) + a default Open Graph social card for the docs/blog.

### Fixed

- **Self-heal a Desktop-nested ComfyUI path** (the "doubled `COMFYUI_PATH`" bug):
  detection now validates a candidate is a real ComfyUI root and descends one level
  into `/ComfyUI` if it's the empty wrapper — so model downloads, crash recovery,
  and output scans target the real install. No-op for non-nested installs.
- **WMI process-creation-time read** was feeding CIM's `DateTime` back through a
  DMTF-string converter → threw on every call (disabling the pid-reuse identity
  check and flooding ComfyUI's log). Reads the `DateTime` directly now, stderr
  suppressed.
- **Finished renders auto-deliver, no polling.** `panel_run` tells the agent it
  will be notified with the output when the render finishes — so it ends its turn
  and the executed-event image injects promptly (was sometimes delayed behind the
  agent's own busy-poll turns).
- **ComfyUI run errors interrupt the agent** so it stops running blind after a
  failed queue, and **session ids persist to disk** so the chat survives an
  orchestrator restart. **Send-now** re-queues the interrupted message (both get
  answered) without re-running on a plain Stop. **Reasoning effort** snaps to the
  nearest level a model supports on a provider/model switch instead of silently
  dropping.

See the design doc: [docs/design/agent-backend-injection.md](docs/design/agent-backend-injection.md).

## [0.18.0] - 2026-06-25

### Added

- **Remote self-hosted ComfyUI behind a reverse proxy / API gateway (#52).**
  `COMFYUI_URL` now **preserves a path prefix** (e.g. `https://host/comfyapi`),
  so requests route under the prefix instead of hitting `/prompt`,
  `/system_stats`, … at the root. New `COMFYUI_AUTH_TOKEN` (+ optional
  `COMFYUI_AUTH_HEADER`, default `Authorization`, and `COMFYUI_AUTH_SCHEME`,
  default `Bearer`) attaches a generic auth header to **every** ComfyUI request
  — both the direct HTTP calls and the underlying client/WebSocket library.
  This is independent of Comfy Cloud mode (`COMFYUI_API_KEY` / `X-API-Key`), so
  a normal self-hosted instance behind a gateway no longer gets misread as
  Comfy Cloud. Requested by [@NitishMamadgi](https://github.com/NitishMamadgi).

## [0.17.1] - 2026-06-23

### Fixed

- **Broken install on 0.17.0.** The 0.17.0 `files` allowlist dropped `scripts/`
  while `package.json` still declared `postinstall: node scripts/postinstall.mjs`,
  so `npm install` / `npx -y comfyui-mcp` crashed on a missing file. Restore
  `scripts/` to the published tarball (also ships `sync-agents.mjs` so
  `npm run sync-agents` works from an install). Thanks
  [@NeoAnthropocene](https://github.com/NeoAnthropocene) (#51).

### Changed

- **Release smoke test.** CI and the release workflow now pack the tarball,
  install it into a clean project (running the postinstall hook), and boot the
  entrypoint — so a packaging regression like the above is caught before publish
  instead of after. Run locally with `npm run smoke`.

## [0.17.0] - 2026-06-22

### Added

- **Google Antigravity / `.agents` support.** A new `npm run sync-agents` script
  transpiles the Claude Code plugin — skills, agents, commands, and hooks — into
  Google Antigravity's `.agents` + `.gemini` formats (and other AI IDEs that read
  `.agents`), with a `GEMINI.md` developer guide. It's a manual dev step (no
  install/build-time side effects). Contributed by
  [@NeoAnthropocene](https://github.com/NeoAnthropocene) (#50).

### Changed

- **Leaner npm package.** Publishing now uses an explicit `files` allowlist
  (`dist`, `plugin`, `packs`, `model-settings.json` + its override template),
  dropping dev/CI/docs cruft (`scripts/`, `blog/`, `docs/`, the legacy
  `web/extensions` drop-in, dotfiles) from the tarball while keeping everything
  the server and agent actually use.

## [0.16.0] - 2026-06-19

### Added

- **Conversation rewind (`forkSession`).** The orchestrator can fork the panel
  agent's session at a chosen turn anchor, dropping everything after it from the
  agent's memory — the backend for the panel's per-message rollback (code /
  conversation / both) and double-Esc rewind.
- **Reorder queued messages.** A new `reorder` bridge frame lets the panel set the
  flush order of still-queued messages; the orchestrator stable-sorts its queue to
  match (a turn already in flight is untouched).
- **Destructive-op confirmation (#46).** `panel_clear` and `panel_restart_comfyui`
  now pop a yes/no card in the panel and only act on an explicit "yes" (gated
  in-tool, since `canUseTool` is bypassed under `bypassPermissions`).
- **Workflow layout tools + skill.** Graph reads now include node `pos`/`size` and
  subgraph I/O rail positions; new `panel_move_rail`, group create/edit,
  `panel_set_node_collapsed`, `panel_set_node_color`, and `panel_screenshot` (a
  visual verify loop) give the agent spatial control. Ships a `workflow-layout`
  skill (incl. the "expose inputs/outputs" rule).
- **ComfyUI extra search-path config tools.** Added `list_extra_paths`,
  `add_extra_path`, and `remove_extra_path` to inspect and edit standalone
  `<ComfyUI>/extra_model_paths.yaml` or ComfyUI Desktop's app-data
  `extra_models_config.yaml`. Categories are generic ComfyUI search-path keys,
  so model folders (`checkpoints`, `loras`, `vae`, etc.) and `custom_nodes`
  entries can both be managed when supported by the running ComfyUI build.
- **Queue payload inspection and pending-job edits.** `get_queue` can now include
  queued workflow payloads, `get_queued_workflow` returns one pending job's
  payload, and `move_queued_job` / `edit_queued_job` requeue pending jobs at the
  front/back with patched node inputs or a replacement workflow. Requeued jobs
  receive a new `prompt_id`; running jobs are still interrupt-only.
- **Wan Blackwell (fp16) pack tiers.** Added `-96gb` siblings for i2v / v2v /
  transparent and `wan-longer-videos-t2v-96gb` for RTX PRO 6000 Blackwell.

### Fixed

- **The panel agent never lingers as a zombie.** A wedged orchestrator used to stay
  alive but stop serving the bridge, so reloads — and even a full ComfyUI restart —
  reattached to a dead process ("the panel agent will no longer reconnect"). The
  bridge now exits on a post-startup server error, an `uncaughtException` exits
  instead of being swallowed, and Connect reclaims a lockfile-less orchestrator
  zombie that still holds the port.
- **Rewind correctness** (post-review): reset the last-assistant anchor on each
  session (re)start so a fork can't report a stale pre-fork anchor; dropped a dead
  `text` parameter from the rewind path.
- **Workflow converter robustness:** translate rgthree Power Lora Loader loras to
  `lora_N` inputs, detect `control_after_generate` on seed-named INT widgets,
  default invalid combo values, and drop type-mismatched links.
- **Wan packs:** use the official lightx2v 4-step lightning loras (2+2 split),
  switch A14B unets Q8_0 → Q4_K_S for speed, ModelSamplingSD3 shift 8 → 5 to match
  the official Wan2.2 template, and VRAM-fit settings for 24GB cards.

## [0.15.0] - 2026-06-19

### Added

- **Live-streaming panel chat.** The orchestrator streams extended-thinking and
  reply deltas to the sidebar (collapsible "see thinking" + typewriter reveal),
  with a live thinking-token counter.
- **SDK slash commands in the composer.** The orchestrator probes
  `query.supportedCommands()` and surfaces the useful built-ins — `/compact`,
  `/context`, `/usage`, `/loop`, `/goal`, `/clear` — in the panel's `/` menu
  (the user's unrelated skills/plugins are filtered out).
- **Subgraph authoring + canvas tools** — `panel_promote_widget` (expose/retract
  an inner subgraph widget on the parent node), plus the live-graph tool surface
  (subgraph enter/exit/create, node-title rename, workflow tabs, built-in Manager
  install→restart→resume).
- **Live model-download progress** streamed to the panel's status tray; **loop
  mode** drives a `panel_set_todo` checklist to completion.
- **Workflow-converter robustness** — a de-virtualization pre-pass (strips
  Get/Set + Reroute), subgraph→subgraph edge relink, top-level virtual
  `PrimitiveNode` resolution, V3 dynamic-combo recognition, default-fill of
  required inputs, and VHS object-form widgets. Packs render-verified: ideogram,
  z-image (turbo/base) ControlNets, qwen-image-edit, ltx-2.3.

### Changed

- **Removed the legacy `--channels` mode entirely.** The panel runs only on the
  autonomous orchestrator (`--panel-orchestrator`, dedicated bridge **9180**).
  The `--channels` flag/env, the in-session `panel_*` tools (`panel_say`,
  `panel_inbox`, `panel_status`), and their docs are gone; the shared UI bridge
  stays. A stray session can no longer steal the panel's bridge port.
- **Panel display name → "ComfyUI Agent Panel"** (registry slug
  `comfyui-agent-panel`); docs and the full `panel_*` tool reference updated.

### Fixed

- **Pid-reuse-safe orchestrator kill.** The pack re-verifies a pid's identity
  (cmdline + recorded creation time) immediately before every terminate/kill, and
  records `pidStartedAt` in the lockfile — so a recycled pid can never be mistaken
  for the orchestrator and a user's unrelated process is never signalled.
- **Race-free turn gate.** Replaced the resolver gate (which could deadlock and
  strand queued messages) with monotonic counters; serialized the input queue
  (one turn per batch, no SDK read-ahead) with true read-receipts.
- **Installers** target the ComfyUI venv and resolve each custom node's
  `requirements.txt` after clone (was using system Python / skipping deps).

## [0.14.0] - 2026-06-17

### Added

- **Autonomous panel orchestrator — drive the ComfyUI sidebar with a background
  agent on your Claude subscription (no API key).** `comfyui-mcp --panel-orchestrator`
  owns the loopback bridge and spawns one persistent Claude Agent SDK session per
  panel tab, so the sidebar works on its own and your interactive Claude session
  stays free. Agents authenticate via the on-disk Claude login (`apiKeySource=none`)
  and load the bundled plugin's skills, so they're ComfyUI experts out of the box.
  Replaces the unshippable `--sdk-url`/CCR-v2 path (guarded on current Claude
  Code). The panel pack auto-starts the orchestrator on ComfyUI load, and a
  parent-PID beacon shuts it down when ComfyUI exits. See
  `docs/blog/panel-agent-subscription`.

- **`installer-packs` skill.** Teaches agents how to use, build, and derive
  packs (manifest → generated install scripts) and to **proactively invite users
  to contribute new packs upstream** — an issue/PR with `manifest.yaml` +
  `pack.yaml` + `workflow.json`, reviewed for safety and CI-validated on merge.

- **`ai-toolkit-trainer` skill (renamed from `wan-lora-trainer`).** Generalized
  the ostris AI-Toolkit trainer skill to cover **Z-Image** (Turbo & Base, low-VRAM
  image LoRAs) alongside WAN 2.2 — Z-Image is single-stream (no hi/lo multi-stage),
  plus the V2 embedded-Python installer and the `No module named 'torchaudio'` fix.

- **Eight more installer packs + a WAN LoRA-trainer skill.** New `packs/`: WAN
  (`wan-animate`, `wan-longer-videos`, `wan-transparent`), Qwen (`qwen-image`,
  `qwen-image-edit`) and Z-Image (`z-image-turbo`, `z-image-base`,
  `z-image-xy-plot`), plus `cozy-flow` (AI-influencer image+video, derived from
  its workflow with no upstream installer) — bringing the catalog to **13 packs**, each manifest-driven
  with generated `install-windows.bat` / `install-runpod.sh` and CI URL+size
  validation. New `wan-lora-trainer` skill (ostris AI-Toolkit) for training WAN
  2.2 LoRAs. The LTX pack ships its kornia import fix as both `.bat` and `.sh`.

- **Blog — "Installer packs that can't rot."** Why the packs are a single
  manifest driving both the double-click scripts and an MCP-native install, with
  CI that fails the build the moment a model link dies
  (`docs/blog/installer-packs-that-cant-rot`).

- **Five new model-family skills.** `ideogram-ultra` (Ideogram 4 — open-weight
  text-to-image with area prompting, logos, posters, readable text),
  `ernie-image` (ERNIE-Image — fast text-to-image with precise multilingual text
  rendering, runs on <8GB VRAM), `anima-base` (ANIMA 1.0 — ~2B anime/illustration
  model, Danbooru tags + natural language, anime inpainting, <6GB VRAM), and
  `anima-lora-trainer` (kohya `sd-scripts` Gradio trainer for custom anime
  LoRAs). Each frontmatter `description` is tuned as an agent routing signal so
  Claude picks the right model per task (anime → ANIMA, typography/control →
  Ideogram, fast text-render → ERNIE, editing → Qwen-Edit, video → LTX).

- **Installer packs (`packs/`) — manifest-driven, one-command ComfyUI setups.**
  Each pack (`anima`, `ideogram`, `ltx-2.3`, `ernie`) is a `manifest.yaml` (a
  pure `ComfyManifest` consumable by `apply_manifest`) plus `pack.yaml` metadata
  and the workflow, with cross-platform `install-windows.bat` /
  `install-runpod.sh` generated from the manifest by
  `scripts/gen-pack-installers.mjs` (`npm run packs:gen`). Validation tooling:
  `npm run packs:validate` (schema), `packs:test` (offline idempotency dry-run
  with `git`/`curl` stubbed), and `packs:check-urls` (HEAD/range check that every
  model URL resolves and its payload size is sane for the model type — no full
  downloads). A `.github/workflows/packs.yml` CI job runs all of these on
  `ubuntu-latest`.

### Changed

- **Migrated to zod 4.** Lets the Claude Agent SDK be a clean optional
  dependency (its zod 4 peer is now satisfied); `gen-tool-docs` uses zod's native
  `toJSONSchema`, and tool schemas use the two-arg `z.record(key, value)` form.

- **The plugin now ships in the npm package.** A stale `.npmignore` rule was
  excluding `plugin/` (skills, agents, commands, hooks); anchored those patterns
  to repo root so the bundled plugin is published — which is what lets the
  orchestrator's agents load skills and be experts out of the box.

- **`ltxv2-video` skill upgraded to LTX-2.3.** GGUF UNet via `UnetLoaderGGUF`,
  separate video/audio VAEs + text-projection, the spatial upscaler and new
  LoRAs, the kornia 0.8.3+ import fix (`fix-ltxvideo-kornia.{bat,sh}`), and
  guidance for swapping in alternate / GGUF base models (incl. the community
  "sulphur" LTX-2.3 finetune).

### Fixed

- **Windows dev: the full test suite is green.** Fixed 27 tests that assumed
  POSIX paths/commands (`/fake` separators, `which` vs `where`) — test-only
  changes; the product itself was already cross-platform.

- **UI bridge survives fast `/mcp` reconnects.** The `--channels` WebSocket
  bridge now retries binding `127.0.0.1:9101` with exponential backoff
  (5 attempts, ~6s) when a previous session hasn't released the port yet,
  instead of failing with `-32000`. It logs "listening" only once truly bound,
  uses a cross-platform port-in-use hint, and clears the retry timer on `stop()`.

## [0.13.0] - 2026-06-15

### Added

- **`generate_audio` tool — audio generation from text prompts.** Supports ACE Step 1.5 (music with lyrics/structure/ key/language) and Stable Audio 3 (music, instruments, SFX). Builds the appropriate workflow graph, auto-selects local models (`diffusion_models`, `vae`, `text_encoders`, `checkpoints`), and enqueues via the existing pipeline. Two new `create_workflow` templates: `ace_step_15` and `stable_audio_3`. Requires a ComfyUI build with built-in audio nodes (`EmptyLatentAudio`, `VAEDecodeAudio`, `SaveAudioMP3`, etc.) — included in ComfyUI ≥0.11.1. Now covered by a `generate-audio` smoke-test suite (graph construction + model auto-resolution + validation for both families) and the generated tool docs (89/89 tools documented).

- **Plugin bundles the Civitai MCP — headless pairing.** `plugin/.mcp.json`
  now declares the official [Civitai MCP](https://mcp.civitai.com/mcp) remote
  server (streamable HTTP) alongside comfyui, so `/plugin install comfy`
  auto-wires `mcp__civitai__*` with no `claude mcp add` and no API key for
  browsing — the `Authorization` header defaults to an empty Bearer
  (`Bearer ${CIVITAI_API_TOKEN:-}`), which Civitai accepts for its read tools
  (verified: `tools/list` + `search_models` both work unauthenticated). Set
  `CIVITAI_API_TOKEN` to unlock gated downloads and account context — the same
  variable comfyui-mcp already uses for `download_civitai_model`.

- **`requireLocalComfyUI()` guard in client.** New assertion that blocks tools
  needing local ComfyUI filesystem access when using `--comfyui-url` with a
  non-loopback host and when `COMFYUI_PATH` is unset.

- **`RemoteModeError` error class.** Dedicated error type for operations that
  are incompatible with remote ComfyUI targets.

- **Remote mode guard for install/start/stop/restart tools.** `install_comfyui`,
  `start_comfyui`, `stop_comfyui`, and `restart_comfyui` now throw a clear error
  when `--comfyui-url` points at a remote (non-loopback) host.

  _The `generate_audio` tool and the remote-mode guards / Windows test fixes in
  this release were contributed by [@x-yahya997](https://github.com/x-yahya997)
  (`x-yahya997/comfyui-mcp@c2ff7a9`, `@27e7f02`) — thank you._

### Fixed

- **Warn when COMFYUI_URL and COMFYUI_PATH conflict.** Config now prints a
  warning to stderr when both variables are set simultaneously.

- **process-control tests pass on Windows.** Port-detection mocks now handle
  both `netstat` (Windows) and `lsof` (Unix) commands, and the config mock
  exports `isRemoteMode`.

## [0.12.0] - 2026-06-13

### Fixed

- **Panel messages now push into Claude Code for real.** The server now
  declares the experimental `claude/channel` capability and sends
  `notifications/claude/channel` with the host's expected
  `{ content, meta }` shape — previously the capability was missing and
  the params were a flat custom object, so Claude Code silently dropped
  every panel message and only `panel_inbox` polling worked.

### Added

- **`civitai` plugin skill (16 skills total).** Pairs the official
  [Civitai MCP](https://mcp.civitai.com/mcp) with comfyui-mcp instead of
  proxying it: Claude discovers models on Civitai, hands the returned
  model-version id to `download_civitai_model`, and installs/wires/generates
  locally — falling back to HuggingFace search when the Civitai MCP isn't
  connected. The `comfy-researcher` agent now prefers Civitai discovery for
  model (not node-pack) requests when those tools are present. Docs gained a
  "Pairs with the official Civitai MCP" section.
- **Multi-tab panel bridge.** Each ComfyUI browser tab now holds its own
  identified bridge connection — the panel sends a `hello` frame with a
  per-tab session id and the open workflow's title, `panel_status` lists
  every connected tab, and all graph tools accept an optional `tab_id`
  (full id or 8-char prefix). Routing default when omitted: the only
  connected tab → the tab the user most recently typed in → an error
  listing the tabs. `panel_say` broadcasts unless targeted; inbox entries
  and channel notifications carry which tab/workflow spoke. Previously a
  second tab silently stole the single connection.
- **`panel_clear` tool** — remove every node from the open graph in one
  step; the whole wipe is a single Ctrl+Z undo (panel pack executes it
  inside one `beforeChange`/`afterChange` pair).
- **Six more panel tools — full control of the open ComfyUI tab:**
  `panel_move_node`, `panel_canvas` (fit / center-on-node / pan / zoom),
  `panel_run` (queue the open workflow with live widget values),
  `panel_get_errors` (last execution error + node validation errors),
  `panel_save_workflow` (Ctrl+S or save-as/duplicate), and
  `panel_get_subgraph` (drill into a subgraph node). `panel_get_graph` now
  reports which graph the user is viewing and summarizes subgraph nodes
  shallowly (boundary slots + inner count). Panel user messages carry the
  opened subgraph in channel-event meta and inbox entries.
- **Panel v0.3 (in progress, [comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel)):**
  native ComfyUI design-system restyle (PrimeVue semantic tokens, theme-
  tracking), activity cards for every agent graph edit, empty-state
  onboarding, "Claude is working…" typing indicator. Polished registry
  release **coming soon**.

[0.13.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.13.0
[0.12.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.12.0

## [0.11.1] - 2026-06-12

### Added

- **`model-registry` plugin skill** — one curated table of download URLs +
  target `models/` subdirs for every model the skills reference (Flux, WAN,
  LTX, Qwen, Z-Image, shared VAEs/text-encoders), consolidating rows that
  were scattered across `model-settings.json` and individual skills. Grows
  each release. Plugin is now **15 skills**.
- **Plugin ships channels mode by default** — `plugin/.mcp.json` now passes
  `--channels`, so plugin users get the panel bridge + `panel_*` tools
  automatically (pair with the
  [comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel) pack).

### Changed

- **Discoverability:** README leads with "the Claude Code plugin for
  ComfyUI" and the real asset counts (88 tools / 15 skills / 11 commands /
  4 agents / 4 hooks — previously undersold as 6 skills / 10 commands);
  corrected the plugin install command (`/plugin marketplace add` +
  `/plugin install comfy`); npm description + keywords expanded; GitHub
  repo topics added (both repos had zero); new docs page
  [`/plugin`](https://comfyui-mcp.artokun.io/docs/plugin) documenting the
  full skill/command/agent/hook surface.

## [0.11.0] - 2026-06-12

### Added

- **Channels mode (`--channels`) — your own agent session drives the ComfyUI
  sidebar panel. No LLM API keys.** The server hosts a loopback WebSocket
  bridge (`COMFYUI_MCP_BRIDGE_PORT`, default 9101) that the
  [comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel) pack
  connects to, and registers nine `panel_*` MCP tools (`status`, `get_graph`,
  `add_node`, `remove_node`, `connect`, `disconnect`, `set_widget`, `say`,
  `inbox`). The agent — your existing Claude Code (or any MCP client) session,
  subscription-billed — edits the user's live graph through its MCP
  connection; every mutation is Ctrl+Z-undoable. Messages typed into the panel
  queue for `panel_inbox` and are pushed as `notifications/claude/channel`
  events on hosts that surface them. Bridge design (rid-correlated
  request/reply, loopback-only, last-writer-wins) ported from the author's
  node-lab project. New dependency: `ws`.
- **Live graph edits for the agent panel** (superseded same-day by channels
  mode above, retained as the legacy API-key path). The experimental
  `/api/chat` backend declares six client-side `graph_*` tools that the
  sidebar panel executes against the user's open LiteGraph graph. The panel
  ships as the **comfyui-mcp-panel** pack (the manual drop-in under
  `web/extensions/` is deprecated and will be removed next minor). Epic B
  step 4, built on v1 LiteGraph shims instead of waiting for
  `@comfyorg/extension-api` v2.

## [0.10.1] - 2026-06-12

### Fixed

- **Long jobs no longer killed at 10 minutes.** The job watcher's completion
  timeout was hardcoded to 10 minutes — a 15-minute LTX/WAN video render lost
  its completion notification mid-run. The timeout is now `COMFYUI_JOB_TIMEOUT_S`
  (default 1800 s = 30 min) and the poll cadence is
  `COMFYUI_JOB_POLL_INTERVAL_S` (default 2 s). Gap flagged by
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).

### Changed

- **`/object_info` is now memoized for the life of the server process.**
  `validate_workflow`, dependency extraction, and `lock_workflow` each
  triggered a fresh 300–800 ms `/object_info` fetch; repeat validations now
  serve from cache (comfy-cozy reports the same change took their re-validate
  from ~7 s to ~0.5 s). The cache resets automatically on
  `stop_comfyui` / `restart_comfyui` (the only paths that change the node
  set), with in-flight coalescing on the first fetch. Cloud mode is
  unaffected. Idea from
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).

## [0.10.0] - 2026-06-11

### Added

- **`lock_workflow` + `verify_workflow_lock`** — provenance sidecars for
  saved workflows. `lock_workflow` walks a workflow's model loaders
  (`CheckpointLoaderSimple`, `UNETLoader`, `VAELoader`, `LoraLoader`,
  `ControlNetLoader`, `CLIPLoader`/`DualCLIPLoader`, `UpscaleModelLoader`,
  …), SHA-256s every referenced model, records the git commit currently
  checked out for every custom node pack the workflow's `class_type`s
  resolve to, captures ComfyUI's reported version, and writes
  `<filename>.lock.json` next to the workflow in ComfyUI's user library.
  `verify_workflow_lock` re-computes the lock and surfaces structured drift
  (changed model SHA-256s, packs on different commits, ComfyUI version
  bumps). Local install required for v1 (SHA-256 needs file bytes;
  commits come from `custom_nodes/*/.git/HEAD`). Idea from
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).
- **Resumable model downloads.** Big-model fetches (10–40 GB checkpoints over
  flaky connections to HuggingFace / CivitAI / S3) used to start from byte 0
  every retry. The download cache now writes to a deterministic
  `~/.comfyui-mcp/cache/.<hash>.<ext>.partial` file, sends `Range: bytes=N-`
  on the next attempt, appends on `206 Partial Content`, and falls back
  cleanly to a full overwrite when the server replies `200` (Range
  unsupported). Idea from
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).

### Fixed

- **`list_local_models` now sees `extra_model_paths.yaml` redirects + works
  remotely.** The tool previously did only a filesystem scan of
  `${COMFYUI_PATH}/models/`, so models the user had pointed at via
  `extra_model_paths.yaml` (symlinked to a shared drive, mounted from a NAS,
  etc.) were invisible — a common setup for serious rigs. It also threw
  `ModelError: COMFYUI_PATH is not configured` against remote/cloud
  ComfyUI. We now query ComfyUI's `/models/<dir>` REST endpoint first
  (which reports what's actually available to workflows), fall back to the
  filesystem scan only when the HTTP path yields nothing, and return an
  empty list rather than throwing when neither is available. Size and
  modified time are only populated when the filesystem path is taken.
  Originally contributed by [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@e2ae39c8`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/e2ae39c8).

## [0.9.5] - 2026-06-11

Interoperability + paperwork.

### Added

- **MIT `LICENSE` file** at the repo root — `package.json` and the npm registry
  have always declared MIT, but the file itself was absent and downstream
  paperwork checks flagged it. Reported by
  [@ductiletoaster](https://github.com/ductiletoaster) in
  [#27](https://github.com/artokun/comfyui-mcp/issues/27).

### Fixed

- **Federation timeouts on `resources/list` / `prompts/list`** — federating
  clients (LiteLLM, etc.) probe every standard list endpoint on `initialize`
  fan-out regardless of advertised capabilities. We don't expose resources or
  prompts today, so those calls hit the SDK's default "Method not found" path
  and each downstream paid a per-server timeout (~30 s default). We now
  declare both capabilities and answer with empty lists from
  `resources/list`, `resources/templates/list`, and `prompts/list`. No
  behavioral change for clients that only use `tools/*`. Reported by
  [@ductiletoaster](https://github.com/ductiletoaster) in
  [#29](https://github.com/artokun/comfyui-mcp/issues/29).

## [0.9.4] - 2026-06-03

### Fixed

- **TS2742 portability error on pnpm builds (e.g. Glama)** — `tsc` previously
  failed to emit `dist/experimental/provider-registry.d.ts` under pnpm because
  the inferred return type of `getRegistry()` referenced a transitive type from
  `@ai-sdk/provider`, whose pnpm store path (`.pnpm/@ai-sdk+provider@…`) TS
  considers non-portable. We're a CLI/executable, not a library, so declaration
  emission was useless overhead — disabled `declaration` + `declarationMap` in
  `tsconfig.json`. `dist/` now contains only `.js` + `.js.map`; builds pass
  under both `npm` and `pnpm`.

## [0.9.3] - 2026-06-01

### Added

- **`llms-install.md`** — agent-focused install guide at the repo root, what
  Cline and similar agents read preferentially over `README.md` when setting up
  the MCP server. Covers the Node ≥ 22 prerequisite, the three deployment modes
  (local/remote/Comfy Cloud), Claude Code / Cline / Cursor settings recipes,
  optional env vars, verification, and common issues.
- **400×400 marketplace logo** at `docs/logo/mcpmarket-icon-400.png` for the
  Cline MCP Marketplace listing.

## [0.9.2] - 2026-06-01

### Fixed

- **Docker build hang on rate-limited CI (e.g. Glama)** — `npm ci` in the
  Dockerfile no longer runs the `cloudflared` postinstall, which fetches a
  ~40 MB binary from GitHub releases over an `https.get()` call with no
  timeout. On networks where GitHub rate-limits (or otherwise stalls)
  unauthenticated requests, that fetch hung indefinitely and blocked image
  builds. Install scripts are now skipped with `--ignore-scripts` and the
  two native deps we actually need (`better-sqlite3`, `sharp`) are rebuilt
  explicitly. The runtime tunnel helper already downloads the cloudflared
  binary lazily on first use, so no functionality is lost.

## [0.9.1] - 2026-06-01

### Added

- **`get_job_status` cloud-mode coverage** — when `COMFYUI_API_KEY` is set,
  `get_job_status` now dispatches to `cloud-client.getJobStatus` (which calls
  `/api/job/<id>/status`) and maps the cloud
  `{ pending | in_progress | completed | failed }` shape to the existing
  local `JobStatus`. Completed jobs are still enriched from history when
  available; failed jobs surface the cloud's error string via
  `error.exception_message`. Closes part of `comfyui-mcp-eik`.

### Changed

- Refined the `CLOUD_UNSUPPORTED` error message surfaced by tools that need
  a direct ComfyUI session (workflow library, memory management, etc.). The
  message no longer leaks the internal `getClient` function name and clearly
  tells the user to unset `COMFYUI_API_KEY` to target a local or remote
  ComfyUI.
- **Upgraded vitest to ^4.1.0** (dev-only). Clears
  [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp)
  (Vitest UI server arbitrary file read/exec). Test infrastructure tweaks:
  S3 mock now uses a `function` declaration (vitest 4 invokes mocked
  constructors via `new`) and manager-config fallback tests call
  `vi.clearAllMocks()` explicitly (vitest 4's `restoreAllMocks` no longer
  resets `.mock.calls`). Closes `comfyui-mcp-g6e`.

## [0.9.0] - 2026-06-01

Three deployment modes, slimmer install footprint, and first-class
[Comfy Cloud](https://cloud.comfy.org) support — built from a survey of
forks and a port of the cloud-dispatch architecture from
[@picoSols](https://github.com/picoSols)'s `comfyui-cloud-mcp` fork.

### Added

- **Comfy Cloud mode** — set `COMFYUI_API_KEY` to route HTTP-backed primitives
  (enqueue, history, system stats, queue, view, upload) to `cloud.comfy.org`
  with `X-API-Key` authentication. WebSocket-bound and local-FS/process
  tools throw a clear `CLOUD_UNSUPPORTED` error in this mode. New
  `src/comfyui/cloud-client.ts` mirrors the local client interface so the
  rest of the server is transparent to which backend it's talking to.
  Architecture and dispatcher pattern originally shipped by
  [@picoSols](https://github.com/picoSols) in
  [`picoSols/comfyui-cloud-mcp@7a812069`](https://github.com/picoSols/comfyui-cloud-mcp/commit/7a812069).
- **Explicit remote mode + smart-detect** — when `--comfyui-url` points at a
  non-loopback host (anything other than `127.0.0.1` / `localhost` / `::1` /
  `0.0.0.0`), the server skips `COMFYUI_PATH` auto-detection. This closes
  the root cause behind the 0.8.1 `upload_*` fix — a stale local install can
  no longer silently absorb uploads/downloads the agent intended for the
  remote target. An explicit `COMFYUI_PATH` env var still wins.
- **`isCloudMode()` / `isRemoteMode()` / `isLocalMode()`** config helpers and
  `COMFYUI_CLOUD_URL` (defaults to `https://cloud.comfy.org`).

### Changed

- **Slim install** — moved seven heavy/feature-gated packages out of
  `dependencies` into `optionalDependencies` and dynamic-import them lazily
  via a new `requireOptionalDep` helper:
  `@aws-sdk/client-s3`, `@azure/storage-blob`, `cloudflared`,
  `ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`. A
  `npm install --no-optional comfyui-mcp` now yields a working core server;
  features that need a missing optional dep surface a clear
  `OPTIONAL_DEP_MISSING` error with the exact `npm install <pkg>` hint.

### Documentation

- New "Deployment modes" section in `docs/configuration.mdx` covering the
  local / remote / cloud feature parity matrix and the `COMFYUI_API_KEY` /
  `COMFYUI_CLOUD_URL` env vars.

## [0.8.1] - 2026-06-01

Bug-fix release picking up upstream contributions from
[@joaolvivas](https://github.com/joaolvivas)'s fork of comfyui-mcp.

### Added

- **`health_check`** — single-call pre-flight diagnostic that reports
  ComfyUI/Python/PyTorch versions, GPU + VRAM, queue depth, per-category
  `/models` populations (catches empty-dropdown surprises from a
  misconfigured `extra_model_paths.yaml`), and recent errors from
  `/internal/logs`. Read-only. Useful before a long batch or when triaging an
  unexplained failure. Originally contributed by
  [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@de82ecda`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/de82ecda).

### Fixed

- **`search_custom_nodes`** — `api.comfy.org/nodes` accepts a `search` query
  parameter but ignores it server-side, returning the same paginated default
  list regardless of query. We now fetch a larger window (limit=100) and
  rank-filter client-side by id / name / author / description with a
  popularity boost, so query-relevant packs actually appear. Diagnosed and
  patched by [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@f066b597`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/f066b597);
  port adds a guard so popularity no longer inflates non-matching packs.
- **`upload_image` / `upload_video` / `upload_audio`** — HTTP-only.
  Previously these tools fell back to a local filesystem copy if HTTP upload
  failed and `COMFYUI_PATH` was set. When `COMFYUI_PATH` was auto-detected to
  an unrelated install (common for users targeting a remote `--comfyui-url`),
  the fallback wrote the file to the wrong tree and reported success, while
  the remote ComfyUI never received it — the next `LoadImage` then failed
  mysteriously. Now HTTP-only against the connected ComfyUI's
  `/upload/image` endpoint, which works for both local and remote. Diagnosed
  and patched by [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@089180ad`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/089180ad).

## [0.8.0] - 2026-05-26

Completes the custom-node authoring lifecycle, adds cloud storage I/O and
declarative setup, and adds node discovery — all built and reviewed in a
codex implement→review→fix loop.

### Added

- **`apply_manifest`** — declarative environment setup from an inline object or
  a JSON/YAML manifest: `pip` packages, `custom_nodes` (registry ids or git URLs
  with `@ref`), and `models`. Idempotent, per-item structured report; `apt`
  entries are accepted but skipped (manual/root). Local-only.
- **`verify_custom_node`** — the "test" step of the author loop: restarts ComfyUI
  (with a bounded readiness wait) and confirms a pack's `NODE_CLASS_MAPPINGS`
  class_types registered in `/object_info` (a failed import simply never appears).
- **`scaffold_custom_node`** now also emits `.comfyignore`/`.gitignore` and, with
  `with_ci`, a `.github/workflows/publish_action.yml` (Comfy-Org/publish-node-action).
- **`convert_image`** — re-encode a generated image (by `asset_id` or output-dir
  path) to PNG/JPEG/WebP via `sharp`; returns inline base64 + optional file write
  (output-dir confined), and reports bytes saved.
- **Cloud storage** — model downloads may be `s3://` or Azure Blob URLs
  (`download_model` gains `s3` auth); new **`upload_output`** pushes a generated
  output to S3 / Azure / HTTP / Hugging Face and returns URL(s).
- **`download_model` `auth`** — per-request `bearer`/`basic`/`header`/`query`
  authentication for gated/private hosts (carried over and extended).
- **`comfy-researcher` agent** — turns a problem statement into ranked custom-node
  pack recommendations (searches the Registry, evaluates, delegates deep dives to
  `comfy-explorer`).
- **Cached `generate_node_skill`** — read-through cache keyed by source@version
  (`COMFYUI_SKILL_CACHE_DIR`; `refresh` to bypass), so repeat analyses are instant.

### Security

- `apply_manifest` rejects pip argv-option injection; realpath/symlink-safe path
  containment for manifest model paths, `convert_image`, and upload sources;
  `convert_image` caps source size + sharp pixels.
- Cloud storage: Azure SAS / AWS presigned secrets redacted from logs/errors;
  Azure URL-vs-env account mismatch rejected; HF-CLI remote-path argv hardening;
  manual redirect handling (no cross-origin auth replay or upload-redirect SSRF).

### Fixed

- `generate_node_skill` cache resolves the current pack version before lookup
  (no stale docs served after a pack updates) and writes atomically (temp +
  rename with a content-hash check).

### Dependencies

- Added `yaml` (manifest parsing), `sharp` (image conversion), `@aws-sdk/client-s3`
  and `@azure/storage-blob` (cloud storage). `npm audit`: 0 high vulnerabilities.

## [0.7.0] - 2026-05-25

Stability + authoring release: hardens model downloads and the ComfyUI process
lifecycle, makes failures actionable, and adds a custom-node authoring/publishing
lifecycle. Plus a hosted docs site and an experimental embedded-agent backend.

### Added

- **Custom-node authoring** — `scaffold_custom_node` (generate a Python node pack
  from a template) and `publish_custom_node` (publish to the Comfy Registry via
  comfy-cli; key via `REGISTRY_ACCESS_TOKEN`, never logged) (#24).
- **`install_custom_node` ref pinning** — pin a pack to a commit/branch/tag, parsed
  from GitHub/GitLab/Bitbucket URLs or `repo@ref`, or an explicit `ref` arg.
- **`download_model` auth** — per-request `bearer` / `basic` / `header` / `query`
  authentication for gated/private model hosts.
- **Model download cache** — content-addressed dedup, concurrent-download coalescing,
  and optional LRU eviction (`COMFYUI_DOWNLOAD_CACHE_DIR`, `COMFYUI_LRU_CACHE_SIZE_GB`).
- **ComfyUI process supervision** — bounded startup readiness checks
  (`COMFYUI_STARTUP_CHECK_INTERVAL_S`/`_MAX_TRIES`) and opt-in bounded
  auto-restart-on-crash (`COMFYUI_ALWAYS_RESTART`, `COMFYUI_RESTART_MAX_ATTEMPTS`,
  `COMFYUI_RESTART_WINDOW_S`).
- **Plugin skills** — `comfyui-frontend-extensions` (v2 `@comfyorg/extension-api`
  authoring + v1→v2 migration) and `comfyui-node-registry` (node authoring/publishing).
- **Hosted docs** — Mintlify site with a schema-generated tool reference at
  [comfyui-mcp.artokun.io/docs](https://comfyui-mcp.artokun.io/docs).

### Changed

- **`get_job_status` + completion notifications** now surface ComfyUI
  `execution_error` detail (node id/type, exception type/message, truncated traceback,
  `current_inputs`, OOM flag) and optional per-node + total execution timing.
  Additive and backward-compatible.

### Security

- `download_model` auth inputs are validated (reject CR/LF/control chars; HTTP-token
  header names); query-auth secrets are redacted from logs and error details.
- `install_custom_node` git refs are validated and run via `git checkout
  --end-of-options <ref>`, closing an argv-option-injection vector.
- Spawned ComfyUI children now have `error` listeners so a missing/failed executable
  can't crash the MCP server.

### Experimental

- **Embedded-agent backend POC** (flag-gated via `COMFYUI_MCP_AGENT_POC`): a cloudflared
  quick-tunnel helper + an AI SDK `/api/chat` endpoint with bearer auth, a request body
  cap, and a server-side model allowlist. Not part of default startup. See
  `design/embedded-agent-panel.md` and `ROADMAP.md`.

### Dependencies

- Added `ai` + `@ai-sdk/anthropic`/`openai`/`google` + `cloudflared` (experimental POC)
  and declared `zod-to-json-schema` (docs generation). `npm audit`: 0 high vulnerabilities.

## [0.6.1] - 2026-05-25

### Added

- **Media upload** — `upload_video` and `upload_audio` copy local video/audio
  files into ComfyUI's input directory so they can be referenced as workflow
  inputs, mirroring the existing `upload_image` (closes #12).

## [0.6.0] - 2026-05-25

A large feature release that ports much of the [`comfy-cli`](https://github.com/Comfy-Org/comfy-cli)
workflow into MCP tools. New tools operate on the connected ComfyUI (local or a
remote `--comfyui-url` target), preferring the ComfyUI-Manager HTTP API with a
subprocess fallback where the API can't do the job.

### Added — comfy-cli capability port

- **Custom-node management** — `install_custom_node`, `update_custom_node`,
  `reinstall_custom_node`, `fix_custom_node`, `list_installed_nodes`,
  `sync_node_dependencies` (#15)
- **Node snapshots** — `save_node_snapshot`, `restore_node_snapshot`,
  `list_node_snapshots`; honors comfy-cli's `.json`/`.yaml` snapshot contract (#13)
- **Node bisect** — `bisect_start`, `bisect_good`, `bisect_bad`, `bisect_reset`,
  `bisect_status` to isolate a faulty custom node; never re-enables packs you had
  disabled before the session (#14)
- **Workflow dependencies** — `extract_workflow_dependencies`,
  `install_workflow_dependencies` (handles API- and UI-format workflows) (#16)
- **Install ComfyUI** — `install_comfyui`: clones ComfyUI (+ ComfyUI-Manager) and
  installs requirements into a dedicated workspace virtualenv (#17)
- **Update** — `update_comfyui` (core) and `update_all` (all custom nodes) (#18)
- **Models** — `remove_model` (path-safe) and `download_civitai_model` (#19)
- **Workspace & environment** — `get_workspace`, `set_default_workspace`,
  `list_workspaces`, `get_environment` (#20)
- **API / partner nodes** — `list_api_nodes`, `get_api_node_schema`,
  `generate_with_api_node` (#21)
- **ComfyUI-Manager configuration** — `configure_manager` (#22)

### Changed

- Rewrote tool descriptions and parameter docs across the core tool set for
  clearer purpose, usage guidance, and behavioral transparency — improving agent
  tool-selection quality (#23).
- Added a `Dockerfile`, `.dockerignore`, `glama.json`, and Glama quality badges
  for the [glama.ai](https://glama.ai) listing.

### Security

- CivitAI authentication is now sent as an `Authorization: Bearer` header instead
  of a `?token=` query parameter, so the API token no longer leaks into logs,
  errors, or redirect URLs. Model-download filenames are validated to stay within
  the models directory (closes a path-traversal hole shared with `download_model`) (#19).
- `COMFY_API_KEY` is delivered to API nodes via the `/prompt` `extra_data` payload
  rather than being placed in the workflow (#21).

### Notes

- Local-management tools (install/update ComfyUI, custom-node installs, model
  removal) require a local install (`COMFYUI_PATH`) and return a clear error when
  targeting a remote instance where the operation cannot apply.

Earlier releases predate this changelog.

[0.11.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.11.1
[0.11.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.11.0
[0.10.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.10.1
[0.10.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.10.0
[0.9.5]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.5
[0.9.4]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.4
[0.9.3]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.3
[0.9.2]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.2
[0.9.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.1
[0.9.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.0
[0.8.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.8.1
[0.8.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.8.0
[0.7.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.7.0
[0.6.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.6.1
[0.6.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.6.0
