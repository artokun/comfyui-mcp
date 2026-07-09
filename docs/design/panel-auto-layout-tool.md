# `panel_auto_layout` — one-shot canvas auto-arrange

**Status:** implemented (this PR) · **Implementation branch:** `spec/panel-auto-layout` · **Pairs with:** comfyui-mcp-panel [PR #75](https://github.com/artokun/comfyui-mcp-panel/pull/75) (`docs/design/auto-layout-engine.md` — the engine + `graph_auto_layout` bridge command)

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) `modify_layout`. The engine, algorithm, and improvements over FL-MCP (groups, reroutes, barycenter, overlap resolution) are specified in the paired panel RFC; this doc covers only the orchestrator tool surface.

## Motivation

Agents fix layouts today with dozens of `panel_move_node` round-trips. The panel gains a `graph_auto_layout` bridge command (see paired RFC); this tool exposes it to the agent.

## Tool API

Added to `buildPanelToolDefs()` in `src/orchestrator/panel-tools.ts`, right after `panel_move_node` (~line 631) — both transports (Claude in-process SDK server + Codex HTTP MCP) pick it up automatically:

```ts
def(
  "panel_auto_layout",
  "Automatically arrange the user's open graph (or a subset of nodes) into a clean left-to-right / top-to-bottom / grid layout based on the real link topology. Group boxes move with their members and are re-fit. Use dry_run:true to preview proposed positions without touching the canvas. Undoable (one Ctrl+Z).",
  {
    node_ids: z.array(z.number().int()).optional()
      .describe("Node ids to arrange (default: every node in the active graph)."),
    mode: z.enum(["flow_horizontal", "flow_vertical", "grid"]).optional()
      .describe("Layout strategy (default flow_horizontal — left-to-right by dependency depth)."),
    spacing: z.number().min(0.25).max(4).optional()
      .describe("Gap multiplier (1 = compact default, 1.5 = 50% roomier)."),
    groups: z.enum(["preserve", "cluster", "ignore"]).optional(),
    dry_run: z.boolean().optional()
      .describe("Compute and return proposed positions without moving anything."),
  },
  async (args, ctx) =>
    ctx.call({ cmd: "graph_auto_layout", node_ids: args.node_ids, mode: args.mode,
               spacing: args.spacing, groups: args.groups, dry_run: args.dry_run }, 15000),
),
```

The bridge command additionally accepts `align`/`anchor`; those stay panel-side defaults for now (not exposed to the agent until needed — the frame contract already carries them for a later tool rev or panel UI use).

Result/error shapes are defined by the paired RFC (`{applied, columns, moved[], groups[], skipped[]}`; agent-readable error strings). The result JSON is passed through as text like every other `panel_*` tool.

## Gating

Ships ungated, exactly like the other mutating panel tools today (`panel_move_node`, `panel_add_node`, …). Safety gates were deferred: the `panel-writes` gate / spec PR #172 was closed and the work moved to [ROADMAP.md](../../ROADMAP.md) Theme G — when gates land they'll cover `panel_auto_layout` alongside the rest of the mutating panel surface.

## Implementation plan

1. `src/orchestrator/panel-tools.ts` — the def above (15 s timeout: layout is O(n) but big graphs + redraw need headroom).
2. `docs/panel.mdx` — add the tool row (the only doc enumerating `panel_*` tools).
3. No `ui-bridge.ts` changes — the bridge is command-agnostic (`ctx.call` forwards any `{cmd, ...}` frame with rid correlation).

## Test plan

No runtime logic beyond the def: extend the existing panel-tools def-shape coverage (or snapshot `buildPanelToolDefs().map(d => d.name)`). Behavior is covered by the paired repo's unit + Playwright suites.

## Rollout / compat

**Panel PR ships first.** New orchestrator + old panel: the tool errors with `Unknown command "graph_auto_layout"` — agent-readable; the description must not promise availability. Changelog note in both repos.
