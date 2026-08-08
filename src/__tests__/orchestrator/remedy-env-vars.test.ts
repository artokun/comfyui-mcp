// panel#769 — the restart refusal recommends a remedy, and nothing proved the
// remedy works.
//
// `panel_restart_comfyui` refuses on a tunnelled remote (a loopback host that is
// not this machine) and tells the reader:
//
//     Set COMFYUI_MCP_FORCE_REMOTE=1 (or pass --force-remote) and this tool takes
//     the remote path, which restarts through ComfyUI-Manager
//
// Two reporters were sent down that path. Nothing in the suite checked either
// half: that the flag exists, or that setting it actually re-classifies a
// loopback target as remote. If the classification regressed, the message would
// go on confidently recommending a fix that no longer worked — and the reader has
// no way to tell the difference between bad advice and their own mistake.
//
// This file pins both, and generalizes the first: an env var named in ADVICE must
// be one the code actually reads.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.m?ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Every way the codebase actually consumes one of these. */
const READ_PATTERNS = [
  /process\.env\.(COMFYUI_MCP_[A-Z0-9_]+)/g,
  /process\.env\[\s*["'](COMFYUI_MCP_[A-Z0-9_]+)["']/g,
  // An injected env object — self-restart and tool-mode-policy both take one, so
  // requiring `process.env` would call their reads fabricated.
  /\benv\.(COMFYUI_MCP_[A-Z0-9_]+)/g,
  /\benv\[\s*["'](COMFYUI_MCP_[A-Z0-9_]+)["']/g,
  // A typed env-shape field: `COMFYUI_MCP_X?: string`.
  /^\s*(COMFYUI_MCP_[A-Z0-9_]+)\s*[?:]/gm,
];

const STRING_LITERAL = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/gs;

/**
 * Split every mention into a DECLARATION and a RECOMMENDATION.
 *
 * The rule that makes this work: a literal that is EXACTLY the name is the code
 * naming its own variable — `envNum("COMFYUI_MCP_OLLAMA_TOP_K")`,
 * `baseUrlEnv: "COMFYUI_MCP_GLM_BASE_URL"`, `export const X = "COMFYUI_MCP_..."`.
 * A name embedded in a longer sentence is advice to a human.
 *
 * Without that split the scan reports nine false positives on a clean tree —
 * every indirect read looks fabricated — and a check that cries wolf nine times
 * teaches its reader to ignore it.
 */
function scan() {
  const read = new Set<string>();
  const advice = new Map<string, Set<string>>();
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const text = readFileSync(file, "utf8");
    for (const re of READ_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) read.add(m[1]);
    }
    for (const lit of text.match(STRING_LITERAL) ?? []) {
      const inner = lit.slice(1, -1);
      if (/^\s*COMFYUI_MCP_[A-Z0-9_]+\s*$/.test(inner)) {
        read.add(inner.trim());
        continue;
      }
      for (const m of inner.matchAll(/COMFYUI_MCP_[A-Z0-9_]+/g)) {
        if (!advice.has(m[0])) advice.set(m[0], new Set());
        advice.get(m[0])!.add(`${rel}`);
      }
    }
  }
  return { read, advice };
}

describe("#769 an env var our messages RECOMMEND must be one the code reads", () => {
  it("finds both declarations and recommendations at all", () => {
    // Guards the scan itself: if the patterns stopped matching, every assertion
    // below would pass vacuously on an empty set.
    const { read, advice } = scan();
    expect(read.size).toBeGreaterThan(80);
    expect(advice.size).toBeGreaterThan(10);
  });

  it("no message names an env var that nothing consumes", () => {
    // A fabricated name in a remedy is indistinguishable from a real one to the
    // reader — they set it, nothing changes, and the tool keeps refusing with the
    // same advice. Verified to CATCH one: planting COMFYUI_MCP_PRETEND_REMOTE in
    // this exact refusal takes the count from 0 to 1.
    const { read, advice } = scan();
    const orphans = [...advice.entries()]
      .filter(([name]) => !read.has(name))
      .map(([name, files]) => `${name} (named in ${[...files].sort()[0]})`);
    expect(orphans, `advice names env var(s) nothing reads:\n${orphans.join("\n")}`).toEqual([]);
  });

  it("the restart refusal names FORCE_REMOTE, and config resolves it", () => {
    // The specific remedy two reporters were sent to. Both halves, because either
    // one rotting on its own is enough to strand them.
    const panelTools = readFileSync(join(SRC, "orchestrator", "panel-tools.ts"), "utf8");
    expect(panelTools).toMatch(/COMFYUI_MCP_FORCE_REMOTE=1/);
    expect(panelTools).toMatch(/--force-remote/);

    const config = readFileSync(join(SRC, "config.ts"), "utf8");
    expect(config).toMatch(/argv\.includes\("--force-remote"\)/);
    expect(config).toMatch(/process\.env\.COMFYUI_MCP_FORCE_REMOTE/);
  });

  it("force-remote is what makes a LOOPBACK target classify as remote", () => {
    // The whole reason the refusal fires on a tunnelled pod: classification reads
    // the HOST, and a tunnel's host is 127.0.0.1. `forceRemote` is the only term
    // that can override it, so if this `||` were ever reordered or dropped the
    // remedy would silently stop working while still being recommended.
    const config = readFileSync(join(SRC, "config.ts"), "utf8");
    const assignments = config.match(/remoteUrlActive\s*=[\s\S]{0,120}?;/g) ?? [];
    expect(assignments.length, "the classification must be findable").toBeGreaterThan(0);
    for (const a of assignments) {
      expect(a, `a classification that ignores forceRemote strands a tunnelled remote:\n${a}`).toMatch(
        /forceRemote/,
      );
    }
  });
});
