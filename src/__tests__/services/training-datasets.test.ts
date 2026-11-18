import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the training root at a temp dir (trainingRoot() reads the env per call).
let root: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env.COMFYUI_MCP_TRAINING_DIR;
  root = mkdtempSync(join(tmpdir(), "train-datasets-test-"));
  process.env.COMFYUI_MCP_TRAINING_DIR = root;
});
afterAll(() => {
  if (saved === undefined) delete process.env.COMFYUI_MCP_TRAINING_DIR;
  else process.env.COMFYUI_MCP_TRAINING_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

import { getDataset, getJobConfig, listDatasets, previewConfig, readTrainingFile, deleteDataset, updateDataset } from "../../services/training-datasets.js";

function stageDataset(name: string, files: Array<[string, string | null]>) {
  const dir = join(root, "datasets", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, caption] of files) {
    writeFileSync(join(dir, file), "fakepng");
    if (caption != null) {
      writeFileSync(join(dir, file.replace(/\.[^.]+$/, ".txt")), caption);
    }
  }
  return dir;
}

describe("listDatasets / getDataset", () => {
  it("lists staged datasets newest-first with image/caption counts (empty dirs excluded)", () => {
    stageDataset("alpha", [["img_00001.png", "ohwx a person"], ["img_00002.png", null]]);
    stageDataset("empty", []);
    mkdirSync(join(root, "datasets", "beta"), { recursive: true });
    const betaImg = join(root, "datasets", "beta", "img_00001.png");
    writeFileSync(betaImg, "x");
    // Force beta genuinely newer than alpha, rather than trusting that two writes
    // in the same test land in different mtime buckets — coarse filesystem mtime
    // granularity made this "newest-first" assertion flake on CI when alpha and
    // beta tied. summarize() takes the max file mtime, so stamping beta's only
    // file into the future is enough.
    const future = new Date(Date.now() + 60_000);
    utimesSync(betaImg, future, future);
    const list = listDatasets();
    expect(list.map((d) => d.name)).toEqual(["beta", "alpha"]);
    expect(list.find((d) => d.name === "alpha")).toMatchObject({ imageCount: 2, captionedCount: 1 });
  });

  it("detail returns the items with captions (null when uncaptioned) + the reusable datasetPath", () => {
    const d = getDataset("alpha");
    expect(d.datasetPath.replace(/\\/g, "/")).toContain("/datasets/alpha");
    expect(d.items).toEqual([
      { file: "img_00001.png", caption: "ohwx a person" },
      { file: "img_00002.png", caption: null },
    ]);
  });

  it("rejects traversal and unknown names", () => {
    expect(() => getDataset("../secrets")).toThrow(/invalid dataset name/);
    expect(() => getDataset("no-such-set")).toThrow(/no dataset/);
  });

  it("excludes internal staging dirs from list AND detail (codex: partial sets must not train)", () => {
    stageDataset("partial.staging-1234-abcd", [["img_00001.png", "x"]]);
    expect(listDatasets().map((d) => d.name)).not.toContain("partial.staging-1234-abcd");
    expect(() => getDataset("partial.staging-1234-abcd")).toThrow(/staging/);
  });

  it("accepts dot-prefixed dataset names (legal per sanitizeDirName — list and detail must agree)", () => {
    stageDataset(".portrait", [["img_00001.png", "y"]]);
    expect(listDatasets().map((d) => d.name)).toContain(".portrait");
    expect(getDataset(".portrait").items).toHaveLength(1);
    expect(() => getDataset("..")).toThrow(/invalid dataset name/);
    expect(() => getDataset(".")).toThrow(/invalid dataset name/);
  });
});

describe('readTrainingFile (train_prepare_dataset action:"file")', () => {
  it("inlines an image under the training root with its mime type", () => {
    const f = readTrainingFile(join(root, "datasets", "alpha", "img_00001.png"));
    expect(f.mimeType).toBe("image/png");
    expect(Buffer.from(f.data, "base64").toString()).toBe("fakepng");
  });

  it("rejects escapes, non-images, and oversize files", () => {
    expect(() => readTrainingFile(join(tmpdir(), "outside.png"))).toThrow(/escapes/);
    expect(() => readTrainingFile(join(root, "datasets", "alpha", "img_00001.txt"))).toThrow(/only image files/);
    const bigDir = join(root, "datasets", "bigset");
    mkdirSync(bigDir, { recursive: true });
    const big = join(bigDir, "big.png");
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(() => readTrainingFile(big)).toThrow(/too large/);
  });
});

// The training root reached through an ALIAS (macOS /var → /private/var, a
// symlinked home, a Windows junction). The root realpaths; a missing child does
// not — and it used to be compared lexically against the root's real spelling,
// so an ordinary unknown name was reported as an escape.
describe("an ALIASED training root", () => {
  let realRoot: string;
  let aliasRoot: string;
  let outside: string;
  beforeAll(() => {
    realRoot = join(root, "alias-lab", "real");
    aliasRoot = join(root, "alias-lab", "alias");
    outside = join(root, "alias-lab", "outside");
    mkdirSync(join(realRoot, "datasets", "present"), { recursive: true });
    writeFileSync(join(realRoot, "datasets", "present", "img_00001.png"), "fakepng");
    mkdirSync(join(outside, "loot"), { recursive: true });
    writeFileSync(join(outside, "loot", "img_00001.png"), "secret");
    symlinkSync(realRoot, aliasRoot, "junction");
    symlinkSync(join(outside, "loot"), join(realRoot, "datasets", "linked-out"), "junction");
    process.env.COMFYUI_MCP_TRAINING_DIR = aliasRoot;
  });
  afterAll(() => {
    process.env.COMFYUI_MCP_TRAINING_DIR = root;
  });

  it("an unknown name is 'no dataset', not an escape", () => {
    expect(() => getDataset("no-such-set")).toThrow(/no dataset/);
  });

  it("a present dataset still resolves through the alias", () => {
    expect(getDataset("present").items).toEqual([{ file: "img_00001.png", caption: null }]);
  });

  it("a dataset dir that LINKS outside the root is still an escape", () => {
    expect(() => getDataset("linked-out")).toThrow(/escapes the datasets root/);
    expect(() => readTrainingFile(join(aliasRoot, "datasets", "linked-out", "img_00001.png"))).toThrow(
      /escapes/,
    );
  });

  it("a missing file under the alias is an honest not-found, not an escape", () => {
    expect(() => readTrainingFile(join(aliasRoot, "datasets", "present", "gone.png"))).toThrow(
      /ENOENT/,
    );
  });
});

describe("getJobConfig", () => {
  beforeAll(() => {
    const jobDir = join(root, "jobs", "jobcfg1");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, "config.yml"),
      [
        "job: extension",
        "config:",
        "  name: e2e",
        "  process:",
        "    - type: sd_trainer",
        "      network: { type: lora, linear: 16, linear_alpha: 16 }",
        "      save: { save_every: 250 }",
        "      datasets:",
        "        - folder_path: /dataset",
        "          resolution: [512, 768]",
        "      train: { steps: 2000, lr: 0.0001, batch_size: 1 }",
        "      model: { quantize: true }",
        "      sample: { sample_every: 250 }",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "jobs", "jobcfg1.json"),
      JSON.stringify({
        id: "jobcfg1",
        name: "e2e",
        flow: "character",
        model: "flux1-dev",
        trigger: "e2echar",
        status: "completed",
        progress: { samples: [] },
        datasetPath: join(root, "datasets", "alpha"),
        jobDir,
        outputDir: join(jobDir, "output"),
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  it("reads the effective settings back from config.yml (steps/lr/rank/resolution/cadences/quantize)", async () => {
    const v = await getJobConfig("jobcfg1");
    expect(v).toMatchObject({
      id: "jobcfg1",
      name: "e2e",
      trigger: "e2echar",
      source: "config.yml",
      params: {
        steps: 2000,
        lr: 0.0001,
        rank: 16,
        resolution: [512, 768],
        batchSize: 1,
        saveEvery: 250,
        sampleEvery: 250,
        quantize: true,
      },
    });
    expect(v.datasetPath).toContain("alpha");
  });

  it("throws on an unknown job id", async () => {
    await expect(getJobConfig("nope")).rejects.toThrow(/no training job/);
  });
});

describe("updateDataset / deleteDataset", () => {
  it("sets captions atomically, deletes images with their caption files, warns on unknown files", async () => {
    const r = await updateDataset("alpha", {
      setCaptions: { "img_00001.png": "ohwx a person, smiling", "ghost.png": "nope" },
      deleteImages: ["img_00002.png", "ghost2.png"],
    });
    expect(r).toMatchObject({ captionsSet: 1, imagesDeleted: 1 });
    expect(r.warnings).toHaveLength(2);
    const d = getDataset("alpha");
    expect(d.items).toEqual([{ file: "img_00001.png", caption: "ohwx a person, smiling" }]);
  });

  it("rejects non-image mutation targets (caption sidecars, cache files)", async () => {
    const dir = join(root, "datasets", "alpha");
    writeFileSync(join(dir, "img_00001.txt"), "cap");
    writeFileSync(join(dir, "cache.bin"), "x");
    const r = await updateDataset("alpha", {
      setCaptions: { "img_00001.txt": "hijack", "cache.bin": "hijack" },
      deleteImages: ["img_00001.txt", "cache.bin"],
    });
    expect(r.captionsSet).toBe(0);
    expect(r.imagesDeleted).toBe(0);
    expect(r.warnings).toHaveLength(4);
    expect(readFileSync(join(dir, "img_00001.txt"), "utf-8")).toBe("cap"); // untouched
  });

  it("rejects edits and deletes while a running job trains from the dataset", async () => {
    const jobDir = join(root, "jobs", "active1");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(root, "jobs", "active1.json"),
      JSON.stringify({
        id: "active1", name: "x", flow: "character", model: "flux1-dev", status: "running",
        progress: { samples: [] }, datasetPath: join(root, "datasets", "alpha"),
        jobDir, outputDir: join(jobDir, "output"), log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    );
    await expect(updateDataset("alpha", { setCaptions: { "img_00001.png": "y" } })).rejects.toThrow(/in use/);
    await expect(deleteDataset("alpha")).rejects.toThrow(/in use/);
    // cleanup the record so later tests aren't blocked
    rmSync(join(root, "jobs", "active1.json"));
  });

  it("deletes an unused dataset wholesale", async () => {
    stageDataset("doomed", [["img_00001.png", "x"]]);
    await deleteDataset("doomed");
    expect(listDatasets().map((d) => d.name)).not.toContain("doomed");
    expect(() => getDataset("doomed")).toThrow(/no dataset/);
  });
});

describe("previewConfig", () => {
  it("returns the raw ai-toolkit YAML for the settings (no side effects)", () => {
    const v = previewConfig({
      name: "prev",
      datasetPath: join(root, "datasets", "alpha"),
      trigger: "ohwx",
      params: { steps: 200, rank: 32 },
    });
    expect(v.jobName).toBe("prev");
    expect(v.yaml).toContain("steps: 200");
    expect(v.yaml).toContain("linear: 32");
    expect(v.yaml).toContain("trigger_word: ohwx");
  });
});

describe("deleteJob", () => {
  function writeJob(id: string, status: string, containerName?: string) {
    const jobDir = join(root, "jobs", id);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "config.yml"), "job: extension\n");
    writeFileSync(
      join(root, "jobs", `${id}.json`),
      JSON.stringify({
        id, name: id, flow: "character", model: "flux1-dev", status,
        ...(containerName ? { containerName } : {}),
        progress: { samples: [] }, datasetPath: join(root, "datasets", "alpha"),
        jobDir, outputDir: join(jobDir, "output"), log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    );
    return jobDir;
  }

  it("removes the record + job dir (keep_outputs spares the dir)", async () => {
    const { deleteJob } = await import("../../services/training-jobs.js");
    const dir = writeJob("oldjob", "completed");
    await deleteJob("oldjob");
    expect(existsSync(join(root, "jobs", "oldjob.json"))).toBe(false);
    expect(existsSync(dir)).toBe(false);

    const dir2 = writeJob("keepme", "completed");
    await deleteJob("keepme", { keepOutputs: true });
    expect(existsSync(join(root, "jobs", "keepme.json"))).toBe(false);
    expect(existsSync(dir2)).toBe(true);
  });

  it("refuses to delete a running job (cancel first) and unknown ids", async () => {
    const { deleteJob } = await import("../../services/training-jobs.js");
    writeJob("livejob", "running");
    await expect(deleteJob("livejob")).rejects.toThrow(/cancel it first/);
    expect(existsSync(join(root, "jobs", "livejob.json"))).toBe(true);
    await expect(deleteJob("no-such-job")).rejects.toThrow(/no training job/);
    rmSync(join(root, "jobs", "livejob.json"), { force: true });
  });

  it("a CANCELLED job deletes only when its container is verified gone (codex r3 BLOCKER)", async () => {
    const { deleteJob } = await import("../../services/training-jobs.js");
    writeJob("cjob", "cancelled", "comfyui-train-cjob");
    // Container still ALIVE (or unknown) → refuse: the registry must not be
    // erased while training may be live.
    await expect(
      deleteJob("cjob", {}, { containerRunning: () => Promise.resolve(true) }),
    ).rejects.toThrow(/unconfirmed/);
    expect(existsSync(join(root, "jobs", "cjob.json"))).toBe(true);
    // Verified gone → delete proceeds.
    await deleteJob("cjob", {}, { containerRunning: () => Promise.resolve(false) });
    expect(existsSync(join(root, "jobs", "cjob.json"))).toBe(false);
  });

  it("refresh prunes disk-deleted records from the in-memory registry (codex r3 MAJOR)", async () => {
    const jobs = await import("../../services/training-jobs.js");
    writeJob("ghost", "completed");
    // Seed the cache via listJobs, then delete the FILE and re-list.
    await jobs.listJobs();
    rmSync(join(root, "jobs", "ghost.json"), { force: true });
    const after = await jobs.listJobs();
    expect(after.find((j) => j.id === "ghost")).toBeUndefined();
  });
});
