// #1255 — a workflow identity bound under one spelling of the local host must
// validate against the other. `localhost` and `127.0.0.1` are the same machine;
// #1246 established that equivalence for target drift, and the fence's identity
// gate never got it.
//
// The failure it caused is permanent (nothing re-binds the stored origin),
// survives a hard refresh (a reload re-sends the same Origin header), needs no
// relay backend, and is invisible to sibling reads that do not consult
// origin-bound identity — which is why it reads as a contradiction rather than
// a bug.

import { describe, expect, it } from "vitest";

import { workflowIdentityParts } from "../../orchestrator/session-store.js";

const UUID = "11111111-2222-4333-8444-555555555555";
const bind = (origin: string) => workflowIdentityParts({ workflowUuid: UUID, origin });

describe("workflowIdentityParts origin equivalence (#1255)", () => {
  it("binds localhost and 127.0.0.1 to the SAME origin", () => {
    const a = bind("http://localhost:8188");
    const b = bind("http://127.0.0.1:8188");
    expect(a?.origin).toBeTruthy();
    expect(a?.origin).toBe(b?.origin);
  });

  it("covers the other loopback spellings, not just the reported pair", () => {
    // A two-string special case would leave the identical defect for the next
    // spelling, so the equivalence has to come from the shared normaliser.
    const base = bind("http://localhost:8188")?.origin;
    expect(bind("http://[::1]:8188")?.origin).toBe(base);
    expect(bind("http://LOCALHOST:8188/")?.origin).toBe(base);
  });

  // ── The discriminating negatives. A normaliser that is too eager turns a
  // fail-closed gate into a rubber stamp, which is worse than the bug.
  it("still refuses a DIFFERENT host", () => {
    expect(bind("http://192.168.1.50:8188")?.origin).not.toBe(bind("http://localhost:8188")?.origin);
  });

  it("still distinguishes a different PORT", () => {
    expect(bind("http://localhost:8189")?.origin).not.toBe(bind("http://localhost:8188")?.origin);
  });

  it("still distinguishes a different SCHEME", () => {
    expect(bind("https://localhost:8188")?.origin).not.toBe(bind("http://localhost:8188")?.origin);
  });

  it("keeps failing closed on an unparseable origin", () => {
    // Must not become empty-and-accepted: an origin we cannot read is exactly
    // the case the gate exists for.
    expect(bind("")).toBeUndefined();
    expect(bind("   ")).toBeUndefined();
    expect(workflowIdentityParts({ workflowUuid: UUID, origin: undefined })).toBeUndefined();
  });

  it("still rejects a malformed uuid regardless of origin", () => {
    expect(workflowIdentityParts({ workflowUuid: "not-a-uuid", origin: "http://localhost:8188" }))
      .toBeUndefined();
  });
});
