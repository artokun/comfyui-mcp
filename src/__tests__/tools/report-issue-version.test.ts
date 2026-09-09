// #846 follow-through: the version an agent COPIES out of the ENVIRONMENT line.
//
// The ENV line is prose, and it grew a qualifying clause when the running build and
// the installed one disagree ("comfyui-mcp 0.48.18 (this process is RUNNING 0.48.18;
// 0.49.5 is now installed on disk — …)"). report_issue forwards `mcp_version`
// straight to the triage worker, which version-matches it against the fix history to
// tell the user whether upgrading already resolves their bug — the single most
// common resolution, and exactly what #846 exists to protect. A sentence where a
// version was expected defeats that match silently, and so does the WRONG version.

import { describe, expect, it, vi } from "vitest";
import {
  MCP_VERSION_LABEL,
  PANEL_VERSION_LABEL,
  normalizeReportedVersion,
} from "../../tools/report-issue.js";

const mcp = (raw: string | undefined): string | undefined =>
  normalizeReportedVersion(raw, MCP_VERSION_LABEL);
const panel = (raw: string | undefined): string | undefined =>
  normalizeReportedVersion(raw, PANEL_VERSION_LABEL);

/** The shape the ENVIRONMENT line actually renders, other components and all. */
const ENV_LINE =
  "ENVIRONMENT (live, this machine): Windows 11 · NVIDIA RTX 5090 32GB · torch 2.7.1 · " +
  "python 3.12.3 · ComfyUI 0.30.0 (LOCAL) · Backend: Claude · comfyui-mcp 0.48.18 · panel 0.11.38.";

describe("normalizeReportedVersion (#846)", () => {
  it("passes a plain version through unchanged", () => {
    expect(mcp("0.49.6")).toBe("0.49.6");
    expect(mcp(" 0.49.6 ")).toBe("0.49.6");
    expect(mcp("v0.49.6")).toBe("0.49.6");
    expect(mcp("0.50.0-rc.1")).toBe("0.50.0-rc.1");
  });

  it("reads OUR version out of a whole ENVIRONMENT line, not torch's or python's", () => {
    // The tool description tells the agent to source this field from the env line, so
    // the whole line IS a realistic input. Taking the first semver anywhere returned
    // torch 2.7.1 as the reporter's own version — wrong in a way nothing downstream
    // could detect (codex gate round 2). The LABEL is what makes this correct.
    expect(mcp(ENV_LINE)).toBe("0.48.18");
    expect(panel(ENV_LINE)).toBe("0.11.38");
    expect(mcp(ENV_LINE)).not.toBe("2.7.1");
    expect(mcp(ENV_LINE)).not.toBe("3.12.3");
    expect(mcp(ENV_LINE)).not.toBe("0.30.0");
    // The panel's own label must never be read as ours, and vice versa.
    expect(mcp("comfyui-mcp-panel 0.11.38")).toBeUndefined();
    expect(panel("comfyui-mcp-panel 0.11.38")).toBe("0.11.38");
  });

  it("extracts the RUNNING version from the drift clause, not the installed one", () => {
    // The ENV line leads with the build that is executing, and that is the build the
    // report is about. Taking the LAST version — or the largest — would re-pin the
    // issue to code nobody ran, which is the #846 harm restated.
    const clause =
      "0.48.18 (this process is RUNNING 0.48.18; 0.49.5 is now installed on disk" +
      " — restart the orchestrator to load it, and report bugs against the RUNNING version)";
    expect(mcp(clause)).toBe("0.48.18");

    // …and the form an agent ACTUALLY copies is the whole labelled segment. Matching
    // only at position 0 missed this, fell through to a fresh disk read, and returned
    // the INSTALLED version — reintroducing #846 through the fix for it.
    expect(mcp(`comfyui-mcp ${clause}`)).toBe("0.48.18");
    expect(mcp("mcp=0.49.6")).toBe("0.49.6");
    expect(mcp("comfyui-mcp 0.49.6 · panel 0.11.38")).toBe("0.49.6");
  });

  it("preserves a non-semver running version — LABELLED as well as bare (#846)", () => {
    // A real running version need not be semver, and requiring semver AFTER the label
    // was a third way of getting #846 wrong: `comfyui-mcp nightly (…RUNNING nightly;
    // 0.49.6 is now installed…)` matched nothing, fell through to a disk read, and
    // reported the INSTALLED 0.49.6 as the running version — for exactly the user
    // whose version needed the most care (codex gate round 3).
    expect(mcp("nightly")).toBe("nightly");
    expect(mcp("  dev  ")).toBe("dev");
    expect(panel("nightly")).toBe("nightly");
    expect(
      mcp(
        "comfyui-mcp nightly (this process is RUNNING nightly; 0.49.6 is now installed on disk" +
          " — restart the orchestrator to load it, and report bugs against the RUNNING version)",
      ),
    ).toBe("nightly");
    expect(mcp("comfyui-mcp 2026.08.04")).toBe("2026.08.04");
  });

  it("looks PAST a word standing where the number goes, but not into the next component", () => {
    // `MCP version: 0.48.18` puts `version` in the slot the number occupies. Taking
    // only the adjacent token dropped a perfectly good reading into the disk-read
    // fallback — #846 again (codex gate round 4).
    expect(mcp("MCP version: 0.48.18")).toBe("0.48.18");
    expect(mcp("comfyui-mcp version 0.49.6")).toBe("0.49.6");
    // …but ONLY that named filler is skipped. Scanning ahead for "the next thing
    // that looks like a version" walked straight over an indeterminate value into
    // the NEXT component's, reporting the PANEL's version as the mcp one (codex gate
    // round 6). An mcp version that cannot be determined must stay undetermined —
    // that is the whole rule this cluster is about.
    expect(mcp("comfyui-mcp unknown · panel 0.11.38.")).toBeUndefined();
    expect(mcp("comfyui-mcp could not be determined, torch 2.7.1")).toBeUndefined();
  });

  it("does not read ANOTHER product's mcp-suffixed label as ours", () => {
    expect(mcp("other-mcp 1.2.3")).toBeUndefined();
    expect(mcp("somethingmcp 1.2.3")).toBeUndefined();
  });

  it("strips the sentence-ending punctuation the ENV line leaves on the last token", () => {
    // The line ends in a full stop, so the LAST component's version arrives as
    // `0.11.38.` — which passes every shape test and then fails the worker's exact
    // version match with a dot glued on.
    expect(panel(ENV_LINE)).toBe("0.11.38");
    expect(panel("panel 0.11.38.")).toBe("0.11.38");
    expect(mcp("comfyui-mcp 0.49.6, panel 0.11.38")).toBe("0.49.6");
  });

  it("discards prose, so the caller detects a version instead of reporting a sentence", () => {
    expect(mcp("")).toBeUndefined();
    expect(mcp("   ")).toBeUndefined();
    expect(mcp("I could not find the version anywhere")).toBeUndefined();
    expect(mcp(undefined)).toBeUndefined();
    expect(mcp(0.49 as unknown as string)).toBeUndefined();
    // A key=value fragment for some OTHER key is not our version either.
    expect(mcp("torch=2.7.1")).toBeUndefined();
    // Words that STAND WHERE a version was expected are not versions. Forwarding
    // them would hand the worker something unmatchable while looking confident;
    // falling through to detection is right precisely when the agent had nothing.
    expect(mcp("unknown")).toBeUndefined();
    expect(mcp("comfyui-mcp unknown")).toBeUndefined();
    expect(mcp("comfyui-mcp is broken")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WIRING. Everything above tests `normalizeReportedVersion` directly, so every
// one of those cases stays green if `report_issue` stops CALLING it (codex gate
// P2) — and a normalizer nobody calls protects nothing. This drives the real
// registered handler and inspects the bytes that leave for the triage worker.

describe("report_issue is ARCHIVED — the version helpers stay, the wiring sends nothing", () => {
  it("registers a handler that returns the archived notice and never reaches the worker", async () => {
    const { registerReportIssueTools } = await import("../../tools/report-issue.js");
    let handler: ((args: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>) | undefined;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: typeof handler) => {
        handler = h;
      },
    } as unknown as Parameters<typeof registerReportIssueTools>[0];
    registerReportIssueTools(fakeServer);
    const calls: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...a: unknown[]) => {
      calls.push(a);
      throw new Error("must not be reached");
    }) as typeof fetch;
    try {
      const out = await handler!({ title: "t", body: "b", mcp_version: "the env line says mcp=0.52.1 panel=0.15.2" });
      const json = JSON.parse(out.content[0]?.text ?? "{}") as Record<string, unknown>;
      expect(json.archived).toBe(true);
      expect(json.filed).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
