// #1131 — "not listed" has TWO causes, and they take OPPOSITE remedies.
//
// A user downloaded a LoRA into the connected ComfyUI's exact models root. The
// placement check asked the server's loader option list immediately, the list had
// not been re-read yet, and the tool reported NOT VISIBLE — then told them to
// "move the file into the running server's models tree", naming a directory the
// file was already in. Their own words: the written path and the server models
// path were identical.
//
// That is a remedy that cannot be followed — the same family as #1043's fence
// advice, where the verdict was defensible and the instruction was not.
//
// ComfyUI caches loader options and invalidates them on the directory's mtime, so
// a check this soon after a write routinely races it. Inside the root ⇒ stale
// listing, refresh. Outside ⇒ genuinely misplaced, move.

import { describe, expect, it } from "vitest";
import { isUnderRoot, notVisibleVerdict } from "../../services/model-resolver.js";

const BASE = { wanted: "example.safetensors", category: "loras", baseUrl: "http://127.0.0.1:8188" };

describe("a file inside the server's own models root is not called misplaced", () => {
  // The reporter's exact shape: one path, spelled two ways.
  const reported = notVisibleVerdict({
    ...BASE,
    verifiedPath: "C:\\ComfyUI\\models\\loras\\example.safetensors",
    liveModelsDir: "C:/ComfyUI/models",
  });

  it("never prints the impossible instruction", () => {
    expect(reported.note).not.toMatch(/Move the file into the running server's models tree/);
    expect(reported.note).not.toMatch(/point COMFYUI_PATH/);
  });

  it("says the placement is right, and says so explicitly", () => {
    expect(reported.note).toMatch(/it is in the right place/);
    expect(reported.note).toMatch(/Do NOT move the file/);
  });

  it("names the actual cause and a remedy that can be followed", () => {
    expect(reported.note).toMatch(/cached loader options/);
    expect(reported.note).toMatch(/refresh_nodes/);
  });

  it("still reports not-visible — the verdict did not weaken", () => {
    // #369 exists because an unobserved placement must not render as confirmed.
    // A kinder explanation is not evidence that the server can read the file.
    expect(reported.liveVisible).toBe("not-visible");
  });
});

describe("a file outside that root keeps the move remedy", () => {
  const misplaced = notVisibleVerdict({
    ...BASE,
    verifiedPath: "/home/u/Downloads/example.safetensors",
    liveModelsDir: "/opt/ComfyUI/models",
  });

  it("still tells the user to move it, and where", () => {
    expect(misplaced.note).toMatch(/Move the file into the running server's models tree/);
    expect(misplaced.note).toMatch(/\/opt\/ComfyUI\/models/);
  });

  it("does not tell them a refresh will fix it", () => {
    // The dangerous inversion: a genuinely misplaced file that the user refreshes
    // forever instead of moving.
    expect(misplaced.note).not.toMatch(/Do NOT move the file/);
  });

  it("keeps the move remedy when the live root is unknown", () => {
    const unknownRoot = notVisibleVerdict({
      ...BASE,
      verifiedPath: "/home/u/Downloads/example.safetensors",
      liveModelsDir: undefined,
    });
    // Cannot prove it is in the right place ⇒ must not claim it is.
    expect(unknownRoot.note).toMatch(/Move the file/);
    expect(unknownRoot.note).not.toMatch(/models directory that server reads/);
  });
});

describe("isUnderRoot", () => {
  // The platform is a PARAMETER, not read from the host, so the Windows case is
  // genuinely exercised on ubuntu CI rather than quietly passing there for the
  // wrong reason — a local green run is single-platform evidence only.
  it("treats mixed separators and case as the same directory on Windows", () => {
    expect(
      isUnderRoot("C:\\ComfyUI\\models\\loras\\example.safetensors", "c:/comfyui/models", "win32"),
    ).toBe(true);
  });

  it("does NOT fold case on POSIX, where Models and models differ", () => {
    expect(isUnderRoot("/comfy/Models/loras/x.safetensors", "/comfy/models", "linux")).toBe(false);
  });

  it("does not treat a SIBLING directory as inside", () => {
    // …/models2 must never count as inside …/models, or a genuinely misplaced
    // file gets the "just refresh" advice and is never found.
    expect(isUnderRoot("/comfy/models2/loras/x.safetensors", "/comfy/models", "linux")).toBe(false);
  });

  it("counts the root itself as inside", () => {
    expect(isUnderRoot("/comfy/models", "/comfy/models", "linux")).toBe(true);
  });

  it("ignores a trailing separator on the root", () => {
    expect(isUnderRoot("/comfy/models/loras/x.safetensors", "/comfy/models/", "linux")).toBe(true);
  });

  it("keeps a genuinely outside path outside", () => {
    expect(isUnderRoot("/somewhere/else/x.safetensors", "/comfy/models", "linux")).toBe(false);
  });
});
