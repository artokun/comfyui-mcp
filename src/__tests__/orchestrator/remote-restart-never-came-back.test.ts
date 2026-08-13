// #742 — a REMOTE-classified ComfyUI that a restart stops and nothing brings back.
//
// `captureRebootHealthBase` is loopback-only, so on the remote path nothing was ever
// probed: the dispatch returned "it is restarting out-of-band … check in a few seconds"
// whether the server was mid-restart or dead for good. The reporter's Pinokio install was
// addressed by its LAN IP, classified remote, stopped, and never relaunched — Pinokio's
// launcher only re-launches on the Manager's dependency-install signal — and the result
// described a restart in progress the whole time.
//
// The base this session already talks to IS probeable, so it is now watched. What it may
// conclude is one-directional and that is the point of these tests: it can report a
// failure to come back; it must never manufacture readiness, because a healthy answer
// proves the ADDRESS responds, not that this instance cycled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import { getComfyUIBaseUrl, isRemoteMode, setComfyuiTarget } from "../../config.js";

/** The reporter's shape: a ComfyUI on this LAN, reached by IP, so classified REMOTE. */
const REMOTE_URL = "http://192.168.1.50:5000";
let originalTarget: string;

const parse = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

/** A ctx whose comfy_reboot is ACCEPTED — the reporter got `rebooting:true` too. */
function ctxReboot(): PanelToolCtx {
  return {
    call: async () => {
      throw new Error("ctx.call must not be used for reboot dispatch");
    },
    confirm: async () => "yes" as const,
    ensureReachable: () => {},
    bridge: {
      send: async () => ({ rebooting: true }),
      tabOrigin: () => undefined,
      tabIsLocal: () => false,
      tabServerOrigin: () => undefined,
      tabSockId: () => "s0",
      canReach: () => false,
    } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as unknown as PanelToolCtx;
}

function reboot() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def.handler;
}

beforeEach(() => {
  originalTarget = getComfyUIBaseUrl();
  // Retarget for real rather than stubbing isRemoteMode: the branch under test keys on
  // BOTH the mode and the configured base, and a stub of one with the other left local
  // would pass while proving nothing about the pairing that actually ships.
  setComfyuiTarget(REMOTE_URL);
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 60,
    intervalMs: 5,
    probeTimeoutMs: 10,
  });
});

afterEach(() => {
  setComfyuiTarget(originalTarget);
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
});

describe("a remote ComfyUI that never comes back is reported, not described as restarting (#742)", () => {
  it("the target is genuinely classified REMOTE — the premise, asserted not assumed", () => {
    expect(isRemoteMode()).toBe(true);
    expect(getComfyUIBaseUrl()).toContain("192.168.1.50");
  });

  it("WENT DOWN AND STAYED DOWN: says so, and names the launcher", async () => {
    // Every probe refuses: the server stopped and nothing relaunched it.
    const bases: Array<string | null> = [];
    __panelToolsTestHooks.setHealthProbe(async (base) => {
      bases.push(base);
      return "down";
    });

    const out = parse(await reboot()({ force: false }, ctxReboot()));

    // It really probed the configured remote base — without this the assertions below
    // could pass on a branch that never looked at anything.
    expect(bases.length).toBeGreaterThan(0);
    expect(bases.every((b) => typeof b === "string" && b.includes("192.168.1.50"))).toBe(true);

    expect(out.saw_down).toBe(true);
    expect(String(out.note)).toMatch(/WENT DOWN/);
    expect(String(out.note)).toMatch(/has NOT come back within/);
    // The recovery the reporter had to work out for themselves.
    expect(String(out.note)).toMatch(/start ComfyUI from its own launcher/i);
    expect(String(out.note)).toMatch(/Pinokio/);
    // The claim that was wrong for them is gone.
    expect(String(out.note)).not.toMatch(/restarting out-of-band/);

    // AND IT MUST NOT OVER-CLAIM IN THE NEW DIRECTION (codex P1). A bounded window
    // cannot establish that a server is permanently gone — a remote host may simply be
    // slower to boot than the budget — so the note names both explanations and the check
    // that separates them, and never tells the reader to stop waiting.
    expect(String(out.note)).toMatch(/does NOT prove it is gone for good/i);
    expect(String(out.note)).toMatch(/can take longer than this to boot/i);
    expect(String(out.note)).toMatch(/get_system_stats/);
    expect(String(out.note)).not.toMatch(/do not wait/i);
    expect(String(out.note)).not.toMatch(/will stay down/i);
    // No prediction about what a supervisor will or won't do after the window closes.
    expect(String(out.note)).not.toMatch(/nothing is going to bring it back/i);
    expect(String(out.note)).not.toMatch(/it was just slow/i);

    // And it still promises nothing about readiness.
    expect(out.ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
  });

  it("CAME BACK: a real down→up is NOT called a death, and is NOT promoted to ready", async () => {
    // The direction that would break every healthy remote restart if `sawDown` alone
    // were treated as failure.
    let n = 0;
    __panelToolsTestHooks.setHealthProbe(async () => (++n <= 2 ? "down" : "healthy"));

    const out = parse(await reboot()({ force: false }, ctxReboot()));

    expect(String(out.note)).not.toMatch(/has NOT come back/);
    // A responding address is not proof this instance cycled, so readiness stays withheld.
    expect(out.ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
  });

  it("ONE TRANSIENT REFUSAL then a responding endpoint: no death is claimed (codex r2)", async () => {
    // `sawDown` LATCHES on a single "down" and never clears. A remote tunnel/NAT can
    // refuse one connection and then answer — a 401/503/timeout all classify "unknown" —
    // and keying the failure note on `sawDown` alone reported a live install as dead.
    // The trigger reads the LAST sample instead, so this window ends "unknown", not "down".
    let n = 0;
    __panelToolsTestHooks.setHealthProbe(async () => (++n === 1 ? "down" : "unknown"));

    const out = parse(await reboot()({ force: false }, ctxReboot()));

    // The latch really did fire — otherwise this test would pass for the wrong reason,
    // proving nothing about the trigger that reads past it.
    expect(out.saw_down).toBe(true);
    expect(String(out.note)).not.toMatch(/WENT DOWN/);
    expect(String(out.note)).not.toMatch(/has NOT come back/);
    expect(out.ready).toBe(false);
  });

  it("NEVER OBSERVED DOWN: no failure is claimed", async () => {
    // Nothing was witnessed going down, so there is nothing to report — asserting a
    // death here would be the same unmeasured-claim defect pointing the other way.
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");

    const out = parse(await reboot()({ force: false }, ctxReboot()));

    expect(out.saw_down).toBe(false);
    expect(String(out.note)).not.toMatch(/has NOT come back/);
    expect(out.ready).toBe(false);
  });
});
