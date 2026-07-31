import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";

// Guard (#441/#423 cluster): ComfyUI-Manager is an ENVIRONMENT prerequisite, not
// a per-pack custom-node dependency. Listing it in a pack manifest's custom_nodes
// causes install/verify churn (Manager reinstalling itself, verification loops).
// Every bundled pack manifest must therefore be free of a ComfyUI-Manager entry.
// This test FAILS before the sweep (52 manifests listed it) and PASSES after.

const packsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packs");
// Match ComfyUI-Manager only as the REPO BASENAME (last path segment) — a bare
// registry id, or a git URL/shorthand ending in the repo, with an optional
// `.git`, trailing slash, and `@ref`/`#ref`/`?query` suffix. Anchoring to the
// end of the segment avoids false positives where "ComfyUI-Manager" is merely an
// OWNER path segment of an unrelated repo (e.g. .../ComfyUI-Manager/SomeNode.git).
const MANAGER_RE = /(?:^|[/:])ComfyUI-Manager(?:\.git)?\/?(?:[@#?].*)?$/i;

function packManifests(): string[] {
  return readdirSync(packsRoot)
    .map((name) => join(packsRoot, name, "manifest.yaml"))
    .filter((p) => existsSync(p) && statSync(p).isFile());
}

describe("bundled pack manifests", () => {
  const manifests = packManifests();

  it("discovers the bundled manifests to scan", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it("guard regex matches only ComfyUI-Manager as the repo basename", () => {
    // Must flag (the forms that actually appear / could appear as a dep):
    for (const dep of [
      "https://github.com/ltdrdata/ComfyUI-Manager.git",
      "https://github.com/ltdrdata/ComfyUI-Manager",
      "https://github.com/ltdrdata/ComfyUI-Manager.git@v1.2.3",
      "https://github.com/ltdrdata/ComfyUI-Manager/",
      "ltdrdata/ComfyUI-Manager",
      "comfyui-manager",
    ]) {
      expect(MANAGER_RE.test(dep), `should flag: ${dep}`).toBe(true);
    }
    // Must NOT flag (unrelated repos where ComfyUI-Manager is an owner/prefix):
    for (const dep of [
      "https://github.com/ComfyUI-Manager/SomeOtherNode.git",
      "https://github.com/ltdrdata/ComfyUI-Manager-Extras.git",
      "https://github.com/someone/Not-ComfyUI-Manager-Really/nested.git",
    ]) {
      expect(MANAGER_RE.test(dep), `should NOT flag: ${dep}`).toBe(false);
    }
  });

  it("do not list ComfyUI-Manager as a custom-node dependency", () => {
    const offenders: string[] = [];
    for (const file of manifests) {
      const parsed = (parse(readFileSync(file, "utf8")) ?? {}) as {
        custom_nodes?: unknown;
      };
      const nodes = Array.isArray(parsed.custom_nodes)
        ? (parsed.custom_nodes as unknown[])
        : [];
      for (const node of nodes) {
        if (typeof node === "string" && MANAGER_RE.test(node)) {
          offenders.push(`${file} -> ${node}`);
        }
      }
    }
    expect(offenders, `ComfyUI-Manager must not be a pack custom-node dep:\n${offenders.join("\n")}`).toEqual([]);
  });
});
