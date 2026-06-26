import { isAbsolute, join, resolve } from "node:path";
import { config } from "../config.js";
import { getSystemStats } from "../comfyui/client.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Resolve ComfyUI's REAL output directory.
//
// ComfyUI can be launched with --output-directory (or --base-directory) which
// redirects generated images away from the default <COMFYUI_PATH>/output (e.g.
// to a shared drive like ComfyUI-Shared\output). Tools that scan the output
// directory on the local filesystem (convert_image, list_output_images) must
// therefore NOT assume <COMFYUI_PATH>/output, or they find nothing after a
// successful render.
//
// The authoritative source is ComfyUI itself: /system_stats reports the launch
// argv (system.argv), from which we parse --output-directory / --base-directory.
// We fall back to <COMFYUI_PATH>/output when ComfyUI is unreachable or did not
// override the directory. Same class of fix as the doubled-COMFYUI_PATH bug.
// ---------------------------------------------------------------------------

/** Resolve a possibly-relative dir against a base (or COMFYUI_PATH, or cwd). */
function resolveDir(value: string, base?: string): string {
  if (isAbsolute(value)) return resolve(value);
  const root = base ?? config.comfyuiPath ?? process.cwd();
  return resolve(root, value);
}

/** Read a flag's value supporting both `--flag value` and `--flag=value`. */
function flagValue(argv: string[], index: number, flag: string): string | undefined {
  const token = argv[index];
  if (token === flag) return argv[index + 1];
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  return undefined;
}

/**
 * Parse the configured output directory out of ComfyUI's launch argv.
 * --output-directory wins; otherwise --base-directory implies <base>/output.
 * Returns undefined when neither flag is present.
 */
export function parseOutputDirFromArgv(argv: string[] | undefined): string | undefined {
  if (!argv || argv.length === 0) return undefined;

  let outputDir: string | undefined;
  let baseDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    outputDir = flagValue(argv, i, "--output-directory") ?? outputDir;
    baseDir = flagValue(argv, i, "--base-directory") ?? baseDir;
  }

  const resolvedBase = baseDir ? resolveDir(baseDir) : undefined;
  if (outputDir) return resolveDir(outputDir, resolvedBase);
  if (resolvedBase) return join(resolvedBase, "output");
  return undefined;
}

/** <COMFYUI_PATH>/output fallback. Throws if COMFYUI_PATH is unset. */
export function localOutputDirFallback(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return resolve(config.comfyuiPath, "output");
}

/**
 * Resolve the directory ComfyUI actually writes outputs to. Asks the running
 * ComfyUI (/system_stats argv) first; falls back to <COMFYUI_PATH>/output.
 */
export async function resolveOutputDir(): Promise<string> {
  try {
    const stats = await getSystemStats();
    const fromArgv = parseOutputDirFromArgv(stats.system?.argv);
    if (fromArgv) {
      logger.debug("Resolved ComfyUI output directory from launch argv", {
        outputDir: fromArgv,
      });
      return fromArgv;
    }
  } catch (err) {
    logger.debug(
      "Could not resolve output dir from /system_stats; using COMFYUI_PATH/output",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  return localOutputDirFallback();
}
