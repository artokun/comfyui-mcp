// Provenance sidecar for saved ComfyUI workflows.
//
// Captures everything that determines whether a workflow will produce the
// same output tomorrow as it did today:
//   - Every model file the workflow references, with SHA-256.
//   - Every custom-node pack the workflow's class_types come from, with the
//     git commit currently checked out at custom_nodes/<pack>/.git/HEAD.
//   - The ComfyUI version reported by /system_stats.
//
// Idea credited to josephoibrahim/comfy-cozy. The lock file lives next to the
// workflow in ComfyUI's user library as `workflows/<name>.lock.json`, so it
// travels with the workflow.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { getObjectInfo, getSystemStats } from "../comfyui/client.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { config } from "../config.js";
import { ProcessControlError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

import { MODEL_SUBDIRS } from "./model-resolver.js";

export interface LockedModel {
  name: string;
  type: string; // "checkpoints" | "loras" | "vae" | ...
  sha256?: string; // present when the file was readable locally
  missing?: true; // present when referenced but not found
}

export interface LockedNodePack {
  id: string;
  commit_sha?: string; // HEAD sha; undefined for built-in nodes
  builtin?: true;
}

export interface WorkflowLock {
  generated_at: string;
  comfyui_version: string;
  models: LockedModel[];
  node_packs: LockedNodePack[];
}

export interface LockDrift {
  comfyui_version?: { lock: string; current: string };
  models: Array<{
    name: string;
    type: string;
    lock_sha256?: string;
    current_sha256?: string;
    status: "changed" | "missing" | "added";
  }>;
  node_packs: Array<{
    id: string;
    lock_commit?: string;
    current_commit?: string;
    status: "changed" | "missing" | "added";
  }>;
}

// Which class_type → which input field carries the model filename. This list
// covers the loaders ComfyUI core ships; custom packs are walked best-effort
// via the same input-field heuristic (any string input ending in a model
// extension that resolves under <models>/<subdir>/).
const KNOWN_LOADERS: Array<{ classType: string; field: string; modelType: string }> = [
  { classType: "CheckpointLoaderSimple", field: "ckpt_name", modelType: "checkpoints" },
  { classType: "UNETLoader", field: "unet_name", modelType: "diffusion_models" },
  { classType: "VAELoader", field: "vae_name", modelType: "vae" },
  { classType: "CLIPLoader", field: "clip_name", modelType: "text_encoders" },
  { classType: "DualCLIPLoader", field: "clip_name1", modelType: "text_encoders" },
  { classType: "DualCLIPLoader", field: "clip_name2", modelType: "text_encoders" },
  { classType: "LoraLoader", field: "lora_name", modelType: "loras" },
  { classType: "LoraLoaderModelOnly", field: "lora_name", modelType: "loras" },
  { classType: "ControlNetLoader", field: "control_net_name", modelType: "controlnet" },
  { classType: "UpscaleModelLoader", field: "model_name", modelType: "upscale_models" },
  { classType: "CLIPVisionLoader", field: "clip_name", modelType: "clip_vision" },
  { classType: "StyleModelLoader", field: "style_model_name", modelType: "style_models" },
];

function requireLocal(op: string): string {
  if (!config.comfyuiPath) {
    throw new ProcessControlError(
      `${op} requires a local ComfyUI install (COMFYUI_PATH). Lock generation needs to read model file bytes for SHA-256 and inspect custom_nodes/*/.git/HEAD.`,
    );
  }
  return config.comfyuiPath;
}

function extractReferencedModels(workflow: WorkflowJSON): Array<{ name: string; type: string }> {
  const seen = new Map<string, string>(); // key: `${type}/${name}` → type
  for (const node of Object.values(workflow)) {
    if (!node?.class_type || !node.inputs) continue;
    const classMatches = KNOWN_LOADERS.filter((l) => l.classType === node.class_type);
    for (const match of classMatches) {
      const value = (node.inputs as Record<string, unknown>)[match.field];
      if (typeof value !== "string" || !value) continue;
      seen.set(`${match.modelType}/${value}`, match.modelType);
    }
  }
  return Array.from(seen.entries()).map(([key, type]) => ({
    name: key.slice(type.length + 1),
    type,
  }));
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function findModelOnDisk(
  comfyPath: string,
  modelType: string,
  filename: string,
): Promise<string | undefined> {
  // Try the canonical subdir first; ComfyUI's extra_model_paths.yaml may add
  // others, but those resolve at workflow-execution time and we don't have a
  // good way to enumerate them without parsing the YAML.
  const subdirs = MODEL_SUBDIRS.includes(modelType as never)
    ? [modelType]
    : [modelType, ...MODEL_SUBDIRS];
  for (const subdir of subdirs) {
    const candidate = join(comfyPath, "models", subdir, filename);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

async function readGitHeadCommit(packPath: string): Promise<string | undefined> {
  const headPath = join(packPath, ".git", "HEAD");
  try {
    const head = (await readFile(headPath, "utf-8")).trim();
    if (head.startsWith("ref: ")) {
      const refPath = join(packPath, ".git", head.slice(5).trim());
      try {
        return (await readFile(refPath, "utf-8")).trim();
      } catch {
        // Packed refs path — fall back to refs/packed.
        try {
          const packed = await readFile(
            join(packPath, ".git", "packed-refs"),
            "utf-8",
          );
          const wanted = head.slice(5).trim();
          for (const line of packed.split("\n")) {
            if (line.endsWith(` ${wanted}`)) {
              return line.split(" ")[0].trim();
            }
          }
        } catch {
          return undefined;
        }
      }
    }
    // Detached HEAD: contents are the commit SHA directly.
    if (/^[0-9a-f]{7,40}$/.test(head)) return head;
  } catch {
    return undefined;
  }
  return undefined;
}

interface ClassTypeOriginMap {
  byClass: Map<string, { pack: string | null; builtin: boolean }>;
}

async function buildClassTypeOriginMap(): Promise<ClassTypeOriginMap> {
  const byClass = new Map<string, { pack: string | null; builtin: boolean }>();
  const info = (await getObjectInfo()) as unknown as Record<string, { python_module?: string }>;
  for (const [classType, def] of Object.entries(info ?? {})) {
    const mod = def?.python_module ?? "";
    // `python_module` is e.g. "custom_nodes.ComfyUI-WanVideoWrapper.nodes" for
    // a custom pack, or "comfy_extras.nodes_*" / "nodes" for built-ins.
    if (mod.startsWith("custom_nodes.")) {
      const pack = mod.split(".")[1] ?? null;
      byClass.set(classType, { pack, builtin: false });
    } else if (mod) {
      byClass.set(classType, { pack: null, builtin: true });
    }
  }
  return { byClass };
}

async function packsReferencedByWorkflow(
  workflow: WorkflowJSON,
  origins: ClassTypeOriginMap,
): Promise<string[]> {
  const packs = new Set<string>();
  for (const node of Object.values(workflow)) {
    const classType = node?.class_type;
    if (!classType) continue;
    const origin = origins.byClass.get(classType);
    if (origin?.pack) packs.add(origin.pack);
  }
  return Array.from(packs).sort();
}

export async function generateLock(workflow: WorkflowJSON): Promise<WorkflowLock> {
  const comfyPath = requireLocal("generateLock");
  const stats = (await getSystemStats()) as unknown as { system?: { comfyui_version?: string } };
  const comfyuiVersion = stats.system?.comfyui_version ?? "unknown";

  const models = extractReferencedModels(workflow);
  const lockedModels: LockedModel[] = [];
  for (const m of models) {
    const path = await findModelOnDisk(comfyPath, m.type, m.name);
    if (!path) {
      lockedModels.push({ ...m, missing: true });
      continue;
    }
    try {
      const sha256 = await hashFile(path);
      lockedModels.push({ ...m, sha256 });
    } catch (err) {
      logger.warn("Could not SHA-256 model file", {
        name: m.name,
        error: err instanceof Error ? err.message : err,
      });
      lockedModels.push({ ...m, missing: true });
    }
  }

  const origins = await buildClassTypeOriginMap();
  const packIds = await packsReferencedByWorkflow(workflow, origins);
  const lockedPacks: LockedNodePack[] = [];
  for (const id of packIds) {
    const packPath = join(comfyPath, "custom_nodes", id);
    const commit = await readGitHeadCommit(packPath);
    lockedPacks.push(commit ? { id, commit_sha: commit } : { id });
  }

  // Built-in dependencies don't get a separate row — the ComfyUI version field
  // covers them. Only custom packs appear in node_packs.

  return {
    generated_at: new Date().toISOString(),
    comfyui_version: comfyuiVersion,
    models: lockedModels,
    node_packs: lockedPacks,
  };
}

/**
 * Parse a lock file's raw body into a WorkflowLock, tolerating a missing or
 * empty file. ComfyUI's /api/userdata can return 200 with an empty body for a
 * file that doesn't exist; feeding that straight to JSON.parse throws
 * "Unexpected end of JSON input". Returns null when there is no lock present
 * (empty/whitespace body) so callers can report "no lock" gracefully, and
 * throws a clear ValidationError only when the body is genuinely malformed.
 */
export function parseWorkflowLock(raw: string | null | undefined): WorkflowLock | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new ValidationError(
      `Lock file exists but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as WorkflowLock;
}

export function diffLocks(lock: WorkflowLock, current: WorkflowLock): LockDrift {
  const drift: LockDrift = { models: [], node_packs: [] };

  if (lock.comfyui_version !== current.comfyui_version) {
    drift.comfyui_version = { lock: lock.comfyui_version, current: current.comfyui_version };
  }

  const lockModels = new Map(lock.models.map((m) => [`${m.type}/${m.name}`, m]));
  const currentModels = new Map(current.models.map((m) => [`${m.type}/${m.name}`, m]));
  for (const [key, m] of lockModels) {
    const c = currentModels.get(key);
    if (!c || c.missing) {
      drift.models.push({
        name: m.name,
        type: m.type,
        lock_sha256: m.sha256,
        status: "missing",
      });
      continue;
    }
    if (m.sha256 && c.sha256 && m.sha256 !== c.sha256) {
      drift.models.push({
        name: m.name,
        type: m.type,
        lock_sha256: m.sha256,
        current_sha256: c.sha256,
        status: "changed",
      });
    }
  }
  for (const [key, c] of currentModels) {
    if (!lockModels.has(key)) {
      drift.models.push({
        name: c.name,
        type: c.type,
        current_sha256: c.sha256,
        status: "added",
      });
    }
  }

  const lockPacks = new Map(lock.node_packs.map((p) => [p.id, p]));
  const currentPacks = new Map(current.node_packs.map((p) => [p.id, p]));
  for (const [id, p] of lockPacks) {
    const c = currentPacks.get(id);
    if (!c) {
      drift.node_packs.push({ id, lock_commit: p.commit_sha, status: "missing" });
      continue;
    }
    if (p.commit_sha && c.commit_sha && p.commit_sha !== c.commit_sha) {
      drift.node_packs.push({
        id,
        lock_commit: p.commit_sha,
        current_commit: c.commit_sha,
        status: "changed",
      });
    }
  }
  for (const [id, c] of currentPacks) {
    if (!lockPacks.has(id)) {
      drift.node_packs.push({ id, current_commit: c.commit_sha, status: "added" });
    }
  }

  return drift;
}
