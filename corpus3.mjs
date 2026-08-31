// Re-measurement after the codex revision. Same 533 official ComfyUI templates,
// but the predicate now mirrors set_steps exactly: int(steps/denoise) > steps,
// plus the "source consumes no links" requirement.
//
// Self-checking as before: only core KSampler nodes with the exact 7-widget shape
// [seed, control, steps, cfg, sampler_name, scheduler, denoise] are judged, and
// shape mismatches are COUNTED so a broken parser cannot masquerade as a clean zero.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2];
const EMPTY_LATENT_RE = /^Empty[A-Za-z0-9_]*Latent/i;

function startsBelowSigmaMax(denoise, steps) {
  if (denoise <= 0) return true;
  if (denoise > 0.9999) return false;
  if (typeof steps !== "number" || !Number.isFinite(steps) || steps <= 0) return false;
  return Math.trunc(steps / denoise) > steps;
}

function evaluate(graph) {
  const byId = new Map();
  for (const n of graph.nodes ?? []) byId.set(n.id, n);
  const linkOrigin = new Map();
  for (const l of graph.links ?? []) if (Array.isArray(l) && l.length >= 3) linkOrigin.set(l[0], l[1]);

  let judged = 0, unparsed = 0, subOne = 0, truncating = 0;
  const fired = [];
  for (const n of graph.nodes ?? []) {
    if (n.type !== "KSampler") continue;
    const w = n.widgets_values;
    const shapeOk =
      Array.isArray(w) && w.length === 7 && typeof w[2] === "number" &&
      typeof w[4] === "string" && typeof w[5] === "string" && typeof w[6] === "number";
    if (!shapeOk) { unparsed++; continue; }
    judged++;
    const steps = w[2], denoise = w[6];
    if (denoise <= 0.9999) subOne++;
    if (!startsBelowSigmaMax(denoise, steps)) continue;
    truncating++;
    const slot = (n.inputs ?? []).find((i) => i.name === "latent_image");
    if (!slot || slot.link == null) continue;
    const originId = linkOrigin.get(slot.link);
    const src = byId.get(originId);
    if (!src || !EMPTY_LATENT_RE.test(src.type)) continue;
    // "source consumes no links": in UI format, any input slot with a link.
    if ((src.inputs ?? []).some((i) => i.link != null)) continue;
    fired.push(`node ${n.id} steps=${steps} denoise=${denoise} <- ${originId} (${src.type})`);
  }
  return { judged, unparsed, subOne, truncating, fired };
}

let files = 0, graphs = 0, judged = 0, unparsed = 0, subOne = 0, truncating = 0, badJson = 0;
const hits = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
  files++;
  let j;
  try { j = JSON.parse(readFileSync(join(DIR, f), "utf-8")); } catch { badJson++; continue; }
  if (!j?.nodes) continue;
  graphs++;
  const r = evaluate(j);
  judged += r.judged; unparsed += r.unparsed; subOne += r.subOne; truncating += r.truncating;
  for (const h of r.fired) hits.push(`${f}  ${h}`);
}

console.log(`template files                 : ${files}  (unparseable JSON: ${badJson})`);
console.log(`UI graphs read                 : ${graphs}`);
console.log(`core KSampler nodes judged     : ${judged}  (skipped, shape mismatch: ${unparsed})`);
console.log(`  ...denoise <= 0.9999         : ${subOne}`);
console.log(`  ...actually truncating       : ${truncating}`);
console.log(`FALSE POSITIVES                : ${hits.length}`);
for (const h of hits) console.log("  ! " + h);

// Controls -- a zero above is meaningless if the evaluator cannot fire.
const mk = (steps, denoise, srcType = "EmptyLatentImage", srcInputs = []) => ({
  nodes: [
    { id: 8, type: srcType, widgets_values: [1024, 1024, 1], inputs: srcInputs },
    { id: 9, type: "KSampler", widgets_values: [42, "fixed", steps, 4, "euler", "simple", denoise], inputs: [{ name: "latent_image", link: 143 }] },
  ],
  links: [[143, 8, 0, 9, 3, "LATENT"]],
});
const chk = (label, g, want) => {
  const n = evaluate(g).fired.length;
  console.log(`${n === want ? "PASS" : "FAIL"}  ${label}  (fired ${n}, expected ${want})`);
};
console.log("");
chk("positive: #2678 shape steps=50 denoise=0.65", mk(50, 0.65), 1);
chk("negative: same graph at denoise 1.0", mk(50, 1.0), 0);
chk("negative: steps=50 denoise=0.9999 (full schedule)", mk(50, 0.9999), 0);
chk("negative: steps=4 denoise=0.9 (full schedule)", mk(4, 0.9), 0);
chk("positive: steps=50 denoise=0.98 (int=51, truncates)", mk(50, 0.98), 1);
chk("negative: Empty*-named source that consumes a link", mk(50, 0.65, "EmptyLatentFromReference", [{ name: "reference", link: 7 }]), 0);
