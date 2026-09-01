import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { calliopeSupervise, parseReport, VENDORED_SCRIPT, type CalliopeSupervisorDeps } from "../../services/calliope-supervisor.js";
import type { PanelDetection } from "../../services/panel-installer.js";

const installed: PanelDetection = { applicable: true, installed: true, dir: "/comfy/custom_nodes/comfyui-mcp-panel", isDevSymlink: false };
const script = join(installed.dir!, VENDORED_SCRIPT);

function deps(over: Partial<CalliopeSupervisorDeps> & { report?: unknown; stderr?: string; code?: number; timedOut?: boolean } = {}): CalliopeSupervisorDeps & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => ({
    code: over.code ?? 0,
    stdout: over.report === undefined ? "" : `[calliope-up] progress\n${JSON.stringify(over.report)}\n`,
    stderr: over.stderr ?? "[calliope-up] starting",
    timedOut: over.timedOut ?? false,
  }));
  return { detect: over.detect ?? (async () => installed), exists: over.exists ?? (() => true), run };
}

describe("calliopeSupervise — runs the panel's vendored bring-up, never its own copy", () => {
  it("refuses without a local panel install, before touching anything", async () => {
    const d = deps({ detect: async () => ({ applicable: false, installed: false, isDevSymlink: false }) });
    expect((await calliopeSupervise("up", d)).ok).toBe(false);
    const e = deps({ detect: async () => ({ applicable: true, installed: false, isDevSymlink: false }) });
    expect((await calliopeSupervise("up", e)).error).toMatch(/install the panel first/);
    expect(d.run).not.toHaveBeenCalled();
    expect(e.run).not.toHaveBeenCalled();
  });

  it("names the missing script when the panel build does not carry it", async () => {
    const d = deps({ exists: () => false });
    const r = await calliopeSupervise("check", d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(script);
    expect(d.run).not.toHaveBeenCalled();
  });

  it("up: passes no flag, reads the report off the last stdout line, ok when reachable", async () => {
    const d = deps({ report: { reachable: true, version: "1.2.1", base_url: "http://127.0.0.1:8247", started: true } });
    const r = await calliopeSupervise("up", d);
    expect(d.run).toHaveBeenCalledWith(script, [], 600_000);
    expect(r).toMatchObject({ ok: true, op: "up", result: { reachable: true, version: "1.2.1" } });
  });

  it("check and stop pass their flag; stop is ok on `stopped`, check on `reachable`", async () => {
    const c = deps({ report: { reachable: false, error: "fetch failed" }, code: 1 });
    const rc = await calliopeSupervise("check", c);
    expect(c.run).toHaveBeenCalledWith(script, ["--check"], 15_000);
    expect(rc).toMatchObject({ ok: false, error: "fetch failed" });
    const s = deps({ report: { stopped: true, pid: 42 } });
    expect((await calliopeSupervise("stop", s)).ok).toBe(true);
    expect(s.run).toHaveBeenCalledWith(script, ["--stop"], 30_000);
  });

  it("a run that prints no report is a failure that carries the log, not a silent ok", async () => {
    const d = deps({ code: 1, stderr: "[calliope-up] Python 3.11+ was not found on PATH" });
    const r = await calliopeSupervise("up", d);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exited 1 without a report/);
    expect(r.log).toContain("Python 3.11+");
  });

  it("a timeout is reported as one", async () => {
    const d = deps({ timedOut: true, code: null });
    expect((await calliopeSupervise("up", d)).error).toMatch(/did not finish within 600s/);
  });

  it("parseReport takes the last JSON line and ignores progress noise", () => {
    expect(parseReport('{"first":1}\nnoise\n{"reachable":true}\n')).toEqual({ reachable: true });
    expect(parseReport("nothing here")).toBeUndefined();
    expect(parseReport("{not json\n")).toBeUndefined();
  });
});
