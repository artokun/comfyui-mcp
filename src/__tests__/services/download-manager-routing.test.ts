import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for shouldDispatchDownloadToManager — the single routing decision
 * that keeps model downloads working after a panel/orchestrator RECONNECT drops
 * the effective ComfyUI base (#420). Distinct from #418 (base resolution at
 * START): here the base is LOST later, and a nominally-local (loopback) session
 * must fall back to the connected ComfyUI-Manager route — the same live server
 * list_local_models still reaches over HTTP — instead of throwing
 * "no local ComfyUI path configured".
 */

const hoisted = vi.hoisted(() => ({
  remote: false,
  base: undefined as string | undefined,
  stats: undefined as unknown,
  statsThrows: false,
  // Whether an argv-derived live root is present on THIS filesystem. A
  // Docker/forwarded loopback server's container path is not host-local → false.
  liveRootExists: true,
}));

// The live-root routing branch only streams local when the root exists locally.
vi.mock("node:fs", () => ({
  existsSync: () => hoisted.liveRootExists,
}));

// isRemoteMode is the first gate; keep every other real config export.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isRemoteMode: () => hoisted.remote };
});

// resolveEffectiveComfyUIBase is the "do we have a local base?" gate. Control it
// directly so the test doesn't depend on the host's real workspace config / FS.
vi.mock("../../services/workspace-env.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/workspace-env.js")>(
    "../../services/workspace-env.js",
  );
  return { ...actual, resolveEffectiveComfyUIBase: () => hoisted.base };
});

// getSystemStats stands in for the connected server's /system_stats. getClient is
// pulled in transitively by model-resolver; stub it so the import doesn't fail.
vi.mock("../../comfyui/client.js", () => ({
  getClient: () => ({ fetchApi: vi.fn() }),
  // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
  // returns a 4xx instead of throwing. Routed to the SAME spy so every
  // existing "which route did we ask for" assertion still pins the same thing.
  comfyApiFetch: (...a: unknown[]) => (vi.fn())(...(a as [string])),
  getSystemStats: vi.fn(async () => {
    if (hoisted.statsThrows) throw new Error("ECONNREFUSED");
    return hoisted.stats;
  }),
}));

import { shouldDispatchDownloadToManager } from "../../services/model-resolver.js";

beforeEach(() => {
  hoisted.remote = false;
  hoisted.base = undefined;
  hoisted.stats = undefined;
  hoisted.statsThrows = false;
  hoisted.liveRootExists = true;
});

describe("shouldDispatchDownloadToManager (#420 reconnect routing)", () => {
  it("REMOTE mode always dispatches to the Manager", async () => {
    hoisted.remote = true;
    // Even if a local base somehow resolves, remote wins (no local FS).
    hoisted.base = "/some/local/comfy";
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("streams LOCAL when a local base is resolvable (COMFYUI_PATH / default workspace)", async () => {
    hoisted.base = "/home/me/ComfyUI";
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("#420: no local base + reachable server WITHOUT --base-directory → Manager route", async () => {
    // The reconnect case: base lost, but the live server is still connected. It
    // was NOT launched with --base-directory, so there's no local dir to stream
    // to — hand the fetch to its Manager rather than failing.
    hoisted.base = undefined;
    hoisted.stats = { system: { argv: ["main.py", "--listen"] } };
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("#463: no local base + reachable server whose ABSOLUTE main.py root is resolvable → streams local", async () => {
    // A panel-connected local ComfyUI with no COMFYUI_PATH/default, launched with
    // an absolute main.py path and NO --base-directory. Its own install root is
    // derivable from argv (the same live-first root resolveModelsDir writes into),
    // so stream locally into it instead of bouncing through the Manager (which
    // would fail when Manager isn't installed).
    hoisted.base = undefined;
    hoisted.stats = {
      system: { argv: ["python", "/opt/ComfyUI/main.py", "--listen"] },
    };
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("no local base + reachable server whose absolute main.py root is NOT present locally (Docker/forwarded) → Manager route", async () => {
    // Container-side main.py path resolvable but not on the host FS — must NOT be
    // treated as a local stream target (would create a bogus host dir); route the
    // fetch through the connected Manager (server-side write) instead.
    hoisted.base = undefined;
    hoisted.liveRootExists = false;
    hoisted.stats = { system: { argv: ["python", "/app/ComfyUI/main.py"] } };
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("no local base + reachable server WITH --base-directory → still streams local", async () => {
    // Desktop install advertises its real base dir via argv; that dir is on this
    // same (loopback) filesystem, so keep the local streaming path.
    hoisted.base = undefined;
    hoisted.stats = {
      system: { argv: ["main.py", "--base-directory", "/data/ComfyUI"] },
    };
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("no local base + UNREACHABLE server → stays local so the resolver throws a clear error", async () => {
    hoisted.base = undefined;
    hoisted.statsThrows = true;
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("routes to Manager for a RELATIVE --base-directory with no server cwd — EVEN with COMFYUI_PATH set", async () => {
    // The server's real models dir is unknown (relative flag, no reported cwd); a
    // local write to COMFYUI_PATH/models would be the WRONG place, so the server-side
    // Manager fetch must win over the local base short-circuit (codex).
    hoisted.base = "/home/me/ComfyUI";
    hoisted.stats = { system: { argv: ["python", "main.py", "--base-directory", "data"] } };
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("routes to Manager for a RELATIVE --models-directory with no server cwd (no local base)", async () => {
    hoisted.base = undefined;
    hoisted.stats = { system: { argv: ["python", "main.py", "--models-directory", "models2"] } };
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("streams LOCAL for a relative flag that IS resolvable via the server cwd (base set)", async () => {
    hoisted.base = "/home/me/ComfyUI";
    hoisted.stats = {
      system: { argv: ["python", "main.py", "--base-directory", "data"], cwd: "/srv/live" },
    };
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });
});
