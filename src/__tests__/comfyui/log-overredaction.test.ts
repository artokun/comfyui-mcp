// #1223 — the #1206 scrub redacted the diagnosis.
//
// `get_system_stats action:"logs"` came back with every custom-node path and
// every dotted module name replaced by «redacted»:
//
//   [INFO]  0.0 seconds (IMPORT FAILED): «redacted»
//     - «redacted»: ImportError: cannot import name 'pad' from '«redacted»' («redacted»)
//
// Diagnosing an IMPORT FAILED needs exactly those two things — which pack failed
// (a path) and which module the missing symbol came from. Redacting both reduces
// the log tool to "something, somewhere, failed", and the reporter had to bypass
// it and curl ComfyUI's own endpoint to get the answer.
//
// The cause: the opaque-run pass matches 24+ characters of an alphabet that
// includes `/`, `.`, `-` and `_`, on the reasoning that "ordinary prose breaks
// well before 24 chars". True of prose. False of a LOG, where paths are the
// dominant content.
//
// These are the real strings from the report. This file exists to keep them
// readable — but a redaction test that only checks the KEPT direction is
// worthless, so the credential half is asserted right alongside them.

import { describe, expect, it, vi } from "vitest";

const HF = "hf_aBcD3fGh1jKlMnOpQrStUvWxYz";

vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => ({}),
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  config: { huggingfaceToken: HF, civitaiApiToken: undefined, comfyuiApiKey: undefined },
}));

const { scrubLogLines } = await import("../../comfyui/json-guard.js");

const one = (line: string): string => scrubLogLines([line])[0];

describe("a log keeps its paths and module names (#1223)", () => {
  // Verbatim from the issue.
  it.each([
    ["custom-node path", "[INFO]   10.8 seconds: /basedir/custom_nodes/comfyui-easy-use"],
    ["IMPORT FAILED path", "[INFO]    0.0 seconds (IMPORT FAILED): /basedir/custom_nodes/ComfyUI-LTXVideo"],
    ["dotted module", "cannot import name 'pad' from 'kornia.geometry.transform.pyramid'"],
    [
      "site-packages file",
      "(/comfy/mnt/venv/lib/python3.12/site-packages/kornia/geometry/transform/pyramid.py)",
    ],
    ["module-not-found", "  - .VRGDG_LTXLoopingSampler: ModuleNotFoundError: No module named 'ComfyUI-LTXVideo'"],
    ["output dir", "[VRGDG] Created 12 placeholder text file(s) in /basedir/output/VRGDG_TEMP/TextFiles"],
    ["windows path", "C:/Users/artokun/comfy/custom_nodes/ComfyUI-AnimateDiff-Evolved/nodes.py"],
    ["model filename", "loading model sd_xl_base_1.0.safetensors from checkpoints"],
    // DIGIT-LED names. Found by mutation: a letters-then-digits rule reads `4x`
    // as a blob, so the most common upscale filenames in any ComfyUI log would
    // have come back redacted — the very bug this fixes.
    ["digit-led upscale model", "/basedir/models/upscale_models/4x-UltraSharp.pth"],
    ["digit-led ESRGAN variant", "/basedir/models/upscale_models/8x_NMKD-Superscale.pth"],
    ["versioned checkpoint", "/basedir/models/checkpoints/v2-1_768-ema-pruned.ckpt"],
    // INTERLEAVED digits. `t5xxl` has one in the middle, and so do half the
    // text-encoder filenames in a modern ComfyUI log.
    ["interleaved text encoder", "/basedir/models/text_encoders/t5xxl_fp16.safetensors"],
    ["interleaved fp8 encoder", "/basedir/models/text_encoders/umt5_xxl_fp8_e4m3fn.safetensors"],
  ])("keeps %s intact", (_name, line) => {
    expect(one(line)).toBe(line);
  });

  it("keeps the pack name a keyword search would look for", () => {
    // The concrete downstream failure: the substring has to survive, or the
    // filter finds nothing and the tool claims the line does not exist.
    const line = "[INFO]    0.0 seconds (IMPORT FAILED): /basedir/custom_nodes/ComfyUI-LTXVideo";
    expect(one(line).toLowerCase()).toContain("ltxvideo");
  });
});

// THE OTHER DIRECTION. Narrowing a redaction rule is only safe if the thing it
// was for still goes. Each of these is a shape the old flat rule caught, and
// every one must still be caught by the new structure-aware one.
describe("credential shapes are still redacted (#1223)", () => {
  it.each([
    ["configured HF token", `[INFO] using ${HF} for auth`],
    ["unknown base64 blob", "[INFO] sig=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw"],
    ["hex digest", "[INFO] checksum d41d8cd98f00b204e9800998ecf8427e1a2b3c4d"],
    ["digit-led opaque run", "[INFO] id 9f2b7c41aa6e4d0e8b3f5a1c7e9d0b2f4a6c8e1d"],
    // Prefixed-key shape (`<prefix>_<blob>`). Deliberately NOT spelled like any
    // real vendor's live-key format — the first draft used one and GitHub push
    // protection rejected the commit, which is the correct outcome for a fixture
    // that pattern-matches a credential a scanner has to treat as real.
    ["prefixed vendor key", "[INFO] zq_demo_KjLmNoPqRsTuVwXyZ0123456789abcdef"],
    ["jwt-ish segment", "[INFO] eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh"],
  ])("still redacts a %s", (_name, line) => {
    const out = one(line);
    expect(out).toContain("redacted");
    expect(out).not.toBe(line);
  });

  it("redacts a token EMBEDDED in an otherwise ordinary path", () => {
    // The interesting mixed case: real structure around a real blob. The path
    // must survive and the blob must not.
    const out = one(`GET /basedir/custom_nodes/${HF}/x.py`);
    expect(out).not.toContain(HF);
    expect(out).toContain("custom_nodes");
  });

  // SEPARATED blobs — the ones that actually exercise the per-part word test.
  //
  // Found by mutation: making the word test return `true` unconditionally killed
  // nothing, because every credential fixture above is either a CONFIGURED value
  // (caught by name in pass 1) or has no `/` or `.` at all (so it short-circuits
  // as one unbroken blob and never reaches the word test). The branch that
  // decides whether a SEPARATED run is a path or a secret had no coverage — and
  // it is the only branch this change actually loosened.
  it.each([
    ["a real 3-part JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"],
    ["standard base64 carrying a slash", "YWJjZGVmZ2hpamts/bW5vcHFyc3R1dnd4eXoxMjM0"],
    ["an unknown token inside a path", "/basedir/custom_nodes/QNhK3xVmZp0RtLwYc7BdEf9Gs2Ju/x.py"],
    ["a dotted opaque pair", "aGVsbG93b3JsZGZvb2Jhcg.YmFyYmF6cXV4Y29ycmdl"],
    // No digits at all, so only the LENGTH cap can catch it — a chunk this long
    // is not a word whatever its spelling.
    ["a long all-alphabetic blob in a path", "/api/v1/QNhKxVmZpRtLwYcBdEfGsJuAbCdEfGhIjKl/logs"],
    // Interleaved and past the short-name allowance: a hex session id in a path
    // is the shape the digits-at-the-edges rule exists for, and it is under the
    // length cap, so ONLY that rule can catch it.
    ["a hex id inside a route", "/api/v1/sessions/9f2b7c41aa6e4d0e/logs"],
  ])("redacts %s even though it is separated", (_name, blob) => {
    const out = one(`[INFO] value ${blob}`);
    expect(out, `leaked: ${out}`).not.toContain(blob);
    expect(out).toContain("redacted");
  });

  it("redacts a labelled secret whatever its shape", () => {
    // Pass 2 is untouched by this change, and it is what covers a credential
    // that happens to be spelled like a word.
    expect(one("[INFO] api_key=correcthorsebatterystaple")).not.toContain("correcthorse");
  });
});
