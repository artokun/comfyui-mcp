// #918 — "No local models found." was printed for three different situations, one
// of which was "we never got an answer".
//
// Against a remote ComfyUI that was still warming up, every `/models/<dir>` read
// failed silently, `httpReturnedAny` stayed false, the filesystem fallback returned
// [] because a remote setup has no comfyuiPath, and the tool printed the empty
// install sentence. A reporter read it as a misconfigured URL and told the user so.
// The same call returned the full list minutes later.
//
// The listing therefore has to carry HOW it knows, and the renderer has to decline
// to claim "none" when nothing answered.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const target = vi.hoisted(() => ({
  remote: false,
  generation: 0,
  baseUrl: "http://127.0.0.1:8188",
}));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
  getComfyUIBaseUrl: () => target.baseUrl,
  getComfyuiTargetGeneration: () => target.generation,
  isRemoteMode: () => target.remote,
}));

const fetchApi = vi.fn();
const getClient = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getClient: (...args: unknown[]) => getClient(...args),
  // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
  // returns a 4xx instead of throwing. Routed through the SAME double so every
  // existing impl and route assertion in this file keeps pinning the same thing.
  comfyApiFetch: (...a: unknown[]) =>
    (getClient() as { fetchApi: (...x: unknown[]) => unknown }).fetchApi(...a),
}));

const readdir = vi.fn();
const stat = vi.fn();
const readFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readdir: (...a: unknown[]) => readdir(...a),
  stat: (...a: unknown[]) => stat(...a),
  readFile: (...a: unknown[]) => readFile(...a),
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  utimes: vi.fn(),
}));

const { config } = await import("../../config.js");
const { listLocalModelsWithCoverage, describeUnparsableBody } = await import(
  "../../services/model-resolver.js"
);
const { describeEmptyModelListing, registerModelManagementTools } = await import(
  "../../tools/model-management.js"
);

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function registeredListLocalModelsTool(): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, ...rest: unknown[]) => {
      const candidate = rest.find((arg) => typeof arg === "function");
      if (typeof candidate === "function") handler = candidate as ToolHandler;
    },
  };
  registerModelManagementTools(server as never);
  if (!handler) throw new Error("list_local_models was not registered");
  return handler;
}

beforeEach(() => {
  getClient.mockReset();
  fetchApi.mockReset();
  readdir.mockReset();
  stat.mockReset();
  readFile.mockReset();
  readFile.mockRejectedValue(new Error("ENOENT"));
  config.comfyuiPath = "/comfy";
  target.remote = false;
  target.generation = 0;
  target.baseUrl = "http://127.0.0.1:8188";
});

afterEach(() => vi.clearAllMocks());

function advanceTarget(remote: boolean, baseUrl: string): void {
  target.remote = remote;
  target.baseUrl = baseUrl;
  target.generation += 1;
}

describe("#918: the listing records whether ComfyUI actually answered", () => {
  it("an OK empty array is an ANSWER — emptiness here is a verified fact", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("[]", { status: 200 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(models).toEqual([]);
    expect(coverage.answered).toEqual(["checkpoints"]);
    expect(coverage.unanswered).toEqual([]);
  });

  it("a non-OK status is NOT an answer, and the status is kept", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("nope", { status: 503 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered).toEqual([{ dir: "checkpoints", reason: "HTTP 503" }]);
  });

  // The reported shape: a proxy or a still-starting server answers 200 with an
  // HTML login/placeholder page. The old code `continue`d and the category
  // vanished without trace; res.json() would have raised the bare
  // `Unexpected token '<', "<!doctype "...` the reporter flagged on the sibling
  // tool. Name the condition instead of leaking the parser's message.
  it("a 200 carrying HTML is reported as HTML, not as a JSON parser error", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("<!doctype html><html>…", { status: 200 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered[0].reason).toMatch(/returned HTML instead of JSON/);
    expect(coverage.unanswered[0].reason).toMatch(/still starting/);
    expect(coverage.unanswered[0].reason).not.toMatch(/Unexpected token/);
  });

  it("valid JSON of the wrong shape is distinguished from HTML", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 200 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.unanswered[0].reason).toMatch(/JSON but not an array/);
  });

  it("a thrown fetch is recorded with its message, not swallowed", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.4:8188"));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.unanswered[0].reason).toMatch(/ECONNREFUSED/);
  });

  // The exact #918 shape: remote (no comfyuiPath), so there is no second source
  // to consult, and the empty array carries no information whatsoever.
  it("remote + no answer sets noSourceAvailable — nothing was learned at all", async () => {
    config.comfyuiPath = undefined;
    target.remote = true;
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("fetch failed"));
    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(models).toEqual([]);
    expect(coverage.noSourceAvailable).toBe(true);
    expect(coverage.unanswered).toHaveLength(1);
  });

  it("a local install with an unreachable server still reports the categories it could not read", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("fetch failed"));
    readdir.mockResolvedValue(["sd_xl.safetensors"]);
    stat.mockResolvedValue({ isFile: () => true, size: 1024, mtime: new Date(0) });
    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(models).toHaveLength(1); // the FS scan saved it
    expect(coverage.usedFilesystem).toBe(true);
    expect(coverage.noSourceAvailable).toBeUndefined();
    expect(coverage.unanswered).toHaveLength(1);
  });

  it("a remote target never scans a stale local COMFYUI_PATH", async () => {
    config.comfyuiPath = "/comfy";
    target.remote = true;
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("remote fetch failed"));
    readdir.mockResolvedValue(["host-only.safetensors"]);
    stat.mockResolvedValue({ isFile: () => true, size: 1024, mtime: new Date(0) });

    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");

    expect(models).toEqual([]);
    expect(coverage.usedFilesystem).toBe(false);
    expect(coverage.noSourceAvailable).toBe(true);
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("discards local names and paths when local becomes remote during stat", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("local server fetch failed"));
    readdir.mockResolvedValue(["stale-local.safetensors"]);
    stat.mockImplementation(async () => {
      advanceTarget(true, "https://remote.example/comfy");
      return { isFile: () => true, size: 1024, mtime: new Date(0) };
    });

    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");

    expect(models).toEqual([]);
    expect(coverage.targetChanged).toEqual({
      startedBaseUrl: "http://127.0.0.1:8188",
      currentBaseUrl: "https://remote.example/comfy",
    });
    expect(coverage.usedFilesystem).toBe(false);
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered).toEqual([]);
    expect(readdir).toHaveBeenCalledWith(join("/comfy", "models", "checkpoints"), { recursive: true });
    expect(stat).toHaveBeenCalledWith(
      join("/comfy", "models", "checkpoints", "stale-local.safetensors"),
    );
  });

  it("refuses remote results when the target becomes local before HTTP failure falls back", async () => {
    config.comfyuiPath = "/comfy";
    target.remote = true;
    target.baseUrl = "https://remote.example/comfy";
    target.generation = 10;
    getClient.mockReturnValue({ fetchApi });
    let rejectFetch!: (reason: unknown) => void;
    fetchApi.mockReturnValue(
      new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
      }),
    );

    const pending = listLocalModelsWithCoverage("checkpoints");
    expect(fetchApi).toHaveBeenCalledWith("/models/checkpoints");
    advanceTarget(false, "http://127.0.0.1:8188");
    rejectFetch(new Error("remote server disconnected"));

    const { models, coverage } = await pending;

    expect(models).toEqual([]);
    expect(coverage.targetChanged).toEqual({
      startedBaseUrl: "https://remote.example/comfy",
      currentBaseUrl: "http://127.0.0.1:8188",
    });
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("uses generation, not final identity, to reject a local-to-remote-to-local round trip", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("local server fetch failed"));
    readdir.mockResolvedValue(["round-trip-stale.safetensors"]);
    stat.mockImplementation(async () => {
      advanceTarget(true, "https://remote.example/comfy");
      advanceTarget(false, "http://127.0.0.1:8188");
      return { isFile: () => true, size: 1024, mtime: new Date(0) };
    });

    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");

    expect(models).toEqual([]);
    expect(coverage.targetChanged).toEqual({
      startedBaseUrl: "http://127.0.0.1:8188",
      currentBaseUrl: "http://127.0.0.1:8188",
    });
    expect(coverage.usedFilesystem).toBe(false);
    expect(stat).toHaveBeenCalled();
  });

  // getClient throws in cloud mode, before any per-category read runs. Every
  // requested category is then unanswered — not answered-and-empty.
  it("an outright unavailable client marks EVERY requested category unanswered", async () => {
    config.comfyuiPath = undefined;
    target.remote = true;
    getClient.mockImplementation(() => {
      throw new Error("CLOUD_UNSUPPORTED");
    });
    const { coverage } = await listLocalModelsWithCoverage();
    expect(coverage.httpUnavailable).toMatch(/CLOUD_UNSUPPORTED/);
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered.length).toBeGreaterThan(10); // all of MODEL_SUBDIRS
    expect(coverage.noSourceAvailable).toBe(true);
  });
});

describe("#2319: list_local_models uses the target-aware listing service", () => {
  it("refuses a local listing when the target becomes remote during HTTP fallback", async () => {
    target.remote = false;
    target.generation = 41;
    target.baseUrl = "http://127.0.0.1:8188";
    config.comfyuiPath = "/local-comfy";
    const response = deferred<never>();
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockReturnValue(response.promise);
    readdir.mockResolvedValue(["host-only.safetensors"]);
    stat.mockResolvedValue({ isFile: () => true, size: 1024, mtime: new Date(0) });

    const pending = listLocalModelsWithCoverage("checkpoints");
    await Promise.resolve();

    target.remote = true;
    target.generation = 42;
    target.baseUrl = "https://remote.example";
    // The stale local path intentionally remains configured. Mode and generation
    // must fence it before the filesystem fallback can inspect the host.
    response.reject(new Error("local target disappeared"));

    const { models, coverage } = await pending;

    expect(models).toEqual([]);
    expect(coverage.targetChanged).toEqual({
      startedBaseUrl: "http://127.0.0.1:8188",
      currentBaseUrl: "https://remote.example",
    });
    expect(coverage.usedFilesystem).toBe(false);
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("refuses a remote listing when the target becomes local before HTTP answers", async () => {
    target.remote = true;
    target.generation = 51;
    target.baseUrl = "https://remote.example";
    config.comfyuiPath = "/stale-local-comfy";
    const response = deferred<Response>();
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockReturnValue(response.promise);
    readdir.mockResolvedValue(["local-only.safetensors"]);
    stat.mockResolvedValue({ isFile: () => true, size: 1024, mtime: new Date(0) });

    const pending = listLocalModelsWithCoverage("checkpoints");
    await Promise.resolve();

    target.remote = false;
    target.generation = 52;
    target.baseUrl = "http://127.0.0.1:8188";
    config.comfyuiPath = "/new-local-comfy";
    response.resolve(new Response(JSON.stringify(["remote-only.safetensors"]), { status: 200 }));

    const { models, coverage } = await pending;

    expect(models).toEqual([]);
    expect(coverage.targetChanged).toEqual({
      startedBaseUrl: "https://remote.example",
      currentBaseUrl: "http://127.0.0.1:8188",
    });
    expect(coverage.usedFilesystem).toBe(false);
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("refuses an A-to-B-to-A listing even when the final URL and mode match", async () => {
    target.remote = false;
    target.generation = 61;
    target.baseUrl = "http://127.0.0.1:8188";
    config.comfyuiPath = "/local-comfy";
    const response = deferred<Response>();
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockReturnValue(response.promise);

    const pending = listLocalModelsWithCoverage("checkpoints");
    await Promise.resolve();

    target.remote = true;
    target.generation = 62;
    target.baseUrl = "https://remote.example";
    target.remote = false;
    target.generation = 63;
    target.baseUrl = "http://127.0.0.1:8188";
    response.resolve(new Response(JSON.stringify(["stale-after-round-trip.safetensors"]), { status: 200 }));

    const { models, coverage } = await pending;

    expect(models).toEqual([]);
    expect(coverage.targetChanged).toEqual({
      startedBaseUrl: "http://127.0.0.1:8188",
      currentBaseUrl: "http://127.0.0.1:8188",
    });
    expect(coverage.usedFilesystem).toBe(false);
  });

  it("refuses a listing when the explicit local path changes under the same URL", async () => {
    target.remote = false;
    target.generation = 71;
    target.baseUrl = "http://127.0.0.1:8188";
    config.comfyuiPath = "/local-comfy-a";
    const response = deferred<Response>();
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockReturnValue(response.promise);

    const pending = listLocalModelsWithCoverage("checkpoints");
    await Promise.resolve();

    // A direct path retarget is independently fenced even if the URL, mode, and
    // generation source remain unchanged: returned absolute paths must belong to
    // the exact local install that was sampled at the start.
    config.comfyuiPath = "/local-comfy-b";
    response.resolve(new Response(JSON.stringify(["stale-path-model.safetensors"]), { status: 200 }));

    const { models, coverage } = await pending;

    expect(models).toEqual([]);
    expect(coverage.targetChanged).toEqual({
      startedBaseUrl: "http://127.0.0.1:8188",
      currentBaseUrl: "http://127.0.0.1:8188",
    });
    expect(coverage.usedFilesystem).toBe(false);
  });

  it("#2338: records local path recovery without inventing a target change", async () => {
    target.remote = false;
    target.generation = 81;
    target.baseUrl = "http://127.0.0.1:8188";
    config.comfyuiPath = undefined;
    const response = deferred<Response>();
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockReturnValue(response.promise);

    const pending = listLocalModelsWithCoverage("checkpoints");
    await Promise.resolve();

    config.comfyuiPath = "/recovered-comfy";
    response.resolve(
      new Response(JSON.stringify(["stale-before-recovery.safetensors"]), { status: 200 }),
    );

    const { models, coverage } = await pending;

    expect(models).toEqual([]);
    expect(coverage.localPathRecovered).toBe(true);
    expect(coverage.targetChanged).toBeUndefined();
    expect(coverage.usedFilesystem).toBe(false);
  });

  it("#2350: generation round-trip with path recovery pins generation clause", async () => {
    // A→B→A round trip changes generation even though final URL/remote match start.
    // Even if comfyuiPath is recovered mid-listing, the generation change means
    // the answer is stale. Without the generation clause, this would incorrectly
    // be classified as localPathRecovered.
    target.remote = false;
    target.generation = 10;
    target.baseUrl = "http://127.0.0.1:8188";
    config.comfyuiPath = undefined;
    const response = deferred<Response>();
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockReturnValue(response.promise);

    const pending = listLocalModelsWithCoverage("checkpoints");
    await Promise.resolve();

    // A→B transition changes generation to 11
    advanceTarget(true, "https://remote.example/comfy");
    // B→A transition changes generation to 12, back to original URL/remote
    advanceTarget(false, "http://127.0.0.1:8188");
    // And path gets recovered mid-listing
    config.comfyuiPath = "/recovered-comfy";
    response.resolve(
      new Response(JSON.stringify(["model-during-roundtrip.safetensors"]), { status: 200 }),
    );

    const { models, coverage } = await pending;

    expect(models).toEqual([]);
    // Generation clause is load-bearing: without it, this would be localPathRecovered
    expect(coverage.targetChanged).toEqual({
      startedBaseUrl: "http://127.0.0.1:8188",
      currentBaseUrl: "http://127.0.0.1:8188",
    });
    expect(coverage.localPathRecovered).toBeUndefined();
    expect(coverage.usedFilesystem).toBe(false);
  });

  it("#2350: witness.localPath clause pins that path was unknown at capture time", async () => {
    // When witness.localPath is already set (path was known at capture), recovery
    // in mid-listing is not the explanation. Without the witness.localPath===undefined
    // clause, a path change could be misclassified as recovery. This existing case
    // was already pinned; this test documents the invariant.
    target.remote = false;
    target.generation = 50;
    target.baseUrl = "http://127.0.0.1:8188";
    config.comfyuiPath = "/original-comfy";
    const response = deferred<Response>();
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockReturnValue(response.promise);

    const pending = listLocalModelsWithCoverage("checkpoints");
    await Promise.resolve();

    // Change the path mid-listing
    config.comfyuiPath = "/new-comfy";
    response.resolve(
      new Response(JSON.stringify(["model-path-changed.safetensors"]), { status: 200 }),
    );

    const { models, coverage } = await pending;

    expect(models).toEqual([]);
    // witness.localPath=/original-comfy, so even though comfyuiPath changed,
    // this is not "recovery" (it was known) — it's a target change
    expect(coverage.targetChanged).toEqual({
      startedBaseUrl: "http://127.0.0.1:8188",
      currentBaseUrl: "http://127.0.0.1:8188",
    });
    expect(coverage.localPathRecovered).toBeUndefined();
    expect(coverage.usedFilesystem).toBe(false);
  });

  it("does not expose host files through the registered tool for a remote target", async () => {
    config.comfyuiPath = "/comfy";
    target.remote = true;
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("remote fetch failed"));
    readdir.mockResolvedValue(["host-only.safetensors"]);
    stat.mockResolvedValue({ isFile: () => true, size: 1024, mtime: new Date(0) });

    const result = await registeredListLocalModelsTool()({ action: "list", model_type: "checkpoints" });
    const text = result.content[0].text;

    expect(text).toMatch(/Could not determine/);
    expect(text).toContain("no local ComfyUI path to scan");
    expect(text).not.toContain("host-only.safetensors");
    expect(readdir).not.toHaveBeenCalled();
  });

  it("keeps the local filesystem fallback through the registered tool", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("local server fetch failed"));
    readdir.mockResolvedValue(["local-only.safetensors"]);
    stat.mockResolvedValue({ isFile: () => true, size: 1024, mtime: new Date(0) });

    const result = await registeredListLocalModelsTool()({ action: "list", model_type: "checkpoints" });

    expect(result.content[0].text).toContain("local-only.safetensors");
    expect(readdir).toHaveBeenCalled();
  });

  it("returns a stale-target refusal through the registered tool", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("local server fetch failed"));
    readdir.mockResolvedValue(["stale-tool-model.safetensors"]);
    stat.mockImplementation(async () => {
      advanceTarget(true, "https://remote.example/comfy");
      return { isFile: () => true, size: 1024, mtime: new Date(0) };
    });

    const result = await registeredListLocalModelsTool()({ action: "list", model_type: "checkpoints" });
    const text = result.content[0].text;

    expect(text).toContain("target changed while this listing was in progress");
    expect(text).toContain("No model names or paths from the stale target were returned");
    expect(text).not.toContain("stale-tool-model.safetensors");
    expect(text).not.toContain("/comfy/models/checkpoints/stale-tool-model.safetensors");
    expect(text).not.toContain("install path was resolved");
  });

  it("#2338: explains path recovery through the registered tool without stale data", async () => {
    config.comfyuiPath = undefined;
    const response = deferred<Response>();
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockReturnValue(response.promise);

    const pending = registeredListLocalModelsTool()({ action: "list", model_type: "checkpoints" });
    await Promise.resolve();

    config.comfyuiPath = "/recovered-comfy";
    response.resolve(
      new Response(JSON.stringify(["stale-recovery-model.safetensors"]), { status: 200 }),
    );

    const result = await pending;
    const text = result.content[0].text;

    expect(text).toContain("local ComfyUI install path was resolved while this listing was in progress");
    expect(text).toContain("No model names or paths collected before the path was resolved were returned");
    expect(text).not.toContain("target changed");
    expect(text).not.toContain("stale-recovery-model.safetensors");
    expect(text).not.toContain("/recovered-comfy/models/checkpoints/stale-recovery-model.safetensors");
  });
});

describe("#918: what an empty listing is allowed to say", () => {
  const empty = { answered: [] as string[], unanswered: [], usedFilesystem: false };

  it("says 'no models' ONLY when every category answered", () => {
    expect(describeEmptyModelListing(undefined, { ...empty, answered: ["checkpoints"] })).toBe(
      "No local models found.",
    );
    expect(describeEmptyModelListing("loras", { ...empty, answered: ["loras"] })).toBe(
      "No loras models found.",
    );
  });

  // THE fix. The old text asserted an empty install from zero information.
  it("refuses to claim 'none' when nothing answered", () => {
    const text = describeEmptyModelListing("checkpoints", {
      ...empty,
      unanswered: [{ dir: "checkpoints", reason: "fetch failed" }],
      noSourceAvailable: true,
    });
    expect(text).toMatch(/Could not determine/);
    expect(text).toMatch(/NOT the same as having none/);
    expect(text).not.toMatch(/^No checkpoints models found\.$/);
    // and it names the reason, so the reader can act instead of guessing
    expect(text).toMatch(/fetch failed/);
    expect(text).toMatch(/get_system_stats/);
  });

  it("names the missing fallback so remote isn't mistaken for a bad path", () => {
    const text = describeEmptyModelListing(undefined, {
      ...empty,
      unanswered: [{ dir: "checkpoints", reason: "HTTP 502" }],
      noSourceAvailable: true,
    });
    expect(text).toMatch(/no local ComfyUI path to scan/);
  });

  it("calls a mixed result PARTIAL rather than empty", () => {
    const text = describeEmptyModelListing(undefined, {
      answered: ["checkpoints", "loras"],
      unanswered: [{ dir: "vae", reason: "HTTP 500" }],
      usedFilesystem: false,
    });
    expect(text).toMatch(/PARTIAL/);
    expect(text).toMatch(/checkpoints, loras/);
    expect(text).toMatch(/vae: HTTP 500/);
    expect(text).toMatch(/before concluding they are absent/);
  });

  it("does not dump an unbounded list of failed categories", () => {
    const text = describeEmptyModelListing(undefined, {
      ...empty,
      unanswered: Array.from({ length: 15 }, (_, i) => ({ dir: `d${i}`, reason: "fetch failed" })),
    });
    expect(text).toMatch(/…and 7 more/);
  });
});

// #1015 — the follow-on. Coverage correctly refused to call these categories
// empty, but described WHY in the vaguest available terms: an EMPTY body was
// reported as "a non-JSON body (a proxy, login page, or a server still starting
// answers this way)". None of those three produces zero bytes, and the status
// — which the reporter explicitly asked for, to tell an empty category apart
// from a transport failure — was dropped on every parse-failure branch.
//
// What must NOT change: an unparsable answer still leaves the category
// UNANSWERED. This is about the accuracy of the reason, not the verdict.
describe("#1015: an unparsable category body is described from what was observed", () => {
  it("names an EMPTY body as empty, and does not offer proxy/login/starting guesses", () => {
    const reason = describeUnparsableBody(200, "");
    expect(reason).toMatch(/EMPTY body/);
    expect(reason).toMatch(/0 bytes/);
    expect(reason).toMatch(/HTTP 200/);
    // The three causes that cannot produce an empty body.
    expect(reason).not.toMatch(/proxy/);
    expect(reason).not.toMatch(/login/);
    expect(reason).not.toMatch(/still starting/);
    // And never the raw parser message the reporter saw on 0.50.2.
    expect(reason).not.toMatch(/Unexpected end of JSON input/);
  });

  it("treats a whitespace-only body as empty too", () => {
    expect(describeUnparsableBody(200, "\r\n  \n")).toMatch(/EMPTY body/);
  });

  it("keeps the HTML reading, and now carries the status with it", () => {
    const reason = describeUnparsableBody(200, "<!doctype html><html><body>Sign in</body></html>");
    expect(reason).toMatch(/returned HTML instead of JSON/);
    expect(reason).toMatch(/still starting/);
    expect(reason).toMatch(/HTTP 200/);
  });

  it("quotes a bounded excerpt for a body that is neither empty nor markup", () => {
    const reason = describeUnparsableBody(200, "not json at all");
    expect(reason).toMatch(/not JSON/);
    expect(reason).toMatch(/15 bytes/);
    expect(reason).toMatch(/not json at all/);
  });

  it("bounds the excerpt so a large body cannot flood the tool result", () => {
    const reason = describeUnparsableBody(500, "x".repeat(50_000));
    expect(reason.length).toBeLessThan(200);
    expect(reason).toMatch(/50000 bytes/);
    expect(reason).toMatch(/HTTP 500/);
  });

  it("collapses a multi-line body onto one line", () => {
    expect(describeUnparsableBody(200, "line one\nline two")).not.toMatch(/\n/);
  });

  // The end-to-end shape the reporter hit: two categories answer 200 with an
  // empty body while the rest answer normally.
  it("leaves an empty-bodied category UNANSWERED, never empty", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (url: string) =>
      url.endsWith("/models/clip")
        ? new Response("", { status: 200 })
        : new Response(JSON.stringify(["m.safetensors"]), { status: 200 }),
    );
    readdir.mockRejectedValue(new Error("ENOENT"));

    const { coverage } = await listLocalModelsWithCoverage("clip");
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered).toHaveLength(1);
    expect(coverage.unanswered[0].dir).toBe("clip");
    expect(coverage.unanswered[0].reason).toMatch(/EMPTY body/);
    expect(coverage.unanswered[0].reason).not.toMatch(/Unexpected end of JSON input/);
  });
});

// #962 — a filtered empty is a true statement about the WRONG folder.
//
// A reporter called list_local_models({model_type:"diffusion_models"}) and
// {"unet"} against a remote server whose UNETLoader was loading
// krastBf16_v3.safetensors at that moment. Both answered 200 with [], honestly:
// the weights are registered under neither name. The unfiltered path discovers
// every registered category; a filtered one skips discovery precisely because it
// "already names its exact category" — which is what makes the answer misleading.
describe("#962: a filtered empty says where else to look", () => {
  /** `/models` lists categories; `/models/<dir>` lists that category's files. */
  function serverWith(categories: string[], filesByCat: Record<string, string[]> = {}) {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return new Response(JSON.stringify(categories), { status: 200 });
      const cat = path.replace(/^\/models\//, "");
      return new Response(JSON.stringify(filesByCat[cat] ?? []), { status: 200 });
    });
    readdir.mockRejectedValue(new Error("ENOENT"));
  }

  it("collects the OTHER registered categories when the asked-for one is empty", async () => {
    serverWith(["diffusion_models", "unet_gguf", "checkpoints"]);
    const { models, coverage } = await listLocalModelsWithCoverage("diffusion_models");
    expect(models).toEqual([]);
    // The asked-for category is excluded — repeating it back is not a lead.
    expect(coverage.otherRegisteredCategories).toEqual(["unet_gguf", "checkpoints"]);
  });

  it("does NOT pay for the extra call when the listing found something", async () => {
    serverWith(["diffusion_models", "checkpoints"], { diffusion_models: ["a.safetensors"] });
    const { models, coverage } = await listLocalModelsWithCoverage("diffusion_models");
    expect(models.length).toBe(1);
    expect(coverage.otherRegisteredCategories).toBeUndefined();
    expect(fetchApi.mock.calls.filter((c) => c[0] === "/models")).toHaveLength(0);
  });

  it("leaves it UNDEFINED when the category list cannot be read", async () => {
    // "Could not ask" must not render as "there is nowhere else to look" — the
    // same fold this coverage type exists to prevent.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) =>
      path === "/models"
        ? new Response("nope", { status: 503 })
        : new Response("[]", { status: 200 }),
    );
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("diffusion_models");
    expect(coverage.otherRegisteredCategories).toBeUndefined();
  });

  it("does not ask at all for an UNFILTERED call — it already discovers them", async () => {
    serverWith(["diffusion_models", "unet_gguf"]);
    const { coverage } = await listLocalModelsWithCoverage();
    expect(coverage.otherRegisteredCategories).toBeUndefined();
  });
});

describe("#962: the message names the other categories instead of claiming none", () => {
  const base = { answered: ["diffusion_models"], unanswered: [], usedFilesystem: false };

  it("stops asserting an empty install, and points at the real folders", () => {
    const text = describeEmptyModelListing("diffusion_models", {
      ...base,
      otherRegisteredCategories: ["unet_gguf", "checkpoints"],
    });
    // The sentence the reporter acted on.
    expect(text).not.toMatch(/^No diffusion_models models found\.$/);
    expect(text).toMatch(/fact about ONE folder, not about this install/);
    expect(text).toMatch(/unet_gguf/);
    expect(text).toMatch(/checkpoints/);
    // And the two ways out.
    expect(text).toMatch(/NO model_type/);
  });

  it("keeps the plain sentence when the server registers nothing else", () => {
    // Genuinely the only category: "none" is then the whole truth and extra
    // hedging would be noise.
    const text = describeEmptyModelListing("diffusion_models", {
      ...base,
      otherRegisteredCategories: [],
    });
    expect(text).toBe("No diffusion_models models found.");
  });

  it("keeps the plain sentence when the category list could not be read", () => {
    expect(describeEmptyModelListing("diffusion_models", base)).toBe(
      "No diffusion_models models found.",
    );
  });

  it("an UNANSWERED category still wins — that path says 'could not determine'", () => {
    const text = describeEmptyModelListing("diffusion_models", {
      answered: [],
      unanswered: [{ dir: "diffusion_models", reason: "HTTP 503" }],
      usedFilesystem: false,
      otherRegisteredCategories: ["checkpoints"],
    });
    expect(text).toMatch(/Could not determine/);
    expect(text).not.toMatch(/fact about ONE folder/);
  });
});

// #1015 — a 404 category is an ANSWER, not an unreadable one.
//
// A reporter's healthy ComfyUI 0.31 kept saying:
//
//   Partial listing — 2 categories could not be read
//   (clip: Unexpected end of JSON input; unet: Unexpected end of JSON input).
//
// Their follow-up gave the precise shape: /models/clip and /models/unet each
// answer HTTP 404 with an empty body. Reproduced on a live 0.31 server here —
// clip and unet 404 with 0 bytes while text_encoders and diffusion_models answer
// 200. Modern ComfyUI renamed those folders (clip → text_encoders, unet →
// diffusion_models), so a current install does not register the old names at all.
//
// A 404 is the server answering DEFINITIVELY. Counting it as unread put a
// permanent "your inventory is incomplete" on every healthy modern install — and
// named aliases whose real contents were already listed under the new names. The
// house defect, pointing the other way.
describe("#1015: a 404 category does not degrade the listing", () => {
  function serverWith(byCat: Record<string, { status: number; body?: string }>) {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return new Response("[]", { status: 200 });
      const cat = path.replace(/^\/models\//, "");
      const spec = byCat[cat] ?? { status: 200, body: "[]" };
      return new Response(spec.body ?? "", { status: spec.status });
    });
    readdir.mockRejectedValue(new Error("ENOENT"));
  }

  it("records a 404 as ABSENT, never as unanswered", async () => {
    serverWith({ clip: { status: 404 }, unet: { status: 404 } });
    const { coverage } = await listLocalModelsWithCoverage();
    expect(coverage.absent).toEqual(expect.arrayContaining(["clip", "unet"]));
    // The line the reporter kept seeing.
    expect(coverage.unanswered.map((u) => u.dir)).not.toContain("clip");
    expect(coverage.unanswered.map((u) => u.dir)).not.toContain("unet");
  });

  it("a REAL read failure still degrades the listing", async () => {
    // The guard must not be blunted: a 502 or a proxy page is genuinely unread.
    serverWith({ clip: { status: 404 }, vae: { status: 502, body: "bad gateway" } });
    const { coverage } = await listLocalModelsWithCoverage();
    expect(coverage.unanswered.map((u) => u.dir)).toContain("vae");
    expect(coverage.absent).toContain("clip");
  });

  it("a 404 on a FILTERED call is not a coverage gap either", async () => {
    serverWith({ clip: { status: 404 } });
    const { coverage } = await listLocalModelsWithCoverage("clip");
    expect(coverage.unanswered).toEqual([]);
    expect(coverage.absent).toEqual(["clip"]);
  });
});

describe("#1015: all-404 is NOT a verified empty install", () => {
  const base = { answered: [], unanswered: [], usedFilesystem: false };

  it("refuses to say 'none' when every category 404'd", async () => {
    // A server serving no /models route at all is an old build or a proxy — not
    // an install with no models. Claiming the latter would be the same fabricated
    // negative this change exists to remove, pointing the other way.
    const text = describeEmptyModelListing(undefined, {
      ...base,
      absent: ["checkpoints", "loras", "vae"],
    });
    expect(text).toMatch(/Could not determine/);
    expect(text).toMatch(/NOT\s+the same as having no models/);
    expect(text).toMatch(/older\s+ComfyUI, or a proxy/);
  });

  it("still says 'none' when the server ANSWERED and was genuinely empty", async () => {
    const text = describeEmptyModelListing(undefined, {
      ...base,
      answered: ["checkpoints"],
      absent: ["clip"],
    });
    expect(text).toBe("No local models found.");
  });

  it("an UNANSWERED category still wins over the all-404 branch", async () => {
    // "Could not read" says more than "did not serve", so it keeps precedence.
    const text = describeEmptyModelListing(undefined, {
      ...base,
      unanswered: [{ dir: "vae", reason: "HTTP 502" }],
      absent: ["clip"],
    });
    expect(text).toMatch(/could not be read|Could not determine which/);
    expect(text).toMatch(/vae/);
  });
});

// Adversarial review of PR #1196 (my own, before merge) — the all-404 branch
// answered a FILTERED call with the UNFILTERED diagnosis.
//
// list_local_models({model_type:"clip"}) on a healthy modern server returned
// "usually an older ComfyUI, or a proxy answering in front of it. Check the
// ComfyUI URL…" — sending someone to debug a URL that works perfectly, when the
// real answer is that the folder was renamed. A wrong remedy is worse than a
// vague one: it costs time and teaches distrust of a working setup.
describe("#1015: a filtered 404 names the RENAME, not a broken server", () => {
  const base = { answered: [], unanswered: [], usedFilesystem: false };

  it("points clip → text_encoders", () => {
    const text = describeEmptyModelListing("clip", { ...base, absent: ["clip"] });
    expect(text).toMatch(/LEGACY name/);
    expect(text).toContain("text_encoders");
    // The wrong remedy must be gone.
    expect(text).not.toMatch(/older\s+ComfyUI, or a proxy/);
    expect(text).not.toMatch(/Check the ComfyUI URL/);
  });

  it("points unet → diffusion_models", () => {
    const text = describeEmptyModelListing("unet", { ...base, absent: ["unet"] });
    expect(text).toContain("diffusion_models");
    expect(text).toMatch(/LEGACY name/);
  });

  it("a NON-legacy 404 category says what to do without inventing a rename", () => {
    const text = describeEmptyModelListing("gligen", { ...base, absent: ["gligen"] });
    expect(text).toMatch(/does not serve a "gligen" model category/);
    expect(text).toMatch(/NO model_type/);
    expect(text).not.toMatch(/LEGACY name/);
  });

  it("the UNFILTERED all-404 case keeps the old-server\/proxy diagnosis", () => {
    // That message is right there and must not be lost to the filtered branch.
    const text = describeEmptyModelListing(undefined, {
      ...base,
      absent: ["checkpoints", "loras"],
    });
    expect(text).toMatch(/older\s+ComfyUI, or a proxy/);
  });
});
