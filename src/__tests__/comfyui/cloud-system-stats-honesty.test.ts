// #1070 — a health check that cannot fail.
//
// cloud-client's getSystemStats() caught EVERYTHING and returned an invented
// device: a "Comfy Cloud GPU" with zeroed VRAM. An expired API key, a 402, a DNS
// failure, a timeout, a network partition — all of them came back looking like a
// successful health check.
//
// Two things made that worse than a mislabelled outcome usually is.
//
// `get_system_stats (action:"health")` is the remedy our own error messages send
// people to: it is named in describeComfyFetchFailure, in the timeout text, and in
// cloud-client's own messages. In cloud mode that remedy could not return a
// negative result — someone told "confirm the server is up" would run it, see a
// GPU, and conclude the problem was elsewhere. And health-check.ts /
// local-models-fallback.ts both call it as a REACHABILITY PROBE, which the
// placeholder answered "yes" to unconditionally.
//
// It also fabricated data rather than merely mislabelling it. `vram_total: 0` is
// not a reading, and a caller sizing a job against it is reading an invention.
//
// Three states, not two: answered / endpoint absent / could not ask.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  getApiKey: () => "test-key",
  getCloudUrl: () => "https://cloud.comfy.org",
  getComfyUIAuthHeaders: () => ({}),
}));

const cloud = await import("../../comfyui/cloud-client.js");

function undiciFailure(code: string, detail: string): Error {
  const cause = new Error(detail);
  (cause as { code?: string }).code = code;
  return new TypeError("fetch failed", { cause });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getSystemStats answers when the endpoint answers", () => {
  it("returns what the cloud reported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            system: { os: "linux", python_version: "3.12", embedded_python: false },
            devices: [{ name: "H100", type: "cuda", index: 0, vram_total: 80, vram_free: 79, torch_vram_total: 80, torch_vram_free: 79 }],
          }),
          { status: 200 },
        ),
      ),
    );

    const stats = await cloud.getSystemStats();
    expect(stats.devices[0]!.name).toBe("H100");
    expect(stats.devices[0]!.vram_total).toBe(80);
  });
});

describe("it propagates a failure instead of inventing a GPU", () => {
  // Each of these is a REAL failure the caller must see. Before #1070 every one
  // returned a healthy-looking placeholder.
  it("propagates an expired/invalid API key (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad key", { status: 401, statusText: "Unauthorized" })),
    );
    await expect(cloud.getSystemStats()).rejects.toThrow(/401/);
  });

  it("propagates a billing failure (402)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("pay up", { status: 402, statusText: "Payment Required" })),
    );
    await expect(cloud.getSystemStats()).rejects.toThrow(/402/);
  });

  it("propagates a server error (500)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500, statusText: "Internal Server Error" })),
    );
    await expect(cloud.getSystemStats()).rejects.toThrow(/500/);
  });

  it("propagates a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(undiciFailure("ECONNRESET", "read ECONNRESET")));
    await expect(cloud.getSystemStats()).rejects.toThrow(/fetch failed/);
  });

  it("propagates a timeout", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(cloud.getSystemStats()).rejects.toThrow(/No reply from Comfy Cloud/);
  });

  // The load-bearing consequence, stated directly: the probe must be able to say no.
  it("lets a reachability probe actually fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(undiciFailure("ECONNREFUSED", "connect ECONNREFUSED")));
    const reachable = await cloud
      .getSystemStats()
      .then(() => true)
      .catch(() => false);
    expect(reachable).toBe(false);
  });
});

describe("the placeholder survives only for a genuinely absent endpoint", () => {
  it.each([404, 405, 501])("still falls back on %i", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status })));

    const stats = await cloud.getSystemStats();
    expect(stats.devices).toHaveLength(1);
    // Kept as a prefix so anything matching the old name still matches…
    expect(stats.devices[0]!.name).toMatch(/^Comfy Cloud GPU/);
    // …but a reader can now tell these are not measurements.
    expect(stats.devices[0]!.name).toMatch(/placeholders, not readings/);
  });
});
