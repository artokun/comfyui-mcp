// #2714 — `install_custom_node` reported a git install that never happened.
//
// The reporter moved an existing Registry-ZIP pack out of `custom_nodes`, then
// installed the same pack by git URL with `useCmCli:false` against ComfyUI-Manager
// 4.2.2. The tool answered
//
//   Installed "ComfyUI-DaSiWa-Nodes" via ComfyUI-Manager. Restart may be required…
//
// with done_count 2, and `~/ComfyUI/custom_nodes/ComfyUI-DaSiWa-Nodes` did not exist.
//
// The whole proof behind that sentence was ONE question asked of ComfyUI-Manager:
//
//   const installed = await listInstalledNodesAt(managerBase).catch(() => []);
//   if (nodeInstalledMatches(gitId, installed)) return { mechanism: "manager-http", … };
//
// `/v2/customnode/installed` is Manager's own bookkeeping. It is not a filesystem
// read, and for a pack Manager previously tracked it keeps answering after the
// directory is gone — while a v4 task that resolves nothing is still marked done.
// The registry branch of the SAME function already crosses that list with a disk
// scan (`resolvePackPresence`) and already refuses a marker-only husk
// (`looksLikeAPack`, #900/#1816). The git branch had neither.
//
// These tests drive the REAL `installCustomNode` through the REAL resolvers against
// a REAL directory tree, with the Manager LISTING the pack — the one shape the
// existing #1765 coverage never produces (its `/customnode/installed` always
// answers `[]`, so the list never had to be doubted).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── One REAL local install, which the server reports as its own root ───────────
const SANDBOX = mkdtempSync(join(tmpdir(), "manager-listed-absent-2714-"));
const CONNECTED = join(SANDBOX, "comfy");
mkdirSync(join(CONNECTED, "custom_nodes"), { recursive: true });
mkdirSync(join(CONNECTED, "models"), { recursive: true });
writeFileSync(join(CONNECTED, "main.py"), "# ComfyUI\n");
const WORKSPACE_JSON = join(SANDBOX, "workspace.json");
writeFileSync(WORKSPACE_JSON, JSON.stringify({ defaultWorkspace: CONNECTED }));

const cfg = vi.hoisted(() => ({
  comfyuiPath: undefined as string | undefined,
  comfyuiCodePath: undefined as string | undefined,
  resolvedPort: 8188,
  comfyuiHost: "127.0.0.1",
  comfyuiSsl: false,
  githubToken: undefined as string | undefined,
}));
vi.mock("../../config.js", () => ({
  config: cfg,
  getComfyUIBaseUrl: () => `http://${cfg.comfyuiHost}:${cfg.resolvedPort}`,
  getComfyuiTargetGeneration: () => 0,
  getComfyUIAuthHeaders: () => ({}),
  isLoopbackHost: (host: string | undefined) =>
    !host || ["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(host),
  isForceRemoteFlagSet: () => false,
  isRemoteMode: () => false,
  isLocalMode: () => true,
  isCloudMode: () => false,
}));

// ── the LIVE server's self-report: this is how the custom_nodes scan root is
//    established with COMFYUI_PATH unset. ──────────────────────────────────────
const live = vi.hoisted(() => ({
  argv: [] as string[],
  reachable: true,
}));
vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: async () => {
    if (!live.reachable) throw new Error("connect ECONNREFUSED 127.0.0.1:8188");
    return { system: { argv: live.argv } };
  },
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

// The OS process-table tier is not what this file measures; keep it silent so the
// scan root comes from the server's own argv.
vi.mock("../../services/live-interpreter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/live-interpreter.js")>();
  return { ...actual, observeLiveServerProcess: () => undefined };
});

// ── ComfyUI-Manager v4: the queue ACCEPTS, drains "done", and the installed-pack
//    list ANSWERS FOR the pack. Exactly the reporter's wire shape. ─────────────
const manager = vi.hoisted(() => ({
  /** Body served at /v2/customnode/installed. Manager serves the object-keyed
   *  shape; the ARRAY shape is `parseInstalled`'s other branch, which is where a
   *  human `title` can end up standing in for the module key. */
  installed: {} as Record<string, unknown> | unknown[],
  calls: [] as string[],
}));
vi.mock("../../comfyui/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/fetch.js")>();
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return {
    ...actual,
    comfyuiFetch: async (url: string) => {
      manager.calls.push(url);
      const { pathname } = new URL(url);
      if (pathname === "/v2/manager/queue/task") return json({ ui_id: "queued" });
      if (pathname === "/v2/manager/queue/start") return json({});
      if (pathname === "/v2/manager/queue/status") {
        // done_count 2 — the reporter's own number. A drained queue.
        return json({ is_processing: false, done_count: 2, total_count: 2 });
      }
      if (pathname === "/v2/customnode/installed") return json(manager.installed);
      return new Response("no such route", { status: 404, statusText: "Not Found" });
    },
  };
});

// ── `git clone` stands in as a directory creation: no network, and the
//    destination it was handed is observable. ─────────────────────────────────
const git = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    execFile: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
    execFileSync: vi.fn((file: string, args: string[]) => {
      git.calls.push([file, ...args]);
      if (file === "git" && args[0] === "clone") {
        const dest = args[args.length - 1];
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
      }
      return "";
    }),
  };
});

const { installCustomNode, setQueueTimingForTests } = await import(
  "../../services/node-management.js"
);
const { configureWorkspace, resetWorkspaceConfig } = await import(
  "../../services/workspace-env.js"
);
const { setManagerApiCacheForTests } = await import("../../services/manager-api-cache.js");
setQueueTimingForTests({ pollIntervalMs: 1, startupGraceMs: 0, timeoutMs: 5_000 });

/** The reporter's own repository, verbatim from the issue. */
const REPO = "https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes";
const REPO_NAME = "ComfyUI-DaSiWa-Nodes";
const PACK_DIR = join(CONNECTED, "custom_nodes", REPO_NAME);

/** The Manager entry that vouches for the pack — keyed by folder name, as v4 serves it. */
const LISTED_BY_REPO_NAME = {
  [REPO_NAME]: { ver: "nightly", aux_id: "darksidewalker/ComfyUI-DaSiWa-Nodes", enabled: true },
};

function clonedInto(): string | undefined {
  const clone = git.calls.find((c) => c[0] === "git" && c[1] === "clone");
  return clone?.[clone.length - 1];
}

/** Create a directory under custom_nodes with the given top-level entries. */
function makePackDir(name: string, entries: Record<string, string>): string {
  const dir = join(CONNECTED, "custom_nodes", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(entries)) {
    const target = join(dir, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

async function install(
  opts: Parameters<typeof installCustomNode>[0],
): Promise<{ ok?: { mechanism: string; message: string }; error?: string }> {
  try {
    return { ok: (await installCustomNode(opts)) as { mechanism: string; message: string } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

let priorEnvPath: string | undefined;

beforeEach(() => {
  git.calls = [];
  manager.calls = [];
  manager.installed = LISTED_BY_REPO_NAME;
  live.reachable = true;
  live.argv = [join(CONNECTED, "main.py"), "--port", "8188"];
  cfg.comfyuiPath = undefined;
  priorEnvPath = process.env.COMFYUI_PATH;
  delete process.env.COMFYUI_PATH;
  configureWorkspace({ configPath: WORKSPACE_JSON });
  setManagerApiCacheForTests("http://127.0.0.1:8188", "v2");
});

afterEach(() => {
  resetWorkspaceConfig();
  if (priorEnvPath === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = priorEnvPath;
  rmSync(join(CONNECTED, "custom_nodes"), { recursive: true, force: true });
  mkdirSync(join(CONNECTED, "custom_nodes"), { recursive: true });
});

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

describe("#2714 — a Manager-listed git install must be corroborated on disk", () => {
  it("does not report an install ComfyUI-Manager only CLAIMS: the pack is absent, so it clones", async () => {
    // THE REPORT, REPRODUCED. Manager lists the pack; custom_nodes does not have it.
    expect(existsSync(PACK_DIR)).toBe(false);

    const { ok, error } = await install({ id: REPO, source: "git", ref: "main", useCmCli: false });

    expect(error).toBeUndefined();
    // The shipped code answered `manager-http` here, with the reporter's exact
    // sentence, having written nothing. Deleting the #2714 corroboration in
    // node-management.ts turns this line red and every other line in this file green.
    expect(ok?.mechanism).toBe("git-clone");
    expect(ok?.message).not.toMatch(/Installed "ComfyUI-DaSiWa-Nodes" via ComfyUI-Manager/);
    // And the pack the caller asked for is now actually there.
    expect(clonedInto()).toBe(PACK_DIR);
    expect(existsSync(join(PACK_DIR, "__init__.py"))).toBe(true);
  });

  it("names the real reason for the clone — not 'not in the registry', which is false here", async () => {
    const { ok } = await install({ id: REPO, source: "git" });

    // cloneCustomNodeFallback's DEFAULT explanation would be a wrong cause for a
    // correct action: Manager did list this pack. The fall-through has to carry
    // what was actually observed.
    expect(ok?.message).toMatch(/installed-pack list/i);
    expect(ok?.message).toMatch(/NO matching pack exists/i);
    expect(ok?.message).not.toMatch(/is not in the ComfyUI-Manager registry/);
  });

  it("KEEPS the Manager result when the disk corroborates it — no needless clone", async () => {
    makePackDir(REPO_NAME, { "__init__.py": "NODE_CLASS_MAPPINGS = {}\n" });

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok?.mechanism).toBe("manager-http");
    expect(ok?.message).toMatch(/verified present on disk/);
    expect(clonedInto()).toBeUndefined();
  });

  it("corroborates through the MANAGER ENTRY's own id, not just the URL's repo name", async () => {
    // Manager v4 is registry-first: it can resolve a git URL to a CNR record and
    // unpack it under the CNR id, which is NOT the repo name we derived. A check
    // that only asked for `<repo>` would call that a false success and clone a
    // DUPLICATE pack next to the working one.
    manager.installed = {
      "dasiwa-nodes": { ver: "1.2.0", cnr_id: "dasiwa-nodes", aux_id: "darksidewalker/ComfyUI-DaSiWa-Nodes", enabled: true },
    };
    makePackDir("dasiwa-nodes", { "pyproject.toml": '[project]\nname = "dasiwa-nodes"\n' });

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok?.mechanism).toBe("manager-http");
    expect(clonedInto()).toBeUndefined();
    expect(existsSync(PACK_DIR)).toBe(false);
  });

  // ---- codex gate round 1: the identity set itself was wrong in both directions --

  it("corroborates through the aux id's REPO HALF — a raw \"owner/repo\" vouches for nothing", async () => {
    // `packDirNameCandidates` drops any path-shaped id (traversal defence), so passing
    // `aux_id` straight through silently contributes NO candidate. Manager matched this
    // entry by its cnr_id while the real checkout sits under the aux id's repo half, so
    // without the basename this reads as absent and clones a SECOND copy of a pack that
    // is already installed and working.
    manager.installed = {
      "ComfyUI-DaSiWa-Nodes-title": {
        ver: "1.2.0",
        cnr_id: "ComfyUI-DaSiWa-Nodes",
        aux_id: "darksidewalker/dasiwa-nodes-src",
        enabled: true,
      },
    };
    makePackDir("dasiwa-nodes-src", { "__init__.py": "NODE_CLASS_MAPPINGS = {}\n" });

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok?.mechanism).toBe("manager-http");
    expect(clonedInto()).toBeUndefined();
    expect(existsSync(PACK_DIR)).toBe(false);
  });

  it("will not let a human TITLE stand in for the module key", async () => {
    // codex gate round 2, P1. The ARRAY payload branch of `parseInstalled` used to
    // prefer `title` — prose — over the entry's own `module`. That put a label in a
    // slot every consumer reads as an IDENTITY (Manager's `node_name` on
    // uninstall/disable, findInstalledNode's matching, and this disk scan), so an
    // unrelated `custom_nodes/Shared Title` could certify an install that never
    // happened: this issue's own bug wearing a different hat.
    manager.installed = [
      {
        title: "Shared Title",
        module: REPO_NAME,
        aux_id: `darksidewalker/${REPO_NAME}`,
        ver: "nightly",
        enabled: true,
      },
    ];
    makePackDir("Shared Title", { "__init__.py": "NODE_CLASS_MAPPINGS = {}\n" });

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok?.mechanism).toBe("git-clone");
    expect(clonedInto()).toBe(PACK_DIR);
  });

  it("a TITLE-ONLY entry contributes no folder name at all", async () => {
    // codex gate round 3. This entry states NO `module`, so `parseInstalled` promotes
    // its human `title` into that slot — which is why the corroboration reads
    // `moduleKey` (the key the payload actually stated) and not `module`. Reading
    // `module` here would send the scan looking for a directory called "Friendly
    // Label", and an unrelated pack that happens to be named that would certify an
    // install that never happened.
    manager.installed = [
      {
        title: "Friendly Label",
        cnr_id: `someone/${REPO_NAME}`,
        ver: "1.0.0",
        enabled: true,
      },
    ];
    makePackDir("Friendly Label", { "__init__.py": "NODE_CLASS_MAPPINGS = {}\n" });

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok?.mechanism).toBe("git-clone");
    expect(clonedInto()).toBe(PACK_DIR);
  });

  it("a pack folder with a SPACE in its name still corroborates", async () => {
    // codex gate round 2, P1. Round 1 dropped whitespace-bearing aliases on the
    // reasoning that ComfyUI imports a pack directory as a Python module name so it
    // cannot contain a space. MEASURED FALSE: ComfyUI loads packs via
    // `importlib.util.spec_from_file_location`, which accepts any string as the
    // module name. The heuristic would have read a real, working pack as absent and
    // cloned a SECOND copy beside it.
    manager.installed = {
      "Foo Bar": { ver: "1.0.0", cnr_id: "foo-bar", aux_id: "someone/foo-bar", enabled: true },
    };
    makePackDir("Foo Bar", { "__init__.py": "NODE_CLASS_MAPPINGS = {}\n" });

    const { ok, error } = await install({ id: "https://github.com/someone/Foo-Bar", source: "git" });

    // The install id resolves to `Foo-Bar`, which is NOT on disk; only the Manager
    // entry's own module key ("Foo Bar") names the directory that is.
    expect(error).toBeUndefined();
    expect(ok?.mechanism).toBe("manager-http");
    expect(clonedInto()).toBeUndefined();
  });

  it("refuses a marker-only HUSK instead of reporting it as installed (#900 on the git route)", async () => {
    // The directory exists and Manager vouches for it, but ComfyUI cannot import
    // it — it will log a failure on every start. A success here is the same lie
    // in a different disguise.
    const husk = makePackDir(REPO_NAME, { ".git/HEAD": "ref: refs/heads/main\n" });

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(ok).toBeUndefined();
    expect(error).toMatch(/holds nothing ComfyUI can import/);
    expect(error).toContain(husk);
    // Not ours to delete: this call is not the proven author of that directory.
    expect(existsSync(husk)).toBe(true);
    expect(clonedInto()).toBeUndefined();
  });

  it("still succeeds — and SAYS the disk was not checked — when no scan root can be established", async () => {
    // COMFYUI_PATH unset and the server unreachable: `resolveInstallLocalWorkspace`
    // refuses to fall back to the saved default, so there is no custom_nodes root
    // to scan. "Could not look" is not absence, and the Manager list is then the
    // only witness there is — which the message must admit rather than imply.
    live.reachable = false;

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok?.mechanism).toBe("manager-http");
    expect(ok?.message).toMatch(/presence on disk was NOT verified/i);
    expect(ok?.message).toMatch(/only witness/i);
    expect(clonedInto()).toBeUndefined();
  });
});
