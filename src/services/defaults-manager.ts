import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";

export type DefaultSource = "config" | "env" | "runtime";

export interface ResolvedValue {
  value: unknown;
  source: DefaultSource;
}

interface ManagerConfig {
  configPath: string;
  env: Record<string, string | undefined>;
}

const ENV_PREFIX = "COMFYUI_DEFAULT_";

function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(root, "comfyui-mcp", "config.json");
}

function defaultEnv(): Record<string, string | undefined> {
  return process.env;
}

const state = {
  cfg: { configPath: defaultConfigPath(), env: defaultEnv() } as ManagerConfig,
  configValues: {} as Record<string, unknown>,
  runtimeValues: {} as Record<string, unknown>,
  /** Why the on-disk config is not being applied, when it EXISTS and failed to
   *  load. Undefined = loaded fine, or there is no file. See configLoadError(). */
  configError: undefined as string | undefined,
};

function parseEnvValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function envDefaults(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || val === undefined) continue;
    const name = key.slice(ENV_PREFIX.length).toLowerCase();
    if (name.length === 0) continue;
    out[name] = parseEnvValue(val);
  }
  return out;
}

export const DefaultsManager = {
  configure(opts: Partial<ManagerConfig>): void {
    if (opts.configPath !== undefined) state.cfg.configPath = opts.configPath;
    if (opts.env !== undefined) state.cfg.env = opts.env;
  },

  reset(): void {
    state.cfg = { configPath: defaultConfigPath(), env: defaultEnv() };
    state.configValues = {};
    state.runtimeValues = {};
    state.configError = undefined;
  },

  getConfigPath(): string {
    return state.cfg.configPath;
  },

  async load(): Promise<void> {
    state.runtimeValues = {};
    state.configError = undefined;
    if (!existsSync(state.cfg.configPath)) {
      state.configValues = {};
      return;
    }
    try {
      const raw = await readFile(state.cfg.configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        state.configValues = parsed as Record<string, unknown>;
      } else {
        logger.warn("Defaults config file is not a JSON object, ignoring", {
          path: state.cfg.configPath,
        });
        state.configValues = {};
        state.configError = "it is valid JSON but not an object (an array or a bare value)";
      }
    } catch (err) {
      logger.warn("Failed to parse defaults config file, ignoring", {
        path: state.cfg.configPath,
        error: err instanceof Error ? err.message : err,
      });
      state.configValues = {};
      state.configError = err instanceof Error ? err.message : String(err);
    }
  },

  /**
   * Why the config file on disk is NOT being applied, if it is not (#796).
   *
   * A file that EXISTS and could not be loaded left `configValues` empty with
   * only a `logger.warn` to show for it. The user wrote that file to change what
   * gets generated, and the only signal that it stopped applying went to a log
   * they may have no access to — so their renders quietly used different
   * settings and `get_defaults action:"get"` reported the built-ins as though
   * nothing were wrong.
   *
   * Undefined means the file was loaded, or there is no file — both fine.
   */
  configLoadError(): string | undefined {
    return state.configError;
  },

  /**
   * Return the resolved view of all defaults, with source attribution.
   * Precedence (lowest → highest): config → env → runtime.
   */
  getAll(): Record<string, ResolvedValue> {
    const merged: Record<string, ResolvedValue> = {};
    for (const [k, v] of Object.entries(state.configValues)) {
      merged[k] = { value: v, source: "config" };
    }
    for (const [k, v] of Object.entries(envDefaults(state.cfg.env))) {
      merged[k] = { value: v, source: "env" };
    }
    for (const [k, v] of Object.entries(state.runtimeValues)) {
      merged[k] = { value: v, source: "runtime" };
    }
    return merged;
  },

  get(key: string): ResolvedValue | undefined {
    return this.getAll()[key];
  },

  async set(
    updates: Record<string, unknown>,
    opts?: { persist?: boolean },
  ): Promise<void> {
    for (const [k, v] of Object.entries(updates)) {
      state.runtimeValues[k] = v;
    }
    if (opts?.persist) {
      // The file exists and we could not load it, so `state.configValues` is
      // EMPTY — not because the user has no defaults, but because we could not
      // read the ones they wrote. Merging into `{}` and writing would replace
      // their file with just this update, destroying hand-written content whose
      // only problem may be a trailing comma (#796).
      //
      // Unlike the session store, a PARSE failure is preserved here too: that
      // file is machine-written, this one is typed by a person, so unparseable
      // means "has a typo in content they care about", not "worthless bytes".
      if (state.configError !== undefined) {
        const aside = `${state.cfg.configPath}.unreadable-${Date.now()}`;
        try {
          await rename(state.cfg.configPath, aside);
          logger.warn(
            `Preserved the unloadable defaults config as ${aside} before writing a fresh one ` +
              `(it could not be loaded: ${state.configError}). Your previous settings are in that file.`,
          );
          state.configError = undefined; // preserved — later writes are ordinary
        } catch (err) {
          throw new Error(
            `Refusing to overwrite ${state.cfg.configPath}: it could not be loaded ` +
              `(${state.configError}) and could not be moved aside either ` +
              `(${err instanceof Error ? err.message : String(err)}), so writing would destroy ` +
              `settings that are probably still there. The values you just set are active for ` +
              `this session; fix or move that file to persist them.`,
          );
        }
      }
      const merged = { ...state.configValues, ...updates };
      state.configValues = merged;
      const dir = dirname(state.cfg.configPath);
      await mkdir(dir, { recursive: true });
      await writeFile(state.cfg.configPath, JSON.stringify(merged, null, 2), "utf-8");
    }
  },

  /**
   * Fill missing or undefined fields in `args` from resolved defaults.
   * Per-call args win — only undefined-or-missing keys get backfilled.
   */
  apply<T extends Record<string, unknown>>(args: T): T & Record<string, unknown> {
    const result: Record<string, unknown> = { ...args };
    const resolved = this.getAll();
    for (const [k, { value }] of Object.entries(resolved)) {
      if (result[k] === undefined) result[k] = value;
    }
    return result as T & Record<string, unknown>;
  },
};
