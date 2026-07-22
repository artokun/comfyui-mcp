import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itWithSymlinks } from "../helpers/platform.js";

// The registry is module-level state keyed off COMFYUI_MCP_TRAINING_DIR, so each
// test gets a fresh module (vi.resetModules) pointed at a fresh temp dir. All
// docker/catalog seams are injected fakes — no docker daemon or ComfyUI needed.

let root: string;
let mod: typeof import("../../services/training-jobs.js");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeHandle(d: ReturnType<typeof deferred<{ code: number; tail: string }>>) {
  return {
    containerName: "fake",
    done: d.promise,
    child: {} as never,
  };
}

/** A catalog fake capturing upsert/setPreview calls. */
function fakeCatalog() {
  const upserts: unknown[] = [];
  const previews: { id: string; src: string }[] = [];
  return {
    upserts,
    previews,
    upsert(partial: Record<string, unknown>) {
      upserts.push(partial);
      return { id: "loras-test-job", previewFile: undefined, ...partial } as never;
    },
    setPreview(id: string, src: string) {
      previews.push({ id, src });
      return { id, previewFile: `${id}.png` } as never;
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), "training-jobs-test-"));
  process.env.COMFYUI_MCP_TRAINING_DIR = join(root, "training");
  mod = await import("../../services/training-jobs.js");
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_TRAINING_DIR;
  rmSync(root, { recursive: true, force: true });
});

function makeImage(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return p;
}

describe("prepareDataset", () => {
  it("stages images with captions and a defaultCaption fallback", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a photo.png");
    const b = makeImage(src, "b.jpg");
    const out = await mod.prepareDataset({
      name: "My Character!",
      items: [{ path: a, caption: "ohwx smiling, park" }, { path: b }],
      defaultCaption: "ohwx person",
    });
    expect(out.imageCount).toBe(2);
    expect(out.captionedCount).toBe(2);
    expect(out.warnings).toHaveLength(0);
    expect(existsSync(join(out.datasetPath, "img_00001.png"))).toBe(true);
    expect(readFileSync(join(out.datasetPath, "img_00001.txt"), "utf-8")).toBe("ohwx smiling, park");
    expect(readFileSync(join(out.datasetPath, "img_00002.txt"), "utf-8")).toBe("ohwx person");
  });

  it("warns when neither item caption nor defaultCaption is set", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a.png");
    const out = await mod.prepareDataset({ name: "d", items: [{ path: a }] });
    expect(out.captionedCount).toBe(0);
    expect(out.warnings).toHaveLength(1);
    expect(existsSync(join(out.datasetPath, "img_00001.png"))).toBe(true);
  });

  it("rejects empty items, missing files, and non-image extensions", async () => {
    await expect(mod.prepareDataset({ name: "d", items: [] })).rejects.toThrow(/at least one image/);
    await expect(mod.prepareDataset({ name: "d", items: [{ path: join(root, "nope.png") }] })).rejects.toThrow(/image not found/);
    const txt = join(root, "notes.txt");
    writeFileSync(txt, "hi");
    await expect(mod.prepareDataset({ name: "d", items: [{ path: txt }] })).rejects.toThrow(/not a supported image/);
  });

  it("replaces a previously staged dataset of the same name (no stale files)", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a.png");
    const b = makeImage(src, "b.png");
    const first = await mod.prepareDataset({ name: "same", items: [{ path: a }, { path: b }], defaultCaption: "ohwx" });
    expect(readdirSync(first.datasetPath).filter((f) => f.endsWith(".png"))).toHaveLength(2);
    const second = await mod.prepareDataset({ name: "same", items: [{ path: a }], defaultCaption: "ohwx" });
    expect(second.datasetPath).toBe(first.datasetPath);
    const files = readdirSync(second.datasetPath);
    expect(files.filter((f) => f.endsWith(".png"))).toHaveLength(1);
    expect(files).not.toContain("img_00002.png");
    expect(files).not.toContain("img_00002.txt");
  });

  it("keeps the previous dataset intact when the replacement has a bad item", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a.png");
    const b = makeImage(src, "b.png");
    const first = await mod.prepareDataset({ name: "swap", items: [{ path: a }, { path: b }], defaultCaption: "ohwx" });
    await expect(
      mod.prepareDataset({ name: "swap", items: [{ path: a }, { path: join(root, "gone.png") }] }),
    ).rejects.toThrow(/image not found/);
    // Old staging untouched, no staging temp left behind.
    expect(readdirSync(first.datasetPath).filter((f) => f.endsWith(".png"))).toHaveLength(2);
    expect(existsSync(`${first.datasetPath}.staging-${process.pid}`)).toBe(false);
  });

  it("refuses to restage a dataset a running job is training from", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a.png");
    const staged = await mod.prepareDataset({ name: "busy", items: [{ path: a }] });
    // A running job pointing at this dataset dir (persisted record, foreign process).
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const jobFile = join(mod.jobsRoot(), "tbusy1.json");
    writeFileSync(jobFile, JSON.stringify({
      id: "tbusy1", name: "busy_lora", flow: "character", model: "flux1-dev",
      status: "running", progress: { samples: [] }, containerName: "comfyui-train-tbusy1",
      datasetPath: staged.datasetPath, jobDir: join(mod.jobsRoot(), "tbusy1"),
      outputDir: join(mod.jobsRoot(), "tbusy1", "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    await expect(
      mod.prepareDataset({ name: "busy", items: [{ path: a }] }, { containerRunning: async () => true }),
    ).rejects.toThrow(/in use by running job tbusy1/);
    // Once the job is terminal, restaging works again.
    writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(readFileSync(jobFile, "utf-8")), status: "completed" }));
    await expect(mod.prepareDataset({ name: "busy", items: [{ path: a }] })).resolves.toMatchObject({ imageCount: 1 });
  });
});

describe("findProducedLora", () => {
  it("prefers the exact final save over checkpoints", () => {
    const dir = join(root, "output", "job1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job1_000000250.safetensors"), "a");
    writeFileSync(join(dir, "job1.safetensors"), "b");
    expect(mod.findProducedLora(join(root, "output"), "job1")).toBe(join(dir, "job1.safetensors"));
  });

  it("falls back to the highest-step checkpoint", () => {
    const dir = join(root, "output", "job1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job1_000000250.safetensors"), "a");
    writeFileSync(join(dir, "job1_000001000.safetensors"), "b");
    expect(mod.findProducedLora(join(root, "output"), "job1")).toBe(join(dir, "job1_000001000.safetensors"));
  });

  it("returns null when nothing was produced", () => {
    expect(mod.findProducedLora(join(root, "output"), "ghost")).toBeNull();
  });
});

describe("startTrainingJob", () => {
  async function startWith(deps: Parameters<typeof mod.startTrainingJob>[1], name = "test_job") {
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    writeFileSync(join(dataset, "img_00001.txt"), "ohwx person");
    return mod.startTrainingJob(
      { name, flow: "character", model: "flux1-dev", datasetPath: dataset, trigger: "ohwx", params: { steps: 200 } },
      deps,
    );
  }

  it("runs to completion: config written, progress tracked, LoRA handed off + cataloged", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const catalog = fakeCatalog();
    const lorasDir = join(root, "loras");
    const seen: { containerName?: string; configPath?: string } = {};
    const job = await startWith({
      startTraining: (opts) => {
        seen.containerName = opts.containerName;
        seen.configPath = opts.configPath;
        // Simulate ai-toolkit writing its outputs, then exiting 0.
        const outDir = join(opts.outputDir, "test_job");
        mkdirSync(join(outDir, "samples"), { recursive: true });
        writeFileSync(join(outDir, "test_job.safetensors"), "weights");
        writeFileSync(join(outDir, "samples", "0001.png"), "sample");
        opts.onProgress?.({ step: 199, totalSteps: 200, loss: 0.12, raw: "199/200 loss: 0.12" });
        // Resolve on a timer (not a microtask) so the job is still running when
        // startTrainingJob returns, matching real long-running behavior.
        setTimeout(() => d.resolve({ code: 0, tail: "" }), 5);
        return fakeHandle(d);
      },
      lorasDir: () => lorasDir,
      catalog,
    });

    expect(job.status).toBe("running");
    expect(job.progress.step).toBe(199);
    expect(job.containerName).toMatch(/^comfyui-train-/);
    // The generated config exists and points at the container mount points.
    const yaml = readFileSync(seen.configPath!, "utf-8");
    expect(yaml).toContain("folder_path: /dataset");
    expect(yaml).toContain("training_folder: /output");
    expect(yaml).toContain("trigger_word: ohwx");

    // Let handle.done + finalizeJob run.
    await new Promise((r) => setTimeout(r, 20));
    const done = (await mod.getJob(job.id))!;
    expect(done.status).toBe("completed");
    // Completed jobs normalize the last bar (199/200) to the full count.
    expect(done.progress.step).toBe(200);
    // Samples are picked up from the output dir at finalize (ai-toolkit prints
    // no saved-sample lines for onProgress to catch).
    expect(done.progress.samples).toHaveLength(1);
    expect(done.progress.samples[0]).toContain("0001.png");
    expect(done.result!.loraPath).toBe(join(lorasDir, "test_job.safetensors"));
    expect(existsSync(done.result!.loraPath)).toBe(true);
    expect(done.result!.loraRelPath).toBe("loras/test_job.safetensors");
    expect(catalog.upserts).toHaveLength(1);
    const upsert = catalog.upserts[0] as Record<string, unknown>;
    expect(upsert.keywords).toEqual(["ohwx"]);
    expect(upsert.baseModels).toEqual(["FLUX.1-dev"]);
    expect(upsert.missing).toBe(false);
    expect(catalog.previews).toHaveLength(1);
    expect(done.result!.previewFile).toBe("loras-test-job.png");
  });

  it("marks the job failed when the container exits non-zero", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const job = await startWith({
      startTraining: () => {
        queueMicrotask(() => d.resolve({ code: 1, tail: "CUDA OOM" }));
        return fakeHandle(d);
      },
      lorasDir: () => join(root, "loras"),
      catalog: fakeCatalog(),
    });
    await new Promise((r) => setTimeout(r, 20));
    const done = (await mod.getJob(job.id))!;
    expect(done.status).toBe("failed");
    expect(done.error).toContain("exited 1");
    expect(done.error).toContain("CUDA OOM");
  });

  it("fails the job when training succeeded but produced no LoRA", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const job = await startWith({
      startTraining: () => {
        queueMicrotask(() => d.resolve({ code: 0, tail: "" }));
        return fakeHandle(d);
      },
      lorasDir: () => join(root, "loras"),
      catalog: fakeCatalog(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((await mod.getJob(job.id))!.status).toBe("failed");
    expect((await mod.getJob(job.id))!.error).toContain("handoff");
  });

  it("rejects a dataset with no images", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    await expect(
      mod.startTrainingJob({ name: "x", flow: "character", model: "flux1-dev", datasetPath: empty }),
    ).rejects.toThrow(/no images/);
  });

  it("fails BEFORE launching the container when the loras destination is unresolvable", async () => {
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    let containerStarted = false;
    await expect(
      mod.startTrainingJob(
        { name: "x", flow: "character", model: "flux1-dev", datasetPath: dataset },
        {
          startTraining: () => {
            containerStarted = true;
            return fakeHandle(deferred<{ code: number; tail: string }>());
          },
          lorasDir: () => {
            throw new Error("No local ComfyUI path configured");
          },
          catalog: fakeCatalog(),
        },
      ),
    ).rejects.toThrow(/No local ComfyUI path/);
    expect(containerStarted).toBe(false);
  });

  it("persists throttled progress snapshots so other processes see live state", async () => {
    vi.useFakeTimers();
    try {
      const d = deferred<{ code: number; tail: string }>();
      let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
      const dataset = join(mod.datasetsRoot(), "dataset");
      mkdirSync(dataset, { recursive: true });
      makeImage(dataset, "img_00001.png");
      const job = await mod.startTrainingJob(
        { name: "snap_me", flow: "character", model: "flux1-dev", datasetPath: dataset, params: { steps: 200 } },
        {
          startTraining: (opts) => {
            tick = opts.onProgress;
            return fakeHandle(d);
          },
          lorasDir: () => join(root, "loras"),
          catalog: fakeCatalog(),
        },
      );
      const file = join(mod.jobsRoot(), `${job.id}.json`);
      const readStep = () => (JSON.parse(readFileSync(file, "utf-8")) as { progress: { step?: number } }).progress.step;
      // Snapshots are now async (chained under the job lock) — flush the chain.
      const flush = () => vi.advanceTimersByTimeAsync(50);

      tick!({ step: 10, totalSteps: 200, raw: "10/200" });
      await flush();
      expect(readStep()).toBe(10); // first tick always persists
      tick!({ step: 20, totalSteps: 200, raw: "20/200" });
      await flush();
      expect(readStep()).toBe(10); // inside the 5s throttle window
      vi.setSystemTime(Date.now() + 6000);
      tick!({ step: 30, totalSteps: 200, raw: "30/200" });
      await flush();
      expect(readStep()).toBe(30); // past the window → snapshot written
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cancelJob", () => {
  it("stops the container and keeps 'cancelled' even when done resolves later", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const stopped: string[] = [];
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "cancel_me", flow: "character", model: "flux1-dev", datasetPath: dataset },
      {
        startTraining: () => fakeHandle(d),
        stopTraining: async (name) => {
          stopped.push(name);
          return { ok: true, command: "train_cancel", data: { stopped: name } };
        },
        lorasDir: () => join(root, "loras"),
        catalog: fakeCatalog(),
      },
    );
    const cancelled = await mod.cancelJob(job.id, {
      stopTraining: async (name) => {
        stopped.push(name);
        return { ok: true, command: "train_cancel", data: { stopped: name } };
      },
      containerRunning: async () => false,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(stopped).toEqual([job.containerName]);
    // Container exits (killed) afterwards — finalize must not resurrect it.
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 20));
    expect((await mod.getJob(job.id))!.status).toBe("cancelled");
  });

  it("ignores progress ticks that arrive after a cancel (no resurrection)", async () => {
    const d = deferred<{ code: number; tail: string }>();
    let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "zombie", flow: "character", model: "flux1-dev", datasetPath: dataset },
      {
        startTraining: (opts) => {
          tick = opts.onProgress;
          return fakeHandle(d);
        },
        lorasDir: () => join(root, "loras"),
        catalog: fakeCatalog(),
      },
    );
    await mod.cancelJob(job.id, {
      stopTraining: async (name) => ({ ok: true, command: "train_cancel", data: { stopped: name } }),
      containerRunning: async () => false,
    });
    // A late tqdm line flushes while docker stop is in flight — must be ignored.
    tick!({ step: 42, totalSteps: 200, loss: 0.3, raw: "42/200 loss: 0.3" });
    expect(job.status).toBe("cancelled");
    expect(job.progress.step).toBeUndefined();
    const disk = JSON.parse(readFileSync(join(mod.jobsRoot(), `${job.id}.json`), "utf-8")) as { status: string };
    expect(disk.status).toBe("cancelled");
  });

  it("adopts a foreign cancel seen on disk instead of clobbering it at persist", async () => {
    vi.useFakeTimers();
    try {
      const d = deferred<{ code: number; tail: string }>();
      let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
      const dataset = join(mod.datasetsRoot(), "dataset");
      mkdirSync(dataset, { recursive: true });
      makeImage(dataset, "img_00001.png");
      const job = await mod.startTrainingJob(
        { name: "foreign_cancel", flow: "character", model: "flux1-dev", datasetPath: dataset },
        {
          startTraining: (opts) => {
            tick = opts.onProgress;
            return fakeHandle(d);
          },
          lorasDir: () => join(root, "loras"),
          catalog: fakeCatalog(),
        },
      );
      // Another process cancels: only the DISK record shows it; our memory
      // still says running. The next throttled persist must adopt, not clobber.
      const file = join(mod.jobsRoot(), `${job.id}.json`);
      const record = JSON.parse(readFileSync(file, "utf-8")) as { status: string; finishedAt?: string };
      record.status = "cancelled";
      record.finishedAt = new Date().toISOString();
      writeFileSync(file, JSON.stringify(record, null, 2));
      vi.setSystemTime(Date.now() + 6000); // past the persist throttle window
      tick!({ step: 10, totalSteps: 200, loss: 0.5, raw: "10/200 loss: 0.5" });
      await vi.advanceTimersByTimeAsync(50); // flush the async snapshot chain
      expect(job.status).toBe("cancelled");
      const disk = JSON.parse(readFileSync(file, "utf-8")) as { status: string };
      expect(disk.status).toBe("cancelled");
      // And when the container finally exits, no handoff happens.
      d.resolve({ code: 0, tail: "" });
      await Promise.resolve();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      expect((await mod.getJob(job.id))!.status).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes when a foreign cancel is rolled back after a failed stop", async () => {
    vi.useFakeTimers();
    try {
      const d = deferred<{ code: number; tail: string }>();
      let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
      const catalog = fakeCatalog();
      const lorasDir = join(root, "loras");
      const dataset = join(mod.datasetsRoot(), "dataset");
      mkdirSync(dataset, { recursive: true });
      makeImage(dataset, "img_00001.png");
      const job = await mod.startTrainingJob(
        { name: "rollback", flow: "character", model: "flux1-dev", datasetPath: dataset },
        {
          startTraining: (opts) => {
            tick = opts.onProgress;
            return fakeHandle(d);
          },
          lorasDir: () => lorasDir,
          catalog,
        },
      );
      const file = join(mod.jobsRoot(), `${job.id}.json`);
      const record = JSON.parse(readFileSync(file, "utf-8")) as { status: string };
      record.status = "cancelled";
      writeFileSync(file, JSON.stringify(record, null, 2));
      vi.setSystemTime(Date.now() + 6000);
      tick!({ step: 10, totalSteps: 200, loss: 0.5, raw: "10/200 loss: 0.5" });
      await vi.advanceTimersByTimeAsync(50); // flush the async snapshot chain
      expect(job.status).toBe("cancelled"); // adopted from disk
      // The cancelling process's docker stop FAILED → it reverts the record.
      record.status = "running";
      writeFileSync(file, JSON.stringify(record, null, 2));
      tick!({ step: 11, totalSteps: 200, loss: 0.4, raw: "11/200 loss: 0.4" });
      expect(job.status).toBe("running"); // reconciled, not stuck cancelled
      // A later successful completion now finalizes + hands off normally.
      const outDir = join(job.outputDir, "rollback");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "rollback.safetensors"), "weights");
      d.resolve({ code: 0, tail: "" });
      await Promise.resolve();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      const final = (await mod.getJob(job.id))!;
      expect(final.status).toBe("completed");
      expect(final.result!.loraPath).toBe(join(lorasDir, "rollback.safetensors"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reverts to running when the container genuinely fails to stop", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "cant_stop", flow: "character", model: "flux1-dev", datasetPath: dataset },
      { startTraining: () => fakeHandle(d), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    const after = await mod.cancelJob(job.id, {
      stopTraining: async () => ({ ok: false, command: "train_cancel", error: { code: "stop_failed", message: "daemon unreachable" } }),
      containerRunning: async () => true,
    });
    expect(after.status).toBe("running");
    expect(after.error).toContain("cancel failed");
    // And a later successful finalize still completes the job normally.
    const outDir = join(job.outputDir, "cant_stop");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "cant_stop.safetensors"), "weights");
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 20));
    expect((await mod.getJob(job.id))!.status).toBe("completed");
  });

  it("respects a cancel written by ANOTHER process (disk record) at finalize", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const catalog = fakeCatalog();
    const job = await mod.startTrainingJob(
      { name: "cross_cancel", flow: "character", model: "flux1-dev", datasetPath: dataset },
      { startTraining: () => fakeHandle(d), lorasDir: () => join(root, "loras"), catalog },
    );
    // Another process (e.g. orchestrator call_tool client) cancels via disk:
    // its cancelJob persists status=cancelled, unseen by this process's memory.
    const file = join(mod.jobsRoot(), `${job.id}.json`);
    const record = JSON.parse(readFileSync(file, "utf-8")) as { status: string; finishedAt?: string };
    record.status = "cancelled";
    record.finishedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(record, null, 2));
    // The killed container then exits 0 (docker stop can be a clean exit) —
    // finalize must keep 'cancelled' and skip the handoff.
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 20));
    const final = (await mod.getJob(job.id))!;
    expect(final.status).toBe("cancelled");
    expect(final.result).toBeUndefined();
    expect(catalog.upserts).toHaveLength(0);
  });

  it("retries docker stop for an already-cancelled job whose container is still alive", async () => {
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    // A cancelled-on-disk job left behind by a process that died mid-stop.
    const file = join(mod.jobsRoot(), "tzombie1.json");
    writeFileSync(file, JSON.stringify({
      id: "tzombie1", name: "zombie_lora", flow: "character", model: "flux1-dev",
      status: "cancelled", progress: { samples: [] }, containerName: "comfyui-train-tzombie1",
      datasetPath: dataset, jobDir: join(mod.jobsRoot(), "tzombie1"),
      outputDir: join(mod.jobsRoot(), "tzombie1", "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));
    const stopped: string[] = [];
    let alive = true;
    const after = await mod.cancelJob("tzombie1", {
      containerRunning: async () => alive, // still burning GPU until stopped
      stopTraining: async (name) => {
        stopped.push(name);
        alive = false;
        return { ok: true, command: "train_cancel", data: { stopped: name } };
      },
    });
    expect(stopped).toEqual(["comfyui-train-tzombie1"]);
    expect(after.status).toBe("cancelled");

    // And when the retry ALSO fails, the job goes back to running (honest).
    const after2 = await mod.cancelJob("tzombie1", {
      containerRunning: async () => true,
      stopTraining: async () => ({ ok: false, command: "train_cancel", error: { code: "stop_failed", message: "timeout" } }),
    });
    expect(after2.status).toBe("running");
    expect(after2.error).toContain("cancel retry failed");
  });

  it("leaves an already-cancelled job alone when its container is gone", async () => {
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const file = join(mod.jobsRoot(), "tgone1.json");
    writeFileSync(file, JSON.stringify({
      id: "tgone1", name: "gone_lora", flow: "character", model: "flux1-dev",
      status: "cancelled", progress: { samples: [] }, containerName: "comfyui-train-tgone1",
      datasetPath: dataset, jobDir: join(mod.jobsRoot(), "tgone1"),
      outputDir: join(mod.jobsRoot(), "tgone1", "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));
    let stops = 0;
    const after = await mod.cancelJob("tgone1", {
      containerRunning: async () => false,
      stopTraining: async (name) => {
        stops++;
        return { ok: true, command: "train_cancel", data: { stopped: name } };
      },
    });
    expect(after.status).toBe("cancelled");
    expect(stops).toBe(0);
  });

  it("attempts the stop when cancelled-job liveness is UNKNOWN (daemon flapping)", async () => {
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const file = join(mod.jobsRoot(), "tunknown1.json");
    writeFileSync(file, JSON.stringify({
      id: "tunknown1", name: "unknown_lora", flow: "character", model: "flux1-dev",
      status: "cancelled", progress: { samples: [] }, containerName: "comfyui-train-tunknown1",
      datasetPath: dataset, jobDir: join(mod.jobsRoot(), "tunknown1"),
      outputDir: join(mod.jobsRoot(), "tunknown1", "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));
    let stops = 0;
    const after = await mod.cancelJob("tunknown1", {
      containerRunning: async () => null, // daemon unreachable — can't tell
      stopTraining: async (name) => {
        stops++;
        return { ok: false, command: "train_cancel", error: { code: "stop_failed", message: "daemon unreachable" } };
      },
    });
    expect(stops).toBe(1); // stop attempted, not skipped on "unknown"
    expect(after.status).toBe("running"); // unconfirmed → honest revert
  });
});

describe("registry persistence", () => {
  async function startRestartedJob() {
    const d = deferred<{ code: number; tail: string }>();
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "restart_me", flow: "character", model: "flux1-dev", datasetPath: dataset },
      { startTraining: () => fakeHandle(d), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    expect(existsSync(join(mod.jobsRoot(), `${job.id}.json`))).toBe(true);
    // Simulate an MCP restart: fresh module, same training dir, no live handle.
    vi.resetModules();
    const mod2 = await import("../../services/training-jobs.js");
    return { job, mod2 };
  }

  it("marks an in-flight job failed when its container is definitively gone", async () => {
    const { job, mod2 } = await startRestartedJob();
    const revived = (await mod2.getJob(job.id, { containerRunning: async () => false }))!;
    expect(revived).not.toBeNull();
    expect(revived.status).toBe("failed");
    expect(revived.error).toContain("no longer running");
  });

  it("does NOT mislabel another process's live job as failed", async () => {
    const { job, mod2 } = await startRestartedJob();
    const revived = (await mod2.getJob(job.id, { containerRunning: async () => true }))!;
    expect(revived.status).toBe("running");
  });

  it("keeps status when liveness is unknown (docker daemon down)", async () => {
    const { job, mod2 } = await startRestartedJob();
    const revived = (await mod2.getJob(job.id, { containerRunning: async () => null }))!;
    expect(revived.status).toBe("running");
  });

  it("recovers a FINISHED run whose owner died (handoff runs on next read)", async () => {
    const { job, mod2 } = await startRestartedJob();
    // ai-toolkit finished and wrote the final save before the owner died. No
    // log marker exists (nothing streams after owner death) — the final
    // <name>.safetensors is the durable success signal.
    const outDir = join(job.outputDir, "restart_me");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "restart_me.safetensors"), "weights");
    const lorasDir = join(root, "loras");
    const catalog = fakeCatalog();
    const revived = (await mod2.getJob(job.id, {
      containerRunning: async () => false,
      lorasDir: () => lorasDir,
      catalog,
    }))!;
    expect(revived.status).toBe("completed");
    expect(revived.result!.loraPath).toBe(join(lorasDir, "restart_me.safetensors"));
    expect(existsSync(revived.result!.loraPath)).toBe(true);
    expect(catalog.upserts).toHaveLength(1);
  });

  it("does NOT recover a crashed run that left only checkpoints behind", async () => {
    const { job, mod2 } = await startRestartedJob();
    const outDir = join(job.outputDir, "restart_me");
    mkdirSync(outDir, { recursive: true });
    // A periodic checkpoint without the final save = training never finished.
    writeFileSync(join(outDir, "restart_me_000000100.safetensors"), "partial");
    const lorasDir = join(root, "loras");
    const revived = (await mod2.getJob(job.id, {
      containerRunning: async () => false,
      lorasDir: () => lorasDir,
      catalog: fakeCatalog(),
    }))!;
    expect(revived.status).toBe("failed");
    expect(revived.result).toBeUndefined();
    expect(existsSync(join(lorasDir, "restart_me.safetensors"))).toBe(false);
  });

  it("on retarget: copies the LoRA to the ORIGINAL loras dir but skips the catalog", async () => {
    const { job, mod2 } = await startRestartedJob();
    const outDir = join(job.outputDir, "restart_me");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "restart_me.safetensors"), "weights");
    // Job was started against a DIFFERENT ComfyUI instance than this process
    // currently targets (simulating a mid-run retarget).
    const originalLoras = join(root, "original-loras");
    const record = JSON.parse(readFileSync(join(mod2.jobsRoot(), `${job.id}.json`), "utf-8")) as Record<string, unknown>;
    record.lorasDir = originalLoras;
    record.instanceSlug = "some_other_instance_9000";
    writeFileSync(join(mod2.jobsRoot(), `${job.id}.json`), JSON.stringify(record, null, 2));
    const catalog = fakeCatalog();
    const revived = (await mod2.getJob(job.id, {
      containerRunning: async () => false,
      lorasDir: () => join(root, "WRONG-new-instance-loras"),
      catalog,
    }))!;
    expect(revived.status).toBe("completed");
    // File lands in the ORIGINAL dir; the (new-instance) catalog stays untouched.
    expect(revived.result!.loraPath).toBe(join(originalLoras, "restart_me.safetensors"));
    expect(existsSync(revived.result!.loraPath)).toBe(true);
    expect(revived.result!.catalogId).toBeUndefined();
    expect(catalog.upserts).toHaveLength(0);
  });

  it("re-reads disk on every poll so a fresh process sees later jobs", async () => {
    const { mod2 } = await startRestartedJob();
    // A SECOND job created after mod2's first read must appear on the next one.
    await mod2.listJobs({ containerRunning: async () => true });
    const d2 = deferred<{ code: number; tail: string }>();
    const job2 = await mod.startTrainingJob(
      { name: "created_later", flow: "character", model: "flux1-dev", datasetPath: join(mod.datasetsRoot(), "dataset") },
      { startTraining: () => fakeHandle(d2), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    const jobs = await mod2.listJobs({ containerRunning: async () => true });
    expect(jobs.some((j) => j.id === job2.id)).toBe(true);
  });
});

describe("independent review fixes (PR #237)", () => {
  function writeRecord(id: string, extra: Record<string, unknown> = {}) {
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const jobDir = join(mod.jobsRoot(), id);
    const record = {
      id, name: "review_lora", flow: "character", model: "flux1-dev",
      status: "running", progress: { samples: [] }, containerName: `comfyui-train-${id}`,
      datasetPath: dataset, jobDir, outputDir: join(jobDir, "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...extra,
    };
    writeFileSync(join(mod.jobsRoot(), `${id}.json`), JSON.stringify(record, null, 2));
    return record;
  }

  it("train_status NEVER hands off in the healthy-owner window (read-only)", async () => {
    // Container just exited; the OWNER PROCESS IS ALIVE (ppid here) and about
    // to run its own finalize. A status poll must NOT recover/hand off/persist
    // anything (independent review finding #1).
    const rec = writeRecord("thealthy1", { ownerPid: process.ppid });
    // …and a produced LoRA is sitting right there, so recovery WOULD fire if
    // it weren't for the live owner.
    const outDir = join(rec.jobDir as string, "output", "review_lora");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "review_lora.safetensors"), "weights");
    const catalog = fakeCatalog();
    const before = readFileSync(join(mod.jobsRoot(), "thealthy1.json"), "utf-8");
    const job = (await mod.getJob("thealthy1", {
      containerRunning: async () => false, // container gone
      lorasDir: () => join(root, "loras"),
      catalog,
    }))!;
    expect(job.status).toBe("running"); // reported as recorded
    expect(catalog.upserts).toHaveLength(0); // NO handoff from a read
    expect(existsSync(join(root, "loras", "review_lora.safetensors"))).toBe(false);
    expect(readFileSync(join(mod.jobsRoot(), "thealthy1.json"), "utf-8")).toBe(before); // NO write
  });

  it("recovers when the owner pid is genuinely dead", async () => {
    writeRecord("tdead1", { ownerPid: 99999999 }); // almost certainly not alive
    const rec = readFileSync(join(mod.jobsRoot(), "tdead1.json"), "utf-8");
    const jobDir = JSON.parse(rec).jobDir;
    const outDir = join(jobDir, "output", "review_lora");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "review_lora.safetensors"), "weights");
    const catalog = fakeCatalog();
    const job = (await mod.getJob("tdead1", {
      containerRunning: async () => false,
      lorasDir: () => join(root, "loras"),
      catalog,
    }))!;
    expect(job.status).toBe("completed");
    expect(catalog.upserts).toHaveLength(1);
  });

  it("recovers when the owner is ALIVE but its liveness lease went stale (handleless)", async () => {
    // Owner process alive (ppid) but the record stopped updating — the owner
    // lost its handle without finalizing (codex finding).
    const rec = writeRecord("tstale1", {
      ownerPid: process.ppid,
      updatedAt: new Date(Date.now() - 15 * 60_000).toISOString(), // > 10min lease
    });
    const outDir = join(rec.jobDir as string, "output", "review_lora");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "review_lora.safetensors"), "weights");
    const catalog = fakeCatalog();
    const job = (await mod.getJob("tstale1", {
      containerRunning: async () => false,
      lorasDir: () => join(root, "loras"),
      catalog,
    }))!;
    expect(job.status).toBe("completed");
    expect(catalog.upserts).toHaveLength(1);
  });

  it("marks the job failed (not queued-forever) when startTraining throws", async () => {
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    await expect(
      mod.startTrainingJob(
        { name: "thrower", flow: "character", model: "flux1-dev", datasetPath: dataset },
        {
          startTraining: () => {
            throw new Error("docker binary exploded");
          },
          lorasDir: () => join(root, "loras"),
          catalog: fakeCatalog(),
        },
      ),
    ).rejects.toThrow("docker binary exploded");
    const jobs = await mod.listJobs({ containerRunning: async () => false });
    const job = jobs.find((j) => j.name === "thrower")!;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("could not start the training container");
  });

  it("refreshes the owner lease on log-only activity (no progress ticks)", async () => {
    vi.useFakeTimers();
    try {
      const d = deferred<{ code: number; tail: string }>();
      let log: ((line: string) => void) | undefined;
      const dataset = join(mod.datasetsRoot(), "dataset");
      mkdirSync(dataset, { recursive: true });
      makeImage(dataset, "img_00001.png");
      const job = await mod.startTrainingJob(
        { name: "heartbeat", flow: "character", model: "flux1-dev", datasetPath: dataset },
        {
          startTraining: (opts) => {
            log = opts.onLog;
            return fakeHandle(d);
          },
          lorasDir: () => join(root, "loras"),
          catalog: fakeCatalog(),
        },
      );
      const t0 = Date.parse(job.updatedAt);
      // 90s of pure log output (model download phase) with NO progress ticks.
      vi.setSystemTime(t0 + 90_000);
      log!("Downloading model shards…");
      const t1 = Date.parse(job.updatedAt);
      expect(t1).toBeGreaterThan(t0 + 80_000); // lease refreshed by the log line
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cancel that loses the race adopts the FULL finalized record (no overwrite)", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "race_lost", flow: "character", model: "flux1-dev", datasetPath: dataset },
      { startTraining: () => fakeHandle(d), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    // The finalizer wins: the disk record becomes a RICH completed record
    // (progress + samples + result) before the cancel reads it.
    const file = join(mod.jobsRoot(), `${job.id}.json`);
    const finalized = {
      ...JSON.parse(readFileSync(file, "utf-8")),
      status: "completed",
      progress: { step: 200, totalSteps: 200, loss: 0.12, samples: ["/x/s1.png", "/x/s2.png"] },
      result: { loraPath: "/x/lora.safetensors", loraRelPath: "loras/race_lost.safetensors", catalogId: "c1" },
      log: ["final line"],
      finishedAt: new Date().toISOString(),
    };
    const finalizedText = JSON.stringify(finalized, null, 2);
    writeFileSync(file, finalizedText);
    const after = await mod.cancelJob(job.id, { containerRunning: async () => false });
    expect(after.status).toBe("completed");
    // The FULL record survived — progress, samples, result, and the disk file
    // is byte-identical (the cancel persisted nothing over it).
    expect(after.progress.samples).toEqual(["/x/s1.png", "/x/s2.png"]);
    expect(after.result?.loraRelPath).toBe("loras/race_lost.safetensors");
    expect(after.log).toEqual(["final line"]);
    expect(readFileSync(file, "utf-8")).toBe(finalizedText);
  });

  it("two non-owner processes racing recovery hand off EXACTLY once (CAS)", async () => {
    writeRecord("trace1"); // no ownerPid → dead owner
    const rec = JSON.parse(readFileSync(join(mod.jobsRoot(), "trace1.json"), "utf-8"));
    const outDir = join(rec.jobDir, "output", "review_lora");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "review_lora.safetensors"), "weights");
    vi.resetModules();
    // Distinct query strings → two DISTINCT module instances (two "processes").
    const modA = await import("../../services/training-jobs.js?inst=a");
    const modB = await import("../../services/training-jobs.js?inst=b");
    const catA = fakeCatalog();
    const catB = fakeCatalog();
    await Promise.all([
      modA.getJob("trace1", { containerRunning: async () => false, lorasDir: () => join(root, "loras"), catalog: catA }),
      modB.getJob("trace1", { containerRunning: async () => false, lorasDir: () => join(root, "loras"), catalog: catB }),
    ]);
    expect(catA.upserts.length + catB.upserts.length).toBe(1);
    const final = JSON.parse(readFileSync(join(mod.jobsRoot(), "trace1.json"), "utf-8"));
    expect(final.status).toBe("completed");
  });

  it("refuses to launch when the job record can't be persisted", async () => {
    // jobsRoot as a FILE → every jobs-dir write fails; the container must not start.
    mkdirSync(join(root, "training"), { recursive: true });
    writeFileSync(mod.jobsRoot(), "not-a-dir");
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    let containerStarted = false;
    await expect(
      mod.startTrainingJob(
        { name: "nopersist", flow: "character", model: "flux1-dev", datasetPath: dataset },
        {
          startTraining: () => {
            containerStarted = true;
            return fakeHandle(deferred<{ code: number; tail: string }>());
          },
          lorasDir: () => join(root, "loras"),
          catalog: fakeCatalog(),
        },
      ),
    ).rejects.toThrow();
    expect(containerStarted).toBe(false);
  });

  it("rejects a dataset outside datasetsRoot() (rw container mount constraint)", async () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    makeImage(outside, "img_00001.png");
    await expect(
      mod.startTrainingJob(
        { name: "escape", flow: "character", model: "flux1-dev", datasetPath: outside },
        { startTraining: () => fakeHandle(deferred<{ code: number; tail: string }>()), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
      ),
    ).rejects.toThrow(/must be staged under/);
  });

  itWithSymlinks("rejects a symlinked dataset dir that escapes datasetsRoot()", async () => {
    const outside = join(root, "real-elsewhere");
    mkdirSync(outside, { recursive: true });
    makeImage(outside, "img_00001.png");
    // A symlink INSIDE datasetsRoot pointing OUT — lexical prefix passes, the
    // realpath containment must catch it (docker would mount the target rw).
    // datasetsRoot() isn't auto-created (sibling tests create it implicitly
    // via their dataset mkdir) — without this, symlinkSync ENOENTs on CI.
    mkdirSync(mod.datasetsRoot(), { recursive: true });
    symlinkSync(outside, join(mod.datasetsRoot(), "linked"), "junction");
    await expect(
      mod.startTrainingJob(
        { name: "linked", flow: "character", model: "flux1-dev", datasetPath: join(mod.datasetsRoot(), "linked") },
        { startTraining: () => fakeHandle(deferred<{ code: number; tail: string }>()), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
      ),
    ).rejects.toThrow(/must be staged under/);
  });

  it("accepts a dataset path whose drive-letter casing differs (Windows FS semantics)", async () => {
    if (process.platform !== "win32") return; // case-fold only applies there
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    // Same path, lowercased drive letter — the FS calls it the same dir.
    const folded = dataset.replace(/^([A-Z])(?=:)/, (m) => m.toLowerCase());
    expect(folded).not.toBe(dataset);
    const job = await mod.startTrainingJob(
      { name: "casefold", flow: "character", model: "flux1-dev", datasetPath: folded },
      { startTraining: () => fakeHandle(deferred<{ code: number; tail: string }>()), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    expect(job.status).toBe("running");
  });

  it("rejects a concurrent same-name prepare", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a.png");
    const p1 = mod.prepareDataset({ name: "conc", items: [{ path: a }], defaultCaption: "ohwx" });
    await expect(mod.prepareDataset({ name: "conc", items: [{ path: a }] })).rejects.toThrow(/already being prepared/);
    await p1;
  });

  it("cancel does NOT write unlocked when a finalize holds the lock", async () => {
    const rec = writeRecord("tlock1", { ownerPid: 99999999 });
    // Simulate a LIVE finalizer mid-critical-section: lock held by the (live)
    // parent pid — within the age cap, so it can't be reclaimed.
    writeFileSync(join(mod.jobsRoot(), "tlock1.lock"), String(process.ppid));
    const before = readFileSync(join(mod.jobsRoot(), "tlock1.json"), "utf-8");
    const after = await mod.cancelJob("tlock1", {
      containerRunning: async () => true,
      lockBudgetMs: 300, // don't sit on the 90s default in a test
    });
    expect(after.status).toBe("running"); // reverted, not cancelled
    expect(after.error).toContain("could not confirm the cancel");
    expect(readFileSync(join(mod.jobsRoot(), "tlock1.json"), "utf-8")).toBe(before); // untouched
  });

  it("concurrent cancels COALESCE — the second joins the in-flight one", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "co_cancel", flow: "character", model: "flux1-dev", datasetPath: dataset },
      { startTraining: () => fakeHandle(d), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    // A live lock (parent pid) makes the first cancel wait — and time out.
    writeFileSync(join(mod.jobsRoot(), `${job.id}.lock`), String(process.ppid));
    let stops = 0;
    const deps = {
      containerRunning: async () => true,
      stopTraining: async (name: string) => {
        stops++;
        return { ok: true, command: "train_cancel", data: { stopped: name } } as never;
      },
      lockBudgetMs: 300,
    };
    const [r1, r2] = await Promise.all([mod.cancelJob(job.id, deps), mod.cancelJob(job.id, deps)]);
    // Same outcome object for both; the second caller never ran its own body.
    expect(r1).toBe(r2);
    expect(stops).toBe(0); // lock never acquired → no stop attempted at all
    expect(r1.error).toContain("could not confirm the cancel");
    // The pending registration is cleaned up afterwards: with the lock gone, a
    // later cancel runs a FRESH body and actually succeeds.
    rmSync(join(mod.jobsRoot(), `${job.id}.lock`), { force: true });
    let alive = true;
    const r3 = await mod.cancelJob(job.id, {
      ...deps,
      containerRunning: async () => alive,
      stopTraining: async (name: string) => {
        stops++;
        alive = false;
        return { ok: true, command: "train_cancel", data: { stopped: name } } as never;
      },
    });
    expect(r3.status).toBe("cancelled");
    expect(stops).toBe(1);
  });

  it("progress during a pending cancel does NOT reconcile memory back to running", async () => {
    const d = deferred<{ code: number; tail: string }>();
    let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "pending_cancel", flow: "character", model: "flux1-dev", datasetPath: dataset },
      {
        startTraining: (opts) => {
          tick = opts.onProgress;
          return fakeHandle(d);
        },
        lorasDir: () => join(root, "loras"),
        catalog: fakeCatalog(),
      },
    );
    // Block the cancel's lock acquisition briefly (live holder = parent pid,
    // within the age cap so it can't be reclaimed).
    writeFileSync(join(mod.jobsRoot(), `${job.id}.lock`), String(process.ppid));
    const cancelP = mod.cancelJob(job.id, {
      containerRunning: async () => true,
      lockBudgetMs: 400,
    });
    // Let the cancel reach its memory-marking (it awaits getJob + the lock
    // probe first), then fire the tick mid-wait.
    await new Promise((r) => setTimeout(r, 50));
    tick!({ step: 5, totalSteps: 200, loss: 0.5, raw: "5/200 loss: 0.5" });
    expect(job.status).toBe("cancelled");
    const after = await cancelP; // fails to confirm (lock busy) → reverts honestly
    expect(after.status).toBe("running");
    expect(after.error).toContain("could not confirm the cancel");
  });

  it("finalize proceeds past a DEAD holder's lock (breaks it)", async () => {
    // A crashed process's lock: owner dead, holder pid dead → recovery proceeds.
    writeRecord("tdeadlock1", { ownerPid: 99999999 });
    const rec = JSON.parse(readFileSync(join(mod.jobsRoot(), "tdeadlock1.json"), "utf-8"));
    const outDir = join(rec.jobDir, "output", "review_lora");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "review_lora.safetensors"), "weights");
    // The crashed finalizer's lock — its pid is not alive.
    writeFileSync(join(mod.jobsRoot(), "tdeadlock1.lock"), "99999999");
    const catalog = fakeCatalog();
    const job = (await mod.getJob("tdeadlock1", {
      containerRunning: async () => false,
      lorasDir: () => join(root, "loras"),
      catalog,
    }))!;
    expect(job.status).toBe("completed");
    expect(catalog.upserts).toHaveLength(1);
    expect(existsSync(join(mod.jobsRoot(), "tdeadlock1.lock"))).toBe(false);
  });

  it("reclaims an EMPTY stale lock (crash between create and token write)", async () => {
    writeRecord("tempty1", { ownerPid: 99999999 });
    const rec = JSON.parse(readFileSync(join(mod.jobsRoot(), "tempty1.json"), "utf-8"));
    const outDir = join(rec.jobDir, "output", "review_lora");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "review_lora.safetensors"), "weights");
    // Empty + ancient lockfile (no token at all).
    const lockPath = join(mod.jobsRoot(), "tempty1.lock");
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath, old, old);
    const catalog = fakeCatalog();
    const job = (await mod.getJob("tempty1", {
      containerRunning: async () => false,
      lorasDir: () => join(root, "loras"),
      catalog,
      lockBudgetMs: 2_000,
    }))!;
    expect(job.status).toBe("completed"); // recovered, didn't loop on the empty lock
    expect(catalog.upserts).toHaveLength(1);
  });

  it("a live snapshot never overwrites a terminal disk record", async () => {
    const d = deferred<{ code: number; tail: string }>();
    let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "snap_terminal", flow: "character", model: "flux1-dev", datasetPath: dataset },
      {
        startTraining: (opts) => {
          tick = opts.onProgress;
          return fakeHandle(d);
        },
        lorasDir: () => join(root, "loras"),
        catalog: fakeCatalog(),
      },
    );
    // A finalizer elsewhere lands FIRST: the disk record becomes completed.
    const file = join(mod.jobsRoot(), `${job.id}.json`);
    const finalized = {
      ...JSON.parse(readFileSync(file, "utf-8")),
      status: "completed",
      progress: { step: 200, totalSteps: 200, loss: 0.1, samples: [] },
      result: { loraPath: "/x/l.safetensors", loraRelPath: "loras/snap_terminal.safetensors", catalogId: "c" },
      finishedAt: new Date().toISOString(),
    };
    const finalizedText = JSON.stringify(finalized, null, 2);
    writeFileSync(file, finalizedText);
    // A late progress tick arrives and schedules its snapshot AFTER that.
    tick!({ step: 42, totalSteps: 200, loss: 0.4, raw: "42/200 loss: 0.4" });
    await new Promise((r) => setTimeout(r, 200)); // let the chained persist flush
    // The terminal record survived — no running-overwrite, byte-identical.
    expect(readFileSync(file, "utf-8")).toBe(finalizedText);
  });

  it("a LIVE holder's lock is respected within the age cap", async () => {
    // An in-cap lockfile owned by a LIVE pid (this one, and actually held) must
    // not be broken — long handoff copies are legitimate (codex finding).
    const lockPath = join(mod.jobsRoot(), "tancient1.lock");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    writeFileSync(lockPath, String(process.ppid)); // live, not me
    const recent = new Date(Date.now() - 10 * 60_000); // 10min < 30min cap
    utimesSync(lockPath, recent, recent);
    writeRecord("tancient1", { ownerPid: 99999999 });
    const job = (await mod.getJob("tancient1", {
      containerRunning: async () => false,
      lorasDir: () => join(root, "loras"),
      catalog: fakeCatalog(),
      lockBudgetMs: 300,
    }))!;
    expect(job.status).toBe("running"); // couldn't acquire → record untouched
    expect(existsSync(lockPath)).toBe(true); // NOT broken
  });

  it("reclaims a lock past the age cap even with a LIVE unrelated pid (pid-reuse guard)", async () => {
    const lockPath = join(mod.jobsRoot(), "tancient2.lock");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    writeFileSync(lockPath, String(process.ppid)); // live pid, possibly recycled
    const ancient = new Date(Date.now() - 45 * 60_000); // 45min > 30min cap
    utimesSync(lockPath, ancient, ancient);
    writeRecord("tancient2", { ownerPid: 99999999 });
    const rec = JSON.parse(readFileSync(join(mod.jobsRoot(), "tancient2.json"), "utf-8"));
    const outDir = join(rec.jobDir, "output", "review_lora");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "review_lora.safetensors"), "weights");
    const catalog = fakeCatalog();
    const job = (await mod.getJob("tancient2", {
      containerRunning: async () => false,
      lorasDir: () => join(root, "loras"),
      catalog,
    }))!;
    expect(job.status).toBe("completed"); // reclaimed + recovered
    expect(catalog.upserts).toHaveLength(1);
  });

  it("reclaims a lock with MY pid that this process never took (dead previous life)", async () => {
    // The lockfile carries the CURRENT pid but was planted (never acquired via
    // acquireLock) — i.e. a previous dead process with the same recycled pid.
    const lockPath = join(mod.jobsRoot(), "trecycle1.lock");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    writeFileSync(lockPath, String(process.pid));
    writeRecord("trecycle1", { ownerPid: 99999999 });
    const rec = JSON.parse(readFileSync(join(mod.jobsRoot(), "trecycle1.json"), "utf-8"));
    const outDir = join(rec.jobDir, "output", "review_lora");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "review_lora.safetensors"), "weights");
    const catalog = fakeCatalog();
    const job = (await mod.getJob("trecycle1", {
      containerRunning: async () => false,
      lorasDir: () => join(root, "loras"),
      catalog,
    }))!;
    expect(job.status).toBe("completed"); // reclaimed immediately, no timeout
    expect(catalog.upserts).toHaveLength(1);
  });

  it("adopting a cancelled record CONTINUES to docker stop (cross-process cancel)", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "xproc_cancel", flow: "character", model: "flux1-dev", datasetPath: dataset },
      { startTraining: () => fakeHandle(d), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    // Process A persisted the cancel marker, then died BEFORE its docker stop.
    const file = join(mod.jobsRoot(), `${job.id}.json`);
    const record = JSON.parse(readFileSync(file, "utf-8")) as { status: string; finishedAt?: string };
    record.status = "cancelled";
    record.finishedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(record, null, 2));
    const stopped: string[] = [];
    let alive = true;
    // Process B had the job as running and cancels too: it must ADOPT — and
    // still stop the container (codex finding: ack-without-stop burns GPU).
    const after = await mod.cancelJob(job.id, {
      containerRunning: async () => alive,
      stopTraining: async (name) => {
        stopped.push(name);
        alive = false;
        return { ok: true, command: "train_cancel", data: { stopped: name } };
      },
    });
    expect(stopped).toEqual([job.containerName]);
    expect(after.status).toBe("cancelled");
  });

  it("lock acquisition honors the caller's budget past a fresh claim", async () => {
    writeRecord("tbudget1", { ownerPid: 99999999 });
    // Live lock + live (fresh) claim — a takeover "in progress" elsewhere.
    writeFileSync(join(mod.jobsRoot(), "tbudget1.lock"), String(process.ppid));
    writeFileSync(join(mod.jobsRoot(), "tbudget1.lock.claim"), String(process.ppid));
    const t0 = Date.now();
    const after = await mod.cancelJob("tbudget1", {
      containerRunning: async () => true,
      lockBudgetMs: 400,
    });
    const elapsed = Date.now() - t0;
    expect(after.error).toContain("could not confirm the cancel");
    expect(elapsed).toBeLessThan(5_000); // NOT the full 60s claim TTL
  });
});

describe("pod target (P4)", () => {
  const EP = { userHost: "root@203.0.113.10", port: 23456 };

  function podDeps(over: Partial<Parameters<typeof mod.startTrainingJob>[1]> = {}) {
    const calls = { up: [] as string[][], cfg: [] as string[][], lora: [] as string[][], down: [] as string[][] };
    const d = deferred<{ code: number; tail: string }>();
    const deps = {
      sshWorks: async () => true,
      rsyncToPod: async (...a: unknown[]) => { calls.up.push(a as string[]); return { code: 0, stdout: "", stderr: "" }; },
      rsyncFileToPod: async (...a: unknown[]) => {
        const [ , remote] = a as [unknown, unknown, string];
        if (remote.includes("loras")) calls.lora.push(a as string[]);
        else calls.cfg.push(a as string[]);
        return { code: 0, stdout: "", stderr: "" };
      },
      rsyncFromPod: async (...a: unknown[]) => {
        calls.down.push(a as string[]);
        // Simulate the LoRA + a sample landing back on the rig (third arg).
        const [, , local] = a as [unknown, unknown, string];
        mkdirSync(local, { recursive: true });
        writeFileSync(join(local, "pod_lora.safetensors"), "weights");
        mkdirSync(join(local, "samples"), { recursive: true });
        writeFileSync(join(local, "samples", "s1.png"), "sample");
        return { code: 0, stdout: "", stderr: "" };
      },
      startSshTraining: () => ({ containerName: "x", done: d.promise, child: {} as never }),
      lorasDir: () => join(root, "loras"),
      catalog: fakeCatalog(),
      ...over,
    };
    return { deps, calls, d };
  }

  function stageDataset() {
    const dataset = join(mod.datasetsRoot(), "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    return dataset;
  }

  it("runs end-to-end: pod paths in config, uploads staged, delivery both sides, pod tag", async () => {
    const { deps, calls, d } = podDeps();
    const catalog = deps.catalog as ReturnType<typeof fakeCatalog>;
    const job = await mod.startTrainingJob(
      { name: "pod_lora", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
      deps,
    );
    expect(job.target).toBe("pod");
    expect(job.containerName).toBe("pod|root@203.0.113.10|23456");
    // Config points at REAL pod paths (no container mount rewrite).
    const yaml = readFileSync(join(job.jobDir, "config.yml"), "utf-8");
    expect(yaml).toContain("/workspace/training/datasets/pod_lora");
    expect(yaml).toContain("/workspace/training/jobs/");
    // Dataset + config were uploaded before launch.
    expect(calls.up).toHaveLength(1);
    expect(calls.cfg).toHaveLength(1);
    expect(calls.cfg[0][2]).toContain("/workspace/training/jobs/");

    // The runner "finishes" → finalize pulls output down and delivers both ways.
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 50));
    const done = (await mod.getJob(job.id))!;
    if (done.status !== "completed") throw new Error(`job did not complete: ${done.error}`);
    expect(calls.down).toHaveLength(1); // output pulled back
    expect(calls.lora).toHaveLength(1); // delivered to the pod's models/loras
    expect(calls.lora[0][2]).toBe("/workspace/models/loras/pod_lora.safetensors");
    expect(done.result!.podLoraPath).toBe("/workspace/models/loras/pod_lora.safetensors");
    expect(done.result!.loraPath).toBe(join(root, "loras", "pod_lora.safetensors")); // local copy too
    expect(done.progress.samples).toHaveLength(1); // samples mirrored back
    const upsert = (catalog.upserts[0] ?? {}) as { tags?: string[] };
    expect(upsert.tags).toContain("trained-on-pod");
  });

  it("deliverTo 'pod' skips the local copy + catalog, keeps podLoraPath", async () => {
    const { deps, calls, d } = podDeps();
    const catalog = deps.catalog as ReturnType<typeof fakeCatalog>;
    const job = await mod.startTrainingJob(
      { name: "pod_lora", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP, deliverTo: "pod" },
      deps,
    );
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 50));
    const done = (await mod.getJob(job.id))!;
    expect(done.status).toBe("completed");
    expect(done.result!.podLoraPath).toBe("/workspace/models/loras/pod_lora.safetensors");
    expect(existsSync(join(root, "loras", "pod_lora.safetensors"))).toBe(false);
    expect(catalog.upserts).toHaveLength(0);
    expect(done.result!.catalogId).toBeUndefined();
  });

  it("refuses with no endpoint, dead ssh, or an already-active pod job", async () => {
    await expect(
      mod.startTrainingJob({ name: "x", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod" }),
    ).rejects.toThrow(/requires a pod SSH endpoint/);

    await expect(
      mod.startTrainingJob(
        { name: "x", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
        podDeps({ sshWorks: async () => false }).deps,
      ),
    ).rejects.toThrow(/pod SSH unreachable/);

    const first = podDeps();
    const job = await mod.startTrainingJob(
      { name: "busy_pod", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
      first.deps,
    );
    await expect(
      mod.startTrainingJob(
        { name: "second_pod", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
        podDeps().deps,
      ),
    ).rejects.toThrow(/already has an active training job/);
    first.d.resolve({ code: 1, tail: "cleanup" });
    await new Promise((r) => setTimeout(r, 30));
    void job;
  });

  it("hasActiveTrainingJob flags pod jobs only while running", async () => {
    expect(mod.hasActiveTrainingJob("pod")).toBe(false);
    const { deps, d } = podDeps();
    await mod.startTrainingJob(
      { name: "pod_lora", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
      deps,
    );
    expect(mod.hasActiveTrainingJob("pod")).toBe(true);
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 50));
    expect(mod.hasActiveTrainingJob("pod")).toBe(false);
  });

  it("hasActiveTrainingJob scopes to the WATCHED pod id (#274)", async () => {
    const { deps, d } = podDeps();
    await mod.startTrainingJob(
      { name: "scoped_pod", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP, podId: "pod-A" },
      deps,
    );
    // Busy for its OWN pod, and for an unscoped query…
    expect(mod.hasActiveTrainingJob("pod")).toBe(true);
    expect(mod.hasActiveTrainingJob("pod", "pod-A")).toBe(true);
    // …but NOT for a different pod — a run on pod-A must not suppress pod-B's
    // idle auto-stop.
    expect(mod.hasActiveTrainingJob("pod", "pod-B")).toBe(false);
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 50));
    expect(mod.hasActiveTrainingJob("pod", "pod-A")).toBe(false);
  });

  it("serializes two concurrent starts for the SAME pod — exactly one wins (#273)", async () => {
    const a = podDeps();
    const b = podDeps();
    const [r1, r2] = await Promise.allSettled([
      mod.startTrainingJob(
        { name: "race_a", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
        a.deps,
      ),
      mod.startTrainingJob(
        { name: "race_b", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
        b.deps,
      ),
    ]);
    const outcomes = [r1, r2];
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already has an active training job|already reserving/i);
    a.d.resolve({ code: 0, tail: "" });
    b.d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 30));
  });

  it("local LoRA delivery is atomic and leaves no tmp file (#268)", async () => {
    // Pre-existing same-name LoRA: the retrain must overwrite it with the new
    // weights via tmp+rename (no half-written file, no leftover tmp).
    const lorasDir = join(root, "loras");
    mkdirSync(lorasDir, { recursive: true });
    writeFileSync(join(lorasDir, "pod_lora.safetensors"), "OLD");
    const { deps, d } = podDeps();
    const job = await mod.startTrainingJob(
      { name: "pod_lora", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
      deps,
    );
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 50));
    const done = (await mod.getJob(job.id))!;
    expect(done.status).toBe("completed");
    expect(readFileSync(join(lorasDir, "pod_lora.safetensors"), "utf-8")).toBe("weights");
    const leftovers = readdirSync(lorasDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toHaveLength(0);
  });

  it("a failed staging TERMINALIZES the job (no orphaned queued record)", async () => {
    const { deps } = podDeps({ rsyncToPod: async () => ({ code: 5, stdout: "", stderr: "no space left on device" }) });
    await expect(
      mod.startTrainingJob(
        { name: "pod_lora", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
        deps,
      ),
    ).rejects.toThrow(/dataset upload to the pod failed/);
    const jobs = await mod.listJobs({ containerRunning: async () => false });
    const job = jobs.find((j) => j.name === "pod_lora")!;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("dataset upload to the pod failed");
    expect(mod.hasActiveTrainingJob("pod")).toBe(false);
  });

  it("a FAILED output pull never publishes (#263 blocker): job fails, no final file, no pod delivery", async () => {
    const { deps, calls, d } = podDeps({
      rsyncFromPod: async (...a: unknown[]) => {
        // Simulate a transfer that died mid-stream: a PARTIAL file landed in
        // the staging dir and the transport reports a nonzero exit.
        const [, , local] = a as [unknown, unknown, string];
        mkdirSync(local, { recursive: true });
        writeFileSync(join(local, "pod_lora.safetensors"), "truncated-172mb-download");
        return { code: 1, stdout: "", stderr: "connection reset by peer" };
      },
    });
    const catalog = deps.catalog as ReturnType<typeof fakeCatalog>;
    const job = await mod.startTrainingJob(
      { name: "pod_lora", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
      deps,
    );
    d.resolve({ code: 0, tail: "" }); // training SUCCEEDED on the pod
    await new Promise((r) => setTimeout(r, 50));
    const done = (await mod.getJob(job.id, { containerRunning: async () => true }))!;
    expect(done.status).toBe("failed"); // NOT completed
    expect(done.error).toMatch(/output transfer failed/);
    // The partial file was never promoted into the final output dir…
    expect(existsSync(join(job.outputDir, job.name))).toBe(false);
    // …no local LoRA was published, no catalog upsert, and — critically for
    // deliverTo pod/both — the good pod-side artifact was NOT overwritten.
    expect(existsSync(join(root, "loras", "pod_lora.safetensors"))).toBe(false);
    expect(calls.lora).toHaveLength(0);
    expect(catalog.upserts).toHaveLength(0);
  });

  it("reconcileStaleTrainingJobs terminalizes a dead-owner pod job so it stops suppressing auto-stop (#263 money)", async () => {
    // A persisted running pod record whose owner pid is dead — the harness
    // crashed mid-run. Nothing ever calls train_status; before the fix this
    // record suppressed the pod idle auto-stop (and its billing) forever.
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const jobDir = join(mod.jobsRoot(), "tpodgone1");
    writeFileSync(join(mod.jobsRoot(), "tpodgone1.json"), JSON.stringify({
      id: "tpodgone1", name: "gone_lora", flow: "character", model: "flux1-dev",
      status: "running", progress: { samples: [] },
      containerName: "pod|root@203.0.113.10|23456", target: "pod",
      ownerPid: 99999999, // almost certainly not alive
      datasetPath: join(mod.datasetsRoot(), "dataset"), jobDir,
      outputDir: join(jobDir, "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    expect(mod.hasActiveTrainingJob("pod")).toBe(true); // the money leak
    const n = await mod.reconcileStaleTrainingJobs({
      containerRunning: async () => false, // remote run.py provably gone
      rsyncFromPod: async () => ({ code: 1, stdout: "", stderr: "pod unreachable" }),
    });
    expect(n).toBe(1);
    expect(mod.hasActiveTrainingJob("pod")).toBe(false); // auto-stop unblocked
    const after = (await mod.getJob("tpodgone1", { containerRunning: async () => false }))!;
    expect(after.status).toBe("failed");
  });

  it("reconcileStaleTrainingJobs leaves a healthy-owner running job alone", async () => {
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const jobDir = join(mod.jobsRoot(), "tpodlive1");
    let probed = 0;
    writeFileSync(join(mod.jobsRoot(), "tpodlive1.json"), JSON.stringify({
      id: "tpodlive1", name: "live_lora", flow: "character", model: "flux1-dev",
      status: "running", progress: { samples: [] },
      containerName: "pod|root@203.0.113.10|23456", target: "pod",
      ownerPid: process.ppid, // alive owner…
      datasetPath: join(mod.datasetsRoot(), "dataset"), jobDir,
      outputDir: join(jobDir, "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), // …with a fresh lease
    }));
    const n = await mod.reconcileStaleTrainingJobs({
      containerRunning: async () => { probed++; return false; },
    });
    expect(n).toBe(0);
    expect(probed).toBe(0); // healthy owners are never even probed
    expect(mod.hasActiveTrainingJob("pod")).toBe(true); // still honestly busy
  });

  it("a pod cancel is scoped to THIS job's config — an unrelated run.py can't fake still-running (#263)", async () => {
    // A running pod job owned by a live process (so refresh won't orphan-recover
    // it). The stop pkills only `run.py <thisConfig>`; the post-stop liveness
    // probe MUST be scoped to the SAME config path. If it were unscoped, an
    // UNRELATED run.py alive on the pod (another registry / manual launch) would
    // report RUNNING and falsely revert this cancel to "running" — which then
    // keeps suppressing pod idle auto-stop. This models exactly that: the probe
    // answers "gone" only when handed this job's config path, "alive" otherwise.
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const jobDir = join(mod.jobsRoot(), "tpodcancel1");
    writeFileSync(join(mod.jobsRoot(), "tpodcancel1.json"), JSON.stringify({
      id: "tpodcancel1", name: "scoped_lora", flow: "character", model: "flux1-dev",
      status: "running", progress: { samples: [] },
      containerName: "pod|root@203.0.113.10|23456", target: "pod",
      ownerPid: process.ppid, // alive owner + fresh lease → not orphan-recovered
      datasetPath: join(mod.datasetsRoot(), "dataset"), jobDir,
      outputDir: join(jobDir, "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const expectedConfig = "/workspace/training/jobs/tpodcancel1/config.yml";
    const probedWith: Array<string | undefined> = [];
    const stoppedWith: Array<string | undefined> = [];
    const after = await mod.cancelJob("tpodcancel1", {
      // Scope-aware: run.py for THIS job's config is gone (false); an unrelated
      // run.py is alive, so an UNSCOPED probe (no config path) would say true.
      containerRunning: async (_name: string, remoteConfigPath?: string) => {
        probedWith.push(remoteConfigPath);
        return remoteConfigPath === expectedConfig ? false : true;
      },
      stopTraining: async (name: string, remoteConfigPath?: string) => {
        stoppedWith.push(remoteConfigPath);
        return { ok: true as const, command: "train_cancel" as const, data: { stopped: name } };
      },
    });
    // Cancel stuck — NOT reverted to running by the unrelated run.py.
    expect(after.status).toBe("cancelled");
    // Both the kill and the post-stop liveness probe were scoped to this job.
    expect(stoppedWith).toContain(expectedConfig);
    expect(probedWith).toContain(expectedConfig);
    expect(probedWith.every((c) => c === expectedConfig)).toBe(true); // never unscoped
    expect(mod.hasActiveTrainingJob("pod")).toBe(false); // auto-stop unblocked
  });

  it("the one-run limit is per POD, not global (pod B is free while pod A trains)", async () => {
    const podA = podDeps();
    await mod.startTrainingJob(
      { name: "pod_a_lora", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
      podA.deps,
    );
    // A different endpoint — must NOT be rejected by pod A's active job.
    const EP_B = { userHost: "root@198.51.100.7", port: 22001 };
    const podB = podDeps();
    const jobB = await mod.startTrainingJob(
      { name: "pod_b_lora", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP_B },
      podB.deps,
    );
    expect(jobB.containerName).toBe("pod|root@198.51.100.7|22001");
    // But a SECOND job on pod A IS rejected.
    await expect(
      mod.startTrainingJob(
        { name: "pod_a2_lora", flow: "character", model: "flux1-dev", datasetPath: stageDataset(), target: "pod", podEndpoint: EP },
        podDeps().deps,
      ),
    ).rejects.toThrow(/already has an active training job/);
    podA.d.resolve({ code: 1, tail: "cleanup" });
    podB.d.resolve({ code: 1, tail: "cleanup" });
    await new Promise((r) => setTimeout(r, 30));
  });
});
