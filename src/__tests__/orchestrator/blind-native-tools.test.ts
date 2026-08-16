// SECURITY regression (Blind bypass via native tools): the Claude Agent SDK
// subprocess runs the full claude_code preset with bypassPermissions — it keeps
// Claude Code's NATIVE tools (Read, WebFetch, …). Native Read on a PNG delivers
// actual pixels to the model without touching the comfyui MCP tool server, so
// the COMFYUI_MCP_BLIND env gate (issue #90 / #884) never fires. Reproduced
// live: Blind ON, agent read the LoadImage input file with native Read and
// described the photo in detail. The backend must register a PreToolUse hook
// that denies image-content Read/WebFetch whenever the live isBlind() predicate
// says the toggle is on — mechanical, like the MCP-side scrub, not a prompt.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = mkdtempSync(join(tmpdir(), "blind-native-registry-"));

const hoisted = vi.hoisted(() => ({
  optionsSeen: [] as Array<Record<string, unknown>>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (arg: { options?: Record<string, unknown> }) => {
    hoisted.optionsSeen.push(arg.options ?? {});
    const iter = (async function* () {
      yield { type: "result", subtype: "success", result: "{}" };
    })();
    return Object.assign(iter, {
      supportedModels: async () => [],
      supportedCommands: async () => [],
      interrupt: async () => {},
      setModel: async () => {},
    });
  },
}));

beforeEach(() => {
  hoisted.optionsSeen.length = 0;
});

type HookCallback = (
  input: { hook_event_name: string; tool_name: string; tool_input: unknown; tool_use_id: string },
  toolUseID: string | undefined,
  opts: { signal: AbortSignal },
) => Promise<{
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}>;

/** Run one mocked turn and return the PreToolUse hook callbacks the backend registered. */
async function hooksFromRun(isBlind?: () => boolean): Promise<HookCallback[]> {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "", isBlind });
  async function* channel() {
    yield { text: "hi" };
  }
  try {
    for await (const _ of backend.run({ channel: channel() as never })) void _;
  } catch {
    // Mocked SDK result may not fully route — options were already captured.
  }
  const runOpts = hoisted.optionsSeen.find((o) => "systemPrompt" in o) ?? hoisted.optionsSeen[0];
  const hooks = runOpts?.hooks as
    | Record<string, Array<{ hooks: HookCallback[] }>>
    | undefined;
  return (hooks?.PreToolUse ?? []).flatMap((m) => m.hooks);
}

async function decide(
  cbs: HookCallback[],
  tool_name: string,
  tool_input: unknown,
): Promise<{ denied: boolean; reason: string }> {
  let denied = false;
  let reason = "";
  for (const cb of cbs) {
    const out = await cb(
      { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1" },
      "t1",
      { signal: new AbortController().signal },
    );
    if (out?.hookSpecificOutput?.permissionDecision === "deny") {
      denied = true;
      reason = out.hookSpecificOutput.permissionDecisionReason ?? "";
    }
  }
  return { denied, reason };
}

describe("Blind gates the Claude backend's NATIVE pixel tools (PreToolUse hook)", () => {
  it("registers a PreToolUse hook that denies a native Read of an image file while blind", async () => {
    const cbs = await hooksFromRun(() => true);
    expect(cbs.length, "buildOptions must register a PreToolUse hook (native-tool blind gate)").toBeGreaterThan(0);
    const verdict = await decide(cbs, "Read", { file_path: "/anywhere/IMG_SRC_photo.png" });
    expect(verdict.denied, "native Read of a .png must be denied while Blind is ON").toBe(true);
    expect(verdict.reason).toMatch(/[Bb]lind/);
  });

  it("denies renamed image bytes by magic sniff, not just extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blind-sniff-"));
    const disguised = join(dir, "notes.txt");
    // PNG magic bytes in a .txt — extension games must not defeat the gate.
    writeFileSync(disguised, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
    const cbs = await hooksFromRun(() => true);
    const verdict = await decide(cbs, "Read", { file_path: disguised });
    expect(verdict.denied).toBe(true);
  });

  it("denies WebFetch of ComfyUI /view and image URLs while blind", async () => {
    const cbs = await hooksFromRun(() => true);
    expect((await decide(cbs, "WebFetch", { url: "http://127.0.0.1:8188/view?filename=x.png&type=input" })).denied).toBe(true);
    expect((await decide(cbs, "WebFetch", { url: "http://127.0.0.1:8188/api/view?filename=x.png" })).denied).toBe(true);
    expect((await decide(cbs, "WebFetch", { url: "https://example.com/photo.jpg" })).denied).toBe(true);
  });

  it("still allows non-pixel work while blind (text Read, ordinary WebFetch, other tools)", async () => {
    const cbs = await hooksFromRun(() => true);
    expect((await decide(cbs, "Read", { file_path: "/repo/src/index.ts" })).denied).toBe(false);
    expect((await decide(cbs, "WebFetch", { url: "https://docs.comfy.org/quickstart" })).denied).toBe(false);
    expect((await decide(cbs, "Bash", { command: "ls" })).denied).toBe(false);
  });

  it("reads the predicate LIVE — a mid-session Blind toggle applies to the next call, no respawn needed", async () => {
    let blind = false;
    const cbs = await hooksFromRun(() => blind);
    expect((await decide(cbs, "Read", { file_path: "/x/a.png" })).denied).toBe(false);
    blind = true;
    expect((await decide(cbs, "Read", { file_path: "/x/a.png" })).denied).toBe(true);
  });

  it("a backend constructed without isBlind (legacy callers) never denies", async () => {
    const cbs = await hooksFromRun(undefined);
    expect((await decide(cbs, "Read", { file_path: "/x/a.png" })).denied).toBe(false);
  });
});
