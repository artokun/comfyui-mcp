/**
 * Emit the tool vocabulary as JSON, for consumers that cannot import TypeScript.
 *
 *   npm run vocab:export             # rewrite the committed artefact
 *   npm run vocab:export -- --check  # fail if it is stale (CI)
 *
 * The consumer that matters is the PANEL, whose browser JS calls core tools by
 * string literal — `callTool("download_model")` — and names panel tools inside
 * hint strings. Nothing type-checks either, so a rename in this repo ships a
 * panel whose buttons fail at runtime with a tool-not-found the user reads as
 * "the panel is broken". The panel vendors this file and validates every literal
 * against it, which turns that class of break into a red build here rather than a
 * bug report there.
 *
 * Deliberately NOT recorded: the git commit, and — after CI taught me the lesson twice
 * — the package VERSION either. An artefact that embeds its own commit can never be
 * verified as current, because writing it changes HEAD. The version is a milder case of
 * exactly the same flaw: it makes the artefact stale on every RELEASE even when the
 * vocabulary is untouched. That is precisely what happened — main released 0.48.10 while
 * this branch was open, and CI failed with a diff whose only line was
 * `-"mcpVersion": "0.48.6" / +"0.48.10"` while `counts.core` sat unchanged at 181. A gate
 * that cries wolf on every release gets muted.
 *
 * Provenance is a HASH OF THE VOCABULARY ITSELF, which is stable across releases and
 * changes exactly when the thing it identifies changes. It is also the better primitive
 * for the Phase 7 handshake: a server can report its vocabularyHash at runtime and the
 * panel can compare, which a version string can never do reliably (two builds of 0.48.10
 * could differ, and two vocabularies with different versions could be identical).
 *
 * `core` is the LEDGER (src/tools/vocabulary.ts), not a live probe: this file is
 * about what the vocabulary is DECLARED to be, and registry-surface.test.ts is
 * what proves the running server matches. `panel` has no ledger of its own — it is
 * read live from buildPanelToolDefs() until the canvas_* consolidation gives it one,
 * so an accidental panel rename regenerates cleanly HERE and this script will never
 * flag it.
 *
 * That is a statement about THIS script, not about the repo. check-tool-vocabulary.mts
 * closes it from both sides against the frozen docs/design/panel-surface.txt:
 * `panelRetiredNotDeclared` (baseline \ live ⊆ DEAD_NAMES) catches the old name
 * vanishing without a DEAD_NAMES entry, and `panelMissingFromBaseline` (live ⊆
 * baseline) catches the new name appearing without joining the ratchet. A rename
 * trips both. Said plainly because the older wording here read as "panel renames are
 * unguarded" and cost a later reader a re-implementation of a ratchet that exists.
 *
 * What `--check` proves is narrow, and worth stating so it is not over-trusted: the
 * committed artefact matches this repo's ledger. It says nothing about whether the
 * PANEL's vendored copy is current (nothing cross-repo can, short of the Phase 7
 * runtime handshake), and nothing about schemas, descriptions, annotations or
 * handlers, which can all change while every name stays identical.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeVocabularyHash, DEAD_NAMES, MAX_TOOLS, TOOL_NAMES } from "../src/tools/vocabulary.js";
import { CALL_TOOL_WHITELIST } from "../src/orchestrator/call-tool-admission.js";
import { buildPanelToolDefs } from "../src/orchestrator/panel-tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "docs", "design", "tool-vocabulary.json");
const check = process.argv.slice(2).includes("--check");

const panel = buildPanelToolDefs().map((d) => d.name);

// Rejected HERE, at the point the names are collected, because every consumer downstream
// puts them in a Set — the exporter, both vocabulary gates, the panel's own checks — so a
// duplicate definition is invisible to all of them and then throws
// "Tool <name> is already registered" out of the real SDK when the per-tab HTTP panel
// server starts. Passing every gate and failing at startup is the worst available order.
{
  const seen = new Set<string>();
  const dupes = [...new Set(panel.filter((n) => (seen.has(n) ? true : (seen.add(n), false))))];
  if (dupes.length > 0) {
    console.error(
      `[vocab:export] buildPanelToolDefs() returns duplicate tool name(s): ${dupes.join(", ")}.\n` +
        `The MCP SDK throws "Tool <name> is already registered", so this would break the\n` +
        `per-tab HTTP panel server at startup. Remove the duplicate definition.`,
    );
    process.exit(1);
  }
}

const core = [...TOOL_NAMES];
const panelSorted = [...panel].sort();
const dead = DEAD_NAMES.map((d) => ({ name: d.name, since: d.since, replacement: d.replacement }));

/** Identifies the VOCABULARY, not the build that produced it.
 *
 *  Computed by computeVocabularyHash() in src/tools/vocabulary.ts rather than
 *  inline here, because the RUNTIME handshake compares against this value. Two
 *  copies of the rule would drift, and a drifted hash reports a mismatch that is
 *  not real — which is worse than having no check at all. */
const vocabularyHash = computeVocabularyHash({
  core,
  panel: panelSorted,
  dead: dead.map((d) => d.name),
});

const artefact = {
  $comment:
    "GENERATED by scripts/export-vocabulary.mts — do not edit by hand. Run `npm run vocab:export`. " +
    "Vendored by comfyui-mcp-panel, whose browser JS calls these names as string literals.",
  vocabularyHash,
  maxTools: MAX_TOOLS,
  counts: { core: TOOL_NAMES.length, panel: panel.length, dead: DEAD_NAMES.length },
  /** Core MCP tools, in registration order. */
  core,
  /** Panel agent tools, sorted — registration order is not observable for these. */
  panel: panelSorted,
  /** Removed names, with what to use instead. `allowedIn` is repo-local and omitted. */
  dead,
  /**
   * Core tools the DIRECT `call_tool` channel will admit — the canvas-less path
   * mobile, mirrored tabs and the panel's own buttons use.
   *
   * Exists because #908: PR #278 correctly removed pod create/start (now
   * `runpod` actions) from that channel (both start BILLING, and a
   * confirmation-less mirrored tab must not spend money), but the panel's
   * cmcp-runpod-ui.js kept calling them over exactly that channel. Both buttons
   * were inert for about two weeks, returning a bare "not permitted". Each repo
   * was correct alone; nothing could see across the seam.
   *
   * Publishing the admitted set lets the panel gate its OWN call sites the same
   * way it already gates retired names — at build time, instead of a user
   * discovering it by clicking a dead button.
   *
   * NOT part of `vocabularyHash`, deliberately. The hash identifies which tools
   * EXIST; admission is a separate question about one channel, and folding it in
   * would invalidate every vendored copy on a policy change that renamed nothing.
   */
  directCallable: [...CALL_TOOL_WHITELIST].sort(),
};

const serialized = `${JSON.stringify(artefact, null, 2)}\n`;

if (check) {
  let current: string | undefined;
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    console.error(`[vocab:export] ${outPath} is missing — run \`npm run vocab:export\`.`);
    process.exit(1);
  }
  if (current !== serialized) {
    console.error(
      `[vocab:export] docs/design/tool-vocabulary.json is STALE.\n` +
        `The vocabulary changed but the artefact the panel vendors did not, so the panel would\n` +
        `keep validating its callTool() literals against the old surface.\n` +
        `Fix: npm run vocab:export && commit, then re-vendor it into comfyui-mcp-panel.\n`,
    );
    // A unified diff of the two name lists is far more useful than "files differ".
    // The scratch file goes to the OS temp dir, never inside docs/: the CI docs
    // gate runs `git add --intent-to-add -A docs/`, so a stray file there would be
    // reported as an uncommitted generated page.
    const tmp = join(mkdtempSync(join(tmpdir(), "comfyui-mcp-vocab-")), "expected.json");
    try {
      writeFileSync(tmp, serialized);
      execFileSync("git", ["--no-pager", "diff", "--no-index", "--", outPath, tmp], {
        stdio: "inherit",
      });
    } catch {
      /* git diff --no-index exits 1 when files differ; the diff itself already printed */
    } finally {
      rmSync(dirname(tmp), { recursive: true, force: true });
    }
    process.exit(1);
  }
  console.error(
    `[vocab:export] OK — artefact matches the ledger ` +
      `(${artefact.counts.core} core, ${artefact.counts.panel} panel, ${artefact.counts.dead} dead).`,
  );
} else {
  writeFileSync(outPath, serialized);
  console.error(
    `[vocab:export] wrote docs/design/tool-vocabulary.json ` +
      `(${artefact.counts.core} core, ${artefact.counts.panel} panel, ${artefact.counts.dead} dead) ` +
      `vocabularyHash ${vocabularyHash.slice(0, 12)}…`,
  );
}
