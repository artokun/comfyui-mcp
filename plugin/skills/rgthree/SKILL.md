---
name: rgthree
description: Configure and author rgthree-comfy nodes — Fast Groups Bypasser/Muter (group toggles), Power Lora Loader, Context/Context Big, Seed, Any Switch. Use when a workflow contains rgthree nodes, when asked to add stage/section toggles or an A/B switch, when stacking LoRAs, or when an rgthree node needs configuring. Covers the frontend-only nodes that are absent from /object_info and the properties-not-widgets configuration model.
---

# rgthree-comfy

`rgthree-comfy` is one of the most widely installed packs, so its nodes turn up in a
large share of community workflows. Three of its properties make it a recurring
agent-failure mode — all three fail *quietly enough* to look like success.

## The three things that catch agents out

**1. Some rgthree nodes are FRONTEND-ONLY.** They are registered by the pack's JS
(`registerCustomNodes()`), have no Python class, and are therefore **absent from
`/object_info` by design**. Checking `/object_info` and concluding "this node doesn't
exist" is wrong. `/object_info` lists 24 rgthree *backend* types; the toggles are not
among them.

**2. They are configured through PROPERTIES, not widgets.** `matchTitle`,
`toggleRestriction` and `sort` live in `node.properties` (right-click → Properties),
not in `widgets`. Use **`panel_set_property`**. `panel_set_widget` does not silently
half-work — it **refuses**, with `has no widget "matchTitle" (available: …)` listing
the widgets that do exist. That refusal is the fastest confirmation you are on the
properties path; read it rather than retrying the write.

**3. Fast Groups nodes take NO wiring and enumerate GROUPS by title.** Leave the
`OPT_CONNECTION` output unconnected. The node renders one toggle per matching group,
so **the groups must exist and be named before the node is useful**.

## Which rgthree nodes `panel_add_node` will actually add

The panel authorizes every add against fresh `/object_info` and **fails closed** on a
type it cannot find. Genuinely frontend-only types are exempt only via an explicit
allowlist (`FRONTEND_ONLY_NODE_TYPES`), so the exemption covers **seven** rgthree
types and no others:

| Frontend-only, `panel_add_node` WORKS | Frontend-only, `panel_add_node` REFUSES |
|---|---|
| `Fast Groups Bypasser (rgthree)` | `Bookmark (rgthree)` |
| `Fast Groups Muter (rgthree)` | `Mute / Bypass Relay (rgthree)` |
| `Fast Bypasser (rgthree)` | `Mute / Bypass Repeater (rgthree)` |
| `Fast Muter (rgthree)` | `Fast Actions Button (rgthree)` |
| `Node Collector (rgthree)` | `Random Unmuter (rgthree)` |
| `Label (rgthree)` | |
| `Reroute (rgthree)` | |

A refusal in the right-hand column is the guard working as designed, **not** a broken
pack and not something to work around — the node has no backend def and is not on the
allowlist. Say so and pick a different approach (the Bypasser/Muter cover almost every
real toggle need). Everything with a Python class — Power Lora Loader, Context*, Seed,
Any Switch, Power Prompt, Image Comparer — is a normal backend node and adds normally.

## Fast Groups Bypasser / Muter

`Fast Groups Bypasser (rgthree)` sets the nodes of a group to **bypass** (mode `4` —
the node is skipped and its input passes through). `Fast Groups Muter (rgthree)` sets
them to **mute** (mode `2` — the node does not execute and everything downstream
dies). **Prefer the Bypasser** for toggling an optional stage inside a chain; reach
for the Muter only when you genuinely want to stop a branch.

All of the following are node properties — set them with `panel_set_property`:

| Property | Values | Default | Notes |
|---|---|---|---|
| `matchTitle` | regex, case-insensitive | `""` | **Set this.** Empty means every group in the workflow becomes a toggle. It is a real regex matched *unanchored* against the group title, so anchor it (`^STAGE`) or it matches mid-title. |
| `matchColors` | comma-separated colors | `""` | Alternative filter; pairs with a color convention. |
| `toggleRestriction` | `default` / `max one` / `always one` | `default` | Both non-default values enforce mutual exclusion (they are matched on the substring `" one"`). Do NOT set either if the user may ever want all stages on in one queue. |
| `sort` | `position` / `alphanumeric` / `custom alphabet` | `position` | The default means **moving a group on the canvas silently reorders the toggles**. `alphanumeric` is stable — prefer it. |
| `customSortAlphabet` | string | `""` | Only read when `sort` is `custom alphabet`. |
| `showNav` | bool | `true` | Per-row jump-to-group arrow. |
| `showAllGraphs` | bool | `true` | Include groups that live inside subgraphs. |

### Recipe — make pipeline stages toggleable

1. `panel_create_group` per stage, with a **prefixed title** (`STAGE 1 — …`) so one
   anchored regex selects exactly the intended set.

2. **Verify group membership before you trust it.** Group membership is purely
   **geometric**: LiteGraph counts a node as a member when its *centre* falls inside
   the box, and the auto-fit box around your `node_ids` will happily swallow unrelated
   neighbours. When the live members differ from what you asked for, the result
   carries `extra_node_ids`, `missing_node_ids` and a `warning` alongside
   `requested_node_ids` — **read them**. (They appear only when you passed `node_ids`
   *and* something differs, so their absence is a real all-clear.)

   A stray node here is not cosmetic: toggling one stage will disable part of another.
   To fix it, **move the nodes apart** (`panel_edit_node`, or `panel_auto_layout`) so
   the regions are contiguous, or set an explicit `bounds` with `panel_edit_group` —
   then re-check. `panel_move_group` does **not** help: by default it drags the
   contained nodes along with the box, so the same nodes stay inside it.

3. `panel_add_node(class_type="Fast Groups Bypasser (rgthree)")`. Leave its output
   unwired. Add nodes one at a time, not as a parallel batch.

4. `panel_set_property` → `matchTitle` = `^STAGE`, and `sort` = `alphanumeric`.

5. Toggle, then verify with `panel_graph_outline` — it tags nodes `[bypass]` / `[mute]`.

## Power Lora Loader (rgthree)

A **backend** node (present in `/object_info`) that stacks N LoRAs in one node. Each row
is a widget named **`lora_1`, `lora_2`, …** whose value is a composite object
`{on: bool, lora: "subdir\\name.safetensors", strength: float, strengthTwo: float|null}`
(`strengthTwo` is the separate CLIP strength, `null` in the simple view). Rows are
identified by the **presence of a `lora` key**, and the node's control widgets are
appended *after* them, so do not index positionally — **address the row by name**.

Write ONE field at a time with **dotted sub-field addressing**, which merges onto the
current object and preserves every other field:

```
panel_set_widget(node_id=<id>, widget="lora_1.strength", value=0.8)
panel_set_widget(node_id=<id>, widget="lora_2.on",       value=false)
panel_set_widget(node_id=<id>, widget="lora_1.lora",     value="style/foo.safetensors")
```

Writing a **bare scalar to `lora_1` itself** is the trap: it sets one field and nulls
the rest, corrupting the row. Pass a sub-field, or a full JSON object for the whole row.
The fields are schema-checked — `on` is a non-nullable boolean, `strength` a non-nullable
number, `lora` a nullable string (`null` clears the slot), `strengthTwo` a nullable
number — and an unknown field name (a typo like `lora_1.strenght`) is **refused**, not
silently created. Nested paths are not supported. Turning a LoRA **off**
(`lora_N.on = false`) is usually safer than removing the row.

## Other commonly-seen rgthree nodes

- **Context / Context Big / Context Switch / Context Merge** — bundle
  MODEL/CLIP/VAE/conditioning into one `RGTHREE_CONTEXT` wire. **These are NOT virtual
  wiring.** Unlike Get/Set buses they are real executable backend nodes, so
  `panel_strip_workflow` and `panel_flatten_workflow` deliberately **keep** them — they
  run. Do not expect either tool to dissolve a Context chain. There is no hidden edge to
  resolve: every link is a real link, traceable with `panel_query_graph`. What a Context
  hides is *which field* a downstream node pulls out of the bundle, so read the chain
  node by node. (`panel_slice_workflow` still carves one pipeline out of a toggled
  monolith, and `panel_strip_workflow` still resolves any genuine Get/Set buses and
  Reroutes around it.)
- **Seed (rgthree)** — it **deletes the built-in `control_after_generate` widget** on
  creation, so do not try to write it; the widget is not there. Control is by SPECIAL
  SEED VALUES written to the `seed` widget instead: **`-1` randomize, `-2` increment,
  `-3` decrement**. Any concrete seed is returned **unchanged** — `42` stays `42` every
  run — so to pin a run, write the number; to re-randomize, write `-1`. The frontend
  resolves a special value into a real seed *before* queueing and shows the result in a
  read-only `last_seed` widget, so a `seed` re-read after a run may not be the special
  value the user set (a fixed seed, however, is stable).
- **Any Switch (rgthree)** — the first non-null input wins; a common A/B toggle paired
  with bypassed branches. An **empty Context counts as null**, so an unfilled Context
  branch is skipped rather than selected.

## Gotchas

- A **bypassed** node is skipped and passes its input through; a **muted** node kills
  everything downstream. Choosing the Muter where the Bypasser was meant breaks the
  chain rather than shortening it.
- Always `panel_graph_outline` before a run — a stale toggle is a top cause of a wrong
  render, and the outline marks `[bypass]` / `[mute]` explicitly.
- rgthree's `Bookmark` nodes respond to keypresses and are inert to agents.
