import { describe, expect, it } from "vitest";
import {
  parseCrashBlock,
  formatCrashNote,
  comfyuiLogCandidates,
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
