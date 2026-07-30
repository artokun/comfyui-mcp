import type {
  WorkflowJSON,
  ObjectInfo,
  ComfyUINodeDef,
  NodeInputSpec,
  UiWorkflow,
  UiNode,
  UiNodeInput,
  UiNodeOutput,
  UiLink,
  SubgraphDefinition,
  SubgraphLink,
} from "../comfyui/types.js";
import { logger } from "../utils/logger.js";

export interface ConversionResult {
  workflow: WorkflowJSON;
  warnings: string[];
}

interface LinkInfo {
  sourceNodeId: number;
  sourceSlot: number;
  targetNodeId: number;
  targetSlot: number;
  typeName: string;
}

/**
 * Detect whether a parsed object is in ComfyUI UI format (nodes + links arrays)
 * vs API format (string keys with class_type + inputs).
 */
export function isUiFormat(obj: unknown): obj is UiWorkflow {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const record = obj as Record<string, unknown>;
  return Array.isArray(record.nodes) && Array.isArray(record.links);
}

/** The primitive scalar widget types that occupy a widgets_values slot. */
const SCALAR_WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

/**
 * Whether a (type, cfg) pair describes a scalar widget input. Beyond the plain
 * "INT"/"FLOAT"/… types this also recognizes:
 *  - a `widgetType` config hint (the frontend's authoritative "render this as a
 *    FLOAT/INT widget" flag), and
 *  - a COMBINED type string like "FLOAT,INT" (ComfyUI declares widgets whose value
 *    may be either — e.g. LTXVEmptyLatentAudio.frame_rate is `["FLOAT,INT", …]`).
 * Without this, a combined-type widget is misread as a LINK input, dropped from
 * the widget list, and every following widget value shifts by one slot (issue
 * #193: frame_rate 24 landed on batch_size and frame_rate fell back to default 25).
 */
function isScalarWidgetType(type: unknown, cfg?: unknown): boolean {
  const wt = (cfg as { widgetType?: unknown } | undefined)?.widgetType;
  if (typeof wt === "string" && SCALAR_WIDGET_TYPES.has(wt)) return true;
  if (typeof type !== "string") return false;
  if (SCALAR_WIDGET_TYPES.has(type)) return true;
  if (!type.includes(",")) return false;
  const parts = type.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => SCALAR_WIDGET_TYPES.has(p));
}

/**
 * Check if an input spec represents a widget (value input) vs a link (connection input).
 * Widget inputs have an array type spec like ["INT", {...}] or ["STRING", {...}].
 * Link inputs have a plain string type like "MODEL" or "CLIP".
 */
function isWidgetInput(
  inputName: string,
  def: ComfyUINodeDef,
): boolean {
  const spec =
    def.input.required?.[inputName] ?? def.input.optional?.[inputName];
  if (!spec) return false;

  const typeSpec = spec[0];
  // If the type is an array of choices like ["option1", "option2"], it's a widget
  if (Array.isArray(typeSpec)) return true;
  // V3 dynamic combo: a string type carrying an `options` list (e.g.
  // COMFY_DYNAMICCOMBO_V3) — the selected option's key is a widget value.
  const cfg = spec[1] as { options?: unknown } | undefined;
  if (Array.isArray(cfg?.options)) return true;
  // Standard + combined + widgetType-hinted scalar widgets.
  return isScalarWidgetType(typeSpec, cfg);
}

/**
 * Whether an input spec is a POSITIONAL widget — one that occupies a slot in the
 * UI's `widgets_values` array. Inline combos (`["a","b"]`), v3 dynamic combos
 * (a string type carrying an `options` list), and the standard scalar widget
 * types all qualify; link/list types (IMAGE, COMFY_AUTOGROW_V3, …) do not.
 */
function isPositionalWidgetSpec(spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  const type = spec[0];
  if (Array.isArray(type)) return true; // inline combo options
  const cfg = spec[1] as { options?: unknown } | undefined;
  if (Array.isArray(cfg?.options)) return true; // dynamic combo (options-carrying)
  return isScalarWidgetType(type, cfg);
}

/**
 * Model/asset file extensions that appear in ComfyUI loader combos
 * (unet_name, ckpt_name, vae_name, lora_name, control_net_name, clip_name, …).
 * Used to distinguish an asset-selection combo — where substituting a different
 * installed file silently swaps the user's model — from a plain enum combo
 * (sampler_name, a stale "Select to add Wildcard" UI helper) where falling back
 * to the first option is harmless.
 */
const ASSET_FILE_RE =
  /\.(safetensors|safetensor|sft|ckpt|pt|pt2|pth|bin|gguf|onnx|vae|pkl|npz|yaml)$/i;

export function looksLikeAssetFilename(value: unknown): boolean {
  return typeof value === "string" && ASSET_FILE_RE.test(value.trim());
}

/**
 * Widget names that are ALWAYS server-side MODEL asset selectors, even when their
 * options carry no file extension (e.g. DiffusersLoader.model_path lists
 * extensionless directory names). Substituting a different entry here silently
 * swaps the user's model, so these must never take the comboOpts[0] fallback
 * (issue #407). These "_name"/"model_path" widget names are unambiguous model
 * selectors on every node that exposes them, so a plain name match is safe.
 *
 * Deliberately EXCLUDES generic media names (image/audio/video) and enum-shaped
 * "_name" widgets (sampler_name, scheduler): those are NOT globally asset
 * selectors — a combo merely *named* `image` on some non-loader node, or a
 * `sampler_name`, is a true enum whose first-option fallback is legitimate.
 * Media/upload selectors are recognized structurally instead (see
 * LOADER_ASSET_INPUTS and isUploadSelectorSpec).
 */
const ASSET_WIDGET_NAMES = new Set([
  "ckpt_name",
  "unet_name",
  "vae_name",
  "lora_name",
  "clip_name",
  "clip_name1",
  "clip_name2",
  "clip_name3",
  "clip_name4",
  "control_net_name",
  "controlnet_name",
  "style_model_name",
  "gligen_name",
  "hypernetwork_name",
  "clip_vision_name",
  "model_path",
  "diffusion_model",
]);

/**
 * KNOWN server-side file/upload SELECTORS, keyed by (classType → input name):
 * real loader nodes whose combo lists media files present on the *connected*
 * server (uploads or on-disk inputs). For these — and ONLY these, plus the
 * model-loader widget names in ASSET_WIDGET_NAMES and object_info upload-flag
 * metadata (isUploadSelectorSpec) — a value absent from a STALE combo is
 * PRESERVED with a warning rather than silently rewritten to comboOpts[0]
 * (issue #504). This is deliberately an allowlist, NOT a global name/extension
 * heuristic: a combo merely *named* `image`/`audio`/`video`/`extension` on some
 * OTHER node, or a media-looking value (`.bmp`, `.mp4`, …) on a TRUE enum, is
 * NOT an asset selector and must take the enum fallback (substitute + warn) so
 * ComfyUI does not hard-reject a "Value not in list".
 */
const LOADER_ASSET_INPUTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["LoadImage", new Set(["image"])],
  ["LoadImageMask", new Set(["image"])],
  ["LoadImageOutput", new Set(["image"])],
  ["VHS_LoadVideo", new Set(["video"])],
  ["VHS_LoadVideoPath", new Set(["video"])],
  ["VHS_LoadVideoFFmpeg", new Set(["video"])],
  ["VHS_LoadVideoFFmpegPath", new Set(["video"])],
  ["LoadAudio", new Set(["audio"])],
  ["VHS_LoadAudio", new Set(["audio"])],
  ["VHS_LoadAudioUpload", new Set(["audio"])],
]);

function isKnownLoaderInput(classType: string, name: string): boolean {
  return LOADER_ASSET_INPUTS.get(classType)?.has(name) ?? false;
}

/**
 * Whether object_info marks this input as an in-browser file/media UPLOAD
 * selector — the authoritative signal that the combo lists server-side input
 * files (LoadImage's `image` carries `{image_upload: true}`, audio/video loaders
 * `{audio_upload|video_upload: true}`). When present this is more reliable than
 * any name allowlist, so a staged value absent from a stale combo is preserved.
 */
function isUploadSelectorSpec(spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  const cfg = spec[1] as Record<string, unknown> | undefined;
  if (!cfg || typeof cfg !== "object") return false;
  return (
    cfg.image_upload === true ||
    cfg.audio_upload === true ||
    cfg.video_upload === true
  );
}

/**
 * Extract the selectable option list from a widget spec, covering ALL three
 * combo shapes so validation never misses one (issue #504 P1-B):
 *   - inline combo:      [["a","b"], {..}]                 -> spec[0]
 *   - COMBO w/ options:  ["COMBO", {options:["a","b"]}]    -> spec[1].options
 *   - V3 dynamic combo:  ["COMFY_DYNAMICCOMBO_V3",         -> the option keys
 *                          {options:[{key:"K", inputs:{…}}]}]
 * A plain scalar spec (["INT",{…}]) or a link input carries no enumerable list,
 * so this returns undefined and the caller passes the value through untouched.
 * Object-shaped dynamic options are normalized to their `key`.
 */
function getComboOptions(spec: unknown): unknown[] | undefined {
  if (!Array.isArray(spec)) return undefined;
  const type = spec[0];
  if (Array.isArray(type)) return type; // inline combo: spec[0] IS the option list
  const cfg = spec[1] as { options?: unknown } | undefined;
  const opts = cfg?.options;
  if (Array.isArray(opts)) {
    // Flat value list (["auto","1:1"]) or object-keyed dynamic-combo list
    // ([{key:"Nano Banana 2", …}]). Normalize both to their selectable values.
    return opts.map((o) =>
      o &&
      typeof o === "object" &&
      !Array.isArray(o) &&
      "key" in (o as Record<string, unknown>)
        ? (o as { key: unknown }).key
        : o,
    );
  }
  return undefined;
}

/**
 * Validate one saved combo value against its object_info options (of ANY combo
 * shape — see getComboOptions) and return the value to store. This is the SINGLE
 * choke-point every combo-value assignment flows through — direct widget, the
 * name→value object form, the has_serialized_properties overwrite, a linked
 * PrimitiveNode literal (P1-A), AND a V3 dynamic-combo nested leaf value (P1-B) —
 * so no path can emit a value ComfyUI would reject with "Value not in list".
 *
 * Non-combo specs and in-list values pass through unchanged. For an out-of-list
 * value the decision mirrors #407/#504:
 *
 *  - genuine ASSET/upload selector (model-loader widget name, (classType,input)
 *    loader allowlist, or object_info upload flag) → PRESERVE + warn, so a
 *    staged/absent file surfaces as an honest missing-asset error rather than a
 *    silent wrong-file swap;
 *  - true ENUM (sampler_name, scheduler, a stale "Select to add Wildcard"
 *    helper, a combo merely NAMED image/extension, a media-looking value on a
 *    non-loader enum, an out-of-list dynamic/nested key) → SUBSTITUTE
 *    comboOpts[0] + warn, because ComfyUI hard-rejects a "Value not in list".
 *
 * `name` is the LEAF input name (nested leaf for dynamic combos) so asset
 * classification keys off the real selector name, and `spec` is that leaf's
 * spec, never regressing #504/#407.
 */
function validateComboValueForSpec(
  name: string,
  value: unknown,
  spec: unknown,
  classType: string,
  nodeId: string,
  warnings: string[],
): unknown {
  const comboOpts = getComboOptions(spec);
  // Not an enumerable combo (plain INT/FLOAT/STRING/BOOLEAN or a link input) —
  // nothing to validate against.
  if (!Array.isArray(comboOpts)) return value;
  // Already a valid option — pass through untouched.
  if (comboOpts.includes(value as never)) return value;
  const isAssetCombo =
    ASSET_WIDGET_NAMES.has(name) ||
    isKnownLoaderInput(classType, name) ||
    isUploadSelectorSpec(spec);
  // Recognized combo whose option list is EMPTY on the connected server (e.g. no
  // models/files installed, or a fully-retired enum). There is no valid option to
  // substitute to, so preserve the declared value and WARN — surfacing an honest
  // missing-option/asset error rather than SILENTLY emitting an out-of-list
  // literal. (Previously the length===0 branch returned the value with no warning.)
  if (comboOpts.length === 0) {
    warnings.push(
      isAssetCombo
        ? `Node ${nodeId} (${classType}): widget "${name}" value "${String(
            value,
          )}" — the connected server has no installed options for this asset combo; keeping the declared value so it surfaces as a missing-asset error.`
        : `Node ${nodeId} (${classType}): widget "${name}" value "${String(
            value,
          )}" — the connected server lists no options for this combo, so it cannot be validated; keeping the declared value so it surfaces as an honest error rather than being silently emitted.`,
    );
    return value;
  }
  if (isAssetCombo) {
    warnings.push(
      `Node ${nodeId} (${classType}): widget "${name}" value "${String(
        value,
      )}" is not installed on the connected server — keeping the declared value so it surfaces as a missing-asset error rather than silently substituting "${String(
        comboOpts[0],
      )}".`,
    );
    return value;
  }
  warnings.push(
    `Node ${nodeId} (${classType}): widget "${name}" value "${String(
      value,
    )}" is not a valid option on the connected server — substituting the first available option "${String(
      comboOpts[0],
    )}" so the graph stays runnable (ComfyUI rejects unknown enum values).`,
  );
  return comboOpts[0];
}

/**
 * Def-keyed wrapper for validateComboValueForSpec: resolves the input's spec from
 * object_info by name (required then optional) and delegates. Used by the direct
 * widget paths and the linked-PrimitiveNode path.
 */
function validateComboWidgetValue(
  name: string,
  value: unknown,
  def: ComfyUINodeDef,
  classType: string,
  nodeId: string,
  warnings: string[],
): unknown {
  const spec =
    (def.input?.required as Record<string, unknown>)?.[name] ??
    (def.input?.optional as Record<string, unknown>)?.[name];
  return validateComboValueForSpec(name, value, spec, classType, nodeId, warnings);
}

/**
 * Resolve an input NAME (possibly a V3 dynamic-combo dotted "<combo>.<leaf>"
 * key) to its LEAF name and object_info spec. A flat name resolves against the
 * node's top-level required/optional inputs. A dotted name resolves the leaf
 * against the parent dynamic combo's SELECTED option (looked up from the already
 * populated `inputs[parent]`), so validation and asset classification key off
 * the real leaf spec + leaf name — never the dotted name (which no top-level
 * lookup would find, letting an unvalidated value through). Used by the linked
 * PrimitiveNode path, where a primitive can feed a nested dotted input directly.
 */
function resolveWidgetSpec(
  def: ComfyUINodeDef,
  name: string,
  inputs: Record<string, unknown>,
): { leafName: string; spec: unknown } {
  const dot = name.indexOf(".");
  if (dot < 0) {
    const spec =
      (def.input?.required as Record<string, unknown>)?.[name] ??
      (def.input?.optional as Record<string, unknown>)?.[name];
    return { leafName: name, spec };
  }
  const parent = name.slice(0, dot);
  const leafName = name.slice(dot + 1);
  const parentSpec =
    (def.input?.required as Record<string, unknown>)?.[parent] ??
    (def.input?.optional as Record<string, unknown>)?.[parent];
  const opts = (
    Array.isArray(parentSpec)
      ? (parentSpec[1] as {
          options?: Array<{
            key?: unknown;
            inputs?: {
              required?: Record<string, unknown>;
              optional?: Record<string, unknown>;
            };
          }>;
        })
      : undefined
  )?.options;
  const selectedKey = inputs[parent];
  // V3 option inputs may live under required OR optional — search both so an
  // optional nested leaf isn't left unresolved (which would skip validation).
  const selected = Array.isArray(opts)
    ? opts.find((o) => o?.key === selectedKey)?.inputs
    : undefined;
  const spec = selected?.required?.[leafName] ?? selected?.optional?.[leafName];
  return { leafName, spec };
}

/**
 * Whether a widget SPEC carries a control_after_generate phantom slot — either
 * flagged in its config, or a seed-type INT the ComfyUI frontend auto-augments.
 * Works for both top-level inputs and V3 dynamic-combo NESTED leaves (which have
 * no entry in def.input), so nested controlled seeds skip their phantom
 * "fixed"/"randomize" slot too instead of shifting every following widget.
 */
function specHasControlAfterGenerate(name: string, spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  if ((spec[1] as Record<string, unknown> | undefined)?.control_after_generate === true)
    return true;
  // ComfyUI's frontend auto-adds a control_after_generate widget to seed-type INT
  // widgets even when object_info doesn't flag it (e.g. UltimateSDUpscale.seed,
  // KSamplerAdvanced.noise_seed). The saved widgets_values then carry the extra
  // "fixed"/"randomize"/… value that must be skipped during mapping.
  return (
    spec[0] === "INT" &&
    (name === "seed" || name === "noise_seed" || name === "rand_seed")
  );
}

/**
 * Check if an input has control_after_generate in its spec config.
 * These inputs (like seed, noise_seed) have a phantom "fixed"/"randomize" widget
 * in the UI's widgets_values array that doesn't correspond to any named input.
 */
function hasControlAfterGenerate(
  inputName: string,
  def: ComfyUINodeDef,
): boolean {
  const spec =
    def.input.required?.[inputName] ?? def.input.optional?.[inputName];
  if (!spec) return false;
  return specHasControlAfterGenerate(inputName, spec);
}

/**
 * Get the ordered list of input names from a node definition.
 * Uses input_order if available, otherwise falls back to object keys.
 */
function getOrderedInputNames(def: ComfyUINodeDef): string[] {
  const names: string[] = [];
  if (def.input_order) {
    if (def.input_order.required) names.push(...def.input_order.required);
    if (def.input_order.optional) names.push(...def.input_order.optional);
  } else {
    // Fallback: use object key order
    if (def.input.required) names.push(...Object.keys(def.input.required));
    if (def.input.optional) names.push(...Object.keys(def.input.optional));
  }
  return names;
}

// ── De-virtualization (Get/Set/Reroute) pre-pass ────────────────────────────

const WIRING_VIRTUAL_TYPES = new Set([
  "GetNode", "SetNode", "PRO_GetNode", "PRO_SetNode",
  "SetNode_GetNode", "SetNode_SetNode",
]);
const isGetVirtual = (t: string) => WIRING_VIRTUAL_TYPES.has(t) && /get/i.test(t);
const isSetVirtual = (t: string) =>
  WIRING_VIRTUAL_TYPES.has(t) && /set/i.test(t) && !/get/i.test(t);
const isWiringVirtual = (t: string | undefined) =>
  t != null && (t === "Reroute" || isGetVirtual(t) || isSetVirtual(t));

/**
 * The bus name (the "Constant" widget) that keys a Set/Get virtual node. Usually
 * widgets_values[0] on a serialized graph, but the live-canvas reconstruction
 * fallback (#384) keys widget values BY NAME, so widgets_values can be an object
 * ({ Constant: "…" }) instead of a positional array. Read both shapes so Set/Get
 * resolution survives the fallback path.
 */
function busKey(wv: unknown): unknown {
  if (Array.isArray(wv)) return wv[0];
  if (wv && typeof wv === "object") {
    const o = wv as Record<string, unknown>;
    return o.Constant ?? o.constant ?? Object.values(o)[0];
  }
  return undefined;
}

/**
 * Pre-pass: strip the pure "wiring" virtual nodes — KJNodes **Get/Set** bus nodes
 * and **Reroute** — by rewriting each consumer's link straight to the real
 * upstream source (following chains, and Get→bus→Set→source). Runs on the
 * top-level graph AND every subgraph definition, BEFORE expansion, so the
 * expander and the main converter only ever see real nodes and real links. This
 * removes the recurring class of dangling-ref bugs where a skipped virtual node
 * left its consumers (sometimes across a subgraph boundary) pointing at a node
 * that isn't in the prompt. PrimitiveNode is a value-provider, not a wire, so it
 * is left for the link loop (which has object_info to map the widget by name).
 */
function deVirtualizeGraph(
  nodes: UiNode[] | undefined,
  links: unknown[] | undefined,
): void {
  if (!nodes?.length || !links?.length) return;
  const dict = !Array.isArray(links[0]);
  const lid = (l: any) => (dict ? l.id : l[0]);
  const lsrc = (l: any) => (dict ? l.origin_id : l[1]);
  const lsrcSlot = (l: any) => (dict ? l.origin_slot : l[2]);
  const ltgt = (l: any) => (dict ? l.target_id : l[3]);
  const setLsrc = (l: any, n: unknown, s: unknown) => {
    if (dict) { l.origin_id = n; l.origin_slot = s; }
    else { l[1] = n; l[2] = s; }
  };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const linkById = new Map((links as any[]).map((l) => [lid(l), l]));
  const busSet = new Map<string, UiNode>();
  for (const n of nodes) {
    if (isSetVirtual(n.type)) {
      const b = busKey(n.widgets_values);
      if (b != null) busSet.set(String(b), n);
    }
  }
  const incoming = (node: UiNode) => {
    const inp = (node.inputs ?? []).find((i) => i.link != null);
    const l = inp?.link != null ? linkById.get(inp.link) : undefined;
    return l ? { node: lsrc(l), slot: lsrcSlot(l) } : null;
  };
  const resolveReal = (
    nodeId: unknown,
    slot: unknown,
    depth = 0,
  ): { node: unknown; slot: unknown } | null => {
    if (depth > 100) return null;
    const node = byId.get(nodeId as number);
    if (!node) return { node: nodeId, slot };
    if (node.type === "Reroute") {
      const s = incoming(node);
      return s ? resolveReal(s.node, s.slot, depth + 1) : null;
    }
    if (isGetVirtual(node.type)) {
      const b = busKey(node.widgets_values);
      const setN = b != null ? busSet.get(String(b)) : undefined;
      if (!setN) return null;
      const s = incoming(setN);
      return s ? resolveReal(s.node, s.slot, depth + 1) : null;
    }
    // SetNode passthrough: rgthree/KJNodes Set nodes expose an output that mirrors
    // their value input, so a consumer can wire straight off the SetNode (not only
    // via a GetNode). Follow the Set's value input to the real source — otherwise
    // the link is left pointing at the (removed) virtual and gets dropped, losing
    // the connection (issue #361: Set/Get-resolved links missing on downstream nodes).
    if (isSetVirtual(node.type)) {
      const s = incoming(node);
      return s ? resolveReal(s.node, s.slot, depth + 1) : null;
    }
    return { node: nodeId, slot };
  };

  const drop = new Set<unknown>();
  for (const l of links as any[]) {
    const srcType = byId.get(lsrc(l))?.type;
    if (
      srcType === "Reroute" ||
      (srcType && (isGetVirtual(srcType) || isSetVirtual(srcType)))
    ) {
      const real = resolveReal(lsrc(l), lsrcSlot(l));
      if (real && !isWiringVirtual(byId.get(real.node as number)?.type)) {
        setLsrc(l, real.node, real.slot);
      } else {
        drop.add(lid(l)); // unresolved bus/reroute — drop like a dead link
      }
    }
  }
  const keptLinks = (links as any[]).filter((l) => {
    if (drop.has(lid(l))) return false;
    if (isWiringVirtual(byId.get(ltgt(l))?.type)) return false; // link into a virtual
    if (isWiringVirtual(byId.get(lsrc(l))?.type)) return false; // still-virtual source
    return true;
  });
  const keptNodes = nodes.filter((n) => !isWiringVirtual(n.type));
  nodes.length = 0;
  nodes.push(...keptNodes);
  links.length = 0;
  (links as any[]).push(...keptLinks);
}

/** Strip wiring virtuals from the top-level graph and every subgraph definition. */
function deVirtualize(ui: UiWorkflow): void {
  deVirtualizeGraph(ui.nodes, ui.links as unknown[]);
  for (const sg of ui.definitions?.subgraphs ?? []) {
    deVirtualizeGraph(sg.nodes, sg.links as unknown[]);
  }
}

// ── Component / subgraph expansion ──────────────────────────────────────────

/**
 * Collect every node `type` referenced by a UI workflow — top-level nodes plus
 * the internal nodes of every subgraph definition. Used to backfill object_info
 * for node types missing from the bulk /object_info response.
 */
export function collectNodeTypes(ui: UiWorkflow): string[] {
  const types = new Set<string>();
  for (const n of ui.nodes ?? []) if (n.type) types.add(n.type);
  for (const sg of ui.definitions?.subgraphs ?? []) {
    for (const n of sg.nodes ?? []) if (n.type) types.add(n.type);
  }
  return [...types];
}

interface ExpandResult {
  expanded: UiWorkflow;
  warnings: string[];
}

/**
 * Expand component/subgraph nodes by flattening their inner graphs into the
 * outer workflow.  Component nodes have a UUID `type` that matches a definition
 * in `workflow.definitions.subgraphs`.  Each inner node gets a unique ID to
 * avoid collisions with outer nodes or other component instances.
 *
 * Handles nested components (component inside component) iteratively up to a
 * maximum depth of 10.
 */
export function expandComponents(ui: UiWorkflow): ExpandResult {
  const subgraphs = ui.definitions?.subgraphs;
  if (!subgraphs || subgraphs.length === 0) {
    return { expanded: ui, warnings: [] };
  }

  // Build subgraph lookup: UUID → definition
  const sgMap = new Map<string, SubgraphDefinition>();
  for (const sg of subgraphs) {
    sgMap.set(sg.id, sg);
  }

  // Deep-clone so we don't mutate the caller's data
  let nodes: UiNode[] = JSON.parse(JSON.stringify(ui.nodes));
  let links: UiLink[] = JSON.parse(JSON.stringify(ui.links));
  const warnings: string[] = [];

  // Find max IDs for safe remapping
  let nextNodeId = 1;
  let nextLinkId = 1;
  for (const n of nodes) nextNodeId = Math.max(nextNodeId, n.id + 1);
  for (const l of links) nextLinkId = Math.max(nextLinkId, l[0] + 1);
  for (const sg of subgraphs) {
    for (const n of sg.nodes) nextNodeId = Math.max(nextNodeId, n.id + 1);
    for (const l of sg.links) nextLinkId = Math.max(nextLinkId, l.id + 1);
  }

  const MAX_DEPTH = 10;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const componentNodes = nodes.filter((n) => sgMap.has(n.type));
    if (componentNodes.length === 0) break;

    for (const compNode of componentNodes) {
      const sg = sgMap.get(compNode.type)!;

      // Skip muted / bypassed component nodes
      if (compNode.mode === 2 || compNode.mode === 4) {
        warnings.push(
          `Component node ${compNode.id} ("${sg.name}") is muted/bypassed — skipping expansion.`,
        );
        // Remove it so the main converter doesn't warn about unknown type
        nodes = nodes.filter((n) => n.id !== compNode.id);
        continue;
      }

      const result = expandSingleComponent(
        compNode,
        sg,
        nodes,
        links,
        nextNodeId,
        nextLinkId,
      );
      nodes = result.nodes;
      links = result.links;
      nextNodeId = result.nextNodeId;
      nextLinkId = result.nextLinkId;
      warnings.push(...result.warnings);
    }
  }

  const expanded: UiWorkflow = {
    ...ui,
    nodes,
    links,
  };
  return { expanded, warnings };
}

/**
 * Expand a single component node, returning the modified nodes & links arrays.
 */
function expandSingleComponent(
  compNode: UiNode,
  sg: SubgraphDefinition,
  outerNodes: UiNode[],
  outerLinks: UiLink[],
  nextNodeId: number,
  nextLinkId: number,
): {
  nodes: UiNode[];
  links: UiLink[];
  nextNodeId: number;
  nextLinkId: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  const inputNodeId = sg.inputNode.id; // typically -10
  const outputNodeId = sg.outputNode.id; // typically -20

  // ── 1. Remap inner node IDs ──────────────────────────────────────────────
  const nodeRemap = new Map<number, number>(); // oldInner → newOuter
  for (const inner of sg.nodes) {
    nodeRemap.set(inner.id, nextNodeId++);
  }

  // ── 2. Remap inner link IDs ──────────────────────────────────────────────
  const linkRemap = new Map<number, number>();
  for (const inner of sg.links) {
    linkRemap.set(inner.id, nextLinkId++);
  }

  // ── 3. Build inner link lookup ───────────────────────────────────────────
  const innerLinkById = new Map<number, SubgraphLink>();
  for (const l of sg.links) innerLinkById.set(l.id, l);

  // ── 4. Clone inner nodes with remapped IDs ──────────────────────────────
  const newNodes: UiNode[] = [];
  for (const inner of sg.nodes) {
    const cloned: UiNode = JSON.parse(JSON.stringify(inner));
    cloned.id = nodeRemap.get(inner.id)!;

    // Remap link references in inputs
    if (cloned.inputs) {
      for (const inp of cloned.inputs) {
        if (inp.link != null) {
          inp.link = linkRemap.get(inp.link) ?? inp.link;
        }
      }
    }
    // Remap link references in outputs
    if (cloned.outputs) {
      for (const out of cloned.outputs) {
        if (out.links) {
          out.links = out.links.map((lid) => linkRemap.get(lid) ?? lid);
        }
      }
    }

    newNodes.push(cloned);
  }

  // ── 5. Convert inner links to outer array format ────────────────────────
  // Skip links involving virtual input/output nodes — those get rewired.
  const newLinks: UiLink[] = [];
  for (const il of sg.links) {
    if (il.origin_id === inputNodeId || il.target_id === outputNodeId) continue;
    const newId = linkRemap.get(il.id)!;
    const newSrc = nodeRemap.get(il.origin_id);
    const newTgt = nodeRemap.get(il.target_id);
    if (newSrc == null || newTgt == null) {
      warnings.push(
        `Component "${sg.name}": inner link ${il.id} references unknown node — skipping.`,
      );
      continue;
    }
    newLinks.push([newId, newSrc, il.origin_slot, newTgt, il.target_slot, il.type]);
  }

  // ── 6. Rewire external inputs (outer → component → inner) ──────────────
  // Build outer link map for quick lookup
  const outerLinkMap = new Map<number, UiLink>();
  for (const ol of outerLinks) outerLinkMap.set(ol[0], ol);

  const linksToRemove = new Set<number>(); // outer link IDs to remove
  const linksToAdd: UiLink[] = [];

  if (compNode.inputs) {
    for (let slotIdx = 0; slotIdx < compNode.inputs.length; slotIdx++) {
      const compInput = compNode.inputs[slotIdx];
      if (compInput.link == null) continue;

      const outerLink = outerLinkMap.get(compInput.link);
      if (!outerLink) continue;

      const srcNodeId = outerLink[1];
      const srcSlot = outerLink[2];

      // Find the matching subgraph input by name
      const sgInput = sg.inputs.find((inp) => inp.name === compInput.name);
      if (!sgInput) {
        warnings.push(
          `Component "${sg.name}": could not match input "${compInput.name}" — skipping rewire.`,
        );
        continue;
      }

      // For each inner link from the virtual input node, create a new outer link
      for (const innerLinkId of sgInput.linkIds) {
        const il = innerLinkById.get(innerLinkId);
        if (!il || il.origin_id !== inputNodeId) continue;
        const remappedTarget = nodeRemap.get(il.target_id);
        if (remappedTarget == null) continue;

        const newId = nextLinkId++;
        linksToAdd.push([newId, srcNodeId, srcSlot, remappedTarget, il.target_slot, il.type]);

        // If the external source is ITSELF a component instance (expanded in a
        // later iteration), register this new link on its output slot so its own
        // step-7 output rewiring re-targets it. Without this, an A→B subgraph
        // edge dangles when B expands before A (A's original output link to B was
        // removed here, but the replacement isn't on A's output list).
        const srcNode = outerNodes.find((n) => n.id === srcNodeId);
        const srcOut = srcNode?.outputs?.[srcSlot];
        if (srcOut) (srcOut.links ??= []).push(newId);

        // Update the cloned inner node's input to point to the new link
        const targetNode = newNodes.find((n) => n.id === remappedTarget);
        if (targetNode?.inputs) {
          for (const inp of targetNode.inputs) {
            if (inp.link === linkRemap.get(innerLinkId)) {
              inp.link = newId;
            }
          }
        }
      }

      linksToRemove.add(compInput.link);
    }
  }

  // ── 7. Rewire external outputs (inner → component → outer) ─────────────
  if (compNode.outputs) {
    for (let slotIdx = 0; slotIdx < compNode.outputs.length; slotIdx++) {
      const compOutput = compNode.outputs[slotIdx];
      if (!compOutput.links || compOutput.links.length === 0) continue;

      // Find the matching subgraph output by name
      const sgOutput = sg.outputs.find((out) => out.name === compOutput.name);
      if (!sgOutput) {
        warnings.push(
          `Component "${sg.name}": could not match output "${compOutput.name}" — skipping rewire.`,
        );
        continue;
      }

      // Find the inner node that produces this output
      let innerSrcId: number | null = null;
      let innerSrcSlot = 0;
      for (const innerLinkId of sgOutput.linkIds) {
        const il = innerLinkById.get(innerLinkId);
        if (il && il.target_id === outputNodeId) {
          innerSrcId = il.origin_id;
          innerSrcSlot = il.origin_slot;
          break;
        }
      }
      if (process.env.DEBUG_EXPAND) logger.info(`EXPAND ${sg.name} out '${compOutput.name}' links=${JSON.stringify(compOutput.links)} sgLinkIds=${JSON.stringify(sgOutput.linkIds)} innerSrc=${innerSrcId}`);
      if (innerSrcId == null) continue;
      const remappedSrc = nodeRemap.get(innerSrcId);
      if (remappedSrc == null) continue;

      // Rewire each outer link that consumes this component output
      for (const outerLinkId of compOutput.links) {
        const outerLink = outerLinkMap.get(outerLinkId);
        if (process.env.DEBUG_EXPAND) logger.info(`  rewire link ${outerLinkId}: ${outerLink ? "found -> tgt "+outerLink[3] : "NOT in outerLinkMap"}`);
        if (!outerLink) continue;

        const tgtNodeId = outerLink[3];
        const tgtSlot = outerLink[4];
        const linkType = outerLink[5];

        const newId = nextLinkId++;
        linksToAdd.push([newId, remappedSrc, innerSrcSlot, tgtNodeId, tgtSlot, linkType]);

        // Update the outer target node's input to reference the new link
        const tgtNode = outerNodes.find((n) => n.id === tgtNodeId);
        if (tgtNode?.inputs) {
          for (const inp of tgtNode.inputs) {
            if (inp.link === outerLinkId) {
              inp.link = newId;
            }
          }
        }

        linksToRemove.add(outerLinkId);
      }
    }
  }

  // ── 8. Apply proxy widget values ────────────────────────────────────────
  const proxyWidgets: [string, string][] =
    (compNode.properties?.proxyWidgets as [string, string][]) ?? [];
  const widgetValues = compNode.widgets_values ?? [];

  for (let i = 0; i < proxyWidgets.length; i++) {
    const [innerNodeIdStr, widgetName] = proxyWidgets[i];
    const value = i < widgetValues.length ? widgetValues[i] : undefined;
    if (value === undefined || value === null) continue;

    const innerNodeIdNum = Number(innerNodeIdStr);
    const remapped = nodeRemap.get(innerNodeIdNum);
    if (remapped == null) continue;

    const targetNode = newNodes.find((n) => n.id === remapped);
    if (!targetNode) continue;

    // Find the widget position in widgets_values by counting widget-type inputs
    const widgetIdx = findWidgetIndex(targetNode, widgetName);
    if (widgetIdx != null) {
      if (!targetNode.widgets_values) targetNode.widgets_values = [];
      targetNode.widgets_values[widgetIdx] = value;
    }
  }

  // ── 9. Resolve virtual PrimitiveNode nodes inside the subgraph ──────────
  // The legacy virtual "PrimitiveNode" produces a widget value but isn't a real
  // executable node, so bake its value onto the target's widgets_values. The
  // typed primitives (PrimitiveInt/Float/Boolean/String) ARE real nodes that
  // output a value — leave them as link sources so the main converter maps them
  // by name (baking them by widget index mis-positions V3 nested inputs like
  // "resize_type.width", which aren't 1:1 with the inputs[] widget order).
  const PRIMITIVE_TYPES = new Set(["PrimitiveNode", "CustomCombo"]);
  const primitiveNodeIds = new Set(
    newNodes.filter((n) => PRIMITIVE_TYPES.has(n.type)).map((n) => n.id),
  );
  if (primitiveNodeIds.size > 0) {
    // For each new link FROM a primitive node, set the value on the target
    for (const link of newLinks) {
      const [, srcId, , tgtId, tgtSlot] = link;
      if (!primitiveNodeIds.has(srcId)) continue;

      const primNode = newNodes.find((n) => n.id === srcId);
      const tgtNode = newNodes.find((n) => n.id === tgtId);
      if (!primNode || !tgtNode) continue;

      const primValue =
        primNode.widgets_values && primNode.widgets_values.length > 0
          ? primNode.widgets_values[0]
          : undefined;
      if (primValue === undefined) continue;

      // Find the target input at tgtSlot that has a widget
      if (tgtNode.inputs) {
        const tgtInput = tgtNode.inputs.find(
          (inp) => inp.link === link[0] && inp.widget,
        );
        if (tgtInput) {
          const idx = findWidgetIndex(tgtNode, tgtInput.widget!.name);
          if (idx != null) {
            if (!tgtNode.widgets_values) tgtNode.widgets_values = [];
            tgtNode.widgets_values[idx] = primValue;
          }
          // Clear the link so the main converter treats this as a widget value
          tgtInput.link = null;
        }
      }
    }
  }

  // ── 10. Assemble result ─────────────────────────────────────────────────
  const resultNodes = [
    ...outerNodes.filter((n) => n.id !== compNode.id),
    ...newNodes,
  ];
  const resultLinks = [
    ...outerLinks.filter((l) => !linksToRemove.has(l[0])),
    ...newLinks,
    ...linksToAdd,
  ];

  return {
    nodes: resultNodes,
    links: resultLinks,
    nextNodeId,
    nextLinkId,
    warnings,
  };
}

/**
 * Find the widgets_values index for a named widget on a UI node.
 * Counts widget-type inputs (those with a `widget` property) in order.
 */
function findWidgetIndex(node: UiNode, widgetName: string): number | null {
  if (!node.inputs) return null;

  // Widget inputs on a UiNode are entries in `inputs[]` that have a `widget` property.
  // However, not all widgets appear in `inputs[]` — some are only in `widgets_values`.
  // We count only the widget-inputs that appear in the node's inputs array,
  // matching by the `widget.name` field.
  let idx = 0;
  for (const inp of node.inputs) {
    if (inp.widget) {
      if (inp.widget.name === widgetName) return idx;
      idx++;
    }
  }

  // Fallback: if widget is not in inputs[] (pure widget, no link slot),
  // it may be at a fixed position. Search widgets_values if we can match by name.
  // For now, return null — the widget is likely at its default value.
  return null;
}

// ── API → UI conversion ─────────────────────────────────────────────────────

/**
 * Detect an API-format workflow: a non-empty record whose every value is a
 * node object with a string `class_type`. (`inputs` may be absent on
 * degenerate nodes; class_type is the discriminator.)
 */
export function isApiFormat(obj: unknown): obj is WorkflowJSON {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const values = Object.values(obj as Record<string, unknown>);
  if (values.length === 0) return false;
  return values.every(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      typeof (v as { class_type?: unknown }).class_type === "string",
  );
}

/** An API-format connection reference: ["<nodeId>", <outputSlot>]. Graph-aware:
 *  only counts as a link when the first element names an existing node, so
 *  array-valued widgets like [1024, 1024] are not misclassified. Exported for
 *  run_template's override validation. */
export function isLinkRef(v: unknown, nodeKeys: Set<string>): v is [string | number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number" &&
    nodeKeys.has(String(v[0]))
  );
}

/** The UI slot `type` string for a widget input spec. */
function widgetSlotType(spec: NodeInputSpec): string {
  const t = spec[0];
  if (Array.isArray(t)) return "COMBO";
  const wt = (spec[1] as { widgetType?: unknown } | undefined)?.widgetType;
  if (typeof wt === "string") return wt;
  // Combined type like "FLOAT,INT" → the first member is the concrete slot type.
  if (typeof t === "string" && t.includes(",")) return t.split(",")[0].trim();
  return t;
}

/**
 * A sensible widgets_values entry for a widget the API graph didn't provide:
 * the spec default, else the first combo option, else a type-appropriate zero.
 * Used both for omitted widgets (ComfyUI would apply the same default) and as
 * the positional placeholder under a link-fed widget input.
 */
function widgetDefaultValue(spec: NodeInputSpec): unknown {
  const [type, cfg] = spec;
  const c = cfg as
    | { default?: unknown; options?: Array<{ key?: unknown } | string> }
    | undefined;
  if (c?.default !== undefined) return c.default;
  if (Array.isArray(type)) return type[0];
  if (Array.isArray(c?.options)) {
    const first = c.options[0];
    return typeof first === "object" && first !== null ? first.key : first;
  }
  switch (type) {
    case "INT":
    case "FLOAT":
      return 0;
    case "STRING":
      return "";
    case "BOOLEAN":
      return false;
    default:
      return undefined;
  }
}

interface PendingLink {
  srcKey: string;
  srcSlot: number;
  tgtKey: string;
  tgtSlotIdx: number;
  expectedType: string;
}

/**
 * Convert an API-format workflow to UI (canvas) format with a generated
 * layout. The inverse of convertUiToApi for well-formed graphs:
 * `convertUiToApi(convertApiToUi(x).workflow)` reproduces `x` (modulo layout,
 * string-normalized link refs, and filled-in defaults for omitted widgets —
 * both deliberate: the canvas itself materializes every widget when queueing).
 * One knowing asymmetry: `_meta.mode` muted/bypassed becomes UI mode 2/4 and
 * the node is PRESERVED on canvas, but convertUiToApi excludes mode-2/4 nodes
 * from the executable prompt (correct queue semantics), so those nodes don't
 * survive a UI→API round-trip.
 *
 * objectInfo is definitional: widget ORDER in widgets_values comes from
 * input_order (the same order convertUiToApi consumes), including the phantom
 * control_after_generate slot after seed-type widgets and V3 dynamic-combo
 * nested values ("combo.nested" dotted keys) after their combo.
 */
export function convertApiToUi(
  api: WorkflowJSON,
  objectInfo: ObjectInfo,
): { workflow: UiWorkflow; warnings: string[] } {
  const warnings: string[] = [];
  const keys = Object.keys(api);
  const keySet = new Set(keys);

  // Numeric node ids; non-numeric API keys (rare, hand-written) get remapped,
  // as does a key whose numeric value another key already claimed ("1" vs
  // "01" both Number() to 1 — duplicate node ids would corrupt the canvas).
  let maxId = 0;
  for (const k of keys) {
    const n = Number(k);
    if (Number.isInteger(n) && n > 0) maxId = Math.max(maxId, n);
  }
  const idFor = new Map<string, number>();
  const usedIds = new Set<number>();
  for (const k of keys) {
    const n = Number(k);
    if (Number.isInteger(n) && n > 0 && !usedIds.has(n)) {
      idFor.set(k, n);
      usedIds.add(n);
    } else {
      idFor.set(k, ++maxId);
      usedIds.add(maxId);
      warnings.push(
        `Node key "${k}" is not a usable unique positive integer — remapped to id ${maxId} (connections preserved).`,
      );
    }
  }

  const uiNodes = new Map<string, UiNode>();
  const pending: PendingLink[] = [];

  for (const key of keys) {
    const apiNode = api[key];
    const classType = apiNode.class_type;
    const apiInputs = (apiNode.inputs ?? {}) as Record<string, unknown>;
    const def = objectInfo[classType];
    const id = idFor.get(key)!;

    const uiInputs: UiNodeInput[] = [];
    const widgetsValues: unknown[] = [];
    const consumed = new Set<string>();

    if (!def) {
      // Best-effort: keep connections; carry literals as positional widgets in
      // key order. convertUiToApi will skip this node too (same warning), so
      // the graph degrades symmetrically instead of silently losing wiring.
      warnings.push(
        `Node ${key} (${classType}): not found in object_info — custom node may not be installed. Slot layout is best-effort.`,
      );
      for (const [name, val] of Object.entries(apiInputs)) {
        if (isLinkRef(val, keySet)) {
          uiInputs.push({ name, type: "*", link: null });
          pending.push({
            srcKey: String(val[0]),
            srcSlot: val[1],
            tgtKey: key,
            tgtSlotIdx: uiInputs.length - 1,
            expectedType: "*",
          });
        } else {
          widgetsValues.push(val);
        }
      }
    } else {
      const orderedNames = getOrderedInputNames(def);
      for (const name of orderedNames) {
        const spec = def.input.required?.[name] ?? def.input.optional?.[name];
        if (!spec) continue;
        consumed.add(name);
        const raw = apiInputs[name];

        if (isWidgetInput(name, def)) {
          // A widget input fed by a link is a "converted widget" in the UI:
          // an inputs[] slot carrying widget:{name}, with a positional
          // placeholder kept in widgets_values so downstream widget indices
          // stay aligned (convertUiToApi assigns the placeholder, then the
          // link overrides it by name).
          let effective: unknown;
          if (isLinkRef(raw, keySet)) {
            effective = widgetDefaultValue(spec);
            uiInputs.push({
              name,
              type: widgetSlotType(spec),
              link: null,
              widget: { name },
            });
            pending.push({
              srcKey: String(raw[0]),
              srcSlot: raw[1],
              tgtKey: key,
              tgtSlotIdx: uiInputs.length - 1,
              expectedType: widgetSlotType(spec),
            });
          } else {
            effective = raw !== undefined ? raw : widgetDefaultValue(spec);
          }
          widgetsValues.push(effective);

          // Phantom "fixed"/"randomize" widget after control_after_generate
          // seeds — convertUiToApi skips exactly one entry here.
          if (hasControlAfterGenerate(name, def)) widgetsValues.push("fixed");

          // V3 dynamic combo: the selected option's nested POSITIONAL widgets
          // follow the combo value in widgets_values; their API values arrive
          // as dotted "combo.nested" keys.
          const opts = (
            spec[1] as
              | { options?: Array<{ key?: unknown; inputs?: { required?: Record<string, unknown> } }> }
              | undefined
          )?.options;
          const nested = Array.isArray(opts)
            ? opts.find((o) => o?.key === effective)?.inputs?.required
            : undefined;
          if (nested) {
            for (const [nName, nSpec] of Object.entries(nested)) {
              if (!isPositionalWidgetSpec(nSpec)) continue;
              const dotted = `${name}.${nName}`;
              consumed.add(dotted);
              const nRaw = apiInputs[dotted];
              widgetsValues.push(
                nRaw !== undefined ? nRaw : widgetDefaultValue(nSpec as NodeInputSpec),
              );
            }
          }
        } else {
          // Link (connection) input — always present as a slot, wired or not.
          const slotType = typeof spec[0] === "string" ? spec[0] : "COMBO";
          uiInputs.push({ name, type: slotType, link: null });
          if (isLinkRef(raw, keySet)) {
            pending.push({
              srcKey: String(raw[0]),
              srcSlot: raw[1],
              tgtKey: key,
              tgtSlotIdx: uiInputs.length - 1,
              expectedType: slotType,
            });
          } else if (raw !== undefined) {
            warnings.push(
              `Node ${key} (${classType}): input "${name}" expects a connection but got a literal value — dropped (wire it or use a Primitive node).`,
            );
          }
        }
      }

      // rgthree Power Lora Loader: loras arrive as lora_1..lora_N input objects
      // (the shape convertUiToApi emits); in the UI they live in widgets_values.
      if (/Power Lora Loader/.test(classType)) {
        const loraKeys = Object.keys(apiInputs)
          .filter((k) => /^lora_\d+$/.test(k))
          .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
        for (const lk of loraKeys) {
          consumed.add(lk);
          const v = apiInputs[lk];
          if (v && typeof v === "object" && !Array.isArray(v)) widgetsValues.push(v);
        }
      }

      // Anything left is either a stray link (wire it anyway, extra slot) or a
      // literal on an input the node definition doesn't declare (warn — it
      // would be silently lost on a UI round-trip).
      for (const [name, val] of Object.entries(apiInputs)) {
        if (consumed.has(name)) continue;
        if (isLinkRef(val, keySet)) {
          uiInputs.push({ name, type: "*", link: null });
          pending.push({
            srcKey: String(val[0]),
            srcSlot: val[1],
            tgtKey: key,
            tgtSlotIdx: uiInputs.length - 1,
            expectedType: "*",
          });
        } else {
          warnings.push(
            `Node ${key} (${classType}): input "${name}" is not declared by the node definition — value carried nowhere in UI format and will not round-trip.`,
          );
        }
      }
    }

    // Output slots straight from the definition. (COMBO outputs appear as
    // option arrays in some defs — normalize to a "COMBO" slot type.)
    const outputs: UiNodeOutput[] = ((def?.output ?? []) as unknown[]).map((t, i) => ({
      name: def?.output_name?.[i] ?? (typeof t === "string" ? t : "COMBO"),
      type: typeof t === "string" ? t : "COMBO",
      links: [],
    }));

    const meta = apiNode._meta as { title?: string; mode?: string } | undefined;
    const mode = meta?.mode === "muted" ? 2 : meta?.mode === "bypassed" ? 4 : 0;

    const uiNode: UiNode = {
      id,
      type: classType,
      pos: [0, 0],
      size: [280, 100], // finalized by the layout pass
      flags: {},
      order: 0,
      mode,
      inputs: uiInputs,
      outputs,
      properties: { "Node name for S&R": classType },
      widgets_values: widgetsValues,
    };
    if (meta?.title && meta.title !== classType) uiNode.title = meta.title;
    uiNodes.set(key, uiNode);
  }

  // ── Materialize links ────────────────────────────────────────────────────
  const links: UiLink[] = [];
  let lastLinkId = 0;
  for (const p of pending) {
    const src = uiNodes.get(p.srcKey);
    const tgt = uiNodes.get(p.tgtKey)!;
    if (!src) continue; // ref to a key we never materialized (can't happen: keySet-gated)
    // Ensure the source has a slot at srcSlot even if its def was unknown.
    while ((src.outputs ??= []).length <= p.srcSlot) {
      src.outputs.push({ name: `out_${src.outputs.length}`, type: "*", links: [] });
    }
    const srcOut = src.outputs[p.srcSlot];
    const linkType = srcOut.type !== "*" ? srcOut.type : p.expectedType;
    const linkId = ++lastLinkId;
    (srcOut.links ??= []).push(linkId);
    tgt.inputs![p.tgtSlotIdx].link = linkId;
    links.push([linkId, src.id, p.srcSlot, tgt.id, p.tgtSlotIdx, linkType]);
  }

  // ── Generated layout: topological layers, left → right ──────────────────
  const layerByKey = new Map<string, number>(keys.map((k) => [k, 0]));
  const edges = pending
    .map((p) => [p.srcKey, p.tgtKey] as const)
    .filter(([s, t]) => s !== t);
  // Bounded relaxation — cycle-safe and plenty for real graph depths.
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const [s, t] of edges) {
      const want = layerByKey.get(s)! + 1;
      if (want > layerByKey.get(t)!) {
        layerByKey.set(t, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const byLayer = new Map<number, string[]>();
  for (const k of keys) {
    const l = layerByKey.get(k)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(k);
  }
  const X_START = 40;
  const X_STEP = 380;
  const Y_START = 60;
  const Y_GAP = 60;
  let order = 0;
  for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
    let y = Y_START;
    for (const k of byLayer.get(layer)!) {
      const n = uiNodes.get(k)!;
      const slots = Math.max(n.inputs?.length ?? 0, n.outputs?.length ?? 0);
      const widgets = Array.isArray(n.widgets_values) ? n.widgets_values.length : 0;
      const height = Math.max(60, 36 + 22 * slots + 26 * widgets);
      n.pos = [X_START + layer * X_STEP, y];
      n.size = [280, height];
      n.order = order++;
      y += height + Y_GAP;
    }
  }

  const nodes = keys.map((k) => uiNodes.get(k)!);
  const workflow: UiWorkflow = {
    last_node_id: Math.max(0, ...nodes.map((n) => n.id)),
    last_link_id: lastLinkId,
    nodes,
    links,
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  };

  logger.info(
    `Converted API workflow to UI format: ${nodes.length} nodes, ${links.length} links`,
  );
  return { workflow, warnings };
}

/**
 * Convert a ComfyUI UI-format workflow to API format.
 * Requires objectInfo from /object_info to map widgets_values to named inputs.
 */
export function convertUiToApi(
  ui: UiWorkflow,
  objectInfo: ObjectInfo,
): ConversionResult {
  // Clone (don't mutate the caller's workflow), strip the wiring virtuals
  // (Get/Set bus + Reroute) so the expander + converter only see real links,
  // then expand component/subgraph nodes.
  const cleaned = structuredClone(ui);
  deVirtualize(cleaned);
  const { expanded, warnings: expandWarnings } = expandComponents(cleaned);

  const workflow: WorkflowJSON = {};
  const warnings: string[] = [...expandWarnings];

  // Build link lookup: linkId → LinkInfo
  const linkMap = new Map<number, LinkInfo>();
  for (const link of expanded.links) {
    if (!Array.isArray(link) || link.length < 6) continue;
    const [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, typeName] =
      link as UiLink;
    linkMap.set(linkId, {
      sourceNodeId,
      sourceSlot,
      targetNodeId,
      targetSlot,
      typeName,
    });
  }

  // Node types that are purely visual/internal and have no API equivalent
  const SKIP_TYPES = new Set(["Reroute", "Note", "PrimitiveNode", "MarkdownNote"]);

  // Get/Set node types that need special handling (not in object_info)
  const GET_SET_TYPES = new Set([
    "GetNode", "SetNode", "PRO_GetNode", "PRO_SetNode",
    "SetNode_GetNode", "SetNode_SetNode",
  ]);

  const nodesById = new Map(expanded.nodes.map((n) => [n.id, n]));

  const isGetType = (t: string) => GET_SET_TYPES.has(t) && /get/i.test(t);
  const isSetType = (t: string) =>
    GET_SET_TYPES.has(t) && /set/i.test(t) && !/get/i.test(t);

  // bus name (SetNode "Constant") -> the link feeding that SetNode's value input
  const busSource = new Map<string, number>();
  for (const n of expanded.nodes) {
    if (!isSetType(n.type)) continue;
    const bus = busKey(n.widgets_values);
    const inp = (n.inputs ?? []).find((i) => i.link != null);
    if (bus != null && inp?.link != null) busSource.set(String(bus), inp.link);
  }

  // Resolve a UI input link to a live [nodeId, slot], mirroring ComfyUI's
  // graphToPrompt: virtual Get/Set bus nodes are resolved through to the real
  // source; muted (mode 2) sources drop the connection; bypassed (mode 4)
  // sources pass through — the consumer reconnects to the bypassed node's input
  // whose type matches the requested output slot (same index first, then any
  // type match), recursing through chains of bypassed/virtual nodes.
  const resolveSource = (
    linkId: number,
    depth = 0,
  ): { id: string; slot: number } | null => {
    if (depth > 100) return null;
    const link = linkMap.get(linkId);
    if (!link) return null;
    const src = nodesById.get(link.sourceNodeId);
    if (!src) {
      return { id: String(link.sourceNodeId), slot: link.sourceSlot };
    }
    // Virtual GetNode: follow the bus to the SetNode that wrote it.
    if (isGetType(src.type)) {
      const bus = busKey(src.widgets_values);
      const setLink = bus != null ? busSource.get(String(bus)) : undefined;
      return setLink != null ? resolveSource(setLink, depth + 1) : null;
    }
    // Virtual SetNode passthrough: follow its value input.
    if (isSetType(src.type)) {
      const inp = (src.inputs ?? []).find((i) => i.link != null);
      return inp?.link != null ? resolveSource(inp.link, depth + 1) : null;
    }
    // Reroute passthrough: a virtual node that just forwards its single input to
    // all outputs — follow its input link to the real source.
    if (src.type === "Reroute") {
      const inp = (src.inputs ?? []).find((i) => i.link != null);
      return inp?.link != null ? resolveSource(inp.link, depth + 1) : null;
    }
    const mode = src.mode ?? 0;
    if (mode === 0) {
      return { id: String(link.sourceNodeId), slot: link.sourceSlot };
    }
    if (mode === 2) return null; // muted: connection dropped
    if (mode === 4) {
      // bypass: find a matching-type input to pass through
      const outType = link.typeName;
      const inputs = src.inputs ?? [];
      let cand: (typeof inputs)[number] | undefined = inputs[link.sourceSlot];
      if (!cand || cand.link == null || (outType && cand.type !== outType)) {
        cand = inputs.find(
          (i) => i.link != null && (!outType || i.type === outType),
        );
      }
      if (!cand || cand.link == null) return null;
      return resolveSource(cand.link, depth + 1);
    }
    return null;
  };

  for (const node of expanded.nodes) {
    // Muted (2) and bypassed (4) nodes are excluded from the prompt entirely;
    // their downstream connections are rewired via resolveSource above.
    if (node.mode === 2 || node.mode === 4) continue;

    const nodeId = String(node.id);
    const classType = node.type;

    // Skip internal litegraph node types
    if (SKIP_TYPES.has(classType)) continue;

    // Virtual Get/Set bus nodes are not real ComfyUI nodes (not in object_info
    // and rejected by /prompt). Drop them — resolveSource rewires consumers
    // straight through the bus to the real upstream source.
    if (GET_SET_TYPES.has(classType)) continue;

    const def = objectInfo[classType];
    if (!def) {
      warnings.push(
        `Node ${nodeId} (${classType}): not found in object_info — custom node may not be installed. Skipping.`,
      );
      continue;
    }

    const inputs: Record<string, unknown> = {};

    // Get ordered input names and figure out which are widgets vs links
    const orderedNames = getOrderedInputNames(def);
    const widgetNames: string[] = [];
    for (const name of orderedNames) {
      if (isWidgetInput(name, def)) {
        widgetNames.push(name);
      }
    }

    // Nested widgets that have been "converted to input" (linked) carry NO
    // positional widgets_values slot — their value arrives via the link, not the
    // saved array — so consuming a slot for them would steal the next widget's
    // value and mis-align the whole tail. Track the linked (dotted) input names
    // to skip their positional consumption below.
    const linkedInputNames = new Set(
      (node.inputs ?? [])
        .filter((i) => i.link != null)
        .map((i) => i.name),
    );

    // Map widgets_values to named widget inputs.
    // Some INT inputs with "control_after_generate": true (like seed, noise_seed) have
    // a phantom widget value in widgets_values ("fixed"/"randomize"/"increment"/"decrement")
    // that doesn't correspond to any named input — we must skip those.
    const widgetValues = node.widgets_values ?? [];

    // Some nodes (e.g. VHS_VideoCombine) store widgets_values as a name->value
    // object instead of a positional array — as does the #384 live-canvas
    // fallback (graph_get_state keys every widget by name). Map those by name
    // directly; no positional drift means the values are authoritative (no
    // combo-validity re-resolution or phantom control_after_generate slot needed).
    if (!Array.isArray(widgetValues)) {
      const wv = widgetValues as Record<string, unknown>;

      // Resolve a top-level dynamic combo's SELECTED-option nested inputs (merged
      // required + optional — an asset selector may live under `optional`, and
      // reading only `required` would drop it, regressing #504/#407). Mirrors the
      // positional branch's nested lookup.
      const nestedFor = (name: string): Record<string, unknown> | undefined => {
        const spec =
          (def.input?.required as Record<string, unknown>)?.[name] ??
          (def.input?.optional as Record<string, unknown>)?.[name];
        const opts = (
          Array.isArray(spec)
            ? (spec[1] as {
                options?: Array<{
                  key?: unknown;
                  inputs?: {
                    required?: Record<string, unknown>;
                    optional?: Record<string, unknown>;
                  };
                }>;
              })
            : undefined
        )?.options;
        const selInputs = Array.isArray(opts)
          ? opts.find((o) => o?.key === wv[name])?.inputs
          : undefined;
        return selInputs && (selInputs.required || selInputs.optional)
          ? { ...selInputs.required, ...selInputs.optional }
          : undefined;
      };

      // A name-keyed capture (the #384 graph_get_state fallback, or a natively
      // name-keyed widgets_values) stores EVERY widget in ONE FLAT name→value map.
      // That is only authoritative when names are GLOBALLY UNIQUE. When more than
      // one control claims the SAME flat slot — two dynamic-combo parents each with
      // a nested "strength", OR a nested "strength" shadowing a top-level widget
      // "strength" — the single stored value can't be attributed to ANY of them, so
      // reading by leaf name would silently push one control's value onto another
      // (the #504/#499 wrong-value bug class). A control claims the flat slot L when
      // it needs L and the capture did NOT parent-qualify it ("first.strength"); a
      // PARENT-QUALIFIED key is always unambiguous and consumes its own slot, never
      // the flat one. Count the claimants of each flat slot up front so the emit
      // loop can FAIL CLOSED — refuse EVERY control competing for an over-subscribed
      // slot (top-level AND nested), leaving each to its node default — rather than
      // trust a value that might belong to a different control.
      const nestedByParent = new Map<string, Record<string, unknown>>();
      for (const name of widgetNames) {
        const nested = nestedFor(name);
        if (nested) nestedByParent.set(name, nested);
      }
      // flat-slot claimant count, keyed by leaf name.
      const flatClaimants = new Map<string, number>();
      const claimFlat = (leaf: string) =>
        flatClaimants.set(leaf, (flatClaimants.get(leaf) ?? 0) + 1);
      for (const name of widgetNames) {
        if (name in wv) claimFlat(name); // top-level widget claims its own flat slot
      }
      for (const [parent, nested] of nestedByParent) {
        for (const [nName, nSpec] of Object.entries(nested)) {
          if (!isPositionalWidgetSpec(nSpec)) continue;
          // a nested leaf claims the flat slot only when it FALLS BACK to it
          // (no parent-qualified key present in the capture).
          if (`${parent}.${nName}` in wv) continue;
          if (nName in wv) claimFlat(nName);
        }
      }
      const flatAmbiguous = (leaf: string) => (flatClaimants.get(leaf) ?? 0) > 1;
      const ambiguityWarning = (target: string, leaf: string) =>
        `Node ${nodeId} (${classType}): widget "${target}" could not be resolved from the name-keyed capture because the flat slot "${leaf}" is claimed by more than one control (multiple dynamic-combo nested leaves of the same name, or a nested leaf shadowing a top-level widget), so the single stored value can't be attributed to the right control. Left to the node default rather than risk assigning another control's value. Re-capture with a panel that emits parent-qualified widget names, or pass pack/path/graph.`;

      for (const name of widgetNames) {
        if (name in wv) {
          // A top-level widget whose flat slot is over-subscribed (a nested leaf of
          // the same name also falls back to it) is itself ambiguous — the stored
          // value might be the nested control's — so refuse it too, don't trust it.
          if (flatAmbiguous(name)) {
            warnings.push(ambiguityWarning(name, name));
          } else {
            inputs[name] = validateComboWidgetValue(
              name,
              wv[name],
              def,
              classType,
              nodeId,
              warnings,
            );
          }
        }

        // V3 dynamic-combo nested inputs: the selected option adds required
        // sub-inputs whose live values are ALSO keyed in wv. Emit them as
        // "<combo>.<nested>" so the prompt matches the array-branch shape (ComfyUI
        // rebuilds the nested dict from these dotted keys). Each nested leaf is
        // validated against ITS OWN spec/name (mirrors the array branch — don't
        // regress #504/#407 asset preservation for nested combos).
        const nested = nestedByParent.get(name);
        if (nested) {
          for (const [nName, nSpec] of Object.entries(nested)) {
            if (!isPositionalWidgetSpec(nSpec)) continue;
            const qualified = `${name}.${nName}`;
            // Preferred: the capture already parent-qualified the key — unambiguous.
            if (qualified in wv) {
              inputs[qualified] = validateComboValueForSpec(
                nName,
                wv[qualified],
                nSpec,
                classType,
                nodeId,
                warnings,
              );
              continue;
            }
            if (!(nName in wv)) continue;
            // Flat leaf: safe ONLY when it is the SOLE claimant of that flat slot.
            if (flatAmbiguous(nName)) {
              warnings.push(ambiguityWarning(qualified, nName));
              continue;
            }
            inputs[qualified] = validateComboValueForSpec(
              nName,
              wv[nName],
              nSpec,
              classType,
              nodeId,
              warnings,
            );
          }
        }
      }
    } else {
    let widgetIdx = 0;
    // A still-valid dynamic-combo option whose NESTED arity DRIFTED between save
    // and load (the option kept its key but added/removed nested inputs) can't be
    // detected up front — its saved nested slots were serialized against the OLD
    // arity, but we map using the CURRENT one, so any drift shifts the trailing
    // top-level widgets (e.g. a since-removed nested "multiplier" leaves its stale
    // value to land on the seed). The stale-parent guard below only catches a
    // REMOVED option (key absent). For a still-present option, a LEFTOVER saved
    // value after the whole positional mapping is the reliable drift signal — a
    // self-consistent layout consumes exactly. Track whether a still-valid dynamic
    // combo was processed and which widgets were mapped AFTER it, so on leftover we
    // can default those (shifted) widgets + warn instead of trusting the shift.
    let sawDynamicCombo = false;
    // Set when ANY combo hits a refusal (stale/empty-options parent, or a linked-
    // nested leaf). A refusal INTENTIONALLY stops mapping and leaves the tail
    // unconsumed, so the leftover it creates is EXPECTED — it does NOT prove that an
    // EARLIER combo drifted. Positionally, a valid layout ([first, first.note,
    // count, second→refuse]) and a drifted one are IDENTICAL once a refusal is
    // present, so acting on that leftover would DELETE valid earlier values (a real
    // regression). Therefore a refusal suppresses the leftover drift guard entirely
    // for this node; the drift guard fires only on a leftover with NO refusal, where
    // it unambiguously means the arity shrank.
    let refusalOccurred = false;
    const widgetsAfterDynamicCombo: string[] = [];
    // Dotted "<combo>.<leaf>" keys assigned positionally from a dynamic combo's
    // nested layout. On a proven arity drift (leftover) these are ALSO suspect — a
    // since-removed nested slot shifts every later nested value onto the wrong leaf
    // (old A=[obsolete, strength], current A=[strength], saved ["A",4,0.75] maps
    // strength=4, the obsolete value) — so the drift guard defaults them too, not
    // just the trailing top-level widgets.
    const nestedKeysFromDynamic: string[] = [];
    for (let nameIdx = 0; nameIdx < widgetNames.length; nameIdx++) {
      const name = widgetNames[nameIdx];
      if (widgetIdx >= widgetValues.length) break;
      // A widget mapped AFTER a still-valid dynamic combo is positionally
      // downstream of its (unverifiable) nested arity — record it for the
      // drift-leftover check below.
      if (sawDynamicCombo) widgetsAfterDynamicCombo.push(name);
      const value = widgetValues[widgetIdx];
      inputs[name] = value;
      widgetIdx++;

      // If this input has control_after_generate, skip the next widgets_values entry
      if (hasControlAfterGenerate(name, def) && widgetIdx < widgetValues.length) {
        widgetIdx++;
      }

      // V3 dynamic combo: the selected option adds nested required inputs whose
      // values follow in widgets_values (e.g. method="rcas" -> strength=0.55).
      const spec =
        (def.input?.required as Record<string, unknown>)?.[name] ??
        (def.input?.optional as Record<string, unknown>)?.[name];

      // Classic combo widget: if the saved value isn't one of the valid options
      // (a stale UI-helper combo like Impact's "Select to add Wildcard", or a
      // value from a node version with different options), fall back to the
      // default first option — UNLESS it's a genuine asset/upload selector, which
      // we preserve + warn (#407/#504). See validateComboWidgetValue for the full
      // classification (model-loader names + (classType,input) loader allowlist +
      // object_info upload flag — NOT a global name/extension heuristic).
      inputs[name] = validateComboWidgetValue(
        name,
        value,
        def,
        classType,
        nodeId,
        warnings,
      );

      const opts = (
        Array.isArray(spec)
          ? (spec[1] as {
              options?: Array<{
                key?: unknown;
                inputs?: {
                  required?: Record<string, unknown>;
                  optional?: Record<string, unknown>;
                };
              }>;
            })
          : undefined
      )?.options;
      // A V3 option's nested widgets can live under required OR optional; both
      // occupy positional widgets_values slots in serialization order (required
      // then optional). Merging them keeps the positional index aligned AND
      // ensures every nested leaf is validated — reading only `required` would
      // skip an optional leaf and mis-position every later widget.
      //
      // Look up the option by the RAW saved `value` (the selection the array was
      // serialized against), NOT the post-validation inputs[name]. If the saved
      // selection is stale (its option was removed/renamed), its ORIGINAL nested
      // arity is unrecoverable, so consuming zero nested slots while still
      // advancing the top-level index would silently misassign a leftover nested
      // value onto the trailing top-level widgets (e.g. a removed option's nested
      // strength overwriting the user's seed). The stale-parent guard below REFUSES
      // that case (warn + stop) instead of guessing.
      // A V3 dynamic combo must be identified by its EXPLICIT type string
      // (spec[0] === "COMFY_DYNAMICCOMBO_V3"), NOT by whether its current options
      // list happens to contain keyed objects. An EMPTY current options list
      // (["COMFY_DYNAMICCOMBO_V3", {options: []}]) has NO keyed entries, so the
      // object-key heuristic alone reports false and the stale-parent guard below
      // never fires — re-opening the exact silent-positional-shift hole: with an
      // empty options list every saved selection is stale, and consuming zero
      // nested slots while advancing the top-level index misassigns a leftover
      // nested value (e.g. a removed option's strength=0.75) onto the next widget
      // (e.g. a seed). Keying off the type covers the empty-options case too.
      //
      // The object-key heuristic is retained as a fallback for any V3 dynamic list
      // that carries keyed {key, inputs} entries without the literal type marker.
      // A classic string-option COMBO (spec[0] is the ["a","b"] options array, not
      // the "COMFY_DYNAMICCOMBO_V3" string) matches NEITHER branch, so it must NOT
      // trip the stale-parent guard below (which would wrongly refuse a perfectly
      // valid classic-combo value).
      const specType = Array.isArray(spec) ? spec[0] : undefined;
      const isDynamicComboType = specType === "COMFY_DYNAMICCOMBO_V3";
      const isDynamicOptions =
        isDynamicComboType ||
        (Array.isArray(opts) &&
          opts.some(
            (o) =>
              o != null &&
              typeof o === "object" &&
              !Array.isArray(o) &&
              "key" in (o as Record<string, unknown>),
          ));
      const savedOption = Array.isArray(opts)
        ? opts.find((o) => o?.key === value)
        : undefined;

      // P0 (#517): STALE dynamic-combo parent. The saved selection is NOT among
      // the current dynamic options (the option was removed/renamed, or was
      // substituted above). The saved array was serialized against the OLD
      // option's layout: [parent, <OLD option's nested slots>, ...trailing
      // top-level widgets...]. The OLD nested arity is unknowable from THIS schema,
      // so the pre-fix code consumed ZERO nested slots while still advancing the
      // top-level index — silently mapping a leftover stale nested value onto the
      // next widget (e.g. a removed option's strength=0.75 landing on the user's
      // seed, discarding the real 42 with no warning).
      //
      // The saved array was serialized as
      //   [parent, <removed option's nested slots>, ...trailing top-level widgets...]
      // and we CANNOT reconstruct where the orphaned-nested block ends: NEITHER the
      // removed option's nested arity NOR the trailing widgets' saved-slot count is
      // recoverable. The trailing count is doubly unknown — a nested seed carries a
      // variable control_after_generate phantom, a trailing dynamic combo adds a
      // value-dependent number of slots, AND the current schema may have added or
      // removed trailing widgets since the graph was saved. A surplus arithmetic
      // (values-left vs current trailing-widget-count) silently mis-attributes
      // orphaned slots whenever any of those drift (e.g. a schema-added trailing
      // widget makes surplus cancel to zero while an orphan still sits before the
      // seed). Because NO positional reconstruction is provably safe, REFUSE: warn
      // and stop positional mapping here so an orphaned nested value can NEVER be
      // silently mapped onto a later top-level widget (such as a seed). The
      // remaining required inputs then default-fill below. The parent itself was
      // already substituted + warned via validateComboWidgetValue above.
      if (
        isDynamicOptions &&
        savedOption === undefined &&
        widgetIdx < widgetValues.length
      ) {
        warnings.push(
          `Node ${nodeId} (${classType}): widget "${name}" saved selection "${String(
            value,
          )}" is no longer an available option, so the removed option's nested-input layout can't be reconstructed. The remaining ${
            widgetValues.length - widgetIdx
          } saved widget value(s) are left to their defaults rather than risk silently assigning a stale nested value to a later widget (such as a seed).`,
        );
        // A refusal's leftover is expected and can't be attributed to earlier drift,
        // so suppress the drift guard for this node (see refusalOccurred note).
        refusalOccurred = true;
        break;
      }

      // Still-valid dynamic combo (option key present): its nested arity is trusted
      // from the CURRENT schema but can't be verified against the save — flag it so
      // the post-loop leftover check can detect a drift-induced tail shift.
      if (isDynamicOptions && savedOption !== undefined) sawDynamicCombo = true;

      const selectedInputs = savedOption?.inputs;
      const nested =
        selectedInputs &&
        (selectedInputs.required || selectedInputs.optional)
          ? { ...selectedInputs.required, ...selectedInputs.optional }
          : undefined;
      if (nested) {
        // V3 dynamic-combo nested inputs are keyed with the combo's id as a
        // "<combo>.<nested>" prefix (ComfyUI rebuilds the nested dict from these
        // via dynamic_paths). A flat "<nested>" key is rejected as missing.
        // Only POSITIONAL widget nested inputs consume a widgets_values slot —
        // non-widget nested inputs (AUTOGROW lists like Nano Banana 2's
        // "images", or IMAGE/link types) have no saved widget value, so skipping
        // them keeps the positional mapping aligned.
        let refuseTail = false;
        for (const [nName, nSpec] of Object.entries(nested)) {
          if (!isPositionalWidgetSpec(nSpec)) continue;
          // A linked (converted-to-input) nested leaf's value arrives via the link
          // loop below, NOT the saved array. Other/older frontend versions, though,
          // RETAIN a serialized placeholder for a converted widget, so the leaf may
          // OR may not still occupy a widgets_values slot — and that cannot be told
          // apart positionally. If a placeholder IS present and we skip it without
          // consuming, the retained value shifts onto the NEXT top-level widget: a
          // seed silently becomes the placeholder (e.g. widgets_values
          // [parent, 4(linked-nested placeholder), 424242(seed), "fixed"] would map
          // seed=4). When trailing saved values remain, the alignment is
          // unrecoverable, so REFUSE the tail — the same safe pattern as the
          // stale-parent guard above: warn + leave the remaining top-level widgets
          // to their defaults rather than risk a silent shift onto a later widget.
          // (If NO trailing values remain there is nothing to misassign, so the
          // link simply supplies the leaf and the loop ends.)
          if (linkedInputNames.has(`${name}.${nName}`)) {
            if (widgetIdx < widgetValues.length) {
              warnings.push(
                `Node ${nodeId} (${classType}): widget "${name}" has a converted-to-input (linked) nested widget "${name}.${nName}" whose widgets_values slot can't be positionally resolved (frontend versions differ on whether a converted widget keeps a placeholder slot), so the remaining ${
                  widgetValues.length - widgetIdx
                } saved widget value(s) are left to their defaults rather than risk silently assigning a stale value to a later widget (such as a seed).`,
              );
              refuseTail = true;
              break;
            }
            continue;
          }
          if (widgetIdx >= widgetValues.length) break;
          // Nested leaf values bypass the top-level widget validation, so validate
          // each against ITS OWN leaf spec/name (P1-B). Asset classification keys
          // off the leaf name + loader/upload allowlist (don't regress #504/#407);
          // an out-of-list nested enum (e.g. aspect_ratio "4:3") substitutes+warns.
          inputs[`${name}.${nName}`] = validateComboValueForSpec(
            nName,
            widgetValues[widgetIdx],
            nSpec,
            classType,
            nodeId,
            warnings,
          );
          nestedKeysFromDynamic.push(`${name}.${nName}`);
          widgetIdx++;
          // A nested seed-type / control_after_generate leaf carries a phantom
          // "fixed"/"randomize" value right after it (same as top-level seeds), so
          // skip that slot or every following widget shifts by one.
          if (
            specHasControlAfterGenerate(nName, nSpec) &&
            widgetIdx < widgetValues.length
          ) {
            widgetIdx++;
          }
        }
        // A linked nested leaf with trailing saved values made the alignment
        // ambiguous — stop mapping the remaining top-level widgets (they
        // default-fill below) so no retained placeholder can shift onto a seed.
        // This refusal's leftover is expected, so suppress the drift guard for this
        // node (see refusalOccurred note) — otherwise it would delete valid earlier
        // widgets/leaves mapped before this refusing combo.
        if (refuseTail) {
          refusalOccurred = true;
          break;
        }
      }
    }
    // Drift guard: a LEFTOVER saved value after a still-valid dynamic combo means
    // its nested arity SHRANK since the save (see the sawDynamicCombo note above) —
    // the current option consumes fewer nested slots than the save held, leaving a
    // provable leftover. A self-consistent layout consumes exactly; a leftover proves
    // the positional mapping after (and WITHIN) the drifted combo is shifted: both the
    // trailing top-level widgets AND the nested dotted leaves may hold a value that
    // belongs to a since-removed slot (e.g. old A=[obsolete, strength], current
    // A=[strength], saved ["A",4,0.75] maps strength=4 — the obsolete value). Default
    // BOTH sets (delete so top-level widgets default-fill below and nested leaves fall
    // to their runtime option defaults) and warn, rather than trust a silently shifted
    // value on a later widget (such as a seed) OR a nested leaf. This fires on ANY
    // leftover — even with no trailing top-level widget — so a shifted nested value
    // can't survive. (Mirrors the stale-parent + linked-leaf refusals.)
    //
    // LIMITATION (accepted, BROAD): only the direction that nets to a LEFTOVER is
    // catchable. Any nested-arity drift that nets to EXACT consumption is positionally
    // INDISTINGUISHABLE from a legitimate layout and CANNOT be caught from
    // widgets_values alone. That covers not just arity-GROWTH (option gained nested
    // inputs) but ALSO arity-SHRINK masked by a newly-added TOP-LEVEL widget (a
    // removed nested slot canceled by an added trailing widget → exact), and the
    // multi-combo variants of both. Catching any of these would require refusing ALL
    // trailing widgets after every dynamic combo — which regresses the canonical Nano
    // Banana multi-nested node ([prompt, model, aspect_ratio, resolution,
    // thinking_level, seed, control, response_modalities], an existing passing test).
    // So this guard catches only the provable (leftover) direction.
    //
    // ALSO ACCEPTED (undecidable when a REFUSAL is present): a refusal (linked-leaf
    // or stale/empty-options parent) INTENTIONALLY stops mapping, so the leftover it
    // creates is EXPECTED and cannot be attributed to an earlier combo's drift — a
    // valid layout ([first, first.note, count, second→refuse]) and a drifted one are
    // positionally IDENTICAL once a refusal is present. Acting on that leftover would
    // DELETE valid earlier values, so `refusalOccurred` suppresses this guard for the
    // whole node. (Any earlier drift then falls to the accepted exact-consumption
    // class above — a refusal's leftover is not a reliable drift signal.) The guard
    // therefore fires ONLY on a leftover with NO refusal, where it unambiguously means
    // the arity shrank.
    if (sawDynamicCombo && !refusalOccurred && widgetIdx < widgetValues.length) {
      for (const wn of widgetsAfterDynamicCombo) delete inputs[wn];
      for (const nk of nestedKeysFromDynamic) delete inputs[nk];
      const defaulted = [...nestedKeysFromDynamic, ...widgetsAfterDynamicCombo];
      warnings.push(
        `Node ${nodeId} (${classType}): a dynamic-combo option's nested-input layout appears to have changed since this workflow was saved (${
          widgetValues.length - widgetIdx
        } saved widget value(s) remain unmapped), so its nested leaves and the widget(s) positioned after it${
          defaulted.length ? ` (${defaulted.join(", ")})` : ""
        } are left to their defaults rather than risk a silently shifted value on a later widget (such as a seed) or nested leaf.`,
      );
    }
    }

    // Nodes with a CUSTOM serialized-widget layout (properties.has_serialized_properties
    // — WhatDreamsCost's LTXDirector/LTXSequencer, kijai's PromptRelay) pack extra or
    // reordered widgets into widgets_values that don't match object_info input_order,
    // so the positional mapping above shifts every widget after the first unaccounted
    // slot (field: LTXDirector resolved frame_rate:"seconds", display_mode:768,
    // divisible_by:18 — each value pulled from a neighboring widget). These nodes ALSO
    // write their authoritative NAMED values into node.properties — prefer those.
    // Gated on the flag so normal nodes (whose properties can carry stale copies) are
    // untouched, and matched against widgetNames so non-input properties (cnr_id,
    // timeline_data, UI toggles) can't leak into the prompt.
    const serializedProps = node.properties as Record<string, unknown> | undefined;
    if (serializedProps?.has_serialized_properties === true) {
      for (const name of widgetNames) {
        if (name in serializedProps)
          inputs[name] = validateComboWidgetValue(
            name,
            serializedProps[name],
            def,
            classType,
            nodeId,
            warnings,
          );
      }
    }

    // Fill any required input not covered by widgets_values or a link with its
    // object_info default, so /prompt validation doesn't reject on a missing
    // required input (e.g. a node version added a required widget the saved graph
    // predates, or a special widget type the widget-index mapping skipped). Link
    // inputs (IMAGE/LATENT/etc.) have no default, so they're left alone.
    for (const name of orderedNames) {
      if (name in inputs) continue;
      const spec = (def.input?.required as Record<string, unknown>)?.[name];
      if (!Array.isArray(spec)) continue;
      const [type, config] = spec as [
        unknown,
        { default?: unknown; options?: Array<{ key?: unknown }> }?,
      ];
      let dflt: unknown;
      if (Array.isArray(type)) {
        dflt = config?.default ?? type[0]; // combo list: default or first option
      } else if (Array.isArray(config?.options) && config.options.length) {
        // dynamic combo (e.g. COMFY_DYNAMICCOMBO_V3): default or first option key
        dflt = config.default ?? config.options[0]?.key ?? config.options[0];
      } else {
        dflt = config?.default;
      }
      if (dflt !== undefined) {
        // A schema `default` can itself be out-of-list (custom-node combo drift,
        // e.g. sampler_name default "removed_sampler" not in its own options).
        // Route the derived default through the same choke-point so it can't emit
        // a value ComfyUI rejects — first-option substitution for a true enum,
        // leaf-name asset preservation for a loader/upload selector.
        inputs[name] = validateComboValueForSpec(
          name,
          dflt,
          spec,
          classType,
          nodeId,
          warnings,
        );
      }
    }

    // Map linked inputs from node's inputs array (bypass/mute resolved)
    if (node.inputs) {
      for (const input of node.inputs) {
        if (input.link == null) continue;
        // A virtual PrimitiveNode feeding a widget input provides a literal value,
        // not a connection — it's skipped from the prompt, so use its widget value
        // (e.g. a shared seed/steps PrimitiveNode wired into several samplers).
        const link = linkMap.get(input.link);
        const srcNode = link ? nodesById.get(link.sourceNodeId) : undefined;
        if (srcNode?.type === "PrimitiveNode") {
          const val = srcNode.widgets_values?.[0];
          // A linked PrimitiveNode literal bypasses the widget-value validation
          // above (widgets are processed first, links after), so route it through
          // the same choke-point (P1-A). A stale LOADER asset is preserved+warned;
          // a true out-of-list ENUM (e.g. sampler_name "removed_sampler") is
          // substituted+warned rather than reaching the API and being rejected.
          // input.name may be a dynamic-combo dotted "<combo>.<leaf>" key, so
          // resolve the leaf spec/name first — a top-level lookup would miss it
          // and let the value through unvalidated.
          if (val !== undefined) {
            const { leafName, spec } = resolveWidgetSpec(def, input.name, inputs);
            inputs[input.name] = validateComboValueForSpec(
              leafName,
              val,
              spec,
              classType,
              nodeId,
              warnings,
            );
          }
          continue;
        }
        const resolved = resolveSource(input.link);
        if (resolved) inputs[input.name] = [resolved.id, resolved.slot];
      }
    }

    // Final dependency-aware pass over V3 dynamic-combo dotted "<parent>.<leaf>"
    // inputs: a link/PrimitiveNode override above can change the PARENT selection
    // AFTER its nested leaves were validated against the ORIGINAL option (e.g.
    // positional emits model="A"+model.choice="a1", then a primitive overrides
    // model="B"). Re-anchor every dotted leaf to the FINAL parent value — drop a
    // leaf that the selected option no longer defines, and revalidate the rest
    // against the leaf's real spec — so no leaf reaches the prompt validated
    // against the wrong option.
    for (const key of Object.keys(inputs)) {
      const dot = key.indexOf(".");
      if (dot < 0) continue;
      const parent = key.slice(0, dot);
      // Orphaned dotted leaf: its dynamic parent isn't in the prompt (e.g. an
      // optional parent left unset while the leaf was linked). There's no option
      // context to validate against, and the leaf is meaningless without its
      // parent — ComfyUI has no selected option so "<parent>.<leaf>" is an unknown
      // input it hard-rejects. Default-DENY: drop the leaf UNCONDITIONALLY,
      // whether it's an un-parented literal OR a link ref. Keeping a link ref here
      // (the previous behavior) still emitted an orphan the server would reject.
      if (!(parent in inputs)) {
        delete inputs[key];
        continue;
      }
      const leafVal = inputs[key];
      // A leaf can itself be a LINK REF ([id, slot]) — a nested widget converted to
      // input and wired to a real node. We can't membership-check its runtime
      // value, but we CAN check whether the FINAL selected option even DEFINES the
      // leaf: an array leaf under an option that doesn't define it is just as
      // orphaned as a literal one, and ComfyUI hard-rejects the unknown input. So
      // link-ref leaves are re-anchored too (previously they short-circuited here
      // with an unconditional `continue`, leaking an orphan under an incompatible
      // parent).
      const leafIsLink = Array.isArray(leafVal);
      // Parent fed by a real (non-Primitive) link → the SELECTED option is only
      // known at runtime, so a leaf saved/linked under one option may be wrong
      // for the resolved one. Keep it only if it validates under EVERY option
      // that defines the leaf; otherwise drop it (ComfyUI supplies the runtime
      // option's default). This prevents a wrong-option literal (e.g. option-A
      // "a1" left on a parent that resolves to option B) reaching the prompt.
      if (Array.isArray(inputs[parent])) {
        const leaf = key.slice(dot + 1);
        const pSpec =
          (def.input?.required as Record<string, unknown>)?.[parent] ??
          (def.input?.optional as Record<string, unknown>)?.[parent];
        const pOpts = (
          Array.isArray(pSpec)
            ? (pSpec[1] as {
                options?: Array<{
                  inputs?: {
                    required?: Record<string, unknown>;
                    optional?: Record<string, unknown>;
                  };
                }>;
              })
            : undefined
        )?.options;
        // The resolved option is unknowable at convert time, so KEEP the leaf only
        // if it stays valid WHICHEVER option resolves — i.e. it must be defined by
        // EVERY option (definedEverywhere). If ANY option omits the leaf, that
        // runtime resolution would orphan it (ComfyUI rejects the unknown nested
        // input), so default-DENY and drop it — the option's default is supplied at
        // runtime. This holds for a LINK-REF leaf (whose runtime value we can't
        // membership-check — definition is all we can verify) AND a LITERAL leaf,
        // which must ALSO be a strict in-list MEMBER of every option. Membership
        // uses a strict includes() — NOT validateComboValueForSpec, whose
        // asset/empty-combo PRESERVE path would keep an out-of-list literal and
        // swallow its warning.
        let anyOption = false;
        let definedEverywhere = true;
        let definedSomewhere = false;
        // For a LITERAL leaf: it must be an in-list MEMBER of every option that
        // DEFINES it as a combo. Options that OMIT the leaf are skipped (not failed)
        // so a leaf defined by only some options is still assessed on the options
        // that do define it. A scalar/non-combo defining option (getComboOptions
        // undefined) can't fail membership — it's a normal required input.
        let memberWhereDefined = true;
        if (Array.isArray(pOpts)) {
          for (const o of pOpts) {
            anyOption = true;
            const s = o?.inputs?.required?.[leaf] ?? o?.inputs?.optional?.[leaf];
            if (s === undefined) {
              // This option omits the leaf entirely (orphan if IT resolves).
              definedEverywhere = false;
              continue;
            }
            definedSomewhere = true;
            if (leafIsLink) continue; // link ref: definition is all we can check
            const optList = getComboOptions(s);
            if (Array.isArray(optList) && !optList.includes(leafVal as never)) {
              memberWhereDefined = false;
            }
          }
        }
        // Decision, split by leaf kind:
        //  - LINK-REF leaf: its runtime value is unknowable, so the only defense
        //    against orphaning it under an option that omits the leaf is strict
        //    default-DENY — keep only if EVERY option defines it. Dropping a link
        //    ref discards no user-authored scalar (the connection's value is
        //    runtime), so the strict rule is cheap and safe.
        //  - LITERAL leaf: it is a concrete USER VALUE. Dropping it just because
        //    SOME option omits the leaf silently discards the user's input on a
        //    resolution that may never occur (#517 P0-B: option A defines
        //    strength=0.75, option B omits it — the strict rule deleted 0.75 even
        //    though A is the live selection). A deterministic parent never reaches
        //    this branch (a Primitive/positional parent is a STRING, re-anchored
        //    against its RESOLVED option in the non-array path above), so here the
        //    selection is genuinely unknowable — preserve a literal that at least
        //    one option DEFINES, provided it stays a valid member wherever a
        //    defining option enumerates options. A wrong-option literal (defined by
        //    all options but out-of-list for one — the test-1216 case) still fails
        //    memberWhereDefined and is dropped, so no invalid literal reaches the
        //    prompt.
        const drop = !anyOption
          ? true
          : leafIsLink
            ? !definedEverywhere
            : !definedSomewhere || !memberWhereDefined;
        if (drop) {
          // A dropped LINK-REF leaf is a real connection the user wired — deleting it
          // silently would make the parent's runtime option fall back to its default
          // with no trace (FIX 2, #517). Keep the strict default-deny (safest against
          // orphaning under an option that omits the leaf), but WARN so the removed
          // link + parent are surfaced rather than silently discarded.
          if (leafIsLink) {
            warnings.push(
              `Node ${nodeId} (${classType}): the linked nested input "${key}" was dropped — its dynamic parent "${parent}" is fed by a runtime link (resolved option unknown) and not every option defines "${leaf}", so keeping the connection could orphan it under an option that omits the leaf. "${leaf}" will use the resolved option's default instead of the wired link.`,
            );
          }
          delete inputs[key];
        }
        continue;
      }
      const { leafName, spec } = resolveWidgetSpec(def, key, inputs);
      if (spec === undefined) {
        // The final selected option does not define this leaf — it belongs to the
        // superseded option and would be an unknown input on the current one. Drop
        // it whether it's a literal OR a real-link ref (both orphan under the final
        // option; a link ref is not exempt — the previous `continue` above leaked
        // exactly this case).
        delete inputs[key];
        continue;
      }
      // Leaf IS defined by the final selected option. A real-link ref into a defined
      // leaf is a valid connection whose runtime value ComfyUI validates — keep it
      // as-is (there's no literal to re-validate here).
      if (leafIsLink) continue;
      inputs[key] = validateComboValueForSpec(
        leafName,
        leafVal,
        spec,
        classType,
        nodeId,
        warnings,
      );
    }

    // rgthree "Power Lora Loader" stores its loras in widgets_values as a list of
    // {on, lora, strength, strengthTwo} objects, NOT as named inputs — its Python
    // reads them from kwargs keyed lora_1, lora_2, …. Translate them here so the
    // loras actually apply; otherwise the node loads zero loras (e.g. a 4-step
    // lightning video workflow then renders badly under-denoised / blurry).
    if (/Power Lora Loader/.test(classType)) {
      const wv = Array.isArray(node.widgets_values) ? node.widgets_values : [];
      let li = 1;
      for (const w of wv) {
        if (
          w &&
          typeof w === "object" &&
          !Array.isArray(w) &&
          "lora" in (w as Record<string, unknown>)
        ) {
          inputs[`lora_${li++}`] = w;
        }
      }
    }

    // Build the API node
    workflow[nodeId] = {
      class_type: classType,
      inputs,
    };

    // Preserve title metadata
    const title = node.title ?? node._meta?.title;
    const meta: Record<string, unknown> = {};
    if (title && title !== classType) meta.title = title;
    if (Object.keys(meta).length > 0) {
      workflow[nodeId]._meta = meta as { title?: string };
    }
  }

  // Prune dangling input references — a connection to a node id that isn't in
  // the prompt (e.g. a consumer of an expanded-away subgraph instance that the
  // component expansion didn't remap). ComfyUI errors hard ("Node X not found")
  // on these, so drop the connection like an unresolved link.
  const validIds = new Set(Object.keys(workflow));
  let prunedRefs = 0;
  for (const node of Object.values(workflow)) {
    const ins = node.inputs as Record<string, unknown>;
    for (const [name, val] of Object.entries(ins)) {
      if (
        Array.isArray(val) &&
        val.length === 2 &&
        typeof val[0] === "string" &&
        !validIds.has(val[0])
      ) {
        if (process.env.DEBUG_PRUNE) logger.info(`PRUNE: ${(node as {class_type?:string}).class_type}.${name} -> missing ${val[0]}`);
        delete ins[name];
        prunedRefs++;
      }
    }
  }
  if (prunedRefs > 0) {
    warnings.push(`Pruned ${prunedRefs} dangling input reference(s) to nodes not in the prompt.`);
  }

  // Drop links whose source output type clearly mismatches the consuming input's
  // expected type. ComfyUI hard-rejects a type-mismatched link ("Return type
  // mismatch between linked nodes") and fails the whole output branch, so a
  // mismatch means the link is already broken — dropping it cannot regress a
  // working graph (which has none). For an optional input the input simply
  // becomes absent (valid); this rescues e.g. an Impact detailer whose
  // bbox_detector got mis-resolved onto an IMAGE output by a virtual bus.
  // Restricted to custom object types (uppercase, non-primitive) so primitive
  // coercions (INT/FLOAT/…) and wildcard ("*") inputs are never touched.
  // A "strict" object type is a concrete custom type (IMAGE, MODEL, BBOX_DETECTOR…).
  // Exclude primitives (coercible) and polymorphic/wildcard types — notably the V3
  // COMFY_* meta-types (e.g. COMFY_MATCHTYPE_V3, which match whatever they connect
  // to) and ANY/* — so a valid IMAGE↔COMFY_MATCHTYPE_V3 link is never dropped.
  const isObjectType = (t: unknown): t is string =>
    typeof t === "string" &&
    /^[A-Z][A-Z0-9_]*$/.test(t) &&
    !t.startsWith("COMFY_") &&
    !["INT", "FLOAT", "STRING", "BOOLEAN", "NUMBER", "ANY"].includes(t);
  let droppedMismatch = 0;
  for (const node of Object.values(workflow)) {
    const def = objectInfo[node.class_type];
    if (!def) continue;
    const ins = node.inputs as Record<string, unknown>;
    for (const [name, val] of Object.entries(ins)) {
      if (!Array.isArray(val) || val.length !== 2 || typeof val[0] !== "string") {
        continue;
      }
      const srcDef = objectInfo[workflow[val[0]]?.class_type];
      const srcOut = srcDef?.output?.[val[1] as number];
      const inSpec = def.input.required?.[name] ?? def.input.optional?.[name];
      const expected = Array.isArray(inSpec) ? inSpec[0] : undefined;
      if (isObjectType(expected) && isObjectType(srcOut) && expected !== srcOut) {
        if (process.env.DEBUG_PRUNE) {
          logger.info(`TYPEDROP: ${node.class_type}.${name} expected ${expected} got ${srcOut}`);
        }
        delete ins[name];
        droppedMismatch++;
      }
    }
  }
  if (droppedMismatch > 0) {
    warnings.push(`Dropped ${droppedMismatch} type-mismatched link(s).`);
  }

  const nodeCount = Object.keys(workflow).length;
  const skipped = expanded.nodes.length - nodeCount;
  logger.info(
    `Converted UI workflow: ${nodeCount} nodes (${skipped} skipped)`,
  );

  // De-duplicate identical warnings. A value can legitimately be validated twice
  // (positional pass, then the final dynamic-parent re-anchor pass) and produce
  // the same message; identical strings already embed node id + input, so exact
  // duplicates are pure noise. Distinct nodes/inputs keep their own warnings.
  const dedupedWarnings = [...new Set(warnings)];

  return { workflow, warnings: dedupedWarnings };
}
