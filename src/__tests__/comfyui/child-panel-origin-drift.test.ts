// #1415 — `list_packs (action:"list_templates")` failed against a stale
// COMFYUI_URL while the sidebar panel was connected and working, and the error
// made no comparison between the two addresses.
//
// #952 had already built that comparison (describeTargetDrift), and #954 had
// already made the failure name its target. Neither was the gap. The gap was
// REACHABILITY: the comparison's origin source is injected from the bridge at
// orchestrator startup, and `list_packs` — like every other headless comfyui
// tool — runs in the SPAWNED stdio child, which loads orchestrator/index.js never
// (boot.ts imports it only behind --panel-orchestrator) and has no bridge. So in
// the one process where these failures happen the source was null, the comparison
// returned "", and the reporter was told only that "a CONNECTED sidebar panel
// does not imply this address is reachable" — while the orchestrator was holding
// the answer: their panel was on :8188 and the call went to a dead COMFYUI_URL.
//
// These tests drive the CHILD's configuration: no injected source, only the
// spawn-env channel dir. Before the fix every drift assertion here fails.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => ({}),
}));

const { comfyuiFetch, setConnectedPanelOrigins } = await import("../../comfyui/fetch.js");
const { publishConnectedPanelOrigins, resetPublishedPanelOrigins } = await import(
  "../../services/panel-origin-channel.js"
);

/** The exact shape undici throws for the reporter's dead target. */
function undiciFailure(code: string, detail: string): Error {
  const cause = new Error(detail);
  (cause as { code?: string }).code = code;
  return new TypeError("fetch failed", { cause });
}

let dir = "";
const savedEnv = process.env.COMFYUI_MCP_PROGRESS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comfyui-mcp-child-drift-"));
  process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
  resetPublishedPanelOrigins();
  // The child has NO bridge — this is the state the defect lived in.
  setConnectedPanelOrigins(null);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.COMFYUI_MCP_PROGRESS_DIR;
  else process.env.COMFYUI_MCP_PROGRESS_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
  resetPublishedPanelOrigins();
  setConnectedPanelOrigins(null);
  vi.restoreAllMocks();
});

/** Drive a real comfyuiFetch network failure and return the wrapped message. */
async function failureText(target: string): Promise<string> {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    undiciFailure("ERR_INVALID_URL", "bad port"),
  );
  try {
    await comfyuiFetch(target);
    throw new Error("expected comfyuiFetch to throw");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("#1415: a spawned comfyui child names the connected panel's origin", () => {
  // The reported call, verbatim: COMFYUI_URL=http://127.0.0.1:9, panel on :8188.
  it("says DIFFERENT for the reporter's own list_templates failure", async () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    const text = await failureText("http://127.0.0.1:9/api/workflow_templates");
    expect(text).toContain("http://127.0.0.1:8188");
    expect(text).toContain("a DIFFERENT address");
    // …without losing the network diagnosis it is attached to.
    expect(text).toContain("bad port");
    expect(text).toContain("http://127.0.0.1:9/api/workflow_templates");
  });

  it("RULES OUT drift when the panel is on the same ComfyUI", async () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    const text = await failureText("http://127.0.0.1:8188/api/workflow_templates");
    expect(text).toContain("NOT a wrong-address problem");
    expect(text).not.toContain("a DIFFERENT address");
  });

  // An absent comparison is not a negative result, and the child must not invent
  // one. No panel connected → the message reads exactly as it did before.
  it("says nothing about drift when no panel has been published", async () => {
    const text = await failureText("http://127.0.0.1:9/api/workflow_templates");
    expect(text).not.toContain("a DIFFERENT address");
    expect(text).not.toContain("NOT a wrong-address problem");
    expect(text).toContain("does not imply this address is reachable");
  });

  // The stale-claim direction. A tab that disconnected must stop being quoted.
  it("stops naming a panel once it disconnects", async () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    publishConnectedPanelOrigins(dir, []);
    const text = await failureText("http://127.0.0.1:9/api/workflow_templates");
    expect(text).not.toContain("a DIFFERENT address");
    expect(text).not.toContain("8188");
  });

  // In the orchestrator process the bridge is both live and authoritative, so an
  // injected source must keep winning — the channel is the fallback, not a merge.
  it("an injected bridge source still wins over the channel", async () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    setConnectedPanelOrigins(() => ["http://10.0.0.9:8188"]);
    const text = await failureText("http://127.0.0.1:9/api/workflow_templates");
    expect(text).toContain("http://10.0.0.9:8188");
    expect(text).not.toContain("127.0.0.1:8188");
  });

  // A channel that cannot be read must cost a sentence, never the real error.
  it("still reports the real failure when the channel file is unreadable", async () => {
    rmSync(dir, { recursive: true, force: true });
    const text = await failureText("http://127.0.0.1:9/api/workflow_templates");
    expect(text).toContain("bad port");
    expect(text).toContain("http://127.0.0.1:9/api/workflow_templates");
  });
});

// The publisher runs inside a closure in the orchestrator's own startup, which no
// test can construct. What CAN be pinned is that the call sits in the function the 700ms
// timer drives — the property a future edit is most likely to break by moving it
// somewhere that runs once at startup, when no tab has connected yet.
describe("#1415 WIRING: the orchestrator publishes on its existing poll tick", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, "../../orchestrator/index.ts"), "utf8");

  it("imports the publisher", () => {
    expect(src).toMatch(
      /import \{ publishConnectedPanelOrigins \} from "\.\.\/services\/panel-origin-channel\.js";/,
    );
  });

  it("publishes the BRIDGE's server-observed origins, inside pollDownloads", () => {
    const open = src.indexOf("const pollDownloads = () => {");
    // pollDownloads' body ends exactly where the timer that drives it is created.
    const close = src.indexOf("const downloadTimer = setInterval(pollDownloads, 700);");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const body = src.slice(open, close);
    expect(body).toMatch(
      /publishConnectedPanelOrigins\(\s*progressDir,\s*bridge\.connectedServerOrigins\(\)\s*\)/,
    );
    // …and nowhere else, so this test is asking about the only call site.
    expect(src.split("publishConnectedPanelOrigins(").length - 1).toBe(1);
  });

  it("still publishes the SERVER-OBSERVED origins, not the spoofable hello claim", () => {
    // tabOrigin is hello.comfyui_url — page-JS-writable. Naming it here would put
    // a tab-chosen address into a diagnostic the reader is invited to trust.
    const open = src.indexOf("const pollDownloads = () => {");
    const close = src.indexOf("const downloadTimer = setInterval(pollDownloads, 700);");
    expect(src.slice(open, close)).not.toMatch(/publishConnectedPanelOrigins\([^)]*tabOrigin/);
  });
});
