# `panel_connect` auto_match + slot-diagnostic errors; `dsl_to_workflow` wiring warnings

**Status:** implemented (this PR) · **Implementation branch:** `spec/panel-connect-auto-match` · **Pairs with:** comfyui-mcp-panel [PR #76](https://github.com/artokun/comfyui-mcp-panel/pull/76) (`docs/design/connect-auto-match.md` — the resolver + diagnostics)

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) `fl_api.js` connect resolver. Matching rules, ambiguity guard, and diagnostic format are specified in the paired panel RFC; this doc covers the orchestrator tool surface and an optional server-side sibling: advisory wiring warnings in `dsl_to_workflow`.

## Part 1: `panel_connect` schema update (backward compatible)

`src/orchestrator/panel-tools.ts` (~line 584) — params stay identical except:

- `from_output` / `to_input` `.describe()` updated: "…omit to auto-match by type (prefers an unconnected, exact-type input; `*` wildcards match last)".
- New optional param:

  ```ts
  auto_match: z.boolean().optional()
    .describe("Default true. Set false to force legacy exact resolution (omitted slot = index 0).")
  ```

  forwarded in the `ctx.call({ cmd: "graph_connect", ... })` frame.
- Tool description gains: "If both slot args are omitted the panel picks the first type-compatible pairing. On failure the error lists every slot with its type and [connected] flag."

No result-shape change agent-side (the panel's result JSON — now possibly carrying `auto_matched` / `replaced_link` — passes through as text). `docs/panel.mdx` row updated.

## Part 2 (optional commit): advisory wiring warnings in `dsl_to_workflow`

`dslToWorkflow` (`src/services/workflow-dsl.ts:59`) is a pure parser and stays pure. Instead, in the tool handler (`src/tools/workflow-dsl.ts:25`), after parsing and only when ComfyUI is reachable:

- Fetch `getObjectInfo()` (already imported by panel-tools; from `../comfyui/client.js`).
- For every `[srcId, idx]` connection, compare `object_info[srcClass].output[idx]` against the declared input type; append a `warnings: []` array to the tool result:
  - `unknown class_type "X"`,
  - `output index 2 out of range for CheckpointLoaderSimple (3 outputs: MODEL, CLIP, VAE)`,
  - `type mismatch: 4.1 (CLIP) → 3.model (MODEL)`.
- **Never fail the conversion** — offline ComfyUI ⇒ no warnings, identical output otherwise.

### Shared rule set: `src/services/slot-compat.ts`

~40 lines implementing the same compatibility rules as the panel (exact match; `*` wildcard compatible-but-lowest-rank; COMBO array types identical-only; comma multi-types match any segment), so server warnings and panel behavior state one rule set. The panel keeps its own JS copy (the live-served bundle can't import TS) — both sides carry a cross-referencing comment.

## Gating

`panel_connect` is a panel-write; DSL warnings are read-only advisory output — ungated. There is no runtime gating change in this PR: the safety-gates taxonomy (spec PR #172) was closed, and gate enforcement is deferred to ROADMAP Theme G.

## Test plan

- Vitest for `slot-compat.ts`: wildcard, COMBO arrays, comma lists, rank ordering.
- Vitest for DSL warnings against a canned `object_info` fixture (no live ComfyUI): mismatch, out-of-range, unknown class, offline ⇒ no warnings.
- Panel behavior (auto-match, ambiguity guard, diagnostics) is covered by the paired repo's Playwright suite.

## Rollout / compat

- **Panel PR ships first.** Old panel + new orchestrator: the unknown `auto_match` key is ignored by the old executor → exact legacy behavior, no error.
- Changelog callout (both repos): with a new panel, an omitted slot auto-matches by type instead of meaning index 0; `auto_match:false` restores legacy semantics.
- DSL `warnings` is an additive field on an experimental tool — no compat risk.
