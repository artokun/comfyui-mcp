import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DSH_PANEL_PERSONA,
  buildDshSystemAppend,
  assertDshAppendBudget,
  panelToolMode,
  dshCapabilityNote,
} from "../../orchestrator/dsh-prompt.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function overrides(value: object) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-prompt-"));
  dirs.push(dir);
  const path = join(dir, "panel-prompts.json");
  writeFileSync(path, JSON.stringify(value));
  vi.stubEnv("COMFYUI_MCP_PANEL_PROMPTS", path);
  return path;
}
it("pins DSH compact even with global full and leaves all other lanes unchanged", () => {
  vi.stubEnv("COMFYUI_MCP_TOOL_MODE", "full");
  expect(panelToolMode("dsh", "full")).toBe("compact");
  for (const b of ["codex", "gemini", "ollama", "claude"]) {
    for (const mode of ["full", "compact", null] as const)
      expect(panelToolMode(b, mode)).toBe(mode);
  }
});
it("does not inherit or rewrite the large shared persona", () => {
  const data = {
    "panel.persona": "shared".repeat(10000),
    "backend.ollama": "keep",
  };
  const p = overrides(data);
  expect(buildDshSystemAppend()).toBe(DSH_PANEL_PERSONA);
  expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(data);
  expect(
    Buffer.byteLength(assertDshAppendBudget(buildDshSystemAppend())),
  ).toBeLessThan(8192);
});
it("reads DSH overrides afresh and reset falls back to default", () => {
  const p = overrides({ "panel.persona.dsh": "自定义规则" });
  expect(buildDshSystemAppend()).toBe("自定义规则");
  writeFileSync(p, JSON.stringify({ "panel.persona.dsh": " " }));
  expect(buildDshSystemAppend()).toBe(DSH_PANEL_PERSONA);
});
it("enforces the final UTF8 append budget without truncation", () => {
  const s = "中".repeat(3000);
  expect(() => assertDshAppendBudget(s)).toThrow("9000 bytes");
  expect(assertDshAppendBudget("x".repeat(8192))).toHaveLength(8192);
  expect(s).toHaveLength(3000);
});
it("reports a failed listener without instructing saved-file or headless substitution", () => {
  overrides({});
  const caps = {
    os: "linux",
    gpu: "NVIDIA GeForce RTX 3090",
    vramTotalGb: 24,
    ramGb: 125,
    backend: "unknown",
  };
  for (const available of [true, false]) {
    const prompt = assertDshAppendBudget(
      buildDshSystemAppend(caps) + dshCapabilityNote(available),
    );
    expect(prompt).toContain("DSH (native ACP)");
    expect(prompt.includes("listener failed to start")).toBe(!available);
    expect(prompt).not.toContain("file-based route");
  }
});
it("wires the measured policy into the actual DSH factory", () => {
  const src = readFileSync(
    new URL("../../orchestrator/index.ts", import.meta.url),
    "utf8",
  );
  const branch = src.slice(
    src.indexOf('if (backend === "dsh") {', src.indexOf("const sysAppend =")),
    src.indexOf('if (backend === "codex") {', src.indexOf("const sysAppend =")),
  );
  expect(branch).toContain("assertDshAppendBudget(sysAppend)");
  expect(branch).toContain("panelToolMode(backend,httpLaneComfyToolMode)");
  expect(src).toContain('if (bId === "dsh")');
  expect(src).toContain("registerPrompt(DSH_PROMPT_ID");
});
