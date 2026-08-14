// #1133 (failure 2) — on ComfyUI **Desktop** every destructive panel operation
// refused, because the panel's base resolver could find no live-derived root at
// all.
//
// The reported cause was that `--input-directory`/`--output-directory` were being
// read as evidence of a split install. They are not: nothing in the panel path
// has ever looked at either flag. The REAL mechanism is narrower and entirely
// mechanical — Desktop reports its launch argv as a RELATIVE `ComfyUI\main.py`
// with **no** cwd, so:
//
//   * `parseBaseDirFromArgv` yields nothing (there is no `--base-directory`), and
//   * `liveRootFromArgv` yields nothing (a relative dir with no absolute cwd
//     cannot be resolved, and it refuses to hand back a bogus relative root).
//
// …leaving the configured path as the only candidate, which by construction the
// running server never vouched for. So `isLiveDerivedBase` was false and the
// corroboration gate refused — on every Desktop install, universally.
//
// `resolveLiveServerRoot` already has a tier built for exactly this shape: it
// asks the OS which process is listening on our port, correlates it against that
// server's own argv, and re-anchors the relative `main.py` on that interpreter's
// install tree. `resolvePanelBase` simply was not using it — it re-parsed argv
// itself, which is precisely what `LiveServerSnapshot.liveRoot` warns consumers
// against ("or they miss the relative-`main.py` shape entirely").
//
// So this is NOT a relaxation of a guard that gates a DESTRUCTIVE directory
// swap, and these tests are written to hold that line:
//
//   * `--base-directory` still wins ahead of the observed root, so a genuinely
//     split install resolves exactly as it did before (`splitStillWins`);
//   * the observed root is still gated on actually holding `custom_nodes`;
//   * when the observation FAILS, the resolution is still uncorroborated and the
//     gate still refuses.
//
// The end-to-end anchoring itself (interpreter → install tree) is proven against
// the real resolver in workspace-env.test.ts's `resolveLiveServerRoot (#369)`
// block. What is proven HERE is the wiring: that the panel base resolver
// consults it, and that a Desktop-shaped server therefore reaches the mutation
// instead of being refused.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-desktop-observed-${process.pid}.lock`,
);
process.env.COMFYUI_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), "cmcp-data-desktop-observed-"));

const generation = vi.hoisted(() => ({ value: 0 }));
// #1290 — this file reaches `resolveLiveServerRoot`, whose second tier shells
// out (netstat/WMI) to find the python actually serving the port ON THIS
// MACHINE. Unstubbed, the assertions below would depend on whether the
// developer happens to have ComfyUI running (#1263). Stub it at the boundary.
vi.mock("../../services/live-interpreter.js", async () => ({
  ...(await vi.importActual("../../services/live-interpreter.js")),
  resolveLiveInterpreter: () => undefined,
  observeLiveServerProcess: () => undefined,
}));

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isLocalMode: () => true,
  isRemoteMode: () => false,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => generation.value,
}));

const workspace = vi.hoisted(() => ({
  base: undefined as string | undefined,
  liveArgv: undefined as string[] | undefined,
  reachable: false,
  /** What the OS-observed process tier resolves to. undefined ⇒ the process
   *  could not be identified, or the anchored dir held no main.py. */
  observedRoot: undefined as string | undefined,
  /** Raw `--base-directory` value appended to the reported argv (may be relative). */
  baseDirRaw: undefined as string | undefined,
}));

// Stand-in faithful to the real derivation's contract: an ABSOLUTE main.py
// yields its dir; a RELATIVE one with no cwd yields nothing.
const argvRoot = vi.hoisted(() => (argv: string[] | undefined) => {
  const main = argv?.find((a) => /(^|[\\/])main\.py$/.test(a));
  if (!main) return undefined;
  const dir = main.slice(0, main.length - "main.py".length).replace(/[\\/]$/, "");
  if (dir === "" || !/^([a-zA-Z]:[\\/]|[\\/])/.test(dir)) return undefined;
  return dir;
});

vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: () => workspace.base,
  resolveLocalWorkspaceBase: () => workspace.base,
  liveRootFromArgv: (argv: string[] | undefined) => argvRoot(argv),
  // The real two-tier contract: argv first, then the OS-observed process anchor.
  //
  // The observed tier reproduces production's on-disk precondition rather than
  // trusting the injected value: `anchorRelDirOnInterpreter` returns a root ONLY
  // when it actually holds `main.py`. Without that, a fixture could "anchor" a
  // directory production would have rejected, and the suite would be asserting
  // about a state the code can never reach.
  resolveLiveServerRoot: (argv: string[] | undefined) => {
    const fromArgv = argvRoot(argv);
    if (fromArgv) return { root: fromArgv, source: "argv" };
    if (workspace.observedRoot && existsSync(join(workspace.observedRoot, "main.py"))) {
      return { root: workspace.observedRoot, source: "observed-process" };
    }
    return { source: "unresolved" };
  },
  getLiveServerSnapshot: async () => ({
    reachable: workspace.reachable,
    // `--base-directory` is appended to the REAL argv rather than stubbing
    // output-dir, so production's own `parseBaseDirFromArgv` and
    // `hasUnresolvableRelativeBaseDirFlag` do the parsing — a stub there could
    // silently disagree with the code under test about what "unresolvable" means.
    argv: workspace.liveArgv && [
      ...workspace.liveArgv,
      ...(workspace.baseDirRaw ? ["--base-directory", workspace.baseDirRaw] : []),
    ],
    cwd: undefined, // Desktop reports none — the whole point
  }),
}));

import {
  defaultDeps,
  PanelInstallError,
  runPanelActionInner,
  PANEL_REGISTRY_ID,
} from "../../services/panel-installer.js";
import {
  __resetPanelBaseCache,
  isLiveDerivedBase,
  primePanelBase,
} from "../../services/panel-workspace.js";

/** The argv ComfyUI Desktop actually reports — verbatim in shape from #1133.
 *  Relative main.py, no cwd, media dirs relocated, NO --base-directory. */
const DESKTOP_ARGV = [
  join("ComfyUI", "main.py"),
  "--enable-manager",
  "--input-directory",
  join("C:", "Comfy-Desktop", "ComfyUI-Shared", "input"),
  "--output-directory",
  join("C:", "Comfy-Desktop", "ComfyUI-Shared", "output"),
];

let root: string;
let configured: string;
let savedPin: string | undefined;

/** A registry-zip-shaped panel pack (pyproject, no .git) in `base`'s custom_nodes. */
function writePanelPack(base: string, version: string): void {
  const dir = join(base, "custom_nodes", PANEL_REGISTRY_ID);
  mkdirSync(join(dir, "web", "js"), { recursive: true });
  writeFileSync(
    join(dir, "pyproject.toml"),
    `[project]\nname = "${PANEL_REGISTRY_ID}"\nversion = "${version}"\n`,
  );
  writeFileSync(join(dir, "web", "js", "comfyui-mcp-panel.js"), `// panel ${version}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-desktop-observed-"));
  configured = mkdtempSync(join(tmpdir(), "cmcp-desktop-configured-"));
  mkdirSync(join(root, "custom_nodes"), { recursive: true });
  mkdirSync(join(configured, "custom_nodes"), { recursive: true });
  // The observed tier only ever anchors a dir that really holds the entrypoint.
  writeFileSync(join(root, "main.py"), "# ComfyUI\n");
  workspace.base = configured;
  workspace.liveArgv = undefined;
  workspace.reachable = false;
  workspace.observedRoot = undefined;
  workspace.baseDirRaw = undefined;
  generation.value = 0;
  __resetPanelBaseCache();
  savedPin = process.env.COMFYUI_MCP_PANEL_PIN;
  process.env.COMFYUI_MCP_PANEL_PIN = "off";
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(configured, { recursive: true, force: true });
  __resetPanelBaseCache();
  if (savedPin === undefined) delete process.env.COMFYUI_MCP_PANEL_PIN;
  else process.env.COMFYUI_MCP_PANEL_PIN = savedPin;
});

describe("a Desktop argv resolves through the OS-observed process (#1133)", () => {
  it("relative main.py + no cwd + a successful observation ⇒ live-observed-root", async () => {
    workspace.reachable = true;
    workspace.liveArgv = DESKTOP_ARGV;
    workspace.observedRoot = root;

    const resolution = await primePanelBase({ force: true });

    expect(resolution.source).toBe("live-observed-root");
    expect(resolution.base).toBe(root);
    // Neither "could not ask" nor "asked, nothing derivable" — we DID derive one.
    expect(resolution.liveProbeFailed).toBeFalsy();
    expect(resolution.liveRootUnderivable).toBeFalsy();
    // The configured tree is a DIFFERENT one, and that disagreement is surfaced.
    expect(resolution.overriddenConfiguredBase).toBe(configured);
  });

  it("the observed root COUNTS as live-derived — this is the line the gate reads", () => {
    // The whole fix reduces to this predicate. If `live-observed-root` were
    // missing from isLiveDerivedBase, every assertion above would still pass
    // while the corroboration gate refused exactly as before.
    expect(isLiveDerivedBase({ base: root, source: "live-observed-root" })).toBe(true);
    // …and the classification is still a whitelist, not "anything non-configured".
    expect(isLiveDerivedBase({ base: root, source: "configured" })).toBe(false);
    expect(isLiveDerivedBase({ source: "none" })).toBe(false);
    expect(isLiveDerivedBase(undefined)).toBe(false);
  });

  it("the destructive update is no longer REFUSED on a Desktop install", async () => {
    // A pack in BOTH trees, deliberately. If the resolution silently fell back
    // to the configured path, the operation would still find a pack there and
    // fail on CORROBORATION rather than on "not installed" — so this assertion
    // stays pointed at the gate instead of accidentally passing because the
    // fallback tree happened to be empty.
    writePanelPack(root, "0.11.38");
    writePanelPack(configured, "0.11.38");
    workspace.reachable = true;
    workspace.liveArgv = DESKTOP_ARGV;
    workspace.observedRoot = root;

    const resolution = await primePanelBase({ force: true });
    expect(resolution.base).toBe(root); // the OBSERVED tree, not the configured one

    const err = await runPanelActionInner("update", defaultDeps).catch((e) => e);
    const msg = err instanceof Error ? err.message : String(err ?? "");

    // It may still fail for ordinary reasons (no network in this test), but it
    // must NOT fail on corroboration — that refusal is the #1133 dead end.
    expect(msg).not.toMatch(/CONFIGURED path rather than a corroborated one/);
    expect(msg).not.toMatch(/did not identify an install root/);
  });
});

describe("the guard is not relaxed (#1133)", () => {
  it("--base-directory STILL wins over the observed root (split installs unchanged)", async () => {
    // A genuinely split install: the flag names a tree that is NOT the observed
    // one. The flag must win — it is what ComfyUI derives custom_nodes from.
    const splitBase = mkdtempSync(join(tmpdir(), "cmcp-desktop-split-"));
    mkdirSync(join(splitBase, "custom_nodes"), { recursive: true });
    try {
      workspace.reachable = true;
      workspace.liveArgv = DESKTOP_ARGV;
      workspace.observedRoot = root;
      workspace.baseDirRaw = splitBase;

      const resolution = await primePanelBase({ force: true });

      expect(resolution.source).toBe("live-base-directory");
      expect(resolution.base).toBe(splitBase);
      expect(resolution.base).not.toBe(root);
    } finally {
      rmSync(splitBase, { recursive: true, force: true });
    }
  });

  it("an observed root WITHOUT custom_nodes is not adopted", async () => {
    // The candidate is still required to prove it holds the tree the panel lives
    // in. A bare interpreter anchor that happens to resolve is not enough.
    const bare = mkdtempSync(join(tmpdir(), "cmcp-desktop-bare-"));
    writeFileSync(join(bare, "main.py"), "# ComfyUI\n"); // anchors, but…
    try {
      workspace.reachable = true;
      workspace.liveArgv = DESKTOP_ARGV;
      workspace.observedRoot = bare; // …no custom_nodes inside

      const resolution = await primePanelBase({ force: true });

      expect(resolution.source).toBe("configured");
      expect(resolution.liveRootUnderivable).toBe(true);
      expect(isLiveDerivedBase(resolution)).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("a PRESENT but unresolvable --base-directory poisons EVERY candidate", async () => {
    // The hole codex found. `parseBaseDirFromArgv` returns undefined for a
    // RELATIVE --base-directory with no cwd — it cannot be resolved — which used
    // to mean the flag simply "wasn't there", letting the next candidate win.
    // But ComfyUI derives custom_nodes from `<cwd>/<flag>`, so the observed root
    // is a tree that flag has already overridden. Adopting it would hand a
    // destructive swap a confidently-WRONG directory.
    workspace.reachable = true;
    workspace.liveArgv = DESKTOP_ARGV;
    workspace.observedRoot = root; // would otherwise anchor and win
    workspace.baseDirRaw = "ComfyUI-Data"; // relative, and no cwd is reported

    const resolution = await primePanelBase({ force: true });

    expect(resolution.source).toBe("configured");
    expect(resolution.base).not.toBe(root);
    expect(isLiveDerivedBase(resolution)).toBe(false);
    expect(resolution.baseDirUnresolvable).toBe(true);
  });

  it("the poisoned case names the flag, not the dead absolute-main.py remedy", async () => {
    // Reporting "relaunch with an ABSOLUTE path to main.py" here would be the
    // #916 defect pointed at a new branch: the script path is not what failed
    // to resolve. The flag is.
    writePanelPack(configured, "0.11.38");
    workspace.reachable = true;
    workspace.liveArgv = DESKTOP_ARGV;
    workspace.observedRoot = root;
    workspace.baseDirRaw = "ComfyUI-Data";

    const err = await runPanelActionInner("update", defaultDeps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message);

    expect(msg).toMatch(/--base-directory we cannot resolve/);
    expect(msg).toMatch(/ABSOLUTE --base-directory/);
    expect(msg).not.toMatch(/ABSOLUTE path to main\.py/);
  });

  it("an ABSOLUTE --base-directory is not poisoned — it still resolves and wins", async () => {
    // The guard must fire on UNRESOLVABLE, not on "present". An absolute flag
    // is exactly the split install the gate is built to protect.
    const splitBase = mkdtempSync(join(tmpdir(), "cmcp-desktop-abs-"));
    mkdirSync(join(splitBase, "custom_nodes"), { recursive: true });
    try {
      workspace.reachable = true;
      workspace.liveArgv = DESKTOP_ARGV;
      workspace.observedRoot = root;
      workspace.baseDirRaw = splitBase; // absolute

      const resolution = await primePanelBase({ force: true });

      expect(resolution.source).toBe("live-base-directory");
      expect(resolution.base).toBe(splitBase);
      expect(resolution.baseDirUnresolvable).toBeFalsy();
    } finally {
      rmSync(splitBase, { recursive: true, force: true });
    }
  });

  it("a FAILED observation still leaves the resolution uncorroborated and refusing", async () => {
    // The `unknown` case keeps refusing — the same tri-state discipline the
    // reservation fix (#1141) used. This is the branch that must never be
    // turned into a success.
    writePanelPack(configured, "0.11.38");
    workspace.reachable = true;
    workspace.liveArgv = DESKTOP_ARGV;
    workspace.observedRoot = undefined; // the OS could not identify the process

    const resolution = await primePanelBase({ force: true });
    expect(resolution.source).toBe("configured");
    expect(resolution.liveRootUnderivable).toBe(true);
    expect(isLiveDerivedBase(resolution)).toBe(false);

    const err = await runPanelActionInner("update", defaultDeps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect(String(err?.message)).toMatch(/CONFIGURED path rather than a corroborated one/);
  });
});
