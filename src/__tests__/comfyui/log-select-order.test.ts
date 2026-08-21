// #1223 — the log was FILTERED AFTER it was REDACTED.
//
// `get_system_stats action:"logs"` read the whole log, scrubbed it, and only
// then applied the caller's keyword. So a keyword matching any text the scrub
// had rewritten found nothing, and the tool answered:
//
//     No log lines found matching "ltxvideo".
//
// for a log that contained it. That is a FALSE ABSENCE, and it is worse than a
// redacted match by a wide margin: a redacted line still tells the caller the
// event happened, when, and in what context, and they can go look. "No log lines
// found" tells them to stop looking.
//
// The ordering is now structural rather than remembered — `getLogs` takes the
// selection and never hands raw lines out, so no call site CAN filter after the
// scrub. These tests pin the order, because a future refactor that moves
// filtering back out would still pass every redaction test in the suite.

import { describe, expect, it, vi } from "vitest";

// Force local mode and stub the underlying SDK Client so /internal/logs is
// served from this file and never from a real ComfyUI. Mirrors
// get-logs-retry.test.ts — and it is load-bearing: the first draft mocked a
// module client.ts does not import, so these tests silently reached the ComfyUI
// running on this machine and asserted against ITS log.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    isCloudMode: () => false,
    getComfyUIApiHost: () => "127.0.0.1:8188",
    getComfyUIAuthHeaders: () => ({}),
    config: { ...actual.config, comfyuiApiKey: undefined, huggingfaceToken: undefined, civitaiApiToken: undefined },
  };
});

const fetchApi = vi.fn();
vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    apiURL(p: string) {
      return p;
    }
    apiHeaders(init?: { headers?: unknown }) {
      return (init && init.headers) || {};
    }
    async fetch(u: string, init?: RequestInit) {
      return this.fetchApi(u, init);
    }
    fetchApi = fetchApi;
    close() {}
  },
}));

const { getLogs } = await import("../../comfyui/client.js");

/** Serve `lines` as ComfyUI's raw-text /internal/logs body. */
function serve(lines: string[]): void {
  fetchApi.mockReset();
  fetchApi.mockResolvedValue({ text: async () => lines.join("\n") });
}

const IMPORT_FAILED = "[INFO] 0.0 seconds (IMPORT FAILED): /basedir/custom_nodes/ComfyUI-LTXVideo";

describe("getLogs selects BEFORE it scrubs (#1223)", () => {
  it("finds the pack name the reporter searched for", async () => {
    serve(["[INFO] boot", IMPORT_FAILED, "[INFO] done"]);
    expect(await getLogs({ keyword: "ltxvideo" })).toEqual([IMPORT_FAILED]);
  });

  it("matches text that the scrub will then REDACT", async () => {
    // The ordering's whole point, isolated: a checksum a user is grepping for is
    // credential-shaped, so it IS redacted — and must still be findable. Under
    // the old order this returned "No log lines found".
    const digest = "d41d8cd98f00b204e9800998ecf8427e1a2b3c4d";
    serve(["[INFO] boot", `[INFO] verified ${digest}`]);
    const out = await getLogs({ keyword: digest });

    expect(out, "the line must be FOUND").toHaveLength(1);
    expect(out[0], "and it must still be redacted").not.toContain(digest);
    expect(out[0], "with enough context to be worth having").toContain("verified");
  });

  it("tails to maxLines AFTER filtering, not before", async () => {
    // A tail applied first would return the last N lines of the WHOLE log and
    // then filter them — quietly answering about the wrong window.
    serve(["error one", "error two", "boot ok", "shutdown ok"]);
    expect(await getLogs({ keyword: "error", maxLines: 1 })).toEqual(["error two"]);
  });

  it("returns every line when no keyword is given", async () => {
    serve(["a", "b"]);
    expect(await getLogs()).toEqual(["a", "b"]);
  });

  it("treats an EMPTY keyword as no filter, as it always has", async () => {
    serve(["a", "b"]);
    expect(await getLogs({ keyword: "" })).toEqual(["a", "b"]);
  });

  it("still scrubs when nothing is selected away", async () => {
    // The narrowing must not create a path where the scrub is skipped.
    serve(["[INFO] sig=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw"]);
    expect((await getLogs())[0]).toContain("redacted");
  });

  it("handles ComfyUI's JSON-encoded log body the same way", async () => {
    // /internal/logs is a JSON string on some versions and raw text on others,
    // and the selection has to apply to both — a version-shaped hole here would
    // put the filter back after the scrub for half the fleet.
    fetchApi.mockReset();
    fetchApi.mockResolvedValue({ text: async () => JSON.stringify(["x", IMPORT_FAILED].join("\n")) });
    expect(await getLogs({ keyword: "ltxvideo" })).toEqual([IMPORT_FAILED]);
  });
});
