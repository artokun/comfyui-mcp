import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalManifestOutcomeTarget,
  configureManifestOutcomeReader,
  publishManifestOutcome,
  readPublishedManifestOutcomes,
  resetManifestOutcomeReader,
} from "../../services/manifest-outcome-channel.js";
import { buildManifestPartial } from "../../services/manifest-partial.js";

const TARGET = "http://127.0.0.1:8188";
const SECRET = "child-secret-for-1129";

function partial(id = "https://github.com/example/slow-pack") {
  const value = buildManifestPartial({
    source: "this inline manifest",
    notStarted: [],
    stillInstalling: [id],
    outcomeUnknown: [id],
  });
  if (!value) throw new Error("expected partial fixture");
  return value;
}

describe("manifest outcome cross-process channel (#1129)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmcp-manifest-outcome-"));
    resetManifestOutcomeReader();
  });

  it("publishes a child outcome that the configured orchestrator reader can consume", () => {
    expect(
      publishManifestOutcome(partial(), {
        dir,
        secret: SECRET,
        scope: "orchestrator::codex",
        target: TARGET,
      }),
    ).toBe(true);
    configureManifestOutcomeReader(dir, () => [SECRET]);

    expect(readPublishedManifestOutcomes(TARGET)).toEqual([partial()]);
  });

  it("publishes through the real stdio-child environment boundary", () => {
    const value = partial();
    const childSource = `
      import { publishManifestOutcome } from "./src/services/manifest-outcome-channel.ts";
      const ok = publishManifestOutcome(${JSON.stringify(value)});
      if (!ok) process.exitCode = 1;
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", childSource],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          COMFYUI_MCP_PROGRESS_DIR: dir,
          COMFYUI_MCP_MANIFEST_OUTCOME_SECRET: SECRET,
          COMFYUI_MCP_TAB: "orchestrator::codex",
          COMFYUI_URL: TARGET,
        },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    expect(child.status, child.stderr).toBe(0);

    configureManifestOutcomeReader(dir, () => [SECRET]);
    expect(readPublishedManifestOutcomes(TARGET)).toEqual([value]);
  });

  it("rejects forged, stale-target, and malformed records before annotation", () => {
    expect(
      publishManifestOutcome(partial(), {
        dir,
        secret: SECRET,
        scope: "orchestrator::codex",
        target: TARGET,
      }),
    ).toBe(true);
    const file = join(dir, "cmcp-manifest-outcome-unknown.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        scope: "attacker",
        target: TARGET,
        updated: Date.now(),
        partial: partial("../../outside"),
        signature: "0".repeat(64),
      }),
    );
    configureManifestOutcomeReader(dir, () => [SECRET]);

    expect(readPublishedManifestOutcomes("http://127.0.0.1:8189")).toEqual([]);
    expect(readPublishedManifestOutcomes(TARGET)).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toContain("attacker");
  });

  it("removes the child record when the outcome settles", () => {
    publishManifestOutcome(partial(), { dir, secret: SECRET, target: TARGET });
    configureManifestOutcomeReader(dir, () => [SECRET]);
    expect(readPublishedManifestOutcomes(TARGET)).toHaveLength(1);

    expect(publishManifestOutcome(null, { dir, secret: SECRET, target: TARGET })).toBe(true);
    expect(readPublishedManifestOutcomes(TARGET)).toEqual([]);
  });

  it("canonicalizes only safe HTTP target identities", () => {
    expect(canonicalManifestOutcomeTarget("http://127.0.0.1:8188/")).toBe(TARGET);
    expect(canonicalManifestOutcomeTarget("http://user:pass@127.0.0.1:8188")).toBeNull();
    expect(canonicalManifestOutcomeTarget("http://127.0.0.1:8188/?token=secret")).toBeNull();
  });

  afterEach(() => {
    resetManifestOutcomeReader();
    rmSync(dir, { recursive: true, force: true });
  });
});
