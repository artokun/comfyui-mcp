import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

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
  getComfyUIApiHost: () => "127.0.0.1:8188",
  getComfyUIProtocol: () => "http",
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => fsMocks);

import {
  saveNodeSnapshot,
  restoreNodeSnapshot,
  listNodeSnapshots,
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
});
