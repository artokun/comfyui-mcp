import { existsSync, readFileSync } from "node:fs";
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
};

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

  // Resolve the expected class_types: explicit list wins, else infer from the pack.
  let expected = (options.classTypes ?? []).map((s) => s.trim()).filter(Boolean);
  if (expected.length === 0) {
    if (!options.name) {
      throw new ValidationError(
        "Provide `class_types` (the NODE_CLASS_MAPPINGS keys to check) or a `name` " +
          "whose __init__.py declares them.",
      );
    }
    const initPy = deps.readPackInit(options.name);
    if (!initPy) {
      throw new ValidationError(
        `Could not read __init__.py for pack "${options.name}" to infer its node ` +
          `class_types. Pass class_types explicitly.`,
      );
    }
    expected = parseClassMappingKeys(initPy);
    if (expected.length === 0) {
      throw new ValidationError(
        `Could not find NODE_CLASS_MAPPINGS keys in "${options.name}"/__init__.py. ` +
          `Pass class_types explicitly.`,
      );
    }
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
      ? `All ${expected.length} node type(s) registered in ComfyUI. The pack loads correctly.`
      : `${missing.length} of ${expected.length} node type(s) are NOT registered: ` +
        `${missing.join(", ")}. The pack likely failed to import — check ComfyUI logs ` +
        `(a missing dependency or a syntax error keeps a node out of /object_info).`,
  };
}
