import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { config, getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { restartComfyUI } from "./process-control.js";
import { ComfyUIError, ProcessControlError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// verify_custom_node — the "test" step of the custom-node author loop.
//
// Restarts the local ComfyUI (reusing the bounded readiness wait), then checks
// that the pack's node class_types actually registered in /object_info. This
// turns "I scaffolded/installed a node" into a concrete pass/fail, surfacing
// import errors (a node that fails to load simply won't appear in /object_info).
//
// LOCAL-ONLY: a restart + filesystem pack read only make sense for a local
// install. Returns a clear error against a remote --comfyui-url target.
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  /** Pack folder under custom_nodes/; used to infer class_types and for messaging. */
  name?: string;
  /** The NODE_CLASS_MAPPINGS keys expected to appear in /object_info. */
  classTypes?: string[];
  /** Restart ComfyUI before checking (default true). Set false to check the live server as-is. */
  restart?: boolean;
}

export interface VerifyResult {
  ready: boolean;
  restarted: boolean;
  expected: string[];
  loaded: string[];
  missing: string[];
  message: string;
}

export interface VerifyDeps {
  /** Restart ComfyUI; resolves once it is ready (or the readiness wait times out). */
  restart: () => Promise<{ ready: boolean; message: string }>;
  /** Return the set of registered node class_types from /object_info. */
  fetchObjectInfoKeys: () => Promise<string[]>;
  /** Read a pack's __init__.py contents, or undefined if absent. */
  readPackInit: (packName: string) => string | undefined;
  /**
   * Read the contents of every Python source file in a pack folder (recursively,
   * bounded). Lets inference find a NODE_CLASS_MAPPINGS literal defined in a
   * submodule and merely re-exported from __init__.py (e.g. cg-use-everywhere's
   * `from .use_everywhere_nodes import NODE_CLASS_MAPPINGS`). Optional.
   */
  readPackSources?: (packName: string) => string[];
  /**
   * Infer a pack's registered class_types from the LIVE server: query
   * /object_info and keep entries whose `python_module` belongs to the pack.
   * Last-resort fallback for packs that build their mappings dynamically (no
   * static literal to parse). Optional; requires a running server.
   */
  inferPackClassTypes?: (packName: string) => Promise<string[]>;
}

const defaultDeps: VerifyDeps = {
  restart: async () => {
    const result = await restartComfyUI();
    return { ready: result.readiness?.ready ?? false, message: result.message };
  },
  fetchObjectInfoKeys: async () => {
    const url = `${getComfyUIBaseUrl()}/object_info`;
    const res = await comfyuiFetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new ComfyUIError(
        `Failed to fetch /object_info: ${res.status} ${res.statusText}`,
        "OBJECT_INFO_FAILED",
      );
    }
    const data = await res.json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new ComfyUIError(
        "Unexpected /object_info response (not a JSON object).",
        "OBJECT_INFO_FAILED",
      );
    }
    return Object.keys(data as Record<string, unknown>);
  },
  readPackInit: (packName: string) => {
    if (!config.comfyuiPath) return undefined;
    const initPath = join(config.comfyuiPath, "custom_nodes", packName, "__init__.py");
    if (!existsSync(initPath)) return undefined;
    try {
      return readFileSync(initPath, "utf-8");
    } catch {
      return undefined;
    }
  },
  readPackSources: (packName: string) => {
    if (!config.comfyuiPath) return [];
    const packDir = join(config.comfyuiPath, "custom_nodes", packName);
    if (!existsSync(packDir)) return [];
    const sources: string[] = [];
    const MAX_FILES = 200;
    // Bounded recursive walk: read .py files, skip vendored / hidden dirs.
    const walk = (dir: string, depth: number): void => {
      if (depth > 4 || sources.length >= MAX_FILES) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (sources.length >= MAX_FILES) break;
        const name = entry.name;
        if (entry.isDirectory()) {
          if (name.startsWith(".") || name === "__pycache__" || name === "node_modules") continue;
          walk(join(dir, name), depth + 1);
        } else if (entry.isFile() && name.endsWith(".py")) {
          try {
            sources.push(readFileSync(join(dir, name), "utf-8"));
          } catch {
            // Skip unreadable files.
          }
        }
      }
    };
    walk(packDir, 0);
    return sources;
  },
  inferPackClassTypes: async (packName: string) => {
    const url = `${getComfyUIBaseUrl()}/object_info`;
    const res = await comfyuiFetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new ComfyUIError(
        `Failed to fetch /object_info: ${res.status} ${res.statusText}`,
        "OBJECT_INFO_FAILED",
      );
    }
    const data = await res.json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new ComfyUIError(
        "Unexpected /object_info response (not a JSON object).",
        "OBJECT_INFO_FAILED",
      );
    }
    return classTypesForPack(data as Record<string, unknown>, packName);
  },
};

/**
 * Given a parsed /object_info map, return the class_types whose `python_module`
 * belongs to `packName`. ComfyUI tags each node with a python_module like
 * "custom_nodes.<folder>" (sometimes with extra ".<submodule>" segments), so we
 * match when the pack folder name appears as a dot-separated segment.
 */
export function classTypesForPack(
  objectInfo: Record<string, unknown>,
  packName: string,
): string[] {
  const out: string[] = [];
  for (const [classType, value] of Object.entries(objectInfo)) {
    if (!value || typeof value !== "object") continue;
    const mod = (value as Record<string, unknown>).python_module;
    if (typeof mod !== "string") continue;
    const segments = mod.split(".");
    if (segments.includes(packName)) out.push(classType);
  }
  return out;
}

/**
 * Parse NODE_CLASS_MAPPINGS keys from an __init__.py. Best-effort regex (Python
 * isn't parsed) — good enough for the common `{ "Key": Cls, ... }` literal the
 * scaffold and most packs use. Returns [] when it can't find a literal.
 */
export function parseClassMappingKeys(initPy: string): string[] {
  const assign = initPy.search(/NODE_CLASS_MAPPINGS\s*=\s*\{/);
  if (assign < 0) return [];
  const open = initPy.indexOf("{", assign);
  // Find the brace that closes the literal by depth-counting, so a brace inside
  // a value (e.g. `"Foo": make({"x": 1})`) doesn't truncate the block.
  let depth = 0;
  let end = -1;
  for (let i = open; i < initPy.length; i += 1) {
    if (initPy[i] === "{") depth += 1;
    else if (initPy[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = end > open ? initPy.slice(open + 1, end) : initPy.slice(open + 1);
  // Match keys at the start of a line only, so keys of inline nested dicts in a
  // value (mid-line) are not mistaken for top-level node class_types.
  const keys: string[] = [];
  const keyRe = /^[ \t]*["']([^"'\n]+)["']\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) keys.push(m[1]);
  return keys;
}

export async function verifyCustomNode(
  options: VerifyOptions,
  deps: VerifyDeps = defaultDeps,
): Promise<VerifyResult> {
  if (!config.comfyuiPath) {
    throw new ProcessControlError(
      "verify_custom_node is local-only: it restarts and inspects a local ComfyUI " +
        "install and needs COMFYUI_PATH. It cannot verify a remote --comfyui-url target.",
    );
  }

  // Resolve the expected class_types: explicit list wins, else infer from the
  // pack. Inference proceeds in escalating order so common packs need no
  // class_types argument:
  //   1. NODE_CLASS_MAPPINGS literal in __init__.py
  //   2. NODE_CLASS_MAPPINGS literal in ANY pack source file (handles packs that
  //      define mappings in a submodule and re-export them, e.g. cg-use-everywhere)
  //   3. (after restart, below) the LIVE /object_info, filtered to this pack's
  //      python_module — covers packs that build mappings dynamically.
  const explicit = (options.classTypes ?? []).map((s) => s.trim()).filter(Boolean);
  let expected = explicit;
  let inferredFromLiveServer = false;
  const haveName = !!options.name;

  if (expected.length === 0 && !haveName) {
    throw new ValidationError(
      "Provide `class_types` (the NODE_CLASS_MAPPINGS keys to check) or a `name` " +
        "whose node class_types can be inferred.",
    );
  }

  if (expected.length === 0 && options.name) {
    // 1. __init__.py literal.
    const initPy = deps.readPackInit(options.name);
    if (initPy) expected = parseClassMappingKeys(initPy);

    // 2. Any pack source file's literal (re-exported mappings).
    if (expected.length === 0 && deps.readPackSources) {
      const seen = new Set<string>();
      for (const src of deps.readPackSources(options.name)) {
        for (const key of parseClassMappingKeys(src)) seen.add(key);
      }
      expected = [...seen];
    }
    // Step 3 (live /object_info) runs after restart, once the server is ready.
  }

  // Restart so newly-added packs are (re)loaded, unless the caller opted out.
  const shouldRestart = options.restart !== false;
  let ready = true;
  let restartMessage = "Skipped restart; checked the running server as-is.";
  if (shouldRestart) {
    const r = await deps.restart();
    ready = r.ready;
    restartMessage = r.message;
    if (!ready) {
      return {
        ready: false,
        restarted: true,
        expected,
        loaded: [],
        missing: expected,
        message:
          `ComfyUI did not become ready after restart, so node loading could not be ` +
          `verified. ${restartMessage}`,
      };
    }
  }

  const registered = new Set(await deps.fetchObjectInfoKeys());

  // 3. Live fallback: still no class_types to check, so derive them from the
  // running server's /object_info, filtered to this pack's python_module. If the
  // pack registered any nodes, that proves it imported cleanly.
  if (expected.length === 0 && options.name && deps.inferPackClassTypes) {
    expected = await deps.inferPackClassTypes(options.name);
    inferredFromLiveServer = true;
  }

  if (expected.length === 0) {
    throw new ValidationError(
      `Could not determine node class_types for pack "${options.name}". No ` +
        `NODE_CLASS_MAPPINGS literal was found in its sources, and ComfyUI's ` +
        `/object_info reports no nodes from this pack (it may have failed to import, ` +
        `or its folder name differs from its python_module). Pass class_types ` +
        `explicitly (the NODE_CLASS_MAPPINGS keys you expect to register).`,
    );
  }

  const loaded = expected.filter((c) => registered.has(c));
  const missing = expected.filter((c) => !registered.has(c));

  const ok = missing.length === 0;
  logger.info("Verified custom node", {
    name: options.name,
    loaded: loaded.length,
    missing: missing.length,
  });

  return {
    ready,
    restarted: shouldRestart,
    expected,
    loaded,
    missing,
    message: ok
      ? `All ${expected.length} node type(s) registered in ComfyUI. The pack loads correctly.` +
        (inferredFromLiveServer
          ? ` (class_types were inferred from the live /object_info for "${options.name}".)`
          : "")
      : `${missing.length} of ${expected.length} node type(s) are NOT registered: ` +
        `${missing.join(", ")}. The pack likely failed to import — check ComfyUI logs ` +
        `(a missing dependency or a syntax error keeps a node out of /object_info).`,
  };
}
