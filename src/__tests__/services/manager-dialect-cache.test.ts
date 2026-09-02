import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as perfHooks from "node:perf_hooks";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Regression for #646: detectManagerApi() cached the detected ComfyUI-Manager
// wire dialect keyed ONLY by base URL, for the whole process lifetime. After the
// user upgraded Manager 3.x → pip comfyui_manager 4.2.2 and restarted ComfyUI at
// the SAME URL, every later Manager call kept speaking the PRE-restart dialect:
// download_model routed through the v2-batch/legacy-UI path and failed with
// "400 Bad Request for /v2/manager/queue/install_model … LEGACY-UI mode" against
// a server that was demonstrably a normal Manager 4.2.2.
//
// Three self-healing mechanisms are asserted here:
//   1. explicit invalidation on the restart lifecycle (resetManagerApiCache(),
//      which process-control / the panel restart tools call alongside
//      resetObjectInfoCache());
//   2. a TTL backstop for an OUT-OF-BAND restart that no mcp tool observed
//      (mirrors the /object_info TTL added for the same class of bug in #528);
//   3. per-call self-heal — a pre-execution rejection re-probes ONCE and retries
//      the enqueue only when the live dialect actually changed.

// The TTL is read once at module load, so it must be set BEFORE the imports.
// Stash the caller's value and restore it after the suite: the variable is
// process-wide, and a worker that later loads another suite must not inherit it.
const PRIOR_TTL_ENV = process.env.COMFYUI_MCP_MANAGER_API_TTL_MS;
process.env.COMFYUI_MCP_MANAGER_API_TTL_MS = "5000";

// Kept mutable to model the runtime target change that the panel applies while a
// Manager operation is in flight. vi.hoisted makes it available to the mock factory.
const target = vi.hoisted(() => ({ base: "http://127.0.0.1:8188", generation: 0 }));

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: "/fake/comfy",
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined as string | undefined,
  };
  return {
    config,
    getComfyUIBaseUrl: () => target.base,
    getComfyuiTargetGeneration: () => target.generation,
    getComfyUIAuthHeaders: () => ({}),
    // node-management's Manager self-update path (#424) imports this; the mock
    // must provide it or the named import fails at load.
    isLoopbackHost: (host?: string) => host === "127.0.0.1" || host === "localhost",
    // The #797 presence gate gates its disk check on the session mode.
    isRemoteMode: () => false,
  };
});

// node-management pulls in comfy-cli → workspace-env, which calls
// promisify(execFile) at module load; keep the subprocess surface inert.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" })),
}));
vi.mock("node:fs", async (importOriginal) => ({
  // Keep the existsSync knob for resolveCmCliPath; delegate everything else to
  // the REAL fs: panel-targeting mutations (id="all" below) now take the panel
  // mutation lock (panel-pin-guard), which is a real file — a partial mock left
  // the lock's mkdir/open/write undefined and every such op failed closed.
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => true),
}));

// The panel mutation lock is a FILE (panel-pin-guard). Point it at a temp path
// so the suite never touches ~/.comfyui-mcp, and so parallel vitest workers get
// their own lock instead of serializing on one shared file.
process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-dialectcache-${process.pid}.lock`,
);

// The id="all" mutations below consult the panel version pin before any Manager
// traffic. This suite is not about pinning, and its existsSync knob answers
// true for everything, so the pin store would look present-but-unreadable and
// fail closed (correct in production, a false positive here). Use the
// documented env escape hatch to say plainly "no pin in this suite".
process.env.COMFYUI_MCP_PANEL_PIN = "off";

const {
  installCustomNode,
  installModelViaManager,
  reinstallCustomNode,
  updateCustomNode,
  queueUpdateAllCustomNodes,
  detectManagerApi,
  setQueueTimingForTests,
  resetManagerApiCacheForTests,
  fetchManagerTaskHistoryEntry,
} = await import("../../services/node-management.js");
const {
  resetManagerApiCache,
  cacheManagerApi,
  getCachedManagerApi,
  managerApiCacheStamp,
  managerApiEpoch,
} = await import("../../services/manager-api-cache.js");

const BASE = "http://127.0.0.1:8188";

interface Call {
  url: string;
  path: string;
  method: string;
  body: unknown;
}

/** Which Manager the (single, unchanging) URL is currently serving. */
type Persona = "v2-batch" | "v4" | "legacy";

const DRAINED = { total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false };

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * One ComfyUI at ONE URL whose Manager persona can be swapped mid-test — exactly
 * what an in-place Manager upgrade + restart looks like from our side.
 *
 *   "v2-batch" = pip Manager in legacy-UI mode: is_legacy_manager_ui true, the
 *                3.x routes (queue/batch, queue/install_model) answer, and the
 *                unified task route does not exist.
 *   "v4"       = normal pip Manager 4.2.2: is_legacy_manager_ui false, the
 *                unified task route answers, and the 3.x-shaped install_model
 *                body is rejected 400 by Pydantic validation (the #646 report),
 *                while the unregistered batch route 405s via ComfyUI's catchall.
 */
function stubServer(opts: {
  persona: (url: string) => Persona;
  /** Gate resolution of the is_legacy_manager_ui probe (in-flight-race tests). */
  legacyUiGate?: () => Promise<void>;
  /** Override the response for the unified task route. */
  taskStatus?: (url: string) => number;
  /** Run after recording a request but before this fake Manager replies. */
  onCall?: (url: string, path: string, method: string) => void | Promise<void>;
}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const path = new URL(url).pathname;
    calls.push({ url, path, method, body });
    await opts.onCall?.(url, path, method);

    // The install VERIFY step: report the pack as present so installCustomNode
    // never reaches its clone fallback.
    if (path.startsWith("/v2/customnode/installed") || path.startsWith("/customnode/installed")) {
      return jsonResponse({ "comfyui-foo": { ver: "1.0", cnr_id: "comfyui-foo", enabled: true } });
    }

    if (opts.persona(url) === "legacy") {
      // The 3.x custom-node Manager: no /v2/* at all (ComfyUI's frontend catchall
      // 405s an unregistered POST), per-operation routes under /manager/*.
      if (path === "/manager/queue/status") return jsonResponse(DRAINED);
      if (path === "/manager/version") return new Response("V3.41", { status: 200 });
      if (path.startsWith("/manager/queue/")) return new Response("", { status: 200 });
      return new Response("404: Not Found", { status: 404 });
    }

    if (path === "/v2/manager/queue/status") return jsonResponse(DRAINED);
    if (path === "/v2/manager/queue/start") return new Response("", { status: 200 });
    if (path === "/v2/manager/queue/update_all") return new Response("", { status: 200 });
    if (path === "/v2/manager/is_legacy_manager_ui") {
      // Read the persona BEFORE parking on the gate, so a gated probe answers
      // with the reading it took when the request was issued — that is what makes
      // "the server changed while a probe was in flight" testable.
      const body = { is_legacy_manager_ui: opts.persona(url) === "v2-batch" };
      if (opts.legacyUiGate) await opts.legacyUiGate();
      return jsonResponse(body);
    }

    if (opts.persona(url) === "v2-batch") {
      if (path === "/v2/manager/queue/install_model") return new Response("", { status: 200 });
      if (path === "/v2/manager/queue/batch") return jsonResponse({ failed: [] });
      // The unified task route does not exist on the bundled 3.x server.
      if (path === "/v2/manager/queue/task") return new Response("405", { status: 405 });
    } else {
      if (path === "/v2/manager/queue/task") {
        const status = opts.taskStatus?.(url) ?? 200;
        return status === 200 ? jsonResponse({ accepted: true }) : new Response(String(status), { status });
      }
      // v4 registers install_model but validates a ModelMetadata envelope — the
      // 3.x-shaped body the v2-batch dialect sends is rejected 400 (#646).
      if (path === "/v2/manager/queue/install_model") {
        return new Response("400: Bad Request", { status: 400 });
      }
      if (path === "/v2/manager/queue/batch") return new Response("405", { status: 405 });
    }
    return new Response("", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const countOf = (calls: Call[], path: string, method = "POST"): number =>
  calls.filter((c) => c.path === path && c.method === method).length;
/** Each completed detection probes is_legacy_manager_ui exactly once. */
const detections = (calls: Call[]): number =>
  calls.filter((c) => c.path === "/v2/manager/is_legacy_manager_ui").length;

const downloadAModel = () =>
  installModelViaManager({
    name: "model.safetensors",
    url: "https://huggingface.co/foo/model.safetensors",
    filename: "model.safetensors",
    type: "checkpoints",
  });

// Controllable clocks. The freshness window is measured on the MONOTONIC clock
// (performance.now) while the queue-drain loop reads the wall clock (Date.now),
// and real timers must keep working (the drain sleeps) — so shift both sources by
// their own offset rather than switching to fake timers. Keeping them separate is
// what lets a test step the WALL clock backward while real time keeps elapsing.
let monotonicOffset = 0;
let wallOffset = 0;
const realNow = Date.now;
const realPerfNow = perfHooks.performance.now.bind(perfHooks.performance);
/** Real time passes (both clocks advance together). */
const elapse = (ms: number): void => {
  monotonicOffset += ms;
  wallOffset += ms;
};

describe("#646 Manager API dialect cache invalidation", () => {
  beforeEach(() => {
    target.base = BASE;
    target.generation = 0;
    monotonicOffset = 0;
    wallOffset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + wallOffset);
    vi.spyOn(perfHooks.performance, "now").mockImplementation(
      () => realPerfNow() + monotonicOffset,
    );
    resetManagerApiCacheForTests();
    setQueueTimingForTests({ pollIntervalMs: 1, startupGraceMs: 0, timeoutMs: 5000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (PRIOR_TTL_ENV === undefined) delete process.env.COMFYUI_MCP_MANAGER_API_TTL_MS;
    else process.env.COMFYUI_MCP_MANAGER_API_TTL_MS = PRIOR_TTL_ENV;
  });

  it("does not translate an authenticated-proxy 401 into 'Manager is missing' (#2085)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401, statusText: "Unauthorized" })),
    );

    const error = (await detectManagerApi(BASE).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/HTTP 401/);
    expect(error.message).toMatch(/authentication failure/i);
    expect(error.message).toMatch(/not evidence that ComfyUI-Manager is missing/i);
    expect(error.message).not.toMatch(/queue API is not reachable.*installed and enabled/i);
  });

  // -------------------------------------------------------------------------
  // #2754 — both queue/status routes 404. That is evidence about the QUEUE API;
  // it is NOT evidence that ComfyUI-Manager is absent or disabled. The reporter's
  // Manager was installed and had imported cleanly, so "is it installed and
  // enabled? / start ComfyUI with --enable-manager" was the one instruction that
  // could not help. The version routes are disjoint from the queue surface
  // (/v2/manager/version is v4-only, /manager/version is 3.x-only), so they are
  // the witness that decides which of the two claims the evidence supports.
  // -------------------------------------------------------------------------

  /** ComfyUI serving a Manager whose version route answers and whose queue
   *  routes do not. `versionBody` is what BOTH version routes reply with. */
  const stubQueuelessManager = (
    version: { path: string; body: string; status?: number } | undefined,
  ): Call[] => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const path = new URL(url).pathname;
        calls.push({ url, path, method: init?.method ?? "GET", body: undefined });
        if (version && path === version.path) {
          return new Response(version.body, { status: version.status ?? 200 });
        }
        return new Response("404: Not Found", { status: 404 });
      }),
    );
    return calls;
  };

  const detectionError = async (): Promise<Error & { details?: unknown }> =>
    (await detectManagerApi(BASE).catch((e: unknown) => e)) as Error & { details?: unknown };

  it("does not claim Manager is missing when its VERSION route answers (#2754)", async () => {
    stubQueuelessManager({ path: "/manager/version", body: "V3.41" });

    const error = await detectionError();
    expect(error).toBeInstanceOf(Error);
    // The claim it is now allowed to make: Manager is up, its queue API is not.
    expect(error.message).toMatch(/ComfyUI-Manager IS answering/i);
    expect(error.message).toMatch(/generation 3\.x/);
    expect(error.message).toMatch(/serves NO queue API/i);
    // The claims the evidence does NOT support, and which cost the reporter the
    // whole investigation.
    expect(error.message).not.toMatch(/installed and enabled/i);
    expect(error.message).not.toMatch(/only activates when ComfyUI is started with/i);
    // --enable-manager may only appear as the thing being RULED OUT, never as an
    // instruction: prescribing it here is the exact wrong turn #2754 reported.
    expect(error.message).toMatch(/neither installing[^.]*nor adding --enable-manager will fix it/i);
    // The evidence the message was earned on travels with the error.
    expect((error.details as { managerVersionMajor?: number }).managerVersionMajor).toBe(3);
  });

  it("reports the v4 generation when /v2/manager/version is the one answering (#2754)", async () => {
    stubQueuelessManager({ path: "/v2/manager/version", body: "V4.2.2" });

    const error = await detectionError();
    expect(error.message).toMatch(/generation 4\.x/);
    expect((error.details as { managerVersionMajor?: number }).managerVersionMajor).toBe(4);
  });

  it("still says 'not reachable' when the version routes answer nothing either (#2754)", async () => {
    const calls = stubQueuelessManager(undefined);

    const error = await detectionError();
    // The original diagnosis survives — it is the correct one for THIS evidence.
    expect(error.message).toMatch(/queue API is not reachable/i);
    expect(error.message).toMatch(/installed and enabled/i);
    // …but it now states the second observation that makes it more than a guess.
    expect(error.message).toMatch(/neither \/v2\/manager\/version nor \/manager\/version/i);
    expect((error.details as { managerVersionMajor?: number }).managerVersionMajor).toBeUndefined();
    // A clean 404 on every probe, NOT a refusal and NOT an unreadable response —
    // this is the only state entitled to the strong "nothing is serving Manager
    // routes at all" claim, and the message says every probe 404'd.
    expect((error.details as { managerVersionEvidence?: string }).managerVersionEvidence).toBe(
      "absent",
    );
    expect(error.message).toMatch(/every probe 404'd/);
    // The version routes were actually consulted — the claim is not asserted for free.
    expect(calls.map((c) => c.path)).toEqual(
      expect.arrayContaining(["/v2/manager/version", "/manager/version"]),
    );
  });

  it("does not read ComfyUI's SPA catchall 200 as a Manager version (#2754)", async () => {
    // An unregistered GET that a frontend/proxy answers with a page of HTML must
    // never become "Manager is answering" — that is the whole point of the strict
    // parse in parseManagerMajor, and this branch is a new consumer of it.
    const calls = stubQueuelessManager({
      path: "/manager/version",
      body: "<!DOCTYPE html><html><body>ComfyUI</body></html>",
    });

    const error = await detectionError();
    // The catchall WAS consulted (this is the new branch, not the old code path
    // reaching the same words by never asking) and was correctly not believed.
    expect(calls.map((c) => c.path)).toContain("/manager/version");
    expect(error.message).not.toMatch(/ComfyUI-Manager IS answering/i);
    expect(error.message).toMatch(/queue API is not reachable/i);
    expect((error.details as { managerVersionMajor?: number }).managerVersionMajor).toBeUndefined();
    // A 200 page of HTML is a route we could not READ, not a server saying the
    // route is absent — so it lands in `unreadable`, and the strong absence
    // wording (with its migrate/--enable-manager advice) is withheld.
    expect((error.details as { managerVersionEvidence?: string }).managerVersionEvidence).toBe(
      "unreadable",
    );
    expect(error.message).toMatch(/NOT evidence that ComfyUI-Manager is absent/i);
    expect(error.message).not.toMatch(/every probe 404'd/);
    expect(error.message).not.toMatch(/only activates when ComfyUI is started with/i);
  });

  it("settles instead of hanging on a version body that never ends (#2754, gate round 4)", async () => {
    // comfyuiFetch's ceiling cancels the exchange but not the body read (#1672,
    // fetch.ts:575-584), so a 200 whose body never closes leaves managerFetch's
    // `await res.text()` pending forever. Without raceAbort around these two
    // probes this test does not fail — it HANGS, which is the point.
    const previousTimeout = process.env.COMFYUI_MCP_HTTP_TIMEOUT_S;
    process.env.COMFYUI_MCP_HTTP_TIMEOUT_S = "0.3";
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string): Promise<Response> => {
          const path = new URL(url).pathname;
          if (path === "/v2/manager/version") {
            // Headers arrive; the body never does and is never closed.
            return new Response(
              new ReadableStream({
                start() {
                  /* deliberately never enqueues and never closes */
                },
              }),
              { status: 200 },
            );
          }
          return new Response("404: Not Found", { status: 404 });
        }),
      );

      const started = Date.now();
      const error = await detectionError();
      // Bounded by ONE budget for the whole probe, not one per route.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((error.details as { kind?: string }).kind).toBe("manager-queue-detection");
      // A stall is unreadable — it establishes nothing about whether Manager is there.
      expect((error.details as { managerVersionEvidence?: string }).managerVersionEvidence).toBe(
        "unreadable",
      );
      expect(error.message).not.toMatch(/every probe 404'd/);
    } finally {
      if (previousTimeout === undefined) delete process.env.COMFYUI_MCP_HTTP_TIMEOUT_S;
      else process.env.COMFYUI_MCP_HTTP_TIMEOUT_S = previousTimeout;
    }
  }, 20_000);

  it("does not call a BODY-read failure an authentication refusal (#2754, gate round 3)", async () => {
    // managerFetch's `await res.text()` is unguarded, so a 2xx whose body rejects
    // throws from the same place a 401 does. Classifying every throw as "refused"
    // would answer a broken pipe with "configure your gateway credentials".
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        const path = new URL(url).pathname;
        if (path === "/manager/version") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("aborted"));
              },
            }),
            { status: 200 },
          );
        }
        return new Response("404: Not Found", { status: 404 });
      }),
    );

    const error = await detectionError();
    expect((error.details as { managerVersionEvidence?: string }).managerVersionEvidence).toBe(
      "unreadable",
    );
    expect(error.message).not.toMatch(/authentication failure/i);
    expect(error.message).not.toMatch(/credentials/i);
    expect(error.message).toMatch(/could not be established/i);
  });

  it("will not call a 5xx on the version route absence (#2754, gate round 2)", async () => {
    // Both queue routes 404 and the version routes 503. The old single-arm message
    // recommended --enable-manager here — a Manager migration prescribed to a
    // ComfyUI that was merely sick for a moment.
    stubQueuelessManager({ path: "/manager/version", body: "upstream down", status: 503 });

    const error = await detectionError();
    expect((error.details as { managerVersionEvidence?: string }).managerVersionEvidence).toBe(
      "unreadable",
    );
    expect(error.message).toMatch(/could not be established/i);
    expect(error.message).toMatch(/server-error/);
    expect(error.message).toMatch(/do not reinstall or migrate Manager/i);
    expect(error.message).not.toMatch(/only activates when ComfyUI is started with/i);
  });

  it("does not spend a REFUSED version route as absence evidence (#2754)", async () => {
    // managerFetch throws on 401/407 even in soft mode — deliberately, because
    // #2085 is exactly the lesson that a credential rejection is not absence. A
    // bare catch → "no version evidence" here would launder that 401 straight back
    // into "nothing is serving Manager routes at all" (caught by the codex gate).
    const calls = stubQueuelessManager({ path: "/manager/version", body: "", status: 401 });

    const error = await detectionError();
    // The probe that throws is the one this branch added, so it must have run —
    // otherwise this asserts nothing about how its failure is handled.
    expect(calls.map((c) => c.path)).toContain("/manager/version");
    // The reader's real failure survives: this is still queue detection, not the
    // secondary probe's error wearing its name.
    expect(error.message).toMatch(/queue API is not reachable/i);
    expect((error.details as { kind?: string }).kind).toBe("manager-queue-detection");
    // …and the 401 is reported as the unknown it is, never as absence.
    expect(error.message).toMatch(/REJECTED/);
    expect(error.message).toMatch(/not evidence that ComfyUI-Manager is missing/i);
    expect(error.message).toMatch(/UNKNOWN from here/);
    expect(error.message).not.toMatch(/is serving ComfyUI-Manager routes at all/i);
    expect(error.message).not.toMatch(/installed and enabled/i);
    expect((error.details as { managerVersionEvidence?: string }).managerVersionEvidence).toBe(
      "refused",
    );
  });

  it("re-detects after a restart at the SAME url (explicit invalidation)", async () => {
    let persona: Persona = "v2-batch";
    const calls = stubServer({ persona: () => persona });

    // 1. Legacy-UI Manager: the model install goes through the 3.x route.
    await downloadAModel();
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(0);

    // 2. The user upgrades Manager and restarts ComfyUI on the SAME url. The
    //    restart lifecycle (process-control / the panel restart tools) drops the
    //    live-derived caches, the dialect among them.
    persona = "v4";
    resetManagerApiCache("comfyui restarted");

    // 3. The next Manager call re-probes and speaks v4 — no stale legacy-UI
    //    routing, no arbitrary-URL rejection.
    await downloadAModel();
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
    // The stale 3.x route was NOT attempted again.
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);
  });

  it("serves the cached dialect within the freshness window (no per-call re-probe)", async () => {
    const calls = stubServer({ persona: () => "v2-batch" });
    await downloadAModel();
    expect(detections(calls)).toBe(1);

    elapse(4_000); // still inside the 5 s window
    await downloadAModel();
    expect(detections(calls)).toBe(1);
  });

  it("re-detects once the TTL lapses (OUT-OF-BAND restart, no mcp tool involved)", async () => {
    let persona: Persona = "v2-batch";
    const calls = stubServer({ persona: () => persona });

    await downloadAModel();
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);

    // The user restarts ComfyUI themselves after upgrading Manager: nothing in
    // this process observed it, so no explicit invalidation ever fires.
    persona = "v4";
    elapse(6_000); // > the 5 s TTL

    await downloadAModel();
    // Re-probed and routed to the unified v4 envelope on the FIRST attempt —
    // the stale 3.x route was never touched again.
    expect(detections(calls)).toBe(2);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);
  });

  it("a backward wall-clock step neither extends nor resurrects the window", async () => {
    let persona: Persona = "v2-batch";
    const calls = stubServer({ persona: () => persona });

    await downloadAModel();
    expect(detections(calls)).toBe(1);

    // The wall clock is stepped BACK an hour (NTP step / VM snapshot restore)
    // while real time keeps running. Wall-clock arithmetic would read the age as
    // hugely negative here and, worse, read it as ~0 ("fresh") again once wall
    // time caught back up — so a Date.now()-based window could serve the
    // pre-restart dialect for another full TTL after a real restart.
    wallOffset -= 3_600_000;
    persona = "v4";

    // Only 4 s of REAL time has passed: still inside the window, still cached.
    elapse(4_000);
    expect(getCachedManagerApi(BASE)).toBe("v2-batch");

    // Past the window in REAL time — expired regardless of where the wall clock
    // sits, and the next call re-probes and speaks the live dialect.
    elapse(2_000);
    expect(getCachedManagerApi(BASE)).toBeUndefined();
    await downloadAModel();
    expect(detections(calls)).toBe(2);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);

    // And the wall clock catching back up cannot revive the (already re-stamped)
    // entry: freshness never depends on wall-clock arithmetic.
    wallOffset += 3_600_000;
    expect(getCachedManagerApi(BASE)).toBe("v2");
    elapse(6_000);
    expect(getCachedManagerApi(BASE)).toBeUndefined();
  });

  it("on a 400 it re-detects but REFUSES to re-send the mutation", async () => {
    let persona: Persona = "v2-batch";
    const calls = stubServer({ persona: () => persona });

    // Pin the legacy-UI dialect, then swap the server underneath it WITHOUT any
    // restart signal and INSIDE the freshness window — the wedge from #646.
    await downloadAModel();
    persona = "v4";
    calls.length = 0;

    // A 400 does NOT prove the server left the request unexecuted (it can come
    // from a handler that already acted, or from a proxy on the response path),
    // and Manager has no idempotency key — so the model install must NOT be
    // re-sent, however confident we are that the dialect moved.
    const err = (await downloadAModel().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    // The refusal is actionable: it names the dialect we spoke and the one the
    // server now answers as, says the classification is already corrected, and
    // tells the user to verify before reissuing.
    expect(err.message).toMatch(/dialect CHANGED/);
    expect(err.message).toMatch(/"v2-batch"/);
    expect(err.message).toMatch(/"v2"/);
    expect(err.message).toMatch(/NOT retried automatically/);
    expect(err.message).toMatch(/VERIFY/);

    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);
    expect(detections(calls)).toBe(1);
    // NOTHING was re-sent in the newly-detected dialect.
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(0);
    // The queue was never started, so no half-run operation is left behind.
    expect(countOf(calls, "/v2/manager/queue/start")).toBe(0);

    // …and the reissue now routes correctly on the FIRST attempt.
    calls.length = 0;
    await expect(downloadAModel()).resolves.toMatchObject({ mechanism: "manager-http" });
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(0);
  });

  it("rebuilds a dialect-specific body on retry (git install), not just the route", async () => {
    let persona: Persona = "v2-batch";
    const calls = stubServer({ persona: () => persona });

    // Pin the legacy-UI dialect, then swap the server to a normal v4 underneath.
    await downloadAModel();
    persona = "v4";
    calls.length = 0;

    await installCustomNode({ id: "https://github.com/bar/comfyui-foo" });

    // Attempt 1 spoke 3.x: a real git URL in `files`, version "unknown".
    const batch = calls.find((c) => c.path === "/v2/manager/queue/batch");
    expect(batch).toBeDefined();
    const sent = (batch!.body as Record<string, Array<Record<string, unknown>>>).install[0];
    expect(sent.files).toEqual(["https://github.com/bar/comfyui-foo"]);

    // The retry must speak v4 SEMANTICS, not merely the v4 route: repo name +
    // "nightly" and NO `files` (v4 resolves by registry id, so a 3.x body would
    // silently install nothing).
    const task = calls.find((c) => c.path === "/v2/manager/queue/task");
    expect(task).toBeDefined();
    const params = (task!.body as { params: Record<string, unknown> }).params;
    expect(params.id).toBe("comfyui-foo");
    expect(params.selected_version).toBe("nightly");
    expect(params.files).toBeUndefined();
  });

  it("heals update-all too (its dedicated route bypasses queueManagerTask)", async () => {
    let persona: Persona = "v4";
    const calls = stubServer({ persona: () => persona });

    await updateCustomNode({ id: "all" });
    expect(countOf(calls, "/v2/manager/queue/update_all")).toBe(1);

    // Same URL, now serving the 3.x custom-node Manager (a downgrade/rollback is
    // the mirror of the reported upgrade), still inside the freshness window.
    persona = "legacy";
    calls.length = 0;

    await expect(updateCustomNode({ id: "all" })).resolves.toMatchObject({
      mechanism: "manager-http",
    });
    // One rejected attempt on the stale prefix, one retry on the live one …
    expect(countOf(calls, "/v2/manager/queue/update_all")).toBe(1);
    expect(countOf(calls, "/manager/queue/update_all")).toBe(1);
    // … and the queue is started (drained) exactly once, on the live prefix.
    expect(countOf(calls, "/manager/queue/start")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/start")).toBe(0);
  });

  // #1999 — the single-pack update must HAND BACK the ui_id it enqueued under.
  // Without it a drained v4 queue can never be correlated to what our task did:
  // `/v2/manager/queue/history?ui_id=` is keyed on exactly this value, and the
  // queue-wide counters read identically for a task that succeeded and one that
  // errored. This asserts the CALL SITE (updateCustomNodeImpl passing the id
  // out), not just that the tracked helper exists.
  it("a single-pack update returns the ui_id it actually enqueued under (#1999)", async () => {
    const calls = stubServer({ persona: () => "v4" });

    const res = await updateCustomNode({ id: "comfyui-foo" });

    const enqueue = calls.find((c) => c.path === "/v2/manager/queue/task");
    const sentUiId = (enqueue?.body as { ui_id?: string } | undefined)?.ui_id;
    expect(sentUiId).toBeTruthy();
    // The id on the result is the id the Manager was actually given.
    expect(res.taskUiId).toBe(sentUiId);
  });

  // The bulk path deliberately does NOT expose one: v4 derives a separate
  // per-pack task id there, so handing the bare enqueue id to a history lookup
  // would answer "no such task" about tasks that really ran.
  it("update-all does NOT claim a correlatable ui_id (#1999)", async () => {
    stubServer({ persona: () => "v4" });
    const res = await updateCustomNode({ id: "all" });
    expect(res.taskUiId).toBeUndefined();
  });

  // #1999 — the per-task record's STRUCTURED verdict must survive the read.
  // `result` is free prose; `status.status_str` is Manager's own OperationResult
  // enum and is the field the classifier decides on, so dropping it would leave
  // every real failure looking like an unreadable answer. The payload below is
  // byte-for-byte what a live ComfyUI-Manager 4.2.2 returned for a failing
  // pack update on this rig.
  it("reads status.status_str out of the v4 per-task history record (#1999)", async () => {
    const HISTORY = {
      history: {
        ui_id: "task-abc",
        client_id: "comfyui-mcp",
        kind: "update",
        result: "An error occurred while updating 'mcp1999-repro'.",
        status: {
          status_str: "error",
          completed: true,
          messages: ["An error occurred while updating 'mcp1999-repro'."],
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") return jsonResponse(DRAINED);
        if (path === "/v2/manager/is_legacy_manager_ui") {
          return jsonResponse({ is_legacy_manager_ui: false });
        }
        if (path === "/v2/manager/queue/history") return jsonResponse(HISTORY);
        return new Response("", { status: 200 });
      }),
    );

    await expect(fetchManagerTaskHistoryEntry("task-abc", BASE)).resolves.toEqual({
      uiId: "task-abc",
      kind: "update",
      result: "An error occurred while updating 'mcp1999-repro'.",
      statusStr: "error",
    });
  });

  it("refuses completion when a dialect self-heal retargets mid-install", async () => {
    const targetA = BASE;
    const targetB = "http://127.0.0.1:8282";
    let retargeted = false;
    const calls = stubServer({
      // A is a legacy Manager even though its stale cache says v2; B is normal
      // v4. Before the fix, the failed A request re-read the mutable target,
      // detected B, then retried and drained B's queue instead of A's.
      persona: (url) => (url.startsWith(targetA) ? "legacy" : "v4"),
      onCall: (url, path) => {
        if (!retargeted && url.startsWith(targetA) && path === "/v2/manager/queue/task") {
          retargeted = true;
          target.base = targetB;
          target.generation += 1;
          resetManagerApiCache("panel retargeted while Manager request was in flight");
        }
      },
    });
    resetManagerApiCacheForTests("v2");

    await expect(installCustomNode({ id: "comfyui-foo" })).rejects.toMatchObject({
      details: { kind: "target-generation-changed" },
    });

    // The mutation began at A, so its retry, queue start, and drain are all
    // pinned to A. B is now the target for subsequent calls, but receives none
    // from this already-started transaction. The operation refuses to report
    // success before post-queue verification because the target changed.
    expect(calls.filter((call) => call.url.startsWith(targetB))).toHaveLength(0);
    expect(calls.some((call) => call.url.startsWith(targetA) && call.path === "/manager/queue/install")).toBe(true);
    expect(calls.some((call) => call.url.startsWith(targetA) && call.path === "/manager/queue/start")).toBe(true);
    expect(calls.some((call) => call.url.startsWith(targetA) && call.path.startsWith("/customnode/installed"))).toBe(false);
  });

  it("keeps the update-all tool's enqueue + start on its original target after retarget (#656)", async () => {
    const targetA = BASE;
    const targetB = "http://127.0.0.1:8282";
    let retargeted = false;
    const calls = stubServer({
      // A serves the 3.x Manager even though the cache pinned v2; B is normal
      // v4. The update-all tool (queueUpdateAllCustomNodes) pins ONE base for
      // the whole operation, so the panel retarget must not redirect its
      // self-heal retry or queue start to B.
      persona: (url) => (url.startsWith(targetA) ? "legacy" : "v4"),
      onCall: (url, path) => {
        if (!retargeted && url.startsWith(targetA) && path === "/v2/manager/queue/update_all") {
          retargeted = true;
          target.base = targetB;
          target.generation += 1;
          resetManagerApiCache("panel retargeted while Manager request was in flight");
        }
      },
    });
    resetManagerApiCacheForTests("v2");

    await expect(queueUpdateAllCustomNodes()).resolves.toMatchObject({
      endpoint: "/manager/queue/update_all",
      queueStarted: true,
    });

    // The stale-dialect attempt, its self-heal retry, and the queue start are
    // all pinned to A. B is now the target for subsequent calls, but receives
    // nothing from this already-started operation.
    expect(calls.filter((call) => call.url.startsWith(targetB))).toHaveLength(0);
    expect(countOf(calls, "/v2/manager/queue/update_all")).toBe(1);
    expect(countOf(calls, "/manager/queue/update_all")).toBe(1);
    expect(countOf(calls, "/manager/queue/start")).toBe(1);
  });

  it("keeps BOTH halves of a reinstall on its original target after retarget", async () => {
    const targetA = BASE;
    const targetB = "http://127.0.0.1:8282";
    let retargeted = false;
    const calls = stubServer({
      persona: () => "v4",
      // Retarget while the UNINSTALL half is draining. A reinstall is uninstall
      // + install as two queue cycles; if each cycle pins its own target, the
      // install half lands on B — leaving A uninstalled while reporting success.
      onCall: (url, path, method) => {
        if (!retargeted && url.startsWith(targetA) && path === "/v2/manager/queue/start" && method === "POST") {
          retargeted = true;
          target.base = targetB;
          target.generation += 1;
          resetManagerApiCache("panel retargeted while Manager request was in flight");
        }
      },
    });

    await expect(reinstallCustomNode({ id: "comfyui-foo" })).resolves.toMatchObject({
      mechanism: "manager-http",
    });

    // Nothing reached B: the install half re-used the target captured before the
    // uninstall began, not the target selected mid-operation.
    expect(calls.filter((call) => call.url.startsWith(targetB))).toHaveLength(0);
    const kinds = calls
      .filter((c) => c.url.startsWith(targetA) && c.path === "/v2/manager/queue/task" && c.method === "POST")
      .map((c) => (c.body as { kind: string }).kind);
    expect(kinds).toEqual(["uninstall", "install"]);
    expect(countOf(calls, "/v2/manager/queue/start")).toBe(2);
  });

  it("does NOT re-detect or retry on an unrelated failure (403 security gating)", async () => {
    const calls = stubServer({ persona: () => "v4", taskStatus: () => 403 });

    await expect(downloadAModel()).rejects.toThrow(/403/);

    // A 403 is a permission verdict from a route that exists — not a dialect
    // signal. No re-probe storm, no retry of the mutation.
    expect(detections(calls)).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
  });

  it("a persistently-400ing endpoint cannot buy a probe per call (re-check cooldown)", async () => {
    const calls = stubServer({ persona: () => "v4", taskStatus: () => 400 });

    await expect(downloadAModel()).rejects.toThrow(/400/);

    // The 400 could have been a stale dialect, so ONE re-probe is spent proving
    // otherwise — the dialect is unchanged, so the enqueue is not repeated and the
    // caller's original error surfaces unwrapped.
    expect(detections(calls)).toBe(2);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);

    // Every subsequent identical failure is now free: the "unchanged" verdict
    // armed a cooldown, so the cache is NOT reset-and-re-probed per call.
    for (let i = 0; i < 3; i++) {
      calls.length = 0;
      await expect(downloadAModel()).rejects.toThrow(/400/);
      expect(detections(calls)).toBe(0);
      expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
    }

    // A real lifecycle event is new information and clears the cooldown, so the
    // very next failure re-checks again rather than trusting the stale verdict.
    resetManagerApiCache("comfyui restarted");
    calls.length = 0;
    await expect(downloadAModel()).rejects.toThrow(/400/);
    expect(detections(calls)).toBe(2);
  });

  it("shares ONE detection between concurrent callers (no probe storm)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = true;
    const calls = stubServer({
      persona: () => "v4",
      legacyUiGate: async () => {
        if (gated) await gate;
      },
    });

    // Five operations arrive together on a cold cache (exactly what happens just
    // after the window lapses). They must not each fire their own probe round.
    const ops = [downloadAModel(), downloadAModel(), downloadAModel(), downloadAModel(), downloadAModel()];
    while (!calls.some((c) => c.path === "/v2/manager/is_legacy_manager_ui")) {
      await new Promise((r) => setTimeout(r, 1));
    }
    gated = false;
    release();
    await Promise.all(ops);

    // One shared detection for all five …
    expect(detections(calls)).toBe(1);
    // … and all five operations still went through.
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(5);
  });

  it("shares ONE reset+re-detect between concurrent failing calls", async () => {
    const calls = stubServer({ persona: () => "v4", taskStatus: () => 400 });

    // Warm the cache so the failures — not the cold start — drive the re-checks.
    await expect(downloadAModel()).rejects.toThrow(/400/);
    resetManagerApiCache("test: clear the cooldown armed by the warm-up");
    calls.length = 0;

    // Four operations fail concurrently with the ambiguous status. Each re-check
    // RESETS the cache (bumping the epoch), so without a shared transaction they
    // would invalidate each other's probe and run four full detection rounds.
    const results = await Promise.allSettled([
      downloadAModel(),
      downloadAModel(),
      downloadAModel(),
      downloadAModel(),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    // One cold-start detection plus ONE shared re-check for all four.
    expect(detections(calls)).toBe(2);
    // Every operation attempted its own enqueue exactly once, and none was re-sent.
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(4);
  });

  it("does not enqueue with a reading taken before a restart landed mid-detection", async () => {
    let persona: Persona = "v2-batch";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = true;
    const calls = stubServer({
      persona: () => persona,
      legacyUiGate: async () => {
        if (gated) await gate;
      },
    });

    // A detection is parked holding the PRE-restart reading (legacy-UI) …
    const inflight = downloadAModel();
    while (!calls.some((c) => c.path === "/v2/manager/is_legacy_manager_ui")) {
      await new Promise((r) => setTimeout(r, 1));
    }
    // … while ComfyUI restarts with the upgraded Manager and the lifecycle fires.
    persona = "v4";
    resetManagerApiCache("comfyui restarted mid-detection");
    gated = false;
    release();
    await expect(inflight).resolves.toMatchObject({ mechanism: "manager-http" });

    // Dropping only the CACHE write is not enough: the parked reading must not be
    // handed back to the caller either, or the mutation goes out on the dead
    // dialect. The operation re-probed and enqueued on the live v4 route, and the
    // stale 3.x route was never touched.
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(0);
  });

  it("refuses to send anything when every detection is invalidated (restart storm)", async () => {
    // ComfyUI is cycling: each probe is invalidated before it can answer, so every
    // reading describes a server that is already gone. Handing the last one back
    // would route a MUTATION on a dialect we know is stale — nothing has been sent
    // yet at that point, so refusing costs nothing and is the only safe outcome.
    const calls = stubServer({
      persona: () => "v2-batch",
      legacyUiGate: async () => {
        resetManagerApiCache("comfyui restarted again");
      },
    });

    await expect(downloadAModel()).rejects.toThrow(/kept being restarted[\s\S]*NOTHING was sent/i);

    // It gave up after a bounded number of probes rather than spinning …
    expect(detections(calls)).toBe(3);
    // … and no enqueue was attempted on any dialect.
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(0);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(0);
    expect(countOf(calls, "/v2/manager/queue/start")).toBe(0);
  });

  it("still pins the #464 v2-batch demotion when a restart landed during detection", async () => {
    // A build that serves the bundled 3.x server under /v2 but whose
    // is_legacy_manager_ui probe does NOT identify it: detection says "v2", the
    // unified task route 405s, and the batch fallback succeeds — that success is
    // what pins "v2-batch" (#464). If the demotion is guarded on an epoch captured
    // before DETECTION, a restart landing mid-probe vetoes it and every later op
    // pays the dead /queue/task round trip again.
    const calls: Call[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const path = new URL(url).pathname;
        calls.push({ path, method, body });
        // #730: single-pack updates re-read the installed list post-op — both
        // packs must resolve for the ops to succeed.
        if (path.startsWith("/v2/customnode/installed")) {
          return jsonResponse({
            "pack-a": { ver: "1.0.0", enabled: true },
            "pack-b": { ver: "1.0.0", enabled: true },
          });
        }
        if (path === "/v2/manager/queue/status") return jsonResponse(DRAINED);
        if (path === "/v2/manager/is_legacy_manager_ui") {
          if (gated) await gate;
          // Unregistered → ComfyUI's SPA catchall, so the sub-dialect is unknown.
          return new Response("<!doctype html><html>frontend</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        if (path === "/v2/manager/queue/task") return new Response("405", { status: 405 });
        if (path === "/v2/manager/queue/batch") return jsonResponse({ failed: [] });
        return new Response("", { status: 200 });
      }),
    );

    const inflight = updateCustomNode({ id: "pack-a" });
    while (!calls.some((c) => c.path === "/v2/manager/is_legacy_manager_ui")) {
      await new Promise((r) => setTimeout(r, 1));
    }
    resetManagerApiCache("comfyui restarted mid-detection");
    gated = false;
    release();
    await expect(inflight).resolves.toMatchObject({ mechanism: "manager-http" });

    // The batch enqueue SUCCEEDED, so the corrected dialect must be pinned even
    // though a reset landed while the detection was probing …
    expect(getCachedManagerApi(BASE)).toBe("v2-batch");
    // … and the next operation therefore skips the dead task route entirely.
    calls.length = 0;
    await updateCustomNode({ id: "pack-b" });
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(0);
    expect(countOf(calls, "/v2/manager/queue/batch")).toBe(1);
  });

  it("drops a detection that completed across an invalidation (in-flight restart)", async () => {
    // Direct check of the epoch guard the async detection path relies on.
    const stamp = managerApiCacheStamp();
    resetManagerApiCache("comfyui restarted mid-detection");
    cacheManagerApi(BASE, "v2-batch", stamp);
    expect(getCachedManagerApi(BASE)).toBeUndefined();
    // A detection that started AFTER the reset still pins normally.
    cacheManagerApi(BASE, "v2-batch", managerApiCacheStamp());
    expect(getCachedManagerApi(BASE)).toBe("v2-batch");
  });

  it("orders concurrent detections by START, so the newest reading wins either way", async () => {
    // Both probes start after the window lapsed with NO reset involved (an
    // out-of-band restart lands between them), so the epoch can't order them and
    // completion order says nothing about which reading is newer. A starts first
    // and reads the OLD server; B starts second and reads the NEW one.

    // Case 1 — the newer probe finishes FIRST, the older resolves last.
    let stampA = managerApiCacheStamp();
    let stampB = managerApiCacheStamp();
    cacheManagerApi(BASE, "v2", stampB);
    cacheManagerApi(BASE, "v2-batch", stampA); // stale, must be dropped
    expect(getCachedManagerApi(BASE)).toBe("v2");

    // Case 2 — the OLDER probe finishes first: its verdict lands, and the
    // later-started probe must still be able to replace it (this is the order a
    // write-counter guard gets wrong: it would drop the fresher reading).
    resetManagerApiCache("test");
    stampA = managerApiCacheStamp();
    stampB = managerApiCacheStamp();
    cacheManagerApi(BASE, "legacy", stampA);
    expect(getCachedManagerApi(BASE)).toBe("legacy");
    cacheManagerApi(BASE, "v2", stampB);
    expect(getCachedManagerApi(BASE)).toBe("v2");

    // A verdict backed by a SUCCEEDED enqueue (the #464 demotion) supersedes a
    // probe-derived one — it guards on the epoch only …
    cacheManagerApi(BASE, "v2-batch", { epoch: managerApiEpoch() });
    expect(getCachedManagerApi(BASE)).toBe("v2-batch");
    // … and it takes a fresh ticket, so a detection that started BEFORE it can
    // no longer clobber it.
    cacheManagerApi(BASE, "legacy", stampA);
    expect(getCachedManagerApi(BASE)).toBe("v2-batch");
  });

  it("a restart during an in-flight detection does not re-pin the pre-restart dialect", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = true;
    const calls = stubServer({
      persona: () => "v2-batch",
      legacyUiGate: async () => {
        if (gated) await gate;
      },
    });

    // Park the detection mid-probe …
    const inflight = downloadAModel();
    while (!calls.some((c) => c.path === "/v2/manager/is_legacy_manager_ui")) {
      await new Promise((r) => setTimeout(r, 1));
    }
    // … then restart ComfyUI underneath it and let the probe answer.
    resetManagerApiCache("comfyui restarted mid-detection");
    gated = false;
    release();
    await inflight;

    // The parked detection concluded AFTER the invalidation, so its verdict
    // described a server that may no longer be there: it is neither pinned nor
    // returned. The operation therefore probed a SECOND time before enqueueing —
    // without the epoch guard the stale verdict would have been kept and one
    // detection would have sufficed.
    expect(detections(calls)).toBe(2);

    // The second (post-reset) reading IS pinned, so the next call is served from
    // cache rather than probing forever.
    calls.length = 0;
    await downloadAModel();
    expect(detections(calls)).toBe(0);
  });
});
