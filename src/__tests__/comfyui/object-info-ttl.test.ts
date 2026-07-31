import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression for #528: the runtime checker / validator kept serving a stale
// /object_info snapshot after an OUT-OF-BAND ComfyUI restart or custom-node
// install (Desktop Manager reboot, a manual restart — anything that does NOT go
// through an mcp tool and so never calls resetObjectInfoCache()). The old cache
// was memoized for the whole process lifetime, so get_node_info /
// check_workflow_runtime / validate_workflow reported the newly-installed nodes
// as unknown forever. A bounded freshness window (TTL) must let the NEXT call
// after the window pick up the live server's changed node set on its own.

// A short TTL keeps the test fast; it is read once at module load, so it must be
// set BEFORE the dynamic import below.
process.env.COMFYUI_MCP_OBJECT_INFO_TTL_MS = "5000";

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>(
    "../../config.js",
  );
  return {
    ...actual,
    isCloudMode: () => false,
    getComfyUIApiHost: () => "127.0.0.1:8188",
  };
});

const getNodeDefs = vi.fn();
vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    getNodeDefs = getNodeDefs;
    close() {}
  },
}));

const { getObjectInfo, resetObjectInfoCache } = await import(
  "../../comfyui/client.js"
);

describe("#528 object_info TTL self-heals after an out-of-band restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00Z"));
    getNodeDefs.mockReset();
    resetObjectInfoCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps serving the cache WITHIN the freshness window (no per-call refetch)", async () => {
    getNodeDefs.mockResolvedValue({ KSampler: {} });
    await getObjectInfo();
    vi.advanceTimersByTime(4_000); // still inside the 5 s window
    const again = await getObjectInfo();
    expect(again).toEqual({ KSampler: {} });
    expect(getNodeDefs).toHaveBeenCalledTimes(1);
  });

  it("returns the NEW node set after the window lapses (out-of-band install)", async () => {
    // 1. Cache is populated while the server exposes the ORIGINAL node set.
    getNodeDefs.mockResolvedValueOnce({ KSampler: {} });
    await expect(getObjectInfo()).resolves.toEqual({ KSampler: {} });

    // 2. ComfyUI is restarted OUT OF BAND with ComfyUI-GGUF + VideoHelperSuite
    //    installed. No mcp tool ran, so resetObjectInfoCache() was NEVER called.
    getNodeDefs.mockResolvedValue({
      KSampler: {},
      UnetLoaderGGUF: {},
      VHS_VideoCombine: {},
    });

    // 3. Still inside the window: the pre-restart snapshot is (correctly) served.
    vi.advanceTimersByTime(4_000);
    await expect(getObjectInfo()).resolves.not.toHaveProperty("UnetLoaderGGUF");
    expect(getNodeDefs).toHaveBeenCalledTimes(1);

    // 4. Once the window lapses, the next call refetches and reflects the LIVE
    //    node set — the newly-installed nodes are now known.
    vi.advanceTimersByTime(2_000); // total 6 s > 5 s TTL
    const fresh = await getObjectInfo();
    expect(fresh).toHaveProperty("UnetLoaderGGUF");
    expect(fresh).toHaveProperty("VHS_VideoCombine");
    expect(getNodeDefs).toHaveBeenCalledTimes(2);
  });

  it("treats a backward system-clock jump as expired (rollback can't extend the window)", async () => {
    // 1. Cache is populated while the server exposes the ORIGINAL node set.
    getNodeDefs.mockResolvedValueOnce({ KSampler: {} });
    await expect(getObjectInfo()).resolves.toEqual({ KSampler: {} });

    // 2. ComfyUI is restarted OUT OF BAND with a new pack installed.
    getNodeDefs.mockResolvedValue({ KSampler: {}, UnetLoaderGGUF: {} });

    // 3. The system clock steps BACKWARD by an hour (NTP step / VM snapshot
    //    restore / manual correction) — far more than the 5 s TTL. With a raw
    //    Date.now() age this goes negative and the stale snapshot would read
    //    "fresh" for ~an hour, so the out-of-band change would stay stale.
    vi.setSystemTime(new Date("2026-07-29T23:00:00Z")); // 1 h before the base time

    // 4. The next call must treat the negative age as expired, refetch, and
    //    reflect the LIVE node set rather than the stuck snapshot.
    const fresh = await getObjectInfo();
    expect(fresh).toHaveProperty("UnetLoaderGGUF");
    expect(getNodeDefs).toHaveBeenCalledTimes(2);

    // 5. The refetch re-stamps the timestamp against the corrected clock, so
    //    normal within-window caching resumes immediately (no per-call refetch).
    const again = await getObjectInfo();
    expect(again).toBe(fresh);
    expect(getNodeDefs).toHaveBeenCalledTimes(2);
  });

  it("coalesces the post-window refetch so concurrent callers share one fetch", async () => {
    getNodeDefs.mockResolvedValueOnce({ KSampler: {} });
    await getObjectInfo();

    vi.advanceTimersByTime(6_000); // window lapsed

    let release!: (v: unknown) => void;
    getNodeDefs.mockReturnValueOnce(new Promise((r) => (release = r)));
    const p1 = getObjectInfo();
    const p2 = getObjectInfo();
    release({ KSampler: {}, NewNode: {} });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    // One initial fetch + exactly one refetch shared by both concurrent callers.
    expect(getNodeDefs).toHaveBeenCalledTimes(2);
  });
});
