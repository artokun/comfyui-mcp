// #1896 — `list_packs (action:"list_templates")` against an unreachable
// COMFYUI_URL while the sidebar panel was connected and working.
//
// The REFUSAL half of this was closed by #1553: the spawned comfyui child reads
// the orchestrator's panel-origin channel, so an ECONNREFUSED names both
// addresses and says which of them the panel is on. Reproducing #1896 on
// origin/main confirmed that path is complete.
//
// Its TWIN was not. An unroutable target does not always refuse. A firewall or a
// container boundary that DROPs the SYN black-holes it, and the request expires
// on the COMFYUI_MCP_HTTP_TIMEOUT_S ceiling instead — describeComfyTimeout, not
// describeComfyFetchFailure. Same child, same readable channel, same connected
// panel, and that path never asked: measured against a live channel on
// origin/main, a timed-out list_templates said nothing whatsoever about the
// panel. #1795 put list_templates on this ceiling by removing its hard-coded 8s
// signal, so it is a first-class consumer of exactly this message.
//
// Two further things that path asserted, both fixed here:
//   - "The connection was accepted but no answer arrived in time" — untrue for a
//     black-holed SYN, and contradicted by the sentence before it on a read.
//   - "confirm the server is up with get_system_stats (action:"health")" — that
//     runs in THIS process against THIS address. After a SAME-origin verdict it
//     reproduces the failure rather than diagnosing it, and invites the very
//     conclusion the comparison just ruled out.
//
// These tests drive the CHILD's configuration: no injected bridge source, only
// the spawn-env channel dir.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => ({}),
}));

const { comfyuiFetch, setConnectedPanelOrigins } = await import("../../comfyui/fetch.js");
const { publishConnectedPanelOrigins, resetPublishedPanelOrigins } = await import(
  "../../services/panel-origin-channel.js"
);

let dir = "";
const savedDir = process.env.COMFYUI_MCP_PROGRESS_DIR;
const savedBudget = process.env.COMFYUI_MCP_HTTP_TIMEOUT_S;

const PANEL = "http://127.0.0.1:8188";
/** The reporter's shape: a target this process cannot route to at all. */
const DEAD = "http://192.0.2.1:8188/api/workflow_templates";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comfyui-mcp-timeout-drift-"));
  process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
  // Small enough to keep the suite fast; the VALUE is not what is under test,
  // only the branch it drives.
  process.env.COMFYUI_MCP_HTTP_TIMEOUT_S = "0.05";
  resetPublishedPanelOrigins();
  // The child has NO bridge — the state the defect lives in.
  setConnectedPanelOrigins(null);
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.COMFYUI_MCP_PROGRESS_DIR;
  else process.env.COMFYUI_MCP_PROGRESS_DIR = savedDir;
  if (savedBudget === undefined) delete process.env.COMFYUI_MCP_HTTP_TIMEOUT_S;
  else process.env.COMFYUI_MCP_HTTP_TIMEOUT_S = savedBudget;
  rmSync(dir, { recursive: true, force: true });
  resetPublishedPanelOrigins();
  setConnectedPanelOrigins(null);
  vi.restoreAllMocks();
});

/**
 * Drive a real ceiling timeout through comfyuiFetch and return the message.
 *
 * The mock never settles on its own and only rejects when OUR signal aborts —
 * so this exercises the same `init.signal === undefined && isTimeoutAbort(err)`
 * branch production takes, rather than fabricating a TimeoutError.
 */
async function timeoutText(target: string): Promise<string> {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // would hang — asserted against below
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) as Promise<Response>,
  );
  try {
    await comfyuiFetch(target);
    throw new Error("expected comfyuiFetch to time out");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("#1896: a TIMED-OUT ComfyUI call makes the same panel comparison a refused one does", () => {
  it("names the connected panel's DIFFERENT origin instead of staying silent", async () => {
    publishConnectedPanelOrigins(dir, [PANEL]);
    const text = await timeoutText(DEAD);
    expect(text).toContain(PANEL);
    expect(text).toContain("a DIFFERENT address");
    expect(text).toContain("Point COMFYUI_URL");
    // …without losing the timeout diagnosis it is attached to.
    expect(text).toContain("No reply from ComfyUI within");
    expect(text).toContain(DEAD);
  });

  it("RULES OUT drift when the panel is on the very address that timed out", async () => {
    publishConnectedPanelOrigins(dir, ["http://192.0.2.1:8188"]);
    const text = await timeoutText(DEAD);
    expect(text).toContain("NOT a wrong-address problem");
    expect(text).not.toContain("a DIFFERENT address");
  });

  // An absent comparison is not a negative result. No panel → the message must
  // not invent one.
  it("says nothing about drift when no panel has been published", async () => {
    const text = await timeoutText(DEAD);
    expect(text).not.toContain("a DIFFERENT address");
    expect(text).not.toContain("NOT a wrong-address problem");
  });

  // Parity with the transport path: where a bridge IS in-process it is both
  // fresher and authoritative, so it must keep winning over the channel.
  it("an injected bridge source still wins over the channel", async () => {
    publishConnectedPanelOrigins(dir, [PANEL]);
    setConnectedPanelOrigins(() => ["http://10.0.0.9:8188"]);
    const text = await timeoutText(DEAD);
    expect(text).toContain("http://10.0.0.9:8188");
    expect(text).not.toContain(PANEL);
  });
});

describe("#1896: the timeout message says only what a timeout proves", () => {
  it("does NOT claim the connection was accepted", async () => {
    const text = await timeoutText(DEAD);
    // A black-holed SYN expires on this same ceiling having established nothing.
    expect(text).not.toContain("The connection was accepted");
    expect(text).toContain("Whether a connection was ever established is NOT known");
  });

  it("still names the target, the budget and the method", async () => {
    const text = await timeoutText(DEAD);
    expect(text).toContain("No reply from ComfyUI within 0.05s");
    expect(text).toContain("(GET)");
  });
});

describe("#1896: the advice does not send the caller back down the road that just failed", () => {
  it("stops asking whether the server is up once drift is RULED OUT", async () => {
    publishConnectedPanelOrigins(dir, ["http://192.0.2.1:8188"]);
    const text = await timeoutText(DEAD);
    // The comparison has just established a browser is connected to this origin,
    // so "confirm it is up" sends the caller after a question already answered.
    expect(text).not.toContain("Confirm it is up with get_system_stats");
    expect(text).toContain("The address itself is not what is wrong");
    expect(text).toContain("a browser is connected to that origin");
  });

  // The health check is RE-AIMED, not suppressed. Dropping it would have been an
  // overclaim: a SAME verdict compares ORIGINS, and a server that is up and
  // answering the browser can still stall one route (/object_info mid-decode),
  // in which case /system_stats answers fine and is the most informative call
  // available. So it must still be offered, as a discriminator.
  it("keeps the health check, as the thing that tells the remaining cases apart", async () => {
    publishConnectedPanelOrigins(dir, ["http://192.0.2.1:8188"]);
    const text = await timeoutText(DEAD);
    expect(text).toContain('get_system_stats (action:"health")');
    expect(text).toContain("if it fails from here too");
    expect(text).toContain("if it succeeds");
    // …and it must not assert the outcome of that call in advance.
    expect(text).not.toContain("fails the same way");
    expect(text).not.toContain("will NOT add anything");
  });

  // The overclaim deliberately NOT made: a connected browser proves something
  // answers that origin, never that it would answer THIS process quickly. So the
  // "simply slow" option has to survive the SAME verdict.
  it("keeps the timeout budget on the table even when drift is ruled out", async () => {
    publishConnectedPanelOrigins(dir, ["http://192.0.2.1:8188"]);
    const text = await timeoutText(DEAD);
    expect(text).toContain("COMFYUI_MCP_HTTP_TIMEOUT_S");
  });

  it("leaves the DIFFERENT and UNKNOWN tails alone", async () => {
    publishConnectedPanelOrigins(dir, [PANEL]);
    expect(await timeoutText(DEAD)).toContain("Confirm it is up with get_system_stats");
    publishConnectedPanelOrigins(dir, []);
    expect(await timeoutText(DEAD)).toContain("Confirm it is up with get_system_stats");
  });
});

// The TRANSPORT path shares the tail. #1553 already made it name the panel; what
// it still did was hand a ruled-out caller two more calls down the dead path.
describe("#1896: the REFUSAL path's advice follows the same verdict", () => {
  async function refusalText(target: string): Promise<string> {
    const cause = new Error("connect ECONNREFUSED 192.0.2.1:8188");
    (cause as { code?: string }).code = "ECONNREFUSED";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed", { cause }));
    try {
      await comfyuiFetch(target);
      throw new Error("expected comfyuiFetch to throw");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  it("re-aims the health check when the panel is on the same origin", async () => {
    publishConnectedPanelOrigins(dir, ["http://192.0.2.1:8188"]);
    const text = await refusalText(DEAD);
    expect(text).toContain("NOT a wrong-address problem");
    expect(text).not.toContain("confirm the server is up with get_system_stats");
    expect(text).toContain("The address itself is not what is wrong");
    expect(text).toContain("if it fails from here too");
    // install_comfyui (action:"environment") is NOT described as failing: its
    // /system_stats read is inside a try, so it still reports the resolved
    // target on an unreachable server.
    expect(text).toContain('install_comfyui (action:"environment")');
  });

  it("keeps the original tail when the panel is elsewhere, or unknown", async () => {
    publishConnectedPanelOrigins(dir, [PANEL]);
    expect(await refusalText(DEAD)).toContain(
      "confirm the server is up with get_system_stats",
    );
    publishConnectedPanelOrigins(dir, []);
    expect(await refusalText(DEAD)).toContain(
      "confirm the server is up with get_system_stats",
    );
  });
});
