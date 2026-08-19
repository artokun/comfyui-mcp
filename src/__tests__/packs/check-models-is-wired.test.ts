// #1767 — `packs:check-models` existed for months and was run by NOTHING: not
// CI, not the release workflow. Three packs shipped workflows referencing weights
// their manifest never downloaded, and the gate that would have caught it sat
// unexecuted in package.json.
//
// Wiring a gate in is a one-line change that no helper-level test can see, so
// this file asserts on the WIRING itself: the step exists, it invokes the script
// that actually exists, and the workflow's `paths` filter includes the gate's own
// source — otherwise editing the gate would not run the gate.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE_SCRIPT = "scripts/check-pack-models.mjs";
const NPM_SCRIPT = "packs:check-models";

type Workflow = {
  on?: { push?: { paths?: string[] }; pull_request?: { paths?: string[] } };
  jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
};

const workflowPath = join(repoRoot, ".github", "workflows", "packs.yml");
const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
const steps = Object.values(workflow.jobs ?? {}).flatMap((j) => j.steps ?? []);
const runLines = steps.map((s) => s.run ?? "").join("\n");

describe("#1767 the packs gate is actually executed", () => {
  it("parses packs.yml into steps to scan (guards a vacuous pass)", () => {
    expect(steps.length).toBeGreaterThan(0);
    // Sanity: the sibling gates this workflow already ran are still here, so a
    // parse that silently produced the wrong shape cannot look like a pass.
    expect(runLines).toContain("packs:validate");
  });

  it("the gate script it invokes exists on disk", () => {
    expect(existsSync(join(repoRoot, GATE_SCRIPT))).toBe(true);
  });

  it("package.json still defines the npm script CI calls", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[NPM_SCRIPT]).toBeDefined();
    // The npm script must point at the file above, or the two drift apart.
    expect(pkg.scripts?.[NPM_SCRIPT]).toContain("check-pack-models.mjs");
  });

  it("a packs.yml step runs it", () => {
    expect(runLines).toContain(`npm run ${NPM_SCRIPT}`);
  });

  // The defect this pins: a gate whose own source is missing from `paths` is
  // skipped by the very change most likely to break it.
  it.each(["push", "pull_request"] as const)("the %s paths filter includes the gate's own source", (event) => {
    const paths = workflow.on?.[event]?.paths;
    expect(paths, `on.${event}.paths is missing`).toBeDefined();
    expect(paths).toContain(GATE_SCRIPT);
  });

  it("the paths filter also covers the pack files the gate reads", () => {
    for (const event of ["push", "pull_request"] as const) {
      expect(workflow.on?.[event]?.paths).toContain("packs/**");
    }
  });
});
