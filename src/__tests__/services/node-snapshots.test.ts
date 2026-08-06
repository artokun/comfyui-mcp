import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The product builds snapshot paths with node:path.join, so separators differ
// per-platform. Mirror the exact construction here instead of hardcoding POSIX
// paths so the string compares hold on both Windows and POSIX.
const COMFY = "/fake/comfyui";
const managerSnapshotDir = join(COMFY, "user", "__manager", "snapshots");
const legacySnapshotDir = join(
  COMFY,
  "user",
  "default",
  "ComfyUI-Manager",
  "snapshots",
);

// ---------------------------------------------------------------------------
// Mocks. config and node:fs are mocked so the file-write path has no real
// side effects; global.fetch is stubbed per-test for the Manager HTTP API.
// ---------------------------------------------------------------------------

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/fake/comfyui" as string | undefined },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
}));

// #775 — named saves resolve the local install root through
// resolveEffectiveComfyUIBase (COMFYUI_PATH, then the saved default workspace),
// not a bare config.comfyuiPath check. Control the saved-default half here.
const wsMock = vi.hoisted(() => ({
  saved: undefined as string | undefined,
  remote: false,
}));
vi.mock("../../services/workspace-env.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/workspace-env.js")>();
  const effective = () => (config as { comfyuiPath?: string }).comfyuiPath ?? wsMock.saved;
  return {
    ...actual,
    resolveEffectiveComfyUIBase: effective,
    // Destructive snapshot paths now resolve through this seam instead (codex
    // gate P0), so it has to be controllable here too — the real one calls
    // `resolveEffectiveComfyUIBase` module-internally, where the override above
    // cannot reach it. `remote` is the case the gate was about: a stale local
    // COMFYUI_PATH while connected to a remote server must REFUSE, not write.
    resolveLocalMutationTarget: () => {
      if (wsMock.remote) {
        return {
          refusal:
            "this session targets a REMOTE ComfyUI (--comfyui-url), so there is no local " +
            "install this operation can safely modify.",
        };
      }
      const base = effective();
      return base
        ? { base }
        : {
            refusal:
              "no local ComfyUI install path could be established: COMFYUI_PATH is unset and " +
              "no default workspace is saved (set one with the workspace tool, action " +
              "'set_default').",
          };
    },
  };
});

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// The three fsMocks stay per-test controllable; everything else delegates to
// the REAL fs because restoreNodeSnapshot now takes the panel mutation lock
// (panel-pin-guard), which is a real file — a partial mock left the lock's
// open/write undefined and every restore failed closed.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    ...fsMocks,
    // Pending-operation markers are deliberately read back before a deferred
    // restore starts. Keep snapshot file writes mocked, but make this one marker
    // write real so its durability check exercises the production contract.
    // Since #798 the marker write is ATOMIC and DURABLE (durable-write.ts):
    // content goes to a `<pending>.tmp-*` sibling through a real file
    // DESCRIPTOR and is then renamed over the marker — so the fd-form write
    // must reach the real fs as well, or the rename publishes a 0-byte file.
    writeFileSync: (...args: Parameters<typeof import("node:fs")["writeFileSync"]>) => {
      fsMocks.writeFileSync(...args);
      if (typeof args[0] === "number") {
        return real.writeFileSync(...args);
      }
      if (String(args[0]) === process.env.COMFYUI_MCP_PANEL_PENDING) {
        return real.writeFileSync(...args);
      }
    },
  };
});

// The panel mutation lock is a FILE (panel-pin-guard). Point it at a temp path
// so the suite never touches ~/.comfyui-mcp, and so parallel vitest workers get
// their own lock instead of serializing on one shared file.
process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-snapshots-${process.pid}.lock`,
);
process.env.COMFYUI_MCP_PANEL_PENDING = join(
  tmpdir(),
  `cmcp-pending-snapshots-${process.pid}.json`,
);

// restoreNodeSnapshot now consults the panel version pin (a restore reverts
// EVERY pack, panel included — same bulk door as update all). This suite is not
// about pinning, so use the documented env escape hatch to say plainly "no pin
// here" rather than reshaping the fs mocks the pin store reads through.
process.env.COMFYUI_MCP_PANEL_PIN = "off";

import {
  saveNodeSnapshot,
  restoreNodeSnapshot,
  listNodeSnapshots,
  cancelPendingSnapshotRestore,
} from "../../services/node-snapshots.js";
import { NodeSnapshotError } from "../../utils/errors.js";
import { config } from "../../config.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.mkdirSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  (config as { comfyuiPath?: string }).comfyuiPath = "/fake/comfyui";
  wsMock.saved = undefined;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listNodeSnapshots", () => {
  it("returns the items array from /snapshot/getlist", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: ["2024-01-02_03-04-05_snapshot", "prod"] }),
    );
    const result = await listNodeSnapshots();
    expect(result.snapshots).toEqual([
      "2024-01-02_03-04-05_snapshot",
      "prod",
    ]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8188/snapshot/getlist");
  });

  it("returns empty array when items is missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const result = await listNodeSnapshots();
    expect(result.snapshots).toEqual([]);
  });

  it("filters non-string items", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: ["a", 5, null, "b"] }));
    const result = await listNodeSnapshots();
    expect(result.snapshots).toEqual(["a", "b"]);
  });

  it("throws NodeSnapshotError on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(listNodeSnapshots()).rejects.toBeInstanceOf(NodeSnapshotError);
  });

  it("wraps network failures in NodeSnapshotError", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(listNodeSnapshots()).rejects.toBeInstanceOf(NodeSnapshotError);
  });

  it("returns a graceful 'unsupported' result on 404 (Manager build lacks /snapshot/*)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 404));
    const result = await listNodeSnapshots();
    expect(result.unsupported).toBe(true);
    expect(result.snapshots).toEqual([]);
    expect(result.message).toMatch(/aren't supported/i);
  });
});

describe("snapshot family graceful 404 (unsupported Manager build)", () => {
  it("save (no name) returns unsupported instead of throwing on a 404", async () => {
    // First call is the before-list getlist → 404.
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 404));
    const result = await saveNodeSnapshot();
    expect(result.unsupported).toBe(true);
    expect(result.message).toMatch(/aren't supported/i);
  });

  it("save (named) returns unsupported when get_current 404s", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 404));
    const result = await saveNodeSnapshot("prod-baseline");
    expect(result.unsupported).toBe(true);
    expect(result.method).toBe("file");
    // No file is written on the unsupported path.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("restore returns unsupported instead of throwing on a 404", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 404));
    const result = await restoreNodeSnapshot("prod");
    expect(result.unsupported).toBe(true);
    expect(result.name).toBe("prod");
    expect(result.message).toMatch(/aren't supported/i);
  });

  it("still throws on a genuine 500 (not an unsupported endpoint)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(restoreNodeSnapshot("prod")).rejects.toBeInstanceOf(NodeSnapshotError);
  });
});

describe("saveNodeSnapshot (no name — HTTP path)", () => {
  it("POSTs /snapshot/save and reports the newly created name via list diff", async () => {
    // before getlist
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: ["old"] }));
    // save POST
    fetchMock.mockResolvedValueOnce(jsonResponse({}, true, 200));
    // after getlist
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: ["2024-05-25_10-00-00_snapshot", "old"] }),
    );

    const result = await saveNodeSnapshot();
    expect(result.method).toBe("http");
    expect(result.name).toBe("2024-05-25_10-00-00_snapshot");

    // Verify the save call was a POST to the right endpoint.
    const saveCall = fetchMock.mock.calls[1];
    expect(saveCall[0]).toBe("http://127.0.0.1:8188/snapshot/save");
    expect(saveCall[1]).toMatchObject({ method: "POST" });

    // No files written on the HTTP path.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("falls back to newest list entry when diff finds nothing new", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: ["only"] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, true, 200));
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: ["only"] }));
    const result = await saveNodeSnapshot();
    expect(result.name).toBe("only");
  });

  it("treats whitespace-only name as no name (HTTP path)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, true, 200));
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: ["x_snapshot"] }));
    const result = await saveNodeSnapshot("   ");
    expect(result.method).toBe("http");
  });
});

describe("saveNodeSnapshot (named — file path)", () => {
  it("fetches get_current and writes <name>.json to the snapshots dir", async () => {
    const state = { comfyui: "abc123", git_custom_nodes: {} };
    fetchMock.mockResolvedValueOnce(jsonResponse(state));

    const result = await saveNodeSnapshot("prod-baseline");
    expect(result.method).toBe("file");
    expect(result.name).toBe("prod-baseline.json");

    // get_current was fetched.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8188/snapshot/get_current",
    );

    // Wrote to the newest-layout dir (none existed, so candidate[0]).
    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, contents] = fsMocks.writeFileSync.mock.calls[0];
    expect(writtenPath).toBe(join(managerSnapshotDir, "prod-baseline.json"));
    expect(JSON.parse(contents as string)).toEqual(state);
    // Dir was created since existsSync returned false.
    expect(fsMocks.mkdirSync).toHaveBeenCalled();
  });

  it("writes into an existing Manager snapshots dir when one is present", async () => {
    // Make the legacy default-layout dir "exist". The product builds the path
    // with node:path.join (OS separators), so normalize before substring match.
    fsMocks.existsSync.mockImplementation((p: unknown) =>
      String(p).replace(/\\/g, "/").includes("user/default/ComfyUI-Manager/snapshots"),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ comfyui: "x" }));

    await saveNodeSnapshot("named");
    const [writtenPath] = fsMocks.writeFileSync.mock.calls[0];
    expect(writtenPath).toBe(join(legacySnapshotDir, "named.json"));
    // Dir existed, so no mkdir.
    expect(fsMocks.mkdirSync).not.toHaveBeenCalled();
  });

  it("writes a custom_nodes-wrapped YAML file for a .yaml name", async () => {
    const state = {
      comfyui: "abc",
      cnr_custom_nodes: { "comfyui-impact-pack": "1.0.0" },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(state));

    const result = await saveNodeSnapshot("prod.yaml");
    expect(result.name).toBe("prod.yaml");

    const [writtenPath, contents] = fsMocks.writeFileSync.mock.calls[0];
    expect(writtenPath).toBe(join(managerSnapshotDir, "prod.yaml"));
    // comfy-cli/cm-cli YAML contract: body wrapped under `custom_nodes:`.
    expect(contents).toMatch(/^custom_nodes:/);
    expect(contents).toContain('"comfyui-impact-pack": "1.0.0"');
  });

  it("does not double-append .json when the name already ends in .json", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ comfyui: "x" }));
    await saveNodeSnapshot("prod.json");
    const [writtenPath] = fsMocks.writeFileSync.mock.calls[0];
    expect(writtenPath).toBe(join(managerSnapshotDir, "prod.json"));
  });

  it("errors clearly when comfyuiPath is undefined (remote mode)", async () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    await expect(saveNodeSnapshot("name")).rejects.toBeInstanceOf(
      NodeSnapshotError,
    );
    // Must not have made any HTTP call or written files.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("#775 resolves a named save from the SAVED DEFAULT WORKSPACE when COMFYUI_PATH is unset", async () => {
    // The reported defect: a local install connected via URL, default workspace
    // saved, was told "remote (--comfyui-url) mode" by code that only checked
    // config.comfyuiPath. The shared resolver (install_comfyui (action:"environment") / extra_paths)
    // knows the workspace — the snapshot must be written under IT.
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    wsMock.saved = "/saved/ws";
    const state = { comfyui: "abc123", git_custom_nodes: {} };
    fetchMock.mockResolvedValueOnce(jsonResponse(state));

    const result = await saveNodeSnapshot("pre-cleanup");
    expect(result.method).toBe("file");
    const [writtenPath] = fsMocks.writeFileSync.mock.calls[0] ?? [];
    expect(writtenPath).toBe(
      join("/saved/ws", "user", "__manager", "snapshots", "pre-cleanup.json"),
    );
  });

  it("#775 the no-local-root refusal names what was actually checked (not a blanket 'remote mode')", async () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    wsMock.saved = undefined;
    const err = await saveNodeSnapshot("name").catch((e: Error) => e);
    expect(err).toBeInstanceOf(NodeSnapshotError);
    expect(err.message).toMatch(/COMFYUI_PATH is unset/);
    expect(err.message).toMatch(/default workspace/);
    expect(err.message).not.toMatch(/unavailable in remote \(--comfyui-url\) mode/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("#775 cancelPendingSnapshotRestore checks the saved default workspace, not just COMFYUI_PATH", async () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    wsMock.saved = "/saved/ws";
    const result = cancelPendingSnapshotRestore();
    // Not the false "remote" verdict: the local candidates WERE checked.
    expect(result.outcome).toBe("not-scheduled");
    expect(result.checkedPaths.length).toBeGreaterThan(0);
    expect(
      result.checkedPaths.every((p) => p.replace(/\\/g, "/").startsWith("/saved/ws/")),
    ).toBe(true);
  });

  it("rejects path-traversal names before any IO", async () => {
    await expect(saveNodeSnapshot("../evil")).rejects.toBeInstanceOf(
      NodeSnapshotError,
    );
    await expect(saveNodeSnapshot("a/b")).rejects.toBeInstanceOf(
      NodeSnapshotError,
    );
    await expect(saveNodeSnapshot("a\\b")).rejects.toBeInstanceOf(
      NodeSnapshotError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("restoreNodeSnapshot", () => {
  it("POSTs /snapshot/restore with the target in the JSON body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, true, 200));
    const result = await restoreNodeSnapshot("prod");
    expect(result.name).toBe("prod");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8188/snapshot/restore");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ target: "prod" });
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("strips a trailing .json from the target", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, true, 200));
    const result = await restoreNodeSnapshot("prod.json");
    expect(result.name).toBe("prod");
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({ target: "prod" });
  });

  it("throws on empty name without calling fetch", async () => {
    await expect(restoreNodeSnapshot("  ")).rejects.toBeInstanceOf(
      NodeSnapshotError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws NodeSnapshotError on non-2xx restore", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 400));
    await expect(restoreNodeSnapshot("prod")).rejects.toBeInstanceOf(
      NodeSnapshotError,
    );
  });

  it("refuses before contacting Manager when the deferred-restore marker cannot persist", async () => {
    // Make the marker's PARENT a regular file, so every read/write against it
    // fails. The mutation must not run without the durable warning a later pin
    // depends on.
    //
    // This used to set the env var to "\0", intending an fs-rejected path. It did
    // not do that: Node truncates a NUL assignment to "", and `panelPendingOpsPath`
    // treats an empty env var as UNSET — so the test silently fell back to the
    // developer's REAL ~/.comfyui-mcp/panel-pending-ops.json. It therefore tested
    // nothing it claimed, and wrote live pending-op markers into the user's own
    // state, where the orchestrator reads them and warns on every pin write. Same
    // class as #837 (the suite writing to the real .env) and #859 (the real OAuth
    // mirror). The blocker technique below is what update-comfyui.test.ts already
    // uses correctly for this same assertion.
    const blocker = join(tmpdir(), `cmcp-snapshot-pending-blocker-${process.pid}-${Date.now()}`);
    writeFileSync(blocker, "not a directory");
    const previous = process.env.COMFYUI_MCP_PANEL_PENDING;
    process.env.COMFYUI_MCP_PANEL_PENDING = join(blocker, "pending.json");
    try {
      await expect(restoreNodeSnapshot("prod")).rejects.toThrow(
        /Could not persist the pending snapshot-restore marker/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.COMFYUI_MCP_PANEL_PENDING;
      else process.env.COMFYUI_MCP_PANEL_PENDING = previous;
      rmSync(blocker, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #490 (reopened) — `resolveEffectiveComfyUIBase` returns `config.comfyuiPath`
// BEFORE it checks remote mode, so with --comfyui-url set and a stale local
// COMFYUI_PATH it hands back an install that has nothing to do with the server
// this session is talking to. Reading through it is survivable; WRITING and
// DELETING are not. These paths must refuse rather than act on a tree they
// cannot identify.

describe("destructive snapshot paths refuse when the target install cannot be established", () => {
  beforeEach(() => {
    wsMock.remote = true;
    wsMock.saved = undefined;
  });
  afterEach(() => {
    wsMock.remote = false;
  });

  it("a named save REFUSES in remote mode even with COMFYUI_PATH set", async () => {
    // The dangerous shape: a path IS available, so the old "no path" guard passes
    // and the write lands on an unrelated local install while the snapshot content
    // came from the remote server.
    (config as { comfyuiPath?: string }).comfyuiPath = "C:/stale/local/ComfyUI";
    await expect(saveNodeSnapshot("pinned")).rejects.toThrow(/REMOTE ComfyUI/i);
    // Nothing was written anywhere.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(fsMocks.mkdirSync).not.toHaveBeenCalled();
  });

  it("cancelPendingSnapshotRestore REFUSES in remote mode even with COMFYUI_PATH set", () => {
    (config as { comfyuiPath?: string }).comfyuiPath = "C:/stale/local/ComfyUI";
    const res = cancelPendingSnapshotRestore();
    expect(res.outcome).toBe("remote");
    expect(res.detail).toMatch(/REMOTE ComfyUI/i);
    expect(res.detail).toMatch(/Nothing was deleted/);
    expect(res.deletedPaths).toEqual([]);
  });
});
