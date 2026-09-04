#!/usr/bin/env node
/**
 * Fail the build when an orchestrator message tells the user to set an env var
 * that the orchestrator DELETES from its own `process.env` (#2849).
 *
 * `runPanelOrchestrator()` unsets ANTHROPIC_API_KEY at startup so the Claude SDK
 * subprocess authenticates against the user's claude.ai login instead of a key.
 * That is correct. What was not correct is that three of its own messages went on
 * naming that variable as the remedy — so a user who is already blocked sets the
 * first thing suggested, restarts as one message explicitly instructs, and gets
 * the identical message with no signal that this variable can never take effect.
 * Nothing restores it: the dotenv store only fills UNSET keys and runs at import
 * time, the panel's secret allowlist omits it, and there is no `anthropic`
 * credential slot.
 *
 * SCOPE — the orchestrator only, and this is the whole subtlety.
 *
 * The delete governs THAT process's messages. It does not govern the comfyui MCP
 * child, a separate process with TWO lanes. Spawned by the panel, the child gets a
 * CONSTRUCTED env (panel-secrets.ts: "the orchestrator constructs the child env
 * instead of inheriting it") whose allowlist omits the key, so the advice is dead.
 * Run standalone from the user's own MCP client it inherits the real shell env and
 * the SAME advice is correct. A repo-wide version of this gate would demand
 * deleting guidance that is right for standalone users.
 *
 * Import reachability does NOT separate the two — the orchestrator imports
 * src/tools/train.ts for its tool catalog while the tool EXECUTES in the child —
 * so the split is by process, drawn here, and the child's messages are made
 * lane-aware at runtime instead (the COMFYUI_MCP_TAB branch in train-caption.ts).
 *
 * The signature is exact, so this is a scan and not a heuristic:
 *   deleted = `delete process.env.NAME` anywhere in this process's module graph
 *   advised = NAME inside a string literal long enough to be prose, not a bare key
 * Only a name that is both is reported, so there is no allowlist here to drift.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stringLiterals } from "./lib/ts-string-literals.mjs";

const allFiles = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".ts") && !f.includes("__tests__"));

/** Advice is checked here — the process that performs the delete. */
const scoped = allFiles.filter((f) => f.startsWith("src/orchestrator/"));

/** Deletes are searched repo-wide: any of them unsets the var for this process. */
const everything = allFiles.map((f) => readFileSync(f, "utf8")).join("\n");
const deleted = new Set(
  [...everything.matchAll(/delete\s+process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]),
);

/**
 * Prose, not a bare key. The shortest real finding was 92 chars and the longest
 * non-finding (an entry in a credential-name table) is 17, so 40 sits well clear
 * of both edges rather than being tuned to the current tree.
 */
const PROSE_MIN = 40;

const findings = [];
for (const file of scoped) {
  for (const lit of stringLiterals(readFileSync(file, "utf8"))) {
    if (lit.text.length < PROSE_MIN) continue;
    for (const name of deleted) {
      if (lit.text.includes(name)) {
        findings.push({ file, line: lit.line, name, text: lit.text.replace(/\s+/g, " ") });
      }
    }
  }
}

if (findings.length === 0) {
  console.log(
    `check:env-advice: ${deleted.size} env var(s) unset at startup, ` +
      `none named as a remedy across ${scoped.length} orchestrator file(s)`,
  );
  process.exit(0);
}

console.error("[check:env-advice] FAIL\n");
console.error(`${findings.length} message(s) advise setting an env var this process DELETES:\n`);
for (const f of findings) {
  const at = f.text.indexOf(f.name);
  console.error(`  ${f.file}:${f.line}  ${f.name}`);
  console.error(`    …${f.text.slice(Math.max(0, at - 45), at + f.name.length + 45)}…`);
}
console.error(
  `\nSetting it cannot take effect — the delete runs at startup and nothing\n` +
    `restores it. Name a remedy that works instead: the OTHER keys in the same\n` +
    `sentence are usually fine, and the login flows always are.\n\n` +
    `If a name here is prose ABOUT the deletion rather than advice, move it into a\n` +
    `comment (this scanner ignores comments) instead of weakening the gate.`,
);
process.exit(1);
