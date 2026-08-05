// Decision-logic tests for the node-pack auto-sync.
//
// Two invariants are what these tests exist to protect:
//   1. A sync that did not move bytes is NEVER reported as a success.
//   2. A user who pinned the panel is NEVER moved off that pin.
// Everything else here is supporting detail.

import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Panel mutations take a FILE lock (panel-pin-guard) — keep it out of
// ~/.comfyui-mcp and off other workers' lock file.
process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-sync-${process.pid}.lock`,
);

// panel-installer pulls config in transitively; stub it so importing doesn't
// trigger real port detection (mirrors panel-installer.test.ts).
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isLocalMode: () => true,
}));

import {
  classifyPinWrite,
  evaluatePanelSync,
  performPanelSync,
  requiredPanelVersion,
  type PanelSyncDecision,
} from "../../services/panel-sync.js";
import {
  PANEL_REGISTRY_ID,
  type PanelInstallerDeps,
  type PanelStatus,
} from "../../services/panel-installer.js";
import type { PanelPinState } from "../../services/panel-settings.js";
import { BRIDGE_CAPABILITY_MIN_PANEL_VERSION } from "../../services/ui-bridge.js";

const REQUIRED = "0.11.35";
const ORCH = "0.48.32";
const UNPINNED: PanelPinState = { pinned: false, source: "none" };

function status(over: Partial<PanelStatus> = {}): PanelStatus {
  return {
    applicable: true,
    installed: true,
    dir: "/fake/comfy/custom_nodes/comfyui-mcp-panel",
    installedVersion: "0.11.28",
    isDevSymlink: false,
    targetVersion: "nightly",
    shadows: [],
    pin: UNPINNED,
    note: "",
    ...over,
  };
}

function decide(over: Partial<PanelStatus>): PanelSyncDecision {
  return evaluatePanelSync(status(over), {
    requiredVersion: REQUIRED,
    orchestratorVersion: ORCH,
  }).decision;
}

describe("requiredPanelVersion", () => {
  it("includes handshake capabilities as well as bridge-command minimums", () => {
    // A capability gate is just as much a version requirement as a command
    // gate: otherwise install_panel can call the panel current while the bridge
    // refuses every active-workflow write (#708).
    expect(BRIDGE_CAPABILITY_MIN_PANEL_VERSION.enforces_workflow_stamp).toBe("0.11.30");
    expect(BRIDGE_CAPABILITY_MIN_PANEL_VERSION.enforces_workflow_stamp_at_write).toBe(REQUIRED);
    expect(requiredPanelVersion()).toBe(REQUIRED);
  });

  it("marks a 0.11.28 panel behind without a caller-supplied requirement (#708)", () => {
    // This is the status/auto-sync path. It must use the same derived floor as
    // the bridge's stamp-enforcement refusal, rather than reporting the old
    // 0.11.28 panel up-to-date.
    const assessment = evaluatePanelSync(status({ installedVersion: "0.11.28" }), {
      orchestratorVersion: ORCH,
    });
    expect(assessment.requiredPanelVersion).toBe(REQUIRED);
    expect(assessment.decision).toBe("sync");
    expect(assessment.behind).toBe(true);
  });
});

describe("classifyPinWrite — writing a pin is not the same as being pinned", () => {
  it("reports 'active' only when the pin we saved is the one in force", () => {
    expect(
      classifyPinWrite({ pinned: true, version: "0.11.20", source: "settings" }, "0.11.20"),
    ).toBe("active");
  });

  it("reports the env override when a DIFFERENT pin wins — still protected, not by ours", () => {
    expect(
      classifyPinWrite({ pinned: true, version: "0.9.9", source: "env" }, "0.11.20"),
    ).toBe("env-overrides-with-pin");
  });

  it("reports 'superseded' when a concurrent write replaced our pin", () => {
    // Ours is not the pin in force, so calling it active would describe a pin
    // that isn't there.
    expect(
      classifyPinWrite({ pinned: true, version: "0.11.21", source: "settings" }, "0.11.20"),
    ).toBe("superseded");
  });

  it("reports 'not-in-force' when COMFYUI_MCP_PANEL_PIN=off leaves nothing pinned", () => {
    // The dangerous case: the write succeeded, so a naive tool would say
    // "pinned" while update/sync remain allowed.
    expect(classifyPinWrite({ pinned: false, source: "none" }, "0.11.20")).toBe(
      "not-in-force",
    );
  });
});

describe("evaluatePanelSync — the four required outcomes", () => {
  it("mismatch + NO pin → sync", () => {
    const a = evaluatePanelSync(status({ installedVersion: "0.11.3" }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("sync");
    expect(a.behind).toBe(true);
    expect(a.requiredPanelVersion).toBe(REQUIRED);
    expect(a.installedVersion).toBe("0.11.3");
  });

  it("mismatch + pin → pinned-warn: warns a newer panel exists, syncs nothing", () => {
    const pin: PanelPinState = { pinned: true, version: "0.11.3", source: "settings" };
    const a = evaluatePanelSync(status({ installedVersion: "0.11.3", pin }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("pinned-warn");
    expect(a.behind).toBe(true);
    // The warning must actually say all three things the owner asked for.
    expect(a.summary).toContain(REQUIRED); // a newer panel matching the orchestrator
    expect(a.summary).toContain("0.11.3"); // what they're on
    expect(a.summary).toMatch(/pinned/i); // that they're pinned
    expect(a.summary).toMatch(/unpin/i); // how to get off it
  });

  it("pin cleared → the same mismatch now decides sync", () => {
    const pinned = status({
      installedVersion: "0.11.3",
      pin: { pinned: true, version: "0.11.3", source: "settings" },
    });
    expect(
      evaluatePanelSync(pinned, { requiredVersion: REQUIRED, orchestratorVersion: ORCH })
        .decision,
    ).toBe("pinned-warn");
    // Same install, pin removed — nothing else changed.
    const cleared = { ...pinned, pin: UNPINNED };
    expect(
      evaluatePanelSync(cleared, { requiredVersion: REQUIRED, orchestratorVersion: ORCH })
        .decision,
    ).toBe("sync");
  });

  it("versions equal → meets-floor (no-op)", () => {
    const a = evaluatePanelSync(status({ installedVersion: REQUIRED }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("meets-floor");
    expect(a.behind).toBe(false);
  });

  it("installed NEWER than required → meets-floor, never a downgrade", () => {
    expect(decide({ installedVersion: "0.12.0" })).toBe("meets-floor");
  });

  // #806 — the whole cluster's headline defect. This branch compares against the
  // orchestrator's MINIMUM and nothing else; the newest published panel is not
  // known here at all. Reporting that as "up-to-date" told a user two versions
  // behind the fix for his own bug that there was nothing to get.
  it("clearing the floor is never reported as being current", () => {
    const a = evaluatePanelSync(status({ installedVersion: "0.11.36" }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("meets-floor");
    // The verdict value itself must not carry the currency claim...
    expect(a.decision).not.toBe("up-to-date");
    // ...and neither may the prose the user actually reads.
    expect(a.summary).not.toMatch(/up-to-date|already current|latest version/i);
    // It names BOTH numbers, says what kind of check it was, and admits its limit.
    expect(a.summary).toContain("0.11.36");
    expect(a.summary).toContain(REQUIRED);
    expect(a.summary).toMatch(/FLOOR check, not a latest-version check/);
    expect(a.summary).toMatch(/most panel fixes ship WITHOUT raising the floor/);
    // And points at where the real latest lives: the pack's pyproject, NOT the
    // repo's GitHub releases (the panel publishes on a pyproject version change).
    expect(a.summary).toContain("pyproject.toml");
    expect(a.summary).not.toMatch(/\/releases/);
  });
});

describe("evaluatePanelSync — a pin is honoured in every shape", () => {
  it("an env pin blocks the sync just like a settings pin", () => {
    const pin: PanelPinState = { pinned: true, version: "0.11.3", source: "env" };
    const a = evaluatePanelSync(status({ installedVersion: "0.11.3", pin }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("pinned-warn");
    // Must tell the user unpin alone won't clear an env pin.
    expect(a.summary).toContain("COMFYUI_MCP_PANEL_PIN");
  });

  it("a pin while already at the floor is simply meets-floor (no nagging)", () => {
    const pin: PanelPinState = { pinned: true, version: REQUIRED, source: "settings" };
    expect(decide({ installedVersion: REQUIRED, pin })).toBe("meets-floor");
  });

  // #806, pinned variant. The honesty is owed here too — but the step that moves
  // a PINNED user is clearing the pin, not install_panel(action='update'), which
  // this state would refuse. Naming the wrong one is the dead-end shape again.
  it("a pinned floor-clearing panel is told the floor is not the latest, and to unpin first", () => {
    const pin: PanelPinState = { pinned: true, version: REQUIRED, source: "settings" };
    const a = evaluatePanelSync(status({ installedVersion: REQUIRED, pin }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.summary).toMatch(/FLOOR check, not a latest-version check/);
    expect(a.summary).toContain("pyproject.toml");
    expect(a.summary).toMatch(/clear the pin/i);
    expect(a.summary).not.toContain("install_panel(action='update')");
  });

  it("a pin blocks even a FRESH install of a missing panel", () => {
    const pin: PanelPinState = { pinned: true, version: "0.11.3", source: "settings" };
    const a = evaluatePanelSync(
      status({ installed: false, installedVersion: undefined, pin }),
      { requiredVersion: REQUIRED, orchestratorVersion: ORCH },
    );
    expect(a.decision).toBe("pinned-warn");
  });

  it("an UNREADABLE pin is treated as pinned, never as unpinned", () => {
    const pin: PanelPinState = { pinned: true, source: "settings", indeterminate: true };
    const a = evaluatePanelSync(status({ installedVersion: "0.11.3", pin }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("blocked");
    expect(a.decision).not.toBe("sync");
  });

  it("a MISSING pin field is treated as pinned, never as unpinned", () => {
    // A status built by a caller that predates the pin field: absence of the
    // field is not evidence of absence of a pin.
    const s = status({ installedVersion: "0.11.3" });
    delete (s as Partial<PanelStatus>).pin;
    const a = evaluatePanelSync(s, { requiredVersion: REQUIRED, orchestratorVersion: ORCH });
    expect(a.decision).toBe("blocked");
  });

  it("a pin still WARNS when the installed version is uncomparable", () => {
    // Must not fall through to `unknown`: that would skip the warning the user
    // is owed and send the agent to try an update the guard will refuse.
    const pin: PanelPinState = { pinned: true, version: "nightly", source: "settings" };
    const a = evaluatePanelSync(status({ installedVersion: "nightly", pin }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("pinned-warn");
    expect(a.summary).toMatch(/pinned/i);
  });
});

describe("evaluatePanelSync — cases where we must not guess", () => {
  it("missing panel + no pin → sync (install it)", () => {
    const a = evaluatePanelSync(status({ installed: false, installedVersion: undefined }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("sync");
    expect(a.behind).toBe(true);
  });

  it.each([
    "nightly",
    "dev",
    "",
    "not-a-version",
    // Strict SemVer 2.0.0: a looser screen accepted these and compareSemver then
    // read them as satisfying 0.11.28.
    "01.11.28",
    "0.11.28+.",
    "0.11.28-",
    "0.11.28.1",
    "0.11.28abc",
  ])(
    "an uncomparable installed version (%j) → unknown, not a silent up-to-date",
    (v) => {
      // compareSemver returns 0 for junk, so an unscreened compare would report
      // "equal" and quietly claim the panel is current. It must not.
      expect(decide({ installedVersion: v })).toBe("unknown");
    },
  );

  it("an unreadable installed version → unknown", () => {
    expect(decide({ installed: true, installedVersion: undefined })).toBe("unknown");
  });

  it("a shadow copy → blocked (the served panel isn't the one on disk)", () => {
    const a = evaluatePanelSync(
      status({
        installedVersion: "0.11.3",
        shadows: [{ name: ".comfyui-agent-panel.bak-0.11.3", version: "0.11.3" }],
      }),
      { requiredVersion: REQUIRED, orchestratorVersion: ORCH },
    );
    expect(a.decision).toBe("blocked");
    expect(a.summary).toContain(".comfyui-agent-panel.bak-0.11.3");
  });

  it("a FAILED shadow scan → blocked, not a clear-to-sync empty array", () => {
    // panelStatus reports `shadows: []` when it could not enumerate custom_nodes.
    // Reading that as "no shadows" would sync onto an install we can't verify.
    const a = evaluatePanelSync(
      status({ installedVersion: "0.11.3", shadows: [], shadowInspectFailed: true }),
      { requiredVersion: REQUIRED, orchestratorVersion: ORCH },
    );
    expect(a.decision).toBe("blocked");
    expect(a.summary).toMatch(/could not enumerate/i);
  });

  it("a dev symlink → dev-install, never touched", () => {
    expect(decide({ isDevSymlink: true, installedVersion: "0.1.0" })).toBe("dev-install");
  });

  it("remote/cloud → not-applicable", () => {
    expect(decide({ applicable: false, installed: false })).toBe("not-applicable");
  });
});

// ---------------------------------------------------------------------------
// performPanelSync — execution guards
// ---------------------------------------------------------------------------

const COMFY = "/fake/comfy";
const CUSTOM_NODES = join(COMFY, "custom_nodes");
const PANEL_DIR = join(CUSTOM_NODES, "comfyui-mcp-panel");

function pyproject(version: string): string {
  return `[project]\nname = "${PANEL_REGISTRY_ID}"\nversion = "${version}"\n`;
}

interface Harness {
  deps: PanelInstallerDeps;
  updates: number;
  installs: number;
}

/**
 * Minimal on-disk simulation: `files` is the live view the installer re-reads
 * after the op, so `onUpdate` is how a test says what actually landed (or that
 * nothing did).
 */
function makeDeps(opts: {
  installedVersion?: string;
  pin?: PanelPinState;
  dirs?: string[];
  /** Mutate the live files map to simulate what the Manager actually did. */
  onUpdate?: (files: Record<string, string>) => void;
  updateDetails?: unknown;
}): Harness {
  const files: Record<string, string> = {};
  if (opts.installedVersion !== undefined) {
    files[join(PANEL_DIR, "pyproject.toml")] = pyproject(opts.installedVersion);
  }
  const dirs = opts.dirs ?? (opts.installedVersion !== undefined ? ["comfyui-mcp-panel"] : []);
  const h: Harness = { updates: 0, installs: 0, deps: undefined as never };

  h.deps = {
    isLocalMode: () => true,
    comfyuiPath: () => COMFY,
    env: () => ({}),
    existsSync: (p) => p === CUSTOM_NODES || p in files,
    probeFile: (p) => p in files,
    isSymlink: () => false,
    isDirectory: () => true,
    realPath: () => undefined,
    readdir: (p) => (p === CUSTOM_NODES ? dirs : []),
    readFile: (p) => files[p] ?? "",
    gitRevision: () => undefined,
    // The sync personas are never git checkouts (gitRevision → undefined), so
    // the #724 fallback is never reached; if it ever is, fail the test loudly.
    gitStatusPorcelain: () => {
      throw new Error("git fallback must not run in this persona (not a git checkout)");
    },
    gitPullFfOnly: () => {
      throw new Error("git fallback must not run in this persona (not a git checkout)");
    },
    readPin: () => opts.pin ?? UNPINNED,
    isReachable: async () => true,
    install: async () => {
      h.installs++;
      opts.onUpdate?.(files);
      return { mechanism: "manager-http", message: "installed", details: opts.updateDetails };
    },
    update: async () => {
      h.updates++;
      opts.onUpdate?.(files);
      return { mechanism: "manager-http", message: "updated", details: opts.updateDetails };
    },
    reinstall: async () => {
      return { mechanism: "manager-http", message: "reinstalled" };
    },
  };
  return h;
}

const RUN = { requiredVersion: REQUIRED, orchestratorVersion: ORCH } as const;

describe("performPanelSync", () => {
  afterEach(() => vi.restoreAllMocks());

  it("syncs a behind, unpinned panel and reports the version RE-READ from disk", async () => {
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: (files) => {
        files[join(PANEL_DIR, "pyproject.toml")] = pyproject(REQUIRED);
      },
    });
    const r = await performPanelSync({ deps: h.deps, ...RUN });
    expect(h.updates).toBe(1);
    expect(r.synced).toBe(true);
    expect(r.previousVersion).toBe("0.11.3");
    // The reported version is the one observed on disk afterwards.
    expect(r.verifiedVersion).toBe(REQUIRED);
    expect(r.restartRequired).toBe(true);
    expect(r.stillBehind).toBe(false);
  });

  it("does NOTHING and does not queue a mutation when the panel is pinned", async () => {
    const h = makeDeps({
      installedVersion: "0.11.3",
      pin: { pinned: true, version: "0.11.3", source: "settings" },
      onUpdate: (files) => {
        // If this ever runs the guard has failed.
        files[join(PANEL_DIR, "pyproject.toml")] = pyproject(REQUIRED);
      },
    });
    const r = await performPanelSync({ deps: h.deps, ...RUN });
    expect(r.synced).toBe(false);
    expect(r.decision).toBe("pinned-warn");
    expect(h.updates).toBe(0);
    expect(h.installs).toBe(0);
    expect(r.verifiedVersion).toBeUndefined();
    expect(r.message).toMatch(/pinned/i);
  });

  it("proceeds once the pin is cleared — same install, same versions", async () => {
    const make = (pin?: PanelPinState) =>
      makeDeps({
        installedVersion: "0.11.3",
        pin,
        onUpdate: (files) => {
          files[join(PANEL_DIR, "pyproject.toml")] = pyproject(REQUIRED);
        },
      });

    const pinned = make({ pinned: true, version: "0.11.3", source: "settings" });
    expect((await performPanelSync({ deps: pinned.deps, ...RUN })).synced).toBe(false);
    expect(pinned.updates).toBe(0);

    const cleared = make(undefined);
    const r = await performPanelSync({ deps: cleared.deps, ...RUN });
    expect(r.synced).toBe(true);
    expect(cleared.updates).toBe(1);
    expect(r.verifiedVersion).toBe(REQUIRED);
  });

  it("no-ops without touching anything when the floor is already met", async () => {
    const h = makeDeps({ installedVersion: REQUIRED });
    const r = await performPanelSync({ deps: h.deps, ...RUN });
    expect(r.synced).toBe(false);
    expect(r.decision).toBe("meets-floor");
    expect(h.updates).toBe(0);
  });

  it("FAILS LOUDLY when the update did not move anything on disk", async () => {
    // The #639 silent no-op: ComfyUI-Manager drains its queue trivially and the
    // pack is untouched. This must be an error, never "synced".
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: () => {
        /* nothing lands */
      },
      updateDetails: { total_count: 0, done_count: 2 },
    });
    await expect(performPanelSync({ deps: h.deps, ...RUN })).rejects.toThrow(
      /did NOT apply|NOT reporting success/i,
    );
    expect(h.updates).toBe(1);
  });

  it("FAILS LOUDLY when the pack disappears after the op", async () => {
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: (files) => {
        delete files[join(PANEL_DIR, "pyproject.toml")];
      },
    });
    await expect(performPanelSync({ deps: h.deps, ...RUN })).rejects.toThrow(
      /Could not verify|NOT reporting/i,
    );
  });

  it("reports stillBehind honestly when the sync landed but did not close the gap", async () => {
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: (files) => {
        files[join(PANEL_DIR, "pyproject.toml")] = pyproject("0.11.10");
      },
    });
    const r = await performPanelSync({ deps: h.deps, ...RUN });
    expect(r.synced).toBe(true);
    expect(r.verifiedVersion).toBe("0.11.10");
    expect(r.stillBehind).toBe(true);
    expect(r.message).toMatch(/still below/i);
  });

  it("leaves stillBehind NULL when the landed version can't be compared", async () => {
    // "nightly" landed: the sync really happened, but whether it meets the
    // requirement is unknown. `undefined` must NOT collapse to false — that
    // would read as "you're fine now" on a version we never checked.
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: (files) => {
        files[join(PANEL_DIR, "pyproject.toml")] = pyproject("nightly");
      },
    });
    const r = await performPanelSync({ deps: h.deps, ...RUN });
    expect(r.synced).toBe(true);
    expect(r.verifiedVersion).toBe("nightly");
    expect(r.stillBehind).toBeNull();
    expect(r.message).toMatch(/could NOT be confirmed/i);
    // `undefined` would be DROPPED by JSON.stringify on the way to the agent,
    // so the unknown state must survive serialization as an explicit null.
    expect(JSON.parse(JSON.stringify(r))).toHaveProperty("stillBehind", null);
  });

  it("serializes concurrent syncs instead of interleaving their before/after reads", async () => {
    // Two overlapping ops would each read the other's half-applied state, and
    // the #639 movement proof compares a pre-image to a post-image.
    let inFlight = 0;
    let maxConcurrent = 0;
    let n = 0;
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: (files) => {
        files[join(PANEL_DIR, "pyproject.toml")] = pyproject(`0.11.${30 + n++}`);
      },
    });
    const deps: PanelInstallerDeps = {
      ...h.deps,
      update: async (o) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        const res = await h.deps.update(o);
        inFlight--;
        return res;
      },
    };
    const results = await Promise.allSettled([
      performPanelSync({ deps, ...RUN }),
      performPanelSync({ deps, ...RUN }),
    ]);
    expect(maxConcurrent).toBe(1);
    // The first moves the pack; the second sees no further movement and fails
    // closed rather than claiming a second successful sync.
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  });

  it("FAILS LOUDLY when the FINAL post-sync shadow scan could not run", async () => {
    // The mutation applied and runPanelAction's own shadow assertion passed, but
    // custom_nodes became unreadable before performPanelSync's confirming scan.
    // `shadows: []` from a scan that never ran is not an all-clear — reporting
    // `synced: true` there is the same fail-open the pre-mutation assessment
    // blocks, one step later.
    //
    // Self-calibrating rather than hardcoding a call index: phase 1 counts the
    // readdir calls a clean sync makes, phase 2 replays it failing only the
    // LAST one (necessarily the confirming scan). Survives refactors that add or
    // remove intermediate reads.
    const scenario = () => ({
      installedVersion: "0.11.3",
      onUpdate: (files: Record<string, string>) => {
        files[join(PANEL_DIR, "pyproject.toml")] = pyproject(REQUIRED);
      },
    });

    let calls = 0;
    const probe = makeDeps(scenario());
    const counting: PanelInstallerDeps = {
      ...probe.deps,
      readdir: (p) => {
        calls++;
        return probe.deps.readdir(p);
      },
    };
    await expect(performPanelSync({ deps: counting, ...RUN })).resolves.toMatchObject({
      synced: true,
    });
    const total = calls;
    expect(total).toBeGreaterThan(1);

    let n = 0;
    const h = makeDeps(scenario());
    const failingLast: PanelInstallerDeps = {
      ...h.deps,
      readdir: (p) => {
        n++;
        if (n >= total) throw new Error("EACCES: permission denied, scandir");
        return h.deps.readdir(p);
      },
    };
    await expect(performPanelSync({ deps: failingLast, ...RUN })).rejects.toThrow(
      /could not be enumerated|NOT reporting a completed sync/i,
    );
  });

  it("refuses to sync a dev symlink", async () => {
    const h = makeDeps({ installedVersion: "0.11.3" });
    const deps: PanelInstallerDeps = { ...h.deps, isSymlink: (p) => p === PANEL_DIR };
    const r = await performPanelSync({ deps, ...RUN });
    expect(r.synced).toBe(false);
    expect(r.decision).toBe("dev-install");
    expect(h.updates).toBe(0);
  });
});
