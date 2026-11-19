import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ remote: true, base: "http://manager.test:8188" }));
const noProcess = vi.hoisted(() => vi.fn(() => { throw new Error("Unexpected subprocess"); }));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined },
  getComfyUIBaseUrl: () => state.base,
  getComfyuiTargetGeneration: () => 0,
  isRemoteMode: () => state.remote,
}));
vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (url: string, init?: RequestInit) => fetch(url, init),
  raceAbort: (_signal: AbortSignal, read: () => Promise<string>) => read(),
  describeComfyBodyTimeout: () => ({ message: "body timed out" }),
}));
vi.mock("../../comfyui/client.js", () => ({ resetObjectInfoCache: vi.fn() }));
vi.mock("../../services/workspace-env.js", () => ({
  detectLocalWriteTargetMismatch: async () => undefined,
  resolveEffectiveComfyUIBase: () => undefined,
  resolveEffectiveComfyUICodeBase: () => undefined,
  resolveCustomNodesScanBaseLiveStrict: async () => undefined,
  resolveInstallInterpreter: noProcess,
}));
vi.mock("../../services/panel-pin-guard.js", () => ({
  withPanelPinGuard: (_op: string, _id: string, run: () => Promise<unknown>) => run(),
  withPanelMutationLock: (run: () => Promise<unknown>) => run(),
}));
vi.mock("../../services/comfy-cli.js", () => ({
  resolveComfyCliExecutable: () => undefined,
  getComfyCliVersion: () => undefined,
  isSupportedComfyCliVersion: () => false,
  isComfyCliUsable: () => false,
  assertComfyCliOk: noProcess,
  runComfyCliSync: noProcess,
}));
vi.mock("node:child_process", () => ({ execFileSync: noProcess }));
vi.mock("../../services/node-authoring.js", () => ({ parsePyproject: noProcess }));
vi.mock("../../services/registry-client.js", () => ({ getNodePackDetails: noProcess }));

import { installCustomNode, setQueueTimingForTests } from "../../services/node-management.js";
import { resetManagerApiCache, setManagerApiCacheForTests } from "../../services/manager-api-cache.js";

const URL = "https://github.com/example/uncatalogued-pack";
const installed = { "uncatalogued-pack": { ver: "unknown", aux_id: "example/uncatalogued-pack", enabled: true } };
const idle = { total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false };
type Call = { path: string; method: string; body: BodyInit | null | undefined; url: string };
let calls: Call[];
let unexpected: string[];
function stub(options: {
  gitResponse?: () => Response | Promise<Response>;
  installedResponse?: () => Response;
  enqueueResponse?: () => Response;
  statusAfterStart?: () => Response;
} = {}) {
  let started = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new globalThis.URL(url).pathname;
    calls.push({ path, url, method: init?.method ?? "GET", body: init?.body });
    if (path.startsWith("/v2/")) return new Response("missing", { status: 404 });
    if (path === "/manager/version") return new Response("V3.41");
    if (path === "/manager/queue/status") {
      return started && options.statusAfterStart ? options.statusAfterStart() : Response.json(idle);
    }
    if (path === "/customnode/install/git_url") {
      return options.gitResponse ? options.gitResponse() : new Response("");
    }
    if (path === "/manager/queue/install") return options.enqueueResponse?.() ?? new Response("");
    if (path === "/manager/queue/start") { started = true; return new Response("", { status: 201 }); }
    if (path === "/customnode/installed") return options.installedResponse?.() ?? Response.json(installed);
    unexpected.push(path);
    throw new Error(`Unexpected request ${path}`);
  }));
}
beforeEach(() => {
  calls = []; unexpected = []; state.remote = true; state.base = "http://manager.test:8188";
  noProcess.mockClear(); resetManagerApiCache();
  setQueueTimingForTests({ pollIntervalMs: 1, startupGraceMs: 0, timeoutMs: 25 });
});
afterEach(() => {
  expect(unexpected).toEqual([]);
  expect(noProcess).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); resetManagerApiCache(); setQueueTimingForTests();
});
const mutations = () => calls.filter((c) => c.method === "POST");

describe("legacy install endpoint contracts (#2883)", () => {
  it("installs an uncatalogued Git URL on the server without queueing by basename", async () => {
    stub();
    const result = await installCustomNode({ id: URL, source: "git" });
    expect(mutations()).toEqual([expect.objectContaining({ path: "/customnode/install/git_url", body: URL })]);
    expect(result.message).toContain("installed or already present");
    expect(result.message).toContain("node registration were not verified");
    expect(result.details).toMatchObject({ base: "http://manager.test:8188", runtimeVerified: false });
  });
  it("starts and drains the legacy registry queue after its documented empty200 ack", async () => {
    stub({ installedResponse: () => Response.json({ pack: { ver: "1.0", cnr_id: "pack", enabled: true } }) });
    const result = await installCustomNode({ id: "pack", source: "registry" });
    expect(result.mechanism).toBe("manager-http");
    expect(mutations().map((c) => c.path)).toEqual(["/manager/queue/install", "/manager/queue/start"]);
  });
  it.each(["null", "<!doctype html><html>login</html>", '{"error":"denied"}', " "])(
    "does not treat %s as a legacy enqueue acknowledgment", async (body) => {
      stub({ enqueueResponse: () => new Response(body) });
      await expect(installCustomNode({ id: "pack", source: "registry" })).rejects.toMatchObject({
        details: { kind: "manager-enqueue-invalid-response" },
      });
      expect(mutations().map((c) => c.path)).toEqual(["/manager/queue/install"]);
    },
  );
  it.each([204, 202])("does not infer the pinned empty200 contract from HTTP %s", async (status) => {
    stub({ enqueueResponse: () => new Response(null, { status }) });
    await expect(installCustomNode({ id: "pack" })).rejects.toMatchObject({ details: { kind: "manager-enqueue-invalid-response" } });
    expect(mutations()).toHaveLength(1);
  });
  it.each([null, {}, { total_count: "0", done_count: "0", is_processing: false }, { error: "offline" }])(
    "does not turn invalid post-enqueue status %j into completion", async (status) => {
      stub({ statusAfterStart: () => Response.json(status) });
      await expect(installCustomNode({ id: "pack" })).rejects.toThrow(/UNKNOWN/);
      expect(mutations()).toHaveLength(2);
    },
  );
  it.each(["null", "<html>login</html>", '{"error":"denied"}'])("rejects invalid direct success %s without replay", async (body) => {
    stub({ gitResponse: () => new Response(body) });
    await expect(installCustomNode({ id: URL })).rejects.toMatchObject({ details: { kind: "manager-git-url-unverified" } });
    expect(mutations()).toHaveLength(1);
  });
  it.each([{}, { "uncatalogued-pack": { ver: "unknown", aux_id: "someone-else/uncatalogued-pack" } }])(
    "keeps absent/wrong-origin post-state unknown even after empty200 %j", async (body) => {
      state.remote = false;
      stub({ installedResponse: () => Response.json(body) });
      await expect(installCustomNode({ id: URL })).rejects.toThrow(/UNKNOWN/);
      expect(mutations()).toHaveLength(1);
    },
  );
  it("preserves policy refusal and explains why requested CLI was not used", async () => {
    state.remote = false;
    stub({ gitResponse: () => Response.json({ error: "security_level" }, { status: 403 }) });
    const error = await installCustomNode({ id: URL, useCmCli: true }).catch((err) => err);
    expect(error.message).toMatch(/comfy-cli was requested.*no local ComfyUI install/s);
    expect(error.message).toMatch(/security policy refused/);
    expect(error.details).toMatchObject({ status: 403 });
    expect(mutations()).toHaveLength(1);
  });
  it("keeps a lost direct reply UNKNOWN and never replays", async () => {
    stub({ gitResponse: () => Promise.reject(new Error("connection reset after submission")) });
    await expect(installCustomNode({ id: URL })).rejects.toThrow(/UNKNOWN/);
    expect(mutations()).toHaveLength(1);
  });
  it.each([400, 401, 404, 500])("does not replay a direct HTTP %s through queue or local clone", async (status) => {
    state.remote = false;
    stub({ gitResponse: () => new Response("request failed", { status }) });
    await expect(installCustomNode({ id: URL })).rejects.toMatchObject({
      details: { kind: "manager-git-url-unverified", status },
    });
    expect(mutations()).toHaveLength(1);
  });
  it("does not enqueue a legacy basename after a warm v2 dialect changes", async () => {
    stub();
    setManagerApiCacheForTests(state.base, "v2");
    await expect(installCustomNode({ id: URL })).rejects.toMatchObject({
      details: { kind: "manager-git-dialect-changed" },
    });
    expect(mutations().map((call) => call.path)).toEqual(["/v2/manager/queue/task"]);
  });
  it("a delayed server install never launches a later local fallback", async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    let reached!: () => void;
    const submitted = new Promise<void>((resolve) => { reached = resolve; });
    stub({ gitResponse: () => { reached(); return response; } });
    const install = installCustomNode({ id: URL, allowLocalFallbackAfterEmptyV2Enqueue: false });
    await submitted;
    expect(mutations()).toHaveLength(1);
    release(new Response(""));
    await expect(install).resolves.toMatchObject({ mechanism: "manager-http" });
    expect(mutations()).toHaveLength(1);
  });
  it("keeps an unreadable installed list UNKNOWN", async () => {
    stub({ installedResponse: () => new Response("offline", { status: 503 }) });
    await expect(installCustomNode({ id: URL })).rejects.toThrow(/UNKNOWN/);
    expect(mutations()).toHaveLength(1);
  });
  it.each([{ ref: "dev" }, { version: "v1.2" }, { id: `${URL}#dev` }, { id: `${URL}/tree/dev` }])(
    "refuses unsupported ref selection before a write: %j", async (options) => {
      stub();
      await expect(installCustomNode({ id: URL, ...options })).rejects.toMatchObject({ details: { kind: "manager-legacy-git-ref-unsupported" } });
      expect(mutations()).toEqual([]);
    },
  );
  it("keeps verification on the original target after an in-flight retarget", async () => {
    stub({ gitResponse: () => { state.base = "http://other.test:8188"; return new Response(""); } });
    const result = await installCustomNode({ id: URL });
    expect(calls.every((c) => c.url.startsWith("http://manager.test:8188"))).toBe(true);
    expect(result.details).toMatchObject({ base: "http://manager.test:8188" });
  });
});
