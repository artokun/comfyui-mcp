// Per-provider readiness, computed on the machine that actually RUNS the agents
// (this orchestrator = the user's laptop) — NOT on the ComfyUI host.
//
// The panel's ComfyUI-side Python (comfyui-mcp-panel/__init__.py) also probes
// readiness, but it runs wherever ComfyUI runs. In the "remote ComfyUI, local
// agent" model that's the POD, which has no provider CLIs and no logins, so it
// always reports "CLI not installed" even though the agent is happily running on
// the laptop. This module lets the orchestrator report the TRUTH over the bridge,
// which the panel then prefers (see comfyui-mcp-panel: applyReadiness on a
// {type:"backends"} bridge frame).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BackendReadiness = {
  backend: string;
  /** The provider's runtime is present (a CLI on PATH, or — for Claude — the SDK). */
  cli: boolean;
  /** A usable login exists. null = unknown (don't nag). */
  auth: boolean | null;
  /** cli && auth-not-false. */
  ready: boolean;
};

// CLI binary names per provider (Windows resolves .cmd/.exe via PATHEXT, but we
// probe the common variants explicitly to match the panel's Python).
const CLI_NAMES: Record<string, string[]> = {
  codex: ["codex", "codex.cmd", "codex.exe"],
  gemini: ["gemini", "gemini.cmd", "gemini.exe"],
};

/** True if any of `names` resolves on the local PATH. */
function onPath(names: string[]): boolean {
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = (process.env.PATH || "").split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      try {
        if (existsSync(join(dir, name))) return true;
      } catch {
        // unreadable PATH entry — skip
      }
    }
  }
  return false;
}

function fileExists(...parts: string[]): boolean {
  try {
    return existsSync(join(...parts));
  } catch {
    return false;
  }
}

/**
 * Readiness for one backend, evaluated locally.
 *
 * - claude: the orchestrator IS the Claude Agent SDK host — no separate CLI. If
 *   this process is running we can attempt Claude; a genuinely dead/unsigned
 *   Claude still surfaces via the connect ack's model probe (degraded). So we
 *   report it usable here rather than false-flagging "CLI not installed".
 * - codex/gemini: the CLI must be on PATH AND a login cached on disk.
 */
export function backendReadiness(backend: string, opts?: { home?: string }): BackendReadiness {
  const b = (backend || "").toLowerCase();
  const home = opts?.home ?? homedir();
  if (b === "claude") {
    return { backend: "claude", cli: true, auth: true, ready: true };
  }
  if (b === "codex") {
    const cli = onPath(CLI_NAMES.codex);
    const auth = fileExists(home, ".codex", "auth.json");
    return { backend: "codex", cli, auth, ready: cli && auth };
  }
  if (b === "gemini") {
    const cli = onPath(CLI_NAMES.gemini);
    // The gemini CLI caches its Google OAuth at <home>/.gemini/oauth_creds.json
    // (or GEMINI_CLI_HOME when set).
    const geminiHome = process.env.GEMINI_CLI_HOME || home;
    const auth = fileExists(geminiHome, ".gemini", "oauth_creds.json");
    return { backend: "gemini", cli, auth, ready: cli && auth };
  }
  return { backend: b, cli: false, auth: false, ready: false };
}

/** Readiness for every known backend, plus a rolled-up any_ready. */
export function allBackendReadiness(
  backends: Iterable<string>,
  opts?: { home?: string },
): {
  backends: BackendReadiness[];
  any_ready: boolean;
} {
  const list = [...backends].map((b) => backendReadiness(b, opts));
  return { backends: list, any_ready: list.some((r) => r.ready) };
}
