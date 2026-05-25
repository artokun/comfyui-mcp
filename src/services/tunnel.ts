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

    const stop = (): void => {
      try {
        t.stop();
      } catch {
        // Process already gone — fine.
      }
      state.status = "stopped";
      state.url = null;
      state.error = null;
    };

    t.on("url", (url) => {
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
    });

    t.on("stderr", (data) => {
      for (const line of data.split("\n")) {
        if (line.trim()) logger.info(`[tunnel] ${line}`);
      }
    });

    t.on("error", (err) => {
      const message = err.message;
      logger.error(`[tunnel] error: ${message}`);
      state.status = "error";
      state.url = null;
      state.error = message;

      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    t.on("exit", (code, signal) => {
      logger.warn(`[tunnel] exited code=${code} signal=${signal}`);

      // An exit before the `url` event means the tunnel never came up.
      if (!settled) {
        settled = true;
        state.status = "error";
        state.url = null;
        state.error = `cloudflared exited before tunnel was ready (code=${code})`;
        reject(new Error(state.error));
      } else if (state.status !== "stopped") {
        state.status = "stopped";
        state.url = null;
      }
    });
  });
}
