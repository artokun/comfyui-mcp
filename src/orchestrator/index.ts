// Panel orchestrator — a standalone, long-lived process that drives the ComfyUI
// sidebar panel with autonomous BACKGROUND agents, so the user's interactive
// Claude session stays free. Launch with `comfyui-mcp --panel-orchestrator`
// (or COMFYUI_MCP_PANEL_ORCHESTRATOR=1).
//
// It owns the UI bridge (port 9180) directly — so it SEES panel messages instead
// of relying on an idle interactive session to notice a channel push — and spawns
// one Claude Agent SDK streaming session per panel tab (src/orchestrator/
// panel-agent.ts). Each agent runs on the user's Claude SUBSCRIPTION with no API
// key. See docs/design/panel-orchestrator.md.

import { existsSync, writeFileSync, unlinkSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startUiBridge } from "../services/ui-bridge.js";
import { logger } from "../utils/logger.js";
import {
  PanelAgentManager,
  fetchSupportedModels,
  fetchSupportedCommands,
  isEffort,
  type Effort,
  type ModelInfo,
  type SlashCommand,
  type UsageStatus,
} from "./panel-agent.js";
import { createPanelMcpServer } from "./panel-tools.js";
import { readUserMcpServers } from "../services/user-mcp-config.js";
import { CodexBackend } from "./codex-backend.js";
import type { AgentBackend } from "./agent-backend.js";

const PANEL_SYSTEM_APPEND = `You are the autonomous assistant embedded directly in a ComfyUI sidebar panel. The person is working in ComfyUI and talks to you through that panel: their messages arrive as your prompts, and everything you write is shown to them in the panel chat. Write for that reader — lead with the result, keep replies short and concrete, and don't narrate routine internal steps.

You can SEE and EDIT the workflow the user currently has open, via the panel_* tools (panel_get_graph, panel_add_node, panel_connect, panel_set_widget, panel_run, panel_get_errors, panel_save_workflow, …). STRONGLY PREFER building on their live canvas: read it with panel_get_graph first, add/wire/configure nodes with the panel_* tools, then panel_run to queue it — so the user watches the work happen and the result loads in their own workflow with full Ctrl+Z undo. Only fall back to the headless generate_image/enqueue_workflow tools when the user explicitly wants a one-off they don't need on their canvas, or when no panel tab is connected (a panel_* call will error if so).

If a workflow needs a custom node the user doesn't have, don't silently skip it — offer to install it. Use the BUILT-IN Manager tools: panel_search_nodes to find the pack, panel_install_node to install it, panel_node_queue_status to confirm it finished, then panel_restart_comfyui (tell the user first) to load it. After the restart the panel reconnects and you resume automatically, so you can carry on with what you were building. Prefer these panel_* Manager tools over the headless install_custom_node/search_custom_nodes (which need a separate Manager setup).

CRITICAL — never destroy the user's work. When they ask for a "new workflow", a "fresh canvas", or to "start over for a new project", call panel_new_workflow (it opens a NEW TAB and leaves their current workflow intact). NEVER use panel_clear for that — panel_clear wipes the CURRENTLY OPEN graph and is ONLY for an explicit "clear/reset this canvas". You can manage tabs with panel_list_workflows / panel_open_workflow / panel_rename_workflow / panel_close_workflow, and group nodes with panel_select_nodes / panel_create_subgraph. To label a node by its purpose, use panel_set_node_title. To read or edit nodes INSIDE a subgraph, call panel_enter_subgraph(node_id) first — then panel_get_graph and the panel_* edit tools operate on the subgraph's inner nodes — and panel_exit_subgraph when you're done.

You also have the comfyui MCP tools to generate images, video, and audio and to inspect, download models for, and manage their ComfyUI instance. Use them to actually do what's asked, then tell them what you did and name or link any output. If a request is ambiguous, make a sensible choice and say what you chose rather than stalling.

You are running in the background on the user's own machine. For routine, reversible actions that follow from the request, act without asking permission.

You can extend your own capabilities by connecting MCP servers: panel_list_mcp shows what's connected, panel_add_mcp writes a new server to the user's Claude config, and panel_remove_mcp removes one — then call panel_reload to load the change into this session (it restarts you and resumes automatically). For example, if a task needs Civitai model search and it isn't connected, offer to add the official CivitAI MCP (transport 'http', url 'https://mcp.civitai.com/mcp'), then reload. ALWAYS ask the user before connecting a remote MCP — it's an external service connection. After editing your own orchestrator/panel code, you can also call panel_reload to pick it up without a ComfyUI restart.

When you genuinely need the user to choose between options, use the panel_ask tool — it renders an interactive question card in the panel chat and returns their pick (the card always includes an 'Other…' free-text field, so they can answer freely too). Reserve it for decisions that actually change what you do; for a simple yes/no or quick confirmation a plain-text question in your reply is fine. Do NOT use the built-in AskUserQuestion tool — it does not render in this panel and gets auto-dismissed, which makes you think the user declined.

For any genuinely multi-step task, set a plan with panel_set_todo and then WORK THROUGH IT LIKE A LOOP: do each step, mark it done and the next one active as you go, and keep going autonomously all the way to the end. Do NOT stop between steps to ask "should I continue?", to report routine progress, or to seek permission for steps that plainly follow from the plan — the todo list is your commitment to FINISH, not a menu to re-confirm. Clear it (panel_set_todo with an empty array) once every item is done. The ONLY reason to pause the loop is a decision you genuinely cannot make yourself or a true blocker — then use panel_ask to get the answer and immediately resume the loop. When the user hands you a list of things to do, default to executing the WHOLE list before yielding the turn.

Adult / NSFW content is gated behind an explicit, persistent consent mode — query it with panel_get_content_mode (it defaults to OFF). ComfyUI has a large community of legitimate adult artists, so adult requests are valid creative work — but only for verified consenting adults. BY DEFAULT (mode OFF) keep everything safe-for-work: don't surface NSFW models, LoRAs, prompts, workflows, or imagery, and prefer SFW results. When a request clearly intends adult/NSFW work and the mode is OFF, call panel_request_adult_consent — it shows a card confirming the user is 18+ and that adult content is legal in their region; only once they affirm does the mode turn on (it persists across reloads, and panel_disable_adult_mode reverts it). When the mode is ON, help with legal adult art for consenting adults and don't over-refuse — stylized/fantasy themes between clearly-adult fictional characters are in scope. ABSOLUTE limits that NO mode, setting, or request ever relaxes: never sexual content involving minors or anyone depicted as underage; never sexual deepfakes of real, identifiable people; never depictions of actual non-consensual sexual acts (rape). If a request crosses these, refuse regardless of the mode.`;

/**
 * Lockfile path for a given bridge port. The orchestrator self-registers its
 * REAL node pid here (not the npx shim's), plus the ComfyUI pid that launched
 * it, so the panel pack can reliably identify and replace a stale orchestrator
 * left over from a previous ComfyUI session (the "orphan on the port" trap).
 */
function orchLockPath(port: number): string {
  return join(tmpdir(), `comfyui-mcp-panel-orch-${port}.json`);
}

function readWindowsProcessStartedAtMs(pid: number): number | null {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
    `if ($p) { ([Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate)).ToUniversalTime().ToString("o") }`;
  for (const exe of ["powershell.exe", "powershell"]) {
    try {
      const out = execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      }).trim();
      if (!out) return null;
      const ms = Date.parse(out);
      return Number.isFinite(ms) ? ms : null;
    } catch {
      // Try the next PowerShell executable name.
    }
  }
  return null;
}

function readProcessStartedAtMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return readWindowsProcessStartedAtMs(pid);
  return null;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence probe, doesn't actually signal
    return true;
  } catch (err) {
    // EPERM = exists but not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parentIdentityMatches(pid: number, expectedStartedAtMs: number | null): boolean {
  if (!pidExists(pid)) return false;
  if (!expectedStartedAtMs) return true; // legacy/manual launch: PID liveness only.
  const actualStartedAtMs = readProcessStartedAtMs(pid);
  // Couldn't read the start time (transient PowerShell failure / no reader): the
  // pid IS alive, so DON'T false-positive "parent gone" and suicide — fall back
  // to liveness. The pack's Connect-time orphan check is the backstop for reuse.
  if (!actualStartedAtMs) return true;
  return Math.abs(actualStartedAtMs - expectedStartedAtMs) <= 2000;
}

/**
 * Tie the orchestrator's lifetime to ComfyUI's. The launcher (the panel pack)
 * passes its own PID as COMFYUI_MCP_PARENT_PID; we poll whether that process is
 * still alive and shut down when it's gone. Unlike an atexit/signal handler on
 * the parent, this also covers a ComfyUI crash or hard kill — the child notices
 * the parent disappeared and exits on its own. No-op when no parent PID is set
 * (e.g. when run manually from a terminal).
 */
function startParentWatchdog(onParentGone: () => void): void {
  const raw = process.env.COMFYUI_MCP_PARENT_PID;
  const ppid = raw ? Number(raw) : NaN;
  if (!Number.isInteger(ppid) || ppid <= 0) return;
  const expectedStartedAtMs = Number(process.env.COMFYUI_MCP_PARENT_STARTED_AT_MS) || null;
  // Cheap pid-liveness probe every 5s; the expensive start-time identity check
  // (which shells out to PowerShell on Windows) only every ~30s — enough to
  // catch pid reuse without spawning a process every 5s for the orchestrator's
  // whole life.
  let polls = 0;
  const timer = setInterval(() => {
    polls += 1;
    if (!pidExists(ppid)) {
      clearInterval(timer);
      onParentGone();
      return;
    }
    if (expectedStartedAtMs && polls % 6 === 0 && !parentIdentityMatches(ppid, expectedStartedAtMs)) {
      clearInterval(timer);
      onParentGone();
    }
  }, 5000);
  // Don't let the watchdog alone keep the process alive — the bridge does that.
  timer.unref?.();
  logger.info(`[panel-orchestrator] watching parent process ${ppid}; will shut down when it exits`);
}

/**
 * Run the panel orchestrator. Never resolves — the bridge and agents keep the
 * process alive until SIGINT/SIGTERM or the parent (ComfyUI) exits.
 */
export async function runPanelOrchestrator(): Promise<void> {
  // Crash guard: the orchestrator is a long-lived background process the user
  // can't see. A stray rejection (e.g. a fire-and-forget push to a tab that
  // vanished mid-flight, or an SDK hiccup) must never silently kill it —
  // otherwise the panel goes dead with no explanation. Log and keep running.
  process.on("unhandledRejection", (reason) => {
    // Benign strays are common here (a fire-and-forget push to a tab that vanished
    // mid-flight, an SDK hiccup) and must NOT kill the orchestrator — log + continue.
    logger.error(
      `[panel-orchestrator] unhandled rejection (ignored): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
    );
  });
  process.on("uncaughtException", (err) => {
    // A synchronous uncaught throw leaves the process in an UNDEFINED state. The
    // old "log + continue" here was a zombie root cause — the orchestrator stayed
    // alive but broken, so the panel couldn't reconnect and a ComfyUI restart just
    // reattached to it. Exit so the pack respawns a clean orchestrator (Node's own
    // default is to crash on uncaughtException anyway).
    logger.error(
      `[panel-orchestrator] FATAL uncaught exception — exiting so a fresh orchestrator can take over: ${err.stack ?? err.message}`,
    );
    process.exit(1);
  });

  // Subscription lane: the background agent must authenticate against the user's
  // claude.ai login, never an API key. Unset the key for the SDK subprocess.
  delete process.env.ANTHROPIC_API_KEY;

  // Dedicated PANEL bridge port (default 9180).
  const bridge = startUiBridge(Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180);

  // Owning the bridge port is the orchestrator's whole job — if another process
  // holds it, fail loudly instead of running uselessly. (This also avoids the
  // case where a failed bind leaves the process with no live handles and it
  // exits silently.)
  const bound = await bridge.whenReady();
  if (!bound) {
    logger.error(
      `[panel-orchestrator] could not bind the panel bridge port — another process owns it. Free that port and restart the orchestrator. Override the port with COMFYUI_MCP_BRIDGE_PORT.`,
    );
    process.exit(1);
  }

  // We own the port — register our REAL pid + the launching ComfyUI pid so the
  // panel pack can detect and replace us if we're ever orphaned across a Comfy
  // restart. Written only after a successful bind (so the file always names the
  // process that actually holds the port).
  const lockPort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180;
  const lockPath = orchLockPath(lockPort);
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        // Our OWN process creation time, captured now while we KNOW this pid is
        // the real orchestrator. The pack matches a live pid's creation time
        // against this before ever killing it, so a reused pid (a shell, node,
        // anything that inherits our old pid) can't be mistaken for us and
        // terminated — the TOCTOU pid-reuse guard. Null on platforms we can't
        // read it (the pack then falls back to the cmdline identity check).
        pidStartedAt: readProcessStartedAtMs(process.pid),
        parent: Number(process.env.COMFYUI_MCP_PARENT_PID) || null,
        parentStartedAt: Number(process.env.COMFYUI_MCP_PARENT_STARTED_AT_MS) || null,
        port: lockPort,
        // The selected agent backend ("claude" default | "codex"). Lets the panel
        // pack's /backends route report which provider each running orchestrator is
        // without opening the bridge. Mirrors PANEL_AGENT_BACKEND.
        backend: (process.env.PANEL_AGENT_BACKEND ?? "claude").toLowerCase(),
        startedAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.debug(`[panel-orchestrator] could not write lockfile ${lockPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The spawned agent runs THIS comfyui-mcp build as its MCP server in normal
  // mode — so it generates against the live ComfyUI over COMFYUI_URL and never
  // tries to bind the bridge port we own here.
  const mcpEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const comfyuiUrl = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
  // ComfyUI install path — when set, the spawned agent's MCP runs in LOCAL mode,
  // so download_model / apply_manifest / installer-pack / model-scan tools work
  // instead of degrading to remote-only. The panel pack supplies this.
  const comfyuiPath = process.env.COMFYUI_PATH;
  const model = process.env.COMFYUI_MCP_PANEL_MODEL ?? "claude-opus-4-8";
  const envEffort = process.env.COMFYUI_MCP_PANEL_EFFORT;
  const effort: Effort | undefined = isEffort(envEffort) ? envEffort : undefined;
  const bridgePort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180;

  // Cross-process download-progress channel: each tab's comfyui MCP subprocess
  // writes per-download JSON here; the watcher below broadcasts it to the panel
  // tray. Port-scoped so parallel orchestrators don't cross streams.
  const progressDir = join(tmpdir(), `comfyui-mcp-progress-${bridgePort}`);

  // The bundled plugin (skills) ships alongside dist/ in the package root. Load
  // it so the background agents are ComfyUI experts out of the box.
  const pluginPath = fileURLToPath(new URL("../../plugin", import.meta.url));
  const pluginAvailable = existsSync(pluginPath);
  if (!pluginAvailable) {
    logger.warn(
      `[panel-orchestrator] bundled plugin not found at ${pluginPath} — agents run without model-expertise skills.`,
    );
  }

  // Build an agent_status frame from a usage snapshot — used both live (per
  // assistant response) and to re-push the last value when a tab reconnects.
  function pushStatus(tabId: string, status: UsageStatus): void {
    bridge.push(
      {
        type: "agent_status",
        ...(typeof status.contextPct === "number" ? { context_pct: status.contextPct } : {}),
        ...(typeof status.used === "number" ? { used: status.used } : {}),
        ...(typeof status.contextWindow === "number" ? { context_window: status.contextWindow } : {}),
        ...(status.model ? { model: status.model } : {}),
        ...(typeof status.costUsd === "number" ? { cost_usd: status.costUsd } : {}),
      },
      tabId,
    );
  }

  // Inherit the user's own MCP servers (the same ones their normal `claude`
  // session uses), read from ~/.claude.json. Conflicting comfyui entries are
  // filtered out by the reader so they can't grab our bridge port. This is what
  // makes "add the CivitAI MCP" work: panel_add_mcp writes it here, a reload
  // re-reads it, and the agent gains those tools. Re-read on every (re)start so
  // new servers are picked up on the next soft reload.
  const userMcpServers = readUserMcpServers();
  const userMcpNames = Object.keys(userMcpServers);
  if (userMcpNames.length) {
    logger.info(`[panel-orchestrator] inheriting user MCP servers: ${userMcpNames.join(", ")}`);
  }

  // ---- agent backend toggle ----
  // Select the provider backend from PANEL_AGENT_BACKEND ("claude" default |
  // "codex"). Claude stays the default so existing behavior is 100% unchanged
  // when the env is unset. When "codex" is selected we inject a per-tab
  // CodexBackend (codex app-server JSON-RPC); otherwise makeBackend is omitted
  // and PanelAgent falls back to its built-in ClaudeBackend.
  //
  // KNOWN GAP (Phase 2d): the Codex backend currently runs WITHOUT the live-graph
  // panel_* tools — the app-server can't host the in-process SDK MCP server, so
  // the shared "panel tools as a real MCP server" refactor is required first.
  const backendId = (process.env.PANEL_AGENT_BACKEND ?? "claude").toLowerCase();
  // The panel's `model` is a Claude id (e.g. claude-opus-4-8) and is NOT a valid
  // Codex model — so for codex we only pass a model when COMFYUI_MCP_CODEX_MODEL
  // is set explicitly; otherwise Codex uses the account's default (e.g. gpt-5.5).
  const codexModel = process.env.COMFYUI_MCP_CODEX_MODEL;
  const isCodex = backendId === "codex";
  const makeBackend: ((tabId: string) => AgentBackend) | undefined = isCodex
    ? () => new CodexBackend({ cwd: comfyuiPath ?? process.cwd(), model: codexModel })
    : undefined;
  if (isCodex) {
    logger.info(`[panel-orchestrator] agent backend = codex (codex app-server); panel_* live-graph tools deferred (Phase 2d)`);
  } else if (backendId !== "claude") {
    logger.warn(`[panel-orchestrator] unknown PANEL_AGENT_BACKEND "${backendId}" — defaulting to claude`);
  }
  // Readiness/model probing must route through the SELECTED backend (P1-2): in
  // Codex mode the panel's "ready" must NOT depend on Claude SDK/login health.
  // A dedicated probe backend (not tied to a tab) supplies the Codex model list
  // and proves the app-server can start; Claude mode keeps its SDK probes.
  const probeBackend: CodexBackend | null = isCodex
    ? new CodexBackend({ cwd: comfyuiPath ?? process.cwd(), model: codexModel })
    : null;

  const manager = new PanelAgentManager({
    model,
    effort,
    makeBackend,
    comfyuiUrl, // for fetching image bytes to inline into agent turns
    systemAppend: PANEL_SYSTEM_APPEND,
    pluginPath: pluginAvailable ? pluginPath : undefined,
    // Live-graph control of the user's open workflow, per tab (in-process).
    makePanelServer: (tabId) => createPanelMcpServer(bridge, tabId),
    mcpServers: {
      // The user's inherited servers first…
      ...userMcpServers,
      // …then our own comfyui server LAST, so it always wins over any user
      // entry that slipped through (defensive — the reader already filters them).
      comfyui: {
        type: "stdio",
        command: process.execPath, // node
        args: [mcpEntry], // dist/index.js
        env: {
          COMFYUI_URL: comfyuiUrl,
          // Where download_model writes live progress for the panel tray.
          COMFYUI_MCP_PROGRESS_DIR: progressDir,
          // Local mode → enables download_model, apply_manifest (installer packs),
          // and model scans so the agent installs the right way instead of curl.
          ...(comfyuiPath ? { COMFYUI_PATH: comfyuiPath } : {}),
        },
      },
    },
    onSay: (tabId, text, meta) => {
      // `id` lets the panel reconcile this committed message with its live
      // streaming preview (same id) instead of rendering a duplicate bubble.
      bridge.push({ type: "say", text, id: meta?.id, streamed: meta?.streamed }, tabId);
    },
    // Live streaming deltas → the panel's think-window + streaming reply bubble.
    onStream: (tabId, ev) => {
      bridge.push({ type: "stream", phase: ev.phase, id: ev.id, delta: ev.delta }, tabId);
    },
    // Per-response usage → the panel's context/usage meter (updates live).
    onStatus: pushStatus,
    // Report the SDK session id so the panel can persist it and resume on reload.
    onSession: (tabId, sessionId) => {
      bridge.push({ type: "session", session_id: sessionId }, tabId);
    },
    // Per-turn rewind anchor (assistant UUID) → the panel stores it so a later
    // "rewind conversation to here" can fork the session at that point.
    onTurnAnchor: (tabId, uuid) => {
      bridge.push({ type: "turn_anchor", uuid }, tabId);
    },
    // Turn lifecycle → the panel's "working" indicator (stays up through silent
    // tool work; clears on done).
    onTurn: (tabId, state) => {
      bridge.push({ type: "turn", state }, tabId);
    },
    // Live extended-thinking token count → "thinking… (N)" indicator.
    onThinking: (tabId, tokens) => {
      bridge.push({ type: "thinking", tokens }, tabId);
    },
    // The agent dequeued a message (the true "read" moment) → flip that bubble
    // from queued/muted to read.
    onSeen: (tabId, mid) => {
      bridge.push({ type: "ack", ok: true, kind: "seen", mid }, tabId);
    },
  });

  // Debounce the connect ack: the panel re-sends `hello` on reconnect and on
  // workflow-title changes, which would otherwise stack duplicate greetings.
  const lastAckAt = new Map<string, number>();
  const ACK_DEBOUNCE_MS = 4000;

  // The account's real model list — probed once from the SDK (the only way that
  // works on the subscription lane) and cached. Pushed to each tab so the
  // panel's model/effort picker reflects what's actually available, with each
  // model's supported effort levels, instead of a hardcoded list.
  let modelsPromise: Promise<ModelInfo[]> | null = null;
  function ensureModels(): Promise<ModelInfo[]> {
    if (!modelsPromise) {
      // Codex mode (P1-2): enumerate via the Codex backend (which also proves the
      // app-server can start = readiness) — NEVER the Claude SDK probe. Shape the
      // Codex ModelChoice[] into the panel's ModelInfo[] form (value/displayName).
      const probe: Promise<ModelInfo[]> = probeBackend
        ? probeBackend
            .prepare()
            .then(() => probeBackend.listModels())
            .then((list) =>
              list.map((m) => ({ value: m.id, displayName: m.label ?? m.id }) as unknown as ModelInfo),
            )
            .catch((err) => {
              logger.warn(`[panel-orchestrator] codex model probe failed: ${err instanceof Error ? err.message : String(err)}`);
              return [] as ModelInfo[];
            })
        : fetchSupportedModels(model);
      modelsPromise = probe.then((list) => {
        // Don't cache an empty/failed probe forever — let the next hello retry.
        if (!list.length) modelsPromise = null;
        return list;
      });
    }
    return modelsPromise;
  }
  function pushModels(tabId: string): void {
    void ensureModels()
      .then((models) => {
        if (models.length) {
          // `backend` rides on the models frame so the panel's backend picker can
          // reflect which provider this orchestrator is actually running as.
          bridge.push({ type: "models", models, current: model, backend: backendId }, tabId);
        }
      })
      .catch(() => {
        /* probe already logged; panel keeps its fallback list */
      });
  }

  // The SDK's slash commands (built-ins like /compact, plus any loaded skills) —
  // probed once and surfaced in the panel composer's completion menu.
  let commandsPromise: Promise<SlashCommand[]> | null = null;
  function ensureCommands(): Promise<SlashCommand[]> {
    if (!commandsPromise) {
      commandsPromise = fetchSupportedCommands(model).then((list) => {
        if (!list.length) commandsPromise = null; // let the next hello retry
        return list;
      });
    }
    return commandsPromise;
  }
  // The SDK reports EVERY command the user's Claude install exposes — including
  // all their unrelated skills/plugins (Cloudflare, codex:*, etc.). Surface only
  // the built-ins that make sense inside the ComfyUI panel chat.
  const PANEL_SLASH_ALLOWLIST = new Set(["compact", "context", "usage", "loop", "goal", "clear"]);
  function pushCommands(tabId: string): void {
    // Codex mode (P1-2): no Claude slash-commands — skip the Claude SDK probe
    // entirely (CODEX_CAPABILITIES.slashCommands === false).
    if (isCodex) return;
    void ensureCommands()
      .then((commands) => {
        const useful = commands.filter((c) => PANEL_SLASH_ALLOWLIST.has(c.name));
        if (useful.length) bridge.push({ type: "commands", commands: useful }, tabId);
      })
      .catch(() => {
        /* probe already logged; panel just won't show SDK commands */
      });
  }

  bridge.onPanelMessage = (event) => {
    // Connect ack: the instant a panel tab connects, the orchestrator announces
    // itself so "connected" means "a real agent is attending" — not merely "a
    // socket is open." A bare/undriven bridge stays silent, so the panel can
    // tell the difference (and warn if no ack arrives).
    if (event.type === "hello" && event.tab_id) {
      // Reload restore: the panel re-sends the last session id it saw so the
      // agent's memory continues. Only honored before the tab's agent spawns.
      const resume = typeof event.resume === "string" ? event.resume : undefined;
      if (resume) manager.setResume(event.tab_id, resume);
      // Send the live model list so the picker reflects the real subscription,
      // and the SDK's slash commands so the composer can surface them.
      pushModels(event.tab_id);
      pushCommands(event.tab_id);
      // Re-push the last usage so the context meter isn't blank after a reload.
      const lastStatus = manager.lastStatusFor(event.tab_id);
      if (lastStatus) pushStatus(event.tab_id, lastStatus);
      const tabId = event.tab_id;
      const now = Date.now();
      if (now - (lastAckAt.get(tabId) ?? 0) < ACK_DEBOUNCE_MS) return;
      lastAckAt.set(tabId, now);
      // TRUTHFUL "connected": only claim ready after PROVING the SDK can run, by
      // probing the model list (same machinery the agent uses to spawn). If the
      // probe fails — the "connected but dead" wedge — say so and send a degraded
      // ack instead of a green ready, so the panel can show the real state.
      void ensureModels()
        .then((models) => {
          if (models.length) {
            // Greet only on a FRESH session. On a reconnect/resume — a panel swap,
            // a WS blip, or a real restart (all carry `resume`) — the user already
            // has their thread, so re-greeting is just noise. The ack still fires.
            // Backend-appropriate messaging (P1-2): Codex mode must not claim a
            // Claude subscription, and the agent label is the Codex model (or the
            // account default when COMFYUI_MCP_CODEX_MODEL is unset).
            const agentLabel = isCodex ? (codexModel ?? (models[0] as { value?: string }).value ?? "Codex") : model;
            if (!resume) {
              const readyText = isCodex
                ? `🟢 comfyui-mcp agent ready — ${agentLabel} on your Codex (ChatGPT) account. Ask away.`
                : `🟢 comfyui-mcp agent ready — ${agentLabel} on your Claude subscription. Ask away.`;
              bridge.push({ type: "say", text: readyText }, tabId);
            }
            bridge.push({ type: "ack", ok: true, kind: "ready", agent: agentLabel, backend: backendId }, tabId);
            logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} connected — agent healthy, sent ready ack`);
          } else {
            const degradedText = isCodex
              ? "⚠️ The background agent isn't responding — the Codex app-server couldn't start. Make sure Codex is installed and signed in (run `codex login`), then Disconnect → Connect to retry."
              : "⚠️ The background agent isn't responding — the Claude Agent SDK couldn't start. Make sure you're signed in (run `claude` once), then Disconnect → Connect to retry.";
            bridge.push({ type: "say", text: degradedText }, tabId);
            bridge.push({ type: "ack", ok: false, kind: "degraded" }, tabId);
            logger.warn(`[panel-orchestrator] tab ${tabId.slice(0, 8)} connected but model probe empty — sent degraded ack`);
          }
        })
        .catch(() => {
          bridge.push({ type: "ack", ok: false, kind: "degraded" }, tabId);
        });
      return;
    }
    // Model / effort picker: apply and confirm. Model switches live; an effort
    // change restarts the session (resumed) so the conversation carries over.
    if (event.type === "set_options" && event.tab_id) {
      const tabId = event.tab_id;
      const reqModel = typeof event.model === "string" ? event.model : undefined;
      const nextEffort: Effort | null | undefined =
        event.effort === null
          ? null
          : isEffort(event.effort)
            ? event.effort
            : undefined;
      void (async () => {
        let nextModel = reqModel;
        // Guard: never switch to a model the account can't use — an unknown id
        // makes the SDK session hang on init. (Defense in depth; the panel only
        // sends ids from the live catalog.)
        if (nextModel) {
          const known = await ensureModels().catch(() => [] as ModelInfo[]);
          if (known.length && !known.some((m) => m.value === nextModel)) {
            logger.warn(`[panel-orchestrator] ignoring unknown model "${nextModel}" — keeping current`);
            nextModel = undefined;
          }
        }
        const applied = await manager.setOptions(tabId, { model: nextModel, effort: nextEffort });
        bridge.push(
          {
            type: "ack",
            ok: true,
            kind: "options",
            model: applied.model,
            effort: applied.effort ?? null,
            restarted: applied.restarted,
            // Effort changed mid-turn → it takes effect once the current turn ends
            // (we never interrupt a live reply). The panel can note this.
            deferred: applied.deferred,
          },
          tabId,
        );
      })().catch((err) => {
        bridge.push(
          { type: "say", text: `⚠️ Could not change model/effort: ${err?.message ?? err}` },
          tabId,
        );
      });
      return;
    }

    // Execution event from the panel (run finished / errored). Feed it to the
    // tab's live agent so it knows its render landed and can comment/iterate.
    // Dropped silently if no agent is attending the tab (we don't spawn one).
    if (event.type === "agent_event" && event.tab_id) {
      const delivered = manager.injectEvent(event.tab_id, event as {
        kind?: string;
        images?: Array<{ filename: string; subfolder?: string; type?: string }>;
        error?: string;
      });
      if (delivered) {
        logger.info(`[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} event → agent: ${event.kind}`);
      }
      return;
    }

    // Interrupt: stop the current turn without ending the session (Ctrl+C in
    // the panel). The session stays open for the next message.
    if (event.type === "interrupt" && event.tab_id) {
      const tabId = event.tab_id;
      void manager.interrupt(tabId);
      bridge.push({ type: "ack", ok: true, kind: "interrupt" }, tabId);
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} interrupted`);
      return;
    }

    // The user edited/deleted a still-QUEUED message before the agent read it —
    // drop it from the agent's queue so it's never processed.
    if (event.type === "cancel_message" && event.tab_id) {
      const tabId = event.tab_id;
      const mid = typeof (event as { mid?: unknown }).mid === "string" ? (event as { mid?: string }).mid : undefined;
      const removed = mid ? manager.cancelQueued(tabId, mid) : false;
      bridge.push({ type: "ack", ok: true, kind: "cancel_message", mid, removed }, tabId);
      return;
    }

    // New chat: forget this tab's session so the next message starts fresh (no
    // memory of the prior conversation). Tell the panel to drop its stored id.
    if (event.type === "new_session" && event.tab_id) {
      const tabId = event.tab_id;
      // reset() is synchronous (map cleared now), so no concurrent send() can
      // spawn an agent before we report the cleared session.
      manager.reset(tabId);
      bridge.push({ type: "session", session_id: null }, tabId);
      bridge.push({ type: "ack", ok: true, kind: "new_session" }, tabId);
      return;
    }

    // Rewind the conversation: fork the live session at `anchor` (an assistant
    // UUID the panel stored from onTurnAnchor) so everything after it is dropped,
    // optionally continuing with the user's edited `text`. The panel handles the
    // graph (code) scope locally; this is the conversation scope.
    if (event.type === "rewind" && event.tab_id) {
      const tabId = event.tab_id;
      const anchor = typeof event.anchor === "string" ? event.anchor : null;
      const ok = manager.rewind(tabId, anchor);
      bridge.push({ type: "ack", ok, kind: "rewind" }, tabId);
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} rewind (anchor=${anchor ? anchor.slice(0, 8) : "fresh"}, ok=${ok})`);
      return;
    }

    // Reorder still-queued messages to the panel's desired flush order.
    if (event.type === "reorder" && event.tab_id) {
      const tabId = event.tab_id;
      const order = Array.isArray((event as { order?: unknown }).order)
        ? ((event as { order?: unknown[] }).order!.filter((m) => typeof m === "string") as string[])
        : [];
      const ok = manager.reorderQueue(tabId, order);
      bridge.push({ type: "ack", ok, kind: "reorder" }, tabId);
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} reorder queue (${order.length} mids, ok=${ok})`);
      return;
    }

    // Switch to a historical chat: drop the live agent and arm a resume so the
    // next message continues THAT conversation. Both calls are synchronous, so
    // the resume is armed before any later message can spawn a fresh agent.
    if (event.type === "resume_session" && event.tab_id) {
      const tabId = event.tab_id;
      const sid = typeof event.session_id === "string" ? event.session_id : undefined;
      manager.reset(tabId);
      if (sid) manager.setResume(tabId, sid);
      bridge.push({ type: "ack", ok: true, kind: "resume_session" }, tabId);
      return;
    }

    if (
      event.type !== "user_message" ||
      typeof event.text !== "string" ||
      !event.tab_id
    ) {
      return;
    }
    // Echo so the user immediately sees their own message land in the chat.
    bridge.push({ type: "echo", text: event.text }, event.tab_id);
    // Per-message ack: a live server-side signal that the agent received this
    // turn and is working — distinct from the panel's own optimistic spinner.
    // Echo the client mid so the panel can mark that exact bubble delivered.
    const userMid = typeof (event as { mid?: unknown }).mid === "string" ? (event as { mid?: string }).mid : undefined;
    bridge.push({ type: "ack", ok: true, kind: "working", ...(userMid ? { mid: userMid } : {}) }, event.tab_id);
    // Show the working indicator immediately (before the first assistant token).
    bridge.push({ type: "turn", state: "working" }, event.tab_id);
    logger.info(
      `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} → agent: ${event.text.slice(0, 80)}`,
    );
    manager.send(event.tab_id, event.text, {
      title: event.title,
      images: (event as { images?: Array<{ filename: string; subfolder?: string; type?: string }> }).images,
      mid: userMid,
    });
  };

  // ---- Download-progress watcher ----
  // Each tab's comfyui MCP (download_model) writes per-download JSON into
  // progressDir; poll it and broadcast the rows to every panel tab's tray.
  // Done/error rows linger briefly (so completion is visible), then are pruned;
  // a downloading row that stops updating for 60s is treated as a dead writer.
  const DOWNLOAD_LINGER_MS = 8000;
  const downloadRemoveAt = new Map<string, number>();
  let lastDownloadSnapshot = "[]";
  const pollDownloads = () => {
    let files: string[] = [];
    try {
      files = readdirSync(progressDir).filter((f) => f.endsWith(".json"));
    } catch {
      files = []; // dir not created yet — nothing downloading
    }
    const now = Date.now();
    const downloads: Array<Record<string, unknown>> = [];
    for (const f of files) {
      const full = join(progressDir, f);
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
      } catch {
        continue; // mid-write or corrupt — retry next tick
      }
      if (!row || typeof row !== "object") continue;
      const status = row.status;
      const updated = typeof row.updated === "number" ? row.updated : now;
      if (status === "done" || status === "error") {
        const due = downloadRemoveAt.get(full);
        if (due == null) {
          downloadRemoveAt.set(full, now + DOWNLOAD_LINGER_MS); // start the linger
        } else if (now >= due) {
          try { unlinkSync(full); } catch { /* already gone */ }
          downloadRemoveAt.delete(full);
          continue; // pruned from the tray
        }
      } else {
        downloadRemoveAt.delete(full);
        if (now - updated > 60000) {
          try { unlinkSync(full); } catch { /* ignore */ }
          continue; // dead writer (crashed mid-download)
        }
      }
      downloads.push(row);
    }
    downloads.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    const snapshot = JSON.stringify(downloads);
    if (snapshot !== lastDownloadSnapshot) {
      lastDownloadSnapshot = snapshot;
      bridge.push({ type: "download_progress", downloads }); // broadcast to all tabs
    }
  };
  const downloadTimer = setInterval(pollDownloads, 700);
  downloadTimer.unref?.();

  logger.info(
    `[panel-orchestrator] ready — bridge on ws://127.0.0.1:${bridgePort}; an agent spawns per ComfyUI tab on its first message (model=${model}, comfyui=${comfyuiUrl}${comfyuiPath ? `, path=${comfyuiPath}` : " — no COMFYUI_PATH, local install/pack tools limited"})`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[panel-orchestrator] shutting down — stopping agents…");
    clearInterval(downloadTimer);
    await manager.stopAll();
    // Dispose the Codex readiness-probe backend (kills its app-server child).
    if (probeBackend) await probeBackend.close().catch(() => {});
    await bridge.stop();
    // Only remove the lockfile if it still names us — avoid clobbering a fresh
    // orchestrator that may have replaced us.
    try {
      const cur = JSON.parse(readFileSync(lockPath, "utf8"));
      if (cur?.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // No lockfile / unreadable — nothing to clean up.
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Beacon: when ComfyUI (the launcher) exits — cleanly or by crash/kill —
  // shut down rather than linger as an orphan holding the bridge port.
  startParentWatchdog(() => {
    logger.info("[panel-orchestrator] parent (ComfyUI) process exited — shutting down.");
    void shutdown();
  });

  // Keep the process alive; the bridge + agents drive everything from here.
  await new Promise<void>(() => {});
}
