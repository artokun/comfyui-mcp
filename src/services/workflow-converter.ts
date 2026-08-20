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
  SubgraphInput,
  SubgraphLink,
} from "../comfyui/types.js";
import { logger } from "../utils/logger.js";
import { isSelfProducingUeSender, isUeSender } from "./flatten-workflow.js";

export interface ConversionResult {
  workflow: WorkflowJSON;
  warnings: string[];
  /**
   * Nodes DROPPED because their class_type is absent from object_info. Reported
   * structurally so a caller can raise the same authoritative "unknown node type"
   * error the API-format path raises, instead of parsing it back out of the
   * warning prose — a UI export with an uninstalled custom node must not be able
   * to validate as `valid: true` just because it arrived in the other format
   * (#1869).
   */
  missingNodeTypes: Array<{ nodeId: string; classType: string }>;
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
/**
 * #1037 — can the linked-nested placeholder ambiguity be settled by COUNTING?
 *
 * When a dynamic combo's nested leaf is converted-to-input, the saved array may
 * or may not still carry a placeholder slot for it — frontend versions differ,
 * and the two readings are indistinguishable from the leaf alone. The converter
 * therefore refuses the tail rather than risk shifting a later widget (a seed
 * silently becoming a stray `4`). That refusal is right in general.
 *
 * But it is often over-broad, because the WHOLE row usually settles it. Given
 * the slots still unread and the widgets still to map, exactly one reading
 * normally adds up:
 *
 *   widgets_values: ["scale dimensions", 1920, 1088, "center", "lanczos"]
 *   nested(width, height, crop) with width+height linked, then scale_method
 *     retained  -> consumes 3, leaves 1 for scale_method   ✓
 *     omitted   -> consumes 1, leaves 3 for scale_method   ✗
 *
 * So the placeholders ARE present, and `crop` can be read from its slot instead
 * of being dropped — which is what left ltx-2.3-txt2vid queueing a prompt with
 * no `resize_type.crop`, getting its output node ignored by ComfyUI, and still
 * reporting success.
 *
 * Returns the number of nested slots to consume, or undefined when the count
 * does NOT settle it — in which case the caller refuses exactly as before.
 * Deliberately conservative: it answers only when the remaining top-level
 * widgets have a KNOWABLE width, and bails out entirely if any of them is
 * itself a dynamic combo (whose own nested arity is unknown from here) or is a
 * non-positional input. Ambiguity must stay a refusal, never a guess.
 */
function resolveLinkedNestedArity(opts: {
  /** Slots not yet read, i.e. widgetValues.length - widgetIdx. */
  remainingSlots: number;
  /** Positional nested leaves of the selected option, in order. */
  nestedPositional: string[];
  /** Which of those are converted-to-input. */
  isLinked: (leaf: string) => boolean;
  /** Top-level widget names still to map AFTER this combo. */
  laterWidgets: string[];
  /** Slots a later top-level widget consumes, or undefined if unknowable. */
  slotsForLaterWidget: (name: string) => number | undefined;
}): number | undefined {
  const total = opts.nestedPositional.length;
  const linked = opts.nestedPositional.filter(opts.isLinked).length;
  if (linked === 0) return undefined; // not the ambiguous case

  let tail = 0;
  for (const w of opts.laterWidgets) {
    const n = opts.slotsForLaterWidget(w);
    if (n === undefined) return undefined; // unknowable width — refuse, as before
    tail += n;
  }

  const retained = total; // every nested leaf kept a slot
  const omitted = total - linked; // linked leaves serialized nothing
  const fitsRetained = opts.remainingSlots - retained === tail;
  const fitsOmitted = opts.remainingSlots - omitted === tail;
  // Exactly one reading may account for the row. Both (possible when linked
  // leaves and later widgets happen to cancel out) or neither is still
  // ambiguous, and stays a refusal.
  if (fitsRetained === fitsOmitted) return undefined;
  return fitsRetained ? retained : omitted;
}

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
 * Return the full schema path of an AUTOGROW ancestor for a dotted prompt key.
 * AUTOGROW can be top-level (`values.a`) or nested below one or more selected
 * dynamic-combo options (`model.images.image_1`). In the latter case, looking
 * only at the first segment mistakes `images.image_1` for a combo leaf and the
 * final re-anchoring pass deletes the wired entry as unknown.
 */
function autogrowParentPath(
  def: ComfyUINodeDef,
  key: string,
  inputs: Record<string, unknown>,
): string | undefined {
  const parts = key.split(".");
  if (parts.length < 2) return undefined;

  let path = parts[0];
  let spec =
    (def.input?.required as Record<string, unknown>)?.[path] ??
    (def.input?.optional as Record<string, unknown>)?.[path];

  for (let i = 1; i < parts.length; i++) {
    if (Array.isArray(spec) && spec[0] === "COMFY_AUTOGROW_V3") return path;
    if (!Array.isArray(spec)) return undefined;

    const options = (spec[1] as {
      options?: Array<{
        key?: unknown;
        inputs?: {
          required?: Record<string, unknown>;
          optional?: Record<string, unknown>;
        };
      }>;
    } | undefined)?.options;
    if (!Array.isArray(options)) return undefined;

    const selected = options.find((option) => option?.key === inputs[path])?.inputs;
    path = `${path}.${parts[i]}`;
    spec = selected?.required?.[parts[i]] ?? selected?.optional?.[parts[i]];
  }

  return undefined;
}

/**
 * Whether a widget SPEC carries a control_after_generate phantom slot — either
 * flagged in its config, or a seed-type INT the ComfyUI frontend auto-augments.
 * Works for both top-level inputs and V3 dynamic-combo NESTED leaves (which have
 * no entry in def.input), so nested controlled seeds skip their phantom
 * "fixed"/"randomize" slot too instead of shifting every following widget.
 */
/**
 * #1334 — the four values a control_after_generate slot can hold.
 *
 * The phantom is a frontend-owned combo, not a free field: its serialized value is
 * always one of these. So the slot's OWN content is the evidence that it is a phantom,
 * and it is stronger evidence than any inference from the name and type.
 */
const CONTROL_AFTER_GENERATE_MODES = new Set(["fixed", "randomize", "increment", "decrement"]);

/**
 * Is the value sitting in the next serialized slot actually a control mode?
 *
 * `specHasControlAfterGenerate` INFERS a phantom from "INT named seed" — which is right
 * for the frontend's auto-augmented top-level seeds, and wrong for a V3 dynamic-combo
 * nested `seed` that has no such widget. #1334: `TongzeArkReferenceToVideo` on frontend
 * 1.48.7 has a nested `seed` with no phantom, the converter skipped the real next value
 * anyway, and every following widget shifted by one: the watermark flag took the audio
 * flag's value, the audio flag took `service_tier`'s, and a 172800-second expiry landed
 * in `priority`. Silently wrong output, from a graph that was correct on disk and
 * correct in the live panel.
 *
 * Checking the value closes that gap without giving up the inference: when a phantom is
 * really there the slot holds one of four known strings, and when it is not the slot
 * holds the next real widget's value.
 *
 * RESIDUAL RISK, stated rather than hidden: a genuine widget whose value is literally
 * the string "fixed"/"randomize"/… in exactly that position would still be eaten. That
 * is far narrower than what it replaces (every nested seed without a phantom, always),
 * and it fails the same way the old code did rather than a new way.
 */
function nextValueIsControlMode(values: readonly unknown[], idx: number): boolean {
  if (idx >= values.length) return false;
  const v = values[idx];
  return typeof v === "string" && CONTROL_AFTER_GENERATE_MODES.has(v);
}

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

/**
 * INT / FLOAT / BOOLEAN (including a combined "FLOAT,INT"). A serialized action
 * button can never legitimately occupy one of these, so a value that cannot be
 * the declared type is the one skip signal that needs no vocabulary at all —
 * and it is what recovers an INTERSPERSED button (`detect_range` sitting
 * between a combo and an INT), which no prefix rule can see.
 */
function numericOrBooleanParts(spec: unknown): string[] | undefined {
  if (!Array.isArray(spec)) return undefined;
  const type = spec[0];
  const cfg = spec[1] as { widgetType?: unknown } | undefined;
  const t = typeof cfg?.widgetType === "string" ? cfg.widgetType : type;
  if (typeof t !== "string") return undefined;
  const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  if (!parts.every((p) => p === "INT" || p === "FLOAT" || p === "BOOLEAN")) {
    return undefined;
  }
  return parts;
}

/**
 * Deliberately PERMISSIVE: this decides whether a value could belong to a
 * numeric/boolean widget, and a false "no" SKIPS a real value. ComfyUI itself
 * coerces `"1024"` to an INT and `0`/`1` to a BOOLEAN, and frontends serialize
 * both shapes, so accepting them is what the runtime does — treating them as
 * mismatches would drop a legitimate widget value (#1869 review).
 */
function valueFitsNumericOrBoolean(value: unknown, parts: string[]): boolean {
  const numeric = (v: unknown): number | undefined => {
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
    return undefined;
  };
  if (parts.length === 1 && parts[0] === "BOOLEAN") {
    if (typeof value === "boolean") return true;
    if (value === 0 || value === 1) return true;
    return value === "true" || value === "false";
  }
  const n = numeric(value);
  if (n === undefined) return false;
  if (parts.includes("INT") && !parts.includes("FLOAT")) return Number.isInteger(n);
  return true;
}

/**
 * Saved-row length vs remaining schema slots. Undefined when a later
 * dynamic combo makes nested arity unknowable — extras-skipping must then
 * stay off (a guess would be the same silent shift this exists to prevent).
 */
function remainingPositionalSlots(
  widgetNames: string[],
  fromIdx: number,
  def: ComfyUINodeDef,
): number | undefined {
  let n = 0;
  for (let i = fromIdx; i < widgetNames.length; i++) {
    const spec =
      (def.input?.required as Record<string, unknown> | undefined)?.[widgetNames[i]] ??
      (def.input?.optional as Record<string, unknown> | undefined)?.[widgetNames[i]];
    const type = Array.isArray(spec) ? spec[0] : undefined;
    if (type === "COMFY_DYNAMICCOMBO_V3") return undefined;
    n += 1;
    if (hasControlAfterGenerate(widgetNames[i], def)) n += 1;
  }
  return n;
}

/**
 * Button tokens observed serialized into a real `widgets_values` row (#1869,
 * comfyui-am-vfx-tools AMVideoRead/AMVideoWrite).
 *
 * This is a CLOSED vocabulary on purpose. The first cut matched the general
 * shape of an identifier (`/^[a-z][a-z0-9_]*$/`) and tried to corroborate the
 * skip by finding a later value that fits a strict widget. Independent review
 * broke that three ways, because most ordinary values match that shape too:
 * `["my_path", "label", "detect_range", 12]` skipped `my_path`, and
 * `["my_model", "detect_range", 12]` skipped a stale checkpoint name that #361
 * requires be preserved. The corroboration could tell that SOMETHING in the gap
 * did not belong; it could not tell WHICH — and it always dropped the first.
 *
 * Guessing wrong here writes a silently wrong graph, which is worse than the
 * misalignment being fixed. So an unrecognised token is left alone.
 */
const KNOWN_ACTION_BUTTON_TOKENS = new Set([
  "browse",
  "open_in_explorer",
  "copy_path",
  "detect_range",
]);

/**
 * Advance past serialized frontend-only extras that cannot belong to this
 * schema widget. Returns the index of the first value that should be paired.
 *
 * Two signals only, both requiring the saved row to have MORE values left than
 * the schema has slots left:
 *   1. the value cannot be the declared numeric/boolean type, or
 *   2. the value is a known serialized button token.
 */
function skipSerializedActionWidgets(opts: {
  values: unknown[];
  widgetIdx: number;
  spec: unknown;
  def: ComfyUINodeDef;
  widgetNames: string[];
  nameIdx: number;
}): number {
  let widgetIdx = opts.widgetIdx;
  const { values, spec, def, widgetNames, nameIdx } = opts;
  const nbParts = numericOrBooleanParts(spec);

  while (widgetIdx < values.length) {
    // Skipping is only ever safe when the row has more values left than the
    // schema has slots left. Otherwise every remaining value still has a home
    // and dropping one is the same silent shift this exists to prevent — a
    // REORDERED widget (#959) is dropped rather than merely misassigned.
    const remainingSlots = remainingPositionalSlots(widgetNames, nameIdx, def);
    const extras =
      remainingSlots === undefined
        ? 0
        : Math.max(0, values.length - widgetIdx - remainingSlots);
    if (extras <= 0) break;

    const candidate = values[widgetIdx];
    const typeRefutes = nbParts !== undefined && !valueFitsNumericOrBoolean(candidate, nbParts);
    const knownButton =
      typeof candidate === "string" && KNOWN_ACTION_BUTTON_TOKENS.has(candidate);
    if (!typeRefutes && !knownButton) break;
    widgetIdx++;
  }
  return widgetIdx;
}

// ── De-virtualization (Get/Set/Reroute) pre-pass ────────────────────────────

/**
 * The KJNodes-style Get/Set BUS types. Frontend-only: the pre-pass below rewrites
 * each consumer's link straight to the real upstream source, so none of these ever
 * appears in a queued prompt.
 *
 * EXPORTED (#1400) for the same reason `NON_EXECUTING_NODE_TYPES` is: the runtime
 * classifier needs to know which types never reach the backend, and a second copy
 * of that knowledge is how two lists drift. This one is already load-bearing for a
 * much heavier reason than a verdict — a stale entry here drops links.
 */
export const WIRING_VIRTUAL_TYPES: ReadonlySet<string> = new Set([
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
  warnings: string[],
  scope: string,
): void {
  if (!nodes?.length || !links?.length) return;
  const dict = !Array.isArray(links[0]);
  const lid = (l: any) => (dict ? l.id : l[0]);
  const lsrc = (l: any) => (dict ? l.origin_id : l[1]);
  const lsrcSlot = (l: any) => (dict ? l.origin_slot : l[2]);
  const ltgt = (l: any) => (dict ? l.target_id : l[3]);
  const ltgtSlot = (l: any) => (dict ? l.target_slot : l[4]);
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
      if (b == null) continue;
      // Two Set nodes on the SAME bus name: whichever we keep, the other's writer
      // is unreachable. litegraph resolves by iteration order (last wins), so
      // mirror that — but SAY SO, because the graph's meaning is genuinely
      // ambiguous and the stripped result silently picks one of two producers.
      if (busSet.has(String(b))) {
        warnings.push(
          `${scope}: bus "${String(b)}" is written by more than one Set node (#${
            busSet.get(String(b))!.id
          } and #${n.id}) — the LAST one wins when resolving its Get nodes, so the other producer is not reachable in the stripped graph.`,
        );
      }
      busSet.set(String(b), n);
    }
  }
  const incoming = (node: UiNode) => {
    const inp = (node.inputs ?? []).find((i) => i.link != null);
    const l = inp?.link != null ? linkById.get(inp.link) : undefined;
    return l ? { node: lsrc(l), slot: lsrcSlot(l) } : null;
  };
  type Resolved =
    | { ok: true; node: unknown; slot: unknown }
    | { ok: false; reason: string };
  const resolveReal = (
    nodeId: unknown,
    slot: unknown,
    depth = 0,
  ): Resolved => {
    if (depth > 100) {
      return {
        ok: false,
        reason: `the virtual-wiring chain exceeded 100 hops (a Get/Set or Reroute cycle)`,
      };
    }
    const node = byId.get(nodeId as number);
    if (!node) return { ok: true, node: nodeId, slot };
    if (node.type === "Reroute") {
      const s = incoming(node);
      return s
        ? resolveReal(s.node, s.slot, depth + 1)
        : { ok: false, reason: `Reroute #${node.id} has no incoming connection` };
    }
    if (isGetVirtual(node.type)) {
      const b = busKey(node.widgets_values);
      if (b == null) {
        return {
          ok: false,
          reason: `${node.type} #${node.id} has no bus name (its "Constant" widget is unset)`,
        };
      }
      const setN = busSet.get(String(b));
      if (!setN) {
        return {
          ok: false,
          reason: `${node.type} #${node.id} reads bus "${String(
            b,
          )}" but no Set node in ${scope} writes that bus`,
        };
      }
      const s = incoming(setN);
      return s
        ? resolveReal(s.node, s.slot, depth + 1)
        : {
            ok: false,
            reason: `${node.type} #${node.id} reads bus "${String(b)}", whose ${
              setN.type
            } #${setN.id} has no incoming connection`,
          };
    }
    // SetNode passthrough: rgthree/KJNodes Set nodes expose an output that mirrors
    // their value input, so a consumer can wire straight off the SetNode (not only
    // via a GetNode). Follow the Set's value input to the real source — otherwise
    // the link is left pointing at the (removed) virtual and gets dropped, losing
    // the connection (issue #361: Set/Get-resolved links missing on downstream nodes).
    if (isSetVirtual(node.type)) {
      const s = incoming(node);
      return s
        ? resolveReal(s.node, s.slot, depth + 1)
        : {
            ok: false,
            reason: `${node.type} #${node.id} has no incoming connection`,
          };
    }
    return { ok: true, node: nodeId, slot };
  };

  const drop = new Map<unknown, string>();
  for (const l of links as any[]) {
    const srcType = byId.get(lsrc(l))?.type;
    if (
      srcType === "Reroute" ||
      (srcType && (isGetVirtual(srcType) || isSetVirtual(srcType)))
    ) {
      const real = resolveReal(lsrc(l), lsrcSlot(l));
      if (real.ok && !isWiringVirtual(byId.get(real.node as number)?.type)) {
        setLsrc(l, real.node, real.slot);
        // Re-home the link on the RESOLVED producer's output slot. The link tuple
        // alone is not enough: the subgraph expander treats a component node's
        // `outputs[].links` as the authoritative list of consumers to rewire, so a
        // `component → Set/Get → consumer` edge whose id never landed there was
        // dropped when the component expanded away — surfacing only as an
        // anonymous "pruned dangling reference" (codex gate, #361).
        const producer = byId.get(real.node as number);
        const outSlot = producer?.outputs?.[real.slot as number];
        if (outSlot) {
          const existing = outSlot.links ?? [];
          if (!existing.includes(lid(l))) outSlot.links = [...existing, lid(l)];
        }
      } else {
        // Unresolved bus/reroute. Dropping it silently is issue #361's actual
        // harm: the consumer's input simply vanishes and the stripped graph looks
        // fine. Name the consumer + the reason, and CLEAR the consumer's stale
        // link reference so the graph stays self-consistent (an orphaned link id
        // would otherwise resurface later as an anonymous "dangling link").
        drop.set(
          lid(l),
          real.ok
            ? `the chain resolved to another virtual wiring node, which has no executable equivalent`
            : real.reason,
        );
      }
    }
  }
  for (const [linkId, reason] of drop) {
    const l = linkById.get(linkId);
    if (!l) continue;
    const consumer = byId.get(ltgt(l));
    // A dropped link INTO a virtual node is consumed by the resolution itself —
    // there is no surviving consumer to lose a connection, so nothing to report.
    if (!consumer || isWiringVirtual(consumer.type)) continue;
    const slotIdx = ltgtSlot(l) as number;
    const inputSlot = consumer.inputs?.[slotIdx];
    if (inputSlot && inputSlot.link === linkId) inputSlot.link = null;
    const inputName = inputSlot?.name ?? `slot ${slotIdx}`;
    warnings.push(
      `Node ${consumer.id} (${consumer.type}) in ${scope}: input "${inputName}" was fed through virtual Get/Set/Reroute wiring that could NOT be resolved to a real producer — ${reason}. That connection is ABSENT from the stripped graph even though the source workflow has it.`,
    );
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

/**
 * The subgraph definitions actually INSTANTIATED by this workflow, transitively.
 * A workflow file keeps definitions that no node instantiates (deleted instances,
 * imported libraries); nothing in them reaches the stripped graph, so reporting
 * their unresolved wiring would be pure noise that buries the real losses
 * (codex gate, #361).
 */
function reachableSubgraphs(ui: UiWorkflow): SubgraphDefinition[] {
  const defs = ui.definitions?.subgraphs ?? [];
  if (defs.length === 0) return [];
  const byId = new Map(defs.map((sg) => [sg.id, sg]));
  const reached = new Set<string>();
  const queue: UiNode[][] = [ui.nodes ?? []];
  while (queue.length) {
    for (const n of queue.pop()!) {
      if (!byId.has(n.type) || reached.has(n.type)) continue;
      reached.add(n.type);
      queue.push(byId.get(n.type)!.nodes ?? []);
    }
  }
  return defs.filter((sg) => reached.has(sg.id));
}

/** Strip wiring virtuals from the top-level graph and every LIVE subgraph definition. */
function deVirtualize(
  ui: UiWorkflow,
  warnings: string[],
  liveSubgraphs: SubgraphDefinition[],
): void {
  deVirtualizeGraph(ui.nodes, ui.links as unknown[], warnings, "the top-level graph");
  for (const sg of liveSubgraphs) {
    deVirtualizeGraph(
      sg.nodes,
      sg.links as unknown[],
      warnings,
      `subgraph "${sg.name ?? sg.id}"`,
    );
  }
}

// ── cg-use-everywhere (UE) broadcast materialization ────────────────────────

/**
 * cg-use-everywhere ("Anything Everywhere", "Seed Everywhere", "Prompts
 * Everywhere") wires its consumers with links that DO NOT EXIST in `graph.links`
 * — the pack's browser JS injects them at queue time. A pure `links`-based
 * conversion therefore emits a graph whose consumers have NO connection at all,
 * with nothing said (issue #361: "virtual links from node packs that aren't
 * ordinary graph links").
 *
 * The pack writes its OWN computed broadcast list to `extra.ue_links` on every
 * graph analysis, so that list — not a re-implementation of the pack's matching
 * rules — is the ground truth. Materialize each entry as a REAL link before
 * de-virtualization (so a broadcast whose producer sits behind a Get/Set bus
 * still resolves), and never overwrite an input that already has a real link
 * (UE does not fire on a connected input).
 *
 * When senders exist but `extra.ue_links` does not, the broadcasts are NOT
 * recoverable from the saved graph — that is an UNKNOWN, not an absence, so it
 * is reported rather than quietly treated as "no broadcasts".
 */
interface UeLinkEntry {
  downstream: number;
  downstream_slot: number;
  upstream: number;
  upstream_slot: number;
  /** The sender node that produced this broadcast (absent in older lists). */
  controller?: number;
  type?: string;
}

/**
 * Materialize the broadcasts of ONE graph (the top level, or one subgraph
 * definition — hence the `addLink` indirection, since a definition stores links
 * as objects rather than tuples). Reports, never guesses.
 */
function materializeUeInGraph(
  nodes: UiNode[],
  links: ReadonlyArray<{ id: number; origin_id: number; origin_slot: number }>,
  extra: Record<string, unknown> | undefined,
  scope: string,
  warnings: string[],
  nextId: () => number,
  addLink: (
    id: number,
    srcId: number,
    srcSlot: number,
    dstId: number,
    dstSlot: number,
    type: string,
  ) => void,
  /** Present for a subgraph definition: its virtual input node and input slots,
   *  so a broadcast sourced from the definition's boundary can be registered
   *  there and re-targeted to the outer producer during expansion. */
  boundary?: { inputNodeId: number; inputs: SubgraphInput[] },
): number {
  const senders = nodes.filter((n) => typeof n.type === "string" && isUeSender(n.type));
  const ueLinks = extra?.ue_links;
  if (senders.length === 0) {
    // Records but no recognized sender. Returning 0 here silently would be the
    // single worst outcome this whole change exists to prevent: a real broadcast
    // dropped with nothing said, and it is exactly what an unrecognized sender
    // CLASS produces. We cannot tell a deleted sender (records genuinely stale,
    // dropping them is right) from a sender class this converter doesn't know
    // (records live, dropping them is a loss) — so this is a could-not-determine
    // and it is reported as one.
    if (Array.isArray(ueLinks) && ueLinks.length > 0) {
      warnings.push(
        `${ueLinks.length} cg-use-everywhere broadcast record(s) are present in ${scope}, but no node in it is recognized as a cg-use-everywhere broadcast node. Either those broadcast nodes were deleted (leaving the records stale) or they are a sender class this converter does not recognize — the records cannot be attributed either way, so every input they name is UNCONNECTED in the stripped graph.`,
      );
    }
    return 0;
  }

  // An EMPTY computed list is an ANSWER — the pack analysed the graph and found
  // no broadcast to record — so the stripped graph is faithful and nothing is
  // reported. Only an ABSENT (or non-array) list is an unknown, and only that is
  // warned about. Collapsing the two would either invent a loss or hide one.
  if (Array.isArray(ueLinks) && ueLinks.length === 0) return 0;
  if (!Array.isArray(ueLinks)) {
    warnings.push(
      `${senders.length} cg-use-everywhere broadcast node(s) (${senders
        .map((s) => `${s.type} #${s.id}`)
        .join(", ")}) are present in ${scope}, but it carries no computed "extra.ue_links" list. ` +
        `Their broadcast connections are NOT ordinary graph links and CANNOT be recovered from this file, so every input they feed is UNCONNECTED in the stripped graph. ` +
        `Open the workflow with cg-use-everywhere active and save (or queue) it once so the pack writes extra.ue_links, then strip again.`,
    );
    return 0;
  }

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const senderIds = new Set(senders.map((s) => s.id));

  // ── Whole-record staleness: is the sender STILL fed by the recorded producer? ──
  // Verifying only that `controller` is still a sender is not enough. A record
  // left over from before its sender was DISCONNECTED or REWIRED would otherwise
  // materialize `upstream → consumer`: an edge that does not exist live. A
  // fabricated connection is worse than a dropped one — a missing link renders as
  // an obviously broken graph, a fabricated one renders as a plausible graph that
  // is silently wrong and looks deliberate to whoever opens it.
  const linkSrc = new Map<number, { node: number; slot: number }>();
  for (const l of links) {
    if (l && typeof l.id === "number") {
      linkSrc.set(l.id, { node: l.origin_id, slot: l.origin_slot });
    }
  }
  const busSet = new Map<string, UiNode>();
  for (const n of nodes) {
    if (!isSetVirtual(n.type)) continue;
    const b = busKey(n.widgets_values);
    if (b != null) busSet.set(String(b), n);
  }
  // This runs BEFORE de-virtualization, and the pack's `upstream` is sometimes the
  // REAL producer and sometimes the virtual node in front of it. So BOTH sides of
  // the comparison are normalized past Reroute/Get/Set first — comparing a raw
  // origin against a resolved one would flag a perfectly current record as stale
  // and drop a live connection. `null` means the chain could NOT be resolved,
  // which is distinct from "resolved to something else".
  const realOfNode = (
    nodeId: number,
    slot: number,
    depth = 0,
  ): { node: number; slot: number } | null => {
    if (depth > 100) return null;
    const n = nodesById.get(nodeId);
    if (!n) return { node: nodeId, slot }; // outside this graph — take at face value
    if (n.type === "Reroute" || isGetVirtual(n.type) || isSetVirtual(n.type)) {
      const via = isGetVirtual(n.type)
        ? (() => {
            const b = busKey(n.widgets_values);
            const setN = b != null ? busSet.get(String(b)) : undefined;
            return (setN?.inputs ?? []).find((i) => i.link != null);
          })()
        : (n.inputs ?? []).find((i) => i.link != null);
      return via?.link != null ? realSourceOf(via.link, depth + 1) : null;
    }
    return { node: nodeId, slot };
  };
  const realSourceOf = (linkId: number, depth = 0): { node: number; slot: number } | null => {
    if (depth > 100) return null;
    const src = linkSrc.get(linkId);
    if (!src) return null;
    return realOfNode(src.node, src.slot, depth + 1);
  };
  /** Senders whose records were materialized but whose CHANNEL could not be
   *  verified, because the sender carries several distinct producers and a
   *  ue_links record does not name the sender input it came through. Disclosed
   *  once per sender rather than per record. */
  const multiFeedControllers = new Map<
    number,
    { type: string; confirmed: number; unresolved: number }
  >();
  /**
   * THE single "is this producer real" question. Every uncertainty about a
   * producer must flow through here — the record's own producer before it is
   * materialized, AND each of the sender's feeds when counting how many distinct
   * producers it carries. Two separate answers to the same question is how the
   * caveat came to claim a producer was "confirmed" that the materializer would
   * have refused.
   *
   * A node OUTSIDE this graph (a subgraph boundary feed) is not judged here: its
   * real producer lives one level up and is resolved during expansion.
   */
  const producerConfirmed = (nodeId: number, slot: number): boolean => {
    const nd = nodesById.get(nodeId);
    if (!nd) return true;
    // A node that really produces something serializes its outputs. An absent
    // array is could-not-determine, and folding that into a definite yes is what
    // let an executable edge be emitted to a slot nothing proved exists.
    if (!Array.isArray(nd.outputs)) return false;
    return slot < nd.outputs.length;
  };
  /**
   * Verify the record against the sender's LIVE feed.
   *  - "ok"          the sender is still fed by exactly this producer + slot
   *  - "detached"    the sender has no incoming connection at all
   *  - "rewired"     every feed resolved, none to this producer + slot
   *  - "unverifiable" a feed exists but its chain could not be resolved
   * A sender with no `controller` on the record can't be attributed, so it is not
   * assessed ("ok" — older lists predate the field and say nothing either way).
   */
  const assessRecord = (
    raw: UeLinkEntry,
    /** The record's producer ALREADY normalized past any virtual wiring. Passed
     *  in rather than recomputed so the check and the materialization provably
     *  judge the SAME node — computing it independently in each place is exactly
     *  how one site came to compare a raw virtual id against a normalized one. */
    want: { node: number; slot: number },
  ): "ok" | "detached" | "rewired" | "unverifiable" | "unattributable" => {
    // No `controller` (older lists omit the field): the record cannot be tied to
    // ANY sender. Scanning for "some live sender happens to be fed by this
    // producer" reads a COINCIDENCE as evidence — the record's own sender may be
    // long gone while an unrelated sender shares that producer and broadcasts it
    // somewhere else entirely, which fabricates an edge the live graph lacks.
    // The one self-attributing shape is a producer that IS itself a SELF-PRODUCING
    // broadcast node (Seed Everywhere owns its widget): that names its own single
    // channel unambiguously, with no attribution to guess at. It must be a
    // self-producing class specifically — accepting any recognized sender here
    // would skip the feed check for a relay sender, which is how an over-broad
    // class match could turn a stale record into a fabricated edge.
    if (raw.controller == null) {
      const up = nodesById.get(want.node);
      return up && isSelfProducingUeSender(up.type) ? "ok" : "unattributable";
    }
    // Seed Everywhere and friends: the sender IS the producer (it owns the widget),
    // so there is no incoming feed to compare against. Same narrowing — a relay
    // sender that merely names itself as its own upstream is not exempt from
    // verification, it falls through to the feed check below.
    //
    // Compare the NORMALIZED producer, not the raw one. The pack records the
    // virtual in front of a producer as readily as the producer, so a record like
    // { controller: SeedEverywhere#1, upstream: Reroute#2 } is self-producing once
    // the Reroute is followed. Testing the raw value called that a mismatch, fell
    // through to the feed check, found a Seed has no incoming feed, and DROPPED a
    // live broadcast. (The flattener normalizes first; this makes the two agree.)
    if (
      want.node === raw.controller &&
      isSelfProducingUeSender(nodesById.get(raw.controller)?.type ?? "")
    ) {
      return "ok";
    }
    const ctrl = nodesById.get(raw.controller);
    if (!ctrl) return "ok"; // already reported by the sender check above
    // A sender can have SEVERAL inputs (Prompts Everywhere, Anything Everywhere3),
    // each with its own record — the record is current if ANY feed matches.
    //
    // KNOWN LIMIT, and it is a limit of the DATA, not of this check. A ue_links
    // record carries { downstream, downstream_slot, upstream, upstream_slot,
    // controller, type } and nothing that says WHICH INPUT of the sender the
    // broadcast came through. On a multi-input sender the producer identity is
    // therefore the only handle on channel identity, which is what is matched
    // here. What cannot be checked is whether that channel routes to THIS target:
    // deciding that is the pack's own type/name matching, and re-implementing it
    // would be a second guess layered on the first. So a list that went stale by
    // SWAPPING two channels of one sender (positive/negative both still feeding
    // it, just exchanged) is indistinguishable from a current one.
    //
    // Refusing every multi-input record would drop the broadcasts of every Prompts
    // Everywhere / Anything Everywhere3 graph, permanently and with no remedy the
    // user could act on — a certain loss traded for an occasional one. So the
    // record IS materialized, and `multiFeedControllers` records the sender so the
    // residual is DISCLOSED once per sender. Unverifiable and undisclosed are
    // different failures; only the second one is this issue.
    const feeds = (ctrl.inputs ?? []).filter((i) => i.link != null);
    if (feeds.length === 0) return "detached";
    let unresolved = 0;
    let matched = false;
    const distinct = new Set<string>();
    for (const f of feeds) {
      const real = realSourceOf(f.link as number);
      // An UNRESOLVED input is an UNKNOWN producer, not the absence of one, and
      // so is one whose producer this converter would REFUSE to wire from. Both
      // count toward the channel ambiguity below; contributing nothing made a
      // sender with one known and one unknown producer read as "one producer,
      // nothing to confuse", silencing the caveat where the risk is highest.
      if (!real || !producerConfirmed(real.node, real.slot)) {
        unresolved++;
        continue;
      }
      distinct.add(`${real.node}:${real.slot}`);
      if (real.node === want.node && real.slot === want.slot) matched = true;
    }
    if (!matched) return unresolved > 0 ? "unverifiable" : "rewired";
    // Confirmed live, but on a sender carrying MORE THAN ONE distinct producer the
    // channel→target association is not recoverable from the record (see above).
    if (distinct.size + unresolved > 1) {
      multiFeedControllers.set(ctrl.id, {
        type: ctrl.type,
        confirmed: distinct.size,
        unresolved,
      });
    }
    return "ok";
  };

  let added = 0;
  for (const raw of ueLinks as UeLinkEntry[]) {
    const dst = nodesById.get(raw?.downstream);
    const dstInput = dst?.inputs?.[raw?.downstream_slot];
    if (!dst || !dstInput) {
      warnings.push(
        `A cg-use-everywhere broadcast in ${scope} targets node #${raw?.downstream} slot ${raw?.downstream_slot}, which no longer exists — that broadcast connection is ABSENT from the stripped graph.`,
      );
      continue;
    }
    const inputLabel = dstInput.name ?? String(raw.downstream_slot);
    if (dstInput.link != null) continue; // real link present — UE would not fire
    // A record whose own broadcast node is GONE — deleted outright, or that id
    // reused by an ordinary node — is left over; honoring it would fabricate a
    // connection the live graph does not have.
    if (raw.controller != null && !senderIds.has(raw.controller)) {
      warnings.push(
        `A cg-use-everywhere record in ${scope} feeding node ${dst.id} (${dst.type}) input "${inputLabel}" names broadcast node #${raw.controller}, which is no longer a broadcast node in this graph — the record is stale, so that input is left UNCONNECTED rather than wired from a broadcast that no longer exists.`,
      );
      continue;
    }
    // NORMALIZE ONCE, HERE. The pack records the virtual node in front of a
    // producer as readily as the producer itself, so every question asked below —
    // is this the subgraph boundary, does this node exist, does that output slot
    // exist, is the sender still fed by it, what do we wire from — must be asked
    // about the REAL producer. Resolving it independently at each site is what
    // left one check comparing a raw virtual id while its neighbour compared a
    // normalized one, and each such pair cost a live edge.
    const from = realOfNode(raw.upstream, raw.upstream_slot);
    if (!from) {
      warnings.push(
        `A cg-use-everywhere broadcast in ${scope} into node ${dst.id} (${dst.type}) input "${inputLabel}" names producer #${raw.upstream}, whose own virtual wiring could not be resolved to a real node — that input is left UNCONNECTED rather than wired from an unknown source.`,
      );
      continue;
    }
    // Inside a subgraph definition the producer can be the definition's virtual
    // INPUT node: the broadcast's real source is whatever the outer component's
    // matching input is wired to. That is a recoverable connection, not a missing
    // producer — register the materialized edge on the boundary so the expander's
    // input rewiring re-targets it to the outer source like any other inner link.
    const fromBoundary = boundary != null && from.node === boundary.inputNodeId;
    const src = fromBoundary ? undefined : nodesById.get(from.node);
    if (!src && !fromBoundary) {
      warnings.push(
        `A cg-use-everywhere broadcast in ${scope} into node ${dst.id} (${dst.type}) input "${inputLabel}" names producer #${raw.upstream}, which is not in this graph — that connection is ABSENT from the stripped graph.`,
      );
      continue;
    }
    // The recorded output slot must be OBSERVABLY there, on the REAL producer.
    if (src && !producerConfirmed(from.node, from.slot)) {
      const detail = Array.isArray(src.outputs)
        ? `which only has ${src.outputs.length} output(s)`
        : `but that node serializes no outputs at all, so the slot could not be confirmed to exist`;
      warnings.push(
        `A cg-use-everywhere broadcast in ${scope} into node ${dst.id} (${dst.type}) input "${inputLabel}" resolves to output slot ${from.slot} of node ${src.id} (${src.type}), ${detail} — that input is left UNCONNECTED rather than wired to a slot nothing proves is there.`,
      );
      continue;
    }
    // Fourth stale shape, and the only one that would produce an EDGE rather than
    // an absence: the sender survives but is no longer fed by the recorded
    // producer. Never materialize an unconfirmed record — say what could not be
    // confirmed instead.
    const verdict = assessRecord(raw, from);
    if (verdict !== "ok") {
      const ctrl = nodesById.get(raw.controller as number);
      const who = `${ctrl?.type ?? "broadcast node"} #${raw.controller}`;
      const why =
        verdict === "detached"
          ? `${who} no longer has any incoming connection, so it broadcasts nothing`
          : verdict === "rewired"
            ? `${who} is now fed by a different producer than the recorded node ${raw.upstream} (slot ${raw.upstream_slot})`
            : verdict === "unattributable"
              ? `the record names no broadcast node of its own (an older cg-use-everywhere list), so it cannot be attributed to any sender here and there is no way to confirm that producer node ${raw.upstream} (slot ${raw.upstream_slot}) still feeds this input — another sender sharing that producer would prove nothing about THIS target`
              : `${who}'s own incoming connection could not be resolved, so the recorded producer node ${raw.upstream} (slot ${raw.upstream_slot}) could not be confirmed`;
      warnings.push(
        `A cg-use-everywhere record in ${scope} feeding node ${dst.id} (${dst.type}) input "${inputLabel}" could not be confirmed against the live graph: ${why}. That input is left UNCONNECTED rather than wired from a broadcast the live graph may not have.`,
      );
      continue;
    }
    const id = nextId();
    // Wire from the REAL producer, the same node every check above judged.
    addLink(
      id,
      from.node,
      from.slot,
      raw.downstream,
      raw.downstream_slot,
      raw.type ?? dstInput.type ?? "*",
    );
    dstInput.link = id;
    if (fromBoundary) {
      // The expander walks each subgraph input's linkIds to re-point its inner
      // consumers at the outer source; an unregistered edge would be left dangling.
      const sgInput = boundary!.inputs[from.slot];
      if (sgInput) (sgInput.linkIds ??= []).push(id);
    } else {
      const srcOut = src!.outputs?.[from.slot];
      if (srcOut) srcOut.links = [...(srcOut.links ?? []), id];
    }
    added++;
  }
  // A non-empty list is not proof that it accounts for EVERY sender. One that
  // predates a sender simply has no row for it, and the broadcasts of that sender
  // then come out unconnected — which, on a list that looked usable, is exactly
  // the silent difference this change exists to remove. A sender that genuinely
  // reaches nothing has no row either, and the two are indistinguishable here, so
  // it is reported as the could-not-determine it is.
  const attributed = new Set<number>();
  for (const r of ueLinks as UeLinkEntry[]) {
    if (r?.controller != null) attributed.add(r.controller);
    else {
      // A controllerless record still accounts for its sender when the producer
      // IS that sender (the self-producing shape accepted above) — judged on the
      // NORMALIZED producer, since the record may name a virtual in front of it.
      const p = realOfNode(r?.upstream, r?.upstream_slot);
      if (p && isSelfProducingUeSender(nodesById.get(p.node)?.type ?? "")) {
        attributed.add(p.node);
      }
    }
  }
  for (const s of senders) {
    if (attributed.has(s.id)) continue;
    warnings.push(
      `${s.type} #${s.id} in ${scope} is a cg-use-everywhere broadcast node, but no record in extra.ue_links names it. Either it currently broadcasts to nothing, or the saved list predates it — indistinguishable from the file, so nothing was wired from it and any inputs it feeds are UNCONNECTED in the stripped graph. Re-save (or queue) with cg-use-everywhere active to refresh the list.`,
    );
  }
  for (const [id, info] of multiFeedControllers) {
    // Say only what is true. This fires both when several producers were
    // CONFIRMED and when one channel could not be resolved at all, and claiming
    // "every producer was confirmed" in the second case is a false statement in a
    // disclosure — which is how disclosures get ignored.
    const carries =
      info.unresolved > 0
        ? `${info.confirmed} confirmed producer(s) plus ${info.unresolved} input(s) whose own source could NOT be resolved`
        : `${info.confirmed} different confirmed producers`;
    warnings.push(
      `Node ${id} (${info.type}) in ${scope}: a cg-use-everywhere broadcast could not be matched to a specific sender input — this sender carries ${carries}, and a ue_links record does not name the input a broadcast came through. The wiring is materialized, but a saved list that went stale by SWAPPING this sender's channels would look identical from the file. Re-save (or queue) the workflow with cg-use-everywhere active if this sender's routing matters.`,
    );
  }
  return added;
}

function materializeUeLinks(
  ui: UiWorkflow,
  warnings: string[],
  liveSubgraphs: SubgraphDefinition[],
): void {
  // ONE id counter across the whole workflow: subgraph expansion offsets inner
  // link ids from the global maximum, so a definition-local id that collides with
  // a top-level one would be remapped onto a live edge.
  let maxId = ui.last_link_id ?? 0;
  for (const l of ui.links ?? []) if (Array.isArray(l)) maxId = Math.max(maxId, l[0]);
  for (const sg of ui.definitions?.subgraphs ?? []) {
    for (const l of sg.links ?? []) maxId = Math.max(maxId, l?.id ?? 0);
  }
  const nextId = () => ++maxId;

  const links = (ui.links ??= []);
  let added = materializeUeInGraph(
    ui.nodes ?? [],
    // Normalize the top level's tuple links to the object shape the staleness
    // check reads; a subgraph definition already stores them that way.
    links
      .filter((l) => Array.isArray(l))
      .map((l) => ({ id: l[0], origin_id: l[1], origin_slot: l[2] })),
    ui.extra as Record<string, unknown> | undefined,
    "the top-level graph",
    warnings,
    nextId,
    (id, s, ss, d, ds, t) => links.push([id, s, ss, d, ds, t]),
  );
  for (const sg of liveSubgraphs) {
    const sgLinks = (sg.links ??= []);
    added += materializeUeInGraph(
      sg.nodes ?? [],
      sgLinks,
      sg.extra,
      `subgraph "${sg.name ?? sg.id}"`,
      warnings,
      nextId,
      (id, s, ss, d, ds, t) =>
        sgLinks.push({
          id,
          origin_id: s,
          origin_slot: ss,
          target_id: d,
          target_slot: ds,
          type: t,
        }),
      { inputNodeId: sg.inputNode?.id, inputs: sg.inputs ?? [] },
    );
  }
  ui.last_link_id = maxId;
  if (added > 0) {
    logger.info(`Materialized ${added} cg-use-everywhere broadcast link(s)`);
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
      if (!outerLink) {
        // The slot claims a connection whose link does not exist. The inner
        // consumers are then treated as unfed and cleared by 8b below, so the
        // inner nodes silently fall back to their own stored values — the
        // subgraph-boundary counterpart of a dangling input reference, and just
        // as invisible unless it is said.
        warnings.push(
          `Component "${sg.name}" (node ${compNode.id}): input "${compInput.name}" claims link ${compInput.link}, which does not exist in the graph, so the connection is DROPPED and everything inside fed by that input falls back to its own stored value.`,
        );
        continue;
      }

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

      // Every inner link that ORIGINATES at the boundary for this input, not just
      // the ones the definition's own `linkIds` happens to list. De-virtualization
      // re-homes a link onto the boundary when the producer sat behind a Reroute
      // or a Get/Set bus inside the definition, and such a link is nowhere in
      // `linkIds` — it was silently skipped here and its consumer lost the
      // connection, once per instance. `linkIds` remains the primary source (it
      // carries entries even when a link's origin was rewritten elsewhere), and
      // the two are unioned by id.
      const boundaryLinkIds = new Set<number>(sgInput.linkIds ?? []);
      const inputIndex = sg.inputs.indexOf(sgInput);
      for (const il of sg.links) {
        if (il.origin_id === inputNodeId && il.origin_slot === inputIndex) {
          boundaryLinkIds.add(il.id);
        }
      }
      for (const innerLinkId of boundaryLinkIds) {
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

  // ── 8. Apply promoted ("proxy") widget values ───────────────────────────
  // A subgraph node's own widgets are PROMOTIONS: `properties.proxyWidgets` is an
  // ordered [innerNodeId, widgetName] list parallel to `widgets_values`, and the
  // value the user sees/edits on the subgraph node is the LIVE value — the inner
  // node's own saved widgets_values is whatever it held when the subgraph was
  // built. Failing to push the promoted value down means the stripped graph
  // reports (and would run) the STALE inner value: issue #361's "returns wrong
  // dynamic widget values".
  //
  // Two promotion shapes exist and BOTH were silently dropped before:
  //   • innerNodeId "-1" — the promotion targets a SUBGRAPH INPUT slot (a widget
  //     exposed on the subgraph boundary). Its value belongs to every inner
  //     consumer wired from that input slot.
  //   • a real inner node id — the promotion targets that node's named widget.
  // The old code resolved neither reliably: it mapped the widget NAME to a
  // POSITION with findWidgetIndex(), which counts only widgets that appear in the
  // node's inputs[] and returns null otherwise — so a promoted value either
  // vanished or (when inputs[] omitted some widgets) landed on the WRONG widget.
  // Values are now carried BY NAME on `resolvedWidgetValues` and applied by the main
  // converter against object_info, which is authoritative about widget names.
  const proxyWidgets: [string, string][] = Array.isArray(compNode.properties?.proxyWidgets)
    ? (compNode.properties!.proxyWidgets as [string, string][])
    : [];
  const rawWidgetValues = compNode.widgets_values ?? [];
  // A subgraph instance normally serializes its promoted values POSITIONALLY,
  // parallel to proxyWidgets. Some captures key every widget BY NAME instead (the
  // shape the main converter already accepts). Read both, or a name-keyed capture
  // would leave every promotion at the inner node's stale value — silently.
  const widgetValues: unknown[] = Array.isArray(rawWidgetValues) ? rawWidgetValues : [];
  const wvByName: Record<string, unknown> | null =
    !Array.isArray(rawWidgetValues) && rawWidgetValues && typeof rawWidgetValues === "object"
      ? (rawWidgetValues as unknown as Record<string, unknown>)
      : null;
  // A flat name→value map can only be attributed when the promoted names are
  // UNIQUE. Two promotions of the same widget name (from different inner nodes)
  // share one slot, so the stored value belongs to neither in particular — refuse
  // both rather than push one control's value onto another.
  const nameClaims = new Map<string, number>();
  if (wvByName) {
    for (const e of proxyWidgets) {
      if (Array.isArray(e) && e.length >= 2) {
        nameClaims.set(e[1], (nameClaims.get(e[1]) ?? 0) + 1);
      }
    }
  }

  /** Record a promoted value on an inner node BY NAME. A nested subgraph
   *  instance has no object_info of its own, so its promotion is recorded
   *  positionally in its OWN proxyWidgets order (the next expansion pass reads
   *  it from there). Returns false when the target cannot carry the value. */
  const applyPromoted = (target: UiNode, widgetName: string, value: unknown): boolean => {
    const innerProxy = target.properties?.proxyWidgets;
    if (Array.isArray(innerProxy) && innerProxy.length > 0) {
      const idx = (innerProxy as [string, string][]).findIndex(
        ([, wn]) => wn === widgetName,
      );
      if (idx < 0) return false;
      const nestedWv = target.widgets_values as unknown;
      // A nested instance may itself carry a NAME-KEYED widgets_values. Overlay
      // the value in that representation — replacing the object with a positional
      // array would discard the nested instance's OTHER promoted values, which
      // its own expansion pass would then silently leave at their stale inner
      // values (codex gate r3).
      if (nestedWv && typeof nestedWv === "object" && !Array.isArray(nestedWv)) {
        (nestedWv as Record<string, unknown>)[widgetName] = value;
        return true;
      }
      if (!Array.isArray(target.widgets_values)) target.widgets_values = [];
      target.widgets_values[idx] = value;
      return true;
    }
    (target.resolvedWidgetValues ??= {})[widgetName] = value;
    return true;
  };

  // NOTE: a promoted widget with no entry in widgets_values is NOT a loss and is
  // deliberately not reported. The subgraph node's widget is a PROXY VIEW of the
  // inner widget, so "no serialized override" means the inner node's own stored
  // value is exactly what the subgraph node displayed — which is what we keep.
  // (Most real subgraph instances serialize an empty widgets_values, so warning
  // here fired on nearly every subgraph-bearing workflow and would have buried
  // the genuine losses below.)
  for (let i = 0; i < proxyWidgets.length; i++) {
    const entry = proxyWidgets[i];
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [innerNodeIdStr, widgetName] = entry;
    if (wvByName && (nameClaims.get(widgetName) ?? 0) > 1) {
      warnings.push(
        `Component "${sg.name}" (node ${compNode.id}): promoted widget "${widgetName}" could not be resolved from the name-keyed capture because more than one promotion claims that name, so the single stored value can't be attributed to the right one. Left to the inner node's own value rather than risk assigning another control's.`,
      );
      continue;
    }
    const value = wvByName
      ? wvByName[widgetName]
      : i < widgetValues.length
        ? widgetValues[i]
        : undefined;
    if (value === undefined || value === null) continue;

    const remapped = nodeRemap.get(Number(innerNodeIdStr));
    if (remapped != null) {
      const targetNode = newNodes.find((n) => n.id === remapped);
      if (targetNode && applyPromoted(targetNode, widgetName, value)) continue;
      warnings.push(
        `Component "${sg.name}" (node ${compNode.id}): promoted widget "${widgetName}" = ${JSON.stringify(
          value,
        )} could not be applied to inner node ${innerNodeIdStr} — the stripped graph keeps that node's own stored value instead.`,
      );
      continue;
    }

    // "-1" (or any id that is not an inner node): the promotion targets a
    // SUBGRAPH INPUT slot. Push the value to every inner consumer wired from it —
    // but only when the OUTER slot is unconnected, since a real incoming link
    // supplies the value at runtime and step 6 already rewired it.
    const sgInput = sg.inputs?.find((inp) => inp.name === widgetName);
    const outerSlot = compNode.inputs?.find((inp) => inp.name === widgetName);
    if (outerSlot?.link != null && outerLinkMap.has(outerSlot.link)) continue;
    if (!sgInput) {
      warnings.push(
        `Component "${sg.name}" (node ${compNode.id}): promoted widget "${widgetName}" = ${JSON.stringify(
          value,
        )} does not match any inner node or subgraph input, so it could NOT be applied — the stripped graph uses the inner node's stored value instead.`,
      );
      continue;
    }
    let applied = 0;
    for (const innerLinkId of sgInput.linkIds ?? []) {
      const il = innerLinkById.get(innerLinkId);
      if (!il || il.origin_id !== inputNodeId) continue;
      const remappedTarget = nodeRemap.get(il.target_id);
      const targetNode =
        remappedTarget != null ? newNodes.find((n) => n.id === remappedTarget) : undefined;
      if (!targetNode) continue;
      const slot = targetNode.inputs?.[il.target_slot];
      const innerName = slot?.widget?.name ?? slot?.name;
      // The feed came from the virtual input node (-10), which step 5 skips, so
      // the inner slot's link id points at nothing. Clear it — the promoted value
      // IS the connection now.
      if (slot) slot.link = null;
      if (!innerName || !applyPromoted(targetNode, innerName, value)) continue;
      applied++;
    }
    if (applied === 0) {
      warnings.push(
        `Component "${sg.name}" (node ${compNode.id}): promoted widget "${widgetName}" = ${JSON.stringify(
          value,
        )} has no inner consumer that could receive it, so it is NOT reflected in the stripped graph.`,
      );
    }
  }

  // ── 8b. Unconnected subgraph inputs ─────────────────────────────────────
  // An inner slot fed from the virtual input node (-10) whose OUTER slot has no
  // link references a link id that step 5 never materialized. Clear it so the
  // graph is self-consistent — otherwise it later surfaces as an anonymous
  // "dangling link", indistinguishable from a real dropped connection.
  for (const sgInput of sg.inputs ?? []) {
    const outerSlot = compNode.inputs?.find((inp) => inp.name === sgInput.name);
    if (outerSlot?.link != null && outerLinkMap.has(outerSlot.link)) continue;
    for (const innerLinkId of sgInput.linkIds ?? []) {
      const il = innerLinkById.get(innerLinkId);
      if (!il || il.origin_id !== inputNodeId) continue;
      const remappedTarget = nodeRemap.get(il.target_id);
      const targetNode =
        remappedTarget != null ? newNodes.find((n) => n.id === remappedTarget) : undefined;
      const slot = targetNode?.inputs?.[il.target_slot];
      if (slot && slot.link === linkRemap.get(innerLinkId)) slot.link = null;
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
          // Carry the literal BY NAME. (It used to be written positionally via
          // findWidgetIndex, which counts only the widgets present in inputs[] —
          // so on a node whose inputs[] omits some widgets the value landed on the
          // WRONG widget, and when the widget was absent from inputs[] entirely it
          // was dropped outright. Same #361 wrong-widget-value class as the
          // promoted-widget path above.)
          (tgtNode.resolvedWidgetValues ??= {})[tgtInput.widget!.name] = primValue;
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
 *  enqueue_workflow (action:"run_template")'s override validation. */
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
 * Frontend-only node types that never reach the backend (#1372).
 *
 * LiteGraph-native: the ComfyUI frontend registers them, the server's node registry does
 * not, and they are stripped before a prompt is queued. `panel_add_node`'s own description
 * says the same — they "legitimately bypass the backend class_type check".
 *
 * EXPORTED because a second copy is how two lists drift, and #1372 is what that cost: the
 * converter knew MarkdownNote does not execute while the runtime classifier called it an
 * unknown node and refused to say the workflow was free — stopping the paid-API safety
 * flow to ask a question that already had an answer.
 */
export const NON_EXECUTING_NODE_TYPES: ReadonlySet<string> = new Set([
  "Reroute",
  "Note",
  "MarkdownNote",
  "PrimitiveNode",
]);

/**
 * Every type that never reaches the backend — the LiteGraph natives above PLUS the
 * Get/Set bus virtuals the de-virtualization pre-pass strips (#1400).
 *
 * A SEPARATE set from `NON_EXECUTING_NODE_TYPES` because the two answer different
 * questions, and conflating them would be a silent behaviour change:
 *
 *   NON_EXECUTING_NODE_TYPES also drives the converter's own `SKIP_TYPES`. A
 *     Get/Set node that the pre-pass could NOT resolve (a broken bus, a missing
 *     Set for a Get) still reaches the main loop, where dedicated logic handles it
 *     and reports the loss. Adding the bus types there would route those into the
 *     skip path instead, quietly dropping the diagnostic.
 *
 *   FRONTEND_ONLY_NODE_TYPES answers the runtime classifier's question: could this
 *     class_type be a paid API node the server does not expose? For anything in
 *     here the answer is no, whether or not this particular graph's bus resolved.
 *
 * Callers that mean "does not execute anywhere" want THIS one; callers that mean
 * "the converter emits nothing for it" want the narrower one above.
 */
export const FRONTEND_ONLY_NODE_TYPES: ReadonlySet<string> = new Set([
  ...NON_EXECUTING_NODE_TYPES,
  ...WIRING_VIRTUAL_TYPES,
]);

/**
 * Convert a ComfyUI UI-format workflow to API format.
 * Requires objectInfo from /object_info to map widgets_values to named inputs.
 */
export function convertUiToApi(
  ui: UiWorkflow,
  objectInfo: ObjectInfo,
): ConversionResult {
  // Clone (don't mutate the caller's workflow), materialize the node-pack
  // broadcast wiring that isn't in `links` at all (cg-use-everywhere), strip the
  // wiring virtuals (Get/Set bus + Reroute) so the expander + converter only see
  // real links, then expand component/subgraph nodes. Every step reports what it
  // could NOT preserve into the same warnings list (#361).
  const warnings: string[] = [];
  const missingNodeTypes: Array<{ nodeId: string; classType: string }> = [];
  const cleaned = structuredClone(ui);
  // Only definitions this workflow actually instantiates can affect the result;
  // an unused one's wiring problems are not this graph's losses.
  const liveSubgraphs = reachableSubgraphs(cleaned);
  materializeUeLinks(cleaned, warnings, liveSubgraphs);
  deVirtualize(cleaned, warnings, liveSubgraphs);
  const { expanded, warnings: expandWarnings } = expandComponents(cleaned);
  warnings.push(...expandWarnings);

  const workflow: WorkflowJSON = {};

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
  const SKIP_TYPES = NON_EXECUTING_NODE_TYPES;

  // Get/Set node types that need special handling (not in object_info). The SAME
  // set the de-virtualization pre-pass uses — this was a verbatim second copy, and
  // two lists of third-party type names in one file is precisely the drift the
  // exported sets exist to prevent (#1400).
  //
  // NOT covered by a test, and mutation testing says so: narrowing this back to a
  // hand-written `new Set(["GetNode", "SetNode"])` kills nothing, because the
  // pre-pass strips every RESOLVABLE bus before the main loop runs. What reaches
  // here is only a bus the pre-pass could not resolve (a Get with no matching Set,
  // a broken chain), and no fixture builds one. Sharing the set is still strictly
  // better than a second copy — it just cannot be proven from outside, so it is
  // written down instead of assumed.
  const GET_SET_TYPES = WIRING_VIRTUAL_TYPES;

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
  //
  // A failure carries WHY. `toggle` means the drop is ComfyUI's own documented
  // mute/bypass semantics (the queue does the same thing), so it is summarized
  // once rather than repeated per edge; anything else is a genuine loss the
  // caller has no other way to notice, so it is reported per input (#361).
  type SourceResult =
    | { ok: true; id: string; slot: number }
    | { ok: false; toggle: boolean; reason: string };
  const resolveSource = (linkId: number, depth = 0): SourceResult => {
    if (depth > 100) {
      return {
        ok: false,
        toggle: false,
        reason: "the upstream chain exceeded 100 hops (a cycle in the wiring)",
      };
    }
    const link = linkMap.get(linkId);
    if (!link) {
      return {
        ok: false,
        toggle: false,
        reason: `link ${linkId} does not exist in the graph (a dangling reference)`,
      };
    }
    const src = nodesById.get(link.sourceNodeId);
    if (!src) {
      return { ok: true, id: String(link.sourceNodeId), slot: link.sourceSlot };
    }
    // Virtual GetNode: follow the bus to the SetNode that wrote it.
    if (isGetType(src.type)) {
      const bus = busKey(src.widgets_values);
      const setLink = bus != null ? busSource.get(String(bus)) : undefined;
      return setLink != null
        ? resolveSource(setLink, depth + 1)
        : {
            ok: false,
            toggle: false,
            reason: `${src.type} #${src.id} reads bus "${String(
              bus,
            )}", which no Set node writes`,
          };
    }
    // Virtual SetNode passthrough: follow its value input.
    if (isSetType(src.type)) {
      const inp = (src.inputs ?? []).find((i) => i.link != null);
      return inp?.link != null
        ? resolveSource(inp.link, depth + 1)
        : {
            ok: false,
            toggle: false,
            reason: `${src.type} #${src.id} has no incoming connection`,
          };
    }
    // Reroute passthrough: a virtual node that just forwards its single input to
    // all outputs — follow its input link to the real source.
    if (src.type === "Reroute") {
      const inp = (src.inputs ?? []).find((i) => i.link != null);
      return inp?.link != null
        ? resolveSource(inp.link, depth + 1)
        : {
            ok: false,
            toggle: false,
            reason: `Reroute #${src.id} has no incoming connection`,
          };
    }
    const mode = src.mode ?? 0;
    if (mode === 0) {
      return { ok: true, id: String(link.sourceNodeId), slot: link.sourceSlot };
    }
    if (mode === 2) {
      return {
        ok: false,
        toggle: true,
        reason: `its source node ${src.id} (${src.type}) is MUTED`,
      };
    }
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
      if (!cand || cand.link == null) {
        return {
          ok: false,
          toggle: true,
          reason: `its source node ${src.id} (${src.type}) is BYPASSED and has no matching input to pass through`,
        };
      }
      return resolveSource(cand.link, depth + 1);
    }
    return {
      ok: false,
      toggle: false,
      reason: `its source node ${src.id} (${src.type}) has an unrecognized mode ${mode}`,
    };
  };
  // Count of connections dropped by mute/bypass — summarized once at the end.
  let toggleDropped = 0;

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
      missingNodeTypes.push({ nodeId: String(nodeId), classType });
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
    //
    // A live-canvas capture may carry the panel's AUTHORITATIVE name→value widget
    // map (capturedWidgetValues). Prefer it: the positional array below is ordered
    // by the FRONTEND, while the only order we can reconstruct is object_info's, and
    // custom nodes that add or reorder widgets in JS make the two disagree — which
    // silently shifts every value onto the wrong widget (#961/#955/#361: a wildcard
    // string landing on `seed`, a LoRA name landing on a VAE). A name-keyed map has
    // no order to disagree about, so it routes into the object branch below, which
    // already fails CLOSED when a name is ambiguous.
    const widgetValues = node.capturedWidgetValues ?? node.widgets_values ?? [];

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
      const spec =
        (def.input?.required as Record<string, unknown>)?.[name] ??
        (def.input?.optional as Record<string, unknown>)?.[name];
      // #1869 — frontend-only action buttons serialize into widgets_values but
      // are absent from object_info. Skip them before pairing this schema widget
      // so `browse`/`detect_range` cannot land on file_path/first_frame.
      widgetIdx = skipSerializedActionWidgets({
        values: widgetValues,
        widgetIdx,
        spec,
        def,
        widgetNames,
        nameIdx,
      });
      if (widgetIdx >= widgetValues.length) break;
      // A widget mapped AFTER a still-valid dynamic combo is positionally
      // downstream of its (unverifiable) nested arity — record it for the
      // drift-leftover check below.
      if (sawDynamicCombo) widgetsAfterDynamicCombo.push(name);
      const value = widgetValues[widgetIdx];
      inputs[name] = value;
      widgetIdx++;

      // If this input has control_after_generate, skip the next widgets_values entry —
      // but ONLY when that entry actually holds a control mode (#1334). The reporter's
      // defect was nested, and the same inference runs here, so the same guard applies:
      // a node whose object_info flags a phantom the saved row does not contain would
      // shift every following widget in exactly the same way.
      if (hasControlAfterGenerate(name, def) && nextValueIsControlMode(widgetValues, widgetIdx)) {
        widgetIdx++;
      }

      // V3 dynamic combo: the selected option adds nested required inputs whose
      // values follow in widgets_values (e.g. method="rcas" -> strength=0.55).

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
        // #1037 — settle the placeholder ambiguity by COUNTING the row before
        // falling back to a refusal. Computed once for the whole nested block so
        // every leaf reads the same way; undefined means it did NOT settle, and
        // the per-leaf refusal below then behaves exactly as it always did.
        const nestedPositional = Object.entries(nested)
          .filter(([, nSpec]) => isPositionalWidgetSpec(nSpec))
          .map(([nName]) => nName);
        const slotsForLaterWidget = (wName: string): number | undefined => {
          const wSpec =
            (def.input?.required as Record<string, unknown>)?.[wName] ??
            (def.input?.optional as Record<string, unknown>)?.[wName];
          // A later DYNAMIC COMBO carries its own unknown nested arity, so the
          // row cannot be counted past it. Same for a non-positional input.
          const wType = Array.isArray(wSpec) ? wSpec[0] : undefined;
          if (wType === "COMFY_DYNAMICCOMBO_V3") return undefined;
          if (!isPositionalWidgetSpec(wSpec)) return undefined;
          return 1 + (hasControlAfterGenerate(wName, def) ? 1 : 0);
        };
        const settledArity = resolveLinkedNestedArity({
          remainingSlots: widgetValues.length - widgetIdx,
          nestedPositional,
          isLinked: (leaf) => linkedInputNames.has(`${name}.${leaf}`),
          laterWidgets: widgetNames.slice(nameIdx + 1),
          slotsForLaterWidget,
        });
        // "retained" is the only reading under which a linked leaf still occupies
        // a slot that must be stepped over.
        const linkedLeavesHoldSlots =
          settledArity !== undefined && settledArity === nestedPositional.length;
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
            // #1037 — the row settled the ambiguity: step over the placeholder
            // (or don't) and keep mapping, instead of dropping the rest. The
            // leaf's own value still arrives via the link loop either way.
            if (settledArity !== undefined) {
              if (linkedLeavesHoldSlots && widgetIdx < widgetValues.length) widgetIdx++;
              continue;
            }
            if (widgetIdx < widgetValues.length) {
              warnings.push(
                // #1037 — "left to their defaults" was only half true, and the
                // harmless half. A TOP-LEVEL widget does fall back to its schema
                // default. A NESTED "<combo>.<leaf>" key has NO such fallback: it
                // is omitted from the prompt entirely, and if it is required
                // ComfyUI rejects the node ("Required input is missing: crop") and
                // IGNORES that output — which reads downstream as a successful run
                // that produced nothing. Say which of the two this is.
                `Node ${nodeId} (${classType}): widget "${name}" has a converted-to-input (linked) nested widget "${name}.${nName}" whose widgets_values slot can't be positionally resolved (frontend versions differ on whether a converted widget keeps a placeholder slot, and the saved row's length settles neither reading), so the remaining ${
                  widgetValues.length - widgetIdx
                } saved widget value(s) are not read — rather than risk silently assigning a stale value to a later widget (such as a seed). Top-level widgets fall back to their defaults; any NESTED "${name}.<leaf>" key is OMITTED from the prompt instead, so if one of them is required ComfyUI will reject this node and ignore its output branch (the run can then report success with nothing produced). Set the missing nested value explicitly, or reconnect the linked nested input as a widget.`,
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
          // #1334 — and only when the slot actually HOLDS a control mode. A V3
          // dynamic-combo nested `seed` need not have a phantom at all; consuming the
          // slot on the name/type inference alone shifted every following widget.
          if (
            specHasControlAfterGenerate(nName, nSpec) &&
            nextValueIsControlMode(widgetValues, widgetIdx)
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

    // Widget values resolved BY NAME during subgraph expansion — a promoted
    // ("proxy") widget value from the subgraph node, or a virtual PrimitiveNode
    // literal baked onto its consumer. These are the LIVE values the user sees on
    // the subgraph node, so they override the inner node's own stored
    // widgets_values (which is whatever it held when the subgraph was built).
    // Routed through the same combo choke-point as every other widget assignment.
    const resolved = node.resolvedWidgetValues;
    if (resolved) {
      for (const [name, val] of Object.entries(resolved)) {
        if (!widgetNames.includes(name)) {
          warnings.push(
            `Node ${nodeId} (${classType}): a promoted/primitive-supplied value for "${name}" could not be applied — the connected server's definition of ${classType} has no widget by that name, so the node keeps its own stored value.`,
          );
          continue;
        }
        inputs[name] = validateComboWidgetValue(
          name,
          val,
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
        const resolvedSrc = resolveSource(input.link);
        if (resolvedSrc.ok) {
          inputs[input.name] = [resolvedSrc.id, resolvedSrc.slot];
        } else if (resolvedSrc.toggle) {
          // ComfyUI's own queue drops these too — count, don't spam.
          toggleDropped++;
        } else {
          warnings.push(
            `Node ${nodeId} (${classType}): input "${input.name}" is WIRED in the source workflow but its connection could not be resolved — ${resolvedSrc.reason}. The input is ABSENT from the stripped graph.`,
          );
        }
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
      // AUTOGROW entries may be top-level (`values.a`) or nested inside a
      // dynamic-combo option (`model.images.image_1`). Preserve the whole
      // repeated-entry subtree; it is not a dynamic-combo leaf to re-anchor.
      if (autogrowParentPath(def, key, inputs)) continue;
      const parent = key.slice(0, dot);
      // Orphaned dotted leaf: its dynamic parent isn't in the prompt (e.g. an
      // optional parent left unset while the leaf was linked). There's no option
      // context to validate against, and the leaf is meaningless without its
      // parent — ComfyUI has no selected option so "<parent>.<leaf>" is an unknown
      // input it hard-rejects. Default-DENY: drop the leaf UNCONDITIONALLY,
      // whether it's an un-parented literal OR a link ref. Keeping a link ref here
      // (the previous behavior) still emitted an orphan the server would reject.
      if (!(parent in inputs)) {
        warnings.push(
          `Node ${nodeId} (${classType}): the nested input "${key}" was dropped — its dynamic-combo parent "${parent}" has no value in the stripped graph, so there is no selected option the leaf could belong to (ComfyUI rejects an unknown nested input).`,
        );
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
          } else {
            warnings.push(
              `Node ${nodeId} (${classType}): the nested value "${key}" = ${JSON.stringify(
                leafVal,
              )} was dropped — its dynamic parent "${parent}" is fed by a runtime link, so the selected option is unknowable here and this value is not valid under every option it could resolve to. "${leaf}" will use the resolved option's default instead.`,
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
        warnings.push(
          `Node ${nodeId} (${classType}): the nested input "${key}" was dropped — the selected option "${String(
            inputs[parent],
          )}" of "${parent}" does not define it, so it would be an unknown input (this happens when the parent selection changed, e.g. it is supplied by a Primitive node).`,
        );
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
  for (const [nodeId, node] of Object.entries(workflow)) {
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
        // Name the node and the input. A bare count ("pruned N references") told
        // the caller a connection was lost but not WHICH — the same silent-loss
        // shape as #361 itself.
        warnings.push(
          `Node ${nodeId} (${node.class_type}): input "${name}" pointed at node ${val[0]}, which is not in the stripped graph, so the connection was DROPPED (its producer was removed by subgraph expansion or by mute/bypass resolution).`,
        );
      }
    }
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

  if (toggleDropped > 0) {
    warnings.push(
      `${toggleDropped} input connection(s) were dropped because their source node is muted, or bypassed with no matching pass-through input. This mirrors what ComfyUI's queue does with the same graph, so the stripped graph is faithful — but those inputs are unconnected in it.`,
    );
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

  return { workflow, warnings: dedupedWarnings, missingNodeTypes };
}
