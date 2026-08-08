// A transport failure on a POST does not prove the POST never arrived.
//
// describeComfyTimeout already draws this distinction for the CEILING: a POST
// that times out is "OUTCOME UNKNOWN: this request may already have been received
// and acted on, so do NOT blindly re-issue it". A CONNECTION ERROR on that same
// POST carries the identical risk — an ECONNRESET after ComfyUI accepted and
// enqueued the prompt is indistinguishable, at this layer, from one before it —
// and yet the message said only "confirm the server is up with get_system_stats",
// which reads as "it never got there".
//
// The caller retries, and the render is queued twice. That is the most expensive
// duplicate this client can produce.
//
// #796's class again: "could not determine whether it was delivered" folded into
// "it was not delivered". Three states, not two — delivered, definitely not
// delivered, and unknown.
//
// THE DIRECTION OF THE DEFAULT is the whole design. Only a code that POSITIVELY
// proves non-delivery (refused, DNS, TLS, bad URL — all of which fire before a
// byte can reach the application) suppresses the warning. Anything unrecognised
// keeps it, because the two errors are not symmetric: a spurious "verify first"
// costs one extra read, while a spurious "it never arrived" costs a duplicate
// render.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => ({}),
}));

const { comfyuiFetch } = await import("../../comfyui/fetch.js");

/** The exact shape undici throws: an opaque top-level, detail on `.cause`. */
function undiciFailure(code: string | undefined, detail: string): Error {
  const cause = new Error(detail);
  if (code !== undefined) (cause as { code?: string }).code = code;
  return new TypeError("fetch failed", { cause });
}

/** The message comfyuiFetch produces for `err` on `method`. */
async function messageFor(err: Error, method: string | undefined): Promise<string> {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
  const thrown = await comfyuiFetch(
    "http://127.0.0.1:8188/prompt",
    method === undefined ? {} : { method },
  ).catch((e: unknown) => e);
  return thrown instanceof Error ? thrown.message : String(thrown);
}

// vi.stubGlobal is NOT undone by restoreAllMocks — a leftover stub leaks into the
// next test's fetch and makes its assertions describe the previous case.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a mutating request warns that it may already have been delivered", () => {
  it("warns on ECONNRESET, which fires on an ESTABLISHED connection", async () => {
    const msg = await messageFor(undiciFailure("ECONNRESET", "read ECONNRESET"), "POST");

    expect(msg).toMatch(/may already have been received and acted on/i);
    expect(msg).toMatch(/does not establish that the request never arrived/i);
    expect(msg).toMatch(/do NOT blindly re-issue/i);
    // The remedy has to be callable, not a suggestion to "check". These two names
    // are kept live by the vocabulary gate.
    expect(msg).toMatch(/queue \(action:"list"\)/);
    expect(msg).toMatch(/get_history \(action:"list"\)/);
  });

  it("warns on socket-level failures generally (EPIPE, UND_ERR_SOCKET)", async () => {
    for (const code of ["EPIPE", "UND_ERR_SOCKET"]) {
      const msg = await messageFor(undiciFailure(code, `socket ${code}`), "POST");
      expect(msg, code).toMatch(/may already have been received and acted on/i);
    }
  });

  // The conservative default, stated as a test so a later "tidy-up" that inverts
  // it fails here rather than in someone's queue.
  it("warns on an UNRECOGNISED code, and on no code at all", async () => {
    const unknown = await messageFor(undiciFailure("ESOMETHINGNEW", "novel failure"), "POST");
    expect(unknown).toMatch(/may already have been received and acted on/i);

    const none = await messageFor(undiciFailure(undefined, "no code at all"), "POST");
    expect(none).toMatch(/may already have been received and acted on/i);
  });

  it("covers the other mutating verbs, not just POST", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const msg = await messageFor(undiciFailure("ECONNRESET", "read ECONNRESET"), method);
      expect(msg, method).toMatch(/may already have been received and acted on/i);
      expect(msg, method).toMatch(new RegExp(`This ${method} may already`));
    }
  });
});

describe("it stays silent when nothing could have been delivered", () => {
  // Each of these fires before any byte can reach the application, so the
  // warning would be noise — and noise in an error message is how a real warning
  // stops being read.
  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8188"],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND gpu.local"],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN gpu.local"],
    ["CERT_HAS_EXPIRED", "certificate has expired"],
    ["ERR_INVALID_URL", "Invalid URL"],
  ])("says nothing for %s", async (code, detail) => {
    const msg = await messageFor(undiciFailure(code, detail), "POST");

    expect(msg).not.toMatch(/may already have been received/i);
    expect(msg).not.toMatch(/do NOT blindly re-issue/i);
    // …while still being the full diagnostic it was before.
    expect(msg).toMatch(/fetch failed/);
    expect(msg).toMatch(/127\.0\.0\.1:8188\/prompt/);
  });

  it("says nothing for a READ, which cannot double-apply", async () => {
    // Explicit GET, and the default (no method) — both are reads.
    for (const method of ["GET", "HEAD", undefined]) {
      const msg = await messageFor(undiciFailure("ECONNRESET", "read ECONNRESET"), method);
      expect(msg, String(method)).not.toMatch(/may already have been received/i);
    }
  });
});

describe("the existing diagnostic is preserved", () => {
  // Load-bearing: transient-error matchers elsewhere test for /fetch failed/, and
  // the #952 drift explanation must survive the insertion.
  it("keeps the original message, the target, the method and the remedies", async () => {
    const msg = await messageFor(undiciFailure("ECONNRESET", "read ECONNRESET"), "POST");

    expect(msg.startsWith("fetch failed")).toBe(true);
    expect(msg).toMatch(/http:\/\/127\.0\.0\.1:8188\/prompt \(POST\)/);
    expect(msg).toMatch(/CONNECTED sidebar panel does not imply/);
    expect(msg).toMatch(/install_comfyui \(action:"environment"\)/);
    expect(msg).toMatch(/get_system_stats \(action:"health"\)/);
  });

  it("still carries the syscall code on the wrapped error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(undiciFailure("ECONNRESET", "read ECONNRESET")),
    );
    const err = await comfyuiFetch("http://127.0.0.1:8188/prompt", { method: "POST" }).catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("ECONNRESET");
  });
});
