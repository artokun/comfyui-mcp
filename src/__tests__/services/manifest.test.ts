import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const IS_WIN = process.platform === "win32";
// The product (manifest.ts) detects an executable on Windows with
// `where <cmd>` and on POSIX with `<cmd> --version`. Mirror that here so the
// detection assertion passes on both platforms.
const detectCmd = IS_WIN ? "where" : "uv";
const detectArgs = IS_WIN ? ["uv"] : ["--version"];
const COMFY = "/fake/ComfyUI";

const mockConfig = vi.hoisted(() => ({
  comfyuiPath: "/fake/ComfyUI" as string | undefined,
  comfyuiCodePath: undefined as string | undefined,
  // Explicit remote override. When undefined, isRemoteMode mirrors the legacy
  // "no comfyuiPath" gate; set true to model a remote target that COEXISTS with
  // a local COMFYUI_PATH (the regression issue #1 guards against).
  remote: undefined as boolean | undefined,
}));

const readFileMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const realpathMock = vi.hoisted(() => vi.fn());
const lstatMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const installCustomNodeMock = vi.hoisted(() => vi.fn());
const installModelViaManagerMock = vi.hoisted(() => vi.fn());
const listInstalledNodesMock = vi.hoisted(() => vi.fn());
const downloadModelMock = vi.hoisted(() => vi.fn());
/** #369 post-landing verification. Default: the connected ComfyUI DOES list the
 *  landed file (the healthy local case these manifest tests model). */
const verifyLandedModelMock = vi.hoisted(() =>
  vi.fn(async (targetPath: string) => ({
    verifiedPath: targetPath,
    liveVisible: "visible" as const,
    // The verdict names the root it was made against; the reader below reports the
    // SAME root, which is what licenses re-asserting it as applied (#369).
    verifiedAgainstRoot: "/fake/ComfyUI/models",
  })),
);
/** #369: does the connected ComfyUI already list this entry? Default yes, so an
 *  existing file still counts as a legitimate skip. */
const liveListingHasEntryMock = vi.hoisted(() =>
  vi.fn(async (): Promise<boolean | undefined> => true),
);
/** #369: is an existing file physically inside a tree the live server reads? Only
 *  a positive answer licenses an "already exists" SKIP. Default TRUE — these tests
 *  model the healthy local case; the unconfirmed/stale paths are asserted
 *  explicitly below. */
/** #369: does the live server serve a file of this basename in the category?
 *  Default TRUE — the healthy case these tests model. */
const liveListingHasBasenameMock = vi.hoisted(() =>
  vi.fn(async (): Promise<boolean | undefined> => true),
);
const isUnderLiveModelRootsMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ inRoots: boolean | undefined; liveRoot?: string }> => ({
    inRoots: true,
  })),
);
/** The models root the connected server reads NOW. Undefined = unknown, which never
 *  invalidates a verdict. */
const currentLiveRootMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | undefined> => "/fake/ComfyUI/models"),
);
/** #1374 — the ROUTING decision inside startDownloadJob, which is NOT the same
 *  question as manifest's own local-vs-remote branch. A local install with a
 *  filesystem can still have its download dispatched to ComfyUI-Manager (that is
 *  the reporter's own Linux/Pinokio shape), and only then does a manifest item
 *  render from a `viaManager` job. Default mirrors the mode gate. */
const shouldDispatchToManagerMock = vi.hoisted(() =>
  vi.fn(async (): Promise<boolean> => mockConfig.remote ?? !mockConfig.comfyuiPath),
);
/** #1374 — the Manager route's post-dispatch listing check. Default: the server
 *  cannot be asked, which is the inert answer. */
const verifyManagerVisibilityMock = vi.hoisted(() =>
  vi.fn(async () => ({ visibility: "unknown" as const, note: "not asked" })),
);
const resolveExistingModelFileMock = vi.hoisted(() => vi.fn());
const listLocalModelsMock = vi.hoisted(() => vi.fn());
const savedWorkspaceMock = vi.hoisted(() => vi.fn(() => undefined as string | undefined));
const liveComfyBaseMock = vi.hoisted(() =>
  vi.fn(async () => undefined as string | undefined),
);
const effectiveCodeBaseLiveMock = vi.hoisted(() =>
  vi.fn(async () => undefined as string | undefined),
);
const effectiveBaseLiveMock = vi.hoisted(() =>
  vi.fn(async () => mockConfig.comfyuiPath as string | undefined),
);
// Overridable per-test: default mirrors a VERIFIED install-root interpreter (the
// fail-closed resolver only returns a python it can account for, #651).
const installInterpreterMock = vi.hoisted(() =>
  vi.fn(
    async (root: string | undefined): Promise<{ python?: string; source: string; reason: string }> => ({
      python: root ? `${root}/python` : "python",
      source: "launched",
      reason: "test interpreter",
    }),
  ),
);

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => 0,
  // apply_manifest routes models through the Manager in remote mode (no
  // comfyuiPath). isRemoteMode mirrors that gate for the tests.
  isRemoteMode: () => mockConfig.remote ?? !mockConfig.comfyuiPath,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (...a: unknown[]) => lstatMock(...a),
    mkdir: (...a: unknown[]) => mkdirMock(...a),
    readFile: (...a: unknown[]) => readFileMock(...a),
    realpath: (...a: unknown[]) => realpathMock(...a),
    stat: (...a: unknown[]) => statMock(...a),
  };
});

vi.mock("node:fs", () => ({
  existsSync: (...a: unknown[]) => existsSyncMock(...a),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
  };
});

vi.mock("../../services/node-management.js", () => ({
  installCustomNode: (...a: unknown[]) => installCustomNodeMock(...a),
  installModelViaManager: (...a: unknown[]) => installModelViaManagerMock(...a),
  listInstalledNodes: (...a: unknown[]) => listInstalledNodesMock(...a),
}));

vi.mock("../../services/model-resolver.js", () => ({
  MODEL_SUBDIRS: [
    "checkpoints",
    "loras",
    "vae",
    "upscale_models",
    "controlnet",
    "embeddings",
    "clip",
    "diffusers",
    "diffusion_models",
    "gligen",
    "hypernetworks",
    "photomaker",
    "style_models",
    "text_encoders",
    "unet",
  ],
  downloadModel: (...a: unknown[]) => downloadModelMock(...a),
  // startDownloadJob consults this to choose local-vs-Manager routing (#420).
  // Overridable per-test (#1374): the routing decision is INDEPENDENT of whether
  // manifest itself took its local branch, and the gap between them is where the
  // reporter's job came from.
  shouldDispatchDownloadToManager: (...a: unknown[]) => shouldDispatchToManagerMock(...(a as [])),
  // The Manager route's post-dispatch check, and the name it asks about. Both are
  // REQUIRED here: download-jobs.ts calls them on that route, and a module mock
  // that omits them makes the call throw into its own catch — so the arm under
  // test would "pass" while exercising nothing (#1374 review).
  verifyManagerVisibility: (...a: unknown[]) => verifyManagerVisibilityMock(...(a as [])),
  managerJobFilename: (job: { filename?: string; path?: string }) =>
    job.filename ?? ((job.path ?? "").split(" (")[0].split("/").pop() ?? ""),
  // startDownloadJob resolves the destination via this before streaming; stub it
  // so a distinct targetPath is derived per (subfolder, filename) without a server.
  resolveDownloadTarget: async (url: string, sub: string, filename?: string) => {
    const name = filename ?? String(url).split("/").pop() ?? "model.safetensors";
    return { targetDir: `/fake/ComfyUI/models/${sub}`, filename: name, targetPath: `/fake/ComfyUI/models/${sub}/${name}` };
  },
  resolveExistingModelFile: (...a: unknown[]) => resolveExistingModelFileMock(...a),
  listLocalModels: (...a: unknown[]) => listLocalModelsMock(...a),
  // #369: after landing, the job verifies the file against the LIVE server's own
  // listing, and only a CONFIRMED placement is reported as "applied". These tests
  // model the healthy local case (the connected ComfyUI does read from there);
  // the unconfirmed/wrong-place renderings are covered in download-jobs.test.ts
  // and download-live-destination.test.ts.
  verifyLandedModel: (...a: unknown[]) => verifyLandedModelMock(...(a as [string, string])),
  // The "already exists" shortcut confirms the file is one the LIVE server reads
  // before it counts as a skip (#369). Default: it is.
  liveListingHasEntry: (...a: unknown[]) => liveListingHasEntryMock(...(a as [string, string])),
  // A skip additionally requires the live server to really serve a file of that
  // BASENAME in the category (the container/host path-collision guard). Default yes.
  liveListingHasBasename: (...a: unknown[]) =>
    liveListingHasBasenameMock(...(a as [string, string])),
  // The decisive containment test. Default UNKNOWN (only local config could answer),
  // so these tests exercise the listing-based fallback.
  isUnderLiveModelRoots: (...a: unknown[]) => isUnderLiveModelRootsMock(...(a as [string])),
  // The models root the connected server reads NOW — compared against the root a
  // verdict was made against, so a replaced server invalidates a stale positive.
  currentLiveModelsRoot: async (): Promise<string | undefined> => currentLiveRootMock(),
  // Faithful mirror of the real managerModelDestination (pure logic) so the
  // remote-model path resolves a Manager-valid { type, save_path }.
  managerModelDestination: (category: string, relPath?: string) => {
    const map: Record<string, string> = {
      checkpoints: "checkpoints",
      loras: "lora",
      vae: "vae",
      upscale_models: "upscale",
      controlnet: "controlnet",
      embeddings: "embeddings",
      clip: "clip",
      diffusion_models: "diffusion_model",
      gligen: "gligen",
      text_encoders: "text_encoders",
      unet: "unet",
    };
    const type = map[category] ?? category;
    if (relPath && relPath !== category) return { type, save_path: relPath };
    if (map[category]) return { type, save_path: "default" };
    return { type, save_path: category };
  },
}));

vi.mock("../../services/workspace-env.js", () => ({
  getSavedDefaultWorkspaceSync: (...a: unknown[]) => savedWorkspaceMock(...(a as [])),
  resolveLiveComfyUIBase: (...a: unknown[]) => liveComfyBaseMock(...(a as [])),
  resolveEffectiveComfyUICodeBaseLive: (...a: unknown[]) =>
    effectiveCodeBaseLiveMock(...(a as [])),
  resolveEffectiveComfyUIBaseLive: (...a: unknown[]) =>
    effectiveBaseLiveMock(...(a as [])),
  resolveCustomNodesScanBaseLiveStrict: (...a: unknown[]) =>
    effectiveBaseLiveMock(...(a as [])),
  getLiveServerSnapshot: async () => ({ reachable: true }),
  // Mirrors the real resolver enough for the pip tests: an install-root python.
  resolveRootInterpreter: (root: string | undefined) =>
    root ? `${root}/python` : "python",
  resolveInstallInterpreter: (...a: unknown[]) =>
    installInterpreterMock(...(a as [string | undefined])),
}));

// resolveLocalModelPath now roots local_path validation at the SAME live write
// dir the downloader uses (resolveModelsDir), not <COMFYUI_PATH>/models (#490).
// Back it with the fake install's models dir so the containment/symlink guards
// run against the exact root the tests build their symlink fixtures under.
const modelsDirMock = vi.hoisted(() =>
  vi.fn(async () => "/fake/ComfyUI/models" as string),
);
vi.mock("../../services/output-dir.js", () => ({
  resolveModelsDir: (...a: unknown[]) => modelsDirMock(...(a as [])),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyManifest,
  loadManifestFile,
} from "../../services/manifest.js";
import {
  clearManifestPartialLeftover,
  getManifestPartialLeftover,
} from "../../services/manifest-partial.js";

beforeEach(() => {
  clearManifestPartialLeftover();
  mockConfig.comfyuiPath = "/fake/ComfyUI";
  mockConfig.comfyuiCodePath = undefined;
  mockConfig.remote = undefined;
  readFileMock.mockReset();
  statMock.mockReset().mockRejectedValue(new Error("missing"));
  mkdirMock.mockReset().mockResolvedValue(undefined);
  realpathMock.mockReset().mockImplementation((path: string) => Promise.resolve(path));
  lstatMock.mockReset().mockRejectedValue(new Error("missing"));
  existsSyncMock.mockReset().mockReturnValue(false);
  execFileSyncMock.mockReset().mockReturnValue("ok");
  installCustomNodeMock.mockReset().mockResolvedValue({ message: "installed node" });
  installModelViaManagerMock
    .mockReset()
    .mockResolvedValue({ mechanism: "manager-http", message: "queued model" });
  listInstalledNodesMock.mockReset().mockResolvedValue([]);
  downloadModelMock.mockReset().mockResolvedValue("/fake/ComfyUI/models/checkpoints/m.safetensors");
  // Default: the model is found in NO root (multi-root resolver rejects, HTTP
  // listing is empty). Individual tests override to simulate an existing model.
  resolveExistingModelFileMock.mockReset().mockRejectedValue(new Error("not found"));
  listLocalModelsMock.mockReset().mockResolvedValue([]);
  savedWorkspaceMock.mockReset().mockReturnValue(undefined);
  liveComfyBaseMock.mockReset().mockResolvedValue(undefined);
  effectiveCodeBaseLiveMock
    .mockReset()
    .mockImplementation(async () => mockConfig.comfyuiCodePath ?? mockConfig.comfyuiPath);
  effectiveBaseLiveMock
    .mockReset()
    .mockImplementation(
      async () =>
        mockConfig.comfyuiPath ?? savedWorkspaceMock() ?? (await liveComfyBaseMock()),
    );
  installInterpreterMock.mockReset().mockImplementation(
    async (root: string | undefined) => ({
      python: root ? `${root}/python` : "python",
      source: "launched",
      reason: "test interpreter",
    }),
  );
  modelsDirMock.mockReset().mockResolvedValue("/fake/ComfyUI/models");
  shouldDispatchToManagerMock
    .mockReset()
    .mockImplementation(async () => mockConfig.remote ?? !mockConfig.comfyuiPath);
  verifyManagerVisibilityMock
    .mockReset()
    .mockResolvedValue({ visibility: "unknown" as const, note: "not asked" });
});

describe("loadManifestFile", () => {
  it("parses JSON manifests", async () => {
    statMock.mockResolvedValueOnce({ size: 128 });
    readFileMock.mockResolvedValueOnce(JSON.stringify({
      pip: ["numpy"],
      custom_nodes: ["comfyui-impact-pack"],
    }));

    await expect(loadManifestFile("/tmp/manifest.json")).resolves.toMatchObject({
      pip: ["numpy"],
      custom_nodes: ["comfyui-impact-pack"],
      apt: [],
      models: [],
    });
  });

  it("parses YAML manifests", async () => {
    statMock.mockResolvedValueOnce({ size: 128 });
    readFileMock.mockResolvedValueOnce(
      [
        "apt:",
        "  - ffmpeg",
        "models:",
        "  - url: https://example.com/model.safetensors",
        "    model_type: loras",
      ].join("\n"),
    );

    await expect(loadManifestFile("/tmp/manifest.yaml")).resolves.toMatchObject({
      apt: ["ffmpeg"],
      models: [{ url: "https://example.com/model.safetensors", model_type: "loras" }],
    });
  });

  it("rejects oversized manifest files before reading", async () => {
    statMock.mockResolvedValueOnce({ size: 1024 * 1024 + 1 });

    await expect(loadManifestFile("/tmp/manifest.yaml")).rejects.toThrow(/too large/i);
    expect(readFileMock).not.toHaveBeenCalled();
  });
});

describe("applyManifest", () => {
  it("skips apt entries and already-detected custom nodes/models", async () => {
    listInstalledNodesMock.mockResolvedValueOnce([
      { module: "ComfyUI-Impact-Pack", cnrId: "comfyui-impact-pack", enabled: true },
    ]);
    statMock.mockResolvedValueOnce({ isFile: () => true });

    const result = await applyManifest({
      manifest: {
        apt: ["ffmpeg"],
        custom_nodes: ["comfyui-impact-pack"],
        models: [
          {
            url: "https://example.com/model.safetensors",
            model_type: "checkpoints",
            filename: "model.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 3, failed: 0, pending: 0 });
    expect(result.results.map((r) => r.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(installCustomNodeMock).not.toHaveBeenCalled();
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("continues after individual failures and reports each item", async () => {
    installCustomNodeMock.mockRejectedValueOnce(new Error("node failed"));
    downloadModelMock.mockResolvedValueOnce("/fake/ComfyUI/models/loras/model.safetensors");

    const result = await applyManifest({
      manifest: {
        custom_nodes: ["bad-node"],
        models: [
          {
            url: "https://example.com/model.safetensors",
            local_path: "loras/model.safetensors",
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 1, pending: 0 });
    expect(result.results).toMatchObject([
      { action: "custom_node", item: "bad-node", status: "failed" },
      { action: "model", item: "loras/model.safetensors", status: "applied" },
    ]);
    // apply_manifest now routes local downloads through the background job
    // registry (#362), which calls downloadModel with an optional auth arg.
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/model.safetensors",
      "loras",
      "model.safetensors",
      undefined,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
      expect.any(Function), // onDownloadRoute callback — records the download-only network route
      expect.any(Function), // onStagedPartialPath callback — persists the writer's cache identity (#2356)
      undefined, // optional explicit model root for multi-root installs (#2499)
    );
  });

  it("reports a custom_node as FAILED when Manager queued it but it isn't present afterward", async () => {
    // ComfyUI-Manager drains the queue "done" for a git URL not in its registry
    // even though nothing was cloned. installCustomNode resolves, but the
    // post-install verification (listInstalledNodes) must catch the no-op.
    installCustomNodeMock.mockResolvedValueOnce({
      message: "Queued + installed via ComfyUI-Manager.",
    });
    listInstalledNodesMock.mockResolvedValue([]); // never shows up — clone no-op'd

    const result = await applyManifest({
      manifest: {
        custom_nodes: ["https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer"],
        models: [],
      },
    });

    expect(result.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({
      action: "custom_node",
      status: "failed",
    });
    expect(result.results[0].message).toMatch(/not present afterward/i);
  });

  it("reports a custom_node as APPLIED only after verifying it's actually installed", async () => {
    installCustomNodeMock.mockResolvedValueOnce({
      message: "Queued + installed via ComfyUI-Manager.",
    });
    listInstalledNodesMock
      .mockResolvedValueOnce([]) // pre-install skip-check: not yet installed
      .mockResolvedValueOnce([
        { module: "comfyui-krea2t-enhancer", enabled: true },
      ]); // verification: the freshly-cloned node now shows on disk

    const result = await applyManifest({
      manifest: {
        custom_nodes: ["https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer"],
        models: [],
      },
    });

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(result.results[0]).toMatchObject({
      action: "custom_node",
      status: "applied",
    });
  });

  it("refuses a panel manifest when Manager and local loopback targets can differ", async () => {
    // config.comfyuiPath can point at local instance A while the current Manager
    // client targets B. A pre/post panel scan of A cannot validate a mutation of
    // B, even if Manager's installed list says the panel is present there.
    mockConfig.comfyuiPath = "/fake/ComfyUI-A";
    listInstalledNodesMock.mockResolvedValueOnce([
      { module: "comfyui-agent-panel", cnrId: "comfyui-agent-panel", enabled: true },
    ]);

    const result = await applyManifest({
      manifest: { custom_nodes: ["comfyui-agent-panel"] },
    });

    expect(installCustomNodeMock).not.toHaveBeenCalled();
    expect(result.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(result.results[0]?.message).toMatch(/cannot prove.*same instance/i);
  });

  it("skips a model already present in an ALTERNATE model root (extra_model_paths)", async () => {
    // The computed target under <COMFYUI_PATH>/models does NOT exist (statMock
    // rejects by default), but the user already has the file under an extra root
    // declared in extra_model_paths.yaml (e.g. another drive). The multi-root
    // resolver finds it, so we must skip — not re-download.
    const altPath = "E:/AImodels/checkpoints/big.safetensors";
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: altPath,
      root: "E:/AImodels",
      info: { isFile: () => true },
    });

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 1, failed: 0, pending: 0 });
    expect(result.results).toMatchObject([
      { action: "model", status: "skipped", item: "big.safetensors" },
    ]);
    expect(result.results[0].message).toContain(altPath);
    expect(resolveExistingModelFileMock).toHaveBeenCalledWith(
      "checkpoints/big.safetensors",
    );
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  // #369 — "already exists" is a claim about a path the RUNNING server may not read.
  // #1298 — and when that claim is DISPROVEN, the file is irrelevant, not fatal.
  //
  // #369 changed a false SKIP into a FAIL, which was right about skipping: a
  // stale same-named file must never satisfy the manifest. But failing vetoes a
  // download that has nothing wrong with it — the live root resolved correctly,
  // and the old remedy told the user to repoint COMFYUI_PATH when nothing was
  // misconfigured. #369's real requirement survives: the item is satisfied only
  // if the DOWNLOAD succeeds, never by a file existing somewhere.
  it("DOWNLOADS past an existing file that is not in any tree the connected ComfyUI reads", async () => {
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/stale/models/checkpoints/big.safetensors",
      root: "C:/stale/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    // The stale copy must NOT block the download...
    expect(result.summary.failed).toBe(0);
    expect(downloadModelMock).toHaveBeenCalled();
    // ...and must still be NAMED, because a same-named file in another install
    // is genuinely confusing later. #369 was right that the user should hear
    // about it; it is a note on a success, not a veto.
    const msg = result.results[0].message ?? "";
    expect(msg).toMatch(/same-named file also exists/);
    expect(msg).toMatch(/C:\/stale\/models/);
    expect(msg).toMatch(/was ignored/);
    // Re-pinned from the #369 tests this replaced: that clause IS the diagnostic
    // half #369 wanted kept, and after the rewrite nothing held it — stripping it
    // killed zero tests.
    expect(msg).toMatch(/NOT in any directory/);
  });

  it("does not accuse LATER items of a stale copy found for an earlier one", async () => {
    // Surviving mutation: hoisting `let staleOutsideLiveRoots` above the per-item
    // loop passes every other test, because both stale tests use a single-model
    // manifest. Manifests are multi-model by definition, so the mutant ships a
    // false accusation on every subsequent asset.
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/stale/models/checkpoints/big.safetensors",
      root: "C:/stale/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/big.safetensors", model_type: "checkpoints", filename: "big.safetensors" },
          { url: "https://example.com/clean.safetensors", model_type: "loras", filename: "clean.safetensors" },
        ],
      },
    });

    const second = result.results.find((r) => String(r.item).includes("clean")) ?? result.results[1];
    expect(second?.message ?? "").not.toMatch(/same-named file also exists/);
  });

  // #1298 — was "FAILS"; containment proving the file irrelevant now lets the
  // download proceed. The containment CHECK is unchanged and still load-bearing:
  // it is what distinguishes this from a live copy (which still skips) and from
  // an unverifiable one (which is still pending).
  it("DOWNLOADS past a same-named existing file OUTSIDE every live model root (codex gate r5)", async () => {
    // C:\Stale\...\big.safetensors exists locally AND the live server has its own
    // D:\Live\...\big.safetensors, so a name-only listing check would call it a skip.
    // The containment test is decisive and overrides it.
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/Stale/models/checkpoints/big.safetensors",
      root: "C:/Stale/models",
      info: { isFile: () => true },
    });
    // Decisive: the containment answer short-circuits the name-only listing check
    // (which would have said "yes, the server lists big.safetensors" — its own copy).
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary.failed).toBe(0);
    // Re-pinned: the old test asserted downloadModel was NOT called, so the new
    // contract needs the mirror assertion or "downloads past it" is unheld.
    expect(downloadModelMock).toHaveBeenCalled();
    expect(result.results[0].message).toMatch(/same-named file also exists/);
    expect(result.results[0].message).toMatch(/NOT in any directory/);
  });

  it("FAILS a contained file the live server does not serve at all (container/host collision; codex gate r15)", async () => {
    // The container reports --models-directory /models; the HOST happens to have its
    // own /models with this file. Containment passes, but the running server does not
    // list the name anywhere in the category — so it is NOT installed for it.
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/models/checkpoints/big.safetensors",
      root: "C:/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: true });
    liveListingHasBasenameMock.mockResolvedValueOnce(false);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toMatchObject({ skipped: 0, failed: 1 });
    expect(result.results[0].message).toMatch(/does not list/);
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  // #1587 — this block was previously pinned the other way ("reports PENDING
  // (never skipped) ... even if the server lists the NAME"). It is deliberately
  // re-pinned. The old fixture's own premise is that the LIVE tree holds the file,
  // and it then asserted the manifest report it as unsatisfied: `pending`, and
  // therefore `success:false`, for a model the connected server demonstrably has.
  //
  // The verdict came from `isUnderLiveModelRoots`, a filesystem containment test
  // against a root the server never named — a source that does not look at
  // /models at all. It cannot see a server-visible model, so it can only ever
  // answer "unknown" here, and the message it produced asserted a specific and
  // often false reason ("its install root could only be inferred from local
  // configuration") — ComfyUI Desktop's OS-process-observed root lands in the same
  // bucket.
  //
  // #369 is unaffected: its failure is a stale same-named file satisfying the
  // manifest while the live server has NEVER seen it, and that case is the
  // `listed === false` test below, which still reports pending and still downloads.
  it("#1587 SKIPS a model the connected server already serves when containment is unknown", async () => {
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/comfy/models/checkpoints/big.safetensors",
      root: "C:/comfy/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: undefined });
    liveListingHasBasenameMock.mockResolvedValueOnce(true);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toMatchObject({ skipped: 1, failed: 0, pending: 0 });
    expect(result.success).toBe(true);
    expect(downloadModelMock).not.toHaveBeenCalled();
    expect(result.results[0].message).toMatch(/already serves/);
    // What was NOT established is still stated — the fix moves the uncertainty
    // into a note, it does not delete it.
    expect(result.results[0].message).toMatch(/NOT confirmed that the copy at/);
    // ...and the claim that was never the code's to make is gone.
    expect(result.results[0].message).not.toMatch(/inferred from local configuration/);
  });

  it("#1587 still reports PENDING when the server does NOT list it (#369's shape, unchanged)", async () => {
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/stale/models/checkpoints/big.safetensors",
      root: "C:/stale/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: undefined });
    liveListingHasBasenameMock.mockResolvedValueOnce(false);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toMatchObject({ skipped: 0, failed: 0, pending: 1 });
    expect(result.results[0].message).toMatch(/does NOT list/);
  });

  it("#1587 still reports PENDING when the server could not be ASKED (listing unavailable)", async () => {
    // A failed observation and an observed negative must not collapse into the
    // same answer, and neither may become a confirmation.
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/comfy/models/checkpoints/big.safetensors",
      root: "C:/comfy/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: undefined });
    liveListingHasBasenameMock.mockResolvedValueOnce(undefined);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toMatchObject({ skipped: 0, failed: 0, pending: 1 });
    expect(result.results[0].message).toMatch(/could not be asked/);
  });

  it("#1587 a NESTED target needs the EXACT category-relative entry, not a basename anywhere", async () => {
    // `loras/Krea2/x.safetensors` is loaded by that exact string. A same-named
    // file loose in loras/ does not satisfy it, so the basename probe must not be
    // the one consulted here.
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/comfy/models/loras/Krea2/x.safetensors",
      root: "C:/comfy/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: undefined });
    liveListingHasEntryMock.mockResolvedValueOnce(false);
    liveListingHasBasenameMock.mockResolvedValueOnce(true); // must be IGNORED here

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/x.safetensors",
            local_path: "loras/Krea2/x.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toMatchObject({ skipped: 0, pending: 1 });
    expect(result.results[0].message).toMatch(/does NOT list/);
  });

  it("#1587 a NESTED target IS skipped when the server lists that exact entry", async () => {
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/comfy/models/loras/Krea2/x.safetensors",
      root: "C:/comfy/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: undefined });
    liveListingHasEntryMock.mockResolvedValueOnce(true);

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/x.safetensors", local_path: "loras/Krea2/x.safetensors" },
        ],
      },
    });

    expect(result.summary).toMatchObject({ skipped: 1, pending: 0 });
    expect(result.success).toBe(true);
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("skips a CATEGORY-ROOT target found by filename anywhere in the served category", async () => {
    // model_type: checkpoints (category-root target). Not at the computed path
    // nor the exact relative path in any root, but ComfyUI serves it from a
    // nested subfolder within the category. Basename-anywhere match → skip.
    listLocalModelsMock.mockResolvedValueOnce([
      { name: "sdxl/big.safetensors", path: "checkpoints/sdxl/big.safetensors", type: "checkpoints" },
    ]);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 1, failed: 0, pending: 0 });
    expect(result.results[0].status).toBe("skipped");
    expect(listLocalModelsMock).toHaveBeenCalledWith("checkpoints");
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("skips a NESTED local_path model present at the exact category-relative path", async () => {
    // Nested target asks for checkpoints/foo/model.safetensors and ComfyUI
    // serves exactly that (foo/model.safetensors within checkpoints) → skip.
    listLocalModelsMock.mockResolvedValueOnce([
      { name: "foo/model.safetensors", path: "checkpoints/foo/model.safetensors", type: "checkpoints" },
    ]);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/model.safetensors",
            local_path: "checkpoints/foo/model.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 1, failed: 0, pending: 0 });
    expect(result.results[0].status).toBe("skipped");
    expect(listLocalModelsMock).toHaveBeenCalledWith("checkpoints");
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("downloads a NESTED local_path when only a same-named file in a DIFFERENT subfolder exists", async () => {
    // Manifest wants checkpoints/foo/model.safetensors but only
    // checkpoints/bar/model.safetensors exists. A basename match would
    // false-skip and leave the requested file absent — must still download.
    listLocalModelsMock.mockResolvedValueOnce([
      { name: "bar/model.safetensors", path: "checkpoints/bar/model.safetensors", type: "checkpoints" },
    ]);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/model.safetensors",
            local_path: "checkpoints/foo/model.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0, pending: 0 });
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/model.safetensors",
      expect.any(String),
      "model.safetensors",
      undefined,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
      expect.any(Function), // onDownloadRoute callback — records the download-only network route
      expect.any(Function), // onStagedPartialPath callback — persists the writer's cache identity (#2356)
      undefined, // optional explicit model root for multi-root installs (#2499)
    );
    expect(String(downloadModelMock.mock.calls[0]?.[1]).replaceAll("\\", "/")).toBe(
      "checkpoints/foo",
    );
  });

  it("downloads when the model exists in NO root (multi-root check graceful miss)", async () => {
    // resolveExistingModelFile rejects and listLocalModels is empty (defaults):
    // the model is genuinely absent everywhere, so we must download it.
    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/new.safetensors",
            model_type: "loras",
            filename: "new.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0, pending: 0 });
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/new.safetensors",
      "loras",
      "new.safetensors",
      undefined,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
      expect.any(Function), // onDownloadRoute callback — records the download-only network route
      expect.any(Function), // onStagedPartialPath callback — persists the writer's cache identity (#2356)
      undefined, // optional explicit model root for multi-root installs (#2499)
    );
  });

  it("installs pip entries via uv when available", async () => {
    execFileSyncMock.mockReturnValue("ok");

    const result = await applyManifest({
      manifest: { pip: ["torch==2.4.0"] },
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0, pending: 0 });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      detectCmd,
      detectArgs,
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "uv",
      ["pip", "install", "--python", expect.stringMatching(/python/), "torch==2.4.0"],
      expect.objectContaining({ cwd: COMFY }),
    );
  });

  it("routes manifest pip to the serving code root and custom-node fallbacks to the data/base root", async () => {
    const dataRoot = "/shared/ComfyUI-data";
    const codeRoot = "/runtime/ComfyUI-code";
    mockConfig.comfyuiPath = dataRoot;
    mockConfig.comfyuiCodePath = codeRoot;
    effectiveCodeBaseLiveMock.mockResolvedValue(codeRoot);
    effectiveBaseLiveMock.mockResolvedValue(dataRoot);
    listInstalledNodesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ module: "split-root-pack", enabled: true }]);

    const result = await applyManifest({
      manifest: {
        pip: ["numpy"],
        custom_nodes: ["split-root-pack"],
      },
    });

    expect(result.summary).toEqual({ applied: 2, skipped: 0, failed: 0, pending: 0 });
    expect(installInterpreterMock).toHaveBeenCalledWith(codeRoot);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "uv",
      ["pip", "install", "--python", `${codeRoot}/python`, "numpy"],
      expect.objectContaining({ cwd: codeRoot }),
    );
    expect(installCustomNodeMock).toHaveBeenCalledWith(expect.objectContaining({
      id: "split-root-pack",
      comfyuiPath: dataRoot,
      managerBase: "http://127.0.0.1:8188",
      targetGeneration: 0,
    }));
    expect(installCustomNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ onLocalFallback: expect.any(Function) }),
    );
    expect(installInterpreterMock).not.toHaveBeenCalledWith(dataRoot);
  });

  it("falls back to python -m pip when uv is unavailable", async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      // Make `uv` detection fail on both platforms: POSIX probes with
      // `uv --version`; Windows probes with `where uv`.
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      return "ok";
    });

    await applyManifest({ manifest: { pip: ["numpy"] } });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/python/),
      ["-m", "pip", "install", "numpy"],
      expect.objectContaining({ cwd: COMFY }),
    );
  });

  it("falls back to python -m pip when uv rejects a non-venv interpreter (#377)", async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      // uv is detected (probe succeeds), but `uv pip install` fails because the
      // ComfyUI interpreter is a system Python, not a venv.
      if (cmd === "uv" && args[0] === "pip") {
        throw Object.assign(new Error("uv failed"), {
          stderr:
            "error: No virtual environment found for executable name python; " +
            "run `uv venv` to create an environment, or pass `--system`",
        });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["imageio-ffmpeg"] } });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0, pending: 0 });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/python/),
      ["-m", "pip", "install", "imageio-ffmpeg"],
      expect.objectContaining({ cwd: COMFY }),
    );
  });

  // #1508 — the interpreter declares itself EXTERNALLY MANAGED (PEP 668), so its
  // own pip refuses by design. Stability Matrix's uv-managed CPython does exactly
  // this. The refusal text below is the reporter's, verbatim.
  //
  // TWO routes reach it, which is why there are three tests rather than one:
  // uv-absent goes straight to bare pip (the reporter's route, because Stability
  // Matrix keeps uv inside its own directory rather than on PATH), and the #377
  // non-venv fallback lands on bare pip too — so a managed interpreter can hit
  // the same wall one step later, with uv's unrelated complaint on top of it.
  const PEP668 =
    "error: externally-managed-environment\n" +
    "This Python installation is managed by uv and should not be modified.";

  it("refuses with an actionable message when pip is EXTERNALLY MANAGED, uv absent (#1508)", async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      if (args[0] === "-m" && args[1] === "pip") {
        throw Object.assign(new Error("pip failed"), { stderr: PEP668 });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["imageio-ffmpeg"] } });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([{ action: "pip", status: "failed" }]);
    const msg = result.results[0].message ?? "";
    // Names the CAUSE as a deliberate guard, not a broken interpreter...
    expect(msg).toMatch(/EXTERNALLY MANAGED/);
    expect(msg).toMatch(/PEP 668/);
    expect(msg).toMatch(/deliberate guard, not a broken interpreter/);
    // ...and routes out that ACTUALLY WORK. An earlier draft of this message
    // recommended `uv pip install --python <interp>`; measured against a real
    // uv-managed CPython, uv refuses that too ("the interpreter ... is externally
    // managed", hint: `uv venv`). A remedy that cannot work is worse than none —
    // it reads as the answer and costs the reader the time to disprove it. So the
    // message now says uv is NOT a way around this, and points at a venv.
    expect(msg).toMatch(/uv does NOT get around this/);
    expect(msg).toMatch(/uv venv/);
    expect(msg).toMatch(/COMFYUI_PYTHON/);
    // The wrong remedy must not creep back as a bare suggestion.
    expect(msg).not.toMatch(/^\s*-\s*.*uv pip install --python/m);
    // The refusal must SAY it declined to force it, and why — otherwise the
    // obvious next move is the one that quietly breaks their install later.
    expect(msg).toMatch(/break-system-packages/);
    expect(msg).toMatch(/may later reset/);
    // It must NOT have actually forced it.
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["--break-system-packages"]),
      expect.anything(),
    );
  });

  it("uses the actionable refusal when UV ITSELF reports PEP 668 (#1508)", async () => {
    // The third route, and the one a mutation caught me not covering: uv is
    // present and `uv pip install --python <interp>` is itself refused, because
    // uv will not modify a managed environment either. Without the check that
    // runs BEFORE the #377 non-venv branch, this falls through to a bare rethrow
    // and the caller gets uv's raw output with no route out of it.
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "uv" && args[0] === "pip") {
        throw Object.assign(new Error("uv failed"), { stderr: PEP668 });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["imageio-ffmpeg"] } });

    expect(result.success).toBe(false);
    const msg = result.results[0].message ?? "";
    expect(msg).toMatch(/EXTERNALLY MANAGED/);
    expect(msg).toMatch(/uv does NOT get around this/);
    // It must NOT have quietly retried through bare pip after uv refused — that
    // walks into the same wall and buries the reason under a second failure.
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/python/),
      ["-m", "pip", "install", "imageio-ffmpeg"],
      expect.anything(),
    );
  });

  it("does not blame uv's non-venv error when the FALLBACK hits PEP 668 (#1508)", async () => {
    // uv is present, rejects the non-venv interpreter (#377), and the bare-pip
    // fallback is then refused as externally managed. Reporting uv's complaint
    // here would send the reader to create a venv when the real obstacle is the
    // managed environment.
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "uv" && args[0] === "pip") {
        throw Object.assign(new Error("uv failed"), {
          stderr: "error: No virtual environment found for executable name python",
        });
      }
      if (args[0] === "-m" && args[1] === "pip") {
        throw Object.assign(new Error("pip failed"), { stderr: PEP668 });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["imageio-ffmpeg"] } });

    expect(result.success).toBe(false);
    const msg = result.results[0].message ?? "";
    expect(msg).toMatch(/EXTERNALLY MANAGED/);
    expect(msg).not.toMatch(/No virtual environment found/);
  });

  it("keys on the PEP 668 error id, not uv's distributor wording (#1508)", async () => {
    // The second line comes from the distributor's EXTERNALLY-MANAGED file, so it
    // reads differently on Debian and Homebrew. Matching only uv's sentence would
    // have fixed this one reporter and nobody else.
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      if (args[0] === "-m" && args[1] === "pip") {
        throw Object.assign(new Error("pip failed"), {
          stderr:
            "error: externally-managed-environment\n" +
            "× This environment is externally managed\n" +
            "╰─> To install Python packages system-wide, try apt install python3-xyz.",
        });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["imageio-ffmpeg"] } });

    expect(result.success).toBe(false);
    expect(result.results[0].message ?? "").toMatch(/EXTERNALLY MANAGED/);
  });

  it("does NOT claim PEP 668 for prose that merely says 'externally managed' (codex P2)", async () => {
    // The detector originally matched the bare phrase anywhere in the output. Build
    // and dependency errors do say it in passing, and rewriting one of those as the
    // managed-environment story discards the real cause AND hands over a remedy
    // that does not apply — a strictly worse failure than the raw error.
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      if (args[0] === "-m" && args[1] === "pip") {
        throw Object.assign(new Error("build failed"), {
          stderr:
            "note: This package vendors a library whose headers are externally managed by the " +
            "distribution; see BUILD.md.\nerror: command 'cl.exe' failed with exit code 2",
        });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["somepkg"] } });

    expect(result.success).toBe(false);
    const msg = result.results[0].message ?? "";
    expect(msg).not.toMatch(/EXTERNALLY MANAGED \(PEP 668\)/);
    expect(msg).not.toMatch(/uv venv/);
    // The real cause survives.
    expect(msg).toMatch(/cl\.exe|build failed/);
  });

  it("carries the installer's OWN output into the refusal (codex P2)", async () => {
    // The refusal REPLACES the underlying error and apply_manifest reports only
    // `err.message` per item, so anything the tool said that this message does not
    // anticipate would be lost silently. An earlier draft even told the reader the
    // output was "above" when nothing had been printed.
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      if (args[0] === "-m" && args[1] === "pip") {
        throw Object.assign(new Error("pip failed"), {
          stderr: `${PEP668}\nhint: See PEP 668 for the detailed specification.`,
        });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["imageio-ffmpeg"] } });
    const msg = result.results[0].message ?? "";

    expect(msg).toMatch(/This Python installation is managed by uv/);
    expect(msg).toMatch(/hint: See PEP 668/);
    // ...and the actionable part is still there, not drowned by it.
    expect(msg).toMatch(/EXTERNALLY MANAGED/);
  });

  it("does not fire on the PEP 668 token appearing MID-LINE (codex P2)", async () => {
    // The token is anchored to the start of a line because that is where pip
    // prints it. Unanchored, any output merely CONTAINING it — a path, a package
    // name, a vendored log — would be rewritten as this failure and lose its own
    // cause. That is the same defect as the prose case, one token narrower.
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      if (args[0] === "-m" && args[1] === "pip") {
        throw Object.assign(new Error("build failed"), {
          stderr:
            "  Downloading from /var/cache/externally-managed-environment/wheels/x.whl\n" +
            "error: metadata generation failed",
        });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["somepkg"] } });

    const msg = result.results[0].message ?? "";
    expect(msg).not.toMatch(/EXTERNALLY MANAGED \(PEP 668\)/);
    expect(msg).toMatch(/metadata generation failed|build failed/);
  });

  it("never echoes the command line — a direct-URL spec can carry credentials", async () => {
    // Node builds execFileSync's Error.message as `Command failed: <whole argv>`,
    // so it embeds the package spec. A pip spec may legitimately be a direct URL,
    // and a direct URL may carry credentials — that entry passes
    // validatePipPackageSpec, which only rejects options, control chars and
    // whitespace. Carrying the message into a user-facing refusal would copy the
    // token into it. Detection may still read the message; only what is SHOWN is
    // narrowed.
    const SPEC = "https://ci:s3cr3t-token@example.invalid/pkg-1.0-py3-none-any.whl";
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      if (args[0] === "-m" && args[1] === "pip") {
        throw Object.assign(new Error(`Command failed: python -m pip install ${SPEC}`), {
          stderr: PEP668,
        });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: [SPEC] } });
    const msg = result.results[0].message ?? "";

    expect(msg).toMatch(/EXTERNALLY MANAGED/);
    expect(msg).not.toMatch(/s3cr3t-token/);
    expect(msg).not.toMatch(/Command failed:/);
    // THE WHOLE RESULT, not just the message. `item` echoes the manifest entry
    // verbatim, so asserting only on `message` claimed more than it checked —
    // the structured result is what travels into transcripts and logs.
    expect(JSON.stringify(result)).not.toMatch(/s3cr3t-token/);
    // ...and the entry is still identifiable by host and path.
    expect(result.results[0].item).toMatch(/example\.invalid\/pkg-1\.0/);
  });

  it("redacts the spec on an ORDINARY failure too, not just the PEP 668 one", async () => {
    // The non-PEP-668 path rethrows raw by design — right for diagnosis — and the
    // caller reports err.message, which Node builds as `Command failed: <argv>`.
    // So every pip failure that is NOT this issue's case was still echoing the
    // spec. Closed at report(), the one place every item passes through, rather
    // than at each call site.
    const SPEC = "https://ci:s3cr3t-token@example.invalid/pkg-1.0.whl";
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      if (args[0] === "-m" && args[1] === "pip") {
        throw new Error(`Command failed: python -m pip install ${SPEC}\nERROR: no matching dist`);
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: [SPEC] } });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/s3cr3t-token/);
    // The real cause still survives — redaction must not cost the diagnosis.
    expect(result.results[0].message ?? "").toMatch(/no matching dist/);
  });

  it("redacts a password containing '@' and one sitting past the output clip", async () => {
    // Two ways a redaction can look right and not be (codex P1):
    //   - the pattern stopping at the FIRST '@' when the password contains one;
    //   - clipping the carried output BEFORE redacting, severing the '@' the
    //     pattern anchors on so a secret near the cut survives.
    const SPEC = "https://ci:alpha@beta-s3cr3t@example.invalid/pkg-1.0.whl";
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      if (args[0] === "-m" && args[1] === "pip") {
        throw Object.assign(new Error("pip failed"), {
          // Filler pushes the credential past the 1200-char clip boundary.
          stderr: `${PEP668}\n${"x".repeat(1250)}\nLooking in: ${SPEC}`,
        });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: [SPEC] } });

    expect(JSON.stringify(result)).not.toMatch(/s3cr3t/);
    expect(JSON.stringify(result)).not.toMatch(/alpha@beta/);
  });

  it("still surfaces an ORDINARY pip failure as itself (#1508)", async () => {
    // The guard must not swallow every pip error into a managed-environment
    // story — a missing package is a different problem with a different answer.
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      if (args[0] === "-m" && args[1] === "pip") {
        throw Object.assign(new Error("pip failed"), {
          stderr: "ERROR: Could not find a version that satisfies the requirement nope",
        });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["nope"] } });

    expect(result.success).toBe(false);
    const msg = result.results[0].message ?? "";
    expect(msg).not.toMatch(/EXTERNALLY MANAGED/);
    expect(msg).toMatch(/Could not find a version|pip failed/);
  });

  it("reports pip as failed — never applied — when the server interpreter cannot be verified (#651)", async () => {
    installInterpreterMock.mockResolvedValue({
      source: "undetermined",
      reason:
        "Cannot verify the running server's interpreter: no local ComfyUI is reachable. " +
        "Start ComfyUI or connect to it first.",
    });

    const result = await applyManifest({ manifest: { pip: ["omegaconf"] } });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([
      { action: "pip", item: "omegaconf", status: "failed" },
    ]);
    expect(result.results[0].message).toContain("Cannot verify the running server's interpreter");
    // No pip/uv subprocess ran for the refused package.
    expect(
      execFileSyncMock.mock.calls.some(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("omegaconf"),
      ),
    ).toBe(false);
  });

  it("adopts the saved default workspace as the local path when COMFYUI_PATH is unset (#390)", async () => {
    mockConfig.comfyuiPath = undefined;
    mockConfig.remote = false; // local loopback target, just no COMFYUI_PATH
    savedWorkspaceMock.mockReturnValue("/saved/ComfyUI");
    shouldDispatchToManagerMock.mockResolvedValueOnce(false);
    existsSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return (
        s.includes("saved") &&
        (s.endsWith("ComfyUI") || s.endsWith("models") || s.endsWith("custom_nodes"))
      );
    });

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/m.safetensors", model_type: "loras", filename: "m.safetensors" },
        ],
      },
    });

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(downloadModelMock).toHaveBeenCalled();
    // Call-scoped: the adopted path must NOT persist process-wide — it is
    // restored so a later call re-reads/revalidates and other tabs aren't leaked.
    expect(mockConfig.comfyuiPath).toBeUndefined();
  });

  it("adopts the LIVE connected ComfyUI root when COMFYUI_PATH and saved default are both unset (#463)", async () => {
    // #463: sidebar panel connected to a live local ComfyUI, no COMFYUI_PATH and
    // no saved default. Without adoption the session is misclassified "no local
    // filesystem" and every model is skipped. Adopting the live root (from
    // /system_stats) gives a local FS target so the model downloads instead.
    mockConfig.comfyuiPath = undefined;
    mockConfig.remote = false; // local loopback target reached over the panel session
    savedWorkspaceMock.mockReturnValue(undefined);
    liveComfyBaseMock.mockResolvedValue("/live/ComfyUI");
    shouldDispatchToManagerMock.mockResolvedValueOnce(false);
    existsSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return (
        s.includes("live") &&
        (s.endsWith("ComfyUI") || s.endsWith("models") || s.endsWith("custom_nodes"))
      );
    });

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/m.safetensors", model_type: "loras", filename: "m.safetensors" },
        ],
      },
    });

    // Downloaded locally (NOT skipped as "no local filesystem").
    expect(result.summary).toMatchObject({ applied: 1, failed: 0, skipped: 0 });
    expect(downloadModelMock).toHaveBeenCalled();
    // Call-scoped: the adopted live path must NOT persist process-wide.
    expect(mockConfig.comfyuiPath).toBeUndefined();
  });

  it("uses the live models resolver when the generic data root is unavailable (#2089)", async () => {
    // A server may expose a usable models root through --models-directory (or the
    // live download resolver) without yielding a generic dataBase for custom_nodes.
    // The old manifest gate skipped the model before resolveLocalModelPath could
    // use that authoritative route.
    mockConfig.comfyuiPath = undefined;
    mockConfig.remote = false;
    savedWorkspaceMock.mockReturnValue(undefined);
    liveComfyBaseMock.mockResolvedValue(undefined);
    effectiveBaseLiveMock.mockResolvedValue(undefined);
    modelsDirMock.mockResolvedValue("/live/ComfyUI/models");
    shouldDispatchToManagerMock.mockResolvedValueOnce(false);

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/m.safetensors", model_type: "loras", filename: "m.safetensors" },
        ],
      },
    });

    expect(result.summary).toMatchObject({ applied: 1, failed: 0, skipped: 0 });
    expect(downloadModelMock).toHaveBeenCalled();
    expect(installModelViaManagerMock).not.toHaveBeenCalled();
    // The route was captured before local target resolution and threaded through
    // startDownloadJob; it must not re-read mutable connection state mid-call.
    expect(shouldDispatchToManagerMock).toHaveBeenCalledTimes(1);
  });

  it("uses Manager when a local reconnect has no resolvable models root (#2089)", async () => {
    mockConfig.comfyuiPath = undefined;
    mockConfig.remote = false;
    savedWorkspaceMock.mockReturnValue(undefined);
    liveComfyBaseMock.mockResolvedValue(undefined);
    effectiveBaseLiveMock.mockResolvedValue(undefined);
    modelsDirMock.mockRejectedValueOnce(
      new Error("The connected ComfyUI models directory could not be resolved"),
    );
    shouldDispatchToManagerMock.mockResolvedValueOnce(true);

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/m.safetensors", model_type: "loras", filename: "m.safetensors" },
        ],
      },
    });

    expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 1 });
    expect(result.results[0]?.message).toMatch(/ACCEPTED.*NOT verified/i);
    const managerRouteCall = downloadModelMock.mock.calls[0] as unknown[] | undefined;
    expect(managerRouteCall?.[1]).toBe("loras");
    expect(managerRouteCall?.[2]).toBe("m.safetensors");
    expect(managerRouteCall?.[4]).toBe(true);
  });

  it("does not let a configured data root suppress Manager routing for an unresolvable model root (#2089)", async () => {
    // COMFYUI_PATH can still resolve custom-node/pip operations while the live
    // server's explicit --models-directory is relative and lacks cwd. The model
    // route must follow download_model's Manager decision, not the data root.
    mockConfig.comfyuiPath = COMFY;
    mockConfig.remote = false;
    modelsDirMock.mockRejectedValueOnce(
      new Error("relative --models-directory has no reported working directory"),
    );
    shouldDispatchToManagerMock.mockResolvedValueOnce(true);

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/m.safetensors", model_type: "loras", filename: "m.safetensors" },
        ],
      },
    });

    expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 1 });
    const managerRouteCall = downloadModelMock.mock.calls[0] as unknown[] | undefined;
    expect(managerRouteCall?.[4]).toBe(true);
    expect(result.results[0]?.message).toMatch(/ACCEPTED.*NOT verified/i);
  });

  it("reports the local path-resolution reason when neither local models nor Manager is available (#2089)", async () => {
    mockConfig.comfyuiPath = undefined;
    mockConfig.remote = false;
    savedWorkspaceMock.mockReturnValue(undefined);
    liveComfyBaseMock.mockResolvedValue(undefined);
    effectiveBaseLiveMock.mockResolvedValue(undefined);
    modelsDirMock.mockRejectedValueOnce(
      new Error("relative --models-directory has no reported working directory"),
    );
    shouldDispatchToManagerMock.mockResolvedValueOnce(false);

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/m.safetensors", model_type: "loras", filename: "m.safetensors" },
        ],
      },
    });

    expect(result.summary).toMatchObject({ applied: 0, failed: 0, skipped: 1 });
    expect(result.results[0]?.message).toMatch(/could not resolve a local models directory/i);
    expect(result.results[0]?.message).toMatch(/relative --models-directory/i);
    expect(result.results[0]?.message).not.toMatch(/no local filesystem and no ComfyUI-Manager HTTP API/i);
  });

  it("reports a custom_node as PENDING (not failed) when the Manager queue is still installing at the budget (#489)", async () => {
    // A node install that outlives the wall-clock budget must be reported
    // "pending" (poll the Manager queue), never "failed" — the install keeps
    // running server-side — and every not-yet-started node is reported pending too.
    const prevBudget = process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
    process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = "40";
    // First node never settles (simulates the Manager queue still draining); the
    // budget timer must win and stop us blocking on the rest.
    installCustomNodeMock.mockReturnValueOnce(new Promise(() => {}));

    try {
      const result = await applyManifest({
        manifest: { custom_nodes: ["slow-pack", "next-pack"] },
      });

      expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 2 });
      expect(result.results[0]).toMatchObject({
        action: "custom_node",
        item: "slow-pack",
        status: "pending",
      });
      expect(result.results[0].message).toMatch(/still installing/i);
      // The second node is NOT started once the budget is spent — reported pending.
      expect(result.results[1]).toMatchObject({
        action: "custom_node",
        item: "next-pack",
        status: "pending",
      });
      expect(result.results[1].message).toMatch(/not started/i);
      expect(installCustomNodeMock).toHaveBeenCalledTimes(1);
      // Pending is not a FAILURE, but it is not a settled success either: an
      // unfinished apply must not report success (#369). `summary.failed` is the
      // hard-failure signal.
      expect(result.summary.failed).toBe(0);
      expect(result.success).toBe(false);
      // #1699 — the not-started entry is a PARTIAL INSTALL, not queue work.
      // Polling panel_node_queue_status would drain while this pack is absent.
      expect(result.results[1].message).toMatch(/PARTIAL INSTALL/);
      expect(result.results[1].message).toMatch(/never submitted/i);
      expect(result.results[1].message).not.toMatch(/poll the Manager queue/i);
      expect(result.partial).toMatchObject({
        kind: "custom_nodes_not_started",
        source: "this inline manifest",
        not_started: ["next-pack"],
        still_installing: ["slow-pack"],
      });
      expect(result.partial?.message).toMatch(/PARTIAL INSTALL/);
      expect(result.partial?.message).toMatch(/next-pack/);
      expect(getManifestPartialLeftover()?.not_started).toEqual(["next-pack"]);
    } finally {
      if (prevBudget === undefined) delete process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
      else process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = prevBudget;
    }
  });

  it("does not call a local fallback queued server-side when the node budget wins", async () => {
    const prevBudget = process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
    process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = "40";
    installCustomNodeMock.mockImplementationOnce(
      (opts: { onLocalFallback?: (binding: unknown) => void; localFallbackBinding?: unknown }) => {
        // Production-shaped ordering: node-management can select the fallback
        // synchronously, before apply_manifest records its final aggregate.
        opts.onLocalFallback?.(opts.localFallbackBinding);
        return new Promise(() => {});
      },
    );

    try {
      const result = await applyManifest({
        manifest: {
          custom_nodes: [
            "https://github.com/example/local-fallback-pack",
            "next-pack",
          ],
        },
      });

      expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 2 });
      expect(result.results[0].message).toMatch(/local direct-install fallback/i);
      expect(result.results[0].message).toMatch(/NOT queued server-side/i);
      expect(result.results[0].message).toMatch(/NOT on the ComfyUI-Manager queue/i);
      expect(result.results[0].message).not.toMatch(/poll panel_node_queue_status/i);
      expect(result.partial).toMatchObject({
        not_started: ["next-pack"],
        still_installing: ["https://github.com/example/local-fallback-pack"],
        local_fallback: ["https://github.com/example/local-fallback-pack"],
      });
      expect(result.partial?.message).toMatch(/Reconciliation:.*local direct-install fallback/i);
      const binding = installCustomNodeMock.mock.calls[0]?.[0]?.localFallbackBinding;
      expect(binding).toMatchObject({
        itemId: "https://github.com/example/local-fallback-pack",
        target: "http://127.0.0.1:8188",
        targetGeneration: 0,
      });
      expect(binding.operationId).toEqual(expect.any(String));
      expect(binding.scope).toEqual(expect.any(String));
      expect(installCustomNodeMock).toHaveBeenCalledWith(
        expect.objectContaining({ onLocalFallback: expect.any(Function) }),
      );
    } finally {
      if (prevBudget === undefined) delete process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
      else process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = prevBudget;
    }
  });

  it("trims git manifest identity before late-ambiguity classification", async () => {
    const prevBudget = process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
    process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = "40";
    const paddedId = "  https://github.com/example/local-fallback-pack  ";
    installCustomNodeMock.mockReturnValueOnce(new Promise(() => {}));

    try {
      const result = await applyManifest({
        manifest: { custom_nodes: [paddedId, "next-pack"] },
      });

      expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 2 });
      expect(result.results[0].message).toMatch(/outcome is UNKNOWN/i);
      expect(result.results[0].message).toMatch(/no local direct-install fallback is authorized/i);
      expect(result.partial).toMatchObject({
        not_started: ["next-pack"],
        still_installing: [paddedId],
        outcome_unknown: [paddedId],
      });
      expect(result.partial).not.toHaveProperty("local_fallback_pending");
      expect(installCustomNodeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "https://github.com/example/local-fallback-pack",
          localCloneFallback: "verified-only",
        }),
      );
    } finally {
      if (prevBudget === undefined) delete process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
      else process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = prevBudget;
    }
  });

  it("clears leftover not-started names when a later apply submits everything (#1699)", async () => {
    const prevBudget = process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
    process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = "40";
    installCustomNodeMock.mockReturnValueOnce(new Promise(() => {}));
    try {
      await applyManifest({
        manifest: { custom_nodes: ["slow-pack", "next-pack"] },
      });
      expect(getManifestPartialLeftover()?.not_started).toEqual(["next-pack"]);
    } finally {
      if (prevBudget === undefined) delete process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
      else process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = prevBudget;
    }

    listInstalledNodesMock.mockResolvedValue([
      { module: "slow-pack", cnrId: "slow-pack", enabled: true },
      { module: "next-pack", cnrId: "next-pack", enabled: true },
    ]);
    const settled = await applyManifest({
      manifest: { custom_nodes: ["slow-pack", "next-pack"] },
    });
    expect(settled.success).toBe(true);
    expect(settled.partial).toBeUndefined();
    expect(getManifestPartialLeftover()).toBeNull();
  });

  it("hands a slow model download to a background job (pending, not applied) (#362)", async () => {
    const prevGrace = process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
    process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = "0";
    downloadModelMock.mockReturnValue(new Promise<string>(() => {}));

    try {
      const result = await applyManifest({
        manifest: {
          models: [
            { url: "https://example.com/huge.safetensors", model_type: "checkpoints", filename: "huge.safetensors" },
          ],
        },
      });
      // A still-running download is PENDING, never counted as applied.
      expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 1 });
      expect(result.results[0].status).toBe("pending");
      expect(result.results[0].message).toMatch(/background|RUNNING/i);
      // The apply is not settled, so it is not a success — but nothing FAILED.
      expect(result.summary.failed).toBe(0);
      expect(result.success).toBe(false);
    } finally {
      if (prevGrace === undefined) delete process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
      else process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = prevGrace;
    }
  });

  it("names the stale copy on a STILL-RUNNING download — the reporter's own case", async () => {
    // The note used to render on 1 of 6 outcomes. A download slower than the 15s
    // grace reports `pending` and the stale path was lost PERMANENTLY: it lives
    // only in applyManifest's local array, so the `download_model status` poll
    // the user is told to run cannot see it. That is the case that filed #1298,
    // so the fix is hollow without it.
    const prevGrace = process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
    process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = "0";
    downloadModelMock.mockReturnValue(new Promise<string>(() => {}));
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/stale/models/checkpoints/slow.safetensors",
      root: "C:/stale/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });

    try {
      const result = await applyManifest({
        manifest: {
          models: [
            { url: "https://example.com/slow.safetensors", model_type: "checkpoints", filename: "slow.safetensors" },
          ],
        },
      });
      expect(result.results[0].status).toBe("pending");
      expect(result.results[0].message).toMatch(/same-named file also exists/);
      expect(result.results[0].message).toMatch(/C:\/stale\/models/);
    } finally {
      if (prevGrace === undefined) delete process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
      else process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = prevGrace;
    }
  });

  // Round 2: three of the six note-renderings were unpinned — including
  // wrongPlace, which my own commit called the worst case ("two same-named
  // copies on disk and neither message mentions the other"). Deleting any of
  // those three appends left a green suite, so each could regress silently to
  // exactly the state round 1 shipped.
  describe.each([
    {
      name: "a FAILED download",
      file: "failcase.safetensors",
      arm: () => downloadModelMock.mockRejectedValueOnce(new Error("boom")),
    },
    {
      name: "a landed-but-NOT-VISIBLE placement (wrongPlace)",
      file: "wrongplace.safetensors",
      arm: () => verifyLandedModelMock.mockResolvedValueOnce({ liveVisible: "not-visible", note: "" }),
    },
    {
      name: "an UNCONFIRMED placement",
      file: "unconfirmed.safetensors",
      arm: () => verifyLandedModelMock.mockResolvedValueOnce({ liveVisible: "unknown", note: "" }),
    },
  ])("names the stale copy on $name (#1298)", ({ file, arm }) => {
    it("carries the note", async () => {
      resolveExistingModelFileMock.mockResolvedValueOnce({
        path: `C:/stale/models/checkpoints/${file}`,
        root: "C:/stale/models",
        info: { isFile: () => true },
      });
      isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });
      arm();

      const result = await applyManifest({
        manifest: {
          models: [{ url: `https://example.com/${file}`, model_type: "checkpoints", filename: file }],
        },
      });
      expect(result.results[0].message ?? "").toMatch(/same-named file also exists/);
    });
  });

  it("does not block on MANY slow downloads — enqueues all, one bounded grace (#362)", async () => {
    const prevGrace = process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
    process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = "50";
    // Every download hangs; a per-model grace would be 50ms * N. One batch-wide
    // grace must cap total wait near a single window regardless of count.
    downloadModelMock.mockReturnValue(new Promise<string>(() => {}));
    const models = Array.from({ length: 20 }, (_, i) => ({
      url: `https://example.com/m${i}.safetensors`,
      model_type: "checkpoints" as const,
      filename: `m${i}.safetensors`,
    }));

    try {
      const started = Date.now();
      const result = await applyManifest({ manifest: { models } });
      const elapsed = Date.now() - started;
      expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 20 });
      // All 20 enqueued up front; total wait bounded by one grace window, not 20×.
      expect(downloadModelMock).toHaveBeenCalledTimes(20);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      if (prevGrace === undefined) delete process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
      else process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = prevGrace;
    }
  });

  it.each([
    ["--index-url=evil"],
    ["-r/etc/passwd"],
    ["numpy\u0000"],
  ])("rejects unsafe pip entry %s before invoking pip", async (pkg) => {
    const result = await applyManifest({ manifest: { pip: [pkg] } });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([
      { action: "pip", item: pkg, status: "failed" },
    ]);
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["install", pkg]),
      expect.any(Object),
    );
  });

  it("#870 — a junctioned category folder is NOT refused up front (StabilityMatrix)", async () => {
    // The reporter's install junctions models/vae -> E:\comfy\StabilityMatrix\
    // models\VAE. `realpath` of the parent therefore lands OUTSIDE the models
    // root, which apply_manifest used to read as "local_path escapes the models
    // directory" and refuse before any download started.
    //
    // Since #919 the canonical resolver authorizes an in-tree redirect by its
    // LOCATION (ComfyUI's own scanner follows the junction), so this layer must
    // not veto it: the item has to reach the downloader, which applies the one
    // remaining refusal (a custom_nodes landing) on the same path.
    //
    // The product resolves these paths with node:path, yielding
    // backslash-separated absolute paths on Windows. Build the mock keys the
    // same way so they match what the product passes to realpath.
    const modelsDir = resolve(COMFY, "models");
    const junction = join(modelsDir, "vae");
    const shared = resolve("E:/comfy/StabilityMatrix/models/VAE");
    realpathMock.mockImplementation((path: string) => {
      if (path === modelsDir) return Promise.resolve(modelsDir);
      if (path === junction) return Promise.resolve(shared);
      return Promise.resolve(path);
    });

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/qwen_image_vae.safetensors", local_path: "vae/qwen_image_vae.safetensors" },
        ],
      },
    });

    expect(result.results).toMatchObject([
      { action: "model", item: "vae/qwen_image_vae.safetensors" },
    ]);
    expect(result.results[0].status).not.toBe("failed");
    expect(downloadModelMock.mock.calls[0]?.slice(0, 3)).toEqual([
      "https://example.com/qwen_image_vae.safetensors",
      "vae",
      "qwen_image_vae.safetensors",
    ]);
  });

  it("#870 — junctioned and real category folders behave IDENTICALLY (the krea2 pack's three models)", async () => {
    // The reporter's asymmetry: text_encoders is a real directory under the
    // package models root and succeeded, while vae and diffusion_models are
    // junctions and were both refused. All three must now enqueue.
    const modelsDir = resolve(COMFY, "models");
    const junctions = new Map([
      [join(modelsDir, "vae"), resolve("E:/comfy/StabilityMatrix/models/VAE")],
      [join(modelsDir, "diffusion_models"), resolve("E:/comfy/StabilityMatrix/models/DiffusionModels")],
    ]);
    realpathMock.mockImplementation((path: string) =>
      Promise.resolve(junctions.get(path) ?? path),
    );

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/krea2_turbo_fp8.safetensors", local_path: "diffusion_models/krea2_turbo_fp8.safetensors" },
          { url: "https://example.com/qwen3vl_4b_fp8_scaled.safetensors", local_path: "text_encoders/qwen3vl_4b_fp8_scaled.safetensors" },
          { url: "https://example.com/qwen_image_vae.safetensors", local_path: "vae/qwen_image_vae.safetensors" },
        ],
      },
    });

    expect(result.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(downloadModelMock.mock.calls.map((c) => c[1]).sort()).toEqual([
      "diffusion_models",
      "text_encoders",
      "vae",
    ]);
  });

  it("still refuses a local_path that traverses out of models/ lexically", async () => {
    const result = await applyManifest({
      manifest: {
        models: [{ url: "https://example.com/m.safetensors", local_path: "../evil.safetensors" }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([
      { action: "model", status: "failed", item: "../evil.safetensors" },
    ]);
    expect(result.results[0].message).toMatch(/escapes the models directory/i);
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("targets the LIVE models dir, not a stale COMFYUI_PATH (#490)", async () => {
    // #490: COMFYUI_PATH is a stale install; the connected server writes under a
    // DIFFERENT live root. The destination this layer computes — the path the
    // "already installed?" check is asked about — must be rooted at the LIVE
    // models dir, never at <COMFYUI_PATH>/models (which is never written to).
    mockConfig.comfyuiPath = "/stale/ComfyUI";
    const liveModels = resolve("/live/ComfyUI/models");
    modelsDirMock.mockResolvedValue(liveModels);

    await applyManifest({
      manifest: {
        models: [{ url: "https://example.com/m.safetensors", local_path: "loras/m.safetensors" }],
      },
    });

    expect(statMock).toHaveBeenCalledWith(join(liveModels, "loras", "m.safetensors"));
    expect(statMock).not.toHaveBeenCalledWith(
      join(resolve("/stale/ComfyUI/models"), "loras", "m.safetensors"),
    );
  });

  describe("remote mode (no COMFYUI_PATH) — per-section handling", () => {
    beforeEach(() => {
      mockConfig.comfyuiPath = undefined;
    });

    it("does not throw up-front; routes each section by mode", async () => {
      installCustomNodeMock.mockResolvedValueOnce({ message: "installed node" });
      // First check: not installed yet. After install: present → "applied".
      listInstalledNodesMock
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ module: "x", enabled: true }]);

      const result = await applyManifest({
        manifest: {
          apt: ["ffmpeg"],
          pip: ["numpy"],
          custom_nodes: ["x"],
          models: [
            {
              url: "https://example.com/model.safetensors",
              model_type: "checkpoints",
              filename: "model.safetensors",
            },
          ],
        },
      });

      const byAction = Object.fromEntries(
        result.results.map((r) => [r.action, r]),
      );
      // apt + pip are unsupported remotely → skipped, never executed.
      expect(byAction.apt.status).toBe("skipped");
      expect(byAction.pip.status).toBe("skipped");
      expect(execFileSyncMock).not.toHaveBeenCalled();
      // custom_nodes still go through the Manager HTTP install (remote-ok).
      expect(installCustomNodeMock).toHaveBeenCalledWith(expect.objectContaining({
        id: "x",
        managerBase: "http://127.0.0.1:8188",
        targetGeneration: 0,
      }));
      // models route through installModelViaManager, NOT the local downloadModel.
      expect(downloadModelMock).not.toHaveBeenCalled();
      expect(installModelViaManagerMock).toHaveBeenCalledWith({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
        save_path: "default",
        trayCategory: "checkpoints",
      });
      // #369: a ComfyUI-Manager dispatch is ACCEPTED, not verified as landed
      // (Manager reports its queue task done even on failure, and there is no local
      // file to check), so it reports PENDING with the caveat spelled out rather
      // than claiming an apply nobody confirmed.
      expect(byAction.model.status).toBe("pending");
      expect(byAction.model.message).toMatch(/NOT verified as landed/);
    });

    it("derives type + save_path from a nested model local_path", async () => {
      await applyManifest({
        manifest: {
          models: [
            {
              url: "https://example.com/lora.safetensors",
              local_path: "loras/pusa/lora.safetensors",
            },
          ],
        },
      });

      // Nested local_path → explicit save_path verbatim; our "loras" category
      // maps to Manager's singular "lora" type key; name falls back to filename.
      expect(installModelViaManagerMock).toHaveBeenCalledWith({
        name: "lora.safetensors",
        url: "https://example.com/lora.safetensors",
        filename: "lora.safetensors",
        type: "lora",
        save_path: "loras/pusa",
        trayCategory: "loras",
      });
    });
  });

  describe("remote mode while a local COMFYUI_PATH is also set (issue #1 regression)", () => {
    beforeEach(() => {
      // A remote target coexists with an unrelated local install path. The
      // local/remote split must key off isRemoteMode(), NOT comfyuiPath presence.
      mockConfig.comfyuiPath = "/fake/ComfyUI";
      mockConfig.remote = true;
    });

    it("routes pip + models remotely and never touches the local install/disk", async () => {
      const result = await applyManifest({
        manifest: {
          pip: ["numpy"],
          models: [
            {
              url: "https://example.com/model.safetensors",
              model_type: "checkpoints",
              filename: "model.safetensors",
            },
          ],
        },
      });

      const byAction = Object.fromEntries(
        result.results.map((r) => [r.action, r]),
      );
      // pip has no remote equivalent → skipped, never shelled out locally.
      expect(byAction.pip.status).toBe("skipped");
      expect(execFileSyncMock).not.toHaveBeenCalled();
      // Model goes through the Manager (remote), NOT the local downloadModel,
      // and the local model-existence check is skipped entirely.
      expect(downloadModelMock).not.toHaveBeenCalled();
      expect(resolveExistingModelFileMock).not.toHaveBeenCalled();
      expect(installModelViaManagerMock).toHaveBeenCalledWith({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
        save_path: "default",
        trayCategory: "checkpoints",
      });
      // #369: a ComfyUI-Manager dispatch is ACCEPTED, not verified as landed
      // (Manager reports its queue task done even on failure, and there is no local
      // file to check), so it reports PENDING with the caveat spelled out rather
      // than claiming an apply nobody confirmed.
      expect(byAction.model.status).toBe("pending");
      expect(byAction.model.message).toMatch(/NOT verified as landed/);
    });
  });

  // #1374 review, P1-4 — A FALSE FAILURE IS WORSE THAN AN UNCONFIRMED SUCCESS.
  //
  // The reachable shape, and the reporter's own: a LOCAL install (manifest takes
  // its local branch, so this goes through startDownloadJob) whose download is
  // nevertheless routed to ComfyUI-Manager. The dispatch is accepted, and the
  // connected server does not list the file yet.
  //
  // That is genuinely ambiguous — a Manager dispatch returns on ACCEPTANCE and
  // its queue can drain hours before the transfer does (#1197), so "not listed"
  // is equally a 13 GB fetch still in flight. Rendering it `failed` invents a
  // failure, and a caller who believes it re-issues the download and pays for the
  // transfer twice.
  describe("a Manager-routed model that isn't listed yet (#1374 review P1-4)", () => {
    beforeEach(() => {
      // Local filesystem present — manifest takes its local branch...
      mockConfig.comfyuiPath = COMFY;
      mockConfig.remote = false;
      // ...but the DOWNLOAD is routed to Manager anyway. That gap is #1374.
      shouldDispatchToManagerMock.mockResolvedValue(true);
      // And the server does not list it afterwards.
      verifyManagerVisibilityMock.mockResolvedValue({
        visibility: "not-listed" as const,
        note: "The connected ComfyUI does NOT list checkpoints/model.safetensors. That is not proof of failure — a large file may still be arriving.",
      });
    });

    const applyOne = () =>
      applyManifest({
        manifest: {
          models: [
            {
              url: "https://example.com/model.safetensors",
              model_type: "checkpoints",
              filename: "model.safetensors",
            },
          ],
        },
      });

    it("reports PENDING, never FAILED", async () => {
      const result = await applyManifest({
        manifest: {
          models: [
            {
              url: "https://example.com/model.safetensors",
              model_type: "checkpoints",
              filename: "model.safetensors",
            },
          ],
        },
      });

      // The check really ran — otherwise "pending" below would be the untouched
      // default and this test would pass while measuring nothing.
      expect(verifyManagerVisibilityMock).toHaveBeenCalled();
      expect(result.results[0]?.status).toBe("pending");
      expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 1 });
    });

    it("still states the finding in the message", async () => {
      // Not softened into silence: the whole point of #1374 is that the report
      // now carries an observation instead of a caveat true of every outcome.
      const result = await applyOne();

      expect(result.results[0]?.message).toMatch(/does NOT list/);
      expect(result.results[0]?.message).toMatch(/security_level/);
    });

    it("does not claim success either", async () => {
      const result = await applyOne();

      expect(result.results[0]?.status).not.toBe("applied");
      expect(result.success).toBe(false);
    });
  });
});
