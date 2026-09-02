// Reclaim the panel bridge port — but only when the holder is ours (#2030).
//
// `tryReclaimBridgePort` used to treat any pid on 9180 as an orphaned
// comfyui-mcp session and offer to `taskkill /T /F` it. Logitech G HUB's
// `lghub_agent` sits on that port on most gaming/creator desktops; killing it
// takes down the user's mouse software and the updater respawns it, after which
// the straggler sweep killed whatever held the port next.
//
// Protocol probe first. No panel handshake → not ours → no prompt, no kill, no
// sweep. The classification lives in listener-ownership.ts so a definite
// `ours` / `not-ours` can only be minted from evidence.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import {
  classifyBridgeHolder,
  type BridgeHolderClassification,
  type ListenerOwnership,
} from "./listener-ownership.js";
import { probePanelOrchestrator } from "./panel-launcher.js";
import { DEFAULT_PANEL_BRIDGE_PORT, LEGACY_PANEL_BRIDGE_PORT } from "./bridge-ports.js";
import { detectInstallMode } from "./self-update.js";
import { logger } from "../utils/logger.js";
import type { UiBridge } from "./ui-bridge.js";
import { formatComfyUIUrl } from "../transport/comfyui-url.js";

const PORT_PROBE_TIMEOUT_MS = 5000;

export interface OrchestratorLock {
  pid?: unknown;
  startedAt?: unknown;
  version?: unknown;
  comfyuiUrl?: unknown;
}

export function orchLockPath(port: number): string {
  return join(tmpdir(), `comfyui-mcp-panel-orch-${port}.json`);
}

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function pidListeningOnPort(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        timeout: PORT_PROBE_TIMEOUT_MS,
      });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
      return null;
    }
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-s", "tcp:LISTEN"], {
      encoding: "utf8",
      timeout: PORT_PROBE_TIMEOUT_MS,
    });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function processNameOf(pid: number): string {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        timeout: PORT_PROBE_TIMEOUT_MS,
      });
      return /^"([^"]+)"/m.exec(out)?.[1] ?? "unknown";
    }
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
        encoding: "utf8",
        timeout: PORT_PROBE_TIMEOUT_MS,
      }).trim() || "unknown"
    );
  } catch {
    return "unknown";
  }
}

export function readOrchestratorLock(lockPath: string): OrchestratorLock | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as OrchestratorLock) : null;
  } catch {
    return null;
  }
}

export function killProcessTreeCrossPlatform(pid: number, mode: "term" | "kill"): void {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  const sig = mode === "term" ? "SIGTERM" : "SIGKILL";
  try {
    execFileSync("pkill", [`-${sig.replace("SIG", "")}`, "-P", String(pid)], { stdio: "ignore" });
  } catch {
    // no children / pkill absent — the direct signal below still applies
  }
  process.kill(pid, sig);
}

/** Copy-paste "free this port" commands — LAST RESORT, and ONLY when the holder is ours. */
export function portKillHint(port: number): string {
  const ps = `Get-NetTCPConnection -LocalPort ${port} -State Listen | % { taskkill /PID $_.OwningProcess /T /F }`;
  const sh = `lsof -ti tcp:${port} -s tcp:listen | xargs -r kill -9`;
  return process.platform === "win32"
    ? `To free the port manually:\n  PowerShell:  ${ps}\n  bash/zsh:    ${sh}`
    : `To free the port manually:\n  bash/zsh:    ${sh}\n  PowerShell:  ${ps}`;
}

/**
 * What to tell the user when the holder is NOT comfyui-mcp. Names the process,
 * says we will not kill it, and points at the override / new default.
 */
export function foreignBridgeHolderAdvice(port: number, processName: string): string {
  const name = processName || "unknown";
  return (
    `[panel-orchestrator] port ${port} is held by "${name}" (pid listening, but it does not ` +
    `speak the comfyui-mcp panel protocol) — that is not comfyui-mcp, so this process will not ` +
    `stop it. Logitech G HUB (lghub_agent) is a known occupant of ${LEGACY_PANEL_BRIDGE_PORT}. ` +
    `Leave that program running and set COMFYUI_MCP_BRIDGE_PORT to an unused port, or use the ` +
    `new default ${DEFAULT_PANEL_BRIDGE_PORT}.`
  );
}

export function startupDeadlineHolderAdvice(opts: {
  port: number;
  pid: number;
  ownership?: ListenerOwnership;
  processName?: string;
}): string {
  const { port, pid, ownership, processName } = opts;
  if (ownership === "not-ours") {
    const named = processName && processName !== "unknown" ? ` ("${processName}")` : "";
    return (
      ` Port ${port} is held by pid ${pid}${named}, which is not comfyui-mcp. Leave it running ` +
      `and set COMFYUI_MCP_BRIDGE_PORT, or use the default ${DEFAULT_PANEL_BRIDGE_PORT}.`
    );
  }
  if (ownership === "ours") {
    return ` Port ${port} is held by pid ${pid}; if that is an older comfyui-mcp, stop it and start this one again.`;
  }
  // Unconfirmed: name the situation, never instruct a kill. Logitech G HUB is
  // the known occupant of 9180; offering taskkill here is the bug this exists
  // to close.
  return (
    ` Port ${port} is held by pid ${pid}. It could not be confirmed as comfyui-mcp ` +
    `(Logitech G HUB's lghub_agent is a known occupant of ${LEGACY_PANEL_BRIDGE_PORT}). ` +
    `Leave it running and set COMFYUI_MCP_BRIDGE_PORT — the default bridge is now ` +
    `${DEFAULT_PANEL_BRIDGE_PORT}.`
  );
}

/**
 * Bind-failure text. `taskkill` / `kill -9` only when the holder is a definite
 * `ours`. Foreign and unconfirmed name the situation and point at the override;
 * they never offer to kill the process.
 */
export function bindFailureAdvice(
  port: number,
  assessment: { ownership: ListenerOwnership; processName: string },
): string {
  if (assessment.ownership === "ours") {
    return (
      `[panel-orchestrator] could not bind the panel bridge port — another comfyui-mcp owns it. ` +
      `Free that port and restart the orchestrator. Override the port with COMFYUI_MCP_BRIDGE_PORT.\n` +
      portKillHint(port)
    );
  }
  if (assessment.ownership === "not-ours") {
    return foreignBridgeHolderAdvice(port, assessment.processName);
  }
  return (
    `[panel-orchestrator] could not bind the panel bridge port — another process appears to own ` +
    `it, but it could not be confirmed as comfyui-mcp. Leave whatever is listening alone and set ` +
    `COMFYUI_MCP_BRIDGE_PORT (default ${DEFAULT_PANEL_BRIDGE_PORT}).`
  );
}

export async function probeComfyUi(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const target = formatComfyUIUrl(url);
    const res = await fetch(new URL("system_stats", target.endsWith("/") ? target : `${target}/`), {
      signal: ctl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export interface BridgeHolderAssessment extends BridgeHolderClassification {
  pid: number | null;
  portPid: number | null;
  lockPid: number | null;
  processName: string;
  lock: OrchestratorLock | null;
  speaksPanelProtocol: boolean;
}

export interface AssessBridgeHolderDeps {
  probe: (port: number) => Promise<boolean>;
  pidListeningOnPort: (port: number) => number | null;
  processNameOf: (pid: number) => string;
  readLock: (path: string) => OrchestratorLock | null;
  pidExists: (pid: number) => boolean;
}

const defaultAssessDeps: AssessBridgeHolderDeps = {
  probe: (port) => probePanelOrchestrator(port),
  pidListeningOnPort,
  processNameOf,
  readLock: readOrchestratorLock,
  pidExists,
};

/**
 * Classify whoever is listening on `port`. Always probes the panel protocol;
 * the lockfile is corroboration, never a license to kill a foreign holder.
 */
export async function assessBridgeHolder(
  port: number,
  lockPath: string,
  deps: Partial<AssessBridgeHolderDeps> = {},
): Promise<BridgeHolderAssessment> {
  const d = { ...defaultAssessDeps, ...deps };
  const lock = d.readLock(lockPath);
  const lockPidRaw =
    typeof lock?.pid === "number" && Number.isInteger(lock.pid) && lock.pid > 0 ? lock.pid : null;
  const lockPid = lockPidRaw && d.pidExists(lockPidRaw) ? lockPidRaw : null;
  const portPid = d.pidListeningOnPort(port);
  const pid = lockPid ?? portPid;
  const processName = portPid ? d.processNameOf(portPid) : pid ? d.processNameOf(pid) : "unknown";
  const speaksPanelProtocol = await d.probe(port);
  const lockfileOursOrStale = lockPid == null || lockPid === portPid || (portPid == null && !d.pidExists(lockPid));
  // Protocol is the kill gate. A failed pid lookup (netstat/lsof timeout, no
  // lsof) must not throw away a failed probe: bind already lost, so something
  // holds the port, and a silent/foreign TCP is not-ours even when we cannot
  // name the pid. Restoring an `if (!pid) unclassified` early return reopens
  // the G HUB taskkill one-liner (#2030).
  const classified = classifyBridgeHolder({ speaksPanelProtocol, lockfileOursOrStale });
  return {
    ...classified,
    pid,
    portPid,
    lockPid,
    processName,
    lock,
    speaksPanelProtocol,
  };
}

export interface ReclaimDeps extends AssessBridgeHolderDeps {
  isTty: () => boolean;
  promptYesNo: (question: string) => Promise<boolean>;
  killProcessTree: (pid: number, mode: "term" | "kill") => void;
  probeComfyUi: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: { warn: (m: string) => void; info: (m: string) => void };
  currentVersion: () => string;
}

export interface ReclaimResult {
  bound: boolean;
  ownership: ListenerOwnership;
  processName: string;
  prompted: boolean;
  killed: number[];
}

const defaultReclaimDeps: Omit<ReclaimDeps, keyof AssessBridgeHolderDeps> & AssessBridgeHolderDeps = {
  ...defaultAssessDeps,
  isTty: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  promptYesNo,
  killProcessTree: killProcessTreeCrossPlatform,
  probeComfyUi,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  log: logger,
  currentVersion: () => detectInstallMode().currentVersion ?? "unknown",
};

/**
 * If the bridge port is held by a previous comfyui-mcp, offer (on a TTY) to
 * stop it and retry the bind. If the holder does not speak the panel protocol:
 * log that it is not ours and return without prompting or killing.
 */
export async function tryReclaimBridgePort(
  bridge: Pick<UiBridge, "start" | "whenReady">,
  port: number,
  lockPath: string,
  deps: Partial<ReclaimDeps> = {},
): Promise<ReclaimResult> {
  const d = { ...defaultReclaimDeps, ...deps };
  const assessment = await assessBridgeHolder(port, lockPath, d);
  const empty: ReclaimResult = {
    bound: false,
    ownership: assessment.ownership,
    processName: assessment.processName,
    prompted: false,
    killed: [],
  };
  if (!assessment.reclaimable || assessment.ownership === "not-ours") {
    d.log.warn(foreignBridgeHolderAdvice(port, assessment.processName));
    return empty;
  }

  if (!assessment.pid) return empty;

  if (!d.isTty()) return empty;

  const pid = assessment.pid;
  const lock = assessment.lock;
  const myUrl = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
  let holderNote: string;
  let detailNote = "";
  if (assessment.lockPid) {
    const myVersion = d.currentVersion();
    const heldVersion = typeof lock?.version === "string" ? lock.version : "unknown";
    const startedAt = typeof lock?.startedAt === "string" ? lock.startedAt : null;
    holderNote =
      heldVersion !== "unknown" && myVersion !== "unknown" && heldVersion !== myVersion
        ? `an older comfyui-mcp v${heldVersion} (this is v${myVersion})`
        : `another comfyui-mcp v${heldVersion} session`;
    const heldUrl = typeof lock?.comfyuiUrl === "string" ? lock.comfyuiUrl : null;
    if (startedAt) detailNote += `, started ${startedAt}`;
    if (heldUrl) {
      const alive = await d.probeComfyUi(heldUrl);
      detailNote += `, driving ${heldUrl}${alive ? "" : " (NOT RESPONDING — likely a terminated pod / stale session)"}`;
    }
  } else {
    holderNote = `another comfyui-mcp session ("${assessment.processName}")`;
  }
  d.log.warn(
    `[panel-orchestrator] port ${port} is already held by ${holderNote} — pid ${pid}${detailNote}.`,
  );
  const ok = await d.promptYesNo(
    `Stop it (and its whole process tree) and take over port ${port} for ${myUrl}? [y/N] `,
  );
  if (!ok) {
    d.log.info(`[panel-orchestrator] leaving pid ${pid} alone.\n${portKillHint(port)}`);
    return { ...empty, prompted: true };
  }

  const targets = [
    ...new Set([assessment.lockPid, assessment.portPid].filter((p): p is number => p != null)),
  ];
  d.log.info(
    `[panel-orchestrator] stopping pid${targets.length > 1 ? "s" : ""} ${targets.join(", ")} (and their process trees) to reclaim port ${port}…`,
  );
  const killed: number[] = [];
  for (const t of targets) {
    try {
      d.killProcessTree(t, "term");
      killed.push(t);
    } catch (err) {
      d.log.warn(
        `[panel-orchestrator] couldn't stop pid ${t}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const deadline = d.now() + 5000;
  while (d.now() < deadline && targets.some((t) => d.pidExists(t))) {
    await d.sleep(200);
  }
  for (const t of targets) {
    if (!d.pidExists(t)) continue;
    try {
      d.killProcessTree(t, "kill");
    } catch {
      // already gone
    }
  }
  // Straggler sweep: only a process we can still prove is ours. A foreign
  // respawn (G HUB's updater) must not be killed just because it grabbed the
  // port we freed.
  const straggler = d.pidListeningOnPort(port);
  if (straggler && !targets.includes(straggler)) {
    const stillOurs = await d.probe(port);
    if (stillOurs) {
      d.log.warn(`[panel-orchestrator] a new pid ${straggler} grabbed port ${port} — stopping it too.`);
      try {
        d.killProcessTree(straggler, "kill");
        killed.push(straggler);
      } catch {
        // best-effort
      }
    } else {
      d.log.warn(
        foreignBridgeHolderAdvice(port, d.processNameOf(straggler)),
      );
    }
  }
  await d.sleep(300);
  bridge.start();
  const bound = await bridge.whenReady();
  return {
    bound,
    ownership: assessment.ownership,
    processName: assessment.processName,
    prompted: true,
    killed,
  };
}
