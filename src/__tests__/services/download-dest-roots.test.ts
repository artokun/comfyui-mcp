import { describe, expect, it, beforeEach, vi } from "vitest";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Regression suite for the download DESTINATION guard (resolveDownloadTarget /
// resolveModelSubfolderPreferServer -> assertNoEscapingSymlinkAncestor):
//
//   (a) #346 — a server with --base-directory != COMFYUI_PATH roots the download
//       at the SERVER's models dir (where the running ComfyUI actually reads).
//   (b) #633/#870 — a symlink/junction INSIDE the models tree may redirect the
//       write: into a live-registered extra root (#633), or anywhere else the
//       code-root veto does not cover (#870 — the StabilityMatrix layout, where
//       junctioned category folders ARE the registration mechanism and no config
//       can vouch for their targets; ComfyUI's scanner follows the links).
//   (c) path-safety — the symlink allowance never becomes a write-into-code-dir
//       (RCE) hole, and a broken link is never silently followed. Covers:
//         P0a  dangling / uncanonicalizable symlink -> REFUSED (not skipped).
//         P0b  primary models root that resolves into custom_nodes -> REFUSED.
//         P0c  (TOCTOU — inherent to pathname checks in Node; not asserted here).
//         P0d  SUPERSEDED by #870: authorization used to require a LIVE,
//              server-authoritative registration of the escape target. That
//              rule could never cover a junction the server never declares, so
//              it refused correct StabilityMatrix installs. Authorization now
//              comes from the symlink's LOCATION (inside the user's own models
//              tree); the code-root veto below is unaffected by the change.
//
// The REAL resolver + guard run; only /system_stats, the filesystem, config, and
// the static/live registered roots are controlled.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
  isRemoteMode: false,
  /** Whether the configured base corroborates the server's relative `main.py`. True for
   *  every pre-existing test; the #851 case is precisely the one where it does NOT (a
   *  Docker data dir holds no main.py), which is what reaches the inventory rescue. */
  baseHasEntrypoint: true,
}));
vi.mock("../../config.js", () => ({
  config: h.config,
  isRemoteMode: () => h.isRemoteMode,
}));

// resolveModelsDirWithBases consults existsSync only for an argv-derived live root;
// not exercised here (base-directory / fallback paths). Default false.
// `statSync` backs the #851 inventory rescue's `<base>/models` probe. Reporting it as a
// directory is what lets the rescue get as far as asking the server, which is the wiring
// the test below pins; the per-entry probes are irrelevant here because the listing is
// never satisfied.
vi.mock("node:fs", () => ({
  existsSync: () => false,
  statSync: () => ({ isDirectory: () => true, isFile: () => false }),
}));

const getSystemStats = vi.fn();
/** Shared so a test can see WHICH category the #851 inventory rescue asked about — the
 *  wiring that carries the download's own target category down to it. */
const fetchApi = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: (...a: unknown[]) => getSystemStats(...a),
  getClient: () => ({ fetchApi: (...a: unknown[]) => fetchApi(...(a as [])) }),
  // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
  // returns a 4xx instead of throwing. Routed to the SAME spy so every
  // existing "which route did we ask for" assertion still pins the same thing.
  comfyApiFetch: (...a: unknown[]) => ((...a: unknown[]) => fetchApi(...(a as [])))(...(a as [string])),
}));

// Two injected root sources, both feeding the code-root VETO only:
//  - getExtraModelRoots (STATIC-capable): contributes to the code-root VETO only.
//  - getLiveExtraModelRoots (LIVE, server-authoritative): its custom_nodes roots
//    also feed the veto. Since #870 NEITHER source authorizes anything — an
//    in-tree symlink's redirect is authorized by its location.
const getExtraModelRootsMock = vi.fn();
const getLiveExtraModelRootsMock = vi.fn();
vi.mock("../../services/extra-paths.js", () => ({
  getExtraModelRoots: (...a: unknown[]) => getExtraModelRootsMock(...a),
  getLiveExtraModelRoots: (...a: unknown[]) => getLiveExtraModelRootsMock(...a),
}));

const lstatMock = vi.fn();
const realpathMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  lstat: (...a: unknown[]) => lstatMock(...a),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: (...a: unknown[]) => realpathMock(...a),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  utimes: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../services/workspace-env.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/workspace-env.js")
  >("../../services/workspace-env.js");
  return {
    resolveEffectiveComfyUIBase: () =>
      h.config.comfyuiPath ?? (h.isRemoteMode ? undefined : h.config.comfyuiPath),
    liveRootFromArgv: actual.liveRootFromArgv,
    // #369: the models dir resolves through the ONE canonical live-root resolver.
    // These tests are about the destination GUARD, not about process observation,
    // so back it with the real argv parsing only (no OS process-table probe). The
    // configured base IS the live install here (it holds the `main.py` the server
    // reported), so the corroborated base-anchored fallback applies — the guard
    // scenarios below are unchanged by #369's refusal path.
    hasComfyUIEntrypoint: () => h.baseHasEntrypoint,
    resolveLiveServerRoot: (argv?: string[], cwd?: string) => {
      const root = actual.liveRootFromArgv(argv, cwd);
      return {
        root,
        source: root ? "argv" : "unresolved",
        relDir: actual.liveRelDirFromArgv(argv),
      };
    },
  };
});

import {
  resolveDownloadTarget,
  resolveModelSubfolderPreferServer,
} from "../../services/model-resolver.js";
import { ModelError } from "../../utils/errors.js";

const COMFYUI_PATH = "/comfy";

type Root = { category: string; dir: string; group: string };
/** Make getLiveExtraModelRoots return authoritative live roots (server reachable). */
function liveAuthoritative(roots: Root[]): void {
  getLiveExtraModelRootsMock.mockResolvedValue({ authoritative: true, roots });
}
/** A symlink only at `linkDir`, resolving to `realTarget` (identity elsewhere). */
function symlinkTo(linkDir: string, realTarget: string): void {
  lstatMock.mockImplementation((p: string) =>
    Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
  );
  realpathMock.mockImplementation((p: string) =>
    Promise.resolve(resolve(p) === linkDir ? realTarget : resolve(p)),
  );
}

beforeEach(() => {
  h.config.comfyuiPath = COMFYUI_PATH;
  h.isRemoteMode = false;
  h.baseHasEntrypoint = true;
  getSystemStats.mockReset();
  getExtraModelRootsMock.mockReset().mockResolvedValue([]);
  // Fail-closed default: no authoritative live roots (nothing authorizes an escape).
  getLiveExtraModelRootsMock.mockReset().mockResolvedValue({ authoritative: false, roots: [] });
  lstatMock.mockReset().mockResolvedValue({ isSymbolicLink: () => false });
  realpathMock.mockReset().mockImplementation((p: string) => Promise.resolve(p));
});

describe("(a) #346 — download honors the running server's --base-directory", () => {
  it("resolves the destination under the SERVER's models dir, not COMFYUI_PATH/models", async () => {
    const serverBase = resolve("/C/COMFY");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--base-directory", serverBase] },
    });

    const target = await resolveDownloadTarget(
      "https://example.com/model.safetensors",
      "unet",
      "model.safetensors",
    );

    expect(target.targetDir).toBe(join(serverBase, "models", "unet"));
    expect(target.targetPath).toBe(join(serverBase, "models", "unet", "model.safetensors"));
    expect(target.targetDir).not.toBe(resolve(COMFYUI_PATH, "models", "unet"));
  });

  it("honors --models-directory override too", async () => {
    const serverBase = resolve("/C/COMFY");
    const modelsDir = resolve("/D/shared-models");
    getSystemStats.mockResolvedValue({
      system: {
        argv: ["python", "main.py", "--base-directory", serverBase, "--models-directory", modelsDir],
      },
    });

    const target = await resolveDownloadTarget(
      "https://example.com/model.safetensors",
      "checkpoints",
    );
    expect(target.targetDir).toBe(join(modelsDir, "checkpoints"));
  });

  it("falls back to COMFYUI_PATH/models when the server is unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    const target = await resolveDownloadTarget(
      "https://example.com/model.safetensors",
      "loras",
      "m.safetensors",
    );
    expect(target.targetDir).toBe(resolve(COMFYUI_PATH, "models", "loras"));
  });
});

describe("(b) #633 — a symlink into a LIVE authoritatively-registered model root is allowed", () => {
  it("permits models/<link> -> /external/... when the LIVE server registers that extra root", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "external_unet_download");
    const externalRoot = resolve("/Volumes/Render/00_AI/models/unet");

    liveAuthoritative([{ category: "unet", dir: externalRoot, group: "comfyui" }]);
    symlinkTo(linkDir, externalRoot);

    const dir = await resolveModelSubfolderPreferServer("external_unet_download");
    expect(dir).toBe(linkDir);
  });

  it("permits a NESTED path under the symlinked-into-live-root dir", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "external_unet_download");
    const externalRoot = resolve("/Volumes/Render/00_AI/models/unet");

    liveAuthoritative([{ category: "unet", dir: externalRoot, group: "comfyui" }]);
    symlinkTo(linkDir, externalRoot);

    const dir = await resolveModelSubfolderPreferServer("external_unet_download/sub");
    expect(dir).toBe(resolve(linkDir, "sub"));
  });
});

describe("(b) #870 — a StabilityMatrix junction into UNDECLARED storage is allowed", () => {
  it("permits models/vae -> E:/StabilityMatrix/models/VAE with NO registered root covering it", async () => {
    // The reported #870 shape: StabilityMatrix junctions each shared model folder
    // into the package's models dir and registers nothing — the junction IS the
    // registration, and ComfyUI's scanner follows it (followlinks=True). The old
    // live-roots authorization could never vouch for the target, so a correct
    // install was refused.
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "vae");
    const junctionTarget = resolve("/E/comfy/StabilityMatrix/models/VAE");

    // Nothing authorizes this target: no static config, no live roots.
    getExtraModelRootsMock.mockResolvedValue([]);
    getLiveExtraModelRootsMock.mockResolvedValue({ authoritative: false, roots: [] });
    symlinkTo(linkDir, junctionTarget);

    const dir = await resolveModelSubfolderPreferServer("vae");
    expect(dir).toBe(linkDir);
  });
});

describe("(b) #870 — authorization comes from the symlink's LOCATION, not from any config", () => {
  it("ALLOWS an escape a STATIC config would list but the LIVE server does NOT (config no longer AUTHORIZES — it feeds the veto only)", async () => {
    // Pre-#870 this was refused ("no stale authorization", codex P0d). The symlink
    // sits inside the user's own models tree, so its redirect needs no config's
    // blessing — staleness is moot when authorization never came from config.
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "external_unet_download");
    const externalRoot = resolve("/Volumes/Render/00_AI/models/unet");

    getExtraModelRootsMock.mockResolvedValue([{ category: "unet", dir: externalRoot, group: "static" }]);
    getLiveExtraModelRootsMock.mockResolvedValue({ authoritative: false, roots: [] });
    symlinkTo(linkDir, externalRoot);

    await expect(
      resolveModelSubfolderPreferServer("external_unet_download"),
    ).resolves.toBe(linkDir);
  });

  it("ALLOWS an escape when the live-root lookup is non-authoritative (the lookup feeds the veto only)", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "external_unet_download");
    const externalRoot = resolve("/Volumes/Render/00_AI/models/unet");

    getLiveExtraModelRootsMock.mockResolvedValue({
      authoritative: false,
      roots: [{ category: "unet", dir: externalRoot, group: "x" }],
    });
    symlinkTo(linkDir, externalRoot);

    await expect(
      resolveModelSubfolderPreferServer("external_unet_download"),
    ).resolves.toBe(linkDir);
  });
});

describe("(c) escape landing — only a CODE-root landing is still refused", () => {
  it("ALLOWS models/<link> -> an unregistered location (the user's own redirect; post-write reports visibility)", async () => {
    // Pre-#870 this was the "escape floor" refusal. There is no structural
    // difference between `E:\StabilityMatrix\models\VAE` (legitimate) and
    // `/tmp/evil` (pointless) — both are undeclared targets of an in-tree link —
    // so the guard no longer refuses either. A landing the server cannot see is
    // reported honestly by the post-write check instead of being pre-emptively
    // refused (and a pre-existing in-tree symlink is the user's own fixture on
    // their own machine — single trust domain).
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "external_unet_download");
    const outside = resolve("/tmp/evil-outside");

    liveAuthoritative([{ category: "unet", dir: resolve("/Volumes/Render/00_AI/models/unet"), group: "comfyui" }]);
    symlinkTo(linkDir, outside);

    await expect(resolveModelSubfolderPreferServer("external_unet_download")).resolves.toBe(
      linkDir,
    );
  });

  it("REFUSES a symlink into a registered custom_nodes root (no arbitrary CODE write)", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "sneaky");
    const customNodesRoot = resolve("/opt/ComfyUI/custom_nodes");

    // Registered as custom_nodes (feeds the veto) via the static source.
    getExtraModelRootsMock.mockResolvedValue([{ category: "custom_nodes", dir: customNodesRoot, group: "comfyui" }]);
    symlinkTo(linkDir, customNodesRoot);

    await expect(resolveModelSubfolderPreferServer("sneaky")).rejects.toThrow(
      /code directory/i,
    );
  });

  it("REFUSES a RELABELED model category that physically aliases the base custom_nodes (path-based veto)", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "totally_a_model");
    const baseCustomNodes = resolve(COMFYUI_PATH, "custom_nodes"); // sibling of models root

    // Even as a LIVE authoritative "unet" model root, the real path is the base
    // custom_nodes code root -> vetoed by path.
    liveAuthoritative([{ category: "unet", dir: baseCustomNodes, group: "comfyui" }]);
    symlinkTo(linkDir, baseCustomNodes);

    await expect(
      resolveModelSubfolderPreferServer("totally_a_model"),
    ).rejects.toBeInstanceOf(ModelError);
  });

  it("REFUSES a relabeled alias to the base custom_nodes when --models-directory is NOT a sibling of it", async () => {
    const serverBase = resolve("/C/Comfy");
    const modelsDir = resolve("/D/models");
    getSystemStats.mockResolvedValue({
      system: {
        argv: ["python", "main.py", "--base-directory", serverBase, "--models-directory", modelsDir],
      },
    });
    const linkDir = resolve(modelsDir, "sneaky");
    const baseCustomNodes = resolve(serverBase, "custom_nodes"); // the REAL code dir

    liveAuthoritative([{ category: "unet", dir: baseCustomNodes, group: "comfyui" }]);
    symlinkTo(linkDir, baseCustomNodes);

    await expect(resolveModelSubfolderPreferServer("sneaky")).rejects.toBeInstanceOf(ModelError);
  });

  it("REFUSES a link into a custom_nodes subdir NESTED under a registered model root", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "peek");
    const modelRoot = resolve("/data/models");
    const nestedCustomNodes = resolve(modelRoot, "custom_nodes");
    const evilTarget = resolve(nestedCustomNodes, "evilpack");

    // /data/models is an authoritative model root; custom_nodes under it feeds the veto.
    liveAuthoritative([
      { category: "loras", dir: modelRoot, group: "comfyui" },
      { category: "custom_nodes", dir: nestedCustomNodes, group: "comfyui" },
    ]);
    symlinkTo(linkDir, evilTarget);

    await expect(resolveModelSubfolderPreferServer("peek")).rejects.toBeInstanceOf(ModelError);
  });

  it("ALLOWS a link into a model-root subdir that is NOT under custom_nodes (inverse nesting)", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "ok");
    const modelRoot = resolve("/data/models");
    const nestedCustomNodes = resolve(modelRoot, "custom_nodes");
    const goodTarget = resolve(modelRoot, "loras/sub");

    liveAuthoritative([
      { category: "loras", dir: modelRoot, group: "comfyui" },
      { category: "custom_nodes", dir: nestedCustomNodes, group: "comfyui" },
    ]);
    symlinkTo(linkDir, goodTarget);

    const dir = await resolveModelSubfolderPreferServer("ok");
    expect(dir).toBe(linkDir);
  });
});

describe("(c) P0a — dangling / uncanonicalizable symlink is REFUSED (never skipped)", () => {
  it("REFUSES when a symlink ancestor exists but its target cannot be resolved (dangling)", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "out"); // symlink to a NONEXISTENT target

    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    // realpath of the dangling link THROWS ENOENT; identity elsewhere.
    realpathMock.mockImplementation((p: string) => {
      if (resolve(p) === linkDir) {
        return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      }
      return Promise.resolve(resolve(p));
    });

    // target_subfolder "out/sub" -> the recursive mkdir would FOLLOW the dangling link.
    await expect(resolveModelSubfolderPreferServer("out/sub")).rejects.toThrow(
      /dangling or circular/i,
    );
  });

  it("FAILS CLOSED on a non-ENOENT lstat error (e.g. EACCES) rather than proceeding", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const blocked = resolve(modelsRoot, "blocked");

    lstatMock.mockImplementation((p: string) => {
      if (resolve(p) === blocked) {
        return Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      }
      return Promise.resolve({ isSymbolicLink: () => false });
    });

    await expect(resolveModelSubfolderPreferServer("blocked/sub")).rejects.toBeInstanceOf(ModelError);
  });
});

describe("(c) P0 — the PRIMARY models root itself is inspected (dangling/unreadable → refused)", () => {
  it("REFUSES when the models root is a symlink whose target can't be resolved (dangling)", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === modelsRoot }),
    );
    realpathMock.mockImplementation((p: string) => {
      if (resolve(p) === modelsRoot) {
        return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      }
      return Promise.resolve(resolve(p));
    });
    // A normal download; the ROOT models symlink is broken → escape must be refused,
    // not passed through to the recursive write.
    await expect(resolveModelSubfolderPreferServer("checkpoints")).rejects.toThrow(
      /dangling or circular/i,
    );
  });

  it("FAILS CLOSED on a non-ENOENT lstat error of the models root", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    lstatMock.mockImplementation((p: string) => {
      if (resolve(p) === modelsRoot) {
        return Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      }
      return Promise.resolve({ isSymbolicLink: () => false });
    });
    await expect(resolveModelSubfolderPreferServer("checkpoints")).rejects.toBeInstanceOf(ModelError);
  });
});

describe("(c) P0b — the PRIMARY models root itself must not be a code directory", () => {
  it("REFUSES all writes when --models-directory points the models root INTO custom_nodes", async () => {
    const serverBase = resolve("/C/Comfy");
    const modelsDir = resolve(serverBase, "custom_nodes"); // models root IS a code dir
    getSystemStats.mockResolvedValue({
      system: {
        argv: ["python", "main.py", "--base-directory", serverBase, "--models-directory", modelsDir],
      },
    });

    // A plain download, NO symlink in the path — still RCE without the primary veto.
    await expect(resolveModelSubfolderPreferServer("checkpoints")).rejects.toThrow(
      /code directory/i,
    );
  });

  it("REFUSES when the models root is a JUNCTION that canonicalizes into custom_nodes", async () => {
    const serverBase = resolve("/C/Comfy");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--base-directory", serverBase] },
    });
    const modelsRoot = resolve(serverBase, "models");
    const codeDir = resolve(serverBase, "custom_nodes");
    // The models root itself realpaths into custom_nodes (junction).
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === modelsRoot ? codeDir : resolve(p)),
    );

    await expect(resolveModelSubfolderPreferServer("checkpoints")).rejects.toThrow(
      /code directory/i,
    );
  });
});

describe("(d) #851 — the inventory rescue is asked about THIS download's category", () => {
  it("carries the caller's target category down to the corroboration", async () => {
    // The wiring, not the rule. The rescue can only corroborate the folder actually being
    // written to — a match on a sibling category would authorize the whole models root
    // for a category the server may read from somewhere else entirely. If the download
    // path stops passing its own category, the rescue silently starts answering a
    // different question, and nothing else in the system would notice.
    //
    // This shape is the #851 report: relative `main.py`, no cwd, and a base that holds no
    // main.py, so the code-layout corroboration cannot apply and the rescue is reached.
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    h.baseHasEntrypoint = false; // a data dir: no main.py, so only the rescue can apply
    fetchApi.mockClear();

    await resolveModelSubfolderPreferServer("loras/sdxl").catch(() => undefined);

    // Exactly the caller's CATEGORY (not the full subfolder, not a sweep).
    expect(fetchApi.mock.calls.map((c) => c[0])).toEqual(["/models/loras"]);
  });

  it("derives the category from the NORMALIZED subfolder, not its first raw segment", async () => {
    // `target_subfolder` accepts equivalent spellings. `loras/../checkpoints` writes to
    // `checkpoints` while its raw first segment is `loras` — so corroborating `loras`
    // (whose listing may well match) would authorize a `checkpoints` destination nothing
    // vouched for. The sibling-category hole, re-opened through a spelling.
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    h.baseHasEntrypoint = false;
    fetchApi.mockClear();

    await resolveModelSubfolderPreferServer("loras/../checkpoints").catch(() => undefined);

    expect(fetchApi.mock.calls.map((c) => c[0])).toEqual(["/models/checkpoints"]);
  });

  it("asks about NOTHING when the subfolder escapes the models root", async () => {
    // An escaping spelling gets no category at all, so no rescue can corroborate
    // anything; the containment check refuses it immediately after.
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    h.baseHasEntrypoint = false;
    fetchApi.mockClear();

    await expect(resolveModelSubfolderPreferServer("../outside")).rejects.toThrow();
    expect(fetchApi.mock.calls.map((c) => c[0])).not.toContain("/models/..");
  });
});
