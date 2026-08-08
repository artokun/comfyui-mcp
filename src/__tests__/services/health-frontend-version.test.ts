// panel#779 — the health check reported the ComfyUI version and not the FRONTEND
// version, and the frontend version was the whole answer.
//
// A blank agent panel on a fresh install. ComfyUI 0.30.0 on the broken machine,
// 0.30.2 on the working one — near-identical, and not the variable. The frontend
// package was 1.50.3 vs 1.47.12, and pinning it fixed the machine. The reporter
// had to be asked for that number after an hour of eliminating everything else,
// because nothing we ship surfaced it.
//
// /system_stats reports it. Nothing in src read it. The fixtures below are the
// REAL shape, captured from a live ComfyUI 0.30.2.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "..", "services", "health-check.ts"),
  "utf8",
);

/** Load describeFrontendVersion out of the module under test. */
async function load() {
  const mod: any = await import("../../services/health-check.js");
  // Not exported (it is an implementation detail of one line of output), so the
  // behaviour is asserted through the source plus the shape checks below.
  return mod;
}

/** The real /system_stats shape — note both fields live under `system`. */
const LIVE = {
  system: {
    os: "nt",
    comfyui_version: "0.30.2",
    required_frontend_version: "1.47.12",
    comfy_package_versions: [
      { name: "comfyui-frontend-package", installed: "1.47.12", required: "1.47.12" },
      { name: "comfyui-workflow-templates", installed: "0.11.31", required: "0.11.31" },
    ],
    python_version: "3.12.9 (main)",
    pytorch_version: "2.9.1",
  },
  devices: [{ name: "cuda:0", vram_total: 1, vram_free: 1 }],
};

describe("#779 the health check surfaces the FRONTEND version", () => {
  it("reads both fields from under `system`, where they actually are", () => {
    // The first draft read them off the top level and silently produced "?" on a
    // server that reports them perfectly well. Caught by querying a live ComfyUI
    // rather than trusting the shape.
    expect(SRC).toMatch(/stats\?\.system\?\.comfy_package_versions/);
    expect(SRC).toMatch(/stats\?\.system\?\.required_frontend_version/);
  });

  it("prints the frontend version on the ComfyUI line", () => {
    expect(SRC).toMatch(/frontend \$\{describeFrontendVersion\(stats\)\}/);
  });

  it("names comfyui-frontend-package, not some other package", () => {
    expect(SRC).toMatch(/"comfyui-frontend-package"/);
  });

  it("DISCLOSES a pin: installed differing from required is the #779 situation", () => {
    // `--front-end-version …@1.47.12` was the fix on the reporter's machine. A
    // health check that hid the override would hide the remedy.
    expect(SRC).toMatch(/pinned or overridden/);
    expect(SRC).toMatch(/installed && required && installed !== required/);
  });

  it('answers "?" rather than inventing a version', () => {
    // An unknown version must not read as an absent problem — that collapse is
    // the tracked defect class (#796).
    expect(SRC).toMatch(/installed \?\? required \?\? "\?"/);
  });

  it("the live fixture proves the shape this depends on", () => {
    const pkgs = LIVE.system.comfy_package_versions;
    const fe = pkgs.find((p) => p.name === "comfyui-frontend-package");
    expect(fe?.installed).toBe("1.47.12");
    expect(LIVE.system.required_frontend_version).toBe("1.47.12");
    // and NOT at the top level, which is what the first draft assumed
    expect((LIVE as any).comfy_package_versions).toBeUndefined();
  });

  it("the module still loads", async () => {
    const mod = await load();
    expect(typeof mod.runHealthCheck).toBe("function");
  });
});
