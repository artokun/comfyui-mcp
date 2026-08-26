---
name: panel-operations
description: On-demand procedures for the ComfyUI sidebar panel agent that are too long to sit in the system prompt. Read it when a task lands in one of these areas. subgraph boundary rails and blueprint reuse, merging or composing workflows across tabs, pinning your edits to one workflow, opening staged or downloaded workflow files, untangling Get/Set-bus and rgthree toggle-heavy graphs, authoring rgthree Fast Groups nodes, the LoRA Manager autocomplete-node limitation, the CivitAI browser flow, downloading model weights, reading hardware and runtime stats, Prompt Director audits, custom-node crash recovery, run-to-node render debugging, and multi-stage pipeline chaining. Each section is a lookup, not background reading. Reach for the one you need instead of guessing, and follow the tool's own description for parameter detail.
---

# Panel agent operations

These are the procedures the panel system prompt points at rather than carries.
Each tool named here also has its own full MCP description — that description is the
authority on parameters and edge cases. This file is the *procedure*: the order of
calls, and the traps that only show up when you string them together.

Jump to the section you need:

- [Subgraphs](#subgraphs)
- [Merging and composing workflows](#merging-and-composing-workflows)
- [Reusing subgraphs (blueprint library)](#reusing-subgraphs-blueprint-library)
- [Targeting a specific workflow](#targeting-a-specific-workflow)
- [Opening a staged or downloaded workflow](#opening-a-staged-or-downloaded-workflow)
- [Untangling a Get/Set-bus or toggle-heavy graph](#untangling-a-getset-bus-or-toggle-heavy-graph)
- [Authoring rgthree Fast Groups toggles](#authoring-rgthree-fast-groups-toggles)
- [LoRA Manager autocomplete nodes](#lora-manager-autocomplete-nodes)
- [Recommending CivitAI models](#recommending-civitai-models)
- [Downloading model weights](#downloading-model-weights)
- [Hardware and runtime stats](#hardware-and-runtime-stats)
- [Prompt Director awareness](#prompt-director-awareness)
- [Crash recovery for a broken custom node](#crash-recovery-for-a-broken-custom-node)
- [Debugging a wrong render with run-to-node](#debugging-a-wrong-render-with-run-to-node)
- [Multi-stage pipelines on one canvas](#multi-stage-pipelines-on-one-canvas)
- [Connecting MCP servers](#connecting-mcp-servers)

## Subgraphs

**Refactor a big graph into toggleable units.** Do not reconstruct group membership by
hand. `panel_query_graph` reports every group with its member `node_ids` on each
result's `groups` — groups are geometric and do not own nodes, so trust that list, not
coordinates. To make a region readable and switchable as a UNIT (e.g. a "REPLACEMENT
MODE" group), call `panel_subgraph_group(group:<title or id>)`: it wraps that group's
nodes into one subgraph node in a single step. Then toggle the whole region with
`panel_set_node_mode(<subgraph node id>, 'bypass'` to turn it OFF / `'active'` to turn
it ON). To compare variants, queue it twice — `panel_run` with the subgraph active,
then bypass and `panel_run` again. For an arbitrary node set that is not a group, use
`panel_create_subgraph` with explicit `node_ids`.

**Reading and editing inside one.** Call `panel_enter_subgraph(node_id)` first — then
`panel_query_graph` / `panel_graph_outline` and the `panel_*` edit tools operate on the
subgraph's inner nodes — and `panel_exit_subgraph` when you are done.

**Exposing interior nodes to the boundary.** To wire an interior node to the subgraph's
boundary from INSIDE it, do NOT `panel_connect` to a guessed rail node id — that is the
rail and you will get it wrong. Use:

- `panel_expose_subgraph_output(from_node_id, from_output)` to expose an interior OUTPUT
  on the output rail, so the parent graph can wire the subgraph node's new output.
- `panel_expose_subgraph_input(to_node_id, to_input)` to expose an interior INPUT on the
  input rail.

Read `panel_query_graph`'s `rails` field (present when viewing a subgraph) to see the
current boundary slots — what is already exposed and what still needs it.

**Dissolving one.** `panel_unpack_subgraph(node_id)` inlines the inner nodes back into
the parent graph and rewires external links, removing the wrapper — the inverse of
`panel_create_subgraph`. All of these are undoable with Ctrl+Z.

## Merging and composing workflows

To bring nodes from ONE workflow into ANOTHER (combine two graphs, copy a section
across tabs, reuse part of a saved workflow), use copy/paste:

1. `panel_open_workflow` — the source.
2. `panel_select_nodes` — the section you want, or select all the ids from
   `panel_query_graph {fields:'ids'}`.
3. `panel_copy_nodes`.
4. `panel_open_workflow` or `panel_new_workflow` — the destination.
5. `panel_paste_nodes` — returns the new node ids.
6. Wire and tidy them, applying the `workflow-layout` skill so the merged result is
   clean with no overlaps.

The clipboard SURVIVES the workflow switch, so the copied nodes carry across tabs. Use
`connect_inputs` only when you want the pasted nodes to auto-reconnect to matching
existing nodes; the default (false) drops a clean disconnected copy you wire yourself.

## Reusing subgraphs (blueprint library)

When the user builds a useful subgraph and wants to reuse it — now or in other
workflows — SAVE it: `panel_create_subgraph` to group the nodes (if not already a
subgraph), then `panel_save_subgraph(node_id, name)` publishes it to their library
programmatically (no dialog). To drop a saved one into ANY workflow later, list them
with `panel_list_subgraphs` and add with `panel_add_subgraph(name)`.

This is the durable way to reuse a building block across projects — distinct from
copy/paste, which is a one-off merge of the current clipboard.

## Targeting a specific workflow

By default your `panel_*` graph edits follow whichever workflow tab the user is
currently viewing. The panel can only read or edit the workflow currently IN VIEW, so
to work on a specific open workflow, make it the active canvas first with
`panel_open_workflow`, then call
`panel_set_workflow_target(mode:"pinned", path:<from panel_list_workflows>)` to bind
your edits to it. `panel_get_workflow_target` shows the current binding.

Pinning to a background (open but not active) workflow is REJECTED at pin time — it
cannot route edits to a tab that is not in view. A pin does NOT switch what the user
sees; it binds your edits to that workflow so that if the user later switches away,
your next graph call fails loudly instead of silently editing the wrong graph. Set
`mode:"current"` to follow the user's active tab again.

Tabs are managed with `panel_list_workflows` / `panel_open_workflow` /
`panel_rename_workflow` / `panel_close_workflow`. To label, move, resize, recolor,
collapse, or pin a node for presentation, use `panel_edit_node`.

## Opening a staged or downloaded workflow

When you have saved or downloaded a workflow `.json` into the user's ComfyUI workflows
folder (e.g. an example you fetched), open it with
`panel_open_workflow(path:<name-or-path>)` — it REFRESHES the frontend's cached
workflow list before searching, so a just-staged file is found and opened natively in
its own tab.

For a workflow `.json` that lives OUTSIDE the workflows folder (any absolute path on
the ComfyUI machine, or a downloaded example you did not move into `workflows/`), load
it directly onto the live canvas with `panel_load_workflow(path:<file>)` — the
orchestrator reads and parses the JSON server-side and drops it on the canvas in one
shot, so even a large (100KB+) workflow never has to shuttle through the chat. Prefer
`panel_load_workflow(path:<file>)` over pasting a big workflow JSON inline as the
`graph` argument.

## Untangling a Get/Set-bus or toggle-heavy graph

Expert and community graphs are often thick with VIRTUAL WIRING — GetNode/SetNode
buses and Reroutes that hide the real connections — and rgthree "Fast Groups
Bypasser/Muter" TOGGLED PIPELINES (one graph holding several pipelines, only one active
at a time). Do NOT hand-trace GetNode to SetNode links or guess which branches are
live.

- To get the REAL wiring: `panel_strip_workflow(path:<file> | pack:<name> |
  graph:<json>)`, or with no argument to read the LIVE canvas. It resolves Get/Set
  buses, Reroutes, subgraph definitions, and bypassed/muted nodes into REAL connections
  and returns the flat, runnable graph (read server-side, never shuttled through chat).
- If the file is a MULTI-PIPELINE monolith and you want only ONE pipeline, FIRST
  `panel_slice_workflow(path:<file>, groups:[<group-title substrings>])` to carve that
  pipeline into a standalone activated graph — it seeds from the output nodes in those
  groups, takes their backward closure through links and Set/Get buses, and un-bypasses
  the kept nodes — THEN `panel_strip_workflow` to flatten the buses.

Reach for `panel_strip_workflow` whenever a graph is too tangled to read directly or
you need to UNDERSTAND or REBUILD its actual wiring; reach for `panel_slice_workflow`
when an ULTRA-style monolith bundles several toggled pipelines and you want just one.
The same two exist as `get_workflow (action:"strip")` and `get_workflow
(action:"slice")` for non-panel sessions.

## Authoring rgthree Fast Groups toggles

The counterpart to reading them, above. Fast Groups Bypasser/Muter are FRONTEND-ONLY —
registered by the pack's JS and absent from `/object_info` BY DESIGN, so their absence
there is NOT evidence they are unavailable. `panel_add_node` adds them: it exempts a
small allowlist of genuinely frontend-only types covering the Fast (Groups)
Bypasser/Muter, Label, Reroute and Node Collector — but NOT Bookmark, the Mute/Bypass
Relay/Repeater, Fast Actions Button or Random Unmuter, which it refuses fail-closed.

Procedure and traps:

- They are configured with `panel_set_property`, NOT `panel_set_widget` — `matchTitle`,
  `matchColors`, `sort` and `toggleRestriction` are node PROPERTIES, and
  `panel_set_widget` refuses them.
- They take no wiring and enumerate GROUPS by title, so create and NAME the groups
  FIRST, and ALWAYS set `matchTitle` or the node lists every group in the workflow.
- Set `matchTitle` immediately after adding the node, then re-read the node. Fast Groups
  do NOT implement `onPropertyChanged`, so the first write stores the filter but may
  leave leftover Enable rows or `widgets:{}` (unbuilt, not "no matches"). If the list is
  wrong, set `matchTitle` AGAIN — do NOT delete and re-add the node.
- Group membership is GEOMETRIC (any node whose centre lands in the box). When
  `panel_create_group` returns `extra_node_ids` / `missing_node_ids` and a warning, FIX
  IT before toggling, or a toggle disables part of the wrong stage.

Load the `rgthree` skill (`list_packs (action:"skill_read", name:"rgthree")`) before
configuring these.

## LoRA Manager autocomplete nodes

`panel_add_node` cannot add "Lora Loader (LoraManager)", "Lora Stacker (LoraManager)",
or other LoRA Manager nodes whose required input is `AUTOCOMPLETE_TEXT_LORAS` /
`AUTOCOMPLETE_TEXT_PROMPT` — the add waits 5s and refuses even when the pack and its UI
are healthy. That is NOT a missing extension: reloading, `panel_refresh_nodes`, and
retrying will keep failing.

Use "LoRA Text Loader (LoraManager)" instead (`lora_syntax` is a STRING socket you can
drive) or the core `LoraLoader`. Load the `lora-manager` skill (`list_packs
(action:"skill_read", name:"lora-manager")`) before authoring these.

## Recommending CivitAI models

SHOW, don't just tell. When the user asks about — or you are recommending — specific
CivitAI resources (a "good relight LoRA?", "which Flux checkpoint?", "find me an anime
style"), LEAN TOWARD opening the docked CivitAI browser and highlighting your picks
rather than answering with only a text table:

1. `panel_open_civitai` — docked, with a matched query/tab/filters.
2. `panel_civitai_search` — refine.
3. `panel_civitai_results` — read the metadata and URLs.
4. `panel_civitai_highlight` — the one(s) you recommend, with a BRIEF text summary of
   why each fits.

This docks beside the chat so both stay visible, and lets the user SEE the actual
cards. You read metadata and URLs only, not the images. It is a nudge, not a mandate —
a quick factual answer, or a resource the user already named, is fine as text; reach for
the browser when they are choosing between options or exploring.

## Downloading model weights

Use `download_model (action:"download")`, or `action:"download_civitai"` for CivitAI —
NOT a raw shell download. It streams the file into the correct ComfyUI `models/`
subfolder AND surfaces live progress in the panel's download tray so the user can watch
it. Pass `target_subfolder` to land the file exactly where it belongs (e.g. `loras`,
`checkpoints`, `vae`, `text_encoders`, or a nested path like `loras/<subdir>`).

Do NOT shell out to curl/wget/aria2 for model files — a raw shell download has no
progress in the panel and can drop the file in the wrong place. Reserve the shell for
things `download_model` cannot do.

## Hardware and runtime stats

For GPU / VRAM / CPU / RAM, CUDA/torch/python versions, and ComfyUI runtime stats, call
`get_system_stats` (raw `/system_stats`) or `install_comfyui (action:"environment")` (a
summarized snapshot). Both read the CONNECTED ComfyUI's `/system_stats` and work for
LOCAL and REMOTE targets alike.

Do NOT shell out (nvidia-smi, PowerShell, wmic, python) for hardware info: the managed
shell is sandboxed and read-only, rejects multi-line scripts, and only ever reaches the
orchestrator host — not a remote ComfyUI. The startup ENVIRONMENT line already
summarizes the machine; when you need current or more detail, these two tools are the
source of truth.

## Prompt Director awareness

When the graph contains `PromptDirector`, `PromptDirectorAuto`, `PromptDirectorContext`,
`PromptProducer`, or `PromptDirectorResultCritic` nodes, call
`panel_audit_prompt_director` BEFORE declaring that the prompt/model/LoRA setup is
correct, or diagnosing a failed edit.

The audit correlates live wiring and loader widgets with the nodes' resolved Model
Explorer metadata, edit plan, LoRA compatibility and strengths, the exact final prompt,
warnings, and the critic verdict. Surface concise, useful observations proactively —
including when the configuration is coherent. Its recommendations are READ-ONLY
proposals: ask before applying `panel_set_widget` / `panel_connect` changes unless the
user already explicitly asked you to fix the workflow.

## Crash recovery for a broken custom node

If your turn begins with a "⚠️ ComfyUI crashed …" note — it names the fatal log block
and the most likely culprit custom node plus `file:line` — or a run dies with a
node-level error you can pin to one pack, do NOT just re-run the same graph. ESCALATE
to actually fix that node, narrating each step to the user as you go:

1. **UPDATE it to the latest code.** Call `panel_update_node` with the culprit's id, or
   the comfyui MCP `install_custom_node` with `action:"update"` / `action:"fix"`. Try
   version `nightly` to grab a just-landed upstream fix. Poll
   `panel_node_queue_status`, then `panel_restart_comfyui` — you resume and RETRY the
   action to see if the crash is gone.
2. **If updating does not fix it, reach into the source.** Go to
   `COMFYUI_PATH/custom_nodes/<NodeDir>` with your shell. If it is a git repo (a `.git`
   dir), run `git fetch && git pull`, or check out the nightly branch, to force the
   latest; reinstall its requirements if needed; then restart and retry.
3. **If there is no git or it is still broken, patch the source.** Attempt a TARGETED
   patch of the crashing `file:line`, then VERIFY the fix actually resolves the crash —
   restart and retry the same action, confirming it no longer faults.
4. **Offer it upstream.** Once verified, OFFER to suggest the fix to the repo owner
   (open an issue or PR describing the crash and your patch). Describe it and ask the
   user first; do NOT auto-file anything against a third party.

This combines cleanly with the normal install → restart → continue flow: a fresh
install that crashes on first use is the same loop — update or patch the just-installed
node, do not abandon it.

## Debugging a wrong render with run-to-node

For a render that COMPLETES but comes out WRONG — artifacts, wrong subject, pose,
composition or colour, blur, a ControlNet/IPAdapter/mask/LoRA not taking, a refiner or
upscale stage degrading it. (For runs that FAIL with an error, OOM, or a missing node,
use the `troubleshooting` skill instead.)

Do NOT just re-roll the whole graph. LOCALIZE the fault — render only up to one stage
and LOOK at what that stage produces:

- `panel_run` takes `to_node_id` to run ONE output branch (ComfyUI partial execution).
  Only that output node plus everything upstream of it renders; the rest is skipped, so
  it is fast and cheap, and the result is delivered to you automatically like any run.
- `to_node_id` MUST be an OUTPUT node (`is_output:true` in `panel_query_graph` detail
  rows).
- To inspect a point that is NOT an output — a latent, a preprocessor/depth/pose map, a
  mask, an intermediate image — TAP it: add a `PreviewImage` on an IMAGE wire, or
  `VAEDecode` → `PreviewImage` on a LATENT, or `MaskToImage` → `PreviewImage` on a
  MASK. Then `panel_run(to_node_id=that preview)`, read the delivered image, and
  `panel_remove_node` the tap when done.
- Bisect upstream to downstream until you find the FIRST stage whose output is bad —
  that node, or its inputs and widgets, is what to fix. Run-to-node there again to
  confirm before a full run.

For the full method (probe recipes, symptom-to-probe map) read the `debug-render` skill
via `list_packs (action:"skill_read")`.

## Multi-stage pipelines on one canvas

For example Krea2 image → LTX video → WAN extend, all built on one canvas.

**Chain a stage's output into the next stage's loader.** When the next stage's loader
(`LoadImage` / `VHS_LoadVideo` / `LoadAudio`) needs the previous stage's OUTPUT, call
`upload_image (action:"stage")` with the output's `{ filename, subfolder?, type? }` and
drop the returned input filename into the loader's image/video/audio widget. For a file
already on disk, use `upload_image (action:"image")` / `(action:"video")` /
`(action:"audio")` instead.

NEVER copy the output file into, or guess, a filesystem `input/` path: ComfyUI's input
AND output directories may be CUSTOM (launched with `--input-directory` /
`--output-directory`), so a guessed path makes `LoadImage` reject the file ("Invalid
image file") and wastes the render. `upload_image (action:"stage")` goes through the
server API (`/view` then `/upload/image`), which resolves the real directories
correctly every time.

**Verify a video render via the filesystem, not /history.** `VHS_VideoCombine` and
similar video nodes write the `.mp4` but frequently do NOT register an output in
ComfyUI's `/history` — the prompt shows done with no output and no error. So do NOT
conclude a clip "silently dropped" from `get_history` or `queue (action:"status")`.
Confirm it with `get_image (action:"list_outputs")`, which lists videos each tagged
`kind:"video"`, by filename/prefix plus a fresh mtime — then chain it forward with
`upload_image (action:"stage")`.

**Bypass completed stages before queuing the next one.** Once a stage has RUN and you
have captured/staged its output, BYPASS that stage's nodes with
`panel_set_node_mode(mode:"bypass")` BEFORE you queue the next stage — so `panel_run`
does not re-execute (and make the user pay for and wait on) work that is already done.
Re-running the whole graph because an earlier stage was left active is a real, costly
failure mode: explicitly bypass each finished stage and keep only the ACTIVE stage live.

## Connecting MCP servers

You can extend your own capabilities by connecting MCP servers: `panel_list_mcp` shows
what is connected, `panel_add_mcp` writes a new server to the user's Claude config, and
`panel_remove_mcp` removes one — then call `panel_reload` to load the change into this
session (it restarts you and resumes automatically).

For example, if a task needs CivitAI model search and it is not connected, offer to add
the official CivitAI MCP (transport `http`, url `https://mcp.civitai.com/mcp`), then
reload. ALWAYS ask the user before connecting a remote MCP — it is an external service
connection.

After panel frontend or comfyui-tool code changes you can also call `panel_reload` to
pick them up without a ComfyUI restart. But changes to the orchestrator process itself
— the `panel_*` tools and the services they use — only take effect when the user
restarts that process, so never claim such a change is live after a `panel_reload`.

## Sources

- **Official:** the panel and comfyui MCP tool descriptions in comfyui-mcp (this repo) — each tool named above is the authority on its own parameters.
- **Empirical:** the panel agent system preamble these procedures were moved out of, plus the failure modes they were written for (issues #1398, #1551, #1708, #2234).
