import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bin, install, use, Tunnel } from "cloudflared";

import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Cloudflared quick-tunnel helper.
//
// The binary-ensure + `Tunnel.quick(...)` mechanic is adapted (nearly verbatim)
// from the MIT-licensed Ungate project's tunnel-manager:
//   https://github.com/orchidfiles/ungate
//   apps/extension/src/tunnel-manager.ts
//
// This is part of the experimental embedded-agent-panel POC (see
// design/embedded-agent-panel.md). It is NOT wired into the default MCP
// stdio/HTTP startup path — it is only reached behind the
// COMFYUI_MCP_AGENT_POC flag via src/experimental/agent-poc.ts.
// ---------------------------------------------------------------------------

// Where we cache a downloaded cloudflared binary when the bundled `bin` is
// missing (mirrors Ungate's `~/.ungate/bin` location).
const CLOUDFLARED_BIN_DIR = path.join(os.homedir(), ".comfyui-mcp", "bin");

function getCloudflaredBinPath(): string {
  return path.join(
    CLOUDFLARED_BIN_DIR,
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
}

// Quick tunnels do not use a config file. Pointing --config at the platform
// null device prevents cloudflared from picking up an ambient config.
function getCloudflaredConfigArg(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

export type TunnelStatus =
  | "stopped"
  | "starting"
  | "installing"
  | "running"
  | "error";

export interface TunnelState {
  status: TunnelStatus;
  url: string | null;
  error: string | null;
}

export interface QuickTunnel {
  /** Public https://<rand>.trycloudflare.com URL. */
  url: string;
  /** Reactive view of the tunnel lifecycle state. */
  getState(): TunnelState;
  /** Tear the tunnel down. Idempotent. */
  stop(): void;
}

/**
 * Ensure a cloudflared binary is available for the `cloudflared` package to
 * spawn. If the bundled `bin` exists we use it as-is; otherwise we reuse a
 * previously-downloaded binary in CLOUDFLARED_BIN_DIR, or download one.
 *
 * Ported from Ungate's `ensureBinary` (simplified — no legacy-path rename).
 */
async function ensureBinary(): Promise<void> {
  if (fs.existsSync(bin)) {
    return;
  }

  const userBinPath = getCloudflaredBinPath();
  if (fs.existsSync(userBinPath)) {
    use(userBinPath);
    return;
  }

  logger.info("[tunnel] Downloading cloudflared binary...");
  fs.mkdirSync(CLOUDFLARED_BIN_DIR, { recursive: true });
  const installedPath = await install(userBinPath);
  use(installedPath);
  logger.info("[tunnel] cloudflared installed successfully");
}

/**
 * Start a Cloudflare quick tunnel that exposes http://localhost:<port> on a
 * public HTTPS URL. Resolves once the `url` event fires; rejects if the
 * cloudflared process errors or exits before becoming ready.
 *
 * @param port Local port to expose (e.g. the POC chat server's port).
 */
export async function startQuickTunnel(port: number): Promise<QuickTunnel> {
  const state: TunnelState = { status: "starting", url: null, error: null };

  await ensureBinary();

  const t = Tunnel.quick(`http://localhost:${port}`, {
    "--config": getCloudflaredConfigArg(),
    "--edge-ip-version": "4",
  });

  return await new Promise<QuickTunnel>((resolve, reject) => {
    let settled = false;

    // Detach all listeners so nothing leaks once we've settled the promise
    // (especially on the pre-ready failure paths, where the caller never gets
    // a handle to call stop()).
    const teardownListeners = (): void => {
      t.off("url", onUrl);
      t.off("stderr", onStderr);
      t.off("error", onError);
      t.off("exit", onExit);
    };

    const stop = (): void => {
      try {
        t.stop();
      } catch {
        // Process already gone — fine.
      }
      teardownListeners();
      state.status = "stopped";
      state.url = null;
      state.error = null;
    };

    function onUrl(url: string): void {
      logger.info(`[tunnel] URL: ${url}`);
      state.status = "running";
      state.url = url;
      state.error = null;

      if (!settled) {
        settled = true;
        resolve({
          url,
          getState: () => ({ ...state }),
          stop,
        });
      }
    }

    function onStderr(data: string): void {
      for (const line of data.split("\n")) {
        if (line.trim()) logger.info(`[tunnel] ${line}`);
      }
    }

    function onError(err: Error): void {
      const message = err.message;
      logger.error(`[tunnel] error: ${message}`);
      state.status = "error";
      state.url = null;
      state.error = message;

      if (!settled) {
        settled = true;
        // Pre-ready failure: stop the process and detach listeners so a
        // cloudflared that errors without exiting can't leak.
        try {
          t.stop();
        } catch {
          // Already gone — fine.
        }
        teardownListeners();
        reject(err);
      }
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      logger.warn(`[tunnel] exited code=${code} signal=${signal}`);

      // An exit before the `url` event means the tunnel never came up.
      if (!settled) {
        settled = true;
        state.status = "error";
        state.url = null;
        state.error = `cloudflared exited before tunnel was ready (code=${code})`;
        teardownListeners();
        reject(new Error(state.error));
      } else if (state.status !== "stopped") {
        state.status = "stopped";
        state.url = null;
      }
    }

    t.on("url", onUrl);
    t.on("stderr", onStderr);
    t.on("error", onError);
    t.on("exit", onExit);
  });
}
