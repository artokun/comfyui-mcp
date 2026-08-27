// #2411 — a `sharp` whose native library will not load must not take the server down.
//
// THE DEFECT THESE PIN. `sharp` was imported at module top level by
// color-analysis / image-convert / inline-preview, all of which are reached
// statically from `src/tools/index.ts`. Measured on the reporter's platform by
// moving `libvips-cpp-8.18.3.dll` aside and running `node dist/index.js`: the
// process died during module evaluation, no tool registered, and the transport
// never came up. So the tests that matter most here are the IMPORT ones — a
// service that still imports sharp statically fails them however well its error
// message reads.
//
// TWO SUITES, ON PURPOSE, BECAUSE THE MOCK CANNOT CARRY THE MESSAGE.
// `vi.doMock("sharp", () => { throw … })` does make the import fail, which is
// what the blast-radius and degrade/refuse tests need. But vitest REPLACES the
// thrown error with its own ("[vitest] There was an error when mocking a
// module"), so the text that reaches the loader is vitest's, not sharp's. An
// earlier draft asserted message content through the mock and one case passed
// for the wrong reason — it took the non-native branch, and "does not contain
// sharp's install advice" was trivially true of a message that was never about a
// dlopen failure at all.
//
// So message content is pinned against REAL sharp errors instead, reproduced
// verbatim from an observed failure on this machine. That is the stronger test:
// it is the actual string the detection has to classify.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sharpUnavailableMessage,
  sharpUnavailableReason,
} from "../../services/sharp-loader.js";

/**
 * sharp's real words when its prebuilt cannot dlopen.
 *
 * Copied from `node dist/index.js` with `libvips-cpp-8.18.3.dll` moved aside.
 * Note there is NO `code` property: sharp catches the underlying dlopen error
 * and rethrows `new Error(help.join("\n"))`, so every classifier has to work off
 * the message. A test that attached `code: "ERR_DLOPEN_FAILED"` to this would be
 * testing a shape production never sees.
 */
const REAL_SHARP_DLOPEN_ERROR = new Error(
  [
    'Could not load the "sharp" module using the win32-x64 runtime',
    "ERR_DLOPEN_FAILED: The specified module could not be found.",
    "\\\\?\\C:\\Users\\…\\node_modules\\@img\\sharp-win32-x64\\lib\\sharp-win32-x64-0.35.3.node",
    "Possible solutions:",
    "- Ensure optional dependencies can be installed:",
    "    npm install --include=optional sharp",
    "- Consult the installation documentation:",
    "    See https://sharp.pixelplumbing.com/install",
  ].join("\n"),
);

/** What an `--omit=optional` install produces instead: nothing resolved at all. */
const REAL_SHARP_MISSING_ERROR = Object.assign(
  new Error("Cannot find package 'sharp' imported from C:\\…\\dist\\services\\image-convert.js"),
  { code: "ERR_MODULE_NOT_FOUND" },
);

/** Make every later `import("sharp")` fail, standing in for a failed dlopen. */
function blockSharp(): void {
  vi.doMock("sharp", () => {
    throw new Error("blocked");
  });
}

const ENV = "COMFYUI_MCP_NO_SHARP";

beforeEach(() => {
  vi.resetModules();
  delete process.env[ENV];
});

afterEach(() => {
  vi.doUnmock("sharp");
  vi.resetModules();
  delete process.env[ENV];
});

describe("a blocked sharp does not break module loading (#2411)", () => {
  // THE LOAD-BEARING TEST. Reverting any of the three services to
  // `import sharp from "sharp"` turns this red, because the throwing factory
  // fires while that service evaluates.
  it("the three sharp-backed services still IMPORT when sharp throws on load", async () => {
    blockSharp();
    await expect(import("../../services/inline-preview.js")).resolves.toBeDefined();
    await expect(import("../../services/image-convert.js")).resolves.toBeDefined();
    await expect(import("../../services/color-analysis.js")).resolves.toBeDefined();
  });

  // The reason the process died was not the services on their own — it was that
  // `tools/index.ts` reaches all three, so EVERY tool registration went with
  // them. This asserts the blast radius is closed at the top of that chain.
  it("the whole tool registry still IMPORTS when sharp throws on load", async () => {
    blockSharp();
    const mod = await import("../../tools/index.js");
    expect(typeof mod.registerAllTools).toBe("function");
  });
});

/**
 * Run `fn` as if on `platform`, then put the real one back.
 *
 * The remedy paragraph branches on `process.platform`, so a test that just reads
 * the ambient one asserts a different thing on every runner. That is not
 * hypothetical: the first version of this file guarded the Windows assertions
 * behind `if (process.platform === "win32")`, so they never ran on CI — and CI
 * then failed on the OTHER branch, which was echoing sharp's misdirecting
 * install advice. Both branches are pinned explicitly now.
 */
function asPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...real, value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

describe("the message names sharp, the library and a remedy (#2411)", () => {
  it("a real dlopen failure is diagnosed as the NATIVE library, not a missing package", async () => {
    for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
      asPlatform(platform, () => {
        const msg = sharpUnavailableMessage("Image conversion", REAL_SHARP_DLOPEN_ERROR);
        expect(msg).toContain("Image conversion is unavailable");
        expect(msg).toContain("libvips");
        expect(msg).toContain("sharp");
        // The cause is quoted, so the message is diagnosable and not just a
        // category. This is the line the reporter never saw.
        expect(msg).toContain("ERR_DLOPEN_FAILED: The specified module could not be found.");
      });
    }
  });

  it("names Smart App Control on Windows, and does NOT elsewhere", async () => {
    asPlatform("win32", () => {
      const msg = sharpUnavailableMessage("Image conversion", REAL_SHARP_DLOPEN_ERROR);
      // The remedy has to name where the block is visible, and has to say NOT to
      // reach for the switch that looks like it would fix it — disabling SAC is
      // a one-way door.
      expect(msg).toContain("Smart App Control");
      expect(msg).toMatch(/Do NOT disable Smart App Control/);
    });
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      asPlatform(platform, () => {
        // A Windows-only remedy on macOS is noise that costs the reader trust in
        // the rest of the message.
        expect(sharpUnavailableMessage("Image conversion", REAL_SHARP_DLOPEN_ERROR)).not.toContain(
          "Smart App Control",
        );
      });
    }
  });

  // CI caught this on macOS while Windows hid it: the non-Windows branch used to
  // say "npm install --include=optional sharp", which is precisely the advice
  // this test exists to keep out. A conditional assertion had let it through.
  it("no platform repeats sharp's install advice, which misdirects on a LOAD failure", async () => {
    for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
      asPlatform(platform, () => {
        const msg = sharpUnavailableMessage("Image conversion", REAL_SHARP_DLOPEN_ERROR);
        // sharp's own help says "npm install --include=optional sharp" — advice
        // about an ABSENT package. Here the package is present and the binary is
        // being refused, so echoing that sends the user to fix the wrong thing.
        expect(msg).not.toContain("npm install --include=optional sharp");
        expect(msg).not.toContain("sharp.pixelplumbing.com");
      });
    }
  });

  // Caught by running this repo's own review taxonomy (class 6, "prose overstates
  // what the code does") against the diff. The first wording was "Everything that
  // does not resize or re-encode images is unaffected" — but analysing colour
  // neither resizes nor re-encodes (it decodes to raw pixels via `.raw()`), so a
  // reader would have concluded it still worked. It does not.
  it("does not tell the user that colour analysis is unaffected — it is affected", async () => {
    const msg = sharpUnavailableMessage("Image conversion", REAL_SHARP_DLOPEN_ERROR);
    expect(msg).toMatch(/colour analysis/i);
    expect(msg).not.toMatch(/does not resize or re-encode/i);
    // The reassuring half has to stay true too: nothing here touches generation
    // or files already on disk.
    expect(msg).toMatch(/untouched|intact/i);
  });

  it("an ABSENT sharp gets the install remedy instead of the blocked-binary one", async () => {
    const msg = sharpUnavailableMessage("Image conversion", REAL_SHARP_MISSING_ERROR);
    expect(msg).toContain("Image conversion is unavailable");
    // #1447 parked `--omit=optional` precisely because it strips this package,
    // so "it was never installed" is a real case and wants different advice.
    expect(msg).toContain("--omit=optional");
    expect(msg).not.toContain("Smart App Control");
  });

  it("the mid-sentence reason stays on one line with no terminal full stop", async () => {
    const reason = sharpUnavailableReason(REAL_SHARP_DLOPEN_ERROR);
    // The caller splices this into `NOT rendered inline: ${reason}. The
    // full-resolution file is on disk…`, so a multi-line, full-stopped message
    // would read as two collided sentences and bury the caller's own remedy.
    expect(reason).not.toMatch(/\n/);
    expect(reason.endsWith(".")).toBe(false);
    expect(reason).toContain("libvips");
    expect(reason).toContain("sharp");
  });
});

describe("degrade vs refuse (#2411)", () => {
  it("an UNDER-BUDGET image is still delivered with sharp blocked", async () => {
    blockSharp();
    const { boundInlineImage } = await import("../../services/inline-preview.js");
    const result = await boundInlineImage("QUJDRA==", "image/png", {});
    // The pixels reach the caller. Nothing about this payload needed sharp: it
    // already fits on the wire, so withholding it would lose an image over a
    // dimension cap that cannot be measured anyway.
    expect(result.refused).toBeNull();
    expect(result.base64).toBe("QUJDRA==");
  });

  it("an OVER-BUDGET image is refused rather than emitted unresized", async () => {
    blockSharp();
    const { boundInlineImage } = await import("../../services/inline-preview.js");
    const result = await boundInlineImage("A".repeat(4096), "image/png", { budgetBytes: 1024 });
    // Refusing is the honest answer: it cannot be resized, and #1495 established
    // that emitting it anyway fails in transport with an error naming a byte
    // count rather than the image. (The WORDING of the reason is pinned above,
    // against a real sharp error — the mock cannot carry sharp's text.)
    expect(result.refused).not.toBeNull();
    expect(result.refused?.originalEncodedBytes).toBe(4096);
    expect(result.preview).toBeNull();
  });

  it("image conversion REFUSES rather than returning an empty success", async () => {
    blockSharp();
    const { convertImage } = await import("../../services/image-convert.js");
    // Checked before the source is resolved: with sharp unavailable this can
    // never succeed, so naming sharp beats reporting a path problem the user
    // would then fix for nothing.
    await expect(
      convertImage({ path: "does-not-exist.png", format: "png" }),
    ).rejects.toThrow(/Image conversion is unavailable/);
  });
});

describe("the COMFYUI_MCP_NO_SHARP escape hatch (#2411)", () => {
  it("=1 refuses with a message naming the switch, not a fake load error", async () => {
    process.env[ENV] = "1";
    const { requireSharp } = await import("../../services/sharp-loader.js");
    const err = await requireSharp("Image conversion").catch((e: unknown) => e as Error);
    expect(err.message).toContain(ENV);
    // Reporting a dlopen failure for a switch the user set themselves would send
    // them hunting a binary that is fine.
    expect(err.message).not.toMatch(/ERR_DLOPEN_FAILED|libvips/);
  });

  it("=1 short-circuits BEFORE importing sharp, so a healthy sharp is never loaded", async () => {
    process.env[ENV] = "1";
    const { tryLoadSharp } = await import("../../services/sharp-loader.js");
    const result = await tryLoadSharp();
    expect(result.ok).toBe(false);
  });

  // "0" and "false" are how a config file spells NO. Reading them as ON would
  // disable image features for someone who wrote the opposite of what they meant.
  it.each(["0", "false", "no", "off", "", "  "])("%o does NOT disable sharp", async (value) => {
    process.env[ENV] = value;
    const { probeSharp } = await import("../../services/sharp-loader.js");
    expect(await probeSharp()).toBeNull();
  });

  it.each(["1", "true", "yes", "on", "TRUE"])("%o DOES disable sharp", async (value) => {
    process.env[ENV] = value;
    const { probeSharp } = await import("../../services/sharp-loader.js");
    expect(await probeSharp()).toContain(ENV);
  });
});

describe("probeSharp on a healthy install (#2411)", () => {
  it("returns null when sharp loads, so a working machine logs nothing", async () => {
    const { probeSharp } = await import("../../services/sharp-loader.js");
    expect(await probeSharp()).toBeNull();
  });
});
