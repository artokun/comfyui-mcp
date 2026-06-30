import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { platform } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { config, isRemoteMode } from "../config.js";
import {
  installCustomNode,
  installModelViaManager,
  listInstalledNodes,
  type InstalledNode,
} from "./node-management.js";
import {
  downloadModel,
  listLocalModels,
  resolveExistingModelFile,
  managerModelDestination,
  MODEL_SUBDIRS,
  type ModelType,
} from "./model-resolver.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const IS_WIN = platform() === "win32";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const YAML_MAX_ALIAS_COUNT = 50;
const ASCII_CONTROL_RE = /[\x00-\x1F\x7F]/;
const WHITESPACE_RE = /\s/;

const modelTypeSchema = z.enum(MODEL_SUBDIRS);

export const manifestSchema = z
  .object({
    apt: z.array(z.string().min(1)).optional().default([]),
    pip: z.array(z.string().min(1)).optional().default([]),
    custom_nodes: z.array(z.string().min(1)).optional().default([]),
    models: z
      .array(
        z
          .object({
            url: z.string().url(),
            model_type: modelTypeSchema.optional(),
            filename: z.string().min(1).optional(),
            local_path: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional()
      .default([]),
  })
  .strict();

export type ComfyManifest = z.infer<typeof manifestSchema>;

export interface ApplyManifestOptions {
  manifest?: unknown;
  path?: string;
}

export type ManifestAction =
  | "apt"
  | "pip"
  | "custom_node"
  | "model";

export type ManifestItemStatus = "applied" | "skipped" | "failed";

export interface ManifestItemReport {
  item: string;
  action: ManifestAction;
  status: ManifestItemStatus;
  message: string;
}

export interface ApplyManifestResult {
  success: boolean;
  summary: Record<ManifestItemStatus, number>;
  results: ManifestItemReport[];
}

function parseManifestText(path: string, text: string): unknown {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return JSON.parse(text);
  if (ext === ".yaml" || ext === ".yml") {
    return parseYaml(text, { maxAliasCount: YAML_MAX_ALIAS_COUNT });
  }
  throw new ValidationError(
    `Unsupported manifest file extension "${ext || "(none)"}". Use .json, .yaml, or .yml.`,
  );
}

export async function loadManifestFile(path: string): Promise<ComfyManifest> {
  const info = await stat(path);
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new ValidationError(
      `Manifest file is too large (${info.size} bytes). Maximum is ${MAX_MANIFEST_BYTES} bytes.`,
    );
  }
  const text = await readFile(path, "utf-8");
  const raw = parseManifestText(path, text);
  return manifestSchema.parse(raw);
}

async function resolveManifest(opts: ApplyManifestOptions): Promise<ComfyManifest> {
  const hasInline = opts.manifest !== undefined;
  const hasPath = opts.path !== undefined && opts.path.trim().length > 0;
  if (hasInline === hasPath) {
    throw new ValidationError(
      "Provide exactly one of `manifest` or `path` to apply_manifest.",
    );
  }
  if (hasInline) return manifestSchema.parse(opts.manifest);
  return loadManifestFile(opts.path!);
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync(IS_WIN ? "where" : cmd, IS_WIN ? [cmd] : ["--version"], {
      encoding: "utf-8",
      stdio: "ignore",
      timeout: 5000,
      shell: false,
    });
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspacePython(comfyuiPath: string): string {
  if (process.env.COMFYUI_PYTHON) return process.env.COMFYUI_PYTHON;
  for (const venv of [".venv", "venv"]) {
    const py = IS_WIN
      ? join(comfyuiPath, venv, "Scripts", "python.exe")
      : join(comfyuiPath, venv, "bin", "python");
    if (existsSync(py)) return py;
  }
  return IS_WIN ? "python" : "python3";
}

function validatePipPackageSpec(pkg: string): void {
  if (pkg.startsWith("-")) {
    throw new ValidationError(`Manifest pip entry must be a package spec, not an option: ${pkg}`);
  }
  if (ASCII_CONTROL_RE.test(pkg)) {
    throw new ValidationError("Manifest pip entry cannot contain ASCII control characters.");
  }
  if (WHITESPACE_RE.test(pkg)) {
    throw new ValidationError(`Manifest pip entry cannot contain whitespace: ${pkg}`);
  }
}

function installPipPackage(pkg: string, comfyuiPath: string): string {
  validatePipPackageSpec(pkg);
  const python = resolveWorkspacePython(comfyuiPath);
  const useUv = commandExists("uv");
  const cmd = useUv ? "uv" : python;
  const args = useUv
    ? ["pip", "install", "--python", python, pkg]
    : ["-m", "pip", "install", pkg];

  logger.info("Installing manifest Python package", {
    package: pkg,
    installer: useUv ? "uv" : "pip",
  });

  const out = execFileSync(cmd, args, {
    cwd: comfyuiPath,
    encoding: "utf-8",
    timeout: 600_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (out ?? "").trim();
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function maybeGitModuleName(value: string): string | undefined {
  if (!/^(https?:\/\/|git@|git\+)/i.test(value) && !value.endsWith(".git")) {
    return undefined;
  }
  const withoutRef = value.replace(/(?<!^)@[^@/]+$/, "");
  const stripped = withoutRef.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const pathPart = stripped.includes(":") && !stripped.includes("://")
    ? stripped.slice(stripped.lastIndexOf(":") + 1)
    : stripped;
  return basename(pathPart).replace(/\.git$/i, "").toLowerCase();
}

function nodeAlreadyInstalled(id: string, installed: InstalledNode[]): boolean {
  const wanted = normalizeId(id);
  const gitModule = maybeGitModuleName(id);
  return installed.some((node) => {
    const candidates = [
      node.module,
      node.cnrId,
      node.auxId,
    ]
      .filter((v): v is string => Boolean(v))
      .map(normalizeId);
    return candidates.includes(wanted) || (gitModule ? candidates.includes(gitModule) : false);
  });
}

function modelsRoot(comfyuiPath: string): string {
  return join(comfyuiPath, "models");
}

function defaultFilenameForUrl(url: string): string {
  return basename(new URL(url).pathname) || "model.safetensors";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function rejectEscapingSymlinkTarget(
  root: string,
  path: string,
  label: string,
): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return;
    const realTarget = await realpath(path);
    if (!isWithinRoot(root, realTarget)) {
      throw new ValidationError(`${label} escapes the models directory: ${path}`);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    // Missing final target is fine; downloadModel will create it.
  }
}

async function validateExistingModelAncestors(
  root: string,
  parent: string,
  realRoot: string,
  localPath: string,
): Promise<void> {
  let cursor = parent;
  while (cursor !== root && cursor.startsWith(root + sep)) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        const realCursor = await realpath(cursor);
        if (!isWithinRoot(realRoot, realCursor)) {
          throw new ValidationError(
            `Model local_path escapes the models directory: ${localPath}`,
          );
        }
      } else if (!info.isDirectory()) {
        throw new ValidationError(`Model local_path parent is not a directory: ${localPath}`);
      }
      return;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      cursor = dirname(cursor);
    }
  }
}

async function resolveLocalModelPath(
  comfyuiPath: string,
  model: ComfyManifest["models"][number],
): Promise<{ targetSubfolder: string; filename: string; targetPath: string }> {
  const root = resolve(modelsRoot(comfyuiPath));

  if (model.local_path) {
    if (isAbsolute(model.local_path)) {
      throw new ValidationError(
        `Model local_path must be relative to models/: ${model.local_path}`,
      );
    }
    const targetPath = resolve(root, model.local_path);
    const rel = relative(root, targetPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    if (!targetPath.startsWith(root + sep)) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    const filename = basename(targetPath);
    if (filename === "." || filename === ".." || filename.length === 0) {
      throw new ValidationError(`Model local_path must include a filename: ${model.local_path}`);
    }
    await mkdir(root, { recursive: true });
    const realRoot = await realpath(root);
    await validateExistingModelAncestors(root, dirname(targetPath), realRoot, model.local_path);
    await mkdir(dirname(targetPath), { recursive: true });
    const realParent = await realpath(dirname(targetPath));
    if (!isWithinRoot(realRoot, realParent)) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    await rejectEscapingSymlinkTarget(realRoot, targetPath, "Model local_path");
    return {
      targetSubfolder: dirname(rel),
      filename,
      targetPath,
    };
  }

  const targetSubfolder: ModelType = model.model_type ?? "checkpoints";
  const filename = model.filename ?? defaultFilenameForUrl(model.url);
  return {
    targetSubfolder,
    filename,
    targetPath: join(root, targetSubfolder, filename),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Decide whether a manifest model already exists locally, honoring EVERY model
 * root ComfyUI loads from — not just the single computed target under
 * `<COMFYUI_PATH>/models`. ComfyUI resolves models across the primary install
 * PLUS the extra roots declared in extra_model_paths.yaml / extra_models_config
 * (commonly on another drive, e.g. E:\). Checking only the computed path
 * re-downloads a large model the user already has under an alternate root.
 *
 * Returns the path where the file was found (absolute for filesystem hits, or a
 * ComfyUI-relative `category/name` for HTTP hits), or undefined if it exists in
 * no root. Best-effort and NEVER throws: any resolver failure (ComfyUI
 * unreachable, no extra roots, cloud mode) is swallowed and we fall back to the
 * single-path check, so a legitimate install is never blocked.
 *
 * Reuses the existing multi-root machinery:
 *  - `resolveExistingModelFile` (model-resolver, #58/#60) — exact relative-path
 *    lookup across the primary root AND every extra_model_paths root, scoped per
 *    category, with the project's containment/symlink guards.
 *  - `listLocalModels` — the category listing ComfyUI actually serves over HTTP
 *    (aggregates symlinked/extra roots and nested subfolders; also works in
 *    remote mode), with a filesystem fallback.
 */
async function findExistingModel(target: {
  targetSubfolder: string;
  filename: string;
  targetPath: string;
}): Promise<string | undefined> {
  // 1. Baseline single-path check (the original behavior). Always safe and is
  //    the source of truth when no extra roots / HTTP are reachable.
  if (await fileExists(target.targetPath)) return target.targetPath;

  // 2. Exact relative-path lookup across the primary models/ root AND every
  //    extra_model_paths root. The category scoping inside the resolver keeps a
  //    `.safetensors` checkpoint from matching a same-named file under loras/.
  const relativePath = (
    target.targetSubfolder && target.targetSubfolder !== "."
      ? `${target.targetSubfolder}/${target.filename}`
      : target.filename
  ).replace(/\\/g, "/");
  try {
    const found = await resolveExistingModelFile(relativePath);
    if (found.info.isFile()) return found.path;
  } catch {
    // Not found in any root, comfyuiPath unset, or traversal — fall through.
  }

  // 3. Match within the category across all roots ComfyUI serves (when running,
  //    the HTTP-aggregated view of extra/symlinked roots; remote setups; and a
  //    filesystem fallback). Category-scoped, so cross-category same-name files
  //    are never mistaken for a match.
  //
  //    The match precision depends on where the target lives:
  //    - CATEGORY ROOT target (e.g. model_type: checkpoints, or local_path
  //      "checkpoints/foo.safetensors"): the intent is "do I already have this
  //      file anywhere in the served category?", so match by basename anywhere
  //      (also catches a model the user stored under a nested subfolder).
  //    - NESTED target (e.g. local_path "checkpoints/foo/model.safetensors"):
  //      the manifest asks for that EXACT relative location. Matching by
  //      basename here would false-skip when only a same-named file under a
  //      DIFFERENT subfolder exists, leaving the requested file absent. So
  //      require an exact category-relative path match instead.
  const subSegments = target.targetSubfolder.split(/[/\\]+/).filter(Boolean);
  const category = subSegments[0];
  if (category && (MODEL_SUBDIRS as readonly string[]).includes(category)) {
    const isCategoryRoot = subSegments.length === 1;
    // The category-relative path implied by the target (strip the leading
    // category segment), normalized to forward slashes for comparison.
    const relWithinCategory = [...subSegments.slice(1), target.filename].join("/");
    try {
      const local = await listLocalModels(category);
      const hit = local.find((m) => {
        const name = m.name.replace(/\\/g, "/");
        return isCategoryRoot
          ? basename(name) === target.filename
          : name === relWithinCategory;
      });
      if (hit) return hit.path;
    } catch {
      // Listing unavailable — fall through to download.
    }
  }

  return undefined;
}

function report(
  action: ManifestAction,
  item: string,
  status: ManifestItemStatus,
  message: string,
): ManifestItemReport {
  return { action, item, status, message };
}

/**
 * Derive ComfyUI-Manager install-model params from a manifest model entry for
 * REMOTE mode (no local filesystem). Honors `local_path` (its first segment is
 * the model dir, the rest is the relative save path) and `model_type`/`filename`
 * the same way the local resolver does, with the same anti-traversal guards.
 */
function remoteModelTarget(model: ComfyManifest["models"][number]): {
  name: string;
  type: string;
  save_path: string;
  filename: string;
} {
  if (model.local_path) {
    if (isAbsolute(model.local_path)) {
      throw new ValidationError(
        `Model local_path must be relative to models/: ${model.local_path}`,
      );
    }
    const segments = model.local_path.split(/[/\\]+/).filter(Boolean);
    if (segments.length === 0 || segments.includes("..")) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    const filename = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);
    if (dirSegments.length === 0) {
      throw new ValidationError(
        `Model local_path must include a category subfolder (e.g. 'checkpoints/foo.safetensors'): ${model.local_path}`,
      );
    }
    // Map our category folder to a Manager-valid { type, save_path }. Nested
    // paths are handed to Manager verbatim; top-level categories resolve via the
    // type-map ("default") or fall back to the folder name.
    const { type, save_path } = managerModelDestination(
      dirSegments[0],
      dirSegments.length > 1 ? dirSegments.join("/") : undefined,
    );
    return { name: filename, type, save_path, filename };
  }

  const category: ModelType = model.model_type ?? "checkpoints";
  const filename = model.filename ?? defaultFilenameForUrl(model.url);
  const { type, save_path } = managerModelDestination(category);
  return { name: filename, type, save_path, filename };
}

async function installedNodesOrEmpty(): Promise<InstalledNode[]> {
  try {
    return await listInstalledNodes();
  } catch (err) {
    logger.warn("Could not list installed custom nodes before manifest apply", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function applyManifest(
  opts: ApplyManifestOptions,
): Promise<ApplyManifestResult> {
  const manifest = await resolveManifest(opts);
  const results: ManifestItemReport[] = [];

  // Per-section mode handling. A LOCAL filesystem is usable only when we are NOT
  // in remote (or cloud) mode AND COMFYUI_PATH is set; otherwise we are targeting
  // a remote/cloud ComfyUI over HTTP. Keying off isRemoteMode() (rather than mere
  // comfyuiPath presence) matters because a remote target can coexist with an
  // unrelated COMFYUI_PATH on this machine — in that case we must still route
  // pip/model handling remotely instead of touching the local install/disk.
  // custom_nodes and models can still be handled remotely through ComfyUI-Manager's
  // HTTP API, but pip/apt have no remote equivalent.
  const comfyuiPath = config.comfyuiPath;
  const hasLocalFs = !isRemoteMode() && Boolean(comfyuiPath);

  for (const pkg of manifest.apt) {
    results.push(
      report(
        "apt",
        pkg,
        "skipped",
        hasLocalFs
          ? "System packages must be installed manually or with root privileges; apply_manifest does not run apt."
          : "System packages are not supported against a remote ComfyUI (no local shell/root access); install them on the ComfyUI host.",
      ),
    );
  }

  for (const pkg of manifest.pip) {
    if (!hasLocalFs) {
      results.push(
        report(
          "pip",
          pkg,
          "skipped",
          "Python package install is not supported against a remote ComfyUI (no local filesystem/venv); install it on the ComfyUI host.",
        ),
      );
      continue;
    }
    try {
      installPipPackage(pkg, comfyuiPath!);
      results.push(report("pip", pkg, "applied", "Python package installed."));
    } catch (err) {
      results.push(
        report(
          "pip",
          pkg,
          "failed",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  const installedNodes = await installedNodesOrEmpty();
  for (const id of manifest.custom_nodes) {
    if (nodeAlreadyInstalled(id, installedNodes)) {
      results.push(report("custom_node", id, "skipped", "Custom node is already installed."));
      continue;
    }
    try {
      const res = await installCustomNode({ id });
      // ComfyUI-Manager marks a git-URL task "done" (queue drained) even when it
      // cloned NOTHING — e.g. a repo not in its registry resolves to nothing, no
      // dir is created, but the queue still empties cleanly. So a successful
      // installCustomNode() call is NOT proof of install. Re-query the installed
      // list (it reflects on-disk custom_nodes via Manager's
      // /v2/customnode/installed, so a freshly-cloned node shows up even before a
      // reboot) and confirm the node is actually present before reporting success.
      const verified = await installedNodesOrEmpty();
      if (nodeAlreadyInstalled(id, verified)) {
        installedNodes.length = 0;
        installedNodes.push(...verified);
        results.push(report("custom_node", id, "applied", res.message));
      } else {
        results.push(
          report(
            "custom_node",
            id,
            "failed",
            `ComfyUI-Manager reported the install as queued/done, but the node is not present afterward — the source likely resolved to nothing (a git URL that isn't in the Manager registry won't clone). Install it directly (git clone into custom_nodes) or use a registry id. ${res.message}`,
          ),
        );
      }
    } catch (err) {
      results.push(
        report(
          "custom_node",
          id,
          "failed",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  for (const model of manifest.models) {
    const item = model.local_path ?? model.filename ?? model.url;
    try {
      if (!hasLocalFs) {
        // REMOTE: no local filesystem to scan/write. Route the download to the
        // ComfyUI host via ComfyUI-Manager's install-model task (server-side
        // fetch). Cloud mode has no Manager, so report it as unsupported.
        if (!isRemoteMode()) {
          results.push(
            report(
              "model",
              item,
              "skipped",
              "Model install is not supported against this ComfyUI (no local filesystem and no ComfyUI-Manager HTTP API); install it on the ComfyUI host.",
            ),
          );
          continue;
        }
        const { name, type, save_path, filename } = remoteModelTarget(model);
        const res = await installModelViaManager({
          name,
          url: model.url,
          filename,
          type,
          save_path,
        });
        results.push(report("model", item, "applied", res.message));
        continue;
      }
      const target = await resolveLocalModelPath(comfyuiPath!, model);
      const existing = await findExistingModel(target);
      if (existing) {
        results.push(report("model", item, "skipped", `Model already exists at ${existing}.`));
        continue;
      }
      const saved = await downloadModel(model.url, target.targetSubfolder, target.filename);
      results.push(report("model", item, "applied", `Model downloaded to ${saved}.`));
    } catch (err) {
      results.push(
        report(
          "model",
          item,
          "failed",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  const summary: Record<ManifestItemStatus, number> = {
    applied: 0,
    skipped: 0,
    failed: 0,
  };
  for (const result of results) summary[result.status]++;

  return {
    success: summary.failed === 0,
    summary,
    results,
  };
}
