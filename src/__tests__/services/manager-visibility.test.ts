// #1086 — ask the server, instead of telling the caller to ask it.
//
// A Manager dispatch could only ever say "confirm with list_local_models before
// relying on it". A reporter who did not confirm lost a multi-GB model: ComfyUI-
// Manager picks its own destination root and does not necessarily honour
// extra_model_paths, so their file landed in the install's base models directory
// — an ephemeral 20GB overlay — while their ComfyUI read from a 100GB volume.
// Nothing contradicted "download complete" until a pod restart made it absent.
//
// verifyLandedModel cannot answer this. It stats the local filesystem first and
// returns `unknown` outright in remote mode — exactly the case a Manager dispatch
// creates, since there is no local file. But the LISTING question is answerable
// remotely, because it asks the server.
//
// THE TRAP THIS FILE PINS. A Manager dispatch returns when the task is ACCEPTED,
// so a large file is still arriving for minutes afterwards. "not-listed" must
// therefore NEVER be rendered as failure — "not there yet" and "landed somewhere
// the server cannot read" are indistinguishable from here, and claiming the
// second would be a fabricated failure mirroring the fabricated success.
//
// The probe is INJECTED. Mocking the module does not work: the function resolves
// `liveListingHasEntry` through a module-local binding, not the namespace object,
// so a first draft of this file silently queried the developer's real ComfyUI —
// which is why three of its assertions "failed" with plausible-looking values.

import { describe, expect, it, vi } from "vitest";
import { verifyManagerVisibility } from "../../services/model-resolver.js";

describe("verifyManagerVisibility asks the live server", () => {
  it("CONFIRMS when the server lists the file", async () => {
    const probe = vi.fn().mockResolvedValue(true);

    const r = await verifyManagerVisibility("clip_vision", "clip_vision_h.safetensors", {
      attempts: 1,
      probe,
    });

    expect(r.visibility).toBe("visible");
    expect(r.note).toMatch(/now lists clip_vision\/clip_vision_h\.safetensors/);
  });

  it("reports NOT-LISTED without calling it a failure", async () => {
    const probe = vi.fn().mockResolvedValue(false);

    const r = await verifyManagerVisibility("clip_vision", "clip_vision_h.safetensors", {
      attempts: 1,
      retryMs: 0,
      probe,
    });

    expect(r.visibility).toBe("not-listed");
    // The load-bearing hedge: a dispatch returns on ACCEPTANCE.
    expect(r.note).toMatch(/not proof of failure/i);
    expect(r.note).toMatch(/still be arriving/i);
    // …and the actionable half, which is what the reporter needed.
    expect(r.note).toMatch(/does not necessarily honour/);
    expect(r.note).toMatch(/ephemeral overlay/);
  });

  it("says UNKNOWN when the server could not be asked — not 'not-listed'", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);

    const r = await verifyManagerVisibility("loras", "x.safetensors", {
      attempts: 2,
      retryMs: 0,
      probe,
    });

    expect(r.visibility).toBe("unknown");
    expect(r.note).toMatch(/could not be asked/);
    // An unanswerable probe must not masquerade as a negative observation.
    expect(r.note).not.toMatch(/does NOT list/);
  });

  it("says UNKNOWN when the file was ALREADY listed before the dispatch", async () => {
    // A pre-existing file of the same name would otherwise read as a successful
    // landing — the same trap the local path's `listedBefore` guards.
    const probe = vi.fn();

    const r = await verifyManagerVisibility("checkpoints", "sdxl.safetensors", {
      listedBefore: true,
      attempts: 1,
      probe,
    });

    expect(r.visibility).toBe("unknown");
    expect(r.note).toMatch(/already listed .* BEFORE this dispatch/);
    expect(probe).not.toHaveBeenCalled(); // no point asking
  });

  it("retries before concluding not-listed, and stops early once seen", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const r = await verifyManagerVisibility("loras", "x.safetensors", {
      attempts: 3,
      retryMs: 0,
      probe,
    });

    expect(r.visibility).toBe("visible");
    expect(probe).toHaveBeenCalledTimes(2); // stopped at the hit
  });

  it("never throws outward when the probe explodes", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("connection reset"));

    const r = await verifyManagerVisibility("loras", "x.safetensors", {
      attempts: 1,
      retryMs: 0,
      probe,
    });

    // A verification hiccup must not turn a transfer into an error.
    expect(r.visibility).toBe("unknown");
  });
});
