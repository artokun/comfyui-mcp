import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

/**
 * Durable per-tab SDK session ids, so an agent's memory survives the orchestrator
 * PROCESS dying — a wedge auto-restart, a crash, an OOM — not just a soft reload.
 *
 * The panel also persists the session id (onSession → a `session` frame → the
 * panel's localStorage), and resumes by re-sending it on reconnect. But that path
 * is the PANEL's: if the orchestrator is killed and a fresh one comes up before the
 * panel re-sends `hello.resume` — or the panel never sends it — the conversation is
 * silently lost (P0: the agent "forgets everything" after an auto-restart). This is
 * the orchestrator's own belt-and-suspenders copy: written when the agent reports
 * its session id, read as the resume fallback when a tab first spawns. Keyed by the
 * bridge port so two ComfyUI instances on one machine never cross-resume.
 */
export class SessionStore {
  private readonly path: string;
  private map: Record<string, string>;

  constructor(port: number) {
    this.path = join(tmpdir(), `comfyui-mcp-panel-sessions-${port}.json`);
    this.map = this.read();
  }

  private read(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed && typeof parsed === "object") {
        // Keep only string→string entries — never trust the file blindly.
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      }
    } catch {
      // Missing or corrupt — start empty. Resume falls back to a fresh session.
    }
    return {};
  }

  private flush(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.map));
    } catch (err) {
      logger.debug(`[session-store] write failed: ${String(err)}`);
    }
  }

  /** The persisted session id to resume for a tab, if any. */
  get(tabId: string): string | undefined {
    return this.map[tabId];
  }

  /** Record (and persist) a tab's current session id. No-op if unchanged. */
  set(tabId: string, sessionId: string): void {
    if (this.map[tabId] === sessionId) return;
    this.map[tabId] = sessionId;
    this.flush();
  }

  /** Forget a tab's session — called when the panel starts a NEW chat, so the
   *  disk fallback never resurrects a deliberately-reset conversation. */
  clear(tabId: string): void {
    if (!(tabId in this.map)) return;
    delete this.map[tabId];
    this.flush();
  }
}
