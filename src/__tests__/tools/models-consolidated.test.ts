import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The two consolidated model tools (0.50.0 slice 11): fourteen tools folded into
 * `download_model` (8 actions) and `list_local_models` (6). This file is about
 * the ONE genuinely new layer — DISPATCH — and nothing else. The retired
 * handlers' own behaviour is still asserted by model-management.test.ts,
 * model-extras.test.ts, extra-paths.test.ts and missing-models.test.ts.
 *
 * The mocks sit at the SERVICE boundary, not at the action-function boundary, so
 * "action X reaches the same call the retired tool made" is asserted against the
 * thing that actually does the work rather than against an intermediate this
 * file could have invented.
 *
 * WHAT THIS FILE EXISTS TO PIN, above all else: `remove` DELETES A MODEL FILE and
 * now sits one enum value away from `list`. No read action may reach `unlink`,
 * and no `remove` that omitted `path` may reach it either.
 */

const mocks = vi.hoisted(() => ({
  // model-resolver
  searchHuggingFaceModels: vi.fn(),
  listLocalModels: vi.fn(),
  listLocalModelsWithCoverage: vi.fn(),
  resolveExistingModelFile: vi.fn(),
  // download-jobs
  startDownloadJob: vi.fn(),
  getDownloadJob: vi.fn(),
  findDownloadJob: vi.fn(),
  listDownloadJobs: vi.fn(),
  listDownloadJobCandidates: vi.fn(),
  cancelDownloadJob: vi.fn(),
  // civitai-resolver
  searchCivitaiModels: vi.fn(),
  searchCivitaiCreators: vi.fn(),
  fetchCivitaiTopCreators: vi.fn(),
  resolveCivitaiModel: vi.fn(),
  resolveCivitaiModelVersion: vi.fn(),
  // extra-paths service
  listExtraPaths: vi.fn(),
  addExtraPath: vi.fn(),
  removeExtraPath: vi.fn(),
  // missing-models service + comfyui client
  findMissingModels: vi.fn(),
  getObjectInfo: vi.fn(),
  fetchApi: vi.fn(),
  // node:fs/promises
  unlink: vi.fn(),
}));

vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    ...actual,
    searchHuggingFaceModels: (...a: unknown[]) => mocks.searchHuggingFaceModels(...a),
    listLocalModels: (...a: unknown[]) => mocks.listLocalModels(...a),
    listLocalModelsWithCoverage: (...a: unknown[]) => mocks.listLocalModelsWithCoverage(...a),
    resolveExistingModelFile: (...a: unknown[]) => mocks.resolveExistingModelFile(...a),
    currentLiveModelsRoot: async () => undefined,
  };
});

vi.mock("../../services/download-jobs.js", () => ({
  startDownloadJob: (...a: unknown[]) => mocks.startDownloadJob(...a),
  getDownloadJob: (...a: unknown[]) => mocks.getDownloadJob(...a),
  findDownloadJob: (...a: unknown[]) => mocks.findDownloadJob(...a),
  listDownloadJobs: (...a: unknown[]) => mocks.listDownloadJobs(...a),
  listDownloadJobCandidates: (...a: unknown[]) => mocks.listDownloadJobCandidates(...a),
  cancelDownloadJob: (...a: unknown[]) => mocks.cancelDownloadJob(...a),
  describePlacement: () => ({
    confirmed: false,
    wrongPlace: false,
    pathLabel: "written to",
    pathQualifier: " (UNCONFIRMED)",
    warning: "no live server in this test",
  }),
}));

vi.mock("../../services/civitai-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/civitai-resolver.js")>(
    "../../services/civitai-resolver.js",
  );
  return {
    ...actual,
    searchCivitaiModels: (...a: unknown[]) => mocks.searchCivitaiModels(...a),
    searchCivitaiCreators: (...a: unknown[]) => mocks.searchCivitaiCreators(...a),
    fetchCivitaiTopCreators: (...a: unknown[]) => mocks.fetchCivitaiTopCreators(...a),
    resolveCivitaiModel: (...a: unknown[]) => mocks.resolveCivitaiModel(...a),
    resolveCivitaiModelVersion: (...a: unknown[]) => mocks.resolveCivitaiModelVersion(...a),
  };
});

vi.mock("../../services/extra-paths.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/extra-paths.js")>(
    "../../services/extra-paths.js",
  );
  return {
    ...actual,
    listExtraPaths: (...a: unknown[]) => mocks.listExtraPaths(...a),
    addExtraPath: (...a: unknown[]) => mocks.addExtraPath(...a),
    removeExtraPath: (...a: unknown[]) => mocks.removeExtraPath(...a),
  };
});

vi.mock("../../services/missing-models.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/missing-models.js")>(
    "../../services/missing-models.js",
  );
  return {
    ...actual,
    findMissingModels: (...a: unknown[]) => mocks.findMissingModels(...a),
  };
});

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: (...a: unknown[]) => mocks.getObjectInfo(...a),
  getSystemStats: async () => ({ devices: [] }),
  getClient: () => ({ fetchApi: (...a: unknown[]) => mocks.fetchApi(...a) }),
}));

// The delete path. Mocked at node:fs/promises so "did anything unlink?" is
// answerable for EVERY action, not just the one that is supposed to.
vi.mock("node:fs/promises", () => ({
  unlink: (...a: unknown[]) => mocks.unlink(...a),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  link: vi.fn(),
  utimes: vi.fn(),
  realpath: (p: string) => Promise.resolve(p),
}));

vi.mock("../../config.js", () => {
  const config = { comfyuiPath: "/comfy" as string | undefined, civitaiApiToken: undefined };
  return { config, isLocalMode: () => Boolean(config.comfyuiPath), isRemoteMode: () => !config.comfyuiPath };
});

import { registerModelManagementTools } from "../../tools/model-management.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    // The SDK's `tool()` is overloaded: the callback is the LAST argument, and an
    // optional annotations object (#1106) sits before it. Resolve by TYPE the way the
    // real SDK does, so adding annotations to a tool cannot break this fake.
    tool: (name: string, _desc: string, shape: z.ZodRawShape, ...rest: unknown[]) => {
      const handler = rest.find((a) => typeof a === "function") as Handler;
      tools.push({ name, shape, handler });
    },
  };
  registerModelManagementTools(server as never);
  return tools;
}

function tool(name: string): Registered {
  const found = registered().find((t) => t.name === name);
  expect(found, `${name} must be registered`).toBeDefined();
  return found!;
}

const download = () => tool("download_model").handler;
const inventory = () => tool("list_local_models").handler;
const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

/** Only `action` may be schema-required — asserted with the SDK's own options. */
function jsonSchema(shape: z.ZodRawShape) {
  return z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
    properties?: Record<string, { enum?: string[] }>;
    required?: string[];
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  // A settled, still-downloading job keeps the download branches off the grace
  // timer without asserting anything about placement.
  mocks.startDownloadJob.mockResolvedValue({
    job: { id: "job-1", trayId: "tray-1", status: "downloading", started_at: Date.now(), url: "u" },
    settled: Promise.resolve(),
  });
  mocks.listDownloadJobs.mockReturnValue([]);
  mocks.listDownloadJobCandidates.mockReturnValue([]);
  mocks.cancelDownloadJob.mockReturnValue({ found: false, owned: false, aborted: false });
  mocks.searchHuggingFaceModels.mockResolvedValue([]);
  mocks.listLocalModels.mockResolvedValue([]);
  // #918: the listing now carries HOW it knows. An empty list with every category
  // ANSWERED is the verified-empty case these tests mean by "no models".
  mocks.listLocalModelsWithCoverage.mockResolvedValue({
    models: [],
    coverage: { answered: ["checkpoints"], unanswered: [], usedFilesystem: false },
  });
  mocks.searchCivitaiModels.mockResolvedValue({ hits: [] });
  mocks.searchCivitaiCreators.mockResolvedValue({ hits: [] });
  mocks.fetchCivitaiTopCreators.mockResolvedValue([]);
  mocks.listExtraPaths.mockResolvedValue({ target: "standalone", groups: [] });
  mocks.addExtraPath.mockResolvedValue({ changed: true });
  mocks.removeExtraPath.mockResolvedValue({ changed: true });
  mocks.getObjectInfo.mockResolvedValue({});
  mocks.findMissingModels.mockReturnValue([]);
  mocks.fetchApi.mockResolvedValue({ json: async () => [] });
  mocks.resolveExistingModelFile.mockResolvedValue({
    path: "/comfy/models/loras/x.safetensors",
    info: { isFile: () => true, size: 1024 },
  });
  mocks.unlink.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Registration + schema shape
// ---------------------------------------------------------------------------

describe("registration (14 → 2)", () => {
  it("registers exactly two tools, download_model first", () => {
    const tools = registered();
    expect(tools.map((t) => t.name)).toEqual(["download_model", "list_local_models"]);
  });

  // The whole reason for the flat-enum rule: a z.discriminatedUnion renders as
  // ZERO parameters, hiding every input from the model.
  it("download_model exposes a visible flat `action` enum, with `action` the only required field", () => {
    const json = jsonSchema(tool("download_model").shape);
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "auth",
      "base_models",
      "board",
      "creator",
      "filename",
      "filter",
      "id",
      "limit",
      "model_id",
      "model_version_id",
      "nsfw",
      "query",
      "sort",
      "target_subfolder",
      "tray_id",
      "types",
      "url",
      "workflow",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "cancel",
      "download",
      "download_civitai",
      "resolve_missing",
      "search",
      "search_civitai",
      "search_creators",
      "status",
    ]);
    expect(json.required).toEqual(["action"]);
  });

  it("list_local_models exposes a visible flat `action` enum, with `action` the only required field", () => {
    const json = jsonSchema(tool("list_local_models").shape);
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "category",
      "config_path",
      "group",
      "is_default",
      "model_type",
      "path",
      "target",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "add_path",
      "embeddings",
      "list",
      "list_paths",
      "remove",
      "remove_path",
    ]);
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action on either tool returns a clear error naming the valid ones", async () => {
    const a = await download()({ action: "bogus" });
    expect(a.isError).toBe(true);
    expect(text(a)).toMatch(/Unknown download_model action/i);
    expect(text(a)).toMatch(/resolve_missing/);

    const b = await inventory()({ action: "bogus" });
    expect(b.isError).toBe(true);
    expect(text(b)).toMatch(/Unknown list_local_models action/i);
    expect(text(b)).toMatch(/remove_path/);
  });
});

// ---------------------------------------------------------------------------
// Per-action dispatch — same service, same arguments
// ---------------------------------------------------------------------------

describe("download_model dispatch", () => {
  it('action:"search" reaches searchHuggingFaceModels with query/filter/limit', async () => {
    await download()({ action: "search", query: "flux", filter: "diffusers", limit: 5 });
    expect(mocks.searchHuggingFaceModels).toHaveBeenCalledWith("flux", {
      filter: "diffusers",
      limit: 5,
    });
  });

  it('action:"download" reaches startDownloadJob with url/subfolder/filename/auth', async () => {
    const auth = { type: "header", header_name: "X-Api-Key", header_value: "…" } as const;
    await download()({
      action: "download",
      url: "https://example.com/x.safetensors",
      target_subfolder: "checkpoints",
      filename: "x.safetensors",
      auth,
    });
    expect(mocks.startDownloadJob).toHaveBeenCalledWith(
      "https://example.com/x.safetensors",
      "checkpoints",
      "x.safetensors",
      auth,
    );
  });

  it('action:"status" resolves by id + tray_id, and lists everything with no selector', async () => {
    mocks.getDownloadJob.mockReturnValueOnce(undefined);
    await download()({ action: "status", id: "abc", tray_id: "tray-9" });
    expect(mocks.getDownloadJob).toHaveBeenCalledWith("abc", "tray-9");

    await download()({ action: "status" });
    expect(mocks.listDownloadJobs).toHaveBeenCalled();
  });

  it('action:"status" adopts an in-flight download by url when no id is given', async () => {
    mocks.findDownloadJob.mockReturnValueOnce(undefined);
    await download()({ action: "status", url: "https://example.com/x.safetensors" });
    expect(mocks.findDownloadJob).toHaveBeenCalledWith({
      url: "https://example.com/x.safetensors",
    });
  });

  // The cancel target is identified exactly as before: the composite (id, trayId),
  // never a positional guess.
  it('action:"cancel" reaches cancelDownloadJob with the same (id, tray_id) handle', async () => {
    await download()({ action: "cancel", id: "abc", tray_id: "tray-9" });
    expect(mocks.cancelDownloadJob).toHaveBeenCalledWith("abc", "tray-9");
  });

  // A cancel of an id nothing answers to must still report NOT FOUND, with the
  // same advice, rather than a generic failure — folding must not blur "there is
  // no such download" into "something went wrong".
  it('action:"cancel" on an unknown id reports it as not found, not as a generic error', async () => {
    mocks.cancelDownloadJob.mockReturnValueOnce({ found: false, owned: false, aborted: false });
    const res = await download()({ action: "cancel", id: "nope" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("No download with id `nope` to cancel");
    expect(text(res)).toMatch(/already finished and been pruned, or the id is wrong/);
  });

  it('action:"search_civitai" reaches searchCivitaiModels with every filter mapped', async () => {
    await download()({
      action: "search_civitai",
      query: "detail",
      creator: "alcaitiff",
      types: ["LORA"],
      base_models: ["Flux.1 D"],
      sort: "Newest",
      nsfw: true,
      limit: 5,
    });
    expect(mocks.searchCivitaiModels).toHaveBeenCalledWith("detail", {
      types: ["LORA"],
      baseModels: ["Flux.1 D"],
      sort: "Newest",
      nsfw: true,
      limit: 5,
      creator: "alcaitiff",
    });
  });

  it('action:"search_creators" searches usernames with a query and the leaderboard without', async () => {
    await download()({ action: "search_creators", query: "alcait", limit: 5 });
    expect(mocks.searchCivitaiCreators).toHaveBeenCalledWith("alcait", { limit: 5 });
    expect(mocks.fetchCivitaiTopCreators).not.toHaveBeenCalled();

    await download()({ action: "search_creators", board: "new_creators" });
    expect(mocks.fetchCivitaiTopCreators).toHaveBeenCalledWith({
      board: "new_creators",
      limit: undefined,
    });
  });

  it('action:"download_civitai" resolves by model_id or model_version_id, as before', async () => {
    mocks.resolveCivitaiModel.mockResolvedValueOnce({
      downloadUrl: "https://civitai.com/api/download/models/201",
      filename: "cool.safetensors",
      versionId: 201,
    });
    await download()({ action: "download_civitai", model_id: 100, target_subfolder: "loras" });
    expect(mocks.resolveCivitaiModel).toHaveBeenCalledWith(100, undefined);

    mocks.resolveCivitaiModelVersion.mockResolvedValueOnce({
      downloadUrl: "https://civitai.com/api/download/models/55",
      versionId: 55,
    });
    await download()({ action: "download_civitai", model_version_id: 55, target_subfolder: "loras" });
    expect(mocks.resolveCivitaiModelVersion).toHaveBeenCalledWith(55);
  });

  it('action:"resolve_missing" parses the workflow and asks findMissingModels about it', async () => {
    mocks.getObjectInfo.mockResolvedValueOnce({ CheckpointLoaderSimple: {} });
    await download()({
      action: "resolve_missing",
      workflow: { "1": { class_type: "CheckpointLoaderSimple", inputs: {} } },
    });
    expect(mocks.findMissingModels).toHaveBeenCalledWith(
      { "1": { class_type: "CheckpointLoaderSimple", inputs: {} } },
      { CheckpointLoaderSimple: {} },
    );
  });
});

describe("list_local_models dispatch", () => {
  it('action:"list" reaches the model listing with the model_type filter', async () => {
    await inventory()({ action: "list", model_type: "loras" });
    // #918 moved the call to the coverage-carrying entry point. The filter still
    // has to reach the resolver, which is what this has always been pinning.
    expect(mocks.listLocalModelsWithCoverage).toHaveBeenCalledWith("loras");
  });

  it('action:"embeddings" reads the connected server\'s /api/embeddings', async () => {
    await inventory()({ action: "embeddings" });
    expect(mocks.fetchApi).toHaveBeenCalledWith("/api/embeddings");
  });

  it('action:"list_paths" reaches listExtraPaths with target + configPath', async () => {
    await inventory()({ action: "list_paths", target: "desktop", config_path: "c.yaml" });
    expect(mocks.listExtraPaths).toHaveBeenCalledWith({ target: "desktop", configPath: "c.yaml" });
  });

  it('action:"add_path" reaches addExtraPath with every option, is_default → isDefault', async () => {
    await inventory()({
      action: "add_path",
      target: "standalone",
      config_path: "c.yaml",
      group: "shared",
      category: "checkpoints",
      path: "E:/Models/checkpoints",
      is_default: true,
    });
    expect(mocks.addExtraPath).toHaveBeenCalledWith({
      target: "standalone",
      configPath: "c.yaml",
      group: "shared",
      category: "checkpoints",
      path: "E:/Models/checkpoints",
      isDefault: true,
    });
  });

  it('action:"remove_path" reaches removeExtraPath — and NEVER the model-file delete', async () => {
    await inventory()({ action: "remove_path", category: "loras", path: "E:/Models/loras" });
    expect(mocks.removeExtraPath).toHaveBeenCalledWith({
      target: undefined,
      configPath: undefined,
      group: undefined,
      category: "loras",
      path: "E:/Models/loras",
    });
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.resolveExistingModelFile).not.toHaveBeenCalled();
  });

  it('action:"remove" resolves the path across roots and unlinks exactly that file', async () => {
    const res = await inventory()({ action: "remove", path: "loras/x.safetensors" });
    expect(mocks.resolveExistingModelFile).toHaveBeenCalledWith("loras/x.safetensors");
    expect(mocks.unlink).toHaveBeenCalledWith("/comfy/models/loras/x.safetensors");
    expect(text(res)).toContain("Removed model:");
  });
});

// ---------------------------------------------------------------------------
// The delete guard — the highest-risk property in this slice
// ---------------------------------------------------------------------------

describe('nothing but action:"remove" can delete a model file', () => {
  // `path` is shared between remove (a model FILE to unlink) and
  // add_path/remove_path (a DIRECTORY for the YAML). Passing one while asking
  // for the other must not delete anything: it is the ACTION that selects the
  // delete, and this is the test that says so.
  it("every non-remove action leaves unlink untouched, even when `path` is supplied", async () => {
    const calls: Array<[Handler, Record<string, unknown>]> = [
      [inventory(), { action: "list", path: "loras/x.safetensors" }],
      [inventory(), { action: "embeddings", path: "loras/x.safetensors" }],
      [inventory(), { action: "list_paths", path: "loras/x.safetensors" }],
      [inventory(), { action: "add_path", category: "loras", path: "E:/Models/loras" }],
      [inventory(), { action: "remove_path", category: "loras", path: "E:/Models/loras" }],
      [inventory(), { action: "bogus", path: "loras/x.safetensors" }],
    ];
    for (const [handler, args] of calls) {
      await handler(args);
    }
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("no download_model action can delete a model file either", async () => {
    for (const action of [
      "download",
      "status",
      "cancel",
      "search",
      "search_civitai",
      "search_creators",
      "download_civitai",
      "resolve_missing",
    ]) {
      await download()({
        action,
        path: "loras/x.safetensors",
        id: "x",
        query: "x",
        url: "https://example.com/x.safetensors",
        target_subfolder: "loras",
        model_id: 1,
        workflow: {},
      });
    }
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  // The guard is ABSENCE-based, and it must run BEFORE anything resolves a path.
  it('action:"remove" without `path` names the field and touches nothing', async () => {
    const res = await inventory()({ action: "remove" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('list_local_models action:"remove" requires `path`');
    expect(mocks.resolveExistingModelFile).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  // `path: ""` was a SCHEMA rejection before the fold (z.string().min(1)) and
  // still is — the merged field kept `.min(1)` because every action that uses
  // `path` had it. Asserted on the schema, since a schema rejection never
  // reaches the handler.
  it("an empty `path` is still rejected by the schema, so it cannot reach the delete", () => {
    const shape = tool("list_local_models").shape;
    expect(z.object(shape).safeParse({ action: "remove", path: "" }).success).toBe(false);
    expect(z.object(shape).safeParse({ action: "remove", path: "loras/x" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-action presence guards (the flat shape cannot schema-require these)
// ---------------------------------------------------------------------------

describe("missing-field errors NAME the field and call nothing", () => {
  it("download_model per-action required fields", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "download", target_subfolder: "loras" }, "`url`"],
      [{ action: "download", url: "https://example.com/x.safetensors" }, "`target_subfolder`"],
      [{ action: "cancel" }, "`id`"],
      [{ action: "search" }, "`query`"],
      [{ action: "download_civitai", model_id: 1 }, "`target_subfolder`"],
      [{ action: "resolve_missing" }, "`workflow`"],
    ];
    for (const [args, field] of cases) {
      const res = await download()(args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(text(res)).toContain(`action:"${args.action}" requires ${field}`);
    }
    expect(mocks.startDownloadJob).not.toHaveBeenCalled();
    expect(mocks.cancelDownloadJob).not.toHaveBeenCalled();
    expect(mocks.searchHuggingFaceModels).not.toHaveBeenCalled();
    expect(mocks.resolveCivitaiModel).not.toHaveBeenCalled();
    expect(mocks.getObjectInfo).not.toHaveBeenCalled();
  });

  it("list_local_models per-action required fields", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "remove" }, "`path`"],
      [{ action: "add_path", path: "E:/x" }, "`category`"],
      [{ action: "add_path", category: "loras" }, "`path`"],
      [{ action: "remove_path", path: "E:/x" }, "`category`"],
      [{ action: "remove_path", category: "loras" }, "`path`"],
    ];
    for (const [args, field] of cases) {
      const res = await inventory()(args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(text(res)).toContain(`action:"${args.action}" requires ${field}`);
    }
    expect(mocks.addExtraPath).not.toHaveBeenCalled();
    expect(mocks.removeExtraPath).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Absence, not falsiness — and the merged value constraints
// ---------------------------------------------------------------------------

describe("guards test ABSENCE, not falsiness", () => {
  // `query: ""` passed z.string() on the retired HuggingFace search and reached
  // the service, which answers for itself. A `!query` guard would swallow that.
  it('action:"search" with an empty query still reaches the service, as before', async () => {
    await download()({ action: "search", query: "" });
    expect(mocks.searchHuggingFaceModels).toHaveBeenCalledWith("", {
      filter: undefined,
      limit: undefined,
    });
  });

  // `id: ""` passed z.string().optional() on the retired status tool and made it
  // a full listing. Unchanged.
  it('action:"status" with an empty id still lists everything, as before', async () => {
    await download()({ action: "status", id: "" });
    expect(mocks.listDownloadJobs).toHaveBeenCalled();
  });

  // `model_id: 0` is rejected by z.number().positive() exactly as before — the
  // presence guard must not be what refuses it, or a 0 would read as "missing".
  it("a zero model_id is a schema rejection, not a missing-field error", () => {
    const shape = tool("download_model").shape;
    expect(
      z.object(shape).safeParse({ action: "download_civitai", target_subfolder: "loras", model_id: 0 })
        .success,
    ).toBe(false);
  });

  // The two CivitAI searches carried `.min(1)` on `query`; the merged field had
  // to drop it so action:"search" keeps accepting "". The refusal moved into the
  // handler rather than disappearing.
  it('the retired `.min(1)` on query is still enforced for the CivitAI actions', async () => {
    for (const action of ["search_civitai", "search_creators"]) {
      const res = await download()({ action, query: "" });
      expect(res.isError, action).toBe(true);
      expect(text(res)).toContain(`action:"${action}" requires a non-empty \`query\``);
    }
    expect(mocks.searchCivitaiModels).not.toHaveBeenCalled();
    expect(mocks.searchCivitaiCreators).not.toHaveBeenCalled();
    expect(mocks.fetchCivitaiTopCreators).not.toHaveBeenCalled();
  });

  // Same shape for `id`, and this is the asymmetric one: the retired cancel tool
  // had `.min(1)`, the retired status tool did not, and "" means "list
  // everything" for status. So the refusal has to be per-ACTION — an empty id
  // still lists for status (above) and is still refused for cancel.
  it('the retired `.min(1)` on id is still enforced for action:"cancel" only', async () => {
    const res = await download()({ action: "cancel", id: "" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"cancel" requires a non-empty `id`');
    expect(mocks.cancelDownloadJob).not.toHaveBeenCalled();
  });

  // Each retired search capped `limit` differently, and two of the services do
  // not clamp — so widening to one schema ceiling would have let a caller ask
  // for more than the tool ever accepted.
  it("the per-action limit ceilings survive the merge", async () => {
    const overs: Array<[string, number, number]> = [
      ["search_civitai", 30, 25],
      ["resolve_missing", 30, 20],
    ];
    for (const [action, limit, max] of overs) {
      const res = await download()({
        action,
        limit,
        query: "x",
        workflow: {},
      });
      expect(res.isError, action).toBe(true);
      expect(text(res)).toContain(`accepts \`limit\` up to ${max} (got ${limit})`);
    }
    expect(mocks.searchCivitaiModels).not.toHaveBeenCalled();
    expect(mocks.findMissingModels).not.toHaveBeenCalled();

    // …and a limit the action always allowed still gets through.
    await download()({ action: "search_civitai", query: "x", limit: 25 });
    expect(mocks.searchCivitaiModels).toHaveBeenCalledWith("x", expect.objectContaining({ limit: 25 }));
  });
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

describe("the twelve retired model names", () => {
  const retired: Record<string, string> = {
    search_models: 'download_model (action:"search")',
    download_status: 'download_model (action:"status")',
    cancel_download: 'download_model (action:"cancel")',
    search_civitai_models: 'download_model (action:"search_civitai")',
    search_civitai_creators: 'download_model (action:"search_creators")',
    download_civitai_model: 'download_model (action:"download_civitai")',
    resolve_missing_models: 'download_model (action:"resolve_missing")',
    remove_model: 'list_local_models (action:"remove")',
    get_embeddings: 'list_local_models (action:"embeddings")',
    list_extra_paths: 'list_local_models (action:"list_paths")',
    add_extra_path: 'list_local_models (action:"add_path")',
    remove_extra_path: 'list_local_models (action:"remove_path")',
  };

  it("each is in DEAD_NAMES with its exact replacement", () => {
    for (const [name, replacement] of Object.entries(retired)) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toBe(replacement);
    }
  });

  it("none is still in the live ledger, and both survivors are", () => {
    for (const name of Object.keys(retired)) {
      expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    }
    expect(TOOL_NAMES as readonly string[]).toContain("download_model");
    expect(TOOL_NAMES as readonly string[]).toContain("list_local_models");
  });
});
