// #796 sweep — "this root has no custom_nodes" was also being said when the
// directory could not be READ.
//
// `hasCustomNodes` was `statSync(...).isDirectory()` inside a bare `try/catch`
// returning `false`. ENOENT is a real answer: nothing is there. EACCES, EPERM,
// EIO and a dead UNC share are not — they mean the question could not be asked.
//
// It mattered because of what the caller does with a `false`. The live root is
// skipped, the resolution falls back to the CONFIGURED path, and the panel
// installer then operates on a different tree — while that caller's own comment
// says the point is to accept only a base it can PROVE holds custom_nodes. A
// base nobody could read is not disproof.
//
// On a Comfy Desktop split install the configured tree is precisely the one the
// server does NOT read (#766), so this fold turns an unreadable directory into a
// confident answer about the wrong tree.
//
// The skip is UNCHANGED — loosening a guard on an unread directory is the wrong
// direction. What changed is that the reason is now carried out instead of
// vanishing, in the same idiom this file already uses for `liveProbeFailed` vs
// `liveRootUnderivable` (#916).

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  argv: undefined as string[] | undefined,
  reachable: true,
  configured: undefined as string | undefined,
  statError: undefined as NodeJS.ErrnoException | undefined,
}));

// #1290 — this file reaches `resolveLiveServerRoot`, whose second tier shells
// out (netstat/WMI) to find the python actually serving the port ON THIS
// MACHINE. Unstubbed, the assertions below would depend on whether the
// developer happens to have ComfyUI running (#1263). Stub it at the boundary.
vi.mock("../../services/live-interpreter.js", async () => ({
  ...(await vi.importActual("../../services/live-interpreter.js")),
  resolveLiveInterpreter: () => undefined,
  observeLiveServerProcess: () => undefined,
}));

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isLocalMode: () => true };
});

vi.mock("../../services/workspace-env.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/workspace-env.js")>(
    "../../services/workspace-env.js",
  );
  return {
    ...actual,
    resolveEffectiveComfyUIBase: () => hoisted.configured,
    getLiveServerSnapshot: async () => ({
      reachable: hoisted.reachable,
      argv: hoisted.argv,
      cwd: undefined,
    }),
    liveRootFromArgv: (argv: string[] | undefined) => (argv ? argv[0] : undefined),
    // #1133 — `resolvePanelBase` derives the install root through the CANONICAL
    // resolver now, not by re-parsing argv, so that is the seam this file has to
    // stub. Left on `liveRootFromArgv` alone it would silently stop producing a
    // live candidate at all, and every assertion below would pass vacuously
    // against a resolution that never had one to disqualify.
    resolveLiveServerRoot: (argv: string[] | undefined) =>
      argv ? { root: argv[0], source: "argv" as const } : { source: "unresolved" as const },
  };
});

// The real statSync, except that a chosen path raises a chosen errno — the
// permission/IO failure this is about, which cannot be produced portably on a
// developer machine or on CI.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    statSync: (p: string, ...rest: unknown[]) => {
      if (hoisted.statError && String(p).includes("unreadable")) throw hoisted.statError;
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

const { resolvePanelBase, __resetPanelBaseCache } = await import(
  "../../services/panel-workspace.js"
);

let root: string;

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cnstate-"));
  hoisted.argv = undefined;
  hoisted.reachable = true;
  hoisted.configured = undefined;
  hoisted.statError = undefined;
  __resetPanelBaseCache();
});

afterEach(() => {
  __resetPanelBaseCache();
  rmSync(root, { recursive: true, force: true });
});

describe("an UNREADABLE custom_nodes is not an absent one (#796)", () => {
  it("records the live root it could not read, instead of silently falling back", async () => {
    const live = join(root, "unreadable-live");
    mkdirSync(join(live, "custom_nodes"), { recursive: true });
    const configured = join(root, "configured");
    mkdirSync(join(configured, "custom_nodes"), { recursive: true });

    hoisted.argv = [live];
    hoisted.configured = configured;
    hoisted.statError = errno("EACCES");

    const res = await resolvePanelBase();

    expect(res.source, "the guard still refuses an unproven live root").toBe("configured");
    expect(res.liveRootUnreadable, "but the reason is carried out").toBe(live);
  });

  it.each(["EPERM", "EIO", "EBUSY"])("treats %s as unreadable too", async (code) => {
    const live = join(root, "unreadable-live");
    mkdirSync(join(live, "custom_nodes"), { recursive: true });
    hoisted.argv = [live];
    hoisted.statError = errno(code);

    expect((await resolvePanelBase()).liveRootUnreadable).toBe(live);
  });

  it("a genuinely ABSENT custom_nodes stays absent, with nothing recorded", async () => {
    // The other direction, and the one that must not regress: ENOENT is a real
    // answer, so it is a disqualification rather than an unanswered question.
    const live = join(root, "no-custom-nodes");
    mkdirSync(live, { recursive: true });
    hoisted.argv = [live];

    const res = await resolvePanelBase();

    expect(res.source).toBe("none");
    expect(res.liveRootUnreadable, "ENOENT is not an unknown").toBeUndefined();
  });

  it("a root that DOES hold custom_nodes is still accepted", async () => {
    // The guard must keep working; this is the ordinary case.
    const live = join(root, "good-live");
    mkdirSync(join(live, "custom_nodes"), { recursive: true });
    hoisted.argv = [live];

    const res = await resolvePanelBase();

    expect(res.base).toBe(live);
    expect(res.source).toBe("live-argv-root");
    expect(res.liveRootUnreadable).toBeUndefined();
  });

  it("a FILE named custom_nodes is absent, not unreadable", async () => {
    // isDirectory() false — the stat succeeded, so the question was answered.
    const live = join(root, "file-not-dir");
    mkdirSync(live, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(live, "custom_nodes"), "not a directory");
    hoisted.argv = [live];

    const res = await resolvePanelBase();

    expect(res.source).toBe("none");
    expect(res.liveRootUnreadable).toBeUndefined();
  });
});

// THE REMEDY. Recording the state is only half of it: without this, the new
// field is plumbing nothing reads — and the uncorroborated message would keep
// offering one of two remedies that cannot apply. The argv was fine (so
// relaunching with an absolute main.py changes nothing) and ComfyUI is reachable
// (so "start/reach ComfyUI" is already true).
describe("the uncorroborated message names the RIGHT remedy (#796)", () => {
  it("has a distinct branch for an unreadable root, before the underivable one", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../services/panel-installer.ts", import.meta.url),
      "utf-8",
    );

    const at = src.indexOf("baseResolution?.liveRootUnreadable");
    expect(at, "the unreadable case must be handled").toBeGreaterThan(-1);

    // ORDER MATTERS: underivable is the fallback of the two, so unreadable has to
    // be tested first or it can never be reached.
    const underivableAt = src.indexOf("baseResolution?.liveRootUnderivable");
    expect(at, "unreadable must be checked before underivable").toBeLessThan(underivableAt);

    const branch = src.slice(at, underivableAt);
    expect(branch, "it must name the path that could not be read").toContain(
      "baseResolution.liveRootUnreadable",
    );
    expect(branch, "and say what to do about it").toMatch(/readable/);
    // The remedies that do NOT apply here must not appear in this branch.
    expect(branch).not.toMatch(/ABSOLUTE path to main\.py/);
    expect(branch).not.toMatch(/Start\/reach/);
  });
});
