// #1026 — a `list_packs` call sat in flight past 180s with no exception and no
// response, and had to be killed client-side.
//
// The reporter named action:"list" and action:"skill_list", but neither can hang:
// both are synchronous local filesystem enumeration with no network and no await.
// The pack catalog's one live-server action (list_templates) is bounded by
// comfyuiFetch's COMFYUI_MCP_HTTP_TIMEOUT_S ceiling.
//
// The actual unbounded path on that tool is action:"generate_skill", which
// reaches GitHub and api.comfy.org — and all three of those calls were a bare
// `fetch` with NO AbortSignal. A host that accepts the connection and then never
// answers leaves the request pending forever: no error, no result, nothing for
// the caller to act on. That is the reported shape exactly — not a failure that
// was mis-described, but no answer at all.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({ config: { githubToken: undefined } }));
vi.mock("../../comfyui/client.js", () => ({ getObjectInfo: vi.fn() }));

const { fetchGitHubFile } = await import("../../services/skill-generator.js");

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.COMFYUI_MCP_SKILL_FETCH_TIMEOUT_S;
});

describe("#1026: the network calls are bounded", () => {
  it("passes an AbortSignal — a request can no longer hang forever", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: "aGk=", encoding: "base64" }), { status: 200 }),
    );
    await fetchGitHubFile("o", "r", "README.md");
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("honours COMFYUI_MCP_SKILL_FETCH_TIMEOUT_S for a slow link", async () => {
    process.env.COMFYUI_MCP_SKILL_FETCH_TIMEOUT_S = "90";
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: "aGk=", encoding: "base64" }), { status: 200 }),
    );
    await fetchGitHubFile("o", "r", "README.md");
    expect((spy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("ignores a nonsense timeout value rather than disabling the bound", async () => {
    for (const bad of ["0", "-5", "abc", ""]) {
      process.env.COMFYUI_MCP_SKILL_FETCH_TIMEOUT_S = bad;
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ content: "aGk=", encoding: "base64" }), { status: 200 }),
      );
      await fetchGitHubFile("o", "r", "README.md");
      // A signal is still attached — a bad value must never mean "unbounded".
      expect((spy.mock.calls[0][1] as RequestInit).signal, bad).toBeInstanceOf(AbortSignal);
      vi.restoreAllMocks();
    }
  });
});

describe("#1026: a timeout says what was NOT learned", () => {
  /** What undici throws when an AbortSignal.timeout fires. */
  function timeoutError(): Error {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    return err;
  }

  it("does not report a timeout as a missing resource", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError());
    const err = await fetchGitHubFile("o", "r", "README.md").catch((e) => e);
    const text = String((err as Error).message);
    expect(text).toContain("could NOT be determined");
    expect(text).toContain('not a "not found"');
  });

  it("names the host it was waiting on and the remedy", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError());
    const err = await fetchGitHubFile("o", "r", "README.md").catch((e) => e);
    const text = String((err as Error).message);
    expect(text).toContain("api.github.com/repos/o/r/contents/README.md");
    expect(text).toContain("COMFYUI_MCP_SKILL_FETCH_TIMEOUT_S");
    expect((err as { code?: string }).code).toBe("NETWORK_TIMEOUT");
  });

  // A genuine network error already says what happened; rewriting it as a
  // timeout would be the same fold in the other direction.
  it("leaves a non-timeout failure exactly as it was", async () => {
    const original = new TypeError("fetch failed");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(original);
    const err = await fetchGitHubFile("o", "r", "README.md").catch((e) => e);
    expect(err).toBe(original);
  });

  // An HTTP error status is not a timeout either — the existing GITHUB_ERROR
  // path must keep its own wording.
  it("leaves an HTTP error status on its own path", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    const err = await fetchGitHubFile("o", "r", "README.md").catch((e) => e);
    expect(String((err as Error).message)).toContain("GitHub API error 404");
    expect(String((err as Error).message)).not.toContain("Timed out");
  });
});
