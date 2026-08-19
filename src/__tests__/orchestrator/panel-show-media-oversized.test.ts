// #648 — panel_show_media's 20 MB ceiling stops being a dead end.
//
// The panel half (panel #649) already gives an oversized video a sampled preview
// with full disclosure, but it was never reached: the orchestrator refused first,
// naming a limit and no way past it. These tests pin the routing that closes the
// gap — a file ComfyUI already serves goes as a /view reference (no cap on that
// path), anything else gets a refusal that names a remedy the caller can act on.
//
// MAX_BYTES is NOT raised, and these tests would not notice if it were; the
// oversized fixtures are real files above the cap.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const state = vi.hoisted(() => ({
  outputDir: "" as string,
  inputDir: "" as string,
  outputError: null as string | null,
  inputError: null as string | null,
  remote: false,
  cloud: false,
  /** Paths statSync should fail on with a non-ENOENT error. */
  statEacces: new Set<string>(),
  /** absolute path -> errno code readFileSync should fail with. */
  readFail: new Map<string, string>(),
}));

vi.mock("../../services/output-dir.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/output-dir.js")>();
  return {
    ...actual,
    resolveOutputDir: async () => {
      if (state.outputError) throw new Error(state.outputError);
      return state.outputDir;
    },
    resolveInputDir: async () => {
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

// An existing file that cannot be stat'ed is the third outcome the old
// existsSync+statSync pair had no branch for. It cannot be produced portably on
// Windows, so the syscall is made to fail for one designated path.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((p: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      if (typeof p === "string" && state.statEacces.has(p)) {
        const err = new Error(`EACCES: permission denied, stat '${p}'`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.statSync,
    // A file whose METADATA reads fine but whose CONTENTS do not — statSync
    // proves the former, never the latter.
    readFileSync: ((p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      const code = typeof p === "string" ? state.readFail.get(p) : undefined;
      if (code) {
        const err = new Error(`${code}: injected read failure, open '${String(p)}'`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
});

const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");

type Forwarded = Record<string, unknown>;

function makeCtx(): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx = {
    call: async (cmd: Forwarded) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
    },
    confirm: async () => "yes" as const,
    bridge: { isHeadless: () => false } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
  return { ctx, calls };
}

async function showMedia(
  items: Array<Record<string, unknown>>,
): Promise<{ res: ToolResult; calls: Forwarded[] }> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media");
  if (!def) throw new Error("panel_show_media not found");
  const { ctx, calls } = makeCtx();
  const res = (await def.handler({ items }, ctx)) as ToolResult;
  return { res, calls };
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? c.text : "")).join("\n");

const OVERSIZE = 21 * 1024 * 1024; // > the tool's 20 MB inline cap

let root: string;
let outDir: string;
let inDir: string;
let bigVideoUnderRoot: string;
let bigImageUnderRoot: string;
let bigVideoOutside: string;
let smallImage: string;
let bigTextUnderRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-showmedia-"));
  outDir = join(root, "ComfyUI", "output");
  inDir = join(root, "ComfyUI", "input");
  mkdirSync(join(outDir, "takes"), { recursive: true });
  mkdirSync(inDir, { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });

  const big = Buffer.alloc(OVERSIZE);
  bigVideoUnderRoot = join(outDir, "takes", "reference.mp4");
  writeFileSync(bigVideoUnderRoot, big);
  bigImageUnderRoot = join(outDir, "plate.png");
  writeFileSync(bigImageUnderRoot, big);
  bigVideoOutside = join(root, "elsewhere", "reference.mp4");
  writeFileSync(bigVideoOutside, big);
  bigTextUnderRoot = join(outDir, "notes.txt");
  writeFileSync(bigTextUnderRoot, big);
  smallImage = join(outDir, "small.png");
  writeFileSync(smallImage, Buffer.alloc(1024));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  state.outputDir = outDir;
  state.inputDir = inDir;
  state.outputError = null;
  state.inputError = null;
  state.remote = false;
  state.cloud = false;
  state.statEacces.clear();
  state.readFail.clear();
});

describe("panel_show_media: an oversized file UNDER a ComfyUI root is forwarded", () => {
  it("sends a /view reference instead of refusing, and inlines nothing", async () => {
    const { res, calls } = await showMedia([{ source: { path: bigVideoUnderRoot } }]);
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    const items = calls[0].items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    // The reason, not just the state: it must be a REFERENCE, with the ref the
    // file's real location implies — not inline bytes, and not a bare success.
    expect(items[0].kind).toBe("viewRef");
    expect(items[0].viewRef).toEqual({
      filename: "reference.mp4",
      subfolder: "takes",
      type: "output",
    });
    expect(items[0].dataUrl).toBeUndefined();
    // 21 MB of base64 would be ~28 MB of text; assert it is nowhere in the frame.
    expect(JSON.stringify(calls[0]).length).toBeLessThan(4096);
  });

  it("tells the agent the bytes were not sent, and does not claim a display", async () => {
    const { res } = await showMedia([{ source: { path: bigVideoUnderRoot } }]);
    const text = textOf(res);
    expect(text).toContain("NOT sent the bytes");
    expect(text).toContain("inline cap");
    // The panel's reply is the only thing that observed a paint.
    expect(text).toContain("in its reply above");
    expect(text).not.toMatch(/was shown to you/i);
  });

  it("forwards an oversized IMAGE too, and points the agent at get_image", async () => {
    // Decision: the reference route is not video-only. An oversized image has no
    // storyboard, but the panel still displays it same-origin at full size, and
    // refusing would leave the same dead end for stills.
    const { res, calls } = await showMedia([{ source: { path: bigImageUnderRoot } }]);
    expect(res.isError).toBeFalsy();
    const items = calls[0].items as Array<Record<string, unknown>>;
    expect(items[0].kind).toBe("viewRef");
    expect(items[0].viewRef).toEqual({ filename: "plate.png", type: "output" });
    expect(textOf(res)).toContain("get_image");
  });

  it("forwards a file under the INPUT directory with type input", async () => {
    const staged = join(inDir, "staged.mp4");
    writeFileSync(staged, Buffer.alloc(OVERSIZE));
    const { calls } = await showMedia([{ source: { path: staged } }]);
    const items = calls[0].items as Array<Record<string, unknown>>;
    expect(items[0].viewRef).toEqual({ filename: "staged.mp4", type: "input" });
  });

  it("still inlines the small items in the same batch", async () => {
    const { calls } = await showMedia([
      { source: { path: bigVideoUnderRoot } },
      { source: { path: smallImage } },
    ]);
    const items = calls[0].items as Array<Record<string, unknown>>;
    expect(items[0].kind).toBe("viewRef");
    expect(items[1].kind).toBe("image");
    expect(String(items[1].dataUrl)).toMatch(/^data:image\/png;base64,/);
  });
});

describe("panel_show_media: an oversized file NOT under a root is refused with a remedy", () => {
  it("names the cap, the directories checked, and what to do next", async () => {
    const { res, calls } = await showMedia([{ source: { path: bigVideoOutside } }]);
    expect(res.isError).toBe(true);
    // Nothing was sent to the panel, so nothing may be reported as shown.
    expect(calls).toHaveLength(0);
    const text = textOf(res);
    expect(text).toContain("21.0 MB");
    expect(text).toContain("20.0 MB");
    expect(text).toContain(outDir);
    expect(text).toContain(inDir);
    expect(text).toMatch(/Copy or move it/);
    expect(text).toContain("panel_show_media");
    // #802 — the refusal also names the opt-in one-call remedy.
    expect(text).toContain("stage:true");
  });

  it("does not blame the file's location when the roots could not be resolved", async () => {
    state.outputError = "COMFYUI_PATH is not configured";
    state.inputError = "COMFYUI_PATH is not configured";
    const { res } = await showMedia([{ source: { path: bigVideoOutside } }]);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("could NOT be determined");
    expect(text).not.toContain("This file is not under any directory");
    expect(text).toContain("COMFYUI_PATH");
  });

  it("gives a remote session a remedy that works from a different host", async () => {
    state.remote = true;
    // Under the output dir — but the server is elsewhere and cannot open it.
    const { res, calls } = await showMedia([{ source: { path: bigVideoUnderRoot } }]);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const text = textOf(res);
    expect(text).toContain("REMOTE ComfyUI");
    expect(text).not.toMatch(/Copy or move it/);
    expect(text).toContain('type: "input"');
  });
});

// #802 — with stage:true the caller opts into the orchestrator copying an
// oversized OUTSIDE file into <output>/_panel_staged and displaying the copy
// by reference. These cover the WIRING; the staging mechanics and their
// failure modes are pinned in comfy-view-ref.test.ts.
describe("panel_show_media: stage:true stages an oversized outside file (#802)", () => {
  it("copies the file under _panel_staged and forwards a ref to the COPY", async () => {
    const { res, calls } = await showMedia([{ source: { path: bigVideoOutside, stage: true } }]);
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    const items = calls[0].items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("viewRef");
    expect(items[0].viewRef).toMatchObject({
      subfolder: "_panel_staged",
      type: "output",
    });
    const ref = items[0].viewRef as { filename: string };
    expect(ref.filename).toMatch(/^\d+-reference\.mp4$/);
    // The copy exists, is the full file, and the ORIGINAL was left alone.
    expect(statSync(join(outDir, "_panel_staged", ref.filename)).size).toBe(OVERSIZE);
    expect(statSync(bigVideoOutside).size).toBe(OVERSIZE);
  });

  it("discloses the write, its location, and that the copy persists", async () => {
    const { res } = await showMedia([{ source: { path: bigVideoOutside, stage: true } }]);
    const text = textOf(res);
    expect(text).toContain("COPIED");
    expect(text).toContain("_panel_staged");
    expect(text).toMatch(/persists/);
    expect(text).toContain("NOT sent the bytes");
  });

  it("without stage the same file is still refused — the write stays opt-in", async () => {
    const before = existsSync(join(outDir, "_panel_staged"))
      ? readdirSync(join(outDir, "_panel_staged")).length
      : 0;
    const { res, calls } = await showMedia([{ source: { path: bigVideoOutside } }]);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const after = existsSync(join(outDir, "_panel_staged"))
      ? readdirSync(join(outDir, "_panel_staged")).length
      : 0;
    expect(after).toBe(before);
  });

  it("a staging failure falls through to the refusal WITH the reason attached", async () => {
    state.remote = true;
    const { res, calls } = await showMedia([{ source: { path: bigVideoOutside, stage: true } }]);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const text = textOf(res);
    expect(text).toContain("Staging WAS requested");
    expect(text).toContain("REMOTE");
  });

  it("stage:true does not copy a file that is already servable by reference", async () => {
    const { res, calls } = await showMedia([{ source: { path: bigVideoUnderRoot, stage: true } }]);
    expect(res.isError).toBeFalsy();
    const items = calls[0].items as Array<Record<string, unknown>>;
    // The ORIGINAL location's ref — not a staged copy.
    expect(items[0].viewRef).toEqual({
      filename: "reference.mp4",
      subfolder: "takes",
      type: "output",
    });
  });

  it("stage:true is ignored for a file small enough to inline", async () => {
    const { res, calls } = await showMedia([{ source: { path: smallImage, stage: true } }]);
    expect(res.isError).toBeFalsy();
    const items = calls[0].items as Array<Record<string, unknown>>;
    expect(items[0].kind).toBe("image");
    expect(String(items[0].dataUrl)).toMatch(/^data:image\/png;base64,/);
  });
});

describe("panel_show_media: the other outcomes stay distinct", () => {
  it("leaves under-cap files inlined, with no reference note", async () => {
    const { res, calls } = await showMedia([{ source: { path: smallImage } }]);
    expect(res.isError).toBeFalsy();
    const items = calls[0].items as Array<Record<string, unknown>>;
    expect(items[0].kind).toBe("image");
    expect(String(items[0].dataUrl)).toMatch(/^data:image\/png;base64,/);
    expect(items[0].viewRef).toBeUndefined();
    expect(textOf(res)).not.toContain("inline cap");
  });

  it("refuses an oversized UNSUPPORTED type for what is actually wrong with it", async () => {
    // A .txt is not displayable at any size, so the reference route is not a
    // remedy for it and must not be offered.
    const { res } = await showMedia([{ source: { path: bigTextUnderRoot } }]);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("unsupported file type");
    expect(text).not.toContain("too large");
  });

  it("reports a missing file as missing", async () => {
    const { res } = await showMedia([{ source: { path: join(outDir, "nope.mp4") } }]);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("file not found");
  });

  it("reports an unreadable file as unreadable — not as missing, and not as too large", async () => {
    state.statEacces.add(bigVideoUnderRoot);
    const { res, calls } = await showMedia([{ source: { path: bigVideoUnderRoot } }]);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const text = textOf(res);
    expect(text).toContain("could not read file metadata");
    expect(text).toContain("EACCES");
    // Neither of the two answers it is NOT. Matched on the phrasing the real
    // refusals use, so this cannot be satisfied by a message that merely avoids
    // the words while still reporting the wrong cause.
    expect(text).not.toContain("file not found");
    expect(text).not.toContain("file too large");
    expect(text).not.toContain("inline cap");
  });

  it("does not claim a file was readable when only its metadata was", async () => {
    // statSync proves METADATA access; a mode/ACL can permit that and deny the
    // read. Asserting "it was readable a moment ago" would state something this
    // process never observed (codex finding).
    state.readFail.set(smallImage, "EACCES");
    const { res } = await showMedia([{ source: { path: smallImage } }]);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("metadata was readable but its contents were not");
    expect(text).not.toContain("was readable a moment ago");
    expect(text).not.toContain("size limit,"); // not misreported as a cap problem
  });

  it("reports a file deleted mid-call as having disappeared, not as unreadable", async () => {
    state.readFail.set(smallImage, "ENOENT");
    const { res } = await showMedia([{ source: { path: smallImage } }]);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("disappeared between being measured and being read");
  });

  it("still rejects a relative path", async () => {
    const { res } = await showMedia([{ source: { path: "relative/clip.mp4" } }]);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("must be absolute");
  });
});

// #941 — a /view reference forwarded to a BROWSER panel comes back described as
// painted, and the reporter's eight painted cards were eight broken images on a
// proxied remote ComfyUI. The panel's count is honest about the card; nothing
// in the chain knows whether the browser's own /view fetch succeeded.
//
// These cover the WIRING: the note has to reach the reply. The note's own
// wording is pinned in comfy-view-ref.test.ts.
describe("#941: a forwarded /view reference says what 'painted' does not cover", () => {
  const ref = { source: { filename: "a.png", subfolder: "final", type: "output" } };

  beforeEach(() => {
    // No probe response — fetch is not stubbed here, so every probe throws and
    // is (correctly) not counted. The caveat must stand on its own regardless.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in test")));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("appends the caveat when an item goes as a reference", async () => {
    const { res } = await showMedia([ref]);
    const t = textOf(res);
    expect(t).toMatch(/NOT that the media loaded/);
    expect(t).toMatch(/browser fetches \/view itself/);
    expect(t).toContain("a.png");
  });

  it("still forwards the reference — the caveat replaces nothing", async () => {
    const { calls } = await showMedia([ref]);
    const items = calls[0]?.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "viewRef" });
  });

  // An inlined local path is verified bytes; hedging it would make a
  // trustworthy result look doubtful.
  it("says nothing for an item that was inlined from a local path", async () => {
    const small = join(outDir, "small.png");
    writeFileSync(small, Buffer.alloc(64));
    const { res } = await showMedia([{ source: { path: small } }]);
    expect(textOf(res)).not.toMatch(/NOT that the media loaded/);
  });

  it("an unreachable probe is not counted as a check", async () => {
    const { res } = await showMedia([ref]);
    // Every probe threw, so there is no evidence sentence to print…
    expect(textOf(res)).not.toMatch(/Checked from HERE/);
    // …but the caveat itself is unconditional.
    expect(textOf(res)).toMatch(/renders BROKEN/);
  });
});
