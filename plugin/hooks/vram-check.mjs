#!/usr/bin/env node
/**
 * PreToolUse hook for enqueue_workflow.
 * 1. Checks if ComfyUI is reachable — blocks with a message to start it if not.
 * 2. Checks available VRAM and warns if critically low.
 *
 * Exit 0 = allow tool execution.
 * JSON stdout with hookSpecificOutput = structured control.
 */

function resolveUrlOverride() {
  const raw = process.env.COMFYUI_URL;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
      protocol: u.protocol.replace(":", ""),
    };
  } catch {
    return undefined;
  }
}

const urlOverride = resolveUrlOverride();
const COMFY_HOST =
  urlOverride?.host || process.env.COMFYUI_HOST || process.env.COMFY_HOST || "127.0.0.1";
const COMFY_PROTOCOL =
  urlOverride?.protocol || (process.env.COMFYUI_SSL === "true" ? "https" : "http");
const VRAM_WARNING_MB = 1024; // Warn if less than 1GB free

// Mirrors the main server's detectComfyUIPort() (src/config.ts): an explicit
// port (via COMFYUI_URL or COMFYUI_PORT/COMFY_PORT) is honored as-is,
// otherwise probe the same two well-known ports (8188 repo/CLI default first,
// then 8000 Desktop default) so this hook agrees with whichever port the
// server actually resolved to. Previously this hardcoded 8000 as the sole
// default, which denied every enqueue_workflow call whenever ComfyUI was
// actually running on the 8188 default (and something else answered on 8000
// with a non-2xx status).
const explicitPort =
  urlOverride?.port || Number(process.env.COMFYUI_PORT || process.env.COMFY_PORT) || undefined;
const CANDIDATE_PORTS = explicitPort ? [explicitPort] : [8188, 8000];

async function probePort(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${COMFY_PROTOCOL}://${COMFY_HOST}:${port}/system_stats`, {
      signal: controller.signal,
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function check() {
  try {
    let res = null;
    for (const port of CANDIDATE_PORTS) {
      res = await probePort(port);
      if (res) break;
    }

    if (!res) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "ComfyUI is not running. Use start_comfyui to start it first.",
          },
        }),
      );
      process.exit(0);
    }

    const stats = await res.json();

    if (!stats.devices?.[0]) {
      // No GPU info — allow execution anyway
      process.exit(0);
    }

    const gpu = stats.devices[0];
    const vramFreeMB = gpu.vram_free / 1024 / 1024;

    if (vramFreeMB < VRAM_WARNING_MB) {
      console.error(
        `Warning: Only ${vramFreeMB.toFixed(0)}MB VRAM free. Consider running clear_vram first to avoid OOM errors.`,
      );
    }

    process.exit(0);
  } catch {
    // Connection failed — ComfyUI is not reachable
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "ComfyUI is not running. Use start_comfyui to start it first.",
        },
      }),
    );
    process.exit(0);
  }
}

check();
