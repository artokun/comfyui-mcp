#!/usr/bin/env node
/**
 * PreToolUse hook for stop_comfyui and restart_comfyui.
 * Prompts the user to confirm before stopping ComfyUI,
 * warning them to save any unsaved workflow changes.
 *
 * Returns permissionDecision: "ask" to show a confirmation dialog.
 */

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason:
        "This will stop ComfyUI. Any unsaved workflow changes in the ComfyUI editor will be lost. Make sure your work is saved before proceeding.",
    },
  }),
);

process.exit(0);
