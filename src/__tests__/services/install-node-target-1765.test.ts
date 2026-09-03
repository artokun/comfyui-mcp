// #1765, the recurrence reported against 0.52.35.
//
// The original issue asked for split code/data roots and got them: `COMFYUI_CODE_PATH`
// shipped in 0.52.11 via #1766. What came back is a different failure wearing the same
// title. On macOS with SIX local installs, the session targeted
// `http://127.0.0.1:8189` (the reporter's "krea-2"), and `install_custom_node` with
// `source:"git"` cloned an unregistered repository into a DIFFERENT install — the saved
// default workspace, serving :8188. The call reported `git-clone` SUCCESS; only the
// returned `nodeDir` named the wrong tree, and the configured :8189 install never
// received the pack.
//
// MEASURED, not reasoned (the first revision of this file was the reproduction, and it
// reproduced the reporter's outcome exactly): the destination came from
// `resolveEffectiveComfyUIBase()` — `COMFYUI_PATH` env, then auto-detection, then the
// saved default workspace — i.e. from CONFIGURATION ALONE. `resolveLiveServerRoot`, which
// workspace-env.ts documents as "the single notion every write-side caller (download
// destination, package install) must resolve through, so they can never disagree about
// which install is 'the live one'", was never consulted on this path: `/system_stats` was
// not called even once during the install.
//
// These tests drive the REAL `installCustomNode` — the call site, not a helper — through
// the REAL resolvers against two REAL directories on disk.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Two REAL installs on one machine ───────────────────────────────────────────
const SANDBOX = mkdtempSync(join(tmpdir(), "wrong-install-1765-"));
/** The install the session is CONNECTED to (the reporter's krea-2 on :8189). */
const CONNECTED = join(SANDBOX, "krea-2");
/** The install the saved default workspace names (the reporter's qwen-image-edit). */
const SAVED_DEFAULT = join(SANDBOX, "qwen-image-edit");
/** A third tree, used as a `--base-directory` data root. */
const DATA_ROOT = join(SANDBOX, "comfy-data");
for (const root of [CONNECTED, SAVED_DEFAULT, DATA_ROOT]) {
  mkdirSync(join(root, "custom_nodes"), { recursive: true });
  mkdirSync(join(root, "models"), { recursive: true });
  writeFileSync(join(root, "main.py"), "# ComfyUI\n");
}
const WORKSPACE_JSON = join(SANDBOX, "workspace.json");
writeFileSync(WORKSPACE_JSON, JSON.stringify({ defaultWorkspace: SAVED_DEFAULT }));
/** A stand-in comfy-cli executable, so the `useCmCli` branch is reachable. */
const FAKE_COMFY_CLI = join(SANDBOX, "comfy");
writeFileSync(FAKE_COMFY_CLI, "#!/bin/sh");
/** A stand-in absolute Python image for the producer-to-clone contract test. */
const FAKE_PORTABLE_PYTHON = join(SANDBOX, "python_embeded", "python.exe");
mkdirSync(join(SANDBOX, "python_embeded"), { recursive: true });
writeFileSync(FAKE_PORTABLE_PYTHON, "");

// ── config: a LOOPBACK target on :8189 (that is LOCAL mode, which is why the
//    filesystem fallback runs at all), with COMFYUI_PATH unset. ───────────────
const cfg = vi.hoisted(() => ({
  comfyuiPath: undefined as string | undefined,
  comfyuiCodePath: undefined as string | undefined,
  resolvedPort: 8189,
  comfyuiHost: "127.0.0.1",
  comfyuiSsl: false,
  githubToken: undefined as string | undefined,
}));
const target = vi.hoisted(() => ({ generation: 0 }));
vi.mock("../../config.js", () => ({
  config: cfg,
  getComfyUIBaseUrl: () => `http://${cfg.comfyuiHost}:${cfg.resolvedPort}`,
  getComfyuiTargetGeneration: () => target.generation,
  getComfyUIAuthHeaders: () => ({}),
  isLoopbackHost: (host: string | undefined) =>
    !host || ["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(host),
  isForceRemoteFlagSet: () => false,
  isRemoteMode: () => false,
  isLocalMode: () => true,
  isCloudMode: () => false,
}));

// ── the LIVE server's self-report ─────────────────────────────────────────────
const live = vi.hoisted(() => ({
  argv: [] as string[],
  reachable: true,
  onStats: undefined as (() => void) | undefined,
  /** How many times the running server was asked to describe itself. Zero is the
   *  measurement that proves the shipped code never consulted it. */
  statsCalls: 0,
}));
vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: async () => {
    live.statsCalls += 1;
    const onStats = live.onStats;
    live.onStats = undefined;
    onStats?.();
    if (!live.reachable) throw new Error("connect ECONNREFUSED 127.0.0.1:8189");
    return { system: { argv: live.argv } };
  },
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

// ── ComfyUI-Manager. BOTH roads to the direct-clone fallback are exercised:
//
//   "refuse-enqueue"  HTTP 403 on the enqueue — a 3.x security_level /
//                     allow_git_url_install gate; the #1129 divert.
//   "accept-enqueue"  the queue ACCEPTS and drains, but the pack is not in the
//                     installed list afterwards, because it is unregistered —
//                     the reporter's own shape ("reported git-clone success").
//
// They reach `cloneCustomNodeFallback` from two different call sites, and a
// guard on only one of them is a guard that is not there. ────────────────────
const http = vi.hoisted(() => ({
  mode: "refuse-enqueue" as
    | "refuse-enqueue"
    | "accept-enqueue"
    | "manager-absent"
    // #2754 — Manager is SERVING (its version route answers) but has no queue
    // API. The queue routes 404 exactly as in "manager-absent"; only the version
    // route tells the two apart.
    | "manager-queueless"
    // #2754 — queue routes 404 and the version routes 5xx: presence UNKNOWN.
    | "manager-version-unreadable"
    | "manager-unavailable",
  calls: [] as string[],
}));
// Only `comfyuiFetch` is being stood in for. Everything else in the module —
// raceAbort, defaultComfyTimeoutSignal, the failure describers — is real, because
// a mock that silently omits them turns "node-management started using another
// helper from this module" into a confusing failure in a suite about install
// TARGETS (#2754).
vi.mock("../../comfyui/fetch.js", async (importOriginal) => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return {
    ...(await importOriginal<typeof import("../../comfyui/fetch.js")>()),
    comfyuiFetch: async (url: string) => {
      http.calls.push(url);
      if (http.mode === "refuse-enqueue") {
        return new Response("gated by security_level", {
          status: 403,
          statusText: "Forbidden",
        });
      }
      if (http.mode === "manager-absent") {
        return new Response("missing", { status: 404, statusText: "Not Found" });
      }
      if (http.mode === "manager-version-unreadable") {
        return new URL(url).pathname.endsWith("/manager/version")
          ? new Response("upstream down", { status: 503 })
          : new Response("missing", { status: 404, statusText: "Not Found" });
      }
      if (http.mode === "manager-queueless") {
        // A legacy Manager that is up and answering its version route while its
        // queue routes 404 — the #2754 shape.
        return new URL(url).pathname === "/manager/version"
          ? new Response("V3.41", { status: 200 })
          : new Response("missing", { status: 404, statusText: "Not Found" });
      }
      const { pathname } = new URL(url);
      if (
        http.mode === "manager-unavailable" &&
        (pathname === "/v2/manager/queue/status" || pathname === "/manager/queue/status")
      ) {
        // H3/Desktop can answer these routes without a usable Manager queue
        // payload. This is the #1129 path, not the already-shipped both-404
        // Manager-absent path.
        return new Response("", { status: 200 });
      }
      if (pathname === "/manager/queue/install") return json({ ui_id: "queued" });
      if (pathname === "/manager/queue/start") return json({});
      if (pathname === "/manager/queue/status") {
        return json({ is_processing: false, done_count: 1, total_count: 1 });
      }
      // Unregistered: the Manager drained the task without installing anything.
      if (pathname === "/customnode/installed") return json([]);
      return new Response("no such route", { status: 404, statusText: "Not Found" });
    },
  };
});

// ── `git clone` stands in as a directory creation, so nothing hits the network
//    and the destination it was handed is observable. ────────────────────────
const git = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    execFile: vi.fn(),
    // `comfy --json --version`, so comfy-cli reads as installed and supported.
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        schema: "envelope/1",
        type: "envelope",
        ok: true,
        command: "version",
        version: "1.11.1",
        where: null,
        data: {},
        error: null,
      }),
      stderr: "",
    })),
    execFileSync: vi.fn((file: string, args: string[]) => {
      git.calls.push([file, ...args]);
      if (file === "git" && args[0] === "clone") {
        const dest = args[args.length - 1];
        http.calls.push(`git clone:${dest}`);
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
      }
      return "";
    }),
  };
});

// The OS process-table probe — `resolveLiveServerRoot`'s `observed-process` tier.
//
// MEASURED against the ComfyUI running on the development machine (0.33.2,
// ComfyUI Desktop): argv[0] is the RELATIVE "ComfyUI\main.py" and the
// /system_stats payload carries no `cwd` field at all. `liveRootFromArgv`
// resolves a relative script only against an absolute server cwd, so on that
// layout — and on the Windows portable bundle, and on `comfy launch`, which runs
// `python main.py` from the workspace — the argv tier answers NOTHING. An
// argv-only guard is green in every test here and INERT on the machines where
// several installs coexist. Hence this tier, and hence these tests.
const probe = vi.hoisted(() => ({
  calls: 0,
  useActualProducer: false,
  actualPid: 4244,
  actualIdentity: undefined as
    | {
        commandLine?: string;
        argv?: string[];
        argvFidelity?: "exact" | "flattened";
        executablePath?: string;
        startedAt?: string;
      }
    | undefined,
  /** What the OS says is running on the port; undefined = nothing observable. */
  result: undefined as { python?: string; pid: number; launchScript?: string } | undefined,
}));
vi.mock("../../services/live-interpreter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/live-interpreter.js")>();
  return {
    ...actual,
    observeLiveServerProcess: (opts: Parameters<typeof actual.observeLiveServerProcess>[0]) => {
      probe.calls += 1;
      if (probe.useActualProducer) {
        return actual.observeLiveServerProcess({
          ...opts,
          findPid: () => probe.actualPid,
          readIdentity: () => probe.actualIdentity,
        });
      }
      return probe.result;
    },
  };
});

const { installCustomNode } = await import("../../services/node-management.js");
const { applyManifest } = await import("../../services/manifest.js");
const { configureWorkspace, resetWorkspaceConfig } = await import(
  "../../services/workspace-env.js"
);
const { resetManagerApiCache, setManagerApiCacheForTests } = await import(
  "../../services/manager-api-cache.js"
);
const { setQueueTimingForTests } = await import("../../services/node-management.js");
setQueueTimingForTests({ pollIntervalMs: 1, startupGraceMs: 0, timeoutMs: 5_000 });

/** The reporter's shape: an unregistered repository, installed by git URL. */
const REPO = "https://github.com/someone/unregistered-pack";
const PACK_DIR = join("custom_nodes", "unregistered-pack");

/** Where did the clone actually land? `undefined` when no clone ran at all. */
function clonedInto(): string | undefined {
  const clone = git.calls.find((c) => c[0] === "git" && c[1] === "clone");
  return clone?.[clone.length - 1];
}

async function install(
  opts: Parameters<typeof installCustomNode>[0],
): Promise<{ ok?: unknown; error?: string }> {
  try {
    return { ok: await installCustomNode(opts) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

let priorEnvPath: string | undefined;

beforeEach(() => {
  git.calls = [];
  http.calls = [];
  probe.calls = 0;
  probe.useActualProducer = false;
  probe.actualIdentity = undefined;
  probe.result = undefined;
  live.onStats = undefined;
  http.mode = "refuse-enqueue";
  live.reachable = true;
  live.statsCalls = 0;
  target.generation = 0;
  live.argv = [join(CONNECTED, "main.py"), "--port", "8189"];
  cfg.comfyuiPath = undefined;
  priorEnvPath = process.env.COMFYUI_PATH;
  delete process.env.COMFYUI_PATH;
  configureWorkspace({ configPath: WORKSPACE_JSON });
  // The 403 below is the ENQUEUE refusal, not a dialect probe — pin the dialect
  // so detection does not consume it.
  setManagerApiCacheForTests("http://127.0.0.1:8189", "legacy");
});

afterEach(() => {
  resetWorkspaceConfig();
  if (priorEnvPath === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = priorEnvPath;
  for (const root of [CONNECTED, SAVED_DEFAULT, DATA_ROOT]) {
    rmSync(join(root, "custom_nodes"), { recursive: true, force: true });
    mkdirSync(join(root, "custom_nodes"), { recursive: true });
  }
});

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

describe("#1765 — install_custom_node must not write into an install this session is not connected to", () => {
  it("uses the verified live root instead of the saved default", async () => {
    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(CONNECTED, PACK_DIR));
    expect(existsSync(join(SAVED_DEFAULT, PACK_DIR))).toBe(false);
  });

  it("asks the running server which install it is — the shipped path never did", async () => {
    await install({ id: REPO, source: "git" });
    expect(live.statsCalls).toBeGreaterThan(0);
  });

  it("#1129 clones to the verified live root when Manager queue status is unavailable", async () => {
    http.mode = "manager-unavailable";
    resetManagerApiCache("#1129 manager-unavailable regression");

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(CONNECTED, PACK_DIR));
    expect(existsSync(join(SAVED_DEFAULT, PACK_DIR))).toBe(false);
    expect(http.calls.some((url) => url.endsWith("/manager/queue/install"))).toBe(false);
    expect(ok).toMatchObject({
      details: { managerStatus: { manager_unavailable: true } },
    });
  });

  it("#2754 does not label the clone manager_absent when Manager answered its version route", async () => {
    // Both queue routes 404, so the clone is still allowed and still happens —
    // nothing was queued. But the SAME detection saw /manager/version answer
    // "V3.41", so calling the result manager_absent is a claim contradicted by the
    // error object the label was read from.
    http.mode = "manager-queueless";
    resetManagerApiCache("#2754 queueless-Manager label");

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(CONNECTED, PACK_DIR));
    // Routing is unchanged by #2754 — only the name the outcome is given.
    expect(ok).toMatchObject({
      details: { managerStatus: { manager_unavailable: true } },
    });
    expect(
      (ok as { details?: { managerStatus?: Record<string, unknown> } }).details?.managerStatus,
    ).not.toHaveProperty("manager_absent");
  });

  it("#2754 does not label the clone manager_absent when the version probe was UNREADABLE", async () => {
    // Queue routes 404, version routes 503. The diagnostic says presence is
    // unknown; the label must not say absent in the same breath (gate round 7).
    http.mode = "manager-version-unreadable";
    resetManagerApiCache("#2754 unreadable-version label");

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(ok).toMatchObject({
      details: { managerStatus: { manager_unavailable: true } },
    });
    expect(
      (ok as { details?: { managerStatus?: Record<string, unknown> } }).details?.managerStatus,
    ).not.toHaveProperty("manager_absent");
  });

  it("#2754 STILL labels a fully-404 host manager_absent", async () => {
    // The control: when every probe 404s, `absent` is exactly right and the round-5
    // and round-7 predicates must not have quietly retired the label.
    http.mode = "manager-absent";
    resetManagerApiCache("#2754 absent control");

    const { ok } = await install({ id: REPO, source: "git" });

    expect(ok).toMatchObject({
      details: { managerStatus: { manager_absent: true } },
    });
  });

  it("#1129 serializes concurrent unavailable-Manager git installs", async () => {
    http.mode = "manager-unavailable";
    resetManagerApiCache("#1129 concurrent manager-unavailable regression");

    const [first, second] = await Promise.all([
      install({ id: REPO, source: "git" }),
      install({ id: REPO, source: "git" }),
    ]);

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(first.ok).toMatchObject({ mechanism: "git-clone" });
    expect(second.ok).toMatchObject({ mechanism: "git-clone" });
    expect(git.calls.filter((call) => call[0] === "git" && call[1] === "clone")).toHaveLength(1);
    expect(existsSync(join(CONNECTED, PACK_DIR))).toBe(true);
  });

  it("clones normally when the configured root IS the connected install", async () => {
    live.argv = [join(SAVED_DEFAULT, "main.py"), "--port", "8189"];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("uses the verified live root when Manager accepts but resolves nothing", async () => {
    // The reporter's own shape: the queue takes the task, drains, and the pack is
    // still not installed because it is unregistered. That reaches
    // cloneCustomNodeFallback from a DIFFERENT call site than the 403 divert.
    http.mode = "accept-enqueue";

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(CONNECTED, PACK_DIR));
    expect(existsSync(join(SAVED_DEFAULT, PACK_DIR))).toBe(false);
  });

  it("still clones on that road when the configured root IS the connected install", async () => {
    http.mode = "accept-enqueue";
    live.argv = [join(SAVED_DEFAULT, "main.py"), "--port", "8189"];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("uses the live --base-directory as the custom_nodes target", async () => {
    live.argv = [join(CONNECTED, "main.py"), "--base-directory", DATA_ROOT];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(DATA_ROOT, PACK_DIR));
  });

  it("fails closed when --base-directory is relative and unresolvable", async () => {
    // The server WAS given a base directory, but a relative one with no server
    // cwd to resolve it against. It scans custom_nodes/ from a directory we
    // cannot name — and the main.py root, which argv does give us, is then
    // confidently NOT that directory. Judging the write against it would be
    // comparing the base to the wrong tree, so nothing is refused.
    live.argv = [join(CONNECTED, "main.py"), "--base-directory", "data"];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(ok).toBeUndefined();
    expect(clonedInto()).toBeUndefined();
    expect(error).toMatch(/no ComfyUI path is set|local ComfyUI install/i);
  });

  it("clones normally when the server's --base-directory IS the configured root", async () => {
    // The #1715/#1770 split shape: main.py in one tree, custom_nodes scanned from
    // the data root — which is exactly the root we were about to write into.
    live.argv = [join(CONNECTED, "main.py"), "--base-directory", SAVED_DEFAULT];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("refuses a COMFYUI_PATH that disagrees too — the env var is not proof of intent", async () => {
    // The panel orchestrator resolves `COMFYUI_PATH || detectLocalComfyUIPath()`
    // and forwards the RESULT to every child MCP as COMFYUI_PATH, so "the env var
    // is set" cannot distinguish a deliberate setting from an auto-detected guess.
    // A carve-out keyed on it would have switched this check off in exactly the
    // panel sessions it exists for.
    process.env.COMFYUI_PATH = SAVED_DEFAULT;
    cfg.comfyuiPath = SAVED_DEFAULT;

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(ok).toBeUndefined();
    expect(clonedInto()).toBeUndefined();
    expect(error).toContain("COMFYUI_PATH");
    expect(error).toMatch(/two DIFFERENT ComfyUI installs/);
    // …and it names the supported way to make that data root authoritative.
    expect(error).toContain(`--base-directory ${SAVED_DEFAULT}`);
  });

  it("clones normally when COMFYUI_PATH names the connected install", async () => {
    process.env.COMFYUI_PATH = SAVED_DEFAULT;
    cfg.comfyuiPath = SAVED_DEFAULT;
    live.argv = [join(SAVED_DEFAULT, "main.py"), "--port", "8189"];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("fails closed when the server cannot be reached — an outage is not a clone target", async () => {
    live.reachable = false;

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(ok).toBeUndefined();
    expect(clonedInto()).toBeUndefined();
    expect(error).toMatch(/no ComfyUI path is set|local ComfyUI install/i);
  });

  it("uses a verified root from the OS process observation", async () => {
    // The shape the live rig actually reports, and the one `comfy launch`
    // produces: a relative launch script and no server cwd. Nothing in argv
    // names a root; the interpreter the OS says is on the port does.
    live.argv = ["main.py", "--port", "8189"];
    probe.result = { python: join(CONNECTED, ".venv", "Scripts", "python.exe"), pid: 4242 };

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(CONNECTED, PACK_DIR));
    expect(probe.calls).toBeGreaterThan(0);
  });

  it("uses the correlated absolute launch script for a portable bare-main.py process", async () => {
    // Drive the real OS-process producer, not a hand-authored LiveServerProcess:
    // the portable interpreter is a sibling of the actual ComfyUI checkout, so
    // only the producer's correlated absolute launch script can identify this root.
    live.argv = ["main.py", "--port", "8189"];
    probe.useActualProducer = true;
    const script = join(CONNECTED, "main.py");
    probe.actualIdentity = {
      commandLine: `${FAKE_PORTABLE_PYTHON} -s "${script}" --port 8189`,
      argv: [FAKE_PORTABLE_PYTHON, "-s", script, "--port", "8189"],
      argvFidelity: "exact",
      executablePath: FAKE_PORTABLE_PYTHON,
      startedAt: "t1",
    };

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(CONNECTED, PACK_DIR));
  });

  it("refuses the git fallback when the producer sees a DIRECTORY named main.py", async () => {
    const badRoot = join(SANDBOX, "directory-main");
    const badScript = join(badRoot, "main.py");
    // Keep the observed interpreter usable and portable-looking. Before the
    // invalid launch-script veto, this let the resolver authorize this other
    // regular-main.py tree after rejecting the observed directory.
    const fallbackRoot = join(SANDBOX, "interpreter-fallback");
    const fallbackPython = join(fallbackRoot, "python_embeded", "python.exe");
    mkdirSync(badScript, { recursive: true });
    mkdirSync(join(fallbackRoot, "python_embeded"), { recursive: true });
    writeFileSync(join(fallbackRoot, "main.py"), "# fallback tree\n");
    writeFileSync(fallbackPython, "");
    try {
      live.argv = ["main.py", "--port", "8189"];
      probe.useActualProducer = true;
      probe.actualIdentity = {
        commandLine: `${fallbackPython} -s "${badScript}" --port 8189`,
        argv: [fallbackPython, "-s", badScript, "--port", "8189"],
        argvFidelity: "exact",
        executablePath: fallbackPython,
        startedAt: "t1",
      };

      const { ok, error } = await install({ id: REPO, source: "git" });

      expect(ok).toBeUndefined();
      expect(clonedInto()).toBeUndefined();
      expect(error).toMatch(/no ComfyUI path is set|local ComfyUI install/i);
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
      rmSync(fallbackRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the relative main.py cannot be anchored", async () => {
    // Relative script, and the OS observation yields no interpreter (a remote
    // proxy, a permissions failure, an unreadable process table). No live root
    // is then authorized for a local clone.
    live.argv = ["ComfyUI/main.py", "--port", "8189"];
    probe.result = undefined;

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(ok).toBeUndefined();
    expect(clonedInto()).toBeUndefined();
    expect(error).toMatch(/no ComfyUI path is set|local ComfyUI install/i);
  });

  it("fails closed when the observed interpreter belongs to no install we can anchor", async () => {
    // A SYSTEM python: walking up from it reaches directories that are not the
    // install at all, which is the unsoundness `interpreterBelongsToInstall`
    // exists to reject. It must not produce a clone target.
    live.argv = ["ComfyUI/main.py", "--port", "8189"];
    probe.result = { python: join(SANDBOX, "python", "python.exe"), pid: 4243 };

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(ok).toBeUndefined();
    expect(clonedInto()).toBeUndefined();
    expect(error).toMatch(/no ComfyUI path is set|local ComfyUI install/i);
  });

  it("refuses the comfy-cli branch too — --workspace has the identical hazard", async () => {
    const priorCli = process.env.COMFY_CLI_PATH;
    process.env.COMFY_CLI_PATH = FAKE_COMFY_CLI;
    try {
      const { ok, error } = await install({ id: REPO, source: "git", useCmCli: true });

      expect(error).toBeUndefined();
      expect(ok).toMatchObject({ mechanism: "comfy-cli" });
      // The verified live root is used; the direct-clone fallback is not involved.
      expect(git.calls.filter((c) => c[0] === "git" && c[1] === "clone")).toHaveLength(0);
      expect(clonedInto()).toBeUndefined();
    } finally {
      if (priorCli === undefined) delete process.env.COMFY_CLI_PATH;
      else process.env.COMFY_CLI_PATH = priorCli;
    }
  });

  it("does not touch the registry path, which the Manager routes to the connected server", async () => {
    // A plain CNR id is installed BY the connected ComfyUI-Manager: there is no
    // local destination to misdirect, so the guard must not fire (and must not
    // spend a /system_stats probe).
    const { error } = await install({ id: "comfyui-kjnodes" });

    expect(error).toBeDefined();
    expect(error).not.toMatch(/two DIFFERENT ComfyUI installs/);
    expect(live.statsCalls).toBe(0);
  });
});

describe("#463 — apply_manifest uses the verified panel-connected local scan root", () => {
  it("clones a Git manifest source with COMFYUI_PATH unset and reports it applied", async () => {
    http.mode = "manager-absent";
    resetManagerApiCache("#463 manifest probe regression");

    const result = await applyManifest({
      manifest: { custom_nodes: [REPO], models: [] },
    });

    expect(result.results).toMatchObject([
      { action: "custom_node", item: REPO, status: "applied" },
    ]);
    expect(clonedInto()).toBe(join(CONNECTED, PACK_DIR));
    expect(existsSync(join(SAVED_DEFAULT, PACK_DIR))).toBe(false);

    const statusCalls = http.calls
      .map((url, index) => ({ url, index }))
      .filter(({ url }) =>
        url.includes("/v2/manager/queue/status") || url.includes("/manager/queue/status"),
      );
    const cloneIndex = http.calls.findIndex((value) => value.startsWith("git clone:"));
    expect(statusCalls.length).toBeGreaterThanOrEqual(4);
    expect(statusCalls.every(({ url }) => url.startsWith("http://127.0.0.1:8189/"))).toBe(true);
    expect(Math.max(...statusCalls.map(({ index }) => index))).toBeLessThan(cloneIndex);
  });

  it("refuses the Git fallback when the no-path local target cannot be verified", async () => {
    http.mode = "manager-absent";
    live.reachable = false;
    resetManagerApiCache("#463 unverified manifest target");

    const result = await applyManifest({
      manifest: { custom_nodes: [REPO], models: [] },
    });

    expect(result.results).toMatchObject([
      { action: "custom_node", item: REPO, status: "failed" },
    ]);
    expect(result.results[0]?.message).toMatch(/no ComfyUI path is set|local ComfyUI install/i);
    expect(clonedInto()).toBeUndefined();
  });

  it("refuses when the target retargets during apply_manifest's awaited probe", async () => {
    http.mode = "manager-absent";
    resetManagerApiCache("#463 target-generation race");
    const retargetDuringThirdProbe = () => {
      if (live.statsCalls < 3) {
        live.onStats = retargetDuringThirdProbe;
        return;
      }
      // The custom_nodes root was already verified for the original target A.
      // Make the newly selected target B unreachable before installCustomNode
      // starts; an unreachable mismatch check must not wash out this retarget.
      cfg.resolvedPort = 8190;
      target.generation += 1;
      live.reachable = false;
    };
    live.onStats = retargetDuringThirdProbe;

    const result = await applyManifest({
      manifest: { custom_nodes: [REPO], models: [] },
    });

    expect(result.results).toMatchObject([
      { action: "custom_node", item: REPO, status: "failed" },
    ]);
    expect(result.results[0]?.message).toMatch(/target changed/i);
    expect(clonedInto()).toBeUndefined();
    // The initial Manager read and any attempted install must remain pinned to
    // A; no request may be recaptured against the unreachable B target.
    expect(http.calls.length).toBeGreaterThan(0);
    expect(http.calls.every((url) => url.startsWith("http://127.0.0.1:8189/"))).toBe(true);
  });

  it("attempts Manager before refusing a clone for an ambiguous live root", async () => {
    http.mode = "accept-enqueue";
    live.argv = ["main.py", "--port", "8189"];

    const result = await applyManifest({
      manifest: { custom_nodes: [REPO], models: [] },
    });

    expect(result.results).toMatchObject([
      { action: "custom_node", item: REPO, status: "failed" },
    ]);
    expect(http.calls.some((url) => url.endsWith("/manager/queue/install"))).toBe(true);
    expect(clonedInto()).toBeUndefined();
    expect(result.results[0]?.message).toMatch(/no ComfyUI path is set|local ComfyUI install/i);
  });

  it("attempts Manager when no local root is available instead of preflight-refusing", async () => {
    http.mode = "accept-enqueue";
    live.reachable = false;
    // A configured/saved root is still not proof of the panel target when the
    // explicit COMFYUI_PATH is unset. It must not be used for the clone.
    cfg.comfyuiPath = SAVED_DEFAULT;

    const result = await applyManifest({
      manifest: { custom_nodes: [REPO], models: [] },
    });

    expect(result.results).toMatchObject([
      { action: "custom_node", item: REPO, status: "failed" },
    ]);
    expect(http.calls.some((url) => url.endsWith("/manager/queue/install"))).toBe(true);
    expect(clonedInto()).toBeUndefined();
    expect(result.results[0]?.message).not.toMatch(/could not verify.*custom_nodes root/i);
  });
});
