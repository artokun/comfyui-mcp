import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface DshInstallation {
  command: string;
  args: string[];
  home: string;
  source: "configured" | "path" | "standard" | "running" | "cached";
  overlays?: string[];
  defaultModel?: string;
  defaultEffort?: string;
}

export interface DshDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  node?: string;
  procRoot?: string;
}

function file(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function launch(
  path: string,
  home: string,
  source: DshInstallation["source"],
  node: string,
): DshInstallation | null {
  if (!file(path)) return null;
  const target = realpathSync(path);
  if (/\.(?:cmd|bat|ps1)$/i.test(target)) {
    // Resolve the npm shim to JS; never pass user paths through cmd.exe.
    const script = join(
      dirname(target),
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js",
    );
    return file(script)
      ? {
          command: node,
          args: [script],
          home,
          source,
          overlays: dshMemoryOverlays(home),
          ...dshDefaultSelection(home),
        }
      : null;
  }
  return /\.[cm]?js$/i.test(target)
    ? {
        command: node,
        args: [path],
        home,
        source,
        overlays: dshMemoryOverlays(home),
        ...dshDefaultSelection(home),
      }
    : {
        command: target,
        args: [],
        home,
        source,
        overlays: dshMemoryOverlays(home),
        ...dshDefaultSelection(home),
      };
}

function hintPath(env: NodeJS.ProcessEnv, home: string) {
  return join(
    env.COMFYUI_MCP_DATA_DIR || join(home, ".comfyui-mcp"),
    "dsh-installation.json",
  );
}
export function rememberDshInstallation(value: DshInstallation) {
  if (value.args.length !== 1) return;
  try {
    const file = hintPath(process.env, homedir());
    mkdirSync(dirname(file), { recursive: true });
    const pending = file + "." + process.pid + ".tmp";
    writeFileSync(
      pending,
      JSON.stringify({
        command: value.command,
        args: value.args,
        home: value.home,
      }),
      { mode: 0o600 },
    );
    renameSync(pending, file);
  } catch {
    /* A read-only configuration directory must not disable a working CLI. */
  }
}

export function dshDefaultSelection(home: string): {
  defaultModel?: string;
  defaultEffort?: string;
} {
  try {
    const settings = parseYaml(
      readFileSync(join(home, "settings.yaml"), "utf8"),
    )?.["agent-default-model"];
    if (
      typeof settings?.provider !== "string" ||
      typeof settings?.model !== "string"
    )
      return {};
    return {
      defaultModel: JSON.stringify([settings.provider, settings.model]),
      ...(typeof settings.reasoningEffort === "string"
        ? { defaultEffort: settings.reasoningEffort }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Reuse an already-selected memory bundle; never install one or copy secrets. */
export function dshMemoryOverlays(home: string): string[] {
  try {
    const acp = JSON.parse(
      readFileSync(join(home, "profiles/acp/package.json"), "utf8"),
    );
    if (acp.dsh?.profile?.bundles?.includes("dsh-mnemon")) return [];
  } catch {
    /* The official CLI may not have initialized the ACP profile yet. */
  }
  for (const profile of ["web", "tui"]) {
    const directory = join(home, "profiles", profile);
    try {
      const profilePackage = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (!profilePackage.dsh?.profile?.bundles?.includes("dsh-mnemon"))
        continue;
      const root = join(directory, "node_modules", "dsh-mnemon");
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      const patch = pkg.dsh?.bundle?.patch;
      if (pkg.name !== "dsh-mnemon" || typeof patch !== "string") continue;
      const resolved = resolve(root, patch);
      if (
        !resolved.startsWith(
          resolve(root) + (process.platform === "win32" ? "\\" : "/"),
        ) ||
        !file(resolved)
      )
        continue;
      return [resolved];
    } catch {
      /* A missing optional bundle must not hide a working DSH CLI. */
    }
  }
  return [];
}

/** Detect on the orchestrator host, without reading or copying credentials. */
export function discoverDsh(
  options: DshDiscoveryOptions = {},
): DshInstallation | null {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const dataHome =
    env.COMFYUI_MCP_DSH_HOME || env.DSH_HOME || join(home, ".dsh");
  const platform = options.platform ?? process.platform;
  const node = options.node ?? process.execPath;
  if (env.COMFYUI_MCP_DSH_BIN) {
    const result = launch(
      resolve(env.COMFYUI_MCP_DSH_BIN),
      dataHome,
      "configured",
      node,
    );
    if (!result)
      throw new Error(
        "Configured DSH CLI is missing or is an unsupported shell shim",
      );
    return result;
  }
  const names = platform === "win32" ? ["dsh.exe", "dsh.cmd", "dsh"] : ["dsh"];
  for (const dir of (env.PATH ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean)) {
    for (const name of names) {
      const found = launch(join(dir, name), dataHome, "path", node);
      if (found) return found;
    }
  }
  const standards = [
    join(
      dataHome,
      "profiles",
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js",
    ),
    join(
      home,
      ".local",
      "lib",
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js",
    ),
    join(
      env.APPDATA || join(home, "AppData", "Roaming"),
      "npm",
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js",
    ),
    "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
  ];
  for (const candidate of standards) {
    const found = launch(candidate, dataHome, "standard", node);
    if (found) return found;
  }
  try {
    const hint = JSON.parse(readFileSync(hintPath(env, home), "utf8"));
    if (
      Array.isArray(hint.args) &&
      hint.args.length === 1 &&
      typeof hint.args[0] === "string" &&
      isAbsolute(hint.args[0]) &&
      typeof hint.home === "string" &&
      isAbsolute(hint.home)
    ) {
      const real = realpathSync(hint.args[0]);
      const pkg = JSON.parse(
        readFileSync(join(dirname(real), "..", "package.json"), "utf8"),
      );
      if (pkg.name === "@deepseek-ai/dsh") {
        const found = launch(
          hint.args[0],
          env.COMFYUI_MCP_DSH_HOME || env.DSH_HOME || hint.home,
          "cached",
          file(hint.command) ? hint.command : node,
        );
        if (found) return found;
      }
    }
  } catch {
    /* Stale hints are ignored; normal discovery can find the new install. */
  }
  if (platform !== "linux") return null;
  // Portable installs need not be on PATH. An owned running official CLI gives
  // us its executable and DSH_HOME, not its credential values or configuration.
  const proc = options.procRoot ?? "/proc";
  let entries: string[];
  try {
    entries = readdirSync(proc);
  } catch {
    return null;
  }
  for (const pid of entries.filter((p) => /^\d+$/.test(p))) {
    try {
      const directory = join(proc, pid);
      if (
        options.procRoot === undefined &&
        statSync(directory).uid !== process.getuid?.()
      )
        continue;
      const args = readFileSync(join(directory, "cmdline"), "utf8").split("\0");
      const script = args.find(
        (arg) =>
          isAbsolute(arg) &&
          arg.replaceAll("\\", "/").endsWith("/@deepseek-ai/dsh/lib/bin.js"),
      );
      if (!script || !file(script)) continue;
      const pkg = JSON.parse(
        readFileSync(join(dirname(script), "..", "package.json"), "utf8"),
      );
      if (pkg.name !== "@deepseek-ai/dsh") continue;
      const configuredHome = readFileSync(join(directory, "environ"), "utf8")
        .split("\0")
        .find((value) => value.startsWith("DSH_HOME="))
        ?.slice(9);
      const actualHome =
        env.COMFYUI_MCP_DSH_HOME || env.DSH_HOME || configuredHome || dataHome;
      if (!isAbsolute(actualHome) || !existsSync(actualHome)) continue;
      return launch(
        script,
        actualHome,
        "running",
        file(args[0]) ? args[0] : node,
      );
    } catch {
      /* A process may exit or deny access during discovery. */
    }
  }
  return null;
}
