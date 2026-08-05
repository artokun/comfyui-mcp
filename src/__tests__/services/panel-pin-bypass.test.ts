// END-TO-END regression for the pin BYPASS.
//
// The pin was originally enforced only inside `runPanelAction`, which the PR
// described as "the mutation choke point". It was not: the sidebar panel is an
// ordinary custom node pack, so the GENERIC node mutations reach the very same
// ComfyUI-Manager operation without touching install_panel at all. A pinned user
// was one `update_custom_node(id="all")` away from being moved.
//
// These tests call the REAL exported service functions (no fs mocking, a real
// temp settings file) and assert they REFUSE while a pin is in force — and,
// critically, that they refuse BEFORE any Manager request is issued.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The pending-operation marker is a REAL file (panel-pin-guard). Point it at a
// temp path at MODULE scope so the suite never touches ~/.comfyui-mcp, and so
// parallel vitest workers get their own file instead of racing on one.
//
// Without this, every call here wrote live pending-op markers into the developer's
// own state, where the orchestrator reads them and warns on every pin write that a
// queued update or deferred restore may be outstanding. Same class as #837 (the
// suite writing to the real .env) and #859 (the real OAuth mirror).
process.env.COMFYUI_MCP_PANEL_PENDING = join(
  tmpdir(),
  `cmcp-pending-pin-bypass-${process.pid}.json`,
);


vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined as string | undefined,
  };
  return {
    config,
    isLocalMode: () => true,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
    getComfyUIAuthHeaders: () => ({}),
  };
});

// Any Manager traffic at all means the guard let the mutation through.
const managerCalls: string[] = [];
// Test-controlled gates on the stubbed Manager. `managerGate` parks a call
// mid-flight, so a mutation can be held BETWEEN its pin check and completion;
// `managerFailAfterGate` then fails every later call fast, so the parked op
// settles immediately instead of wandering the queue-dialect probes on the
// stub "{}" responses.
let managerGate: Promise<void> | null = null;
let managerFailAfterGate = false;
// The update paths route through detectManagerApi (#656), and with the generic
// "{}" answers detection THROWS — which is what most of these tests want (a
// fast, definite failure right after the guard lets a call through). But the
// update_all lock test needs the mutation to actually COMPLETE — enqueue +
// worker start, no drain — so it opts into the stub answering the dialect
// probes like a legacy 3.x Manager. (Never turn this on for a path that
// DRAINS the Manager queue: the stub has no queue progression, so the drain
// would hold the panel lock until the test times out, cascading into every
// later lock-taking test.)
let managerLegacyPersona = false;
vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: vi.fn(async (url: string) => {
    managerCalls.push(url);
    if (managerGate) await managerGate;
    if (managerFailAfterGate) throw new Error("test: Manager went away");
    if (managerLegacyPersona) {
      const path = new URL(url, "http://stub.local").pathname;
      if (path === "/manager/queue/status") {
        return new Response(
          JSON.stringify({
            total_count: 1,
            done_count: 1,
            in_progress_count: 0,
            is_processing: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (path === "/manager/version") {
        return new Response("V3.41", { status: 200 });
      }
    }
    return new Response("{}", { status: 200 });
  }),
}));

import {
  fixCustomNode,
  installCustomNode,
  reinstallCustomNode,
  updateCustomNode,
} from "../../services/node-management.js";
import { updateAllCustomNodes } from "../../services/update-comfyui.js";
import { restoreNodeSnapshot } from "../../services/node-snapshots.js";
import {
  PanelPinnedError,
  withPanelMutationLock,
} from "../../services/panel-pin-guard.js";
import {
  getPanelPinState,
  PANEL_PIN_ENV_VAR,
  setPanelVersionPin,
} from "../../services/panel-settings.js";

let dir: string;

beforeEach(() => {
  managerCalls.length = 0;
  managerGate = null;
  managerFailAfterGate = false;
  managerLegacyPersona = false;
  dir = mkdtempSync(join(tmpdir(), "cmcp-bypass-"));
  process.env.COMFYUI_MCP_PANEL_SETTINGS = join(dir, "panel-settings.json");
  process.env.COMFYUI_MCP_PANEL_LOCK = join(dir, "panel-op.lock");
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
  delete process.env.COMFYUI_MCP_PANEL_LOCK;
  delete process.env[PANEL_PIN_ENV_VAR];
  rmSync(dir, { recursive: true, force: true });
});

describe("generic node mutations cannot walk past the panel pin", () => {
  it('update_custom_node(id="comfyui-agent-panel") REFUSES while pinned', async () => {
    setPanelVersionPin("0.11.3");
    await expect(updateCustomNode({ id: "comfyui-agent-panel" })).rejects.toThrow(
      PanelPinnedError,
    );
    expect(managerCalls).toEqual([]); // refused before any Manager request
  });

  it('update_custom_node(id="all") REFUSES while pinned — the bulk door', async () => {
    // Nothing about "all" names the panel, yet it moves it. This is the exact
    // scenario that made the original guard placement wrong.
    setPanelVersionPin("0.11.3");
    await expect(updateCustomNode({ id: "all" })).rejects.toThrow(PanelPinnedError);
    expect(managerCalls).toEqual([]);
  });

  it("update_all REFUSES while pinned — the third door, not a node tool at all", async () => {
    setPanelVersionPin("0.11.3");
    await expect(updateAllCustomNodes()).rejects.toThrow(PanelPinnedError);
    expect(managerCalls).toEqual([]);
  });

  it("reinstall/install/fix of the panel REFUSE while pinned, by any spelling", async () => {
    setPanelVersionPin("0.11.3");
    await expect(reinstallCustomNode({ id: "comfyui-mcp-panel" })).rejects.toThrow(
      PanelPinnedError,
    );
    await expect(
      installCustomNode({ id: "https://github.com/artokun/comfyui-mcp-panel.git" }),
    ).rejects.toThrow(PanelPinnedError);
    await expect(fixCustomNode({ id: "all" })).rejects.toThrow(PanelPinnedError);
    expect(managerCalls).toEqual([]);
  });

  it("REJECTS rather than throwing synchronously (callers use .then/.catch)", async () => {
    // apply_manifest does `installCustomNode(...).then().catch()` and documents
    // that it never rejects — a synchronous throw would walk straight past that
    // .catch and escape as an unhandled exception.
    setPanelVersionPin("0.11.3");
    let sync: unknown;
    let promise: Promise<unknown> | undefined;
    try {
      promise = updateCustomNode({ id: "all" });
    } catch (err) {
      sync = err;
    }
    expect(sync).toBeUndefined();
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow(PanelPinnedError);
  });

  it.each([
    "https://github.com/artokun/comfyui-mcp-panel.git@v0.11.28",
    "https://github.com/artokun/comfyui-mcp-panel/tree/main",
    "https://gitlab.com/artokun/comfyui-mcp-panel/-/commit/abc1234",
    "comfyui-agent-panel@nightly",
  ])("REFUSES the ref-carrying git form %j while pinned", async (id) => {
    // These are forms parseGitUrl accepts, so they really do reach the pack —
    // but the first matcher compared the raw last path segment and let them all
    // through, moving a pinned panel.
    setPanelVersionPin("0.11.3");
    await expect(installCustomNode({ id })).rejects.toThrow(PanelPinnedError);
    expect(managerCalls).toEqual([]);
  });

  it("an UNRELATED pack is untouched by the pin", async () => {
    setPanelVersionPin("0.11.3");
    // Reaches the Manager path (and fails there on the stubbed response, not on
    // the pin) — proving the guard is targeted, not a blanket freeze.
    await expect(updateCustomNode({ id: "was-node-suite" })).rejects.not.toThrow(
      PanelPinnedError,
    );
    expect(managerCalls.length).toBeGreaterThan(0);
  });

  it("everything proceeds again once the pin is cleared", async () => {
    setPanelVersionPin("0.11.3");
    await expect(updateCustomNode({ id: "all" })).rejects.toThrow(PanelPinnedError);
    process.env[PANEL_PIN_ENV_VAR] = "off";
    // No longer refused by the pin; it now reaches the Manager path.
    await updateCustomNode({ id: "all" }).catch(() => undefined);
    expect(managerCalls.length).toBeGreaterThan(0);
  });
});

describe("a pin written MID-mutation cannot slice through it", () => {
  it("a bulk update holds the mutation lock across check + act, so the pin write waits", async () => {
    // Park the update BETWEEN its pin check and completion: the first Manager
    // request only fires once the check has passed, so an observed request
    // means the update is inside the critical window the race used to exploit.
    let releaseManager!: () => void;
    managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });

    const update = updateCustomNode({ id: "all" });
    await vi.waitFor(() => expect(managerCalls.length).toBeGreaterThan(0));

    // Commit a pin exactly the way install_panel(action='pin') does — through
    // the shared mutation lock.
    let pinCommitted = false;
    const pinWrite = withPanelMutationLock(async () => {
      setPanelVersionPin("0.11.3");
      pinCommitted = true;
    });

    // Give the pin write every chance to run. It must NOT land: the update
    // holds the lock across check + act, so a pin commits before an op starts
    // (and blocks it) or after it finishes — never in the middle. Before the
    // fix, the pin committed right here and the in-flight update went on to
    // move a by-then-pinned panel.
    await new Promise((r) => setTimeout(r, 250));
    expect(pinCommitted).toBe(false);
    expect(getPanelPinState().pinned).toBe(false);

    // Let the update settle (the stub is not a real Manager — fail it fast so
    // it ends immediately), then the pin commits and governs the NEXT op.
    managerFailAfterGate = true;
    releaseManager();
    await update.catch(() => undefined);
    await pinWrite;
    expect(pinCommitted).toBe(true);
    await expect(updateCustomNode({ id: "all" })).rejects.toThrow(PanelPinnedError);
  });

  it("update_all holds the lock across queue + start, and still only reports 'queued'", async () => {
    // update_all goes detectManagerApi → enqueueUpdateAll → queue/start with NO
    // drain, so the stub can let it complete: answer the dialect probes like a
    // legacy 3.x Manager (see the stub's comment).
    managerLegacyPersona = true;
    let releaseManager!: () => void;
    managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });

    const update = updateAllCustomNodes();
    await vi.waitFor(() => expect(managerCalls.length).toBeGreaterThan(0));

    let pinCommitted = false;
    const pinWrite = withPanelMutationLock(async () => {
      setPanelVersionPin("0.11.3");
      pinCommitted = true;
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(pinCommitted).toBe(false);
    expect(getPanelPinState().pinned).toBe(false);

    // update_all is fire-and-forget by design: the lock covers the pin check +
    // queue + worker start; the Manager-side drain afterwards is outside any
    // process's control, which is exactly why the result must keep saying
    // "queued" and never claim the updates landed.
    releaseManager();
    const result = await update;
    await pinWrite;
    expect(pinCommitted).toBe(true);
    expect(result.message).toMatch(/[Qq]ueued/);
    await expect(updateAllCustomNodes()).rejects.toThrow(PanelPinnedError);
  });

  it('node_snapshot(action:"restore") REFUSES while pinned — the snapshot door', async () => {
    setPanelVersionPin("0.11.3");
    await expect(restoreNodeSnapshot("prod")).rejects.toThrow(PanelPinnedError);
    expect(managerCalls).toEqual([]); // refused before any Manager request
  });
});
