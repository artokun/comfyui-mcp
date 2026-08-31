import type { WorkflowJSON, ObjectInfo } from "../comfyui/types.js";

/**
 * Graph-health heuristics for ComfyUI workflows.
 *
 * Where the hard validator (`workflow-validator.ts`) answers "will this graph
 * run?", this service answers "is this graph *healthy*?" — dead subgraphs,
 * duplicate model loads wasting VRAM, sampler branches whose outputs never reach
 * a save node, muted/bypassed nodes silently dropping connections, and samplers set
 * to a partial denoise over an empty latent (a graph that runs clean and returns a
 * flat field).
 *
 * Prior art: filliptm/ComfyUI_FL-MCP `workflow_overview` reports node-type
 * histograms, disconnected nodes, and missing required inputs — but client-side
 * with slot-name heuristics because the live canvas lacks schema data. We run
 * server-side against real `/object_info` required/optional data and keep the
 * slot-name heuristics ONLY as a fallback for uninstalled node types.
 *
 * Pure and synchronous — the caller (validator or analyze handler) already holds
 * `objectInfo`, so there is no extra fetch and the function is trivially testable.
 */

export interface HealthFinding {
  kind:
    | "disconnected"
    | "missing_required_input"
    | "duplicate_model_load"
    | "orphaned_branch"
    | "muted_or_bypassed"
    | "no_output_reachable"
    | "partial_denoise_empty_latent";
  severity: "warning" | "info";
  node_ids: string[];
  node_type?: string;
  /** e.g. `CheckpointLoaderSimple loads "sd_xl_base.safetensors" in nodes 4 and 17` */
  detail: string;
  /** true when object_info lacked the node and slot-name heuristics were used */
  heuristic?: boolean;
}

export interface GraphHealth {
  total_nodes: number;
  node_type_histogram: Record<string, number>;
  findings: HealthFinding[];
  summary: string;
}

// Model-file extensions — kept in sync with workflow-validator.ts's isModel test.
const MODEL_FILE_RE = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i;

// A latent produced from nothing — EmptyLatentImage, EmptySD3LatentImage,
// EmptyHunyuanLatentVideo, EmptyLTXVLatentVideo, EmptyLatentAudio, and the
// custom EmptyLatentImagePresets family. Every one of these emits ZEROS.
const EMPTY_LATENT_RE = /^Empty[A-Za-z0-9_]*Latent/i;

// ComfyUI's OWN full-denoise threshold. comfy/samplers.py KSampler.set_steps:
//   if denoise is None or denoise > 0.9999: <full schedule>
//   else: sigmas = calculate_sigmas(int(steps/denoise))[-(steps + 1):]
// At or below this the sigma schedule is TRUNCATED, so sigmas[0] < sigma_max and
// the latent_image term stops being multiplied by zero. Matching the threshold
// exactly means this finding fires on precisely the branch that changes behaviour.
const FULL_DENOISE_THRESHOLD = 0.9999;

// Hardcoded output classes, mirroring workflow-validator.ts step 4.
const OUTPUT_CLASSES = new Set([
  "SaveImage",
  "PreviewImage",
  "SaveAnimatedWEBP",
  "SaveAnimatedPNG",
]);

/**
 * FL-MCP-style slot-name required heuristic, used ONLY for node classes absent
 * from object_info (uninstalled custom nodes). Returns the set of input-slot
 * names we *expect* a node of this class-name family to require, so a missing
 * key can be flagged. Returns null for families we can't reason about (a generic
 * unknown node), where guessing would only produce false positives.
 */
function heuristicRequiredSlots(classType: string): string[] | null {
  if (/Sampler/i.test(classType)) {
    return ["model", "positive", "negative", "latent_image"];
  }
  if (/VAE/i.test(classType)) {
    // Decode wants samples+vae; encode wants pixels/images+vae. `vae` is the
    // one slot common to the whole family, so that's all we assert.
    return ["vae"];
  }
  // Loader / Load families are model-file consumers whose required input is a
  // widget (a *name*/*path*/*ckpt* value), not a link — handled separately below.
  return null;
}

/** Is a value an API-format connection tuple `[nodeId, outputIndex]`? */
function isConnection(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}

function isOutputNode(classType: string, objectInfo: ObjectInfo): boolean {
  return OUTPUT_CLASSES.has(classType) || objectInfo[classType]?.output_node === true;
}

/**
 * Analyze a workflow's structural health. Pure — no I/O, no fetch.
 *
 * @param workflow   API-format workflow JSON.
 * @param objectInfo Node catalog from `/object_info` (authoritative required/optional).
 */
export function analyzeGraphHealth(
  workflow: WorkflowJSON,
  objectInfo: ObjectInfo,
): GraphHealth {
  const nodeIds = Object.keys(workflow);
  const findings: HealthFinding[] = [];

  // --- Node-type histogram -------------------------------------------------
  const histogram: Record<string, number> = {};
  for (const id of nodeIds) {
    const ct = workflow[id].class_type;
    histogram[ct] = (histogram[ct] ?? 0) + 1;
  }

  // --- Adjacency (forward: source -> [targets]) ----------------------------
  const consumers = new Map<string, Set<string>>(); // node -> nodes that read its output
  const sources = new Map<string, Set<string>>(); // node -> nodes it reads from
  for (const id of nodeIds) {
    consumers.set(id, new Set());
    sources.set(id, new Set());
  }
  for (const id of nodeIds) {
    for (const value of Object.values(workflow[id].inputs)) {
      if (isConnection(value)) {
        const [srcId] = value;
        if (workflow[srcId] && srcId !== id) {
          sources.get(id)!.add(srcId);
          consumers.get(srcId)!.add(id);
        }
      }
    }
  }

  // --- 1. Disconnected nodes (warning) -------------------------------------
  // No inbound links, no consumers, and not itself an output node.
  for (const id of nodeIds) {
    const ct = workflow[id].class_type;
    if (
      sources.get(id)!.size === 0 &&
      consumers.get(id)!.size === 0 &&
      !isOutputNode(ct, objectInfo)
    ) {
      findings.push({
        kind: "disconnected",
        severity: "warning",
        node_ids: [id],
        node_type: ct,
        detail: `Node ${id} (${ct}) has no connections — it is isolated and does nothing.`,
      });
    }
  }

  // --- 2. Missing required inputs ------------------------------------------
  for (const id of nodeIds) {
    const node = workflow[id];
    const ct = node.class_type;
    const def = objectInfo[ct];
    if (def) {
      // Authoritative: object_info required list.
      const required = def.input?.required ?? {};
      for (const inputName of Object.keys(required)) {
        if (!(inputName in node.inputs)) {
          findings.push({
            kind: "missing_required_input",
            severity: "warning",
            node_ids: [id],
            node_type: ct,
            detail: `Node ${id} (${ct}) is missing required input "${inputName}".`,
          });
        }
      }
    } else {
      // Fallback heuristic — only for classes absent from object_info.
      const expected = heuristicRequiredSlots(ct);
      if (expected) {
        for (const inputName of expected) {
          if (!(inputName in node.inputs)) {
            findings.push({
              kind: "missing_required_input",
              severity: "warning",
              node_ids: [id],
              node_type: ct,
              detail: `Node ${id} (${ct}) appears to be missing required input "${inputName}" (heuristic — "${ct}" is not installed here).`,
              heuristic: true,
            });
          }
        }
      }
    }
  }

  // --- 3. Duplicate model loads (warning) ----------------------------------
  // Group Loader/Load-family nodes by (class_type, model-file value). NUL can't
  // appear in a class_type or filename, so it is a collision-proof separator.
  const DUP_SEP = String.fromCharCode(0);
  const loadGroups = new Map<string, string[]>();
  for (const id of nodeIds) {
    const ct = workflow[id].class_type;
    if (!/Loader|Load/i.test(ct)) continue;
    for (const value of Object.values(workflow[id].inputs)) {
      if (typeof value === "string" && MODEL_FILE_RE.test(value)) {
        const key = `${ct}${DUP_SEP}${value}`;
        const arr = loadGroups.get(key) ?? [];
        arr.push(id);
        loadGroups.set(key, arr);
      }
    }
  }
  for (const [key, ids] of loadGroups) {
    if (ids.length < 2) continue;
    const [ct, file] = key.split(DUP_SEP);
    findings.push({
      kind: "duplicate_model_load",
      severity: "warning",
      node_ids: ids,
      node_type: ct,
      detail: `${ct} loads "${file}" in nodes ${ids.join(", ")} — merge into one loader to save VRAM.`,
    });
  }

  // --- 4. Orphaned branches (warning) --------------------------------------
  // Reverse-BFS from every output node; unreached non-output nodes are computed
  // but never saved. Report one finding per connected component of the unreached
  // set (over the undirected graph) to avoid many line items on big graphs.
  const outputNodes = nodeIds.filter((id) => isOutputNode(workflow[id].class_type, objectInfo));
  if (nodeIds.length > 0 && outputNodes.length === 0) {
    // No output node at all → ComfyUI rejects the prompt outright with "Prompt
    // has no outputs" (field: small models hand-build a graph and forget the
    // sink). Surface it as the top finding so validate/analyze catches it BEFORE
    // a failed run, and the agent can add the missing node instead of retrying.
    findings.push({
      kind: "no_output_reachable",
      severity: "warning",
      node_ids: [],
      detail:
        "No output node — the workflow will FAIL to run (ComfyUI: \"Prompt has no outputs\"). " +
        "Add a terminal SaveImage (or PreviewImage / SaveVideo / SaveAudio) node and connect the final IMAGE/LATENT/etc. into it before running.",
    });
  }
  if (outputNodes.length > 0) {
    const reachable = new Set<string>();
    const queue = [...outputNodes];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const src of sources.get(cur)!) {
        if (!reachable.has(src)) queue.push(src);
      }
    }

    const unreached = nodeIds.filter(
      (id) => !reachable.has(id) && !isOutputNode(workflow[id].class_type, objectInfo),
    );
    // Exclude fully-disconnected nodes already reported in check 1 — an isolated
    // node is its own story, not an orphaned branch.
    const unreachedSet = new Set(
      unreached.filter(
        (id) => sources.get(id)!.size > 0 || consumers.get(id)!.size > 0,
      ),
    );

    // Undirected connected components within the unreached set.
    const visited = new Set<string>();
    for (const start of unreachedSet) {
      if (visited.has(start)) continue;
      const component: string[] = [];
      const stack = [start];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        component.push(cur);
        for (const nb of [...sources.get(cur)!, ...consumers.get(cur)!]) {
          if (unreachedSet.has(nb) && !visited.has(nb)) stack.push(nb);
        }
      }
      component.sort((a, b) => a.localeCompare(b));
      const types = component.map((id) => workflow[id].class_type);
      findings.push({
        kind: "orphaned_branch",
        severity: "warning",
        node_ids: component,
        detail: `Orphaned branch: nodes ${component.join(", ")} (${types.join(" → ")}) never reach a save/preview node.`,
      });
    }
  }

  // --- 5. Muted / bypassed nodes (info) ------------------------------------
  // Surfaced via _meta.mode where the raw API JSON carries it. convertUiToApi
  // *drops* mode-2/4 nodes, so for library workflows this is usually absent and
  // silently skipped; raw API JSON handed to create_workflow (action:"validate") is checked here.
  for (const id of nodeIds) {
    const mode = workflow[id]._meta?.mode;
    if (mode === "muted" || mode === "bypassed") {
      const ct = workflow[id].class_type;
      findings.push({
        kind: "muted_or_bypassed",
        severity: "info",
        node_ids: [id],
        node_type: ct,
        detail: `Node ${id} (${ct}) is ${mode} (_meta.mode) — its connections are silently dropped.`,
      });
    }
  }

  // --- 6. Partial denoise fed by an empty latent (warning) -----------------
  // A sampler with denoise < 1.0 is being asked to keep part of its input latent.
  // If that input is an Empty*Latent* node the input is ZEROS, so there is nothing
  // to keep and the run is degenerate — it validates, executes without error, and
  // returns a flat/uniform field (#2678).
  //
  // Why it is a certainty rather than a guess, from ComfyUI's own source:
  //   samplers.py KSAMPLER.sample ->
  //     noise = model_sampling.noise_scaling(sigmas[0], noise, latent_image, max_denoise)
  //   model_sampling.py CONST.noise_scaling (flow-matching: Qwen, Flux, SD3, WAN) ->
  //     return sigma * noise + (1.0 - sigma) * latent_image
  // With denoise <= 0.9999 the schedule is truncated so sigmas[0] < sigma_max, which
  // is what gives the `(1.0 - sigma) * latent_image` term any weight at all. Hand it
  // a zero latent and that term contributes nothing: the sampler is told the clean
  // image underneath the noise IS the empty latent, and it integrates toward exactly
  // that. (EPS models take the sibling branch with the same consequence.) At
  // denoise = 1.0 sigmas[0] IS sigma_max, the term is multiplied by zero, and an
  // empty latent is correct — which is why this is scoped to the truncated branch.
  //
  // Deliberately DIRECT-connection only. A hires-fix chain (KSampler -> LatentUpscale
  // -> KSampler denoise 0.5) is healthy and must never be flagged, and tracing through
  // arbitrary latent ops to decide whether real content survives would trade a
  // zero-false-positive check for a guess.
  for (const id of nodeIds) {
    const node = workflow[id];
    const denoise = node.inputs?.denoise;
    // A literal widget value only. A converted-to-input `denoise` is a connection
    // tuple whose value we cannot know statically, and a non-finite value is not a
    // claim about the schedule either way.
    if (typeof denoise !== "number" || !Number.isFinite(denoise)) continue;
    if (denoise > FULL_DENOISE_THRESHOLD) continue;

    const latentInput = node.inputs?.latent_image;
    if (!isConnection(latentInput)) continue;

    const sourceId = latentInput[0];
    const sourceType = workflow[sourceId]?.class_type;
    if (!sourceType || !EMPTY_LATENT_RE.test(sourceType)) continue;

    findings.push({
      kind: "partial_denoise_empty_latent",
      severity: "warning",
      node_ids: [id, sourceId],
      node_type: node.class_type,
      detail:
        `Node ${id} (${node.class_type}) runs denoise=${denoise} on a latent taken straight from ` +
        `node ${sourceId} (${sourceType}), which emits an EMPTY latent. denoise < 1.0 keeps part of ` +
        `the input latent — but there is nothing to keep, so the sampler denoises toward the empty ` +
        `latent and the result decodes to a flat, near-uniform field. It will run without error. ` +
        `For image editing / img2img, feed latent_image from a VAEEncode of the source image ` +
        `instead. For text-to-image from an empty latent, set denoise to 1.0.`,
    });
  }

  // --- Summary -------------------------------------------------------------
  const typeCount = Object.keys(histogram).length;
  const top = Object.entries(histogram)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([ct, n]) => `${ct} x${n}`)
    .join(", ");
  const warnCount = findings.filter((f) => f.severity === "warning").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;
  const summary =
    `${nodeIds.length} nodes, ${typeCount} types` +
    (top ? ` (top: ${top})` : "") +
    ` — ${warnCount} warning(s), ${infoCount} info.`;

  return {
    total_nodes: nodeIds.length,
    node_type_histogram: histogram,
    findings,
    summary,
  };
}
