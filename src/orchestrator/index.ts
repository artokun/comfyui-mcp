// Panel orchestrator — a standalone, long-lived process that drives the ComfyUI
// sidebar panel with autonomous BACKGROUND agents, so the user's interactive
// Claude session stays free. Launch with `comfyui-mcp --panel-orchestrator`
// (or COMFYUI_MCP_PANEL_ORCHESTRATOR=1).
//
// It owns the UI bridge (port 9101) directly — so it SEES panel messages instead
// of relying on an idle interactive session to notice a channel push — and spawns
// one Claude Agent SDK streaming session per panel tab (src/orchestrator/
// panel-agent.ts). Each agent runs on the user's Claude SUBSCRIPTION with no API
// key. See docs/design/panel-orchestrator.md.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startUiBridge } from "../services/ui-bridge.js";
import { logger } from "../utils/logger.js";
import { PanelAgentManager } from "./panel-agent.js";

const PANEL_SYSTEM_APPEND = `You are the autonomous assistant embedded directly in a ComfyUI sidebar panel. The person is working in ComfyUI and talks to you through that panel: their messages arrive as your prompts, and everything you write is shown to them in the panel chat. Write for that reader — lead with the result, keep replies short and concrete, and don't narrate routine internal steps.

You have the comfyui MCP tools to generate images, video, and audio and to inspect and manage their ComfyUI instance. Use them to actually do what's asked, then tell them what you did and name or link any output. If a request is ambiguous, make a sensible choice and say what you chose rather than stalling.

You are running in the background on the user's own machine. For routine, reversible actions that follow from the request, act without asking permission.`;

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
  const timer = setInterval(() => {
    let alive = true;
    try {
      process.kill(ppid, 0); // signal 0 = existence probe, doesn't actually signal
    } catch (err) {
      // ESRCH = gone; EPERM = exists but not ours to signal (treat as alive).
      alive = (err as NodeJS.ErrnoException).code === "EPERM";
    }
    if (!alive) {
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
  // Subscription lane: the background agent must authenticate against the user's
  // claude.ai login, never an API key. Unset the key for the SDK subprocess.
  delete process.env.ANTHROPIC_API_KEY;

  const bridge = startUiBridge();

  // Owning the bridge port is the orchestrator's whole job — if another process
  // holds it (e.g. an interactive comfyui-mcp running with --channels), fail
  // loudly instead of running uselessly. (This also avoids the case where a
  // failed bind leaves the process with no live handles and it exits silently.)
  const bound = await bridge.whenReady();
  if (!bound) {
    logger.error(
      `[panel-orchestrator] could not bind the panel bridge port — another process owns it (often an interactive comfyui-mcp started with --channels). Free that port (or stop the --channels session) and restart the orchestrator. Override the port with COMFYUI_MCP_BRIDGE_PORT.`,
    );
    process.exit(1);
  }

  // The spawned agent runs THIS comfyui-mcp build as its MCP server, in normal
  // (non-channels) mode — so it generates against the live ComfyUI over
  // COMFYUI_URL and never tries to bind the bridge port we own here.
  const mcpEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const comfyuiUrl = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
  const model = process.env.COMFYUI_MCP_PANEL_MODEL ?? "claude-opus-4-8";

  // The bundled plugin (skills) ships alongside dist/ in the package root. Load
  // it so the background agents are ComfyUI experts out of the box.
  const pluginPath = fileURLToPath(new URL("../../plugin", import.meta.url));
  const pluginAvailable = existsSync(pluginPath);
  if (!pluginAvailable) {
    logger.warn(
      `[panel-orchestrator] bundled plugin not found at ${pluginPath} — agents run without model-expertise skills.`,
    );
  }

  const manager = new PanelAgentManager({
    model,
    systemAppend: PANEL_SYSTEM_APPEND,
    pluginPath: pluginAvailable ? pluginPath : undefined,
    mcpServers: {
      comfyui: {
        type: "stdio",
        command: process.execPath, // node
        args: [mcpEntry], // dist/index.js, no --channels
        env: { COMFYUI_URL: comfyuiUrl },
      },
    },
    onSay: (tabId, text) => {
      bridge.push({ type: "say", text }, tabId);
    },
  });

  bridge.onPanelMessage = (event) => {
    if (
      event.type !== "user_message" ||
      typeof event.text !== "string" ||
      !event.tab_id
    ) {
      return;
    }
    // Echo so the user immediately sees their own message land in the chat.
    bridge.push({ type: "echo", text: event.text }, event.tab_id);
    logger.info(
      `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} → agent: ${event.text.slice(0, 80)}`,
    );
    manager.send(event.tab_id, event.text, { title: event.title });
  };

  logger.info(
    `[panel-orchestrator] ready — bridge on ws://127.0.0.1:9101; an agent spawns per ComfyUI tab on its first message (model=${model}, comfyui=${comfyuiUrl})`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[panel-orchestrator] shutting down — stopping agents…");
    await manager.stopAll();
    await bridge.stop();
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
