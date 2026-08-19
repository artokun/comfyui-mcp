// #954 / #952 — `fetch failed` is not a diagnostic.
//
// undici gives every network-layer failure the same four characters. Not the
// host, not the port, not whether it was DNS, a refused connection, a timeout,
// or a certificate. The real reason sits one level down on `.cause`, and
// `errorToToolResult` kept only `err.message`.
//
// #954 saw it from the workflow-templates listing (now `list_packs`
// action:"list_templates") and could not tell which target was
// tried. #952 saw it from the readonly tools while the panel bridge was working
// fine — and read it, reasonably, as "these tools are broken". They weren't: the
// panel talks to whichever ComfyUI its browser tab is on, while these calls go to
// the configured COMFYUI_URL, and those two addresses are allowed to differ. That
// distinction is invisible unless the failure names the address it used.
//
// Same defect had already been fixed once for HuggingFace downloads (#411) in a
// private helper. It is now shared, which is why this file also pins that the
// original message survives at the FRONT of the expansion: transient-error
// matchers elsewhere test for /fetch failed/.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => ({}),
}));

const { comfyuiFetch, setConnectedPanelOrigins } = await import("../../comfyui/fetch.js");
const { describeFetchFailure, isBareFetchFailure, errorToToolResult, ComfyUIError } =
  await import("../../utils/errors.js");

/** The exact shape undici throws: an opaque top-level, detail on `.cause`. */
function undiciFailure(code: string, detail: string): Error {
  const cause = new Error(detail);
  (cause as { code?: string }).code = code;
  return new TypeError("fetch failed", { cause });
}

afterEach(() => vi.restoreAllMocks());

describe("describeFetchFailure", () => {
  it("unwraps the cause chain and surfaces the syscall code", () => {
    const { message, code } = describeFetchFailure(
      undiciFailure("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8188"),
    );
    expect(code).toBe("ECONNREFUSED");
    expect(message).toContain("connect ECONNREFUSED 127.0.0.1:8188");
  });

  // Load-bearing: process-control classifies transient network errors with a
  // /fetch failed/ regex. Expanding the message must not break that.
  it("keeps the ORIGINAL message at the front", () => {
    const { message } = describeFetchFailure(undiciFailure("ENOTFOUND", "getaddrinfo ENOTFOUND gpu.local"));
    expect(message.startsWith("fetch failed")).toBe(true);
    expect(message).toMatch(/fetch failed/);
  });

  it("survives a self-referential cause chain", () => {
    const err = new Error("boom") as Error & { cause?: unknown };
    err.cause = err;
    expect(describeFetchFailure(err).message).toBe("boom");
  });

  it("handles a non-Error throw", () => {
    expect(describeFetchFailure("just a string").message).toBe("just a string");
  });

  it("recognises only the bare opaque failure", () => {
    expect(isBareFetchFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isBareFetchFailure(new Error("  fetch failed  "))).toBe(true);
    // Anything that already says something is left alone.
    expect(isBareFetchFailure(new Error("fetch failed to parse the manifest"))).toBe(false);
    expect(isBareFetchFailure(new Error("The operation was aborted"))).toBe(false);
    expect(isBareFetchFailure("fetch failed")).toBe(false);
  });
});

describe("errorToToolResult", () => {
  it("expands a bare fetch failure instead of printing four useless words", () => {
    const res = errorToToolResult(undiciFailure("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.4:8188"));
    const text = String(res.content[0].text);
    expect(res.isError).toBe(true);
    expect(text).not.toBe("fetch failed");
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("10.0.0.4:8188");
  });

  it("leaves an error that already explains itself untouched", () => {
    expect(String(errorToToolResult(new Error("Workflow node 7 is missing")).content[0].text)).toBe(
      "Workflow node 7 is missing",
    );
  });

  it("still routes a ComfyUIError through its own envelope", () => {
    const res = errorToToolResult(new ComfyUIError("nope", "SOME_CODE"));
    expect(String(res.content[0].text)).toContain("SOME_CODE");
  });
});

describe("comfyuiFetch names the target it could not reach", () => {
  it("reports the URL, the cause, and that a live panel proves nothing about it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(undiciFailure("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8188")),
    );
    await expect(comfyuiFetch("http://127.0.0.1:8188/api/workflow_templates")).rejects.toThrow(
      /http:\/\/127\.0\.0\.1:8188\/api\/workflow_templates/,
    );
    // The #952 misreading, addressed directly.
    await expect(comfyuiFetch("http://127.0.0.1:8188/api/x")).rejects.toThrow(
      /CONNECTED sidebar panel does not imply/,
    );
    // Remedies must be NAMED, or the reader is still guessing. The vocabulary
    // gate keeps these two names live — it caught an earlier draft of this very
    // change pointing at the environment tool's pre-0.50.0 name.
    await expect(comfyuiFetch("http://127.0.0.1:8188/api/x")).rejects.toThrow(
      /install_comfyui \(action:"environment"\)/,
    );
    await expect(comfyuiFetch("http://127.0.0.1:8188/api/x")).rejects.toThrow(/get_system_stats/);
  });

  it("preserves the original error as `cause` and the syscall code", async () => {
    const original = undiciFailure("ENOTFOUND", "getaddrinfo ENOTFOUND gpu.local");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(original));
    const err = await comfyuiFetch("http://gpu.local:8188/x").catch((e) => e);
    expect((err as { cause?: unknown }).cause).toBe(original);
    expect((err as { code?: string }).code).toBe("ENOTFOUND");
  });

  // Rewriting an error that ALREADY carries information would be a downgrade —
  // the same class of mistake in the other direction.
  it("does NOT rewrite an error that already says what happened", async () => {
    const abort = new Error("The operation was aborted due to timeout");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(comfyuiFetch("http://127.0.0.1:8188/x")).rejects.toBe(abort);
  });

  it("passes a successful response straight through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const res = await comfyuiFetch("http://127.0.0.1:8188/x");
    expect(res.status).toBe(200);
  });

  // An HTTP error status is NOT a fetch failure — it must reach the caller as a
  // Response so the existing #828 HTML/proxy classification still runs.
  it("does not touch a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 502 })));
    const res = await comfyuiFetch("http://127.0.0.1:8188/x");
    expect(res.status).toBe(502);
  });
});

// #952 follow-on — naming the drift instead of asking the reader to check for it.
//
// The shipped message said a connected panel "does not imply this address is
// reachable" and pointed at install_comfyui(action:"environment") to compare the
// two by hand. The bridge already knows what each connected tab fronts, so the
// comparison can just be done — and which of the three cases holds is worth much
// more than the instruction to go and find out.
describe("#952: a headless failure names the connected panel's origin", () => {
  afterEach(() => setConnectedPanelOrigins(null));

  /** Drive a real comfyuiFetch failure and return the wrapped message. */
  async function failureText(target: string): Promise<string> {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      undiciFailure("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8188"),
    );
    try {
      await comfyuiFetch(target);
      throw new Error("expected comfyuiFetch to throw");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  it("says DIFFERENT when the panel is on another origin — the likely answer", async () => {
    setConnectedPanelOrigins(() => ["http://192.168.1.50:8188"]);
    const text = await failureText("http://127.0.0.1:8188/object_info");
    expect(text).toContain("http://192.168.1.50:8188");
    expect(text).toContain("a DIFFERENT address");
    expect(text).toContain("COMFYUI_URL");
  });

  // The valuable inverse: stating that drift is RULED OUT stops the reader
  // chasing the explanation the surrounding text volunteers.
  it("RULES OUT drift when the panel is on the same origin", async () => {
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8188"]);
    const text = await failureText("http://127.0.0.1:8188/object_info");
    expect(text).toContain("NOT a wrong-address problem");
    expect(text).toContain("firewall");
    expect(text).not.toContain("a DIFFERENT address");
  });

  it("ignores the path and compares ORIGINS only", async () => {
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8188"]);
    expect(await failureText("http://127.0.0.1:8188/api/v2/deep/path?x=1")).toContain(
      "NOT a wrong-address problem",
    );
  });

  it("says nothing about drift when no panel is connected", async () => {
    setConnectedPanelOrigins(() => []);
    const text = await failureText("http://127.0.0.1:8188/object_info");
    expect(text).not.toContain("a DIFFERENT address");
    expect(text).not.toContain("NOT a wrong-address problem");
  });

  // An absent comparison is not a negative result. With no source installed at
  // all (the plain MCP server), the message must read exactly as it did before.
  it("says nothing about drift when no origin source is installed", async () => {
    const text = await failureText("http://127.0.0.1:8188/object_info");
    expect(text).not.toContain("a DIFFERENT address");
    expect(text).not.toContain("NOT a wrong-address problem");
    expect(text).toContain("does not imply this address is reachable");
  });

  it("lists every distinct origin, without repeating one", async () => {
    setConnectedPanelOrigins(() => [
      "http://192.168.1.50:8188",
      "http://192.168.1.50:8188",
      "http://10.0.0.9:8188",
    ]);
    const text = await failureText("http://127.0.0.1:8188/object_info");
    expect(text).toContain("http://192.168.1.50:8188, http://10.0.0.9:8188");
    expect(text.match(/192\.168\.1\.50/g)).toHaveLength(1);
  });

  // The comparison is a nicety; the network error is the point. A throwing
  // source must never cost the caller the real diagnosis.
  it("still reports the real failure when the origin source throws", async () => {
    setConnectedPanelOrigins(() => {
      throw new Error("bridge exploded");
    });
    const text = await failureText("http://127.0.0.1:8188/object_info");
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toContain("bridge exploded");
  });

  it("does not crash on an unparsable target", async () => {
    setConnectedPanelOrigins(() => ["http://192.168.1.50:8188"]);
    expect(await failureText("not-a-url")).toContain("ECONNREFUSED");
  });
});

// A ComfyUI call that brought no budget of its own had NO time limit at all:
// comfyuiFetch passed `init` straight to fetch, so a host that accepts the
// connection and never answers left the request pending forever. Thirteen of
// twenty-five call sites were in that state, including /prompt, /queue,
// /object_info and the Manager API — the same defect #1026 hit in the skill
// generator, which bounded three calls and left these.
describe("comfyuiFetch bounds a call that brought no budget", () => {
  afterEach(() => {
    delete process.env.COMFYUI_MCP_HTTP_TIMEOUT_S;
  });

  it("supplies a signal when the caller passed none", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await comfyuiFetch("http://127.0.0.1:8188/queue");
    expect((spy.mock.calls.at(-1)![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  // The caller's own budget is the informed one. Ours must never shorten or replace it.
  it("NEVER overrides a caller's own signal", async () => {
    const mine = AbortSignal.timeout(5_000);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await comfyuiFetch("http://127.0.0.1:8188/queue", { signal: mine });
    expect((spy.mock.calls.at(-1)![1] as RequestInit).signal).toBe(mine);
  });

  it("keeps auth headers while adding the signal", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await comfyuiFetch("http://127.0.0.1:8188/queue", { headers: { "X-Mine": "1" } });
    const init = spy.mock.calls.at(-1)![1] as RequestInit;
    expect(new Headers(init.headers).get("X-Mine")).toBe("1");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a nonsense env value does not disable the ceiling", async () => {
    for (const bad of ["0", "-1", "abc", ""]) {
      process.env.COMFYUI_MCP_HTTP_TIMEOUT_S = bad;
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
      await comfyuiFetch("http://127.0.0.1:8188/queue");
      expect((spy.mock.calls.at(-1)![1] as RequestInit).signal, bad).toBeInstanceOf(AbortSignal);
      vi.restoreAllMocks();
    }
  });
});

describe("a ComfyUI timeout says what it did NOT establish", () => {
  beforeEach(() => vi.unstubAllGlobals());
  function timeoutError(): Error {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    return err;
  }

  it("does not read a GET timeout as a refusal or a missing resource", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError());
    const err = await comfyuiFetch("http://127.0.0.1:8188/queue").catch((e) => e);
    const text = String((err as Error).message);
    expect(text).toContain("Nothing was learned about the server");
    expect(text).toContain("not a refusal");
    expect((err as { code?: string }).code).toBe("COMFYUI_HTTP_TIMEOUT");
  });

  // THE case that matters. /prompt may have queued the render before the reply
  // was lost, so calling this a failure would invite a retry that queues twice.
  it("calls a MUTATING timeout OUTCOME UNKNOWN, not a failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError());
    const err = await comfyuiFetch("http://127.0.0.1:8188/prompt", { method: "POST" }).catch(
      (e) => e,
    );
    const text = String((err as Error).message);
    expect(text).toContain("OUTCOME UNKNOWN");
    expect(text).toContain("do NOT");
    expect(text).toContain("queue (action:\"list\")");
    expect(text).not.toContain("Nothing was learned");
  });

  it("names the target and the method", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError());
    const err = await comfyuiFetch("http://gpu.local:8188/object_info").catch((e) => e);
    expect(String((err as Error).message)).toContain("http://gpu.local:8188/object_info");
    expect(String((err as Error).message)).toContain("(GET)");
  });

  // A caller who set their OWN deadline gets their own abort back untouched —
  // rewriting it as our ceiling would misattribute whose budget expired.
  it("leaves a CALLER's abort exactly as it was", async () => {
    const original = timeoutError();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(original);
    const err = await comfyuiFetch("http://127.0.0.1:8188/queue", {
      signal: AbortSignal.timeout(5_000),
    }).catch((e) => e);
    expect(err).toBe(original);
  });
});
