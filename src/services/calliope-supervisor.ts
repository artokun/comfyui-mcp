// Calliope bring-up from the orchestrator.
//
// The steps live in ONE script — BenjiDirector's `calliope-up.mjs`, vendored into the panel
// beside its bundle — so there is no second copy of the venv/pip/uvicorn dance here to drift.
// This module only finds that script inside the installed panel and runs it with the same
// Node the orchestrator runs on, then hands back the one JSON line it prints. Idempotency,
// the probe-first rule and the pidfile are the script's; refusing to run without a local
// panel install is ours.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectPanelInstall, type PanelDetection } from "./panel-installer.js";

export type CalliopeOp = "up" | "check" | "stop";

export interface CalliopeSupervisorResult {
  ok: boolean;
  op: CalliopeOp;
  /** The script's own JSON report, when it printed one. */
  result?: Record<string, unknown>;
  error?: string;
  script?: string;
  /** Last lines of the script's stderr — the progress log, or the reason it failed. */
  log?: string;
}

export interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CalliopeSupervisorDeps {
  detect: () => Promise<PanelDetection>;
  exists: (path: string) => boolean;
  run: (script: string, args: string[], timeoutMs: number) => Promise<RunOutcome>;
  env?: NodeJS.ProcessEnv;
}

/** How long each op may take: `up` includes a clone and a pip install on first run. */
export const CALLIOPE_OP_TIMEOUT_MS: Record<CalliopeOp, number> = { up: 10 * 60_000, check: 15_000, stop: 30_000 };

export const VENDORED_SCRIPT = join("web", "js", "vendor", "benjidirector", "calliope-up.mjs");

/** Run a script with the orchestrator's own Node, capturing both streams, killed on timeout. */
export function runNodeScript(script: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export const defaultCalliopeSupervisorDeps: CalliopeSupervisorDeps = {
  detect: () => detectPanelInstall(),
  exists: existsSync,
  run: (script, args, timeoutMs) => runNodeScript(script, args, timeoutMs),
};

/** The script's report is its LAST non-empty stdout line; everything before is progress. */
export function parseReport(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // not the report line
    }
  }
  return undefined;
}

const tail = (s: string, n = 12) => s.trim().split(/\r?\n/).slice(-n).join("\n");

export async function calliopeSupervise(op: CalliopeOp, deps: CalliopeSupervisorDeps = defaultCalliopeSupervisorDeps): Promise<CalliopeSupervisorResult> {
  const det = await deps.detect();
  if (!det.applicable) return { ok: false, op, error: "Calliope bring-up runs on the machine that has the panel installed; this orchestrator is not driving a local ComfyUI." };
  if (!det.installed || !det.dir) return { ok: false, op, error: "no local panel install was found under custom_nodes — install the panel first (install_comfyui action:'panel')." };
  const script = join(det.dir, VENDORED_SCRIPT);
  if (!deps.exists(script)) return { ok: false, op, script, error: `${script} is missing — this panel build does not carry BenjiDirector's bring-up; update the panel.` };
  const args = op === "up" ? [] : [`--${op}`];
  const out = await deps.run(script, args, CALLIOPE_OP_TIMEOUT_MS[op]);
  const result = parseReport(out.stdout);
  if (out.timedOut) return { ok: false, op, script, error: `calliope-up ${op} did not finish within ${CALLIOPE_OP_TIMEOUT_MS[op] / 1000}s`, log: tail(out.stderr), ...(result ? { result } : {}) };
  if (result) {
    const ok = op === "stop" ? result.stopped === true : result.reachable === true;
    return { ok, op, script, result, ...(ok ? {} : { error: typeof result.error === "string" ? result.error : `calliope-up ${op} reported failure` }), ...(out.stderr.trim() ? { log: tail(out.stderr) } : {}) };
  }
  return { ok: false, op, script, error: `calliope-up ${op} exited ${out.code ?? "by signal"} without a report`, log: tail(`${out.stderr}\n${out.stdout}`) };
}
