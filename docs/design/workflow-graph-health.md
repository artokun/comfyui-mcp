# Graph-health heuristics in workflow analysis

**Status:** implemented (this PR) · **Implementation branch:** `spec/workflow-graph-health`

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) `workflow_overview` (`web/js/query_executor.js`) reports node-type histograms, disconnected nodes, and missing required inputs — but client-side with slot-name heuristics, because the live canvas lacks schema data. We run server-side with real `/object_info` required/optional data, keeping their heuristics only as a fallback for uninstalled node types.

## Motivation

`validate_workflow` (`src/tools/workflow-validate.ts` → `src/services/workflow-validator.ts`) catches hard errors: unknown node types, missing required inputs, broken/self-referencing links, invalid output indices, out-of-list combo values. `analyze_workflow` (`src/tools/workflow-library.ts:409-509`) explains *structure*. Neither answers "is this graph *healthy*": dead subgraphs, duplicate model loads wasting VRAM, sampler branches whose outputs never reach a save node, or muted/bypassed nodes silently dropping connections.

## Placement: `validate_workflow` (primary), `analyze_workflow view:"health"` (secondary)

- `validate_workflow` takes raw workflow JSON — the shape agents hold while authoring; health findings are a validation concern (severity-tagged issues) and compose with `ValidationResult.issues`.
- `analyze_workflow` takes a library filename; extending its `view` enum with `"health"` reuses `loadWorkflowApi()` (which already converts UI→API via `convertUiToApi`) for near-zero extra code.

## Tool API

`validate_workflow` — unchanged params plus:

```ts
health: z.boolean().optional().default(true)
  .describe("Include graph-health heuristics (disconnected nodes, duplicate model loads, orphaned branches, muted/bypassed nodes) as info/warning issues plus a structured health section.")
```

`analyze_workflow` — `view` enum gains `"health"`.

## New service: `src/services/workflow-health.ts`

```ts
export interface HealthFinding {
  kind: "disconnected" | "missing_required_input" | "duplicate_model_load"
      | "orphaned_branch" | "muted_or_bypassed" | "no_output_reachable";
  severity: "warning" | "info";
  node_ids: string[];
  node_type?: string;
  detail: string;        // e.g. `CheckpointLoaderSimple loads "sd_xl_base.safetensors" in nodes 4 and 17`
  heuristic?: boolean;   // true when object_info lacked the node and slot-name heuristics were used
}

export interface GraphHealth {
  total_nodes: number;
  node_type_histogram: Record<string, number>;
  findings: HealthFinding[];
  summary: string;
}

export function analyzeGraphHealth(workflow: WorkflowJSON, objectInfo: ObjectInfo): GraphHealth
```

Pure and synchronous — the caller (validator or analyze handler) already holds `objectInfo`; no extra fetch, trivially unit-testable.

### Checks (API-format `WorkflowJSON`)

1. **Disconnected nodes** (warning): build in/out adjacency from `[nodeId, outIdx]` input tuples; a node with no inbound links, no consumers, and not an `output_node` per object_info is isolated.
2. **Missing required inputs** (warning): primary source `objectInfo[class_type].input.required`. **Fallback heuristic only** when the class is absent from object_info (uninstalled custom node): FL-MCP's `isInputSlotRequired` rules — known-optional slot-name list; Loader/Load families require `*name*/*path*/*ckpt*`; Sampler families require `model/positive/negative/latent_image`; VAE families require `samples/images/vae`; default required. Tagged `heuristic: true`.
3. **Duplicate model loads** (warning): group nodes by `(class_type, model-file widget value)` where class_type matches `/Loader|Load/` and the value matches the model-file regex already in `workflow-validator.ts:213` (`/\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i`). ≥2 nodes on the same file → one finding listing all node ids.
4. **Orphaned branches / no output reachable** (warning): reverse-BFS from every output node (`objectInfo[ct].output_node === true` plus the hardcoded SaveImage/PreviewImage/SaveAnimated* list at `workflow-validator.ts:137-146`). Unreached non-output nodes are "computed but never saved" — reported as **one finding per connected component** (avoids 40 line items on big graphs). The existing zero-output validator check stays as-is.
5. **Muted/bypassed** (info): via `_meta.mode` where present. Known limitation, documented: `convertUiToApi` *drops* mode-2/4 nodes (comment at `workflow-converter.ts:731`; the `_meta.mode: "muted"|"bypassed"` mapping lives at `932-942`), so for `analyze_workflow` we surface the converter's existing warnings instead; raw API JSON handed to `validate_workflow` is checked directly, and silently skipped when `_meta` is absent.

## Output composition

`validate_workflow` text output gains, after Errors/Warnings:

```
### Graph health
- 24 nodes, 14 types (top: KSampler x2, LoadImage x3, ...)
- [warning] Duplicate model load: CheckpointLoaderSimple "sd_xl_base.safetensors" in nodes 4, 17 — merge into one loader to save VRAM
- [warning] Orphaned branch: nodes 22, 23, 24 (UpscaleModelLoader → ImageUpscaleWithModel) never reach a save/preview node
- [info] Node 9 (KSampler) is bypassed (_meta.mode)
```

Programmatically: findings are appended into `result.issues` (severity `warning`/`info`) so existing consumers see them; `ValidationIssue.severity` widens to `"error" | "warning" | "info"` and gains optional `kind?: string`; `ValidationResult` gains `health: GraphHealth`. **`valid` remains errors-only — health never flips validity.**

## Implementation plan

1. `src/services/workflow-health.ts` — `analyzeGraphHealth` (~180 lines, pure). Types imported from `src/comfyui/types.ts`.
2. `src/services/workflow-validator.ts` — widen `ValidationIssue.severity`; call `analyzeGraphHealth` after existing step 4 (objectInfo already in hand); merge findings; return `health`.
3. `src/tools/workflow-validate.ts` — `health` param; render the section incl. the `info` bucket.
4. `src/tools/workflow-library.ts` — add `"health"` to `analyze_workflow`'s `view` enum; handler calls `analyzeGraphHealth(workflow, objectInfo)` (both in scope at lines 443-444) and renders.

## Test plan (vitest)

New `src/__tests__/services/workflow-health.test.ts` — pure-function tests with a small mocked `ObjectInfo` (pattern: `workflow-converter.test.ts`): isolated node; duplicate checkpoint; orphaned upscale branch; heuristic fallback for an unknown Sampler-family class missing `model`; `_meta.mode` info; per-component grouping. Plus one validator test asserting health findings merge without affecting `valid`.

## Rollout / compat

Non-breaking: default `health: true` adds text but never errors (flip the default to `false` later if token cost matters in compact mode). No config. Regenerate tool docs via `npm run docs:gen`.
