#!/usr/bin/env node
/**
 * PreToolUse hook for enqueue_workflow.
 * 1. Checks if ComfyUI is reachable — blocks with a message to start it if not.
 * 2. Checks available VRAM and warns if critically low.
 *
 * Exit 0 = allow tool execution.
 * JSON stdout with hookSpecificOutput = structured control.
 */

const COMFY_PORT = Number(process.env.COMFY_PORT) || 8000;
const VRAM_WARNING_MB = 1024; // Warn if less than 1GB free

async function check() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${COMFY_PORT}/system_stats`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "ComfyUI returned a non-OK status. Check if it is running correctly.",
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
