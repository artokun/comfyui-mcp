// The cross-process AGENT IDENTITY channel — which LLM is driving the panel
// agent, published by the orchestrator and read by report_issue in the comfyui
// MCP subprocess (services/agent-identity.ts).
//
// What these pin is the failure mode the channel exists to prevent: a report
// attributed to the WRONG model, or attributed at all when we do not actually
// know. Every "we don't know" input — no env var, no file, corrupt file, a
// payload with no backend — must read as undefined and leave the body untouched,
// because a body that says nothing is honest and a body that names the wrong
// model is not.

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_IDENTITY_ENV,
  agentIdentityPath,
  agentLabel,
  formatAgentIdentity,
  publishAgentIdentity,
  readAgentIdentity,
  stampAgentIdentity,
} from "../../services/agent-identity.js";

const DIR = mkdtempSync(join(tmpdir(), "cmcp-agent-identity-"));
const saved = process.env[AGENT_IDENTITY_ENV];
const savedData = process.env.COMFYUI_MCP_DATA_DIR;

afterEach(() => {
  if (saved === undefined) delete process.env[AGENT_IDENTITY_ENV];
  else process.env[AGENT_IDENTITY_ENV] = saved;
  if (savedData === undefined) delete process.env.COMFYUI_MCP_DATA_DIR;
  else process.env.COMFYUI_MCP_DATA_DIR = savedData;
  try {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  } catch {
    /* best-effort */
  }
});

describe("agentIdentityPath", () => {
  it("is keyed by BOTH the bridge port and the agent key", () => {
    process.env.COMFYUI_MCP_DATA_DIR = DIR;
    const a = agentIdentityPath(9180, "orchestrator::claude");
    const b = agentIdentityPath(9190, "orchestrator::claude");
    const c = agentIdentityPath(9180, "orchestrator::ollama");
    // Two ComfyUI instances on one machine share the agent key (it carries no
    // port — see session-store.ts), so a port-less path would have one
    // instance's identity stamped onto the other instance's reports.
    expect(a).not.toBe(b);
    // Two providers live at once (#884) is the ordinary case, not an edge one.
    expect(a).not.toBe(c);
  });

  it("reduces the agent key to a filename-safe token", () => {
    process.env.COMFYUI_MCP_DATA_DIR = DIR;
    const p = agentIdentityPath(9180, "orchestrator::claude");
    expect(p.endsWith("identity-9180-orchestrator_claude.json")).toBe(true);
    // `::` is the ordinary separator, but nothing downstream validates a backend
    // id, so a path separator arriving in a key must not escape the directory.
    const evil = agentIdentityPath(9180, "../../etc/passwd");
    expect(evil.includes("..")).toBe(false);
  });
});

describe("publish → read round trip", () => {
  it("round-trips the chips and stamps a write time", () => {
    const p = join(DIR, "identity.json");
    expect(publishAgentIdentity(p, { backend: "ollama", model: "gemma3:4b", effort: "low" })).toBe(
      true,
    );
    const got = readAgentIdentity(p);
    expect(got?.backend).toBe("ollama");
    expect(got?.model).toBe("gemma3:4b");
    expect(got?.effort).toBe("low");
    expect(typeof got?.updated).toBe("number");
  });

  it("republishing replaces the previous identity (a live model switch)", () => {
    const p = join(DIR, "identity.json");
    publishAgentIdentity(p, { backend: "claude", model: "claude-opus-4-5" });
    publishAgentIdentity(p, { backend: "claude", model: "claude-haiku-4-5" });
    // setModel does not restart the session, so the SECOND value is the one the
    // running turn uses — reading a stale first write would attribute the report
    // to the model the user switched away from.
    expect(readAgentIdentity(p)?.model).toBe("claude-haiku-4-5");
  });

  it("reads from the env var by default", () => {
    const p = join(DIR, "identity.json");
    publishAgentIdentity(p, { backend: "kimi", model: "kimi-k2-thinking" });
    process.env[AGENT_IDENTITY_ENV] = p;
    expect(readAgentIdentity()?.backend).toBe("kimi");
  });

  it("does NOT age out — a long turn is still the turn that is running", () => {
    const p = join(DIR, "identity.json");
    // An hour-old write. The identity is published when a turn STARTS, and a
    // turn can run for hours before its agent files a report; a TTL here would
    // silently drop attribution for exactly the longest sessions.
    writeFileSync(
      p,
      JSON.stringify({ backend: "codex", model: "gpt-5.6", updated: Date.now() - 3_600_000 }),
      "utf8",
    );
    expect(readAgentIdentity(p)?.model).toBe("gpt-5.6");
  });
});

describe("an unknown identity stays unknown", () => {
  it("returns undefined for no env var, a missing file, garbage, or no backend", () => {
    delete process.env[AGENT_IDENTITY_ENV];
    expect(readAgentIdentity()).toBeUndefined(); // every non-panel spawn
    expect(readAgentIdentity(join(DIR, "nope.json"))).toBeUndefined();

    const bad = join(DIR, "bad.json");
    writeFileSync(bad, "{not json", "utf8");
    expect(readAgentIdentity(bad)).toBeUndefined();

    // A torn/partial write, or a future writer that changed the shape: no
    // backend means we cannot name the provider, so we name nothing.
    for (const payload of ["null", '"claude"', "[]", "{}", '{"backend":"   "}', '{"model":"x"}']) {
      const f = join(DIR, "shape.json");
      writeFileSync(f, payload, "utf8");
      expect(readAgentIdentity(f), payload).toBeUndefined();
    }
  });

  it("survives a non-string model/effort without inventing one", () => {
    const f = join(DIR, "types.json");
    writeFileSync(f, JSON.stringify({ backend: "grok", model: 42, effort: {} }), "utf8");
    const got = readAgentIdentity(f);
    expect(got?.backend).toBe("grok");
    expect(got?.model).toBeUndefined();
    expect(got?.effort).toBeUndefined();
  });
});

describe("stampAgentIdentity", () => {
  const identity = { backend: "ollama", model: "gemma3:4b", effort: "low" };

  it("names the provider AND the model, and says it was not self-reported", () => {
    const out = stampAgentIdentity("It broke.", identity);
    expect(out).toContain("It broke.");
    expect(out).toContain("ollama");
    expect(out).toContain("gemma3:4b");
    // The value of the line is that a reader can trust it the way they trust the
    // version line — so it has to say who put it there.
    expect(out).toContain("not self-reported");
    // Machine-readable form for after-the-fact analysis across many issues.
    expect(out).toContain("<!-- reporter-agent: backend=ollama model=gemma3:4b effort=low -->");
  });

  it("stamps a body that QUOTES another issue's stamp — with THIS model (gate P1)", () => {
    // Quoting a related issue is ordinary agent behaviour, and every stamped
    // issue in the tracker carries the marker as quotable text. Treating that
    // marker as "already stamped" filed the report under the QUOTED model's
    // name, inside a sentence vouching the attribution is mechanical — the
    // exact mis-attribution this module exists to prevent.
    const quoting =
      "Related to #1234, whose body reads:\n" +
      "> Filed from the ComfyUI panel by **claude** · model `claude-opus-5`\n" +
      "> <!-- reporter-agent: backend=claude model=claude-opus-5 -->";
    const out = stampAgentIdentity(quoting, identity);
    expect(out).toContain("gemma3:4b");
    expect(out.trimEnd().endsWith("-->")).toBe(true);
    // EXACTLY ONE live marker, and it is this report's: an analysis pass
    // counting attributions across the tracker cannot read a quotation as a
    // second reporter.
    expect(out.match(/<!-- reporter-agent:/g)?.length).toBe(1);
    expect(out).toContain("<!-- reporter-agent: backend=ollama model=gemma3:4b effort=low -->");
    // The quoted line survives, readable, as a quotation.
    expect(out).toContain("<!-- quoted-reporter-agent: backend=claude model=claude-opus-5 -->");
  });

  it("has no 'already stamped' shortcut — the stamp is always this call's", () => {
    // Nothing in a body can establish that WE stamped it; the one caller passes
    // the raw argument and forwards the result, so a double-stamp is not
    // reachable. Stamping unconditionally is what makes suppression impossible.
    const once = stampAgentIdentity("It broke.", identity);
    const twice = stampAgentIdentity(once, { backend: "claude", model: "claude-opus-4-5" });
    expect(twice).toContain("claude-opus-4-5");
    expect(twice.match(/<!-- reporter-agent:/g)?.length).toBe(1);
  });

  it("passes the body through untouched when there is no identity", () => {
    expect(stampAgentIdentity("It broke.", undefined)).toBe("It broke.");
  });

  it("states an unreported model rather than omitting the field", () => {
    const out = stampAgentIdentity("b", { backend: "pi" });
    expect(out).toContain("_unreported_");
    expect(out).toContain("model=unknown");
    // A provider with no model chip and a report filed before this shipped are
    // different facts; dropping the field silently makes them read the same.
    expect(formatAgentIdentity({ backend: "pi" })).toContain("unreported");
  });
});

describe("agentLabel", () => {
  it("is per-PROVIDER, so the label set stays bounded", () => {
    expect(agentLabel({ backend: "ollama", model: "gemma3:4b" })).toBe("agent:ollama");
    expect(agentLabel({ backend: "ollama", model: "qwen3:30b" })).toBe("agent:ollama");
  });
});
