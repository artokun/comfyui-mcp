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
import { readFileSync } from "node:fs";
import { verifyManagerVisibility } from "../../services/model-resolver.js";

describe("verifyManagerVisibility asks the live server", () => {
  it("reports VISIBLE when the server lists the file", async () => {
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

// #473 — LISTING IS NOT VALIDITY, and saying otherwise was my regression.
//
// A reporter on 0.50.34 got six byte-identical 10,038-byte CivitAI Login HTML
// documents saved as models, and observed that `download_model` "sometimes
// upgraded the filename-presence check to CONFIRMED". That upgrade was this
// check, shipped in 0.50.29.
//
// Manager writes whatever the URL returned under the name you asked for, and it
// cannot carry this MCP's credentials — so an auth-gated URL yields a login page
// with a .safetensors name. It lists perfectly. It deserializes into
// "SafetensorError: header too large" the moment a LoraLoader touches it.
//
// This is #473's original failure (the landing watcher treating presence as
// success) reintroduced one layer up, which is why the wording is pinned here.
describe("a visible verdict never implies the payload is a real model", () => {
  it("says placement, and explicitly disclaims validity", async () => {
    const probe = vi.fn().mockResolvedValue(true);

    const r = await verifyManagerVisibility("loras", "KNP_000003000.safetensors", {
      attempts: 1,
      probe,
    });

    expect(r.visibility).toBe("visible");
    expect(r.note).toMatch(/PLACEMENT, not validity/i);
    // The mechanism, so the reader can tell WHY a listing proves so little.
    expect(r.note).toMatch(/whatever the URL returned under the name you asked for/i);
    expect(r.note).toMatch(/cannot carry this MCP's credentials/i);
    // The tell a caller can actually act on.
    expect(r.note).toMatch(/login page is ~10KB/i);
  });

  it("does not use the word CONFIRMED for a Manager dispatch", async () => {
    const probe = vi.fn().mockResolvedValue(true);

    const r = await verifyManagerVisibility("loras", "x.safetensors", { attempts: 1, probe });

    // The label is the whole defect: "CONFIRMED" reads as "this worked".
    expect(r.note).not.toMatch(/\bCONFIRMED\b/);
  });
});

// THE WIRING. The label lives in the tool's Manager branch, so the helper tests
// above cannot see a revert to "CONFIRMED:" there — the same call-site blindness
// that has bitten this suite repeatedly. Read the source, the way the other
// prose gates in this repo do.
describe("the tool's Manager branch never labels a listing as confirmation", () => {
  it("has no CONFIRMED label on the viaManager path", () => {
    const src = readFileSync(
      new URL("../../tools/model-management.ts", import.meta.url),
      "utf-8",
    );
    const start = src.indexOf("const text = job.viaManager");
    expect(start, "the viaManager branch must still exist").toBeGreaterThan(-1);
    const branch = src.slice(start, start + 1400);

    // The regression, stated exactly: `CONFIRMED: ${managerSeen.note}`.
    expect(branch).not.toMatch(/`CONFIRMED[:\s]/);
    expect(branch).toMatch(/LISTED \(placement only, NOT validity\)/);
  });
});
