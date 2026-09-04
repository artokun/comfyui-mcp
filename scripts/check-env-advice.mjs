#!/usr/bin/env node
/**
 * Fail the build when a message tells the user to set an env var that the
 * orchestrator DELETES from its own `process.env` (#2849).
 *
 * `runPanelOrchestrator()` unsets ANTHROPIC_API_KEY at startup so the Claude SDK
 * subprocess authenticates against the user's claude.ai login instead of a key.
 * That is correct. What was not correct is that three of its own messages went on
 * naming that variable as the remedy — one of them beside "restart the
 * orchestrator", which is precisely the step that re-runs the delete. A blocked
 * user follows the advice, restarts, and gets the identical message. Nothing
 * restores it: the dotenv store only fills UNSET keys and runs at import time, the
 * panel secret allowlist omits it, and there is no `anthropic` credential slot.
 *
 * SCOPE — the orchestrator only, and this is the whole subtlety.
 *
 * The delete governs THAT process's messages. It does not govern the comfyui MCP
 * child, a separate process with TWO lanes. Spawned by the panel, the child gets a
 * CONSTRUCTED env (panel-secrets.ts: "the orchestrator constructs the child env
 * instead of inheriting it") whose allowlist omits the key, so the advice is dead.
 * Run standalone from the user's own MCP client, it inherits the real shell env
 * and the SAME advice is correct. A repo-wide version of this gate would demand
 * deleting guidance that standalone users need.
 *
 * Import reachability does NOT separate the two — the orchestrator imports
 * src/tools/train.ts for its tool catalog while the tool EXECUTES in the child —
 * so the split is drawn by process here, and the child's messages are made
 * lane-aware at runtime instead (the COMFYUI_MCP_TAB branch in train-caption.ts).
 *
 * The signature is exact, so this is a scan and not a heuristic:
 *   deleted = `delete process.env.NAME` anywhere in this process's module graph
 *   advised = NAME inside a string long enough to be prose, not a bare key
 * Only a name that is both is reported, so there is no allowlist here to drift.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stringLiterals } from "./lib/ts-string-literals.mjs";

const allTracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
const allSources = allTracked.filter(
  (f) => f.startsWith("src/") && f.endsWith(".ts") && !f.includes("__tests__"),
);

/** Advice is checked here — the process that performs the delete. */
const scoped = allSources.filter((f) => f.startsWith("src/orchestrator/"));

/** Deletes are searched repo-wide: any of them unsets the var for this process. */
const everything = allSources.map((f) => readFileSync(f, "utf8")).join("\n");
// Dot AND bracket access. `delete process.env["ANTHROPIC_API_KEY"]` is the same
// delete, and matching only the dot form meant a harmless syntax refactor would
// empty this set and let the gate report success while the advice it guards was
// still shipping. A gate that a rename can silence is not a gate.
const deleted = new Set([
  ...[...everything.matchAll(/delete\s+process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]),
  ...[...everything.matchAll(/delete\s+process\.env\[\s*["'\`]([A-Z_][A-Z0-9_]*)["'\`]\s*\]/g)].map(
    (m) => m[1],
  ),
]);

/**
 * Prose, not a bare key. The shortest real finding was 92 chars and the longest
 * non-finding (an entry in a credential-name table) is 17, so 40 sits well clear
 * of both rather than being tuned to the current tree.
 */
const PROSE_MIN = 40;

const findings = [];
for (const file of scoped) {
  for (const lit of stringLiterals(readFileSync(file, "utf8"))) {
    if (lit.text.length < PROSE_MIN) continue;
    for (const name of deleted) {
      if (lit.text.includes(name)) {
        findings.push({ file, at: `:${lit.line}`, name, text: lit.text.replace(/\s+/g, " ") });
      }
    }
  }
}

/**
 * The CATALOGS matter as much as the source, and this is not belt-and-braces.
 *
 * `tr(key, fallback)` resolves the catalog FIRST and the in-source fallback only
 * on a miss, so a corrected fallback changes nothing for any user whose locale
 * carries the key — including `en`, which every English user resolves through.
 * Fixing #2849 in TypeScript alone left the dead advice live in all twelve
 * locales while the source read clean and `i18n:check` stayed green, because that
 * check compares key COUNTS, not meaning.
 *
 * Every catalog value is scanned rather than just orchestrator keys: the catalog
 * is one flat namespace with no marker for which process renders a string.
 */
const localeFiles = allTracked.filter((f) => /^locales\/[^/]+\/main\.json$/.test(f));
for (const file of localeFiles) {
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node ?? {})) {
      const at = path ? `${path}.${k}` : k;
      if (typeof v === "string") {
        if (v.length < PROSE_MIN) continue;
        for (const name of deleted) {
          if (v.includes(name)) {
            findings.push({ file, at: ` ${at}`, name, text: v.replace(/\s+/g, " ") });
          }
        }
      } else if (v && typeof v === "object") {
        walk(v, at);
      }
    }
  };
  walk(JSON.parse(readFileSync(file, "utf8")), "");
}

if (findings.length === 0) {
  console.log(
    `check:env-advice: ${deleted.size} env var(s) unset at startup, none named as a ` +
      `remedy across ${scoped.length} orchestrator file(s) and ${localeFiles.length} locale catalog(s)`,
  );
  process.exit(0);
}

console.error("[check:env-advice] FAIL\n");
console.error(`${findings.length} message(s) advise setting an env var this process DELETES:\n`);
for (const f of findings) {
  const at = f.text.indexOf(f.name);
  console.error(`  ${f.file}${f.at}  ${f.name}`);
  console.error(`    …${f.text.slice(Math.max(0, at - 45), at + f.name.length + 45)}…`);
}
console.error(
  `\nSetting it cannot take effect — the delete runs at startup and nothing\n` +
    `restores it. Name a remedy that works instead: the OTHER keys in the same\n` +
    `sentence are usually fine, and the login flows always are.\n\n` +
    `A locale hit needs the same edit in locales/<lang>/main.json — the catalog\n` +
    `WINS over the in-source fallback, so fixing only the source changes nothing.\n` +
    `Regenerate locales/en/main.json with \`npm run i18n:build\`.\n\n` +
    `If a name here is prose ABOUT the deletion rather than advice, move it into a\n` +
    `comment (this scanner ignores comments) instead of weakening the gate.`,
);
process.exit(1);
