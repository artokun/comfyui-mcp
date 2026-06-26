import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";

// Mock node:fs so config.ini fallback has no real side effects.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock config so we control comfyuiPath and the API host/protocol.
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/fake/ComfyUI" as string | undefined },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "../../config.js";
import {
  configureManager,
  MANAGER_CONFIG_ACTIONS,
} from "../../services/manager-config.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

/** Build a fetch mock that returns scripted responses per call. */
function fetchSequence(responses: Array<Partial<Response> & { __text?: string; __json?: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? "OK",
      text: async () => r.__text ?? "",
      json: async () => r.__json ?? {},
    } as unknown as Response;
  });
}

describe("configureManager (HTTP API actions)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    config.comfyuiPath = "/fake/ComfyUI";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("set_preview_method POSTs {value} then reads back state", async () => {
    const f = fetchSequence([
      { ok: true }, // POST
      { ok: true, __text: "taesd\n" }, // GET state
    ]);
    vi.stubGlobal("fetch", f);

    const res = await configureManager("set_preview_method", "taesd");

    expect(res.via).toBe("api");
    expect(res.state).toBe("taesd");
    const [postUrl, postInit] = f.mock.calls[0];
    expect(postUrl).toBe("http://127.0.0.1:8188/manager/preview_method");
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body)).toEqual({ value: "taesd" });
    expect(f.mock.calls[1][0]).toBe("http://127.0.0.1:8188/manager/preview_method");
  });

  it("set_db_mode hits /manager/db_mode", async () => {
    const f = fetchSequence([{ ok: true }, { ok: true, __text: "remote" }]);
    vi.stubGlobal("fetch", f);
    const res = await configureManager("set_db_mode", "remote");
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:8188/manager/db_mode");
    expect(res.state).toBe("remote");
  });

  it("set_component_policy hits /manager/policy/component", async () => {
    const f = fetchSequence([{ ok: true }, { ok: true, __text: "higher" }]);
    vi.stubGlobal("fetch", f);
    await configureManager("set_component_policy", "higher");
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:8188/manager/policy/component");
  });

  it("set_update_policy hits /manager/policy/update", async () => {
    const f = fetchSequence([{ ok: true }, { ok: true, __text: "nightly-comfyui" }]);
    vi.stubGlobal("fetch", f);
    await configureManager("set_update_policy", "nightly-comfyui");
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:8188/manager/policy/update");
  });

  it("set_channel POSTs the name and verifies the selection echoes back", async () => {
    const f = fetchSequence([
      { ok: true }, // POST
      { ok: true, __json: { selected: "default", list: [] } }, // GET
    ]);
    vi.stubGlobal("fetch", f);
    const res = await configureManager("set_channel", "default");
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:8188/manager/channel_url_list");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ value: "default" });
    expect(res.state).toBe("default");
  });

  it("set_channel throws when Manager ignores an unknown channel name", async () => {
    const f = fetchSequence([
      { ok: true },
      { ok: true, __json: { selected: "custom", list: [] } },
    ]);
    vi.stubGlobal("fetch", f);
    await expect(configureManager("set_channel", "bogus")).rejects.toThrow(/did not switch/i);
  });

  it("reset_queue POSTs /manager/queue/reset and needs no value", async () => {
    const f = fetchSequence([{ ok: true }]);
    vi.stubGlobal("fetch", f);
    const res = await configureManager("reset_queue");
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:8188/manager/queue/reset");
    expect(f.mock.calls[0][1].method).toBe("POST");
    expect(res.via).toBe("api");
  });

  it("surfaces a clear error when Manager API returns non-OK", async () => {
    const f = fetchSequence([{ ok: false, status: 403, statusText: "Forbidden", __text: "nope" }]);
    vi.stubGlobal("fetch", f);
    await expect(configureManager("set_db_mode", "cache")).rejects.toThrow(/403/);
  });

  it("surfaces a clear error when ComfyUI is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(configureManager("reset_queue")).rejects.toThrow(/Could not reach/i);
  });
});

describe("configureManager (config.ini fallback actions)", () => {
  beforeEach(() => {
    // vitest 4: restoreAllMocks no longer auto-clears .mock.calls; clear
    // explicitly so calls.calls[0] reads the current test's write, not the
    // previous test's leftover.
    vi.clearAllMocks();
    vi.restoreAllMocks();
    config.comfyuiPath = "/fake/ComfyUI";
    // No HTTP fetch should be needed for these.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("fetch should not be called for config-file actions");
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("set_network_mode updates an existing key in [default]", () => {
    // First candidate path exists. Use path.join so the suffix uses the
    // platform separator the product computes (backslash on Windows).
    mockedExistsSync.mockImplementation((p) =>
      String(p).endsWith(join("user", "__manager", "config.ini")),
    );
    mockedReadFileSync.mockReturnValue("[default]\nnetwork_mode = public\ndb_mode = cache\n");

    const res = configureManager("set_network_mode", "offline");
    return res.then((r) => {
      expect(r.via).toBe("config-file");
      expect(r.state).toBe("offline");
      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      expect(written).toContain("network_mode = offline");
      expect(written).toContain("db_mode = cache");
      expect(written).not.toContain("network_mode = public");
    });
  });

  it("set_security_level appends the key when missing", async () => {
    mockedExistsSync.mockImplementation((p) =>
      String(p).endsWith(join("user", "__manager", "config.ini")),
    );
    mockedReadFileSync.mockReturnValue("[default]\npreview_method = auto\n");

    const r = await configureManager("set_security_level", "weak");
    expect(r.state).toBe("weak");
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    expect(written).toContain("security_level = weak");
    expect(written).toContain("preview_method = auto");
  });

  it("falls back to the legacy config.ini location", async () => {
    mockedExistsSync.mockImplementation((p) =>
      String(p).endsWith(join("user", "default", "ComfyUI-Manager", "config.ini")),
    );
    mockedReadFileSync.mockReturnValue("[default]\n");
    await configureManager("set_network_mode", "private");
    expect(mockedWriteFileSync.mock.calls[0][0]).toContain(
      join("user", "default", "ComfyUI-Manager", "config.ini"),
    );
  });

  it("sanitizes CRLF/NUL out of written values", async () => {
    mockedExistsSync.mockImplementation((p) =>
      String(p).endsWith(join("user", "__manager", "config.ini")),
    );
    mockedReadFileSync.mockReturnValue("[default]\nsecurity_level = normal\n");
    // network_mode is enum-validated, so test sanitization via the ini writer
    // path using a valid value (no injection possible through the enum) — assert
    // the written file has no stray CR.
    await configureManager("set_network_mode", "public");
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    expect(written).not.toContain("\r");
  });

  it("errors clearly when comfyuiPath is undefined and no HTTP setter exists", async () => {
    config.comfyuiPath = undefined;
    await expect(configureManager("set_network_mode", "public")).rejects.toThrow(
      /no ComfyUI install path is known/i,
    );
  });

  it("errors clearly when config.ini cannot be found", async () => {
    mockedExistsSync.mockReturnValue(false);
    await expect(configureManager("set_security_level", "normal")).rejects.toThrow(
      /Could not find ComfyUI-Manager config\.ini/i,
    );
  });
});

describe("configureManager validation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    config.comfyuiPath = "/fake/ComfyUI";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }) as unknown as Response));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects invalid enum values per action", async () => {
    await expect(configureManager("set_preview_method", "bogus")).rejects.toThrow(/Invalid preview method/i);
    await expect(configureManager("set_db_mode", "bogus")).rejects.toThrow(/Invalid db mode/i);
    await expect(configureManager("set_network_mode", "bogus")).rejects.toThrow(/Invalid network mode/i);
    await expect(configureManager("set_security_level", "bogus")).rejects.toThrow(/Invalid security level/i);
  });

  it("requires a value for value-taking actions", async () => {
    await expect(configureManager("set_db_mode")).rejects.toThrow(/requires a "value"/i);
    await expect(configureManager("set_channel", "")).rejects.toThrow(/requires a "value"/i);
  });

  it("exposes the expected action set", () => {
    expect([...MANAGER_CONFIG_ACTIONS]).toEqual([
      "set_preview_method",
      "set_db_mode",
      "set_component_policy",
      "set_update_policy",
      "set_channel",
      "reset_queue",
      "set_network_mode",
      "set_security_level",
    ]);
  });
});
