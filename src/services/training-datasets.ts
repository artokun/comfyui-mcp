// Dataset + job-config readers behind the training surfaces (panel Jobs/
// Datasets tabs, the mobile monitor). READ-ONLY, and bounded to the training
// root: dataset names are basename-checked, action:"file" paths are realpath-
// contained, and inlining is size-capped (a phone is the other end).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { datasetsRoot, getJob, trainingRoot } from "./training-jobs.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
/** train_prepare_dataset (action:"file") inlining cap — a sample/dataset photo, not a checkpoint. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface DatasetSummary {
  name: string;
  imageCount: number;
  captionedCount: number;
  /** Latest file mtime in the dir (ISO string). */
  modified: string;
}

export interface DatasetDetail extends DatasetSummary {
  datasetPath: string;
  items: Array<{ file: string; caption: string | null }>;
}

/** Containment on REAL paths — a symlinked dir must not smuggle reads across
 *  the root (same lesson as the ref resolver, #302). A MISSING path resolves
 *  through its deepest existing ancestor with the absent tail re-appended, so it
 *  is spelled the same way as the (existing, realpath'd) root it is compared
 *  against and fails later with an honest not-found. Resolving it lexically
 *  instead compared "/var/…/datasets/x" with "/private/var/…/datasets" under any
 *  aliased root (macOS temp, a symlinked home, a Windows junction) and reported an
 *  ordinary unknown name as an ESCAPE. An ENOENT tail is not proof that no link
 *  is involved — a DANGLING symlink also reports ENOENT, and its eventual target
 *  is not resolved here; such a path has nothing to read now, and callers still
 *  stat/read it and fail on absence. Any other realpath failure keeps the lexical
 *  form, as before. */
function realOrLexical(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const parent = dirname(cur);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

function contained(child: string, root: string): boolean {
  const c = realOrLexical(child);
  const r = realOrLexical(root);
  const norm = (x: string) => (process.platform === "win32" ? x.toLowerCase() : x);
  return norm(c) === norm(r) || norm(c).startsWith(norm(r) + sep);
}

/** Resolve a dataset dir by NAME. Rules mirror prepareDataset's sanitizeDirName
 *  (dot-prefixed names like ".portrait" are legal dataset dirs; dots-only
 *  collapses and separators are not). Staging dirs from in-flight/crashed
 *  prepares are internal and never resolve here (codex finding). */
function datasetDir(name: string): string {
  const clean = name.trim();
  if (!clean || clean !== basename(clean) || /^\.+$/.test(clean)) {
    throw new Error(`invalid dataset name "${name}"`);
  }
  if (clean.includes(".staging-")) {
    throw new Error(`"${clean}" is an internal staging dir, not a dataset`);
  }
  const dir = join(datasetsRoot(), clean);
  if (!contained(dir, datasetsRoot())) {
    throw new Error(`dataset "${name}" escapes the datasets root`);
  }
  if (!existsSync(dir)) throw new Error(`no dataset "${clean}" (looked in ${datasetsRoot()})`);
  return dir;
}

function summarize(dir: string, name: string): DatasetSummary {
  const files = readdirSync(dir);
  const images = files.filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()));
  const captioned = images.filter((f) =>
    existsSync(join(dir, `${basename(f, extname(f))}.txt`)),
  );
  const modified = Math.max(
    0,
    ...files.map((f) => {
      try {
        return statSync(join(dir, f)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  return {
    name,
    imageCount: images.length,
    captionedCount: captioned.length,
    modified: new Date(modified || 0).toISOString(),
  };
}

/** Every staged dataset, newest first. Internal staging dirs from in-flight
 *  or crashed prepares (`<name>.staging-<pid>-<rand>`) are NOT datasets — an
 *  abandoned partial set must never be advertised as trainable (codex). */
export function listDatasets(): DatasetSummary[] {
  const root = datasetsRoot();
  if (!existsSync(root)) return [];
  // Newest first; a deterministic name tiebreaker keeps the order STABLE when two
  // datasets share an mtime (coarse filesystem granularity) — otherwise the order
  // follows readdir and varies by platform.
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.includes(".staging-"))
    .map((d) => summarize(join(root, d.name), d.name))
    .filter((s) => s.imageCount > 0)
    .sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
}

/** One dataset's items with their captions (null when uncaptioned). */
export function getDataset(name: string): DatasetDetail {
  const dir = datasetDir(name);
  const files = readdirSync(dir)
    .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
    .sort();
  const items = files.map((f) => {
    const capPath = join(dir, `${basename(f, extname(f))}.txt`);
    let caption: string | null = null;
    try {
      caption = readFileSync(capPath, "utf-8").trim() || null;
    } catch {
      /* uncaptioned */
    }
    return { file: f, caption };
  });
  return { ...summarize(dir, name), datasetPath: dir, items };
}

// ── Dataset mutations (edit captions, delete images, delete datasets) ───────

import { rmSync, renameSync } from "node:fs";
import { listJobs } from "./training-jobs.js";
import { buildTrainingConfig, type TrainParams } from "./training-config.js";

function samePath(a: string, b: string): boolean {
  const norm = (x: string) => (process.platform === "win32" ? x.toLowerCase() : x);
  return norm(resolve(a)) === norm(resolve(b));
}

/** A dataset dir a RUNNING/QUEUED job trains from must not be edited or
 *  deleted (the dir is bind-mounted into the running container — same guard
 *  as prepareDataset's replace check, codex finding lineage). */
export async function assertDatasetEditable(dir: string, what: string): Promise<void> {
  const active = await listJobs();
  const inUse = active.find(
    (j) => (j.status === "running" || j.status === "queued") && j.datasetPath && samePath(j.datasetPath, dir),
  );
  if (inUse) {
    throw new Error(`dataset is in use by ${inUse.status} job ${inUse.id} — ${what} is blocked until it finishes (or cancel it first)`);
  }
}

export interface DatasetUpdateResult {
  captionsSet: number;
  imagesDeleted: number;
  warnings: string[];
}

/** Edit captions and/or delete images in a staged dataset. Caption writes are
 *  atomic per file (tmp+rename); unknown files are warnings, never silent. */
export async function updateDataset(
  name: string,
  opts: { setCaptions?: Record<string, string>; deleteImages?: string[] },
): Promise<DatasetUpdateResult> {
  const dir = datasetDir(name);
  await assertDatasetEditable(dir, "editing");
  const warnings: string[] = [];
  let captionsSet = 0;
  let imagesDeleted = 0;
  for (const [file, caption] of Object.entries(opts.setCaptions ?? {})) {
    if (file !== basename(file) || !IMAGE_EXTS.has(extname(file).toLowerCase())) {
      warnings.push(`${file}: skipped (not a supported image file)`);
      continue;
    }
    const img = join(dir, file);
    if (!existsSync(img) || !statSync(img).isFile()) {
      warnings.push(`${file}: no such image — caption not written`);
      continue;
    }
    const cap = join(dir, `${basename(file, extname(file))}.txt`);
    const tmp = `${cap}.tmp-${process.pid}`;
    writeFileSync(tmp, caption.trim());
    renameSync(tmp, cap);
    captionsSet++;
  }
  for (const file of opts.deleteImages ?? []) {
    if (file !== basename(file) || !IMAGE_EXTS.has(extname(file).toLowerCase())) {
      warnings.push(`${file}: skipped (not a supported image file)`);
      continue;
    }
    const img = join(dir, file);
    if (!existsSync(img) || !statSync(img).isFile()) {
      warnings.push(`${file}: no such image`);
      continue;
    }
    rmSync(img, { force: true });
    rmSync(join(dir, `${basename(file, extname(file))}.txt`), { force: true });
    imagesDeleted++;
  }
  return { captionsSet, imagesDeleted, warnings };
}

/** Delete a whole staged dataset (dir + captions). In-use guard as above. */
export async function deleteDataset(name: string): Promise<void> {
  const dir = datasetDir(name);
  await assertDatasetEditable(dir, "deleting");
  rmSync(dir, { recursive: true, force: true });
}

/** The raw YAML train_start would write for these settings — the ostris-UI
 *  "raw config" preview. NO side effects (nothing is written or started). */
export function previewConfig(input: {
  name: string;
  datasetPath: string;
  trigger?: string;
  params?: Partial<TrainParams>;
}): { jobName: string; yaml: string } {
  const built = buildTrainingConfig({
    name: input.name,
    flow: "character",
    model: "flux1-dev",
    datasetPath: input.datasetPath,
    outputDir: join(trainingRoot(), "jobs", "<job>", "output"),
    trigger: input.trigger,
    params: input.params,
  });
  return { jobName: built.jobName, yaml: built.yaml };
}

// ── action:"file": bounded inline reads under the training root ────────────

/** Read an image under the training root (dataset images, job samples) as
 *  base64 for the MCP image channel. Contained, image-only, size-capped. */
export function readTrainingFile(absPath: string): { data: string; mimeType: string } {
  if (!contained(absPath, trainingRoot())) {
    throw new Error("path escapes the training root");
  }
  const p = realOrLexical(absPath);
  const ext = extname(p).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw new Error(`only image files are served (${[...IMAGE_EXTS].join("/")}), not ${ext || "(none)"}`);
  }
  const st = statSync(p); // ENOENT surfaces honestly as "no such file"
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`file too large to inline (${(st.size / 1024 / 1024).toFixed(1)} MB > 2 MB) — fetch it on the rig instead`);
  }
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { data: readFileSync(p).toString("base64"), mimeType };
}

// ── action:"job_config": "what settings did this run use?" ─────────────────

export interface JobConfigView {
  id: string;
  name: string;
  flow: string;
  model: string;
  trigger?: string;
  datasetPath: string;
  /** The raw ai-toolkit config.yml text the job consumed (the ostris-UI "raw
   *  config" view) — null when the file is gone/unreadable. */
  rawYaml: string | null;
  params: {
    steps?: number;
    lr?: number;
    rank?: number;
    resolution?: number[];
    batchSize?: number;
    saveEvery?: number;
    sampleEvery?: number;
    quantize?: boolean;
  };
  /** Where params were read from. "config.yml" covers every job incl. records
   *  written before any params-persistence; "unknown" when unreadable. */
  source: "config.yml" | "unknown";
}

/** Read a job's effective settings back from the ai-toolkit config.yml we
 *  wrote for it (the single source of truth run.py consumed). */
export async function getJobConfig(id: string): Promise<JobConfigView> {
  const job = await getJob(id);
  if (!job) throw new Error(`no training job ${id}`);
  const params: JobConfigView["params"] = {};
  let source: JobConfigView["source"] = "unknown";
  let rawYaml: string | null = null;
  try {
    rawYaml = readFileSync(join(job.jobDir, "config.yml"), "utf-8");
    const doc = parseYaml(rawYaml) as {
      config?: { process?: Array<Record<string, unknown>> };
    };
    const proc = (doc?.config?.process?.[0] ?? {}) as Record<string, Record<string, unknown> & { datasets?: Array<Record<string, unknown>> }>;
    const train = proc.train ?? {};
    const network = proc.network ?? {};
    const save = proc.save ?? {};
    const sample = proc.sample ?? {};
    const model = proc.model ?? {};
    const ds = Array.isArray(proc.datasets) ? (proc.datasets[0] ?? {}) : {};
    if (typeof train.steps === "number") params.steps = train.steps;
    if (typeof train.lr === "number") params.lr = train.lr;
    if (typeof network.linear === "number") params.rank = network.linear;
    if (Array.isArray(ds.resolution)) params.resolution = ds.resolution as number[];
    if (typeof train.batch_size === "number") params.batchSize = train.batch_size;
    if (typeof save.save_every === "number") params.saveEvery = save.save_every;
    if (typeof sample.sample_every === "number") params.sampleEvery = sample.sample_every;
    if (typeof model.quantize === "boolean") params.quantize = model.quantize;
    source = "config.yml";
  } catch {
    // config.yml missing/unreadable — return the record fields, empty params
  }
  return {
    id: job.id,
    name: job.name,
    flow: job.flow,
    model: job.model,
    trigger: job.trigger,
    datasetPath: job.datasetPath,
    rawYaml,
    params,
    source,
  };
}
