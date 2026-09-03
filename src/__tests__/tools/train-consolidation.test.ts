import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The three consolidated training tools (0.50.0 slice 10): the eighteen train_*
 * tools folded by WORK-DOMAIN into `train_prepare_dataset` (datasets),
 * `train_start` (jobs) and `train_doctor` (the trainer itself).
 *
 * Proves the consolidation did not change behaviour — every action calls the
 * identical service the old tool called, with the same arguments — and that the
 * flat-enum shape actually EXPOSES its parameters (the discriminated-union trap
 * renders zero params).
 *
 * The load-bearing test in this file is the DELETE PAIR. Two actions share the
 * name `delete` across two tools with wildly different blast radii: a job's
 * record + checkpoints, versus a whole hand-curated dataset of images and
 * captions. Both directions are pinned, in both the dispatch and the prose, so a
 * future edit cannot quietly wire one to the other or blur the descriptions that
 * keep a model off the wrong one.
 */

const mocks = vi.hoisted(() => ({
  // training-jobs.js
  prepareDataset: vi.fn(),
  startTrainingJob: vi.fn(),
  getJob: vi.fn(),
  listJobs: vi.fn(),
  cancelJob: vi.fn(),
  deleteJob: vi.fn(),
  trainingRoot: vi.fn(() => "/train"),
  hfCacheRoot: vi.fn(() => "/hf"),
  // training-datasets.js
  listDatasets: vi.fn(),
  getDataset: vi.fn(),
  updateDataset: vi.fn(),
  deleteDataset: vi.fn(),
  readTrainingFile: vi.fn(),
  getJobConfig: vi.fn(),
  previewConfig: vi.fn(),
  // train-caption.js
  captionImage: vi.fn(),
  captionDataset: vi.fn(),
  // ai-toolkit.js
  dockerAvailable: vi.fn(),
  trainerImageExists: vi.fn(),
  trainerDoctor: vi.fn(),
  buildTrainerImage: vi.fn(),
  nativeToolkitReady: vi.fn(),
  // trainer-bootstrap.js
  bootstrapStatus: vi.fn(),
  bootstrapToolkit: vi.fn(),
}));

vi.mock("../../services/training-jobs.js", () => ({
  prepareDataset: (...a: unknown[]) => mocks.prepareDataset(...a),
  startTrainingJob: (...a: unknown[]) => mocks.startTrainingJob(...a),
  getJob: (...a: unknown[]) => mocks.getJob(...a),
  listJobs: (...a: unknown[]) => mocks.listJobs(...a),
  cancelJob: (...a: unknown[]) => mocks.cancelJob(...a),
  deleteJob: (...a: unknown[]) => mocks.deleteJob(...a),
  trainingRoot: () => mocks.trainingRoot(),
  hfCacheRoot: () => mocks.hfCacheRoot(),
}));
vi.mock("../../services/training-datasets.js", () => ({
  listDatasets: (...a: unknown[]) => mocks.listDatasets(...a),
  getDataset: (...a: unknown[]) => mocks.getDataset(...a),
  updateDataset: (...a: unknown[]) => mocks.updateDataset(...a),
  deleteDataset: (...a: unknown[]) => mocks.deleteDataset(...a),
  readTrainingFile: (...a: unknown[]) => mocks.readTrainingFile(...a),
  getJobConfig: (...a: unknown[]) => mocks.getJobConfig(...a),
  previewConfig: (...a: unknown[]) => mocks.previewConfig(...a),
}));
vi.mock("../../services/train-caption.js", () => ({
  captionImage: (...a: unknown[]) => mocks.captionImage(...a),
  captionDataset: (...a: unknown[]) => mocks.captionDataset(...a),
}));
// TRAINER_COMMAND comes from the REAL module rather than a literal: the command
// names are vocabulary-gated, so spelling one here would either trip check:vocabulary
// or silently drift from the name the tool actually reports. Everything else stays
// explicitly mocked — this is not a partial passthrough.
vi.mock("../../services/ai-toolkit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/ai-toolkit.js")>();
  return {
    TRAINER_IMAGE: "trainer:test",
    TRAINER_COMMAND: actual.TRAINER_COMMAND,
    dockerAvailable: (...a: unknown[]) => mocks.dockerAvailable(...a),
    trainerImageExists: (...a: unknown[]) => mocks.trainerImageExists(...a),
    trainerDoctor: (...a: unknown[]) => mocks.trainerDoctor(...a),
    buildTrainerImage: (...a: unknown[]) => mocks.buildTrainerImage(...a),
    nativeToolkitReady: (...a: unknown[]) => mocks.nativeToolkitReady(...a),
  };
});
vi.mock("../../services/trainer-bootstrap.js", () => ({
  bootstrapStatus: (...a: unknown[]) => mocks.bootstrapStatus(...a),
  bootstrapToolkit: (...a: unknown[]) => mocks.bootstrapToolkit(...a),
}));
vi.mock("../../services/runpod-watch.js", () => ({ getRunpodWatcher: () => undefined }));
vi.mock("../../services/output-dir.js", () => ({
  resolveOutputDir: () => Promise.resolve("/comfy/output"),
  resolveInputDir: () => Promise.resolve("/comfy/input"),
}));
vi.mock("../../config.js", () => ({ isRemoteMode: () => false, config: { huggingfaceToken: undefined } }));

import { registerTrainTools } from "../../tools/train.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}>;

interface Registered {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, description: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, description, shape, handler });
    },
  };
  registerTrainTools(server as never);
  return tools;
}

function tool(name: string): Registered {
  const found = registered().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

const handler = (name: string): Handler => tool(name).handler;
const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text ?? "").join(" ");

/** The schema a CLIENT is actually given — the SDK's own conversion options. */
function inputSchema(name: string) {
  return z.toJSONSchema(z.object(tool(name).shape), { reused: "inline", io: "input" }) as {
    properties?: Record<string, { enum?: string[] }>;
    required?: string[];
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.trainingRoot.mockReturnValue("/train");
  mocks.hfCacheRoot.mockReturnValue("/hf");
});

describe("training registration (18 → 3)", () => {
  it("registers exactly three tools, in the ledger's order", () => {
    // Registration order IS tools/list order and is pinned by
    // registry-surface.test.ts; the three survivors keep their relative
    // positions from the pre-fold surface.
    expect(registered().map((t) => t.name)).toEqual([
      "train_prepare_dataset",
      "train_start",
      "train_doctor",
    ]);
  });

  it("exposes a visible flat `action` enum on each, with only `action` required", () => {
    const dataset = inputSchema("train_prepare_dataset");
    expect(dataset.properties?.action.enum?.slice().sort()).toEqual([
      "caption_dataset",
      "caption_image",
      "delete",
      "detail",
      "file",
      "list",
      "prepare",
      "update",
    ]);
    expect(Object.keys(dataset.properties ?? {}).sort()).toEqual([
      "action",
      "defaultCaption",
      "deleteImages",
      "guide",
      "items",
      "name",
      "only",
      "path",
      "setCaptions",
      "trigger",
    ]);
    expect(dataset.required).toEqual(["action"]);

    const jobs = inputSchema("train_start");
    expect(jobs.properties?.action.enum?.slice().sort()).toEqual([
      "cancel",
      "delete",
      "job_config",
      "list_flows",
      "preview_config",
      "start",
      "status",
    ]);
    expect(Object.keys(jobs.properties ?? {}).sort()).toEqual([
      "action",
      "datasetPath",
      "deliverTo",
      "device",
      "flow",
      "id",
      "keep_outputs",
      "model",
      "model_path",
      "name",
      "params",
      "pod_id",
      "target",
      "trigger",
    ]);
    expect(jobs.required).toEqual(["action"]);

    const doctor = inputSchema("train_doctor");
    expect(doctor.properties?.action.enum?.slice().sort()).toEqual(["bootstrap", "build_image", "doctor"]);
    expect(Object.keys(doctor.properties ?? {}).sort()).toEqual(["action", "aiToolkitRef", "pod_id", "target"]);
    expect(doctor.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result naming the valid actions", async () => {
    const ds = await handler("train_prepare_dataset")({ action: "bogus" });
    expect(ds.isError).toBe(true);
    expect(text(ds)).toMatch(/unknown train_prepare_dataset action/i);
    expect(text(ds)).toMatch(/caption_dataset/);

    const jobs = await handler("train_start")({ action: "bogus" });
    expect(jobs.isError).toBe(true);
    expect(text(jobs)).toMatch(/unknown train_start action/i);
    expect(text(jobs)).toMatch(/preview_config/);

    const doc = await handler("train_doctor")({ action: "bogus" });
    expect(doc.isError).toBe(true);
    expect(text(doc)).toMatch(/unknown train_doctor action/i);
    expect(text(doc)).toMatch(/build_image/);
  });
});

describe("train_prepare_dataset actions call the same services with the same arguments", () => {
  it('action:"prepare" resolves items and forwards name/items/defaultCaption', async () => {
    mocks.prepareDataset.mockResolvedValueOnce({ datasetPath: "/train/datasets/aria", imageCount: 1 });
    const res = await handler("train_prepare_dataset")({
      action: "prepare",
      name: "aria",
      items: [{ path: "/pics/a.png", caption: "c" }],
      defaultCaption: "ohwx",
    });
    expect(mocks.prepareDataset).toHaveBeenCalledWith({
      name: "aria",
      items: [{ path: "/pics/a.png", caption: "c" }],
      defaultCaption: "ohwx",
    });
    expect(JSON.parse(text(res))).toEqual({ ok: true, datasetPath: "/train/datasets/aria", imageCount: 1 });
  });

  it('action:"list" returns the dataset list', async () => {
    mocks.listDatasets.mockReturnValueOnce([{ name: "aria", images: 12 }]);
    const res = await handler("train_prepare_dataset")({ action: "list" });
    expect(mocks.listDatasets).toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ ok: true, datasets: [{ name: "aria", images: 12 }] });
  });

  it('action:"detail" reads one dataset by name', async () => {
    mocks.getDataset.mockReturnValueOnce({ datasetPath: "/train/datasets/aria", images: [] });
    const res = await handler("train_prepare_dataset")({ action: "detail", name: "aria" });
    expect(mocks.getDataset).toHaveBeenCalledWith("aria");
    expect(JSON.parse(text(res))).toEqual({ ok: true, datasetPath: "/train/datasets/aria", images: [] });
  });

  it('action:"update" forwards setCaptions/deleteImages exactly as before', async () => {
    mocks.updateDataset.mockResolvedValueOnce({ warnings: [] });
    const res = await handler("train_prepare_dataset")({
      action: "update",
      name: "aria",
      setCaptions: { "img_00001.png": "ohwx smiling" },
      deleteImages: ["img_00002.png"],
    });
    expect(mocks.updateDataset).toHaveBeenCalledWith("aria", {
      setCaptions: { "img_00001.png": "ohwx smiling" },
      deleteImages: ["img_00002.png"],
    });
    expect(JSON.parse(text(res))).toEqual({ ok: true, warnings: [] });
  });

  it('action:"file" returns the inline IMAGE block, not JSON', async () => {
    mocks.readTrainingFile.mockReturnValueOnce({ data: "BASE64", mimeType: "image/png" });
    const res = await handler("train_prepare_dataset")({ action: "file", path: "/train/datasets/aria/img_00001.png" });
    expect(mocks.readTrainingFile).toHaveBeenCalledWith("/train/datasets/aria/img_00001.png");
    expect(res.content).toEqual([{ type: "image", data: "BASE64", mimeType: "image/png" }]);
  });

  it('action:"caption_image" returns the bare caption and writes nothing', async () => {
    mocks.captionImage.mockResolvedValueOnce("ohwx person in a cafe");
    const res = await handler("train_prepare_dataset")({
      action: "caption_image",
      path: "/train/datasets/aria/img_00001.png",
      guide: "outfits",
      trigger: "ohwx",
    });
    expect(mocks.captionImage).toHaveBeenCalledWith({
      imagePath: "/train/datasets/aria/img_00001.png",
      guide: "outfits",
      trigger: "ohwx",
    });
    expect(JSON.parse(text(res))).toEqual({ ok: true, caption: "ohwx person in a cafe" });
    expect(mocks.updateDataset).not.toHaveBeenCalled();
  });

  it('action:"caption_dataset" forwards guide/trigger/only', async () => {
    mocks.captionDataset.mockResolvedValueOnce({ captioned: 3, failures: [] });
    const res = await handler("train_prepare_dataset")({
      action: "caption_dataset",
      name: "aria",
      guide: "outfits",
      trigger: "ohwx",
      only: ["img_00001.png"],
    });
    expect(mocks.captionDataset).toHaveBeenCalledWith("aria", {
      guide: "outfits",
      trigger: "ohwx",
      only: ["img_00001.png"],
    });
    expect(JSON.parse(text(res))).toEqual({ ok: true, captioned: 3, failures: [] });
  });
});

describe("train_start actions call the same services with the same arguments", () => {
  it('action:"start" preflights docker and forwards the whole job spec', async () => {
    mocks.dockerAvailable.mockResolvedValue(true);
    mocks.trainerImageExists.mockResolvedValue(true);
    mocks.startTrainingJob.mockResolvedValueOnce({ id: "t8f3k2ab", status: "queued" });
    const res = await handler("train_start")({
      action: "start",
      name: "aria_character",
      datasetPath: "/train/datasets/aria",
      trigger: "ohwx",
      params: { steps: 200 },
      device: "cuda:1",
      target: "local",
      deliverTo: "both",
      model_path: undefined,
    });
    expect(mocks.startTrainingJob).toHaveBeenCalledWith({
      name: "aria_character",
      flow: undefined,
      model: undefined,
      datasetPath: "/train/datasets/aria",
      trigger: "ohwx",
      params: { steps: 200 },
      device: "cuda:1",
      target: "local",
      podEndpoint: undefined,
      podId: undefined,
      native: false,
      deliverTo: "both",
      modelPath: undefined,
    });
    expect(JSON.parse(text(res))).toEqual({ ok: true, job: { id: "t8f3k2ab", status: "queued" } });
  });

  it('action:"status" reads ONE job when `id` is given', async () => {
    mocks.getJob.mockResolvedValueOnce({ id: "t8f3k2ab", status: "running" });
    const res = await handler("train_start")({ action: "status", id: "t8f3k2ab" });
    expect(mocks.getJob).toHaveBeenCalledWith("t8f3k2ab");
    expect(mocks.listJobs).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ ok: true, job: { id: "t8f3k2ab", status: "running" } });
  });

  it('action:"status" lists ALL jobs when `id` is omitted', async () => {
    mocks.listJobs.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    const res = await handler("train_start")({ action: "status" });
    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ ok: true, count: 2, jobs: [{ id: "a" }, { id: "b" }] });
  });

  it('action:"cancel" reports ok:false + isError when the job did not actually stop', async () => {
    mocks.cancelJob.mockResolvedValueOnce({ id: "t1", status: "cancelled" });
    const ok = await handler("train_start")({ action: "cancel", id: "t1" });
    expect(mocks.cancelJob).toHaveBeenCalledWith("t1");
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(text(ok)).ok).toBe(true);

    // The honest-cancel property from P1: a stop that could not be confirmed
    // must NOT surface as a successful cancellation.
    mocks.cancelJob.mockResolvedValueOnce({ id: "t1", status: "running", error: "daemon unreachable" });
    const bad = await handler("train_start")({ action: "cancel", id: "t1" });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(text(bad))).toMatchObject({
      ok: false,
      error: { code: "cancel_failed", message: "daemon unreachable" },
    });
  });

  it('action:"list_flows" is pure data — it touches no service', async () => {
    const res = await handler("train_start")({ action: "list_flows" });
    const body = JSON.parse(text(res));
    expect(body.ok).toBe(true);
    expect(body.flows[0].id).toBe("character");
    expect(body.image).toBe("trainer:test");
    for (const mock of Object.values(mocks)) {
      if (mock === mocks.trainingRoot || mock === mocks.hfCacheRoot) continue;
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it('action:"job_config" reads the effective settings back by id', async () => {
    mocks.getJobConfig.mockResolvedValueOnce({ id: "t1", params: { steps: 200 }, source: "config.yml" });
    const res = await handler("train_start")({ action: "job_config", id: "t1" });
    expect(mocks.getJobConfig).toHaveBeenCalledWith("t1");
    expect(JSON.parse(text(res))).toEqual({ ok: true, id: "t1", params: { steps: 200 }, source: "config.yml" });
  });

  it('action:"preview_config" previews with NO side effects', async () => {
    mocks.previewConfig.mockReturnValueOnce({ jobName: "aria", yaml: "job: extension\n" });
    const res = await handler("train_start")({
      action: "preview_config",
      name: "aria",
      datasetPath: "/train/datasets/aria",
      trigger: "ohwx",
      params: { steps: 200 },
    });
    expect(mocks.previewConfig).toHaveBeenCalledWith({
      name: "aria",
      datasetPath: "/train/datasets/aria",
      trigger: "ohwx",
      params: { steps: 200 },
    });
    expect(JSON.parse(text(res))).toEqual({ ok: true, jobName: "aria", yaml: "job: extension\n" });
    expect(mocks.startTrainingJob).not.toHaveBeenCalled();
  });
});

describe("train_doctor actions call the same services with the same arguments", () => {
  it('action:"doctor" reports the preflight plus the training roots', async () => {
    mocks.trainerDoctor.mockResolvedValueOnce({ ok: true, command: "train_doctor", data: { docker: true } });
    mocks.bootstrapStatus.mockResolvedValueOnce({ dir: "/tk", cloned: true, venv: true, ready: true, ref: "abc" });
    const res = await handler("train_doctor")({ action: "doctor" });
    const body = JSON.parse(text(res));
    expect(body.data).toMatchObject({
      docker: true,
      trainingRoot: "/train",
      hfCache: "/hf",
      hfTokenSet: false,
      localFs: true,
      native: { ready: true, ref: "abc" },
      pod: null,
    });
    expect(mocks.buildTrainerImage).not.toHaveBeenCalled();
  });

  it('action:"bootstrap" (target local) runs the native bootstrap and returns its log tail', async () => {
    mocks.bootstrapToolkit.mockImplementationOnce(async (opts: { onLog: (l: string) => void }) => {
      opts.onLog("cloning");
      return { ok: true, command: "x", data: { ready: true } };
    });
    const res = await handler("train_doctor")({ action: "bootstrap", target: "local" });
    expect(mocks.bootstrapToolkit).toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({
      ok: true,
      command: "x",
      data: { ready: true },
      log_tail: ["cloning"],
    });
  });

  it('action:"build_image" refuses without a docker daemon and never starts a build', async () => {
    mocks.dockerAvailable.mockResolvedValueOnce(false);
    const res = await handler("train_doctor")({ action: "build_image" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(text(res)).error.code).toBe("no_docker");
    expect(mocks.buildTrainerImage).not.toHaveBeenCalled();
  });

  it('action:"build_image" forwards aiToolkitRef to the builder', async () => {
    mocks.dockerAvailable.mockResolvedValueOnce(true);
    mocks.buildTrainerImage.mockResolvedValueOnce({ ok: true, command: "x", data: { image: "trainer:test" } });
    const res = await handler("train_doctor")({ action: "build_image", aiToolkitRef: "deadbeef" });
    expect(mocks.buildTrainerImage).toHaveBeenCalledWith(
      expect.objectContaining({ aiToolkitRef: "deadbeef" }),
    );
    expect(JSON.parse(text(res)).ok).toBe(true);
  });
});

describe("THE DELETE PAIR — two actions named `delete`, two blast radii", () => {
  it('train_start action:"delete" destroys a JOB and never touches a dataset', async () => {
    const res = await handler("train_start")({ action: "delete", id: "t8f3k2ab", keep_outputs: true });
    expect(mocks.deleteJob).toHaveBeenCalledWith("t8f3k2ab", { keepOutputs: true });
    expect(mocks.deleteDataset).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ ok: true });
  });

  it('train_prepare_dataset action:"delete" destroys a DATASET and never touches a job', async () => {
    const res = await handler("train_prepare_dataset")({ action: "delete", name: "aria" });
    expect(mocks.deleteDataset).toHaveBeenCalledWith("aria");
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    expect(JSON.parse(text(res))).toEqual({ ok: true });
  });

  it("neither delete can be driven by the OTHER tool's key", async () => {
    // A `name` handed to the job delete, or an `id` handed to the dataset
    // delete, must be a named missing-field error — never a deletion of the
    // similarly-identified thing the caller did not mean.
    const jobWithName = await handler("train_start")({ action: "delete", name: "aria" });
    expect(jobWithName.isError).toBe(true);
    expect(text(jobWithName)).toContain('train_start action:"delete" requires `id`');
    expect(mocks.deleteJob).not.toHaveBeenCalled();

    const datasetWithId = await handler("train_prepare_dataset")({ action: "delete", id: "t8f3k2ab" });
    expect(datasetWithId.isError).toBe(true);
    expect(text(datasetWithId)).toContain('train_prepare_dataset action:"delete" requires `name`');
    expect(mocks.deleteDataset).not.toHaveBeenCalled();
  });

  it('cancel and delete stay distinct: action:"cancel" stops a job without destroying it', async () => {
    mocks.cancelJob.mockResolvedValueOnce({ id: "t1", status: "cancelled" });
    await handler("train_start")({ action: "cancel", id: "t1" });
    expect(mocks.cancelJob).toHaveBeenCalledWith("t1");
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    expect(mocks.deleteDataset).not.toHaveBeenCalled();
  });

  // Prose is the only thing standing between a model that skimmed one
  // description and the wrong irreversible call, so it is asserted like code.
  it("each delete's description names the OTHER tool, its key, and that it is irreversible", () => {
    const jobs = tool("train_start").description;
    expect(jobs).toContain("THIS DELETES A JOB, NOT A DATASET");
    expect(jobs).toContain("train_prepare_dataset` tool with action:\"delete\"");
    expect(jobs).toMatch(/keyed by `name` rather than `id`/);
    expect(jobs).toContain("Irreversible");

    const dataset = tool("train_prepare_dataset").description;
    expect(dataset).toContain("THIS DELETES A DATASET, NOT A TRAINING JOB");
    expect(dataset).toContain("train_start` tool with action:\"delete\"");
    expect(dataset).toMatch(/keyed by `id` rather than `name`/);
    expect(dataset).toContain("Irreversible");

    // The action enum's own description repeats the distinction, because that is
    // the field a model reads when it is choosing between the two.
    const enumDesc = (d: Registered) => (d.shape.action as unknown as { description?: string }).description ?? "";
    expect(enumDesc(tool("train_start"))).toContain('train_prepare_dataset action:"delete"');
    expect(enumDesc(tool("train_prepare_dataset"))).toContain('train_start action:"delete"');
  });
});

describe("per-action presence guards (the flat shape cannot schema-require these)", () => {
  it("train_prepare_dataset names the missing `name` and calls nothing", async () => {
    for (const action of ["prepare", "detail", "update", "delete", "caption_dataset"]) {
      const res = await handler("train_prepare_dataset")({ action });
      expect(res.isError, action).toBe(true);
      expect(text(res)).toContain(`train_prepare_dataset action:"${action}" requires \`name\``);
    }
    for (const action of ["file", "caption_image"]) {
      const res = await handler("train_prepare_dataset")({ action });
      expect(res.isError, action).toBe(true);
      expect(text(res)).toContain(`train_prepare_dataset action:"${action}" requires \`path\``);
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it('train_prepare_dataset action:"prepare" names the missing `items` once `name` is present', async () => {
    const res = await handler("train_prepare_dataset")({ action: "prepare", name: "aria" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('train_prepare_dataset action:"prepare" requires `items`');
    expect(mocks.prepareDataset).not.toHaveBeenCalled();
  });

  it("train_start names the missing `id` and calls nothing", async () => {
    for (const action of ["cancel", "delete", "job_config"]) {
      const res = await handler("train_start")({ action });
      expect(res.isError, action).toBe(true);
      expect(text(res)).toContain(`train_start action:"${action}" requires \`id\``);
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("train_start names the missing `name`, then the missing `datasetPath`", async () => {
    for (const action of ["start", "preview_config"]) {
      const noName = await handler("train_start")({ action });
      expect(noName.isError, action).toBe(true);
      expect(text(noName)).toContain(`train_start action:"${action}" requires \`name\``);

      const noPath = await handler("train_start")({ action, name: "aria" });
      expect(noPath.isError, action).toBe(true);
      expect(text(noPath)).toContain(`train_start action:"${action}" requires \`datasetPath\``);
    }
    expect(mocks.startTrainingJob).not.toHaveBeenCalled();
    expect(mocks.previewConfig).not.toHaveBeenCalled();
  });
});

describe("absence and emptiness are DIFFERENT answers, never one falsiness check", () => {
  // `id` cannot carry .min(1) on the shared field (action:"status" needs an
  // empty id to mean list-all), but the retired train_cancel / train_delete_job
  // / train_job_config schemas DID carry it — so those three must still reject
  // an empty id rather than hand it to the service. A single `!args.id` guard
  // would collapse both cases into the missing-field text; these assert the two
  // messages are distinct and that NEITHER reaches a service.
  it("an explicitly empty `id` is refused by cancel/delete/job_config, with its own message", async () => {
    for (const action of ["cancel", "delete", "job_config"]) {
      const empty = await handler("train_start")({ action, id: "" });
      expect(empty.isError, action).toBe(true);
      expect(text(empty)).toContain(`train_start action:"${action}" requires a NON-EMPTY \`id\``);

      const absent = await handler("train_start")({ action });
      expect(text(absent)).toContain(`train_start action:"${action}" requires \`id\``);
      // Distinct diagnoses, not one generic string for both.
      expect(text(absent)).not.toBe(text(empty));
    }
    expect(mocks.cancelJob).not.toHaveBeenCalled();
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    expect(mocks.getJobConfig).not.toHaveBeenCalled();
  });

  it("a NON-empty `id` is passed through verbatim — the guard narrows nothing else", async () => {
    mocks.cancelJob.mockResolvedValueOnce({ id: "0", status: "cancelled" });
    // "0" is falsy-adjacent in the shapes this rule usually bites on; it must
    // reach the service untouched.
    await handler("train_start")({ action: "cancel", id: "0" });
    expect(mocks.cancelJob).toHaveBeenCalledWith("0");
  });

  // The one place falsiness is CORRECT, because it is what the old tool did:
  // train_status read `if (args.id)`, so an empty id meant "list them all".
  it('action:"status" keeps train_status\'s empty-id-means-list-all behaviour', async () => {
    mocks.listJobs.mockResolvedValueOnce([]);
    await handler("train_start")({ action: "status", id: "" });
    expect(mocks.listJobs).toHaveBeenCalled();
    expect(mocks.getJob).not.toHaveBeenCalled();
  });

  // `name`, `path` and `datasetPath` KEEP the .min(1) their old schemas had, so
  // an empty string is still rejected at the zod boundary rather than being
  // re-diagnosed by the handler — the constraint did not move.
  it("`name`/`path`/`datasetPath` still reject an empty string at the schema layer", () => {
    const dataset = tool("train_prepare_dataset").shape;
    expect((dataset.name as z.ZodType).safeParse("").success).toBe(false);
    expect((dataset.name as z.ZodType).safeParse("aria").success).toBe(true);
    expect((dataset.path as z.ZodType).safeParse("").success).toBe(false);

    const jobs = tool("train_start").shape;
    expect((jobs.name as z.ZodType).safeParse("").success).toBe(false);
    expect((jobs.datasetPath as z.ZodType).safeParse("").success).toBe(false);
    // …while `id` deliberately does not, because action:"status" needs an empty
    // id to reach the handler and mean "list every job". The three actions whose
    // old schemas carried .min(1) re-apply it in the handler (asserted above).
    expect((jobs.id as z.ZodType).safeParse("").success).toBe(true);
  });

  // ONE tool, ONE `params` field, so both actions that take params share the
  // #104 ceilings. train_preview_config's retired schema was an untyped record;
  // narrowing it to the launcher's bounds is deliberate — a preview of settings
  // action:"start" would refuse is a preview of a run that cannot happen. Pinned
  // so the decision stays visible rather than becoming an accident.
  it('action:"preview_config" enforces the same params bounds as action:"start"', async () => {
    const params = tool("train_start").shape.params as z.ZodType;
    expect(params.safeParse({ steps: 2000, rank: 16 }).success).toBe(true);
    expect(params.safeParse({ steps: 1_000_000_000 }).success).toBe(false);
    expect(params.safeParse({ rank: 100_000 }).success).toBe(false);
  });
});

describe("the fifteen retired training names", () => {
  const retired: Array<[string, string]> = [
    ["train_status", "train_start"],
    ["train_cancel", "train_start"],
    ["train_delete_job", "train_start"],
    ["train_list_flows", "train_start"],
    ["train_job_config", "train_start"],
    ["train_preview_config", "train_start"],
    ["train_list_datasets", "train_prepare_dataset"],
    ["train_dataset_detail", "train_prepare_dataset"],
    ["train_dataset_update", "train_prepare_dataset"],
    ["train_dataset_delete", "train_prepare_dataset"],
    ["train_file", "train_prepare_dataset"],
    ["train_caption_image", "train_prepare_dataset"],
    ["train_caption_dataset", "train_prepare_dataset"],
    ["train_bootstrap", "train_doctor"],
    ["train_build_image", "train_doctor"],
  ];

  it("each old name is in DEAD_NAMES pointing at the tool that absorbed it", () => {
    for (const [name, replacement] of retired) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain(replacement);
    }
  });

  // The two deletes again, from the ledger's side: whichever name a caller
  // invokes, the error must send them to the RIGHT tool AND name its key.
  it("the two retired delete names resolve to different tools and different keys", () => {
    const job = DEAD_NAMES.find((d) => d.name === "train_delete_job")!;
    const dataset = DEAD_NAMES.find((d) => d.name === "train_dataset_delete")!;
    expect(job.replacement).toContain('train_start (action:"delete")');
    expect(job.replacement).toContain("`id`");
    expect(dataset.replacement).toContain('train_prepare_dataset (action:"delete")');
    expect(dataset.replacement).toContain("`name`");
  });

  it("no old name is still in the live ledger, and the three survivors are", () => {
    for (const [name] of retired) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    for (const name of ["train_prepare_dataset", "train_start", "train_doctor"]) {
      expect(TOOL_NAMES as readonly string[]).toContain(name);
    }
  });
});
