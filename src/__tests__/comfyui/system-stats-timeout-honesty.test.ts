// #1896 — the /system_stats probe that the drift advice now sends callers to.
//
// When a ComfyUI call fails and the comparison establishes a connected panel is
// on the SAME origin, comfyui/fetch.ts tells the reader to run
// get_system_stats (action:"health") to settle which of two things is true:
//
//   fails from here too -> the route from this process is what needs fixing
//   succeeds            -> only this one request is stalling
//
// That discriminator is only worth anything if the probe's own timeout message
// leaves both readings open. It did not. It asserted "The connection was
// accepted but the body never finished, which is common while a long decode
// occupies the server. The request was aborted; retry after the current job
// finishes." — the budget covers CONNECTING too, so a target this process cannot
// route to expires here having established nothing, and the reader chasing a
// dead route was handed "a long decode, just retry": precisely the reading the
// discriminator exists to rule out. (The sentence before it already said nothing
// was learned about the server, so it also contradicted its own paragraph.)
//
// The decode case is still the usual one and is kept as the likely reading.
// What is removed is the assertion that it is the only one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "127.0.0.1:8188",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => false,
}));

const { getSystemStats, SYSTEM_STATS_TIMEOUT_MS } = await import("../../comfyui/client.js");

let restoreTimeout: (() => void) | undefined;

beforeEach(() => {
  // Shorten ONLY this probe's deadline, exactly as the #1672 unwind test does.
  // Faking the clock does not govern AbortSignal.timeout here, so the honest
  // way to reach the shipped timer quickly is to shrink the shipped timer.
  const orig = AbortSignal.timeout.bind(AbortSignal);
  const spy = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms: number) => orig(ms === SYSTEM_STATS_TIMEOUT_MS ? 40 : ms));
  restoreTimeout = () => spy.mockRestore();
});

afterEach(() => {
  restoreTimeout?.();
  vi.restoreAllMocks();
});

/**
 * Drive the probe's OWN budget to expiry and return its message.
 *
 * The mock settles only when the caller's signal aborts, so this takes the same
 * `isTimeoutAbort(err)` branch production does rather than fabricating the error.
 */
async function probeTimeoutText(): Promise<string> {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) as Promise<Response>,
  );
  return getSystemStats().then(
    () => "expected /system_stats to time out",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

describe("#1896: the /system_stats probe says only what its timeout proves", () => {
  it("does not assert that the connection was accepted", async () => {
    const text = await probeTimeoutText();
    expect(text).toContain("No reply from ComfyUI within");
    expect(text).not.toContain("The connection was accepted but the body never finished");
    expect(text).toContain("Whether a connection was ever established is NOT known");
  });

  // Both readings have to survive, or the discriminator in comfyui/fetch.ts is
  // answering its own question before the caller runs it.
  it("keeps the decode reading AND leaves the dead-route reading open", async () => {
    const text = await probeTimeoutText();
    expect(text).toContain("retrying after the current job finishes");
    expect(text).toContain("points at the route rather than at a busy server");
  });

  it("still names the budget and the endpoint", async () => {
    const text = await probeTimeoutText();
    expect(text).toContain(`within ${SYSTEM_STATS_TIMEOUT_MS / 1000}s`);
    expect(text).toContain("/system_stats");
  });
});
