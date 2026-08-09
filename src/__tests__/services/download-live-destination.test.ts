import { describe, expect, it, beforeEach, vi } from "vitest";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// #369 — "download_model reports success, the model never appears".
//
// Two halves are covered here, both about the LIVE server rather than local config:
//
//  (1) PRE-write — when the models root came from local configuration the running
//      server never vouched for, a destination the server demonstrably does not
//      read from is REFUSED before the transfer starts.
//  (2) POST-write — a landed file is verified on disk AND against the connected
//      server's own `/models/<category>` listing, and the VERIFIED path is what
//      gets reported. Reporting the intended path is what made the original bug
//      look like a success.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  comfyuiPath: "/comfy" as string | undefined,
  remote: false,
  baseUrl: "http://127.0.0.1:8188",
  /** Per-category listing the LIVE server answers with; undefined → 404. */
  liveListings: {} as Record<string, string[] | undefined>,
  /** The candidate models root on disk: category folder → files it contains. */
  onDisk: {} as Record<string, string[]>,
  modelsDirSource: "configured-base" as string,
  fetchCalls: [] as string[],
  /** What getLiveExtraModelRoots reports — only an AUTHORITATIVE, EMPTY answer can
   *  rule out "the server's models live on another drive". */
  liveExtraRoots: { authoritative: false, roots: [] as unknown[] },
  /** Does the resolved models root exist on THIS filesystem? */
  modelsRootExists: true,
  /** The models root resolveModelsDirWithBases reports (the download destination). */
  destModelsDir: "/comfy/models",
  /** The live server's argv in the snapshot. An ABSOLUTE main.py means its
   *  extra_model_paths config location IS knowable, which is what lets the
   *  "empty tree + no extra roots" refusal conclude anything at all. */
  snapshotArgv: [] as string[],
}));

vi.mock("../../config.js", () => ({
  config: {
    get comfyuiPath() {
      return h.comfyuiPath;
    },
    huggingfaceToken: undefined,
    civitaiApiToken: undefined,
    resolvedPort: 8188,
  },
  getComfyUIBaseUrl: () => h.baseUrl,
  isRemoteMode: () => h.remote,
}));

vi.mock("../../comfyui/client.js", () => {
  // Declared INSIDE the factory: `vi.mock` is hoisted above every top-level
  // const, so a shared double defined out there is read before it exists. `h` is
  // fine to close over — it is `vi.hoisted`.
  const listingFetch = async (path: string) => {
    h.fetchCalls.push(path);
    const category = path.replace(/^\/models\//, "");
    const listing = h.liveListings[category];
    if (listing === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => listing };
  };
  return {
    getSystemStats: vi.fn(async () => ({ system: { argv: [join("ComfyUI", "main.py")] } })),
    getClient: () => ({ fetchApi: listingFetch }),
    // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
    // returns a 4xx instead of throwing. Same double, so `h.fetchCalls` records
    // the identical routes and every assertion in this file is unchanged.
    comfyApiFetch: listingFetch,
  };
});

vi.mock("../../services/node-management.js", () => ({
  installModelViaManager: vi.fn(),
}));

vi.mock("../../services/extra-paths.js", () => ({
  getExtraModelRoots: vi.fn(async () => []),
  getLiveExtraModelRoots: vi.fn(async () => h.liveExtraRoots),
}));

const resolveModelsDirWithBasesMock = vi.hoisted(() =>
  vi.fn(async (): Promise<unknown> => undefined),
);
vi.mock("../../services/output-dir.js", () => ({
  resolveModelsDir: vi.fn(async () => resolve(h.destModelsDir)),
  resolveModelsDirWithBases: () => resolveModelsDirWithBasesMock(),
  parseModelsDirFromArgv: vi.fn(() => undefined),
  hasUnresolvableRelativeModelDirFlag: vi.fn(() => false),
  // Real behaviour (pure argv parsing): the "empty tree + no extra roots" refusal
  // only concludes anything when the server's config location is knowable.
  parseExtraModelPathsConfigsFromArgvRaw: (argv?: string[]) => {
    const out: string[] = [];
    for (let i = 0; i < (argv?.length ?? 0); i++) {
      if (argv![i] === "--extra-model-paths-config" && argv![i + 1]) out.push(argv![i + 1]);
    }
    return out;
  },
  isLiveAuthoritativeModelsDir: (s: string) =>
    s === "argv-flag" || s === "live-root" || s === "observed-root",
}));

// A live-resolved models root is exempt from the pre-write check ONLY when it
// exists on this filesystem (a container-side path does not). Default true.
vi.mock("node:fs", () => ({ existsSync: () => h.modelsRootExists }));

const statMock = vi.fn();
const realpathMock = vi.fn();
const readdirMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
  mkdir: vi.fn(),
  readdir: (...a: unknown[]) => readdirMock(...a),
  readFile: vi.fn(),
  realpath: (...a: unknown[]) => realpathMock(...a),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: (...a: unknown[]) => statMock(...a),
  utimes: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

import {
  currentLiveModelsRoot,
  resolveModelSubfolderPreferServer,
  verifyLandedModel,
} from "../../services/model-resolver.js";
import { ModelError } from "../../utils/errors.js";

beforeEach(() => {
  h.comfyuiPath = "/comfy";
  h.remote = false;
  h.liveListings = {};
  h.onDisk = {};
  h.modelsDirSource = "configured-base";
  h.fetchCalls = [];
  h.liveExtraRoots = { authoritative: false, roots: [] };
  h.modelsRootExists = true;
  h.destModelsDir = "/comfy/models";
  // Absolute argv main.py: the live install root resolves, so the server's
  // extra_model_paths config location is knowable.
  h.snapshotArgv = [resolve("/live/ComfyUI/main.py")];
  resolveModelsDirWithBasesMock.mockReset();
  resolveModelsDirWithBasesMock.mockImplementation(async () => ({
    modelsDir: resolve(h.destModelsDir),
    baseDirs: [],
    snapshot: { reachable: true, argv: h.snapshotArgv },
    source: h.modelsDirSource,
  }));
  statMock.mockReset();
  realpathMock.mockReset();
  readdirMock.mockReset();
  // Model the candidate models root: `withFileTypes` enumerates its category
  // folders, a plain recursive read lists that category's files.
  readdirMock.mockImplementation(
    async (dir: string, opts?: { withFileTypes?: boolean }) => {
      if (opts?.withFileTypes) {
        return Object.keys(h.onDisk).map((name) => ({ name, isDirectory: () => true }));
      }
      const category = String(dir).split(/[\\/]/).filter(Boolean).pop() ?? "";
      return h.onDisk[category] ?? [];
    },
  );
  realpathMock.mockImplementation(async (p: string) => p);
  statMock.mockResolvedValue({ isFile: () => true, size: 10 });
});

describe("pre-write: a destination the LIVE server does not read from is refused (#369)", () => {
  it("REFUSES a locally-configured root whose contents the live server does not list", async () => {
    // The exact reported shape: the stale install holds a handful of models and
    // the running server lists a completely different set for that category.
    h.onDisk = {
      diffusion_models: [
        "stale-a.safetensors",
        "stale-b.safetensors",
        "stale-c.safetensors",
      ],
    };
    h.liveListings["diffusion_models"] = Array.from(
      { length: 24 },
      (_, i) => `live-${i}.safetensors`,
    );

    await expect(resolveModelSubfolderPreferServer("diffusion_models")).rejects.toThrow(
      ModelError,
    );
    const err = await resolveModelSubfolderPreferServer("diffusion_models").catch(
      (e: Error) => e,
    );
    const msg = (err as Error).message;
    expect(msg).toMatch(/does not read from it/);
    expect(msg).toMatch(/DIFFERENT install/);
    expect(msg).toMatch(/127\.0\.0\.1:8188/);
  });

  // #1147 — an EMPTY live listing is not disagreement.
  //
  // A reporter's portable install held models/birefnet/BiRefNet_lite/model.safetensors
  // (a HuggingFace repo dump) while the running server's /models/birefnet answered
  // empty. Their loras/ agreed with the live server perfectly and argv pointed at
  // that very tree — and the download was refused into the correct install.
  //
  // The #369 signature this guard exists for is a POPULATED listing describing a
  // DIFFERENT tree (3 on disk, 24 unrelated live). "0 live entries" cannot tell
  // "wrong install" from "a category this server does not enumerate the way a
  // filesystem walk does", so it is not positive evidence and must not refuse.
  it("#1147: PROCEEDS when the live listing for a populated category is EMPTY", async () => {
    h.onDisk = { birefnet: ["BiRefNet_lite/model.safetensors"] };
    h.liveListings["birefnet"] = []; // registered, answers, names nothing
    h.liveListings["loras"] = ["agreed.safetensors"];

    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBeTruthy();
  });

  it("#1147: still REFUSES when that same category lists OTHER files", async () => {
    // The guard must not be blunted: a populated listing that omits the on-disk
    // files is the real #369 signature and still fails closed.
    h.onDisk = { birefnet: ["BiRefNet_lite/model.safetensors"] };
    h.liveListings["birefnet"] = ["someone-elses.safetensors"];

    await expect(resolveModelSubfolderPreferServer("birefnet")).rejects.toThrow(ModelError);
  });

  it("REFUSES on a POPULATED SIBLING when the target category is empty (codex gate)", async () => {
    // The stale install has never held a diffusion model, so the target folder is
    // empty and says nothing — but its checkpoints/ betrays the wrong install.
    h.onDisk = {
      diffusion_models: [],
      checkpoints: ["stale-ckpt.safetensors"],
    };
    h.liveListings["diffusion_models"] = ["live-unet.safetensors"];
    h.liveListings["checkpoints"] = ["live-ckpt.safetensors"];

    await expect(resolveModelSubfolderPreferServer("diffusion_models")).rejects.toThrow(
      /DIFFERENT install/,
    );
  });

  it("ALLOWS when the live server lists EVERY file the directory holds (it scans this tree)", async () => {
    h.onDisk = { loras: ["a.safetensors", "b.safetensors"] };
    h.liveListings["loras"] = ["a.safetensors", "b.safetensors", "from-an-extra-root.safetensors"];
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("REFUSES when a nested file matches only by BASENAME under a different subfolder (codex gate r9)", async () => {
    // The stale tree holds loras/a/shared.safetensors; the live server lists only
    // loras/b/shared.safetensors. Those are different files in different installs.
    h.onDisk = { loras: ["a/shared.safetensors"] };
    h.liveListings["loras"] = ["b/shared.safetensors"];
    await expect(resolveModelSubfolderPreferServer("loras")).rejects.toThrow(
      /DIFFERENT install/,
    );
  });

  it("PROCEEDS when the tree has FOLDERS but no model files to contradict anything", async () => {
    // Nothing on disk here can contradict the server, and the fact that its models
    // live somewhere we cannot see is not evidence about THIS directory.
    h.onDisk = { loras: [], checkpoints: [] };
    h.liveListings["loras"] = [];
    h.liveListings["checkpoints"] = [];
    h.liveListings["text_encoders"] = ["t5xxl.safetensors"];
    h.liveExtraRoots = { authoritative: true, roots: [] };
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("REFUSES on a merely OVERLAPPING filename — containment is required (codex gate r5)", async () => {
    // Two unrelated installs routinely share a popular checkpoint. That shared name
    // must NOT suppress the refusal when the rest of the tree is unknown to the server.
    h.onDisk = { loras: ["sd_xl_base_1.0.safetensors", "only-here.safetensors"] };
    h.liveListings["loras"] = ["sd_xl_base_1.0.safetensors", "live-only.safetensors"];
    await expect(resolveModelSubfolderPreferServer("loras")).rejects.toThrow(
      /DIFFERENT install/,
    );
  });

  it("ALLOWS when a SIBLING category is fully accounted for and the target is empty", async () => {
    h.onDisk = { loras: [], checkpoints: ["shared.safetensors"] };
    h.liveListings["checkpoints"] = ["shared.safetensors"];
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  // There is deliberately NO "the server lists models this tree cannot account for"
  // refusal. Not being able to EXPLAIN the server's models is absence of evidence,
  // not proof of a different install: the roots may come from a config we cannot
  // read, one deleted after the server loaded it, or a shape nobody enumerated.
  // Every tightening of that rule produced another false refusal of a legitimate
  // setup, so an unaccountable tree PROCEEDS and the post-write check reports
  // honestly (maintainer ruling).
  it("PROCEEDS on an empty tree whose live models cannot be accounted for", async () => {
    h.onDisk = { loras: [], checkpoints: [] };
    h.liveListings["loras"] = ["a.safetensors", "b.safetensors"];
    h.liveListings["checkpoints"] = ["c.safetensors"];
    h.liveExtraRoots = { authoritative: true, roots: [] };
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("PROCEEDS when a config was deleted AFTER the server loaded its roots", async () => {
    // The running process still holds `E:\\Models\\loras`; its YAML is gone, so the
    // roots are unknowable. The old rule called this "a DIFFERENT install" and
    // blocked the user from downloading into a perfectly valid primary tree.
    h.onDisk = { loras: [] };
    h.liveListings["loras"] = ["live-only.safetensors"];
    h.liveExtraRoots = { authoritative: true, roots: [] };
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("PROCEEDS on a brand-new models tree (a fresh install's first model)", async () => {
    h.onDisk = { loras: [] };
    h.liveListings["loras"] = [];
    h.liveExtraRoots = { authoritative: true, roots: [] };
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("ALLOWS when the server cannot answer for any category (inconclusive, fails open)", async () => {
    h.onDisk = { loras: ["a.safetensors"] };
    h.liveListings = {}; // every /models/<cat> 404s
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("does NOT second-guess a LIVE-AUTHORITATIVE root that exists locally — no listing call", async () => {
    h.modelsDirSource = "observed-root";
    h.onDisk = { loras: ["stale.safetensors"] };
    h.liveListings["loras"] = ["completely-different.safetensors"];
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
    expect(h.fetchCalls).toEqual([]);
  });

  it("PROCEEDS on a container-side models root that does not exist here (post-write reports it)", async () => {
    // A loopback ComfyUI inside Docker reports its CONTAINER-side --models-directory,
    // which does not exist on the host. There is nothing on disk to contradict it, so
    // this is unaccountable, NOT proof of a different install — the write goes ahead
    // and verifyLandedModel reports not-visible afterwards.
    h.modelsDirSource = "argv-flag";
    h.modelsRootExists = false;
    h.onDisk = {}; // nothing on the host at that path
    h.liveListings["loras"] = ["a.safetensors", "b.safetensors"];
    h.liveExtraRoots = { authoritative: true, roots: [] };
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBeTruthy();
  });

  it("ignores non-core extensions on disk (a .gguf-only dir is not evidence of disagreement)", async () => {
    h.onDisk = { diffusion_models: ["weights.gguf"] };
    h.liveListings["diffusion_models"] = ["a.safetensors"];
    await expect(
      resolveModelSubfolderPreferServer("diffusion_models"),
    ).resolves.toBeTruthy();
  });

  it("PROCEEDS when the only 'mismatch' is a diffusers folder the server CONTRACTUALLY never lists (#844)", async () => {
    // The exact reported shape: nested Diffusers component files under
    // models/diffusers that /models/diffusers never lists — ComfyUI registers
    // that category with a ["folder"] extension contract (no file matches it),
    // so the component files' absence is contractual, not evidence of a
    // different install. The old rule read it as positive proof and refused a
    // correct workspace.
    h.onDisk = {
      vae: [],
      diffusers: [
        "hunyuan3d-paint-v2-0-turbo/vae/diffusion_pytorch_model.bin",
        "hunyuan3d-paint-v2-0-turbo/text_encoder/pytorch_model.bin",
      ],
    };
    h.liveListings["vae"] = ["server-vae.safetensors"];
    h.liveListings["diffusers"] = []; // what the real endpoint answers, by contract
    await expect(resolveModelSubfolderPreferServer("vae")).resolves.toBe(
      resolve("/comfy/models/vae"),
    );
    // Assert the REASON, not just the state: the category was excused by its
    // enumeration contract, so the server was never even asked about it.
    expect(h.fetchCalls).not.toContain("/models/diffusers");
  });

  it("STILL REFUSES a real mismatch in a sibling category when a diffusers folder is present (#844 is not a blind spot)", async () => {
    // Excusing the contract-empty category must not excuse anything else: a
    // populated checkpoints/ the server demonstrably does not read is still the
    // #369 signature.
    h.onDisk = {
      diffusers: ["hunyuan3d-paint-v2-0-turbo/vae/diffusion_pytorch_model.bin"],
      checkpoints: ["stale-ckpt.safetensors"],
    };
    h.liveListings["diffusers"] = [];
    h.liveListings["checkpoints"] = ["live-ckpt.safetensors"];
    const err = await resolveModelSubfolderPreferServer("vae").catch((e: Error) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as Error).message).toMatch(/DIFFERENT install/);
    // The refusal must name the category with REAL evidence, not the excused one.
    expect((err as Error).message).toMatch(/"checkpoints"/);
  });
});

describe("currentLiveModelsRoot — only a LIVE-AUTHORITATIVE answer (#369)", () => {
  it("returns the root when the models dir came from the running server", async () => {
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/live/ComfyUI/models";
    await expect(currentLiveModelsRoot()).resolves.toBe(resolve("/live/ComfyUI/models"));
  });

  it("returns UNDEFINED when it fell back to local config (codex gate r12)", async () => {
    // A transient /system_stats outage falls back to COMFYUI_PATH. Reporting that as
    // "what the server reads now" would falsely downgrade a correct verdict.
    h.modelsDirSource = "configured-base";
    h.destModelsDir = "/comfy/models";
    await expect(currentLiveModelsRoot()).resolves.toBeUndefined();
  });
});

describe("post-write: the reported path is VERIFIED, not intended (#369)", () => {
  const target = resolve("/live/ComfyUI/models/loras/new.safetensors");

  beforeEach(() => {
    // Default to the healthy case: the destination IS the root the running server
    // reported, so a listing hit is decisive. Tests about the non-authoritative
    // ambiguity set `configured-base` explicitly.
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/live/ComfyUI/models";
  });

  it("reports the on-disk path and 'visible' when the live server lists the file", async () => {
    h.liveListings["loras"] = ["new.safetensors", "old.safetensors"];
    const res = await verifyLandedModel(target, "loras", { attempts: 1, retryMs: 0 });
    expect(res.verifiedPath).toBe(target);
    expect(res.liveVisible).toBe("visible");
    expect(res.note).toBeUndefined();
  });

  it("resolves a symlinked destination to the REAL path it reports", async () => {
    const real = resolve("/mnt/models/loras/new.safetensors");
    realpathMock.mockImplementation(async () => real);
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", { attempts: 1, retryMs: 0 });
    expect(res.verifiedPath).toBe(real);
  });

  // This test's own fixture writes INTO /live/ComfyUI/models — the very root the
  // running server reported — so its original assertion ("move the file into the
  // running server's models tree") was pinning #1131: an instruction naming the
  // directory the file was already in. The verdict is unchanged; the remedy is
  // the stale-listing one, and the outside-the-root case is covered below.
  it("reports NOT-VISIBLE and blames the stale listing when the file is inside the live root", async () => {
    h.liveListings["loras"] = ["something-else.safetensors"];
    const res = await verifyLandedModel(target, "loras", { attempts: 2, retryMs: 0 });
    expect(res.liveVisible).toBe("not-visible");
    expect(res.verifiedPath).toBe(target);
    expect(res.note).toMatch(/does not list "new\.safetensors" under "loras" YET/);
    expect(res.note).toMatch(/Do NOT move the file/);
    expect(res.note).not.toMatch(/Move the file into the running server's models tree/);
    expect(res.note).toContain(resolve("/live/ComfyUI/models"));
  });

  it("still says MOVE IT when the file is outside the live models root", async () => {
    const stray = resolve("/somewhere/else/new.safetensors");
    realpathMock.mockImplementation(async () => stray);
    h.liveListings["loras"] = ["something-else.safetensors"];
    const res = await verifyLandedModel(target, "loras", { attempts: 2, retryMs: 0 });
    expect(res.liveVisible).toBe("not-visible");
    expect(res.note).toMatch(/does NOT list "new\.safetensors"/);
    expect(res.note).toMatch(/will not be usable/);
    expect(res.note).toMatch(/Move the file into the running server's models tree/);
    expect(res.note).toContain(resolve("/live/ComfyUI/models"));
  });

  it("reports UNKNOWN — never a success — when the file is not on disk at all", async () => {
    statMock.mockRejectedValue(new Error("ENOENT"));
    const res = await verifyLandedModel(target, "loras", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("unknown");
    expect(res.verifiedPath).toBeUndefined();
    expect(res.note).toMatch(/could not be confirmed on disk/);
  });

  it("reports UNKNOWN when the server cannot answer for the category", async () => {
    h.liveListings = {};
    const res = await verifyLandedModel(target, "loras", { attempts: 2, retryMs: 0 });
    expect(res.liveVisible).toBe("unknown");
    expect(res.verifiedPath).toBe(target);
    expect(res.note).toMatch(/did not answer/);
  });

  it("reports UNKNOWN in remote mode (local placement says nothing about the remote host)", async () => {
    h.remote = true;
    const res = await verifyLandedModel(target, "loras", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("unknown");
    expect(res.note).toMatch(/remote/i);
  });

  it("matches a nested entry by its CATEGORY-RELATIVE path (ComfyUI lists 'sub/file')", async () => {
    h.liveListings["loras"] = ["sub/new.safetensors"];
    const res = await verifyLandedModel(target, "loras/sub", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("visible");
  });

  it("does NOT call a same-named file in a DIFFERENT subfolder visible (codex gate r2)", async () => {
    // The live server holds loras/b/new.safetensors; we wrote loras/a/new.safetensors
    // into a tree it does not read. A basename comparison would fabricate success.
    h.liveListings["loras"] = ["b/new.safetensors"];
    const res = await verifyLandedModel(target, "loras/a", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("not-visible");
    expect(res.note).toMatch(/a\/new\.safetensors/);
  });

  it("does NOT confirm a non-authoritative destination whose name the server ALREADY listed (codex gate r3)", async () => {
    // Both trees hold `loras/new.safetensors`. The write went into the LOCALLY
    // CONFIGURED tree; the server listing that name proves nothing about our bytes.
    h.modelsDirSource = "configured-base";
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: true,
    });
    expect(res.liveVisible).toBe("unknown");
    expect(res.note).toMatch(/already listed that name/i);
  });

  it("does NOT confirm a non-authoritative destination when the PRE-download listing was unavailable (codex gate r14)", async () => {
    // Nothing establishes that the entry appeared because of THIS write — the live
    // server may have listed that name all along, from a tree we did not write to.
    h.modelsDirSource = "configured-base";
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: undefined,
    });
    expect(res.liveVisible).toBe("unknown");
    expect(res.note).toMatch(/could not be checked/);
  });

  it("NEVER confirms a non-authoritative destination, even when the entry appeared after the write (codex gate r17)", async () => {
    // "It was not listed before, and it is now" looks like proof, but the server
    // that answered BEFORE the write need not be the one answering after it — a
    // replacement install holding its own same-named model reads identically. With
    // no live-authoritative destination to tie the two observations together, the
    // honest answer is unconfirmed.
    h.modelsDirSource = "configured-base";
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("unknown");
    expect(res.note).toMatch(/cannot be tied to the file just written/);
    // An unverifiable result must say WHY and how to become verifiable, or the user
    // has nothing to act on.
    expect(res.note).toMatch(/RELATIVE main\.py/);
    expect(res.note).toMatch(/could not be identified/);
    expect(res.note).toMatch(/list_local_models/);
  });

  it("DOES confirm a re-download into a LIVE-AUTHORITATIVE root even though the name pre-existed", async () => {
    // Repairing/replacing an existing model in the server's own tree must stay a
    // clean success — the ambiguity only exists for locally-configured roots.
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/live/ComfyUI/models"; // the tree `target` lives in
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: true,
    });
    expect(res.liveVisible).toBe("visible");
  });

  it("reports NOT-VISIBLE when the live root moved out from under the landed file (restart A→B; codex gate r4)", async () => {
    // Server A was live when the file landed under A's models root. B replaced it on
    // the same port before verification and happens to list the same filename — that
    // is B's OWN copy, not ours, and ours is outside everything B reads.
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/serverB/models"; // the CURRENT live root
    h.liveListings["loras"] = ["new.safetensors"]; // B's own same-named model
    h.liveExtraRoots = { authoritative: true, roots: [] };
    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("not-visible");
    expect(res.note).toMatch(/OUTSIDE every directory/);
  });

  it("re-checks membership AFTER the listing — a server swap mid-check is not a success (codex gate r11)", async () => {
    // Server A is live for the membership check; B replaces it before the listing
    // and lists its OWN same-named model. That must not confirm A's file.
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/live/ComfyUI/models"; // A: the landed file IS under this
    h.liveExtraRoots = { authoritative: true, roots: [] };
    h.liveListings["loras"] = ["new.safetensors"];
    let calls = 0;
    resolveModelsDirWithBasesMock.mockImplementation(async () => {
      calls += 1;
      return {
        // 1st call (membership) = server A; 2nd (re-check after the listing) = B.
        modelsDir: resolve(calls === 1 ? "/live/ComfyUI/models" : "/serverB/models"),
        baseDirs: [],
        snapshot: { reachable: true, argv: h.snapshotArgv },
        source: h.modelsDirSource,
      };
    });

    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("not-visible");
    expect(res.note).toMatch(/changed while this was being checked/);
  });

  it("stamps the live root a VISIBLE verdict was made against", async () => {
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/live/ComfyUI/models";
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("visible");
    expect(res.verifiedAgainstRoot).toBe(resolve("/live/ComfyUI/models"));
  });

  it("stamps the root the MEMBERSHIP check ran against, not a later observation (codex gate r12)", async () => {
    // The membership re-check sees A; a THIRD observation would see B. The stamp
    // must name A, or a later reader would think the verdict is current for B.
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/live/ComfyUI/models";
    h.liveListings["loras"] = ["new.safetensors"];
    let calls = 0;
    resolveModelsDirWithBasesMock.mockImplementation(async () => {
      calls += 1;
      return {
        // calls 1 and 2 are the membership checks (server A); anything later is B.
        modelsDir: resolve(calls <= 2 ? "/live/ComfyUI/models" : "/serverB/models"),
        baseDirs: [],
        snapshot: { reachable: true, argv: h.snapshotArgv },
        source: h.modelsDirSource,
      };
    });

    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("visible");
    expect(res.verifiedAgainstRoot).toBe(resolve("/live/ComfyUI/models"));
  });

  it("still confirms a JUNCTIONED primary models root (codex gate r6 — no false failure)", async () => {
    // `C:\ComfyUI\models` is a junction to `D:\Models`. The landed file realpaths
    // outside the lexical root; a lexical-only compare would call a correctly
    // placed, server-readable file "outside the live roots".
    const real = resolve("/D/Models/loras/new.safetensors");
    realpathMock.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === target) return real;
      if (resolve(s) === resolve("/comfy/models")) return resolve("/D/Models");
      return resolve(s);
    });
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/comfy/models";
    h.liveExtraRoots = { authoritative: true, roots: [] };
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("visible");
    expect(res.verifiedPath).toBe(real);
  });

  it("does NOT let a CHECKPOINTS extra root vouch for a LORA (codex gate r6)", async () => {
    // Live extra roots are category-scoped; a registered `checkpoints` root says
    // nothing about where the server reads loras from.
    const external = resolve("/E/Shared/loras/new.safetensors");
    realpathMock.mockImplementation(async (p: string) =>
      String(p) === target ? external : resolve(String(p)),
    );
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/serverB/models";
    h.liveExtraRoots = {
      authoritative: true,
      roots: [{ category: "checkpoints", dir: resolve("/E/Shared") }],
    };
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("not-visible");
  });

  it("still confirms a #633 destination that really lives in a registered EXTRA root", async () => {
    // A symlinked models/<link> resolving onto another drive is legitimate: the
    // landed realpath is outside the primary root but inside a live extra root.
    const external = resolve("/E/render/models/loras/new.safetensors");
    realpathMock.mockImplementation(async (p: string) =>
      String(p) === target ? external : resolve(String(p)),
    );
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/serverB/models";
    h.liveExtraRoots = {
      authoritative: true,
      roots: [{ category: "loras", dir: resolve("/E/render/models/loras") }],
    };
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("visible");
    expect(res.verifiedPath).toBe(external);
  });

  it("normalizes OS-native separators in the live listing", async () => {
    h.liveListings["loras"] = ["sub\\new.safetensors"];
    const res = await verifyLandedModel(target, "loras/sub", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("visible");
  });

  it("confirms a file landed through a category-level JUNCTION onto undeclared storage (StabilityMatrix, #870)", async () => {
    // `models/vae` is a junction to the StabilityMatrix shared store. The server
    // scans that path THROUGH the junction (its recursive_search follows links)
    // and lists the file, so membership is answered by the LEXICAL write path —
    // a realpath-only check would call the file "outside every directory the
    // server reads", the post-write twin of the pre-write refusal.
    const smTarget = resolve("/comfy/models/vae/new.safetensors");
    const real = resolve("/E/StabilityMatrix/models/VAE/new.safetensors");
    realpathMock.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === smTarget) return real;
      if (resolve(s) === resolve("/comfy/models/vae")) {
        return resolve("/E/StabilityMatrix/models/VAE");
      }
      return resolve(s);
    });
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/comfy/models";
    h.liveExtraRoots = { authoritative: true, roots: [] };
    h.liveListings["vae"] = ["new.safetensors"];
    const res = await verifyLandedModel(smTarget, "vae", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("visible");
    expect(res.verifiedPath).toBe(real);
  });

  it("confirms a file landed through a NESTED in-tree link (`models/vae/vendor -> ...`, #870 gate)", async () => {
    // The junction need not sit at the category folder: the server follows links
    // at any depth, so a file under `models/vae/vendor` is listed as
    // "vendor/new.safetensors" wherever that link points.
    const nestedTarget = resolve("/comfy/models/vae/vendor/new.safetensors");
    const real = resolve("/E/shared/vendor/new.safetensors");
    realpathMock.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === nestedTarget) return real;
      if (resolve(s) === resolve("/comfy/models/vae/vendor")) {
        return resolve("/E/shared/vendor");
      }
      return resolve(s);
    });
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/comfy/models";
    h.liveExtraRoots = { authoritative: true, roots: [] };
    h.liveListings["vae"] = ["vendor/new.safetensors"];
    const res = await verifyLandedModel(nestedTarget, "vae/vendor", {
      attempts: 1,
      retryMs: 0,
      listedBefore: false,
    });
    expect(res.liveVisible).toBe("visible");
    expect(res.verifiedPath).toBe(real);
  });

  it("reports UNKNOWN — never a false not-visible — for a diffusers file the listing contractually cannot contain (#844)", async () => {
    // /models/diffusers can never list FILES (the folder is registered with a
    // ["folder"] extension contract no file matches), so a landed file's absence
    // from it is the contract speaking, not the server. The verdict must be an
    // honest unconfirmed, not "the server does NOT list it".
    const dTarget = resolve("/live/ComfyUI/models/diffusers/model.safetensors");
    h.modelsDirSource = "observed-root";
    h.destModelsDir = "/live/ComfyUI/models";
    h.liveListings["diffusers"] = []; // what the real endpoint answers, by contract
    const res = await verifyLandedModel(dTarget, "diffusers", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("unknown");
    expect(res.verifiedPath).toBe(dTarget);
    expect(res.note).toMatch(/never lists individual files/);
    expect(res.note).not.toMatch(/does NOT list/);
  });
});
