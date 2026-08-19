#!/usr/bin/env node
// Cross-check every pack's workflow.json against its manifest.yaml so a loader
// node can't reference a model file the pack never downloads (and vice versa).
//
// This is the guard that was missing when two packs shipped a VAELoader pointing
// at `ae.safetensors` while their installers only fetched a different VAE — the
// node throws a missing-model error on load, but nothing caught it in review.
//
//   node scripts/check-pack-models.mjs              # all packs
//   node scripts/check-pack-models.mjs packs/ernie  # one pack
//
// Exit non-zero if any workflow references a model the manifest doesn't provide.
// Dead downloads (provided but never referenced) are reported as warnings only.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packsRoot = join(repoRoot, "packs");

// File extensions that denote a model weight the pack must provide.
const MODEL_EXT = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin|onnx)$/i;

// Loader widget values are sometimes a sentinel rather than a real file.
const SENTINELS = new Set(["none", "undefined", "null", ""]);

// Node types that fetch their own weights on first run (the model is NOT the
// manifest's responsibility): controlnet-aux preprocessors, RIFE interpolation,
// and the kijai DownloadAndLoad* nodes. A reference from one of these is never
// a manifest gap.
const SELF_MANAGING = /(^DownloadAndLoad)|Preprocessor$|RIFE|InsightFace/i;
const isSelfManaging = (type) => SELF_MANAGING.test(String(type || ""));

// Widget names that are unambiguous MODEL selectors on every node exposing them.
// Kept in sync by hand with ASSET_WIDGET_NAMES in src/services/workflow-converter.ts
// (this script is standalone .mjs and deliberately does not import from src/).
// Deliberately excludes enum-shaped "_name" widgets (sampler_name, scheduler)
// and generic media names, for the same reasons the converter excludes them.
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

function packDirs() {
  const arg = process.argv[2];
  // resolve(), not join(): an ABSOLUTE arg must be honoured as-is so the test
  // suite can point the gate at a synthetic pack outside the repo. A relative
  // arg still resolves against repoRoot exactly as before.
  if (arg) return [resolve(repoRoot, arg)];
  return readdirSync(packsRoot)
    .map((n) => join(packsRoot, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "manifest.yaml")));
}

// Compare by basename, lowercased — manifest local_paths and workflow widget
// values disagree on subfolders (e.g. "loras\\style\\x.safetensors" vs
// "loras/x.safetensors"), but the filename ComfyUI loads is the same.
const norm = (p) => basename(String(p).replace(/\\/g, "/")).toLowerCase();

// Files a manifest downloads (basename of local_path, else filename, else URL).
function providedFiles(manifest) {
  const out = new Map(); // norm -> display name
  for (const m of manifest.models || []) {
    let name;
    if (m.local_path) name = basename(m.local_path);
    else if (m.filename) name = m.filename;
    else if (m.url) {
      try {
        name = basename(new URL(m.url).pathname);
      } catch {
        name = m.url;
      }
    }
    if (name) out.set(norm(name), name);
  }
  return out;
}

/** How many model-extension strings a widgets_values tree holds (same shape test
 *  `record` applies, so the two can never disagree about what counts). */
function countModelStrings(v) {
  if (Array.isArray(v)) return v.reduce((n, x) => n + countModelStrings(x), 0);
  if (v && typeof v === "object") return Object.values(v).reduce((n, x) => n + countModelStrings(x), 0);
  if (typeof v !== "string") return 0;
  if (SENTINELS.has(v.toLowerCase())) return 0;
  return MODEL_EXT.test(v) ? 1 : 0;
}

/**
 * How many of this node's MODEL widget slots are fed by a link instead of by
 * their stored widget value.
 *
 * When a widget is promoted to an input and connected, litegraph keeps the old
 * string in `widgets_values` forever, but `graphToPrompt` builds that input from
 * the LINK — the stored string is dead and ComfyUI never loads it. Five
 * `LoraLoader`s in z-image-xy-plot and two in ltx-2.3-xy-plot are exactly this:
 * a stale filename from before the author wired up the `easy loraNames`
 * selectors. Counting them as live references made the gate report seven
 * missing models that no install can ever miss.
 *
 * The reference itself is NOT lost by skipping them: the link resolves back to
 * a selector node (`easy loraNames`, through Reroutes) whose own widget value is
 * scanned on its own turn, so the gap is still reported — against the node that
 * actually supplies the value.
 *
 * `input.link == null` matters: a widget can be promoted to an input and left
 * UNCONNECTED, and then its stored value is still what ComfyUI loads. Dropping
 * that check would turn every promoted-but-dangling model widget into a blind
 * spot.
 *
 * RESIDUAL RISK, stated rather than hidden: the caller decides by arity, so a
 * node whose linked slot happens to hold a NON-model string (never set to a real
 * file before promotion) under-counts here, and a second model widget typed in
 * on the same node could be skipped with it. That shape does not occur in any of
 * the 57 bundled packs — measured, all 7 link-fed model slots hold model strings
 * — and closing it properly needs object_info, which this script deliberately
 * does not load.
 */
function linkedAssetWidgetCount(node) {
  let n = 0;
  for (const input of node.inputs || []) {
    if (!input || !input.widget || input.link == null) continue;
    if (ASSET_WIDGET_NAMES.has(String(input.widget.name))) n++;
  }
  return n;
}

// Model files referenced by a workflow's loader nodes. We scan widgets_values
// (the value ComfyUI actually loads) for strings ending in a model extension —
// NOT node.properties.models, which is a download hint that is often stale.
function referencedFiles(workflow) {
  const refs = new Map(); // norm -> { name, nodes: [{type,id,bypassed}] }
  const record = (val, node) => {
    if (typeof val !== "string") return;
    if (SENTINELS.has(val.toLowerCase())) return;
    if (!MODEL_EXT.test(val)) return;
    const key = norm(val);
    if (!refs.has(key)) refs.set(key, { name: val, nodes: [] });
    refs.get(key).nodes.push({
      type: node.type,
      id: node.id,
      bypassed: node.mode === 2 || node.mode === 4,
    });
  };
  const walk = (v, node) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, node));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, node));
    else record(v, node);
  };
  if (Array.isArray(workflow.nodes)) {
    for (const node of workflow.nodes) {
      // `widgets_values` is POSITIONAL and this script has no object_info, so it
      // cannot map a slot index back to a widget name. It can still decide the
      // question safely by ARITY: if every model-extension string on the node is
      // accounted for by a linked model widget, all of them are link-supplied.
      //
      // When the counts DISAGREE the node is ambiguous (e.g. a DualCLIPLoader
      // with clip_name1 linked and clip_name2 typed in) and we scan it in full.
      // That direction is deliberate: an ambiguous node yields a false POSITIVE
      // the author can silence explicitly, whereas guessing would yield a false
      // NEGATIVE — a genuinely missing model, silently unreported.
      const modelStrings = countModelStrings(node.widgets_values);
      if (modelStrings > 0 && modelStrings <= linkedAssetWidgetCount(node)) continue;
      walk(node.widgets_values, node);
    }
  } else {
    // API/prompt-format workflow: { "<id>": { class_type, inputs } }. Scan only
    // scalar input values (link references are [nodeId, slot] arrays, but a
    // string filename can't be confused with one).
    for (const [id, node] of Object.entries(workflow)) {
      if (!node || typeof node !== "object" || !node.class_type) continue;
      walk(node.inputs, { type: node.class_type, id, mode: 0 });
    }
  }
  return refs;
}

let errors = 0;
let warnings = 0;

for (const dir of packDirs()) {
  const name = basename(dir);
  const manifest = parse(readFileSync(join(dir, "manifest.yaml"), "utf8")) || {};
  const packPath = join(dir, "pack.yaml");
  const pack = existsSync(packPath) ? parse(readFileSync(packPath, "utf8")) || {} : {};
  const wfFile = pack.workflow || "workflow.json";
  const wfPath = join(dir, wfFile);
  if (!existsSync(wfPath)) {
    console.log(`SKIP ${name} — no ${wfFile}`);
    continue;
  }

  const provided = providedFiles(manifest);
  const referenced = referencedFiles(JSON.parse(readFileSync(wfPath, "utf8")));
  // Files the workflow legitimately references but the pack intentionally does
  // not download (user-supplied LoRAs, etc.). Declared in pack.yaml so the gap
  // is explicit and reviewed, not silent. Compared by basename.
  const allowed = new Set((pack.external_models || []).map(norm));

  // An ACTIVE loader pointing at a file the manifest doesn't provide is a hard
  // error (ComfyUI flags it missing on load). The same from a bypassed node, a
  // self-managing node, or an allow-listed file is a warning at most.
  const hardMissing = [];
  const softMissing = [];
  for (const [key, info] of referenced) {
    if (provided.has(key)) continue;
    if (allowed.has(key)) continue;
    const liveLoaders = info.nodes.filter((n) => !n.bypassed && !isSelfManaging(n.type));
    (liveLoaders.length ? hardMissing : softMissing).push(info);
  }
  // Dead downloads: provided but no loader references them. Often intentional
  // (alt quants, optional upscalers), so this is a warning, not an error.
  const unused = [];
  for (const [key, disp] of provided) {
    if (!referenced.has(key)) unused.push(disp);
  }

  if (hardMissing.length === 0) {
    console.log(`OK   ${name} — ${referenced.size} model refs, no live gaps`);
  }
  for (const info of hardMissing) {
    const where = info.nodes
      .map((n) => `${n.type}#${n.id}${n.bypassed ? "(bypassed)" : ""}`)
      .join(", ");
    console.error(`FAIL ${name} — workflow references "${info.name}" not downloaded by manifest [${where}]`);
    errors++;
  }
  for (const info of softMissing) {
    console.warn(`warn ${name} — "${info.name}" referenced only by bypassed/self-managing nodes, not in manifest`);
    warnings++;
  }
  for (const disp of unused) {
    console.warn(`warn ${name} — manifest downloads "${disp}" but no loader references it`);
    warnings++;
  }
}

console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
