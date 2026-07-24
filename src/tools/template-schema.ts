import { z } from "zod";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorToToolResult } from "../utils/errors.js";
import { getComfyUIApiHost, getComfyUIProtocol } from "../config.js";
import { getObjectInfo } from "../comfyui/client.js";
import { convertUiToApi, isApiFormat, isUiFormat } from "../services/workflow-converter.js";
import { enumeratePacks, resolvePackWorkflowFile } from "./skills-access.js";
import type {
  ComfyUINodeDef,
  NodeInputSpec,
  ObjectInfo,
  WorkflowJSON,
  UiWorkflow,
} from "../comfyui/types.js";

// ── get_template_schema ──────────────────────────────────────────────────────
// The template-level "what can I override" view: resolve a template (bundled
// installer pack first, then an official ComfyUI workflow template on the live
// server — the SAME sources list_packs / list_workflow_templates enumerate and
// read_pack_workflow loads), normalize it to API/prompt format so every widget
// has a NAME, then surface the meaningful run-time parameters ("slots").
//
// KEY CONVENTION (shared with run_template's `overrides`): every slot key is
//   "<nodeId>.<widget_name>"        e.g.  "3.seed", "6.text", "5.width"
// so get_template_schema → run_template round-trips with zero translation.

export interface TemplateSlot {
  /** Stable override key: "<nodeId>.<widget_name>" — feed straight into run_template overrides. */
  key: string;
  node_id: string;
  class_type: string;
  /** The node's title when it differs from the class type (helps tell positive vs negative prompt). */
  node_title?: string;
  widget: string;
  /** Semantic role: prompt | seed | steps | cfg | guidance | sampler | scheduler | denoise | width | height | batch_size | checkpoint | lora | model | strength | input_image | input_media | length | frame_rate | shift | other */
  role: string;
  /** Value type: INT | FLOAT | STRING | BOOLEAN | COMBO (from node schema when known, else inferred from the value). */
  type: string;
  /** The template's current/default value for this widget. */
  value: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: unknown[];
  options_count?: number;
}

// Roles that make a slot "primary" (surfaced in `slots`); everything else is a
// still-overridable but structural/secondary widget (surfaced in `other_slots`).
const PRIMARY_ROLES = new Set([
  "prompt", "seed", "steps", "cfg", "guidance", "sampler", "scheduler",
  "denoise", "width", "height", "batch_size", "checkpoint", "lora", "model",
  "strength", "input_image", "input_media", "length", "frame_rate", "shift",
]);

/** Classify a widget into a semantic role from its name + owning class type. */
export function classifyWidget(classType: string, widget: string): string {
  const w = widget.toLowerCase();
  const c = classType.toLowerCase();
  if (w === "text" || w === "prompt" || w === "positive_prompt" || w === "negative_prompt") {
    if (/textencode|prompt|conditioning/.test(c) || w !== "text") return "prompt";
  }
  if (w === "seed" || w === "noise_seed" || w === "rand_seed") return "seed";
  if (w === "steps") return "steps";
  if (w === "cfg" || w === "cfg_scale" || w === "guidance_scale") return "cfg";
  if (w === "guidance") return "guidance";
  if (w === "sampler_name") return "sampler";
  if (w === "scheduler") return "scheduler";
  if (w === "denoise") return "denoise";
  if (w === "width") return "width";
  if (w === "height") return "height";
  if (w === "batch_size") return "batch_size";
  if (w === "ckpt_name") return "checkpoint";
  if (w === "lora_name" || /^lora_\d+$/.test(w)) return "lora";
  if (
    w === "unet_name" || w === "model_name" || w === "clip_name" ||
    /^clip_name\d+$/.test(w) || w === "vae_name" || w === "style_model_name" ||
    w === "control_net_name" || w === "ipadapter_file" || w === "gguf_name"
  ) {
    return "model";
  }
  if (w === "strength_model" || w === "strength_clip" || (w === "strength" && /lora/.test(c))) {
    return "strength";
  }
  if (w === "image" && /loadimage/.test(c)) return "input_image";
  if ((w === "video" || w === "audio" || w === "file") && /^load/.test(c)) return "input_media";
  if (w === "length" || w === "num_frames" || w === "frames" || w === "video_frames") return "length";
  if (w === "frame_rate" || w === "fps") return "frame_rate";
  if (w === "shift" || w === "max_shift") return "shift";
  return "other";
}

/** An API-format connection reference: [nodeId, outputSlot] — only when the
 *  referenced node actually exists (a literal like [512, 512] is a widget value). */
function isLinkValue(v: unknown, nodeKeys: Set<string>): boolean {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number" &&
    nodeKeys.has(String(v[0]))
  );
}

function specFor(def: ComfyUINodeDef | undefined, widget: string): NodeInputSpec | undefined {
  if (!def) return undefined;
  // V3 dynamic-combo nested inputs are keyed "<combo>.<nested>" — no direct
  // spec lookup; treat as schema-less (value-inferred type).
  return def.input?.required?.[widget] ?? def.input?.optional?.[widget];
}

const MAX_OPTIONS = 24;

/**
 * Extract override slots from an API/prompt-format graph. Pure + offline:
 * `objectInfo` (live /object_info or the built-in fallback) only ENRICHES
 * (type/min/max/options) — extraction itself needs nothing but the graph.
 */
export function extractTemplateSlots(
  api: WorkflowJSON,
  objectInfo?: ObjectInfo | null,
): { slots: TemplateSlot[]; other_slots: TemplateSlot[] } {
  const slots: TemplateSlot[] = [];
  const other: TemplateSlot[] = [];
  const nodeKeys = new Set(Object.keys(api));
  const ids = Object.keys(api).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });
  for (const nodeId of ids) {
    const node = api[nodeId];
    if (!node || typeof node !== "object" || typeof node.class_type !== "string") continue;
    const inputs = node.inputs;
    // An inputs ARRAY is malformed (Object.entries would emit fake "<id>.0"
    // index keys) — only a name→value record is a valid API-format inputs map.
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
    const def = objectInfo?.[node.class_type];
    const title = node._meta?.title;
    for (const [widget, value] of Object.entries(inputs)) {
      if (isLinkValue(value, nodeKeys)) continue; // connection, not an overridable widget
      const slot: TemplateSlot = {
        key: `${nodeId}.${widget}`,
        node_id: nodeId,
        class_type: node.class_type,
        widget,
        role: classifyWidget(node.class_type, widget),
        type: "STRING",
        value,
      };
      if (title && title !== node.class_type) slot.node_title = title;
      const spec = specFor(def, widget);
      if (spec) {
        const [typeSpec, cfg] = spec;
        if (Array.isArray(typeSpec)) {
          slot.type = "COMBO";
          slot.options_count = typeSpec.length;
          slot.options = typeSpec.slice(0, MAX_OPTIONS);
        } else {
          slot.type = String(typeSpec);
        }
        if (cfg && typeof cfg === "object") {
          if (typeof cfg.min === "number") slot.min = cfg.min;
          if (typeof cfg.max === "number") slot.max = cfg.max;
          if (typeof cfg.step === "number") slot.step = cfg.step;
        }
      } else {
        // No schema for this node/widget — infer the type from the value.
        slot.type =
          typeof value === "number"
            ? Number.isInteger(value) ? "INT" : "FLOAT"
            : typeof value === "boolean"
              ? "BOOLEAN"
              : "STRING";
      }
      (PRIMARY_ROLES.has(slot.role) ? slots : other).push(slot);
    }
  }
  return { slots, other_slots: other };
}

// ── Fallback node schema ─────────────────────────────────────────────────────
// A minimal object_info for the common core nodes, used when the live server
// is unreachable so UI-format templates can still be mapped from positional
// widgets_values to NAMED widgets (the converter needs a def per class type).
// Live /object_info always wins when available.

function def(required: Record<string, NodeInputSpec>): ComfyUINodeDef {
  return {
    input: { required },
    input_order: { required: Object.keys(required) },
    output: [],
    output_is_list: [],
    output_name: [],
    name: "",
    display_name: "",
    description: "",
    category: "",
    output_node: false,
  };
}

const INT: NodeInputSpec = ["INT", {}];
const FLOAT: NodeInputSpec = ["FLOAT", {}];
const STR: NodeInputSpec = ["STRING", {}];
const COMBO: NodeInputSpec = ["COMBO", {}];

export const FALLBACK_OBJECT_INFO: ObjectInfo = {
  CLIPTextEncode: def({ text: ["STRING", { multiline: true }] }),
  KSampler: def({
    seed: ["INT", { min: 0, control_after_generate: true }],
    steps: ["INT", { min: 1, max: 10000 }],
    cfg: ["FLOAT", { min: 0, max: 100 }],
    sampler_name: COMBO,
    scheduler: COMBO,
    denoise: ["FLOAT", { min: 0, max: 1 }],
  }),
  KSamplerAdvanced: def({
    add_noise: COMBO,
    noise_seed: ["INT", { min: 0, control_after_generate: true }],
    steps: ["INT", { min: 1, max: 10000 }],
    cfg: ["FLOAT", { min: 0, max: 100 }],
    sampler_name: COMBO,
    scheduler: COMBO,
    start_at_step: INT,
    end_at_step: INT,
    return_with_leftover_noise: COMBO,
  }),
  EmptyLatentImage: def({ width: INT, height: INT, batch_size: INT }),
  EmptySD3LatentImage: def({ width: INT, height: INT, batch_size: INT }),
  CheckpointLoaderSimple: def({ ckpt_name: COMBO }),
  LoraLoader: def({ lora_name: COMBO, strength_model: FLOAT, strength_clip: FLOAT }),
  LoraLoaderModelOnly: def({ lora_name: COMBO, strength_model: FLOAT }),
  LoadImage: def({ image: COMBO }),
  SaveImage: def({ filename_prefix: STR }),
  UNETLoader: def({ unet_name: COMBO, weight_dtype: COMBO }),
  VAELoader: def({ vae_name: COMBO }),
  CLIPLoader: def({ clip_name: COMBO, type: COMBO }),
  DualCLIPLoader: def({ clip_name1: COMBO, clip_name2: COMBO, type: COMBO }),
  RandomNoise: def({ noise_seed: ["INT", { min: 0, control_after_generate: true }] }),
  KSamplerSelect: def({ sampler_name: COMBO }),
  BasicScheduler: def({ scheduler: COMBO, steps: INT, denoise: FLOAT }),
  FluxGuidance: def({ guidance: FLOAT }),
  CFGGuider: def({ cfg: FLOAT }),
  ModelSamplingSD3: def({ shift: FLOAT }),
};

/**
 * Normalize a loaded template graph (UI or API format) to API/prompt format so
 * every widget carries a NAME. UI graphs need node defs — live object_info when
 * reachable, else FALLBACK_OBJECT_INFO (unknown node types are skipped with a
 * warning rather than crashing). Returns null when the JSON is neither format.
 */
export function templateGraphToApi(
  graph: unknown,
  objectInfo: ObjectInfo | null,
): { api: WorkflowJSON; warnings: string[]; objectInfo: ObjectInfo } | null {
  if (isUiFormat(graph)) {
    const merged: ObjectInfo = { ...FALLBACK_OBJECT_INFO, ...(objectInfo ?? {}) };
    // isUiFormat only checks that nodes/links are arrays — drop malformed
    // entries (null nodes, missing id/type) so the converter can't crash on
    // odd shapes; report what was dropped.
    const ui = graph as UiWorkflow;
    const warnings: string[] = [];
    const goodNodes = (ui.nodes ?? [])
      .filter(
        (n): n is UiWorkflow["nodes"][number] =>
          !!n && typeof n === "object" && typeof (n as { id?: unknown }).id === "number" &&
          typeof (n as { type?: unknown }).type === "string",
      )
      // The converter iterates node.inputs/outputs as arrays of objects and
      // dereferences entry fields (input.link, input.name) — normalize any
      // non-array nested field AND drop non-object entries so a malformed node
      // can't crash it. (Non-array widgets_values is LEGITIMATE — e.g. VHS
      // nodes use a name→value object — the converter handles it; leave alone.)
      .map((n) => {
        const slotArr = <T>(v: unknown): T[] | undefined =>
          Array.isArray(v)
            ? (v.filter((e) => !!e && typeof e === "object") as T[])
            : undefined;
        const inputs = slotArr<NonNullable<UiWorkflow["nodes"][number]["inputs"]>[number]>(n.inputs);
        const outputs = slotArr<NonNullable<UiWorkflow["nodes"][number]["outputs"]>[number]>(n.outputs);
        // widgets_values may be a positional array OR a name→value record (VHS
        // nodes) — both are valid. A scalar (string/number/…) would crash the
        // converter's `name in wv` check, so normalize it away.
        const wv = n.widgets_values;
        const widgets_values =
          Array.isArray(wv) || (wv != null && typeof wv === "object") ? wv : undefined;
        if (
          widgets_values === wv &&
          inputs?.length === (Array.isArray(n.inputs) ? n.inputs.length : -1) &&
          outputs?.length === (Array.isArray(n.outputs) ? n.outputs.length : -1)
        ) {
          return n; // fully well-shaped, keep as-is
        }
        return { ...n, inputs, outputs, widgets_values };
      });
    if (goodNodes.length !== (ui.nodes ?? []).length) {
      warnings.push(
        `Dropped ${(ui.nodes ?? []).length - goodNodes.length} malformed node entr(y/ies) (missing id/type).`,
      );
    }
    const goodLinks = (ui.links ?? []).filter((l) => Array.isArray(l) && l.length >= 6);
    const sanitized: UiWorkflow = { ...ui, nodes: goodNodes, links: goodLinks as UiWorkflow["links"] };
    const { workflow, warnings: convWarnings } = convertUiToApi(sanitized, merged);
    return { api: workflow, warnings: [...warnings, ...convWarnings], objectInfo: merged };
  }
  if (isApiFormat(graph)) {
    return {
      api: graph,
      warnings: [],
      objectInfo: { ...FALLBACK_OBJECT_INFO, ...(objectInfo ?? {}) },
    };
  }
  return null;
}

/** Fetch an official workflow template's graph from the live ComfyUI. */
async function loadServerTemplate(
  name: string,
): Promise<{ graph: unknown; source: string } | { error: string; available: string[] }> {
  const base = `${getComfyUIProtocol()}://${getComfyUIApiHost()}`;
  let index: Record<string, unknown> = {};
  try {
    const res = await fetch(`${base}/api/workflow_templates`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) index = (await res.json()) as Record<string, unknown>;
  } catch {
    return {
      error: "Not a bundled pack, and the ComfyUI server is unreachable to look up official workflow templates.",
      available: [],
    };
  }
  const all: string[] = [];
  let module: string | null = null;
  for (const [mod, names] of Object.entries(index)) {
    if (!Array.isArray(names)) continue;
    for (const n of names) {
      const nm = typeof n === "string" ? n : (n as { name?: string })?.name;
      if (typeof nm !== "string") continue;
      all.push(nm);
      if (nm === name && module == null) module = mod;
    }
  }
  if (module == null) {
    const needle = name.toLowerCase();
    const near = all.filter((n) => n.toLowerCase().includes(needle)).slice(0, 10);
    return {
      error: `No official workflow template named "${name}".`,
      available: near.length ? near : all.slice(0, 20),
    };
  }
  // Core templates ship in the comfyui-workflow-templates package served under
  // /templates/; custom-node templates under /api/workflow_templates/<module>/
  // (older servers: /extensions/<module>/example_workflows/). Try in order.
  const enc = encodeURIComponent(name);
  const candidates = [
    `${base}/templates/${enc}.json`,
    `${base}/api/workflow_templates/${encodeURIComponent(module)}/${enc}.json`,
    `${base}/extensions/${encodeURIComponent(module)}/example_workflows/${enc}.json`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      return { graph: await res.json(), source: `server-template:${module}` };
    } catch {
      // try next candidate
    }
  }
  return {
    error: `Template "${name}" is indexed (module "${module}") but its workflow JSON could not be fetched from the server.`,
    available: [],
  };
}

export function registerTemplateSchemaTools(server: McpServer): void {
  server.tool(
    "get_template_schema",
    "Get a template's OVERRIDABLE run-time parameters (its 'slots') before running it. Pass a bundled pack name (from list_packs) or an official ComfyUI workflow template name (from list_workflow_templates). Returns `slots` — the meaningful knobs: positive/negative prompt, seed, steps, cfg, sampler/scheduler, width/height, checkpoint/LoRA/model files, denoise, batch_size, input image — plus `other_slots` (every remaining overridable widget), each with a stable key `\"<nodeId>.<widget_name>\"`, semantic role, type, current value, and min/max/options where the node schema is known. Feed the keys DIRECTLY into run_template's `overrides` (same convention) for a schema→run round-trip.",
    {
      template: z
        .string()
        .min(1)
        .describe("Template name/id: a bundled pack directory name (list_packs) or an official workflow template name (list_workflow_templates)."),
    },
    async (args) => {
      try {
        const name = args.template.trim();
        let graph: unknown;
        let source: string;

        const packFile = resolvePackWorkflowFile(name);
        if (packFile) {
          graph = JSON.parse(readFileSync(packFile, "utf8"));
          source = `pack:${name}`;
        } else {
          const res = await loadServerTemplate(name);
          if ("error" in res) {
            const packs = enumeratePacks().map((p) => String(p.name));
            const near = packs.filter((p) => p.toLowerCase().includes(name.toLowerCase()));
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      error: `Could not resolve template "${name}". ${res.error}`,
                      near_matches: [...near, ...res.available].slice(0, 20),
                      hint: "Use list_packs for bundled packs or list_workflow_templates for official templates.",
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          graph = res.graph;
          source = res.source;
        }

        // Live node schema enriches types/min/max/options and names UI widgets;
        // fall back to the built-in core-node table offline.
        let live: ObjectInfo | null = null;
        try {
          live = await getObjectInfo();
        } catch {
          live = null;
        }
        const normalized = templateGraphToApi(graph, live);
        if (!normalized) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Template "${name}" resolved (${source}) but its JSON is neither a UI-format nor an API-format ComfyUI workflow.`,
              },
            ],
          };
        }
        const { slots, other_slots } = extractTemplateSlots(normalized.api, normalized.objectInfo);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  template: name,
                  source,
                  node_schema: live ? "live-object_info" : "builtin-fallback (server unreachable — types/options are best-effort)",
                  slot_key_format: "<nodeId>.<widget_name> — pass these keys as run_template overrides",
                  slot_count: slots.length,
                  slots,
                  other_slot_count: other_slots.length,
                  other_slots,
                  warnings: normalized.warnings.slice(0, 20),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
