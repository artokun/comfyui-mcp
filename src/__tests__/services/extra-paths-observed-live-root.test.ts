import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * #1621 — `list_local_models action:"list_paths"` reported UNRESOLVED against a LOCAL,
 * connected, perfectly reachable ComfyUI, and `getExtraModelRoots()` (model discovery)
 * contributed nothing, so callers fell back to reading loader combo options.
 *
 * The shape that does it is the most ordinary launch there is:
 *
 *     cd /opt/ComfyUI && python main.py --listen
 *
 * `sys.argv[0]` is then the RELATIVE string "main.py", and current ComfyUI does not
 * report its working directory in /system_stats — so nothing in the server's own argv
 * names an absolute path, and extra-paths' argv-only derivation gave up. With
 * COMFYUI_PATH unset and no saved default workspace (the normal state for a
 * panel-connected install), the static fallback then THREW rather than fell back.
 *
 * The OS knows the answer: it can name the process listening on the port and where its
 * interpreter lives. That is `resolveLiveServerRoot`'s observed-process tier — the same
 * resolver that already decides where a DOWNLOADED MODEL is written (#369). These tests
 * pin that extra-paths resolves through it too.
 */

// Spread the real config so every consumer of this module (workspace-env,
// live-interpreter) keeps the exports it reads at import time; only the two knobs these
// cases drive are overridden.
const mockIsRemoteMode = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    config: { ...actual.config, comfyuiPath: undefined as string | undefined },
    isRemoteMode: mockIsRemoteMode,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  };
});

// #1263 — THE PROCESS TABLE IS NOT A FIXTURE. `resolveLiveServerRoot`'s observed-process
// tier shells out to netstat/WMI/lsof to find whatever is really serving the port on THIS
// machine, so a developer box with ComfyUI up would anchor onto a real interpreter and a
// CI box would not. Stubbed to "found nothing" by default — the state the refusal cases
// describe — and opted into per case.
const hoisted = vi.hoisted(() => ({
  liveProcess: vi.fn((): { pid: number; python?: string; image?: string } | undefined => undefined),
}));
vi.mock("../../services/live-interpreter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/live-interpreter.js")>();
  return { ...actual, observeLiveServerProcess: hoisted.liveProcess };
});

const mockGetSystemStats = vi.hoisted(() =>
  vi.fn(async (): Promise<{ system?: { argv?: string[]; cwd?: string } }> => {
    throw new Error("ComfyUI unreachable (test default)");
  }),
);
vi.mock("../../comfyui/client.js", () => ({ getSystemStats: mockGetSystemStats }));

import { config } from "../../config.js";
import { observeLiveServerProcess } from "../../services/live-interpreter.js";
import {
  addExtraPath,
  getExtraModelRoots,
  listExtraPaths,
} from "../../services/extra-paths.js";
import { configureWorkspace, resetWorkspaceConfig } from "../../services/workspace-env.js";

let dirs: string[] = [];
const oldComfyuiPathEnv = process.env.COMFYUI_PATH;

async function trackTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "comfyui-observed-root-"));
  dirs.push(dir);
  return dir;
}

/**
 * A ComfyUI install laid out the way a manual Linux/macOS install is: `main.py` in the
 * root and the interpreter in `<root>/.venv/bin`, which is what makes the interpreter
 * provably INSIDE this install rather than beside it.
 */
async function install(): Promise<{ root: string; python: string }> {
  const root = await trackTmp();
  await writeFile(join(root, "main.py"), "# comfyui\n", "utf-8");
  const bin = join(root, ".venv", "bin");
  await mkdir(bin, { recursive: true });
  const python = join(bin, "python3");
  await writeFile(python, "#!/bin/sh\n", "utf-8");
  return { root, python };
}

beforeEach(() => {
  config.comfyuiPath = undefined;
  delete process.env.COMFYUI_PATH;
  dirs = [];
  mockIsRemoteMode.mockReturnValue(false);
  // mockReturnValue does NOT clear the call log, and one case asserts the probe was
  // never reached — without this it would read a previous case's calls.
  hoisted.liveProcess.mockClear();
  hoisted.liveProcess.mockReturnValue(undefined);
  mockGetSystemStats.mockRejectedValue(new Error("ComfyUI unreachable (test default)"));
  // No saved default workspace — point the store at a path that cannot exist, so these
  // cases can never pick up the developer's real one.
  configureWorkspace({ configPath: join(tmpdir(), "comfyui-mcp-no-such-workspace.json") });
});

afterEach(async () => {
  if (oldComfyuiPathEnv === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = oldComfyuiPathEnv;
  config.comfyuiPath = undefined;
  resetWorkspaceConfig();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("extra-paths resolves the live root the OS can see (#1621)", () => {
  it("the imported observeLiveServerProcess IS this file's stub, by identity", () => {
    // Without this, a mock that silently stopped applying would make every case below
    // pass for the wrong reason — or hit the real process table.
    expect(observeLiveServerProcess).toBe(hoisted.liveProcess);
  });

  it("lists the RUNNING server's own extra_model_paths.yaml for a bare `python main.py` launch", async () => {
    const { root, python } = await install();
    await writeFile(
      join(root, "extra_model_paths.yaml"),
      "mine:\n  base_path: /srv/models\n  loras: loras/\n",
      "utf-8",
    );
    // Exactly what `cd <root> && python main.py --listen` reports: a RELATIVE argv[0]
    // and no cwd.
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["main.py", "--listen"] } });
    hoisted.liveProcess.mockReturnValue({ pid: 4242, python });

    const listed = await listExtraPaths();

    expect(listed.path).toBe(join(root, "extra_model_paths.yaml"));
    expect(listed.exists).toBe(true);
    expect(listed.groups[0].categories).toEqual([{ category: "loras", paths: ["loras/"] }]);
    // Reported as the LIVE server's own file, not as the local heuristic's guess —
    // `serverResolved` is internal, so the caption is what the caller actually sees.
    expect(listed.notes.join(" ")).toContain(
      `Resolved from the RUNNING ComfyUI's own install root (${root})`,
    );
    expect(listed.notes.join(" ")).not.toMatch(/not confirmation that the live server reads it/i);
  });

  it("feeds MODEL DISCOVERY the live server's extra roots, not an empty set", async () => {
    // getExtraModelRoots deliberately does NOT take the display-only #764 fallback, so
    // before this fix it saw the refusal and returned [] — which is why the reporter had
    // to read loader combo options instead of the path resolver.
    //
    // A relative DIR rather than a bare script (`ComfyUI/main.py`) — the ComfyUI Desktop
    // and Windows-portable shape — anchored on an interpreter inside that nested root.
    const bundle = await trackTmp();
    const nested = join(bundle, "ComfyUI");
    await mkdir(join(nested, ".venv", "bin"), { recursive: true });
    await writeFile(join(nested, "main.py"), "# comfyui\n", "utf-8");
    const nestedPython = join(nested, ".venv", "bin", "python3");
    await writeFile(nestedPython, "#!/bin/sh\n", "utf-8");
    const models = await trackTmp();
    await writeFile(
      join(nested, "extra_model_paths.yaml"),
      `mine:\n  base_path: ${models}\n  loras: loras/\n`,
      "utf-8",
    );
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [join("ComfyUI", "main.py"), "--listen"] },
    });
    hoisted.liveProcess.mockReturnValue({ pid: 99, python: nestedPython });

    await expect(getExtraModelRoots()).resolves.toEqual([
      { category: "models", dir: resolve(models), group: "mine" },
      { category: "loras", dir: resolve(models, "loras"), group: "mine" },
    ]);
  });

  it("targets the live root for a WRITE, instead of refusing an install it can see", async () => {
    // The same root this MCP would stream a DOWNLOADED MODEL into (resolveLiveServerRoot
    // is that resolver): refusing to write the yaml beside those models while happily
    // writing the models is the disagreement #369 exists to prevent.
    const { root, python } = await install();
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["main.py"] } });
    hoisted.liveProcess.mockReturnValue({ pid: 7, python });

    await addExtraPath({ category: "loras", path: "/mnt/big/loras" });

    const written = await readFile(join(root, "extra_model_paths.yaml"), "utf-8");
    expect(written).toMatch(/loras/);
    expect(written).toMatch(/\/mnt\/big\/loras/);
  });

  it("still refuses, and says what it observed, when the OS cannot anchor the process", async () => {
    // Nothing found on the port — genuinely unavailable. The refusal must state what was
    // observed (a relative script, no cwd, no anchor) and must NOT claim the argv
    // revealed no main.py, which it plainly did.
    const stale = await trackTmp();
    config.comfyuiPath = stale;
    process.env.COMFYUI_PATH = stale;
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["main.py", "--listen"] } });
    hoisted.liveProcess.mockReturnValue(undefined);

    await expect(addExtraPath({ category: "loras", path: "/mnt/big/loras" })).rejects.toThrow(
      /UNRESOLVED[\s\S]*RELATIVELY[\s\S]*could not be anchored/,
    );
    // …and the false cause is gone. Matched WITHOUT the "at all" suffix so it also
    // catches the refusal's own hardcoded copy of that claim, not just localityGap's.
    await expect(addExtraPath({ category: "loras", path: "/mnt/big/loras" })).rejects.not.toThrow(
      /does not reveal a main\.py/,
    );
  });

  it("does not consult the process table when the argv already resolves", async () => {
    // The observed-process tier may only ADD a resolution. An absolute argv[0] is already
    // authoritative, so the probe must not run at all — it shells out, and a second
    // answer could disagree with the one being reported.
    const { root } = await install();
    await writeFile(join(root, "extra_model_paths.yaml"), "mine:\n  loras: /x\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", join(root, "main.py")] } });

    const listed = await listExtraPaths();

    expect(listed.path).toBe(join(root, "extra_model_paths.yaml"));
    expect(hoisted.liveProcess).not.toHaveBeenCalled();
  });
});
