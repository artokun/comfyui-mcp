---
name: workflow-layout
description: Lay out and organize a ComfyUI workflow cleanly on the live panel canvas — dependency-layered node placement with no overlaps, subgraphs, colored group boxes, and subgraph rail alignment. Use when asked to tidy / clean up / organize / arrange a workflow, add groups or subgraphs, fix overlapping nodes, or build a workflow that should look good from the start.
---

# ComfyUI Workflow Layout & Organization

Turn a tangled graph into a clean **left-to-right dataflow** a human reads at a glance,
using the `panel_*` canvas tools. The golden rule: **never lay out blind** — read the
real node sizes and rail positions first, then compute positions from them.

## Primitives (panel tools)

- **`panel_query_graph {fields:'detail', limit:200, max_chars:60000}`** — READ FIRST, every time. Returns, for the graph you're viewing:
  - each node's **`pos` [x,y]**, **`size` [w,h]** (body only), and **`full_height`** (the
    TRUE rendered footprint = title bar + body; use this for vertical stacking),
  - all **`groups`** (`id`, `title`, `color`, `bounding [x,y,w,h]`),
  - and — only when inside a subgraph — the **`rails`**: the `input` / `output` boundary
    node positions. Everything below is computed from these numbers.
- `panel_move_node(node_id, [x,y])`, `panel_set_node_title(node_id, title)`,
  `panel_set_node_collapsed(node_id, collapsed)` (minimize to title bar),
  `panel_set_node_color(node_id, {preset|color|bgcolor})` (color-code stages —
  presets: red/brown/green/blue/pale_blue/cyan/purple/yellow/black)
- **Groups** (colored boxes; nodes stay put): `panel_create_group` (pass `node_ids` to
  auto-wrap, or `bounds [x,y,w,h]`; `color` hex), `panel_move_group`, `panel_edit_group`,
  `panel_remove_group`.
- **Subgraphs** (nest nodes into one collapsible node): `panel_create_subgraph(node_ids)`,
  `panel_enter_subgraph` / `panel_exit_subgraph`, `panel_get_subgraph`,
  `panel_promote_widget`, **`panel_move_rail(rail, [x,y])`** (`rail` = `"input"|"output"`,
  must be inside the subgraph), **`panel_expose_subgraph_output(from_node_id, from_output)`** /
  **`panel_expose_subgraph_input(to_node_id, to_input)`** (expose an interior slot on the
  boundary rail — must be inside the subgraph), and **`panel_unpack_subgraph(node_id)`**
  (expand/dissolve a subgraph back into the parent — the inverse of `panel_create_subgraph`).
- `panel_canvas({action:"fit"})` to frame the result; `panel_save_workflow` to persist.

## The layout algorithm (dependency-layered, overlap-free)

1. **Read** the graph. Build a DAG from each input's `connected_from` (ignore unconnected
   widget inputs — only node→node edges matter).
2. **Layer** every node by longest path from a source:
   `layer(n) = 0` if it has no incoming node edges, else `1 + max(layer(of its sources))`.
   Layers become columns, left → right.
3. **X by layer:** `x = X0 + layer * COL_PITCH`, where `COL_PITCH ≈ widest node.size[0] in
   that column + ~80`.
4. **Y by FULL height (this is what stops overlaps):** stack a column top→down with
   `y[i+1] = y[i] + node[i].full_height + ROW_GAP`. Use **`full_height`** (from
   `panel_query_graph` detail rows), NOT `size[1]`. `size[1]` is the BODY only (slots + widgets); the
   **title bar renders ~30px ABOVE `pos`** and is NOT in `size[1]`, so stacking by `size[1]`
   overlaps every node by a header (the classic "headers eating the node above" bug).
   `full_height` already includes that header (and is just the title height for a collapsed
   node), so `y += full_height + ROW_GAP` lands an exact `ROW_GAP` gap between the previous
   node's bottom and the next node's title. **Never** use a fixed row pitch — tall nodes
   (KSampler, WanVideo Sampler, LoRA-select) are 480–600px and *will* overlap a 320 pitch.
   (If `full_height` is ever absent, fall back to `size[1] + ~30` for the header.)
5. **Order within a column** to cut wire crossings: place each node near the average Y of its
   connected nodes (a median/barycenter pass is plenty).

Reads-well constants: `COL_PITCH` 360–480, `ROW_GAP` 40. Because `full_height` already
accounts for the title bar, you don't add extra top headroom per node — `ROW_GAP` is the
clean gap you'll actually see.

## Subgraph interiors — move the rails!

A subgraph has two boundary **rails** (input left, output right). They **do not** follow the
inner nodes — move the nodes without moving the rails and you get a huge gap (a very common
mistake). For each subgraph: `panel_enter_subgraph` → lay out the inner nodes (algorithm
above) → then pin the rails to the node band:

- input rail → `panel_move_rail("input",  [minNodeX - 180, bandTopY])`
- output rail → `panel_move_rail("output", [maxNodeX + 60,  bandTopY])`

Keep rails at the same Y as the first row. Read current rail positions from
`panel_query_graph` (`rails`) before deciding. `panel_exit_subgraph` when done.

**Wiring interior nodes to the boundary (don't connect to a guessed rail id).** To expose
an interior node's output/input on the boundary so the PARENT graph can wire it, do NOT
`panel_connect` to a rail node id you guessed — use `panel_expose_subgraph_output(from_node_id,
from_output)` (interior output → output rail) and `panel_expose_subgraph_input(to_node_id,
to_input)` (interior input → input rail), both while inside the subgraph. `panel_query_graph`'s
`rails` shows which boundary slots already exist and which still need exposing. To expand/
dissolve a subgraph back into the parent (inline its inner nodes + rewire external links,
removing the wrapper — the inverse of `panel_create_subgraph`), use
`panel_unpack_subgraph(node_id)`. All undoable with Ctrl+Z.

## Groups vs subgraphs — choose deliberately

- **Group** (colored box): lightweight visual band; nodes stay in place and editable. Reach
  for this **first** — to label regions of a flat graph or band stage-columns at the root.
- **Subgraph**: collapses a stage into one node. Powerful for large graphs, but it nests/hides
  nodes and adds boundary ports. **Don't subgraph everything** — a 2–3 node stage rarely earns
  it, and over-subgraphing hurts readability and complicates packaging/handoff.
- Clean recipe: lay the flat graph out well → wrap only the genuinely complex stages in
  subgraphs → drop colored group bands around the columns at the root.

## Stage decomposition that fits most pipelines

`Loaders → Inputs → Preprocess (pose/controlnet/conditioning) → Embeds → Sample →
Decode/Output` — one concern per column/stage, strictly left-to-right.

## Always leave inputs & outputs exposed

The nodes a user touches first — the **input** (Load Image / Load Video) and the
**output** (save / video-combine / preview) — must stay **expanded and visible** so they
can jump straight in: drop in their media, hit run, watch the result. Collapse the
internal machinery (loaders, encoders, samplers) into chips to cut noise, but **never**
collapse the inputs or outputs. When they live inside subgraphs, keep those subgraph
nodes expanded — and consider `panel_promote_widget` to surface the one key widget
(prompt, seed) onto the subgraph node so it's editable without drilling in.

> Heads-up: input/output preview nodes (`LoadImage`, `VHS_LoadVideo`, video-combine)
> report their full `size[1]` but render short until media loads — size their group band
> to the `.size` (so it fits once filled), not to the empty-preview render.

## End-to-end workflow

1. `panel_query_graph {fields:'detail', limit:200, max_chars:60000}` — capture `pos`/`size`/`groups` (and `rails` inside each subgraph).
2. Compute layers + overlap-free positions from the real sizes.
3. `panel_move_node` for each (batch the moves — they apply in order).
4. Per subgraph: enter → lay out inner nodes → `panel_move_rail` both rails → exit.
5. Optional: `panel_create_group` bands around the root columns (and `panel_remove_group`
   any stranded empty groups left behind by earlier edits).
6. `panel_save_workflow`, then `panel_canvas({action:"fit"})`.

## Gotchas

- **Save before relying on it:** node positions/titles and groups persist only once saved; a
  browser refresh reloads from the saved workflow (and re-binds nodes after installing packs).
- Converting nodes to a subgraph **preserves inner node ids**; the subgraph node gets a new id.
- Moving nodes inside a subgraph leaves the **rails behind** — always re-pin them (see above).
- Canvas edits never affect an in-flight render; but a ComfyUI **restart clears the queue**.
- **Image/video nodes under-report height:** `LoadImage`, `VHS_LoadVideo`, preview nodes
  return a tiny `size[1]` because the image/video preview height isn't in `.size`. Leave
  extra vertical room (≈250–300px) below them so the preview doesn't overlap the next node.
- Color-code by stage (e.g. all loaders `blue`, sampler `green`) and `collapsed` rarely-touched
  loaders to cut visual noise — cheap wins once the positions are right.
- Don't over-tidy a graph that's mid-build for the user — confirm if a big reorg is wanted.
