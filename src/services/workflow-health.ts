import type { WorkflowJSON, WorkflowNode, ObjectInfo } from "../comfyui/types.js";

/**
 * Graph-health heuristics for ComfyUI workflows.
 *
 * Where the hard validator (`workflow-validator.ts`) answers "will this graph
 * run?", this service answers "is this graph *healthy*?" — dead subgraphs,
 * duplicate model loads wasting VRAM, sampler branches whose outputs never reach
 * a save node, muted/bypassed nodes silently dropping connections, and samplers set
 * to a partial denoise over an empty latent (a graph that runs clean and returns a
 * flat field), and image-edit graphs whose sampled canvas is not derived from the
 * reference image at all.
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
    | "partial_denoise_empty_latent"
    | "edit_reference_empty_latent";
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
// custom EmptyLatentImagePresets family. Name-matching alone is not enough to
// call a node's output empty, so callers must ALSO require that the node consumes
// no links — see `producesEmptyLatent`.
const EMPTY_LATENT_RE = /^Empty[A-Za-z0-9_]*Latent/i;

// ComfyUI's OWN full-denoise gate, comfy/samplers.py KSampler.set_steps.
const FULL_DENOISE_THRESHOLD = 0.9999;

/**
 * Does ComfyUI actually start this sampler below sigma_max?
 *
 * This is `KSampler.set_steps` (comfy/samplers.py) transcribed, NOT a proxy for it:
 *
 *   if denoise is None or denoise > 0.9999:  self.sigmas = calculate_sigmas(steps)
 *   elif denoise <= 0.0:                     self.sigmas = FloatTensor([])
 *   else:  sigmas = calculate_sigmas(int(steps / denoise)); self.sigmas = sigmas[-(steps + 1):]
 *
 * The last branch only DROPS leading entries when `int(steps / denoise) > steps`.
 * When it doesn't, the slice keeps the whole schedule, `sigmas[0]` is still
 * sigma_max, and an empty latent is exactly correct. That makes the threshold
 * steps-dependent, and a bare `denoise <= 0.9999` test is WRONG: at steps=50,
 * denoise=0.9999 gives int(50.005) = 50, i.e. the full schedule. Same for
 * steps=4 at denoise=0.9 (int(4.44) = 4). Flagging those would be a false alarm
 * on an ordinary txt2img graph.
 *
 * Returns true only for the two shapes that really are degenerate over zeros:
 * a truncated schedule, and the empty schedule at denoise <= 0 (zero sampling
 * steps, so the sampler hands back the latent it was given, untouched).
 */
function startsBelowSigmaMax(denoise: number, steps: unknown): boolean {
  if (denoise <= 0) return true;
  if (denoise > FULL_DENOISE_THRESHOLD) return false;
  // `steps` decides the rest, so without a literal value there is no claim to make.
  if (typeof steps !== "number" || !Number.isFinite(steps) || steps <= 0) return false;
  // Python's int() truncates toward zero; both operands are positive here.
  return Math.trunc(steps / denoise) > steps;
}

// Scalar widget feeds. A link on one of these carries a NUMBER or a string into a
// dimension/seed slot; it cannot put picture content into the generated latent.
const SCALAR_INPUT_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN"]);

/**
 * Is this node's LATENT output empty — all zeros?
 *
 * The class-name test alone is not enough: an `EmptyLatentFromReference`-style
 * custom node derives its latent from an input and is not empty at all. But
 * "consumes no links" is too strict in the other direction, and would drop the
 * very common `PrimitiveInt → EmptyLatentImage.width` shape, whose output is
 * still zeros.
 *
 * So the question asked is specifically whether any CONNECTED input can carry
 * content, decided from the node's real `/object_info` slot types rather than
 * from its name. A width/height/batch_size feed is a scalar and changes only the
 * shape of the zeros; an IMAGE/LATENT/anything-else feed can carry a picture.
 *
 * A node missing from object_info, or a connected slot missing from its definition,
 * is NOT called empty — whether it is, is unknowable. That direction is the safe one:
 * it costs a warning we might have raised, never a false one.
 */
function producesEmptyLatent(
  node: { class_type: string; inputs?: Record<string, unknown> } | undefined,
  objectInfo: ObjectInfo,
): boolean {
  if (!node || !EMPTY_LATENT_RE.test(node.class_type)) return false;

  // An uninstalled node has no semantics here — its NAME is the only evidence, and a
  // name is not a fact. A custom `EmptyLatent…` could synthesise content from literal
  // configuration and never take a link at all, so a link-free unknown node must not
  // fall through to "empty". Nothing is lost by staying quiet: the validator already
  // reports an unknown class as a missing_node_type ERROR.
  const def = objectInfo[node.class_type];
  if (!def) return false;
  const slots = { ...(def.input?.required ?? {}), ...(def.input?.optional ?? {}) };

  for (const [name, value] of Object.entries(node.inputs ?? {})) {
    if (!isConnection(value)) continue;
    const declared = slots[name]?.[0];
    if (declared === undefined) return false; // unknown slot — decline to claim empty
    if (Array.isArray(declared)) continue; // a combo (dropdown) is a value, not content
    if (SCALAR_INPUT_TYPES.has(declared)) continue; // INT/FLOAT/… — shape, not content
    return false; // IMAGE / LATENT / … — this latent may be derived
  }
  return true;
}

// --- Image-edit reference geometry ---------------------------------------
//
// ComfyUI's Qwen edit text encoders carry the source image on CONDITIONING as
// `reference_latents`, at a HARD-CODED budget (comfy_extras/nodes_qwen.py, both
// TextEncodeQwenImageEdit and …Plus):
//
//   total = int(1024 * 1024)
//   scale_by = math.sqrt(total / (w * h))
//   width = round(w * scale_by / 8.0) * 8   # height likewise
//   ref_latents.append(vae.encode(...))
//
// so the reference is always ~1.05 MP at the SOURCE image's aspect ratio — a
// geometry computed at run time from pixels a static check cannot see.
//
// The transformer then places the reference tokens and the sampled tokens on the
// SAME centred RoPE grid (comfy/ldm/qwen_image/model.py `process_img`, called once
// for `x` and once per ref): both get
// `linspace(offset, len - 1 + offset) - (len // 2)` on the h and w axes, differing
// only in the `index` (t) channel. Reference token (i, j) and output token (i, j)
// therefore name the same coordinate ONLY when the two grids have the same shape.
//
// An `Empty*Latent*` node's dimensions are literals, so they can agree with a
// run-time-derived reference only by coincidence. #2681 sampled a 1104x1472 canvas
// (1.63 MP) against that 1.05 MP reference — 1.24x linear. Unlike #2678 this does
// not depend on denoise: at denoise 1.0 the graph renders a plausible image, it just
// re-synthesises the subject instead of copying it.
//
// Measured on the 533 workflow templates ComfyUI bundles
// (comfyui_workflow_templates_json): 33 samplers take `positive` from a node that
// sets reference_latents, 31 of them take `latent_image` from a `VAEEncode`, and NONE
// takes it from an empty latent. The remaining 2 are the Qwen-Image-Layered templates,
// whose `EmptyQwenImageLayeredLatentImage` genuinely is a different tensor rank from
// its reference — they reach reference_latents through a generic `ReferenceLatent`
// fed by a `CLIPTextEncode`, never through a Qwen edit encoder. That measurement is
// why this rule keys on the two Qwen edit ENCODERS and not on `ReferenceLatent`:
// including `ReferenceLatent` scores 2 false positives on the same corpus, and its
// reference geometry is whatever latent it is handed, so the equal-shape invariant
// is not universal for it.
const QWEN_EDIT_ENCODERS = new Set(["TextEncodeQwenImageEdit", "TextEncodeQwenImageEditPlus"]);

// `total = int(1024 * 1024)` in both encoders' execute().
const QWEN_EDIT_REFERENCE_PIXELS = 1024 * 1024;

// `image` on TextEncodeQwenImageEdit, `image1`..`image3` on …Plus. The name alone is
// not enough — a `TextEncodeQwenImageEdit` carrying an `image1` key is malformed, and
// accepting it would classify a node as emitting references over a slot its own class
// does not have. So the slot must ALSO be declared IMAGE in object_info.
const EDIT_IMAGE_SLOT_RE = /^image[0-9]*$/;

// Bound on the conditioning walk. Chains are a handful of nodes long in practice;
// this only stops a pathological graph from costing real time.
const CONDITIONING_WALK_LIMIT = 64;

/**
 * Does this node actually append `reference_latents`?
 *
 * Both guards transcribe the encoder's own control flow, and both are
 * false-positive guards rather than defensive noise:
 *   - `if vae is not None` — with no VAE the node never calls `vae.encode` and
 *     appends nothing, so it is a plain (if VL-conditioned) text encoder and an
 *     empty latent under it is ordinary txt2img.
 *   - `if image is not None` — same, with no image there is no reference at all.
 */
function emitsEditReferenceLatents(
  node: WorkflowNode | undefined,
  objectInfo: ObjectInfo,
): boolean {
  if (!node || !QWEN_EDIT_ENCODERS.has(node.class_type)) return false;

  // `vae` is the first half of ComfyUI's own condition, transcribed: with nothing wired
  // there the encoder never calls `vae.encode` and appends nothing.
  if (!isConnection(node.inputs?.vae)) return false;

  // The image slot is the second half, and its TYPE is checked as well as its name: a
  // key the class does not declare cannot stand in for one it does (a
  // `TextEncodeQwenImageEdit` carrying `image1` is malformed, not an edit graph). That
  // one test also settles the unknown-class case without a separate branch — a class
  // absent from object_info has no declared slots, so nothing is typed IMAGE and the
  // answer is "decline", the same direction `producesEmptyLatent` takes. Guards that
  // only restate this were removed after a mutation run showed no test could tell them
  // apart from their absence.
  const def = objectInfo[node.class_type];
  const slots = { ...(def?.input?.required ?? {}), ...(def?.input?.optional ?? {}) };
  return Object.entries(node.inputs ?? {}).some(
    ([slot, value]) =>
      EDIT_IMAGE_SLOT_RE.test(slot) && isConnection(value) && slots[slot]?.[0] === "IMAGE",
  );
}

/**
 * Walk a sampler's `positive` input upstream along CONDITIONING links, looking for
 * an edit encoder that really emits reference latents. Returns its node id, or null.
 *
 * KNOWN LIMIT (raised in review): the walk assumes a node that passes CONDITIONING
 * through also passes `reference_latents` through, and a transform that rebuilt the
 * entry from a fresh dict would break that — rule 7 would report a reference the sampler
 * never receives, and would suppress rule 6 while doing it. Measured against the
 * installed ComfyUI: the only conditioning entries built from a fresh `{}` are in
 * nodes_hunyuan3d.py and nodes_lotus.py, and neither node takes a CONDITIONING input, so
 * neither can sit mid-chain. Every stock transform (`ConditioningZeroOut`,
 * `conditioning_set_values`, …) does `t[1].copy()` and preserves the key. A custom node
 * could still do it; if one ever shows up, this is where to key off it.
 *
 * Only CONDITIONING-typed slots are followed, decided from real `/object_info` types
 * rather than slot names — so a `ControlNetApply`'s `image` input is not mistaken for
 * part of the conditioning chain. Three shapes end the walk, all in the same direction:
 *
 *   - a node absent from object_info (an uninstalled class has no known slot types)
 *   - any connected wildcard `*` slot, such as a Reroute's — it could be carrying
 *     anything, including the conditioning that actually reaches the output, so it
 *     counts as a fork arm even when a typed conditioning input sits beside it
 *   - a node with MORE THAN ONE connected CONDITIONING input. That is a fork, not a
 *     link in a chain, and which branch reaches the output is not knowable statically:
 *     a switch/mux passes one through and discards the rest, `ConditioningAverage`
 *     carries `reference_latents` from `conditioning_to` only, and
 *     `ControlNetApplyAdvanced` takes a positive and a negative and emits both on
 *     separate slots. Walking every branch would report a reference the sampler never
 *     receives — and, worse, would suppress rule 6 while doing it, turning a false
 *     positive into a LOST warning. (Raised in review; `ConditioningCombine` really
 *     does merge both branches, so declining costs a warning there.)
 *
 * Each costs a warning that could have been raised and none can raise a false one,
 * which is the same direction `producesEmptyLatent` takes. These are real trades, not
 * oversights, and workflow-health.test.ts asserts each of them.
 */
function findEditReferenceEncoder(
  workflow: WorkflowJSON,
  sampler: WorkflowNode,
  objectInfo: ObjectInfo,
): string | null {
  const start = sampler.inputs?.positive;
  if (!isConnection(start)) return null;

  const seen = new Set<string>();
  const queue: string[] = [start[0]];
  while (queue.length > 0 && seen.size < CONDITIONING_WALK_LIMIT) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);

    const node = workflow[id];
    if (!node) continue;
    if (emitsEditReferenceLatents(node, objectInfo)) return id;

    const def = objectInfo[node.class_type];
    if (!def) continue;
    const slots = { ...(def.input?.required ?? {}), ...(def.input?.optional ?? {}) };
    const upstream: string[] = [];
    let wildcardInput = false;
    for (const [slot, value] of Object.entries(node.inputs ?? {})) {
      if (!isConnection(value)) continue;
      const declared = slots[slot]?.[0];
      // A connected `*` is a fork arm of unknown type — it may well be carrying the
      // conditioning that actually reaches the output. Counting only the TYPED inputs
      // would let a node with one typed conditioning and one wildcard look like a chain.
      if (declared === "*") wildcardInput = true;
      else if (declared === "CONDITIONING") upstream.push(value[0]);
    }
    // Exactly one inbound conditioning and nothing untyped beside it is a chain and can
    // be followed. Anything else is a fork whose surviving branch is a run-time
    // decision — stop rather than guess.
    if (!wildcardInput && upstream.length === 1) queue.push(upstream[0]);
  }
  return null;
}

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

  // --- Empty latent under an image-edit reference (shared by rules 6 and 7) --
  // Computed before rule 6 so that rule 6 can stand down where rule 7 speaks: both
  // findings would name the same sampler and prescribe the same fix, but rule 6 also
  // offers "to generate from scratch, set denoise to 1.0", which for an edit graph is
  // the wrong half of the advice — #2681 is exactly that graph at denoise 1.0.
  const editReferenceSamplers = new Map<string, { encoderId: string; emptyId: string }>();
  for (const id of nodeIds) {
    const node = workflow[id];
    const latentInput = node.inputs?.latent_image;
    if (!isConnection(latentInput)) continue;
    if (!producesEmptyLatent(workflow[latentInput[0]], objectInfo)) continue;
    const encoderId = findEditReferenceEncoder(workflow, node, objectInfo);
    if (encoderId === null) continue;
    editReferenceSamplers.set(id, { encoderId, emptyId: latentInput[0] });
  }

  // --- 6. Partial denoise fed by an empty latent (warning) -----------------
  // A denoise low enough to truncate the schedule exists to PRESERVE part of the
  // incoming latent. If that latent is generated empty there is nothing to preserve:
  // the graph validates, executes without error, and cannot reproduce the source
  // image (#2678). Note this is specifically about the LATENT channel — a Qwen/Flux
  // edit encoder really does carry reference images on CONDITIONING, but conditioning
  // steers the denoising trajectory and never seeds its starting state, which is
  // built from `noise` and `latent_image` alone.
  //
  // From ComfyUI's own source, samplers.py KSAMPLER.sample:
  //   noise = model_sampling.noise_scaling(sigmas[0], noise, latent_image, max_denoise)
  // and model_sampling.py:
  //   CONST.noise_scaling -> sigma * noise + (1.0 - sigma) * latent_image   (flow matching)
  //   EPS.noise_scaling   -> noise * sigma + latent_image                   (SD1.x/SDXL)
  // Either way `latent_image` is the ONLY channel carrying source content, and it is
  // zeros. The severity of the visible result differs by family and the message says
  // so rather than overclaiming: on flow matching (Qwen, Flux, SD3, WAN) the source
  // term is `(1 - sigma) * 0`, so the model's target collapses to the empty latent and
  // the output is a flat, near-uniform field — the reported symptom. On EPS the start
  // state `sigma * noise` is still a legitimate noisy latent, so an image does appear;
  // it simply has nothing to do with any source image.
  //
  // Scope is deliberately narrow in three ways, each of which is a false-positive
  // guard rather than an oversight:
  //   - DIRECT connection only. A hires-fix chain (KSampler -> LatentUpscale ->
  //     KSampler denoise 0.5) carries real content and must stay silent; tracing
  //     through arbitrary latent ops to decide whether content survives would trade a
  //     zero-false-positive check for a guess.
  //   - LITERAL widget values only. A `denoise`/`steps` converted to an input is a
  //     connection whose runtime value cannot be known statically.
  //   - The schedule test is ComfyUI's own arithmetic, not a rounded threshold.
  for (const id of nodeIds) {
    if (editReferenceSamplers.has(id)) continue; // rule 7 says it, and says more
    const node = workflow[id];
    const denoise = node.inputs?.denoise;
    if (typeof denoise !== "number" || !Number.isFinite(denoise)) continue;
    if (!startsBelowSigmaMax(denoise, node.inputs?.steps)) continue;

    const latentInput = node.inputs?.latent_image;
    if (!isConnection(latentInput)) continue;

    const sourceId = latentInput[0];
    const sourceNode = workflow[sourceId];
    if (!producesEmptyLatent(sourceNode, objectInfo)) continue;
    const sourceType = sourceNode.class_type;

    const steps = node.inputs?.steps;
    const schedule =
      typeof steps === "number" && denoise > 0
        ? ` — ComfyUI builds int(${steps}/${denoise})=${Math.trunc(steps / denoise)} sigmas and keeps the last ${steps + 1}, so sampling starts BELOW sigma_max`
        : "";
    findings.push({
      kind: "partial_denoise_empty_latent",
      severity: "warning",
      node_ids: [id, sourceId],
      node_type: node.class_type,
      detail:
        `Node ${id} (${node.class_type}) runs denoise=${denoise}` +
        (typeof steps === "number" ? `, steps=${steps}` : "") +
        ` on a latent taken straight from node ${sourceId} (${sourceType}), which generates an ` +
        `EMPTY latent${schedule}. Starting below sigma_max is what PRESERVES part of the incoming ` +
        `latent — and an empty latent has nothing to preserve. Reference images carried on ` +
        `CONDITIONING (Qwen/Flux edit encoders) do not fill this in: latent_image is the only ` +
        `channel that seeds the sampler's starting state, and it is zeros. The graph runs without ` +
        `error; on flow-matching models (Qwen, Flux, SD3, WAN) the output collapses to a flat, ` +
        `near-uniform field. To edit an existing image, feed latent_image from an encode of it ` +
        `(VAEEncode; VAEEncodeAudio for audio). To generate from scratch, set denoise to 1.0.`,
    });
  }

  // --- 7. Empty latent under an image-edit reference (warning) -------------
  // See QWEN_EDIT_ENCODERS above for the mechanism and the corpus measurement. In
  // short: the encoder's reference latent is built from the SOURCE at run time and
  // the transformer aligns it with the sampled latent on a shared centred RoPE grid,
  // so a canvas whose size is a literal cannot be relied on to line up with it.
  //
  // Scope matches rule 6's: DIRECT latent connection only, and the encoder must be
  // reached through CONDITIONING slots typed by real object_info. Unlike rule 6 there
  // is no denoise condition — this one fires at denoise 1.0, which is the whole point.
  for (const [id, { encoderId, emptyId }] of editReferenceSamplers) {
    const node = workflow[id];
    const emptyNode = workflow[emptyId];
    const encoderType = workflow[encoderId].class_type;

    const width = emptyNode.inputs?.width;
    const height = emptyNode.inputs?.height;
    const area =
      typeof width === "number" && typeof height === "number" && width > 0 && height > 0
        ? width * height
        : null;

    let geometry = "";
    if (area !== null) {
      const ratio = area / QWEN_EDIT_REFERENCE_PIXELS;
      // Deliberately NOT phrased as proof. The encoder rounds each reference dimension
      // to a multiple of 8, so an extreme aspect ratio can move the reference's area a
      // few percent off the budget; an area gap is strong evidence, not a theorem. The
      // claim that always holds — a literal cannot track a run-time geometry — is in the
      // main sentence, and these clauses only add the arithmetic.
      geometry =
        ratio >= 0.95 && ratio <= 1.05
          ? ` Its ${width}x${height} canvas does match that budget in AREA, but the reference also keeps the SOURCE image's aspect ratio, which is not knowable until the graph runs — equal area is not equal shape.`
          : ` Here ${width}x${height} = ${area} px is ${ratio.toFixed(2)}x that ${QWEN_EDIT_REFERENCE_PIXELS} px budget in area, ${Math.sqrt(ratio).toFixed(2)}x linear.`;
    }

    // Rule 6 stood down for this node, so say its part here rather than lose it.
    const denoise = node.inputs?.denoise;
    const steps = node.inputs?.steps;
    const alsoTruncated =
      typeof denoise === "number" &&
      Number.isFinite(denoise) &&
      startsBelowSigmaMax(denoise, steps);
    // `startsBelowSigmaMax` is true for two different reasons and they are not the same
    // sentence: denoise <= 0 gives an EMPTY sigma tensor (zero sampling steps, the latent
    // is handed straight back), while a positive denoise gives a schedule missing its
    // leading sigmas. Both end in a flat field over zeros; only the second is truncation.
    const truncation = !alsoTruncated
      ? ""
      : (denoise as number) <= 0
        ? ` This sampler ALSO runs denoise=${denoise} over that empty latent, which builds an EMPTY sigma schedule — no sampling steps at all, so the empty latent is returned untouched and decodes to a flat field (#2678); feeding latent_image from the source fixes both.`
        : ` This sampler ALSO runs denoise=${denoise} over that empty latent, which truncates the sigma schedule and collapses the output to a flat field (#2678); feeding latent_image from the source fixes both.`;

    findings.push({
      kind: "edit_reference_empty_latent",
      severity: "warning",
      node_ids: [id, emptyId, encoderId],
      node_type: node.class_type,
      detail:
        `Node ${id} (${node.class_type}) takes latent_image straight from node ${emptyId} ` +
        `(${emptyNode.class_type}), which generates an EMPTY latent, while its positive ` +
        `conditioning comes from node ${encoderId} (${encoderType}) with a VAE and a reference ` +
        `image connected — so that conditioning carries reference_latents. ComfyUI scales every ` +
        `such reference to int(1024*1024) px at the SOURCE's aspect ratio and then aligns the ` +
        `reference tokens with the sampled tokens on one shared, centred RoPE grid, so the model ` +
        `can only copy detail when the sampled latent has the reference's geometry. An ` +
        `Empty*Latent* node's size is a literal and the reference's is computed from the ` +
        `source when the graph runs, so the two line up only by coincidence.${geometry} ` +
        `Unlike a partial denoise this does not depend on denoise: where the grids differ the ` +
        `graph still runs clean at denoise 1.0 and returns a plausible image, but re-synthesises ` +
        `the subject instead of preserving it — materials read as plastic/CGI and printed detail ` +
        `comes back as generic shapes (#2681). Where they happen to coincide it is fine, which is ` +
        `the trap: nothing here tells you which one you got.${truncation} Feed latent_image from ` +
        `a VAEEncode of the same image you ` +
        `gave the encoder (ComfyUI's own Qwen edit templates use FluxKontextImageScale -> ` +
        `VAEEncode). If you deliberately want a canvas unrelated to the reference, this warning ` +
        `is expected.`,
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
