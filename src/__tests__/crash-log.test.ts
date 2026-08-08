import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCrashBlock,
  formatCrashNote,
  comfyuiLogCandidates,
  readComfyuiCrashLog,
} from "../services/crash-log.js";

// The MOTIVATING CASE: a Wan2.2 build crashed ComfyUI with a native access
// violation. This is the real traceback captured in the log.
const WAN_CRASH = `
2026-06-24 12:00:01 [INFO] got prompt
2026-06-24 12:00:02 [INFO] Using split attention in VAE
Windows fatal exception: access violation

Current thread 0x00004abc (most recent call first):
  File "C:\\Users\\Artokun\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\custom_nodes\\ComfyUI-WanVideoWrapper\\utils.py", line 338 in apply_lora
  File "C:\\Users\\Artokun\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\custom_nodes\\ComfyUI-WanVideoWrapper\\nodes_model_loading.py", line 1736 in loadmodel
  File "C:\\Users\\Artokun\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\execution.py", line 152 in recursive_execute
`;

describe("parseCrashBlock", () => {
  it("extracts the culprit node + frame from the WanVideoWrapper access violation", () => {
    const r = parseCrashBlock(WAN_CRASH);
    expect(r.fatal).toBe(true);
    expect(r.culpritNode).toBe("ComfyUI-WanVideoWrapper");
    // The DEEPEST custom-node frame is apply_lora at utils.py:338 — the last
    // custom_nodes frame before execution drops into core ComfyUI.
    expect(r.culpritFrame).toBe("utils.py:338");
    expect(r.block).toContain("access violation");
    expect(r.block).toContain("apply_lora");
  });

  it("returns fatal:false for a clean log (no crash signature)", () => {
    const clean = `
2026-06-24 12:00:01 [INFO] got prompt
2026-06-24 12:00:30 [INFO] Prompt executed in 28.4 seconds
2026-06-24 12:01:00 [INFO] Comfy is restarting…
`;
    const r = parseCrashBlock(clean);
    expect(r.fatal).toBe(false);
    expect(r.block).toBe("");
    expect(r.culpritNode).toBeUndefined();
  });

  it("detects a bare segmentation fault and a forward-slash custom_nodes frame", () => {
    const seg = `
[INFO] sampling
Segmentation fault (core dumped)
  File "/home/u/ComfyUI/custom_nodes/SomeNativeNode/kernel.py", line 42 in forward
`;
    const r = parseCrashBlock(seg);
    expect(r.fatal).toBe(true);
    expect(r.culpritNode).toBe("SomeNativeNode");
    expect(r.culpritFrame).toBe("kernel.py:42");
  });

  it("detects a Fatal Python error and falls back to any frame when no custom node is in the trace", () => {
    const core = `
Fatal Python error: Illegal instruction

Current thread (most recent call first):
  File "/home/u/ComfyUI/comfy/model_management.py", line 900 in load_models_gpu
`;
    const r = parseCrashBlock(core);
    expect(r.fatal).toBe(true);
    expect(r.culpritNode).toBeUndefined();
    expect(r.culpritFrame).toBe("model_management.py:900");
  });

  it("extracts a colon-form custom_nodes frame from a native crash", () => {
    const tb = `
Fatal Python error: Segmentation fault

Traceback (most recent call last):
  File "custom_nodes/ComfyUI-WanVideoWrapper/nodes.py", line 10, in run
RuntimeError: CUDA error
`;
    const r = parseCrashBlock(tb);
    expect(r.fatal).toBe(true);
    expect(r.culpritNode).toBe("ComfyUI-WanVideoWrapper");
    expect(r.culpritFrame).toBe("nodes.py:10");
  });

  it("does NOT treat a bare Python traceback (no native signature) as a crash", () => {
    const tb = `
Traceback (most recent call last):
  File "custom_nodes/Some-Node/nodes.py", line 10, in run
ValueError: bad input
[2026-06-25T22:00:00Z] [INFO] Prompt executed (recovered, node returned an error)
`;
    const r = parseCrashBlock(tb);
    expect(r.fatal).toBe(false);
    expect(r.fingerprint).toBeUndefined();
  });

  it("does NOT treat a swallowed 'Exception ignored in: __del__' block as a crash", () => {
    // CPython prints but SWALLOWS exceptions raised in __del__/weakref callbacks
    // during GC. The process keeps running (subsequent prompts succeed), so the
    // native signature INSIDE this block must not trip the crash banner.
    const swallowed = [
      "2026-07-28 17:11:20 [INFO] got prompt",
      "Exception ignored in: <function HostBuffer.__del__ at 0x0>",
      "Traceback (most recent call last):",
      '  File "~/.venv/Lib/site-packages/comfy_aimdo/host_buffer.py", line 129, in __del__',
      "    lib.hostbuf_free(ptr)",
      "OSError: exception: access violation writing 0x0000000000000024",
      "2026-07-28 17:11:22 [INFO] Prompt executed in 7.18 seconds",
      "2026-07-28 17:17:22 [INFO] got prompt",
      "2026-07-28 17:17:30 [INFO] Prompt executed in 8.00 seconds",
    ].join("\n");
    const r = parseCrashBlock(swallowed);
    expect(r.fatal).toBe(false);
    expect(r.block).toBe("");
    expect(r.fingerprint).toBeUndefined();
  });

  it("STILL flags a real native crash that appears after an earlier swallowed __del__ block", () => {
    // A swallowed destructor block earlier in the tail must not suppress a genuine
    // process crash that happens later.
    const mixed = [
      "Exception ignored in: <function HostBuffer.__del__ at 0x0>",
      "Traceback (most recent call last):",
      '  File "~/comfy_aimdo/host_buffer.py", line 129, in __del__',
      "OSError: exception: access violation writing 0x24",
      "2026-07-28 17:11:22 [INFO] Prompt executed in 7.18 seconds",
      "",
      "Windows fatal exception: access violation",
      "",
      "Current thread 0x00004abc (most recent call first):",
      '  File "C:\\\\ComfyUI\\\\custom_nodes\\\\SomeNode\\\\nodes.py", line 42 in run',
    ].join("\n");
    const r = parseCrashBlock(mixed);
    expect(r.fatal).toBe(true);
    expect(r.culpritNode).toBe("SomeNode");
    expect(r.culpritFrame).toBe("nodes.py:42");
  });

  it("flags a real crash after a swallowed block even with CRLF line endings", () => {
    // Windows logs use CRLF. The blank-line boundary in the swallowed-block
    // look-back must recognize "\r\n\r\n", or a genuine crash within 1200 chars
    // of an earlier swallowed block gets wrongly filtered out.
    const mixed = [
      "Exception ignored in: <function HostBuffer.__del__ at 0x0>",
      "Traceback (most recent call last):",
      '  File "~/comfy_aimdo/host_buffer.py", line 129, in __del__',
      "OSError: exception: access violation writing 0x24",
      "[INFO] Prompt executed in 7.18 seconds",
      "",
      "Windows fatal exception: access violation",
      "",
      "Current thread 0x00004abc (most recent call first):",
      '  File "C:\\\\ComfyUI\\\\custom_nodes\\\\SomeNode\\\\nodes.py", line 42 in run',
    ].join("\r\n");
    const r = parseCrashBlock(mixed);
    expect(r.fatal).toBe(true);
    expect(r.culpritNode).toBe("SomeNode");
    expect(r.culpritFrame).toBe("nodes.py:42");
  });

  it("fingerprints a crash stably so it can be deduped", () => {
    const a = parseCrashBlock(WAN_CRASH);
    const b = parseCrashBlock(WAN_CRASH + "\n[INFO] more log appended after restart\n");
    expect(a.fingerprint).toBeTruthy();
    // Same crash head → same fingerprint even though the tail grew post-restart.
    expect(b.fingerprint).toBe(a.fingerprint);
  });
});

describe("formatCrashNote", () => {
  it("builds an injectable note naming the culprit node", () => {
    const note = formatCrashNote(parseCrashBlock(WAN_CRASH));
    expect(note).not.toBeNull();
    expect(note!).toContain("ComfyUI crashed");
    expect(note!).toContain("ComfyUI-WanVideoWrapper");
    expect(note!).toContain("utils.py:338");
  });

  it("returns null on a clean parse", () => {
    expect(formatCrashNote({ fatal: false, block: "" })).toBeNull();
  });
});

describe("comfyuiLogCandidates", () => {
  it("prefers logs/comfyui.log over user/comfyui.log", () => {
    const c = comfyuiLogCandidates("/comfy");
    expect(c[0]).toMatch(/logs[\\/]+comfyui\.log$/);
    expect(c[1]).toMatch(/user[\\/]+comfyui\.log$/);
  });
});

// #796's class, in the place it costs most.
//
// `fatal: boolean` is a two-valued field carrying THREE states: a crash was
// found, no crash was found, and NOTHING WAS LOOKED AT. The third rendered as the
// second — and formatCrashNote returns null for !fatal, so a log that could not be
// opened (locked mid-write on Windows, permissions, a truncated read) told the
// agent its restart was CLEAN.
//
// That is the worst available direction. The whole feature exists so the agent
// does not re-run the graph that just killed the server, and silence reads as
// "safe to proceed".
describe("an unreadable log is not a clean restart", () => {
  it("says the outcome is UNKNOWN, and that nothing was scanned", () => {
    const note = formatCrashNote({
      fatal: false,
      block: "",
      unreadable: { path: "C:/comfy/user/comfyui.log", reason: "EBUSY: resource busy or locked" },
    });

    expect(note).not.toBeNull();
    expect(note!).toMatch(/could NOT be read/);
    expect(note!).toMatch(/UNKNOWN/);
    // It must not merely hedge — it has to say WHY the silence is uninformative.
    expect(note!).toMatch(/no crash signature was ruled out, because nothing was scanned/);
    // And name what it tried, so the user can go and look.
    expect(note!).toContain("C:/comfy/user/comfyui.log");
    expect(note!).toContain("EBUSY");
  });

  it("still stays silent for a genuinely clean restart", () => {
    // The noise guard: no `unreadable`, no note. A permanent unknown-banner on
    // every resume is how a real warning stops being read.
    expect(formatCrashNote({ fatal: false, block: "" })).toBeNull();
  });

  it("does not displace a REAL crash note", () => {
    const note = formatCrashNote({
      fatal: true,
      block: "Windows fatal exception: access violation",
      culpritNode: "ComfyUI-WanVideoWrapper",
      unreadable: { path: "x", reason: "y" },
    });

    expect(note!).toMatch(/ComfyUI crashed/);
    expect(note!).not.toMatch(/could NOT be read/);
  });
});

// THE WIRING, not just the helper. The tests above hand formatCrashNote a
// constructed result; they would all still pass if readComfyuiCrashLog never set
// `unreadable` at all. This drives the real function against a real unreadable
// path — and pins the fingerprint, because the injection site skips any note
// without one, so a missing fingerprint would silently suppress the warning.
describe("readComfyuiCrashLog reports an existing-but-unreadable log", () => {
  it("sets unreadable + a fingerprint when the log cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-crashlog-"));
    // A DIRECTORY where the log file goes: existsSync passes, statSync succeeds,
    // readFileSync throws EISDIR. That is the read-catch branch, cross-platform.
    mkdirSync(join(root, "user", "comfyui.log"), { recursive: true });

    const r = readComfyuiCrashLog(root);

    expect(r.fatal).toBe(false);
    expect(r.unreadable, "an existing log that cannot be read must be reported").toBeTruthy();
    expect(r.unreadable!.path).toContain("comfyui.log");
    expect(r.unreadable!.reason).toBeTruthy();
    // Without this the note is built and then dropped by the injection site.
    expect(r.fingerprint, "no fingerprint means the note is never injected").toBeTruthy();
    expect(r.fingerprint!).toMatch(/^unreadable:/);
    // End to end: the agent actually gets told.
    expect(formatCrashNote(r)).toMatch(/could NOT be read/);

    rmSync(root, { recursive: true, force: true });
  });

  it("stays silent when there is no log at all — nothing to report, not an unknown", () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-crashlog-empty-"));

    const r = readComfyuiCrashLog(root);

    expect(r.fatal).toBe(false);
    expect(r.unreadable).toBeUndefined();
    expect(formatCrashNote(r)).toBeNull();

    rmSync(root, { recursive: true, force: true });
  });

  it("is unchanged for a readable log with no crash", () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-crashlog-clean-"));
    mkdirSync(join(root, "user"), { recursive: true });
    writeFileSync(join(root, "user", "comfyui.log"), "[INFO] Prompt executed in 3.2 seconds\n");

    const r = readComfyuiCrashLog(root);

    expect(r.fatal).toBe(false);
    expect(r.unreadable).toBeUndefined();
    expect(formatCrashNote(r)).toBeNull();

    rmSync(root, { recursive: true, force: true });
  });
});
