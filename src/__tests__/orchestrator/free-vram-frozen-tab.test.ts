// #1249 — panel_free_vram on a FROZEN canvas tab. The command is a purely
// server-side operation (the panel's handler is a plain POST /free), yet the
// tool treated the tab's ack as the only source of truth: a reply timeout left
// the caller with "MUTATES … may have been applied" and no way to verify
// recovery — the tool even warns against retrying, so recovery could never be
// confirmed.
//
// The settle: when the tab PROVABLY fronts the orchestrator's local boot
// instance (the captureRebootHealthBase gate), issue /free DIRECTLY and verify
// on the server's own answer, reading /system_stats around it for the VRAM
// counters. /free is idempotent, so the copy the frozen tab may still execute
// when it wakes cannot double-apply — the hazard that bars this path for every
// other mutation does not exist for this one command. Every case that cannot
// be verified returns the original outcome-unknown UNTOUCHED.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { markReplyTimeout } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";

/** The orchestrator's immutable boot endpoint — what the direct /free aims at. */
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

/** The bridge's canonical no-reply for a MUTATING command, verbatim from a live
 *  UiBridge against a frozen tab (the exact string the issue reports). */
const ackTimeout = (cmd: string, ms: number): Error =>
  new Error(
    `Panel tab ${TAB} did not reply to "${cmd}" within ${ms} ms — the ComfyUI tab may be ` +
      `backgrounded or frozen. This command MUTATES and was already delivered to the tab, so it ` +
      `may have been applied despite the missing reply — check the current state before ` +
      `re-issuing it; a blind retry can apply it twice`,
  );

let sent: string[] = [];

function bridge(opts: {
  reply: "timeout" | "acked-error" | "acked-error-timeout-worded" | "ok";
  /** What the captureRebootHealthBase gate sees: is this a server-trusted local
   *  tab whose handshake origin matches the boot instance? */
  local?: boolean;
  origin?: string | null;
}): PanelToolCtx["bridge"] {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd !== "free_vram") return { ok: true };
      if (opts.reply === "ok") return { freed: true, unload_models: true, free_memory: true };
      if (opts.reply === "acked-error") {
        // The panel's OWN verdict: /free answered non-OK and the tab SAID so.
        throw new Error("Failed to free VRAM: 500 Internal Server Error — OOM in unload");
      }
      if (opts.reply === "acked-error-timeout-worded") {
        // An ACKED panel error quoting the bridge's canonical timeout sentence
        // verbatim — text is NOT the discriminator (#1468 round 2); the missing
        // markReplyTimeout tag is the difference that actually exists.
        throw new Error(
          `Panel tab ${TAB} did not reply to "free_vram" within 15000 ms — the ComfyUI tab ` +
            `may be backgrounded or frozen. Reported by the executor: /free answered 503.`,
        );
      }
      throw markReplyTimeout(ackTimeout("free_vram", 15000));
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    // The direct-path gate reads the SERVER-OBSERVED handshake origin and the
    // token-less-loopback provenance, never the spoofable hello.comfyui_url.
    tabIsLocal: () => opts.local ?? true,
    tabServerOrigin: () =>
      opts.origin === undefined ? BOOT_BASE : (opts.origin ?? undefined),
  } as unknown as PanelToolCtx["bridge"];
}

async function run(
  opts: Parameters<typeof bridge>[0],
): Promise<{ text: string; isError: boolean }> {
  const ctx = makePanelToolCtx(bridge(opts), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_free_vram");
  if (!def) throw new Error("panel_free_vram is not registered");
  const res: ToolResult = await def.handler({} as never, ctx);
  return { text: textOf(res), isError: res.isError === true };
}

/** The scripted server-side /free outcomes a test can inject. */
const DIRECT_OK = {
  ok: true,
  before: [{ name: "cuda:0", vram_total: 16_000, vram_free: 2_000 }],
  after: [{ name: "cuda:0", vram_total: 16_000, vram_free: 15_000 }],
};
const DIRECT_OK_NO_STATS = { ok: true, before: null, after: null };
const DIRECT_FAIL = { ok: false, reason: "POST http://127.0.0.1:8188/free answered HTTP 500" };

let directCalls: string[] = [];

beforeEach(() => {
  sent = [];
  directCalls = [];
});

afterEach(() => {
  __panelToolsTestHooks.setFreeVramDirect(null);
  __panelToolsTestHooks.setReadVramDevices(null);
});

describe("panel_free_vram on a frozen tab is settled server-side (#1249)", () => {
  it("issues /free directly and reports the verified outcome when the tab fronts the local server", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async (base: string) => {
      directCalls.push(base);
      return DIRECT_OK;
    });
    const out = await run({ reply: "timeout" });

    // The tab was asked exactly once — nothing was re-dispatched through it.
    expect(sent).toEqual(["free_vram"]);
    // The direct path aimed at the PROVEN base, not a spoofable hello URL.
    expect(directCalls).toEqual([BOOT_BASE]);

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).toMatch(/"verified": "server-side"/);
    expect(out.text).toMatch(/"acknowledged": false/);
    // The observed counters, not a claimed delta.
    expect(out.text).toMatch(/"vram_before"/);
    expect(out.text).toMatch(/"vram_after"/);
    // The disclosure says what happened and why the queued tab copy is harmless.
    expect(out.text).toMatch(/never acknowledged/);
    expect(out.text).toMatch(/idempotent/);
  });

  it("says the 2xx — not a measured delta — is the verification when /system_stats does not answer", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async () => DIRECT_OK_NO_STATS);
    const out = await run({ reply: "timeout" });

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/"vram_before"/);
    expect(out.text).toMatch(/no VRAM counters are reported/);
  });

  it("returns the outcome-unknown UNTOUCHED when the tab is not a server-trusted local tab", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async (base: string) => {
      directCalls.push(base);
      return DIRECT_OK;
    });
    const out = await run({ reply: "timeout", local: false });

    // The gate refused: no direct /free was ever attempted at an unproven server.
    expect(directCalls).toEqual([]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/may have been applied despite the missing reply/);
    expect(out.text).not.toMatch(/server-side/);
  });

  it("returns the outcome-unknown UNTOUCHED when the tab's handshake origin is a DIFFERENT instance", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async (base: string) => {
      directCalls.push(base);
      return DIRECT_OK;
    });
    const out = await run({ reply: "timeout", origin: "http://127.0.0.1:8288" });

    // Freeing the BOOT server and reporting it as this command's success would
    // be a wrong-target success — worse than the honest unknown being fixed.
    expect(directCalls).toEqual([]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/may have been applied despite the missing reply/);
  });

  it("keeps the outcome UNKNOWN — and names what was tried — when the direct /free also fails", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async () => DIRECT_FAIL);
    const out = await run({ reply: "timeout" });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/may have been applied despite the missing reply/);
    expect(out.text).toMatch(/server-side fallback also could not reach/);
    expect(out.text).toMatch(/HTTP 500/);
    expect(out.text).toMatch(/UNVERIFIED/);
  });

  it("does NOT re-issue behind an ACKED executor error — the panel already said what failed", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async (base: string) => {
      directCalls.push(base);
      return DIRECT_OK;
    });
    const out = await run({ reply: "acked-error" });

    expect(sent).toEqual(["free_vram"]);
    expect(directCalls).toEqual([]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Failed to free VRAM: 500/);
  });

  it("does NOT settle an acked error that merely QUOTES the timeout sentence (#1468 round 2)", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async (base: string) => {
      directCalls.push(base);
      return DIRECT_OK;
    });
    const out = await run({ reply: "acked-error-timeout-worded" });

    // Not markReplyTimeout-tagged, so the settle must not fire on the text.
    expect(directCalls).toEqual([]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/\/free answered 503/);
  });

  it("passes a normal acknowledgement through unchanged", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async (base: string) => {
      directCalls.push(base);
      return DIRECT_OK;
    });
    // Occupancy unreadable → #1866 claims nothing extra and leaves the ack.
    __panelToolsTestHooks.setReadVramDevices(async () => null);
    const out = await run({ reply: "ok" });

    expect(directCalls).toEqual([]);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/server-side/);
  });
});
