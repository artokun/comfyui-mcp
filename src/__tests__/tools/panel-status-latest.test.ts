// #1983 — `install_comfyui(action:"panel", panel_action:"status")` must answer
// BOTH questions: the FLOOR one ("is this panel too old for this orchestrator to
// work with?") and the LATEST one ("is a newer panel published?"). They are
// different questions and they get different fields.
//
// #1971 shipped `getLatestPublishedPanelVersion`, but only the periodic
// background loop called it. The tool an operator actually invokes stayed
// floor-only, so a panel sixteen releases behind reported `behind:false`.
//
// The first test here is the REACHABILITY test and it is the load-bearing one:
// it drives the real `panelAction("status")` with nothing injected and asserts
// the published-pyproject URL was really requested. Deleting the call site in
// `src/tools/install-panel.ts` fails it. A test that injected a fake probe would
// still pass with that call site deleted — which is exactly how the original
// defect hid.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelStatus } from "../../services/panel-installer.js";

const mocks = vi.hoisted(() => ({
  panelStatus: vi.fn(),
  repairInterruptedPanelSwap: vi.fn(),
}));

// Minimal panel-installer stand-in: the real module is 6k lines of filesystem
// and Manager traffic, none of which is under test here. Every export listed is
// one that `panel-sync`, `panel-auto-update` or `install-panel` imports at
// module scope, so the real graph still loads.
vi.mock("../../services/panel-installer.js", () => ({
  PANEL_REGISTRY_ID: "comfyui-agent-panel",
  panelStatus: (...a: unknown[]) => mocks.panelStatus(...a),
  repairInterruptedPanelSwap: (...a: unknown[]) => mocks.repairInterruptedPanelSwap(...a),
  runPanelAction: vi.fn(),
  runPanelActionInner: vi.fn(),
  withPanelOpLock: async (fn: () => unknown) => fn(),
  assertPinnedTarget: vi.fn(),
  pinPanelBase: vi.fn(async (d: unknown) => d),
  isPanelAutoInstallDisabled: () => false,
  defaultDeps: {},
}));

import { PANEL_PYPROJECT_RAW_URL } from "../../services/panel-auto-update.js";
import { requiredPanelVersion } from "../../services/panel-sync.js";
import { compareSemver } from "../../services/self-update.js";
import { panelAction } from "../../tools/install-panel.js";

/** The machine state in the issue: 0.15.16 on disk against a 0.15.11 floor. */
const INSTALLED = "0.15.16";
const LATEST = "0.15.32";

function status(over: Partial<PanelStatus> = {}): PanelStatus {
  return {
    applicable: true,
    installed: true,
    dir: "/comfy/custom_nodes/comfyui-agent-panel",
    installedVersion: INSTALLED,
    isDevSymlink: false,
    targetVersion: "nightly",
    shadows: [],
    scanReliable: true,
    absenceProven: true,
    pin: { pinned: false },
    ...over,
  } as PanelStatus;
}

function pyproject(version: string): string {
  return `[project]\nname = "comfyui-agent-panel"\nversion = "${version}"\n`;
}

interface StatusSync {
  decision: string;
  behind: boolean;
  requiredPanelVersion: string;
  installedVersion?: string;
  latestPublishedVersion?: string;
  behindLatest?: boolean | null;
  summary: string;
}

async function statusCall(): Promise<StatusSync> {
  const result = (await panelAction("status", undefined, undefined)) as {
    content: Array<{ text?: string }>;
  };
  return (JSON.parse(result.content[0]?.text ?? "{}") as { sync: StatusSync }).sync;
}

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function stubFetch(reply: () => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return reply();
    }),
  );
}

beforeEach(() => {
  fetchCalls = [];
  mocks.panelStatus.mockReset();
  mocks.repairInterruptedPanelSwap.mockReset();
  mocks.repairInterruptedPanelSwap.mockResolvedValue("");
  // The fixtures below are about versions, not pins; an inherited pin from the
  // host machine's settings would silently re-route every case.
  process.env.COMFYUI_MCP_PANEL_PIN = "off";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.COMFYUI_MCP_PANEL_PIN;
});

describe("#1983 — the status tool REACHES the latest-version probe", () => {
  it("requests the published pyproject with nothing injected (this is the call-site test)", async () => {
    mocks.panelStatus.mockResolvedValue(status());
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    await panelAction("status", undefined, undefined);

    expect(fetchCalls.map((c) => c.url)).toContain(PANEL_PYPROJECT_RAW_URL);
  });

  it("bounds the probe with an abort signal — a status call cannot hang on a dead registry", async () => {
    mocks.panelStatus.mockResolvedValue(status());
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    await panelAction("status", undefined, undefined);

    const probe = fetchCalls.find((c) => c.url === PANEL_PYPROJECT_RAW_URL);
    expect(probe?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("#1983 — floor and latest are two answers, never one", () => {
  it("the fixture is still above the floor (input precondition, not an expectation)", () => {
    // If the derived floor ever rises past 0.15.16 these fixtures stop testing
    // the reported state. Fail here with a clear reason rather than three tests
    // failing obscurely.
    expect(compareSemver(INSTALLED, requiredPanelVersion())).toBeGreaterThanOrEqual(0);
  });

  it("16 versions behind latest, above the floor → behind:false AND behindLatest:true with the pair", async () => {
    mocks.panelStatus.mockResolvedValue(status());
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    // The floor answer is UNCHANGED — 0.15.16 is not too old to work.
    expect(sync.behind).toBe(false);
    expect(sync.decision).toBe("meets-floor");
    // The latest answer is the one that was missing.
    expect(sync.behindLatest).toBe(true);
    expect(sync.latestPublishedVersion).toBe(LATEST);
    expect(sync.installedVersion).toBe(INSTALLED);
    expect(sync.summary).toContain(INSTALLED);
    expect(sync.summary).toContain(LATEST);
  });

  it("staleness stays ADVISORY — the decision does not become a refusal", async () => {
    mocks.panelStatus.mockResolvedValue(status());
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    // A newer panel existing must not turn a supported install into "blocked",
    // and must not fabricate a floor miss.
    expect(sync.decision).not.toBe("blocked");
    expect(sync.decision).not.toBe("sync");
    expect(sync.behind).toBe(false);
  });

  it("on the newest published panel → behindLatest:false, an observation actually made", async () => {
    mocks.panelStatus.mockResolvedValue(status({ installedVersion: LATEST }));
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    expect(sync.behindLatest).toBe(false);
    expect(sync.latestPublishedVersion).toBe(LATEST);
  });

  it("BELOW the floor keeps its own verdict AND reports the latest gap", async () => {
    mocks.panelStatus.mockResolvedValue(status({ installedVersion: "0.0.1" }));
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    expect(sync.behind).toBe(true); // below the floor → unsupported
    expect(sync.decision).toBe("sync");
    expect(sync.behindLatest).toBe(true); // and also stale
  });

  it("a dev symlink behind latest is reported too — the issue reproduced on THIS branch", async () => {
    mocks.panelStatus.mockResolvedValue(status({ isDevSymlink: true }));
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    expect(sync.decision).toBe("dev-install");
    expect(sync.behindLatest).toBe(true);
    expect(sync.latestPublishedVersion).toBe(LATEST);
    // A dev symlink is never touched by the update action, so the advisory must
    // not send the reader at a tool that will refuse them.
    expect(sync.summary).toMatch(/git checkout/);
    expect(sync.summary).not.toMatch(/To pull it, run/);
  });

  it("a PINNED stale panel is told to clear the pin, not to run an update that would refuse", async () => {
    mocks.panelStatus.mockResolvedValue(
      status({ pin: { pinned: true, source: "settings", version: INSTALLED } }),
    );
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    expect(sync.behindLatest).toBe(true);
    expect(sync.behind).toBe(false);
    expect(sync.decision).toBe("meets-floor");
    expect(sync.summary).toMatch(/clearing the pin|clear the pin/i);
  });

  it("an uncomparable installed version cannot be compared to latest either → null", async () => {
    mocks.panelStatus.mockResolvedValue(status({ installedVersion: "nightly" }));
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    expect(sync.behindLatest).toBeNull();
    expect(sync.latestPublishedVersion).toBe(LATEST);
  });
});

describe("#1983 — an untrusted install cannot be laundered into a confident answer", () => {
  it("an UNTRUSTED install (a shadow copy) refuses the latest claim rather than laundering it", async () => {
    mocks.panelStatus.mockResolvedValue(
      status({ shadows: [{ name: ".comfyui-agent-panel.bak-1", dir: "/x" }] } as Partial<PanelStatus>),
    );
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    // The served panel may not be the one on disk, so `installedVersion` is not
    // a number this reply is entitled to compare against anything.
    expect(sync.decision).toBe("blocked");
    expect(sync.behindLatest).toBeNull();
    expect(sync.summary).toMatch(/UNKNOWN/);
  });

  it("a PROVEN absent pack is behind anything published", async () => {
    mocks.panelStatus.mockResolvedValue(
      status({ installed: false, installedVersion: undefined, absenceProven: true }),
    );
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    expect(sync.behindLatest).toBe(true);
    expect(sync.latestPublishedVersion).toBe(LATEST);
  });

  it("an UNPROVEN absence is not claimed as behind latest — a panel may be sitting in another tree", async () => {
    mocks.panelStatus.mockResolvedValue(
      status({ installed: false, installedVersion: undefined, absenceProven: false }),
    );
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    expect(sync.decision).toBe("blocked");
    expect(sync.behindLatest).toBeNull();
    expect(sync.behindLatest).not.toBe(true);
  });

  it("an unreliable custom_nodes scan does not become a confident staleness claim", async () => {
    mocks.panelStatus.mockResolvedValue(status({ scanReliable: false }));
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    expect((await statusCall()).behindLatest).toBeNull();
  });

  it("a MISSING pin field is treated as pinned by the advisory too, not sent at an update", async () => {
    // evaluatePanelSync reads an absent pin as indeterminate-PINNED; an advisory
    // that read it as unpinned would name an update the pin guard will refuse.
    mocks.panelStatus.mockResolvedValue(status({ pin: undefined } as Partial<PanelStatus>));
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    expect(sync.decision).toBe("blocked");
    expect(sync.summary).not.toMatch(/To pull it, run/);
  });
});

describe("#1983 — a failed probe degrades to the floor verdict, never to 'you are fine'", () => {
  it("network error → behindLatest is null (NOT false) and the reply says the latest is unknown", async () => {
    mocks.panelStatus.mockResolvedValue(status());
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));

    const sync = await statusCall();

    expect(sync.behindLatest).toBeNull();
    expect(sync.behindLatest).not.toBe(false);
    expect(sync.latestPublishedVersion).toBeUndefined();
    expect(sync.decision).toBe("meets-floor"); // the floor answer still stands
    expect(sync.behind).toBe(false);
    expect(sync.summary).toMatch(/could not be determined/i);
    expect(sync.summary).toMatch(/NOT evidence/i);
  });

  it("an aborted (slow) probe degrades identically and never throws", async () => {
    mocks.panelStatus.mockResolvedValue(status());
    stubFetch(() =>
      Promise.reject(
        Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        }),
      ),
    );

    const sync = await statusCall();

    expect(sync.behindLatest).toBeNull();
    expect(sync.decision).toBe("meets-floor");
  });

  it("HTTP 500 → null, not false", async () => {
    mocks.panelStatus.mockResolvedValue(status());
    stubFetch(() => new Response("nope", { status: 500 }));

    expect((await statusCall()).behindLatest).toBeNull();
  });

  it("a WRONG-pack pyproject is refused as 'latest' rather than believed", async () => {
    mocks.panelStatus.mockResolvedValue(status());
    stubFetch(
      () => new Response(`[project]\nname = "not-the-panel"\nversion = "99.0.0"\n`, { status: 200 }),
    );

    const sync = await statusCall();

    expect(sync.behindLatest).toBeNull();
    expect(sync.latestPublishedVersion).toBeUndefined();
  });
});

describe("#1983 — the probe is not made where it could not mean anything", () => {
  it("remote / no local ComfyUI → no network call at all", async () => {
    mocks.panelStatus.mockResolvedValue(status({ applicable: false, installed: false }));
    stubFetch(() => new Response(pyproject(LATEST), { status: 200 }));

    const sync = await statusCall();

    expect(fetchCalls).toEqual([]);
    expect(sync.decision).toBe("not-applicable");
    expect(sync.behindLatest).toBeNull();
  });
});
