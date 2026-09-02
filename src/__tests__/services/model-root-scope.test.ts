// #1474 — `remove` searched one root while `list_paths` displayed several.
//
// On a normal Comfy Desktop launch:
//   list        -> lists a model served from M:\Comfy-Desktop\ComfyUI-Shared\models
//   list_paths  -> shows that shared root, from the live --extra-model-paths-config
//   remove      -> "Model file not found ... Searched 1 root(s): <primary install>"
//
// Two tools disagreeing about which roots exist, with nothing to explain it. The
// asymmetry is DELIBERATE — this resolver backs deletion, so it enumerates only roots
// provable from the running server's launch arguments — but it was silent, and the
// reporter had to diagnose it themselves before deleting the files by hand.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modelNotFoundMessage } from "../../services/model-root-scope.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const msg = () =>
  modelNotFoundMessage({
    relativePath: "diffusion_models/z_image_turbo_bf16.safetensors",
    searched: ["M:\\Comfy-Desktop\\ComfyUI-Installs\\comfyui\\ComfyUI\\models"],
  });

describe("#1474 the refusal keeps what it had", () => {
  it("still names the file and the roots it did search", () => {
    // The original text was not wrong, only incomplete — nothing should be lost.
    expect(msg()).toMatch(/Model file not found: diffusion_models\/z_image_turbo_bf16\.safetensors/);
    expect(msg()).toMatch(/Searched 1 root\(s\)/);
    expect(msg()).toMatch(/ComfyUI-Installs/);
  });
});

describe("#1474 it explains the asymmetry the reporter had to work out", () => {
  it("says the searched roots may not be every root you can SEE", () => {
    expect(msg()).toMatch(/may not be every root you can SEE/);
  });

  it("names the other tool by its live action, so the two can be compared", () => {
    expect(msg()).toMatch(/list_local_models \(action:"list_paths"\)/);
  });

  it("states PROVABILITY as the reason, not an accident", () => {
    // Without this the reader concludes one of the two tools is buggy.
    expect(msg()).toMatch(/only roots it can PROVE/);
    expect(msg()).toMatch(/launch arguments/);
    expect(msg()).toMatch(/backs DELETION/);
  });

  it('refuses the "not found means not on disk" reading outright', () => {
    // The reading that would make someone re-download a model they already have.
    expect(msg()).toMatch(/does NOT mean "not on disk"/);
  });

  it("gives both ways forward", () => {
    expect(msg()).toMatch(/main\.py appears in its arguments/);
    expect(msg()).toMatch(/directly on the host/);
    // And the containment caveat survives — this must not read as "just delete it".
    expect(msg()).toMatch(/inside the intended root/);
  });

  it("does NOT claim any extra root was searched", () => {
    // The one thing this fix must never do: imply deletion looked somewhere it did not.
    expect(msg()).not.toMatch(/searched (all|every)/i);
  });
});

describe("#1474 WIRING: the resolver throws through it", () => {
  const src = readFileSync(join(HERE, "../../services/model-resolver.ts"), "utf8");

  it("the not-found throw uses the shared message", () => {
    expect(src).toMatch(/import \{ modelNotFoundMessage \} from "\.\/model-root-scope\.js";/);
    expect(src).toMatch(/modelNotFoundMessage\(\{ relativePath, searched, deletion:/);
  });

  it("the old bare sentence is gone from the throw", () => {
    // Scoped to the throw: the phrase legitimately appears in this test's own prose
    // and in comments explaining the change.
    const at = src.indexOf("throw new ModelError(");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 400);
    expect(block).not.toMatch(/Searched \$\{searched\.length\} root\(s\)/);
  });

  it("the structured details still carry the searched roots", () => {
    // A caller reading `details.searched` programmatically must be unaffected.
    expect(src).toMatch(/\{ path: relativePath, searched \}/);
  });
});
