import type {
  ObjectInfo,
  ComfyUINodeDef,
  NodeInputSpec,
  WorkflowJSON,
} from "../comfyui/types.js";
import { getObjectInfo } from "../comfyui/client.js";
import { enqueueWorkflow } from "./workflow-executor.js";
import { config } from "../config.js";
import { ValidationError } from "../utils/errors.js";

/**
 * API / partner-node support, mirroring `comfy-cli generate` (list / schema / run).
 *
 * MECHANISM & ASSUMPTIONS (confirmed against ComfyUI + comfy-cli source):
 * - These nodes run entirely on the *connected* ComfyUI server via its normal
 *   HTTP API (/object_info + /prompt), so this works against remote servers too.
 *   We reuse the existing client (getObjectInfo) and enqueue helper rather than
 *   re-implementing anything.
 * - ComfyUI marks hosted partner/API nodes in /object_info with `api_node: true`
 *   (server.py emits this from the node class's `API_NODE` attribute). Their
 *   `category` also conventionally starts with "api node/" (e.g.
 *   "api node/image/BFL", "api node/video/Kling"). We treat EITHER signal as a
 *   match so older/newer ComfyUI builds both work.
 *   Ref: comfyanonymous/ComfyUI server.py node_info() and comfy_api_nodes/*.py.
 * - AUTH: API nodes require a Comfy account / API key, but that credential is
 *   supplied to the *ComfyUI server* out-of-band — it is injected by the server
 *   into the node's HIDDEN inputs (`auth_token_comfy_org` / `api_key_comfy_org`)
 *   from the logged-in session. The MCP client does NOT (and should not) place
 *   the key in the workflow JSON. If the server isn't authenticated, the job
 *   will be enqueued but fail server-side; we surface that as guidance rather
 *   than trying to pass credentials ourselves. (Lower-confidence area — see
 *   docs.comfy.org/tutorials/api-nodes.)
 */

const API_CATEGORY_PREFIX = "api node";

/** Injectable dependencies so the logic is unit-testable without a live server. */
export interface ApiNodesDeps {
  getObjectInfo: () => Promise<ObjectInfo>;
  enqueue: (
    workflow: WorkflowJSON,
    options?: {
      disable_random_seed?: boolean;
      extra_data?: Record<string, unknown>;
    },
  ) => Promise<{ prompt_id: string; queue_remaining?: number }>;
}

const defaultDeps: ApiNodesDeps = {
  getObjectInfo,
  enqueue: enqueueWorkflow,
};

/** True if a node definition is a hosted partner/API node. */
export function isApiNode(def: ComfyUINodeDef): boolean {
  if (def.api_node === true) return true;
  const category = (def.category ?? "").toLowerCase();
  return category === API_CATEGORY_PREFIX || category.startsWith(`${API_CATEGORY_PREFIX}/`);
}

export interface ApiNodeSummary {
  class_type: string;
  display_name: string;
  category: string;
  description: string;
  output: string[];
  deprecated: boolean;
  experimental: boolean;
}

/**
 * Discover hosted partner/API nodes available on the connected ComfyUI.
 * Optionally narrow by a case-insensitive substring matched against the
 * class_type, display name, or category (e.g. "image", "kling", "video").
 */
export async function listApiNodes(
  filter?: string,
  deps: ApiNodesDeps = defaultDeps,
): Promise<ApiNodeSummary[]> {
  const objectInfo = await deps.getObjectInfo();
  const needle = filter?.trim().toLowerCase();

  const results: ApiNodeSummary[] = [];
  for (const [classType, def] of Object.entries(objectInfo)) {
    if (!def || !isApiNode(def)) continue;

    const summary: ApiNodeSummary = {
      class_type: classType,
      display_name: def.display_name || classType,
      category: def.category ?? "",
      description: def.description ?? "",
      output: Array.isArray(def.output) ? def.output : [],
      deprecated: def.deprecated === true,
      experimental: def.experimental === true,
    };

    if (needle) {
      const haystack = `${classType} ${summary.display_name} ${summary.category}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }

    results.push(summary);
  }

  results.sort((a, b) => a.class_type.localeCompare(b.class_type));
  return results;
}

/** Collect the ids of every subgraph DEFINITION in a UI-format workflow. A
 *  top-level node whose `type` equals one of these ids is a subgraph INSTANCE — a
 *  local structural grouping, not a real ComfyUI node type — so it must NOT be
 *  classified (it would otherwise look "unknown"/paid). The instance's real nodes
 *  live in the definition and are walked separately. Returns the def map so the
 *  caller can both skip instances and recurse into the definitions. */
function subgraphDefMap(g: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  const defs = (g.definitions as Record<string, unknown> | undefined)?.subgraphs;
  if (Array.isArray(defs)) {
    for (const sg of defs) {
      const id = (sg as Record<string, unknown> | null)?.id;
      if (typeof id === "string" && id.length > 0) m.set(id, sg as Record<string, unknown>);
    }
  }
  return m;
}

/** Count of subgraph definitions in a (UI-format) workflow — 0 if none/unknown. */
export function countSubgraphs(graph: unknown): number {
  if (!graph || typeof graph !== "object") return 0;
  return subgraphDefMap(graph as Record<string, unknown>).size;
}

/**
 * Extract the set of REAL node class_types referenced by a workflow, accepting
 * BOTH UI/litegraph format (top-level `nodes` array, each with a `type`) and
 * API/prompt format (top-level numeric keys, each an object with `class_type`).
 *
 * SUBGRAPH-AWARE: subgraph instances (a node whose `type` is a subgraph
 * definition id, i.e. a UUID) are NOT real node types — they're skipped, and the
 * instance's real inner nodes (from `definitions.subgraphs[].nodes`) are walked
 * instead (nested subgraphs included, since all definitions live in one flat
 * list). This keeps subgraph-heavy workflows from being mis-flagged "unknown"
 * while still classifying any API node nested inside a subgraph.
 */
export function extractWorkflowClassTypes(graph: unknown): string[] {
  const out = new Set<string>();
  if (!graph || typeof graph !== "object") return [];
  const g = graph as Record<string, unknown>;
  // UI/litegraph format.
  if (Array.isArray(g.nodes)) {
    const defs = subgraphDefMap(g);
    const walk = (nodes: unknown) => {
      if (!Array.isArray(nodes)) return;
      for (const n of nodes) {
        const t = (n as Record<string, unknown> | null)?.type;
        if (typeof t !== "string" || t.length === 0) continue;
        if (defs.has(t)) continue; // subgraph instance — structural; its def is walked below
        out.add(t);
      }
    };
    walk(g.nodes);
    for (const sg of defs.values()) walk(sg.nodes); // real nodes inside every subgraph def
    return [...out];
  }
  // API/prompt format (no subgraph definitions).
  for (const v of Object.values(g)) {
    const ct = (v as Record<string, unknown> | null)?.class_type;
    if (typeof ct === "string" && ct.length > 0) out.add(ct);
  }
  return [...out];
}

export interface WorkflowRuntime {
  /** "local" = every node was classified and runs on the user's GPU (free);
   *  "api" = every real node is a hosted API node (paid credits); "mixed" = some
   *  of each; "unknown" = some class_types couldn't be classified (not in the
   *  server's /object_info) and none of the rest are API nodes, so we CAN'T
   *  promise it's free — treat as possibly paid and ask. */
  runtime: "local" | "api" | "mixed" | "unknown";
  /** True if any recognized API node is present; null when runtime is "unknown"
   *  (unclassifiable nodes mean we can't rule API usage in or out). */
  usesApiNodes: boolean | null;
  /** The class_types in the workflow that are hosted API/partner nodes. */
  apiNodes: string[];
  /** All class_types found in the workflow. */
  classTypes: string[];
  /** class_types not present in the connected server's /object_info (can't be
   *  classified — e.g. uninstalled custom nodes). Subgraph instances are NOT
   *  listed here — they're recognized structurally and their inner nodes are
   *  classified instead. */
  unknownNodes: string[];
  /** Number of subgraph definitions in the workflow (0 if none). The agent uses
   *  this to know the graph nests subgraphs it may need to enter to edit. */
  subgraphCount: number;
}

/**
 * Classify a workflow's runtime (local-GPU vs paid API nodes) by scanning its
 * node class_types against the connected ComfyUI's /object_info (the same signal
 * isApiNode uses). Works on UI or API/prompt format graphs.
 */
export async function checkWorkflowRuntime(
  graph: unknown,
  deps: ApiNodesDeps = defaultDeps,
): Promise<WorkflowRuntime> {
  const classTypes = extractWorkflowClassTypes(graph);
  const objectInfo = await deps.getObjectInfo();
  const apiNodes: string[] = [];
  const unknownNodes: string[] = [];
  for (const ct of classTypes) {
    const def = objectInfo[ct];
    if (!def) {
      unknownNodes.push(ct);
      continue;
    }
    if (isApiNode(def)) apiNodes.push(ct);
  }
  const hasApiNodes = apiNodes.length > 0;
  // "api" only if EVERY classifiable node is an API node; "mixed" if some are.
  const classifiable = classTypes.length - unknownNodes.length;
  let runtime: "local" | "api" | "mixed" | "unknown";
  let usesApiNodes: boolean | null;
  if (hasApiNodes) {
    runtime = apiNodes.length >= classifiable && classifiable > 0 ? "api" : "mixed";
    usesApiNodes = true;
  } else if (unknownNodes.length > 0) {
    // No recognized API nodes, but some class_types aren't in /object_info — they
    // COULD be paid API/partner nodes the server doesn't expose. Don't claim free.
    runtime = "unknown";
    usesApiNodes = null;
  } else {
    runtime = "local";
    usesApiNodes = false;
  }
  return { runtime, usesApiNodes, apiNodes, classTypes, unknownNodes, subgraphCount: countSubgraphs(graph) };
}

export interface ApiNodeInputDescriptor {
  name: string;
  type: string | string[];
  required: boolean;
  /** Extra config from /object_info (default, min, max, options, tooltip, ...). */
  config: Record<string, unknown>;
}

export interface ApiNodeSchema {
  class_type: string;
  display_name: string;
  category: string;
  description: string;
  is_api_node: boolean;
  /** Whether the node is itself a terminal OUTPUT_NODE (drives execution). */
  is_output_node: boolean;
  /** Visible inputs the caller can/should supply. */
  inputs: ApiNodeInputDescriptor[];
  /**
   * Hidden inputs (e.g. auth_token_comfy_org). The ComfyUI server fills these
   * from the logged-in session — callers should NOT supply them.
   */
  hidden_inputs: string[];
  output: string[];
  output_name: string[];
}

function describeInputs(
  specs: Record<string, NodeInputSpec> | undefined,
  required: boolean,
): ApiNodeInputDescriptor[] {
  if (!specs) return [];
  return Object.entries(specs).map(([name, spec]) => {
    // Spec shape: [type, config?] where type is a string (e.g. "STRING") or a
    // string[] of enum options (e.g. ["fast", "quality"]).
    const type = Array.isArray(spec) ? spec[0] : (spec as unknown as string);
    const config = (Array.isArray(spec) ? spec[1] : undefined) ?? {};
    return {
      name,
      type: type as string | string[],
      required,
      config: config as Record<string, unknown>,
    };
  });
}

/** Return the input schema for a given API node (from its /object_info entry). */
export async function getApiNodeSchema(
  classType: string,
  deps: ApiNodesDeps = defaultDeps,
): Promise<ApiNodeSchema> {
  const objectInfo = await deps.getObjectInfo();
  const def = objectInfo[classType];

  if (!def) {
    throw new ValidationError(
      `Node "${classType}" was not found on the connected ComfyUI. ` +
        `Use list_api_nodes to see available API nodes.`,
    );
  }
  if (!isApiNode(def)) {
    throw new ValidationError(
      `Node "${classType}" exists but is not an API/partner node ` +
        `(category "${def.category ?? ""}"). Use list_api_nodes to find API nodes.`,
    );
  }

  return {
    class_type: classType,
    display_name: def.display_name || classType,
    category: def.category ?? "",
    description: def.description ?? "",
    is_api_node: true,
    is_output_node: def.output_node === true,
    inputs: [
      ...describeInputs(def.input?.required, true),
      ...describeInputs(def.input?.optional, false),
    ],
    hidden_inputs: def.input?.hidden ? Object.keys(def.input.hidden) : [],
    output: Array.isArray(def.output) ? def.output : [],
    output_name: Array.isArray(def.output_name) ? def.output_name : [],
  };
}

// ── V3 dynamic-combo (dotted widget) serialization ──────────────────────────
//
// A ComfyUI v3 node can declare a `COMFY_DYNAMICCOMBO_V3` input (e.g. Nano Banana
// 2's `model`). Selecting an option REVEALS a set of nested inputs. The live
// canvas serializes those nested widgets into the /prompt API format as DOTTED
// keys — `model` = the selected option key, and `model.<nested>` = each revealed
// widget value. The ComfyUI server rebuilds the nested dict from those dotted
// keys (it 400s with `required_input_missing` for e.g. `model.resolution` if they
// are absent). Our API-format builders must therefore emit the dotted form rather
// than the flat one. (Verified against a live server: flat `aspect_ratio` is
// ignored and `model.aspect_ratio` is the accepted key.)

interface DynamicComboOption {
  key?: unknown;
  inputs?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
}

const SIMPLE_WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

/**
 * If a node input is a v3 dynamic combo, return its option list (each option has
 * a `key` plus the nested `inputs` it reveals). Returns null otherwise.
 */
function dynamicComboOptions(descriptor: ApiNodeInputDescriptor): DynamicComboOption[] | null {
  const type = descriptor.type;
  const opts = (descriptor.config as { options?: unknown }).options;
  if (!Array.isArray(opts)) return null;
  const typeIsDyn =
    typeof type === "string" && type.toUpperCase().includes("DYNAMICCOMBO");
  // Also detect by shape: options that carry nested `inputs` (not plain strings).
  const shapeIsDyn = opts.some(
    (o) => o != null && typeof o === "object" && "inputs" in (o as object),
  );
  if (!typeIsDyn && !shapeIsDyn) return null;
  return opts as DynamicComboOption[];
}

/**
 * Classify a nested input spec (from a dynamic combo option) as a POSITIONAL
 * widget (one that carries a scalar value the caller supplies) and resolve its
 * default. Non-widget nested inputs (AUTOGROW lists, IMAGE/link types) are not
 * emitted unless the caller explicitly provides a value.
 */
function classifyNestedSpec(spec: unknown): { isWidget: boolean; dflt: unknown } {
  if (!Array.isArray(spec)) return { isWidget: false, dflt: undefined };
  const [type, cfg] = spec as [unknown, { default?: unknown; options?: unknown[] }?];
  if (Array.isArray(type)) {
    // Inline combo: ["1K","2K",...]
    return { isWidget: true, dflt: cfg?.default ?? type[0] };
  }
  const t = String(type).toUpperCase();
  if (SIMPLE_WIDGET_TYPES.has(t)) {
    let dflt = cfg?.default;
    if (dflt === undefined && Array.isArray(cfg?.options) && cfg.options.length) {
      dflt = cfg.options[0];
    }
    return { isWidget: true, dflt };
  }
  return { isWidget: false, dflt: undefined };
}

/**
 * Build the `inputs` map for an API-node prompt from caller-provided values,
 * serializing any v3 dynamic-combo input into its dotted `model.<nested>` form.
 *
 * The caller may supply nested values in any of three natural shapes — already
 * dotted (`"model.aspect_ratio"`), flat (`"aspect_ratio"`), or as a nested object
 * (`model: { key, aspect_ratio }`). Required nested widgets the caller omits are
 * filled from their schema default so the server doesn't 400. Hidden inputs
 * (server-injected auth) are dropped. Exported for unit testing.
 */
export function buildApiNodeInputs(
  schema: ApiNodeSchema,
  provided: Record<string, unknown>,
): { inputs: Record<string, unknown>; consumed: Set<string> } {
  const inputs: Record<string, unknown> = {};
  const consumed = new Set<string>(); // provided keys absorbed by combo expansion

  // Pass 1 — expand dynamic combos into dotted keys.
  for (const desc of schema.inputs) {
    const options = dynamicComboOptions(desc);
    if (!options) continue;
    const name = desc.name;

    // The selected option key may arrive as a string or inside a nested object.
    let selected = provided[name];
    let selObj: Record<string, unknown> | undefined;
    if (selected != null && typeof selected === "object" && !Array.isArray(selected)) {
      selObj = selected as Record<string, unknown>;
      selected = selObj.key ?? selObj.value;
    }
    const cfgDefault = (desc.config as { default?: unknown }).default;
    if (selected === undefined || selected === null) {
      selected = cfgDefault ?? options[0]?.key;
    }
    const option = options.find((o) => o.key === selected) ?? options[0];
    if (!option) continue;

    consumed.add(name);
    inputs[name] = option.key ?? selected;

    const emitNested = (
      nName: string,
      nSpec: unknown,
      requiredFill: boolean,
    ) => {
      const dottedKey = `${name}.${nName}`;
      let val: unknown;
      if (dottedKey in provided) {
        val = provided[dottedKey];
        consumed.add(dottedKey);
      } else if (selObj && nName in selObj) {
        val = selObj[nName];
      } else if (nName in provided) {
        val = provided[nName];
        consumed.add(nName);
      }
      if (val === undefined) {
        if (!requiredFill) return; // optional / non-widget — omit when absent
        const info = classifyNestedSpec(nSpec);
        if (!info.isWidget || info.dflt === undefined) return;
        val = info.dflt;
      }
      inputs[dottedKey] = val;
    };

    for (const [nName, nSpec] of Object.entries(option.inputs?.required ?? {})) {
      const info = classifyNestedSpec(nSpec);
      emitNested(nName, nSpec, info.isWidget);
    }
    for (const [nName, nSpec] of Object.entries(option.inputs?.optional ?? {})) {
      emitNested(nName, nSpec, false);
    }
  }

  // Pass 2 — copy remaining provided inputs (skip consumed + hidden).
  for (const [key, value] of Object.entries(provided)) {
    if (consumed.has(key)) continue;
    if (schema.hidden_inputs.includes(key)) continue;
    if (key in inputs) continue;
    inputs[key] = value;
  }

  // Pass 3 — fill any required top-level WIDGET input the caller omitted with its
  // schema default, so /prompt validation doesn't reject a missing required combo
  // /scalar (link-type inputs like IMAGE have no default and are left absent).
  for (const desc of schema.inputs) {
    if (!desc.required) continue;
    if (desc.name in inputs) continue;
    if (dynamicComboOptions(desc)) continue; // already emitted above
    const cfg = desc.config as { default?: unknown; options?: unknown[] };
    const type = desc.type;
    let dflt: unknown;
    if (Array.isArray(type)) {
      dflt = cfg.default ?? type[0];
    } else if (SIMPLE_WIDGET_TYPES.has(String(type).toUpperCase())) {
      dflt = cfg.default ?? (Array.isArray(cfg.options) ? cfg.options[0] : undefined);
    }
    if (dflt !== undefined) inputs[desc.name] = dflt;
  }

  return { inputs, consumed };
}

export interface GenerateWithApiNodeArgs {
  class_type: string;
  inputs: Record<string, unknown>;
  disable_random_seed?: boolean;
}

export interface GenerateWithApiNodeResult {
  prompt_id: string;
  queue_remaining?: number;
  /** The minimal single-node workflow that was enqueued. */
  workflow: WorkflowJSON;
  /** Non-fatal guidance (e.g. unknown inputs, auth reminder). */
  notes: string[];
}

/**
 * Build a minimal single-node workflow that runs a chosen API node with the
 * provided inputs and enqueue it. Returns the prompt_id (reuses the existing
 * enqueue path). The API node is typically an output node, so it can stand
 * alone as a complete graph.
 */
export async function generateWithApiNode(
  args: GenerateWithApiNodeArgs,
  deps: ApiNodesDeps = defaultDeps,
): Promise<GenerateWithApiNodeResult> {
  const schema = await getApiNodeSchema(args.class_type, deps);
  const notes: string[] = [];

  const provided = args.inputs ?? {};

  // Build the prompt inputs, serializing any v3 dynamic-combo input into its
  // dotted `model.<nested>` form (the canvas does this; a flat form 400s).
  const { inputs, consumed } = buildApiNodeInputs(schema, provided);

  // Acceptable input names: visible schema names, plus the nested names a dynamic
  // combo reveals (in both flat and dotted form) — so we don't warn about them.
  const knownNames = new Set(schema.inputs.map((i) => i.name));
  for (const desc of schema.inputs) {
    const options = dynamicComboOptions(desc);
    if (!options) continue;
    for (const opt of options) {
      for (const nName of Object.keys(opt.inputs?.required ?? {})) {
        knownNames.add(nName);
        knownNames.add(`${desc.name}.${nName}`);
      }
      for (const nName of Object.keys(opt.inputs?.optional ?? {})) {
        knownNames.add(nName);
        knownNames.add(`${desc.name}.${nName}`);
      }
    }
  }

  // Warn about inputs that aren't part of the node's visible schema (typos,
  // or hidden auth fields the server should fill itself).
  for (const key of Object.keys(provided)) {
    if (knownNames.has(key) || consumed.has(key)) continue;
    if (schema.hidden_inputs.includes(key)) {
      notes.push(
        `Ignoring "${key}": it is a hidden input filled by the ComfyUI server, not the client.`,
      );
    } else {
      notes.push(`Unknown input "${key}" for ${args.class_type} (passing through anyway).`);
    }
  }

  // Check required inputs are present in the built prompt (after combo expansion
  // and default-filling), and flag any genuinely missing ones.
  const missingRequired = schema.inputs
    .filter((i) => i.required && !(i.name in inputs))
    .map((i) => i.name);
  if (missingRequired.length > 0) {
    notes.push(
      `Missing required input(s): ${missingRequired.join(", ")}. ` +
        `The server may reject the job. Use get_api_node_schema for details.`,
    );
  }

  const workflow: WorkflowJSON = {
    "1": {
      class_type: args.class_type,
      inputs,
      _meta: { title: schema.display_name },
    },
  };

  // ComfyUI only executes graphs that reach a terminal OUTPUT_NODE; a bare
  // non-output API node fails validation with "prompt_no_outputs". If the API
  // node isn't itself an output node, wire its IMAGE output into a SaveImage.
  if (!schema.is_output_node) {
    const imageIdx = schema.output.findIndex(
      (o) => String(o).toUpperCase() === "IMAGE",
    );
    if (imageIdx >= 0) {
      workflow["2"] = {
        class_type: "SaveImage",
        inputs: { images: ["1", imageIdx], filename_prefix: "ComfyUI" },
        _meta: { title: "Save Image" },
      };
      notes.push(
        "Added a SaveImage output node — ComfyUI requires a terminal output node " +
          "for the prompt to execute.",
      );
    } else {
      notes.push(
        `"${args.class_type}" is not an output node and has no IMAGE output, so no ` +
          "output node was auto-added; the prompt may fail with 'prompt_no_outputs'. " +
          "Wire a terminal output node yourself if needed.",
      );
    }
  }

  // comfy.org API-node credentials travel in /prompt extra_data (the server
  // injects them into the node's hidden inputs). Supply the configured key so
  // API nodes work even when the ComfyUI server isn't logged in itself.
  const extraData: Record<string, unknown> = {};
  if (config.comfyApiKey) {
    extraData.api_key_comfy_org = config.comfyApiKey;
    notes.push(
      "Attached COMFY_API_KEY to the request (extra_data.api_key_comfy_org).",
    );
  } else {
    notes.push(
      "No COMFY_API_KEY configured — relying on the ComfyUI server's own logged-in " +
        "comfy.org session for API-node auth. Set COMFY_API_KEY if the server isn't logged in.",
    );
  }

  const result = await deps.enqueue(workflow, {
    disable_random_seed: args.disable_random_seed,
    extra_data: Object.keys(extraData).length > 0 ? extraData : undefined,
  });

  return {
    prompt_id: result.prompt_id,
    queue_remaining: result.queue_remaining,
    workflow,
    notes,
  };
}
