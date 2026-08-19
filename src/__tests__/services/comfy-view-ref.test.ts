// #648 — an oversized local file is not a dead end when ComfyUI already serves
// the directory it lives in.
//
// The load-bearing distinction here is between "this file is in the wrong place"
// and "we could not find out where the right places are". Collapsing the second
// into the first tells a caller to move a file that may already be exactly where
// it needs to be, so the tests below assert the REASON, not just the outcome.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const state = vi.hoisted(() => ({
  outputDir: "" as string,
  inputDir: "" as string,
  outputError: null as string | null,
  inputError: null as string | null,
  /** A raw value (not necessarily an Error) the resolvers should reject with. */
  rejectWith: null as { value: unknown } | null,
  remote: false,
  cloud: false,
  outputCalls: 0,
  inputCalls: 0,
  /** absolute path -> errno code that realpath should fail with. */
  realpathFail: new Map<string, string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: (async (p: string, ...rest: unknown[]) => {
      const code = state.realpathFail.get(String(p));
      if (code) {
        const err = new Error(`${code}: injected realpath failure`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
      return (actual.realpath as (...a: unknown[]) => unknown)(p, ...rest);
    }) as unknown as typeof actual.realpath,
  };
});

vi.mock("../../services/output-dir.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/output-dir.js")>();
  return {
    ...actual,
    resolveOutputDir: async () => {
      state.outputCalls += 1;
      if (state.rejectWith) throw state.rejectWith.value;
      if (state.outputError) throw new Error(state.outputError);
      return state.outputDir;
    },
    resolveInputDir: async () => {
      state.inputCalls += 1;
      if (state.rejectWith) throw state.rejectWith.value;
      if (state.inputError) throw new Error(state.inputError);
      return state.inputDir;
    },
  };
});

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    isRemoteMode: () => state.remote,
    isCloudMode: () => state.cloud,
  };
});

const {
  resolveServableViewRef,
  oversizedInlineRefusal,
  forwardedByReferenceNote,
  unverifiedViewRefNote,
  stageFileIntoServedDir,
  stagedForDisplayNote,
} = await import("../../services/comfy-view-ref.js");

let root: string;
let outDir: string;
let inDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-viewref-"));
  outDir = join(root, "ComfyUI", "output");
  inDir = join(root, "ComfyUI", "input");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(inDir, { recursive: true });
  state.outputDir = outDir;
  state.inputDir = inDir;
  state.outputError = null;
  state.inputError = null;
  state.remote = false;
  state.cloud = false;
  state.outputCalls = 0;
  state.inputCalls = 0;
  state.rejectWith = null;
  state.realpathFail.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function touch(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  return path;
}

describe("resolveServableViewRef — servable", () => {
  it("derives a top-level ref with NO subfolder key", async () => {
    const file = touch(join(outDir, "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("servable");
    if (res.status !== "servable") return;
    expect(res.ref).toEqual({ filename: "clip.mp4", type: "output" });
    // An empty subfolder must be ABSENT, not "" — the panel forwards this object
    // straight into a /view query string.
    expect("subfolder" in res.ref).toBe(false);
    expect(res.root.kind).toBe("output");
  });

  it("derives a nested subfolder with forward slashes", async () => {
    const file = touch(join(outDir, "video", "takes", "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("servable");
    if (res.status !== "servable") return;
    expect(res.ref).toEqual({
      filename: "clip.mp4",
      subfolder: "video/takes",
      type: "output",
    });
    // Never a backslash, whatever the host separator is.
    expect(res.ref.subfolder).not.toContain("\\");
  });

  it("recognises the INPUT directory and types the ref accordingly", async () => {
    const file = touch(join(inDir, "refs", "plate.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("servable");
    if (res.status !== "servable") return;
    expect(res.ref.type).toBe("input");
    expect(res.ref.subfolder).toBe("refs");
  });

  it("stays servable when the OTHER directory cannot be resolved", async () => {
    // Independence: the input dir failing must not discard a proven output hit.
    state.inputError = "COMFYUI_PATH is not configured";
    const file = touch(join(outDir, "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("servable");
  });
});

describe("resolveServableViewRef — outside", () => {
  it("refuses a file in a sibling directory and names both roots checked", async () => {
    const file = touch(join(root, "elsewhere", "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("outside");
    if (res.status !== "outside") return;
    expect(res.checked.map((c) => c.kind).sort()).toEqual(["input", "output"]);
    expect(res.checked.find((c) => c.kind === "output")?.dir).toBe(resolve(outDir));
  });

  it("does not treat a PREFIX-sharing sibling as inside the root", async () => {
    // "<...>/output-old/clip.mp4" starts with the output dir's string but is a
    // different directory. A prefix test without the separator would mint a ref
    // whose subfolder ("-old") resolves to nothing.
    const file = touch(join(root, "ComfyUI", "output-old", "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("outside");
  });
});

describe("resolveServableViewRef — unknown is not 'outside'", () => {
  it("reports UNKNOWN when neither directory resolves", async () => {
    state.outputError = "COMFYUI_PATH is not configured";
    state.inputError = "COMFYUI_PATH is not configured";
    const res = await resolveServableViewRef(join(root, "elsewhere", "clip.mp4"));
    expect(res.status).toBe("unknown");
    if (res.status !== "unknown") return;
    expect(res.reason).toContain("COMFYUI_PATH is not configured");
  });

  it("reports UNKNOWN — never 'outside' — when one directory is unresolved and the other did not match", async () => {
    // The whole point of the three-way answer: the file could be sitting in the
    // directory that failed to resolve. Calling this "outside" would send the
    // caller to move a file that may already be in the right place.
    state.inputError = "the server did not answer /system_stats";
    const res = await resolveServableViewRef(join(root, "elsewhere", "clip.mp4"));
    expect(res.status).toBe("unknown");
    if (res.status !== "unknown") return;
    expect(res.reason).toContain("undetermined");
    expect(res.reason).toContain("the server did not answer /system_stats");
  });

  it("treats an empty resolved directory as unresolved, not as a root", async () => {
    // "" would make every absolute path look contained.
    state.outputDir = "";
    state.inputDir = "";
    const res = await resolveServableViewRef(join(root, "elsewhere", "clip.mp4"));
    expect(res.status).toBe("unknown");
  });
});

describe("resolveServableViewRef — a failed canonicalisation is a doubt, not a verdict", () => {
  it("reports UNKNOWN when the FILE's real location could not be resolved", async () => {
    // A link this process cannot follow may point straight into a served
    // directory, so a lexical miss is not evidence the file is elsewhere.
    const target = touch(join(root, "elsewhere", "clip.mp4"));
    state.realpathFail.set(resolve(target), "ELOOP");
    const res = await resolveServableViewRef(target);
    expect(res.status).toBe("unknown");
    if (res.status !== "unknown") return;
    expect(res.reason).toContain("real location could not be resolved");
  });

  // The two cases above both use a file lexically OUTSIDE every root, so they
  // exercise only the matched-NOTHING path — where the doubt was already being
  // consulted. They passed identically while a lexical fallback that landed
  // UNDER a root still returned `servable` without ever looking at the doubt
  // (independent gate P0). These two put the lexical path INSIDE the candidate
  // root, which is the only shape that reaches the match.

  it("does NOT claim servable when the FILE's realpath failed but its lexical path is UNDER a root", async () => {
    const target = touch(join(outDir, "takes", "clip.mp4"));
    state.realpathFail.set(resolve(target), "ELOOP");
    const res = await resolveServableViewRef(target);
    // A /view reference derived from an unverified path is a 404, or a different
    // file, presented to the caller as servable.
    expect(res.status).toBe("unknown");
    if (res.status !== "unknown") return;
    expect(res.reason).toContain("unverified path");
    expect(res.reason).toContain("real location could not be resolved");
  });

  it("does NOT claim servable when the matching ROOT could not be canonicalised", async () => {
    const target = touch(join(outDir, "takes", "clip2.mp4"));
    state.realpathFail.set(resolve(outDir), "EACCES");
    const res = await resolveServableViewRef(target);
    expect(res.status).toBe("unknown");
    if (res.status !== "unknown") return;
    expect(res.reason).toContain("unverified path");
    expect(res.reason).toContain("could not be canonicalised");
  });

  it("does NOT claim servable when the matching ROOT is ENOENT — absence only settles the NON-match", async () => {
    // The ENOENT carve-out is sound in the negative direction: a directory that
    // does not exist cannot contain the file. It is not sound here, past a
    // containment test that passed against the root's lexical fallback — a
    // concurrent agent renaming the directory between our stat and our realpath
    // would otherwise yield a /view ref for a root that is no longer there.
    const target = touch(join(outDir, "takes", "gone.mp4"));
    state.realpathFail.set(resolve(outDir), "ENOENT");
    const res = await resolveServableViewRef(target);
    expect(res.status).toBe("unknown");
  });

  it("STILL serves a file under a root when an UNRELATED root failed — the doubt is tied to the matching pair", async () => {
    // Discrimination in the other direction: a failure canonicalising a root the
    // file is not under says nothing about the one that matched, and refusing on
    // it would be the same fold pointed the other way — an over-strict check
    // refusing something real. The target is under `inDir` and the FAILING root
    // is `outDir`, which is visited FIRST: an earlier draft had these swapped, so
    // the resolver matched and returned before ever touching the failing root and
    // the test proved nothing. This ordering is what makes it fail against a
    // whole-`inconclusive` check at the match point.
    const target = touch(join(inDir, "clip3.mp4"));
    state.realpathFail.set(resolve(outDir), "EACCES");
    const res = await resolveServableViewRef(target);
    expect(res.status).toBe("servable");
  });

  it("reports UNKNOWN when a ROOT could not be canonicalised for a reason other than absence", async () => {
    state.realpathFail.set(resolve(outDir), "EACCES");
    const res = await resolveServableViewRef(touch(join(root, "elsewhere", "b.mp4")));
    expect(res.status).toBe("unknown");
    if (res.status !== "unknown") return;
    expect(res.reason).toContain("could not be canonicalised");
  });

  it("still reports OUTSIDE when a root merely does not exist", async () => {
    // ENOENT carries no uncertainty: a directory that is not there cannot hold
    // the file, so this must NOT be softened into "unknown".
    state.inputDir = join(root, "ComfyUI", "never-created");
    const res = await resolveServableViewRef(touch(join(root, "elsewhere", "c.mp4")));
    expect(res.status).toBe("outside");
  });
});

describe("resolveServableViewRef — never throws", () => {
  it("returns UNKNOWN when a resolver rejects with a value that cannot be stringified", async () => {
    // Object.create(null) has no toString; an unguarded String(err) inside the
    // catch would reject this function instead of reporting the failure — the
    // agent would get an opaque transport error with no remedy in it.
    state.rejectWith = { value: Object.create(null) as never };
    const res = await resolveServableViewRef(join(root, "elsewhere", "d.mp4"));
    expect(res.status).toBe("unknown");
    if (res.status !== "unknown") return;
    expect(res.reason).toContain("could not be described");
  });

  it("returns UNKNOWN when an Error's message getter throws", async () => {
    const nasty = new Error("x");
    Object.defineProperty(nasty, "message", {
      get() {
        throw new Error("the message getter itself failed");
      },
    });
    state.rejectWith = { value: nasty };
    const res = await resolveServableViewRef(join(root, "elsewhere", "e.mp4"));
    expect(res.status).toBe("unknown");
  });
});

describe("resolveServableViewRef — remote", () => {
  it("answers REMOTE without resolving any directory", async () => {
    state.remote = true;
    const file = touch(join(outDir, "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("remote");
    // Load-bearing: a remote session can still have COMFYUI_PATH set, so the
    // roots would resolve to LOCAL-looking paths and this very file would be
    // called servable — against a server that cannot open it. The check has to
    // happen before any root is consulted.
    expect(state.outputCalls).toBe(0);
    expect(state.inputCalls).toBe(0);
  });

  it("answers REMOTE for cloud mode too", async () => {
    state.cloud = true;
    const res = await resolveServableViewRef(touch(join(outDir, "clip.mp4")));
    expect(res.status).toBe("remote");
    if (res.status !== "remote") return;
    expect(res.reason).toContain("Cloud");
  });
});

describe("oversizedInlineRefusal — every branch ends in something the caller can do", () => {
  const base = {
    path: "/refs/clip.mp4",
    sizeBytes: 72 * 1024 * 1024,
    capBytes: 20 * 1024 * 1024,
    kind: "video" as const,
  };

  it("states the size, the cap, and why the cap exists", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "outside", checked: [{ kind: "output", dir: "/c/output" }] },
    });
    expect(msg).toContain("72.0 MB");
    expect(msg).toContain("20.0 MB");
    expect(msg).toContain("base64");
  });

  it("names the ACTUAL directories to move the file into", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: {
        status: "outside",
        checked: [
          { kind: "output", dir: "/c/output" },
          { kind: "input", dir: "/c/input" },
        ],
      },
    });
    // A remedy the caller can act on names the destination, not just the rule.
    expect(msg).toContain("/c/output");
    expect(msg).toContain("/c/input");
    expect(msg).toMatch(/Copy or move it/);
    expect(msg).toContain("panel_show_media");
  });

  it("tells a VIDEO caller it still will not be sent the video", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "outside", checked: [{ kind: "output", dir: "/c/output" }] },
    });
    expect(msg).toContain("SAMPLED");
    expect(msg).not.toContain("get_image with its filename");
  });

  it("points an IMAGE caller at get_image, which a storyboard cannot serve", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      kind: "image",
      resolution: { status: "outside", checked: [{ kind: "output", dir: "/c/output" }] },
    });
    expect(msg).toContain("get_image");
    expect(msg).not.toContain("SAMPLED");
  });

  it("does NOT blame the file's location when the answer was unknown", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "unknown", reason: "the output directory could not be resolved (no COMFYUI_PATH)" },
    });
    expect(msg).toContain("could NOT be determined");
    expect(msg).toContain("not the same as knowing the file is in the wrong place");
    // The false claim this branch exists to avoid.
    expect(msg).not.toContain("This file is not under any directory");
    // Still actionable: the remedy addresses the thing that is actually broken.
    expect(msg).toContain("COMFYUI_PATH");
  });

  it("gives a remote caller a remedy that works from a different host", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "remote", reason: "this session targets a REMOTE ComfyUI on a different host" },
    });
    // Moving the file locally is NOT a remedy here, so it must not be offered.
    expect(msg).not.toMatch(/Copy or move it/);
    expect(msg).toContain("input directory");
    expect(msg).toContain('type: "input"');
  });
});

describe("forwardedByReferenceNote", () => {
  it("says the bytes were not sent and never claims anything was displayed", () => {
    const note = forwardedByReferenceNote(
      [
        {
          path: "/c/output/clip.mp4",
          sizeBytes: 72 * 1024 * 1024,
          kind: "video",
          ref: { filename: "clip.mp4", subfolder: "takes", type: "output" },
        },
      ],
      20 * 1024 * 1024,
    );
    expect(note).toContain("NOT sent the bytes");
    expect(note).toContain('subfolder "takes"');
    // The panel's reply is the only thing that knows what was painted.
    expect(note).toContain("in its reply above");
    expect(note).not.toMatch(/was displayed to the user/i);
  });

  it("offers get_image for an image and warns it is never inline for a video", () => {
    const img = forwardedByReferenceNote(
      [{ path: "/c/output/a.png", sizeBytes: 3e7, kind: "image", ref: { filename: "a.png", type: "output" } }],
      20 * 1024 * 1024,
    );
    expect(img).toContain("get_image");
    expect(img).toContain("comes back inline");

    const vid = forwardedByReferenceNote(
      [{ path: "/c/output/a.mp4", sizeBytes: 3e7, kind: "video", ref: { filename: "a.mp4", type: "output" } }],
      20 * 1024 * 1024,
    );
    expect(vid).toContain("never sent to you inline");
  });
});

// #941 — panel_show_media handed a browser panel eight ComfyUI /view references
// and replied {"ok":true,"count":8,"painted":8,"unconfirmed":0} over eight
// BROKEN image cards. The count was honest about what the PANEL did — it made
// eight cards — and silent about the thing the caller cares about: the browser
// fetches /view itself, AFTER that reply, and a proxied remote ComfyUI answering
// HTML breaks every card with no error anywhere in the chain.
describe("unverifiedViewRefNote (#941)", () => {
  const refs = [
    { filename: "a.png", subfolder: "final", type: "output" },
    { filename: "b.png", type: "output" },
  ];

  it("says nothing when nothing was forwarded by reference", () => {
    expect(unverifiedViewRefNote([])).toBe("");
  });

  it("separates what the panel established from what it did not", () => {
    const note = unverifiedViewRefNote(refs);
    expect(note).toMatch(/NOT that the media loaded/);
    expect(note).toMatch(/browser fetches \/view itself/);
    expect(note).toMatch(/renders BROKEN and nothing reports an error/);
    expect(note).toContain("a.png");
    expect(note).toContain('subfolder "final"');
  });

  it("names the remedy, and says not to re-send the same reference", () => {
    const note = unverifiedViewRefNote(refs);
    expect(note).toMatch(/do not re-send the same reference/i);
    expect(note).toMatch(/absolute LOCAL path/);
  });

  // A probe from the orchestrator is EVIDENCE, not proof: this process asks its
  // own COMFYUI_URL while the browser asks the origin its tab is on, and those
  // are allowed to differ (#952). Overstating it here would be the same defect
  // the note exists to fix, one layer up.
  it("reports a failed probe as strong evidence, never as proof", () => {
    const note = unverifiedViewRefNote(refs, {
      checked: 2,
      nonMedia: [{ filename: "a.png", detail: 'content-type "text/html"' }],
    });
    expect(note).toMatch(/1 of the 2 probed did NOT return media/);
    expect(note).toContain('a.png → content-type "text/html"');
    expect(note).toMatch(/strong evidence rather than proof/);
    expect(note).toMatch(/not necessarily the origin the browser tab is on/);
  });

  it("a clean probe does not become a guarantee either", () => {
    const note = unverifiedViewRefNote(refs, { checked: 2, nonMedia: [] });
    expect(note).toMatch(/all 2 probed returned media/);
    // …and still refuses to certify the browser's side.
    expect(note).toMatch(/does not rule out the browser tab reaching a DIFFERENT ComfyUI/);
  });

  it("omits probe wording entirely when nothing could be probed", () => {
    const note = unverifiedViewRefNote(refs, { checked: 0, nonMedia: [] });
    expect(note).not.toMatch(/Checked from HERE/);
  });

  it("caps the listing so a large batch cannot flood the reply", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ filename: `f${i}.png`, type: "output" }));
    const note = unverifiedViewRefNote(many);
    expect(note).toMatch(/…and 4 more/);
    expect(note).not.toContain("f11.png");
  });
});

// #802 — the parked half of the original report: the `outside` verdict used to
// end in "copy the file yourself". stageFileIntoServedDir does that copy for a
// caller who explicitly opted in (stage:true), into <output>/_panel_staged,
// and the tests below pin the things that make it safe to offer: it is a
// disclosed, never-overwriting, size-checked write — and it fails closed.
describe("stageFileIntoServedDir (#802)", () => {
  it("copies an outside file under _panel_staged and returns a ref to the COPY", async () => {
    const src = touch(join(root, "elsewhere", "clip.mp4"));
    writeFileSync(src, "video-bytes");
    const res = await stageFileIntoServedDir(src);
    expect(res.status).toBe("staged");
    if (res.status !== "staged") return;
    expect(res.ref.type).toBe("output");
    expect(res.ref.subfolder).toBe("_panel_staged");
    // Timestamped name, original basename preserved, and the copy really is
    // the file — the by-reference route shows the copy, so it must BE it.
    expect(res.ref.filename).toMatch(/^\d+-clip\.mp4$/);
    expect(readFileSync(res.stagedPath, "utf8")).toBe("video-bytes");
    expect(res.stagedPath).toBe(join(outDir, "_panel_staged", res.ref.filename));
    // The ORIGINAL was not modified or moved.
    expect(readFileSync(src, "utf8")).toBe("video-bytes");
  });

  it("staging the same file twice never overwrites the first copy", async () => {
    const src = touch(join(root, "elsewhere", "clip.mp4"));
    const first = await stageFileIntoServedDir(src);
    const second = await stageFileIntoServedDir(src);
    expect(first.status).toBe("staged");
    expect(second.status).toBe("staged");
    if (first.status !== "staged" || second.status !== "staged") return;
    expect(second.ref.filename).not.toBe(first.ref.filename);
    expect(existsSync(first.stagedPath)).toBe(true);
    expect(existsSync(second.stagedPath)).toBe(true);
  });

  it("refuses to stage a file that is ALREADY under the output directory", async () => {
    const inside = touch(join(outDir, "clip.mp4"));
    const res = await stageFileIntoServedDir(inside);
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.reason).toContain("ALREADY under");
    // No duplicate may have been deposited.
    expect(existsSync(join(outDir, "_panel_staged"))).toBe(false);
  });

  it("fails closed on a REMOTE target — a copy made here would be unreachable", async () => {
    state.remote = true;
    const src = touch(join(root, "elsewhere", "clip.mp4"));
    const res = await stageFileIntoServedDir(src);
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.reason).toContain("REMOTE");
    expect(existsSync(join(outDir, "_panel_staged"))).toBe(false);
  });

  it("fails closed on ComfyUI Cloud", async () => {
    state.cloud = true;
    const src = touch(join(root, "elsewhere", "clip.mp4"));
    const res = await stageFileIntoServedDir(src);
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.reason).toContain("Cloud");
  });

  it("fails, rather than throwing, when the output directory cannot be resolved", async () => {
    state.outputError = "the server did not answer /system_stats";
    const src = touch(join(root, "elsewhere", "clip.mp4"));
    const res = await stageFileIntoServedDir(src);
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.reason).toContain("could not be resolved");
    expect(res.reason).toContain("the server did not answer /system_stats");
  });

  it("refuses a file over the per-file staging cap and copies nothing", async () => {
    const src = touch(join(root, "elsewhere", "clip.mp4"));
    const res = await stageFileIntoServedDir(src, { maxFileBytes: 0 });
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.reason).toContain("per-file staging cap");
    expect(existsSync(join(outDir, "_panel_staged"))).toBe(false);
  });

  it("refuses when the staging folder would pass the total cap, and names the folder", async () => {
    mkdirSync(join(outDir, "_panel_staged"), { recursive: true });
    writeFileSync(join(outDir, "_panel_staged", "old.mp4"), "x".repeat(64));
    const src = touch(join(root, "elsewhere", "clip.mp4"));
    const res = await stageFileIntoServedDir(src, { maxDirBytes: 16 });
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.reason).toContain("total cap");
    expect(res.reason).toContain("_panel_staged");
  });
});

describe("oversizedInlineRefusal — the outside branch names staging (#802)", () => {
  const base = {
    path: "/refs/clip.mp4",
    sizeBytes: 72 * 1024 * 1024,
    capBytes: 20 * 1024 * 1024,
    kind: "video" as const,
  };

  it("offers stage:true as the one-call remedy, disclosed as a persistent disk write", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "outside", checked: [{ kind: "output", dir: "/c/output" }] },
    });
    expect(msg).toContain("stage:true");
    expect(msg).toContain("/c/output/_panel_staged");
    // The write's cost is stated where it is offered, not buried.
    expect(msg).toMatch(/disk write/);
    expect(msg).toContain("PERSISTS");
  });

  it("does NOT offer staging to a remote caller, who it cannot help", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "remote", reason: "this session targets a REMOTE ComfyUI on a different host" },
    });
    expect(msg).not.toContain("stage:true");
  });
});

describe("stagedForDisplayNote (#802)", () => {
  const item = {
    path: "/refs/clip.mp4",
    stagedPath: "/c/output/_panel_staged/1724000000000-clip.mp4",
    sizeBytes: 72 * 1024 * 1024,
    kind: "video" as const,
    ref: { filename: "1724000000000-clip.mp4", subfolder: "_panel_staged", type: "output" as const },
  };

  it("discloses the write, its location, and that the copy PERSISTS", () => {
    const note = stagedForDisplayNote([item], 20 * 1024 * 1024);
    expect(note).toContain("COPIED");
    expect(note).toContain("stage:true");
    expect(note).toContain("/refs/clip.mp4");
    expect(note).toContain(item.stagedPath);
    expect(note).toMatch(/real filesystem WRITE/);
    expect(note).toMatch(/persists/);
    expect(note).toContain("_panel_staged");
  });

  it("never claims the panel displayed anything, and says the bytes were not sent", () => {
    const note = stagedForDisplayNote([item], 20 * 1024 * 1024);
    expect(note).toContain("NOT sent the bytes");
    expect(note).toContain("in its reply above");
    expect(note).not.toMatch(/was displayed to the user/i);
  });
});
