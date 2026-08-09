// #1086 — the destination is unknowable only until we LOOK.
//
// A remote RunPod ComfyUI read models from /workspace/models (the 100GB volume)
// via extra_model_paths, while / was a 20GB overlay. download_model dispatched to
// ComfyUI-Manager, which wrote into /opt/ComfyUI/models instead. A multi-GB Wan
// 2.2 file and a required clip-vision file were gone after a pod restart.
//
// The standing caveat says we cannot know where a Manager dispatch lands, because
// extra_model_paths.yaml lives on the target filesystem. That is true of the
// CONFIG. It is not true of the OUTCOME — Manager announces the absolute path it
// picked, in both generations:
//
//   glob/manager_server.py:1063   f"Install model '{name}' from '{url}' into '{path}'"
//   legacy/manager_server.py:634  (identical)
//
// which is exactly how the reporter found their file. /internal/logs is readable.

import { describe, expect, it } from "vitest";
import {
  describeManagerDestination,
  parseManagerInstallDestination,
} from "../../services/model-resolver.js";

/** The reporter's own log line, verbatim in shape. */
const LOG = (dest: string, name = "clip_vision_h.safetensors") =>
  `[INFO] Install model '${name}' from 'https://example/x' into '${dest}'`;

describe("parseManagerInstallDestination", () => {
  it("reads the absolute path Manager logged", () => {
    const dest = parseManagerInstallDestination(
      LOG("/opt/ComfyUI/models/clip_vision/clip_vision_h.safetensors"),
      "clip_vision_h.safetensors",
    );
    expect(dest).toBe("/opt/ComfyUI/models/clip_vision/clip_vision_h.safetensors");
  });

  it("takes the LAST line for a name installed more than once", () => {
    const text = [LOG("/opt/ComfyUI/models/a.safetensors", "a.safetensors"),
                  LOG("/workspace/models/a.safetensors", "a.safetensors")].join("\n");
    expect(parseManagerInstallDestination(text, "a.safetensors")).toBe(
      "/workspace/models/a.safetensors",
    );
  });

  it("does not match a DIFFERENT file whose name merely contains ours", () => {
    // `x.safetensors` must not be answered by a line about `x.safetensors.part`.
    const text = LOG("/opt/models/x.safetensors.part", "x.safetensors.part");
    expect(parseManagerInstallDestination(text, "x.safetensors")).toBeUndefined();
  });

  it("returns undefined for a log with no such line", () => {
    expect(parseManagerInstallDestination("[INFO] starting up\n", "x.safetensors")).toBeUndefined();
  });

  it("returns undefined for an empty log or empty filename", () => {
    expect(parseManagerInstallDestination("", "x.safetensors")).toBeUndefined();
    expect(parseManagerInstallDestination(LOG("/a/b.safetensors"), "")).toBeUndefined();
  });
});

describe("describeManagerDestination", () => {
  const readLog = (text: string) => async () => text;

  it("WARNS when the destination is outside the root the server reads", async () => {
    // The reported case, and the one that costs a multi-GB file.
    //
    // extraRoots is INJECTED, and must be: without it this falls through to the
    // live read, which on a developer machine reaches the real ComfyUI and on CI
    // reaches nothing. That difference is exactly what made this pass locally and
    // fail on CI — the same "a test silently queried the real server" trap this
    // suite has hit before. A hermetic test states its own world.
    const note = await describeManagerDestination("clip_vision_h.safetensors", {
      readLog: readLog(LOG("/opt/ComfyUI/models/clip_vision/clip_vision_h.safetensors")),
      liveModelsDir: "/workspace/models",
      extraRoots: async () => [],
    });
    expect(note).toMatch(/OUTSIDE the models directory/);
    expect(note).toContain("/opt/ComfyUI/models");
    expect(note).toContain("/workspace/models");
    expect(note).toMatch(/EPHEMERAL OVERLAY/);
    expect(note).toMatch(/will NOT see it/);
  });

  it("confirms a destination INSIDE the live root", async () => {
    const note = await describeManagerDestination("clip_vision_h.safetensors", {
      readLog: readLog(LOG("/workspace/models/clip_vision/clip_vision_h.safetensors")),
      extraRoots: async () => [],
      liveModelsDir: "/workspace/models",
    });
    expect(note).toMatch(/INSIDE the models directory/);
    expect(note).not.toMatch(/OUTSIDE/);
  });

  it("locates the file WITHOUT claiming usability when the live root is unknown", async () => {
    // Knowing WHERE is not knowing whether the server reads there, and the second
    // half is what decides usability. Say the first without implying the second.
    const note = await describeManagerDestination("clip_vision_h.safetensors", {
      readLog: readLog(LOG("/opt/ComfyUI/models/clip_vision/clip_vision_h.safetensors")),
      extraRoots: async () => [],
      liveModelsDir: undefined,
    });
    expect(note).toContain("/opt/ComfyUI/models");
    expect(note).toMatch(/could not be established/);
    expect(note).not.toMatch(/INSIDE|OUTSIDE/);
  });

  it("says NOTHING when the log carries no destination line", async () => {
    // Silence leaves the standing caveat as the answer, which is already the
    // honest unknown. Inventing a second one would be noise.
    expect(
      await describeManagerDestination("x.safetensors", {
        readLog: readLog("[INFO] nothing relevant"),
        extraRoots: async () => [],
        liveModelsDir: "/workspace/models",
      }),
    ).toBeUndefined();
  });

  it("never throws when the log cannot be read", async () => {
    // This runs AFTER a transfer: a diagnostic that cannot be gathered must not
    // turn a completed dispatch into an error.
    await expect(
      describeManagerDestination("x.safetensors", {
        readLog: async () => {
          throw new Error("logs unavailable");
        },
        extraRoots: async () => [],
        liveModelsDir: "/workspace/models",
      }),
    ).resolves.toBeUndefined();
  });
});

// THE WIRING. The helper cannot see whether download_model appends its answer —
// the call-site blindness this suite keeps getting caught by. Read the source,
// the way the other prose gates in this repo do.
describe("the Manager branch reports the destination (#1086)", () => {
  it("calls describeManagerDestination and appends it to BOTH arms", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../tools/model-management.ts", import.meta.url),
      "utf-8",
    );
    const start = src.indexOf("const managerDest = job.viaManager");
    expect(start, "the destination read must exist").toBeGreaterThan(-1);
    expect(src).toMatch(/describeManagerDestination\(/);

    // Appended OUTSIDE the visible/not-listed ternary, so a LISTED file whose
    // destination is outside the live root still gets the warning — that pairing
    // is exactly the #1086 shape.
    const branch = src.slice(start, start + 2600);
    expect(branch).toContain('(managerDest ? `');
    expect(branch).toContain('${managerDest}');
  });
});

// Codex adversarial review of PR #1190 found three real defects. Each is pinned
// here, because each was a case where the fix said something CONFIDENT and WRONG
// — and for two of them, wrong in the dangerous direction: a false OUTSIDE cries
// wolf about a file that is fine, and contradicts a LISTED verdict in the very
// same message.
describe("review fixes (PR #1190)", () => {
  const readLog = (text: string) => async () => text;
  const LINE = (dest: string, name = "x.safetensors") =>
    `Install model '${name}' from 'https://e/x' into '${dest}'`;

  // DEFECT 2, and a PRE-EXISTING bug it exposed: job.filename is optional, and
  // for a Manager dispatch job.path is a DESCRIPTOR, not a path.
  it("recovers the filename from a Manager job DESCRIPTOR", async () => {
    const { managerJobFilename } = await import("../../services/model-resolver.js");
    expect(
      managerJobFilename({
        path: "checkpoints/foo.safetensors (dispatched to the remote ComfyUI via ComfyUI-Manager — download continues server-side. …)",
      }),
    ).toBe("foo.safetensors");
    // An explicit filename still wins.
    expect(managerJobFilename({ filename: "given.safetensors", path: "a/b (x)" })).toBe(
      "given.safetensors",
    );
  });

  // DEFECT 3: a remote POSIX destination vs a root that node's resolve() turned
  // into "C:\workspace\models" on a Windows orchestrator. Comparing those always
  // says OUTSIDE — for a destination that is exactly right.
  it("refuses to judge INSIDE/OUTSIDE across path syntaxes", async () => {
    const note = await describeManagerDestination("x.safetensors", {
      readLog: readLog(LINE("/workspace/models/x.safetensors")),
      extraRoots: async () => [],
      liveModelsDir: "C:\workspace\models",
    });
    expect(note).toContain("/workspace/models/x.safetensors");
    expect(note).toMatch(/different path syntaxes/);
    // Assert the CLAIM, not the word: the message legitimately contains
    // "INSIDE/OUTSIDE" while declining to make that call.
    expect(note).toMatch(/no INSIDE\/OUTSIDE verdict is claimed/);
    expect(note).not.toMatch(/is OUTSIDE the models directory/);
    expect(note).not.toMatch(/will NOT see it/);
  });

  // DEFECT 5: a server reads more than one tree. A destination under a registered
  // extra root is reachable, and calling it unusable would contradict the LISTED
  // verdict rendered beside it.
  it("does not call a destination unusable when an EXTRA root covers it", async () => {
    const note = await describeManagerDestination("x.safetensors", {
      readLog: readLog(LINE("/opt/ComfyUI/models/x.safetensors")),
      liveModelsDir: "/workspace/models",
      extraRoots: async () => ["/opt/ComfyUI/models"],
    });
    expect(note).toMatch(/INSIDE an extra_model_paths root/);
    expect(note).not.toMatch(/will NOT see it/);
  });

  it("withholds the verdict when the extra roots could NOT be read", async () => {
    // "We could not check" must not render as "there are none" — that is the
    // #796 fold, and here it would produce a false unusable.
    const note = await describeManagerDestination("x.safetensors", {
      readLog: readLog(LINE("/opt/ComfyUI/models/x.safetensors")),
      liveModelsDir: "/workspace/models",
      extraRoots: async () => undefined,
    });
    expect(note).toMatch(/could NOT be checked/);
    expect(note).toMatch(/not being called unusable/);
  });

  it("STILL warns for the reported case — outside, with extra roots known and clear", async () => {
    // The guard rails must not have blunted the actual fix.
    const note = await describeManagerDestination("x.safetensors", {
      readLog: readLog(LINE("/opt/ComfyUI/models/x.safetensors")),
      liveModelsDir: "/workspace/models",
      extraRoots: async () => [],
    });
    expect(note).toMatch(/OUTSIDE the models directory/);
    expect(note).toMatch(/EPHEMERAL OVERLAY/);
  });
});

// A test that reaches the developer's real ComfyUI passes locally and fails on
// CI — which is exactly what happened here: the outside-root case omitted
// `extraRoots`, fell through to the live read, and was green on this machine and
// red on ubuntu. Green-because-it-found-a-server is not green.
//
// Pin it structurally: every call in this file states its own world.
describe("this file never reaches a live server", () => {
  it("injects extraRoots wherever a live models root is given", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL(import.meta.url), "utf-8");
    const calls = src.split("describeManagerDestination(").slice(1);
    const leaky = calls.filter((c) => {
      const body = c.slice(0, c.indexOf("});") + 3);
      return body.includes("liveModelsDir:") && !body.includes("extraRoots:");
    });
    expect(leaky, "every call must stub extraRoots or it hits the network").toEqual([]);
  });
});
