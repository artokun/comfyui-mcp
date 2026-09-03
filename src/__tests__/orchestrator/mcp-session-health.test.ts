// #1524 — a session that comes up WITHOUT one of its MCP servers must say so.
//
// The reported failure: mid-session both MCP servers dropped, `comfyui` came back,
// and all 92 `panel_*` tools did not. The orchestrator stayed up and kept its
// ports, the panel looked healthy, and the agent spent the rest of a six-hour
// session unable to touch the user's canvas — with no error anywhere. The reporter
// established it by hand: they noticed a tool-list diff and then probed with
// `ToolSearch` twice.
//
// The harness had already told us. Every Claude session opens with a `system`/`init`
// message carrying `mcp_servers: {name, status}[]`; `route()` read the session id
// off it and discarded the rest. Verified against the installed agent SDK (0.3.197)
// with one server of each kind configured, the report covers BOTH transports the
// panel uses:
//
//   [{"name":"deadstdio","status":"failed"},{"name":"panel","status":"connected"}]
//
// — the in-process `createSdkMcpServer` panel server included. That is what makes
// this worth wiring: it fires on the reporter's symptom without needing to know the
// cause, which is still open.
//
// The direction that matters most here is the QUIET one. A false "your tools are
// gone" on a healthy session is worse than the silence it replaces, so every
// ambiguity resolves to saying nothing.

import { describe, expect, it } from "vitest";
import {
  degradedMcpNotice,
  emptyToolsMcpNotice,
  serversWithoutTools,
  inspectMcpServers,
  reconnectableMcpStatus,
  recoveredMcpNotice,
  reportedFromCodexMcpListing,
  unrecoveredMcpNotice,
} from "../../orchestrator/mcp-session-health.js";

const CONFIGURED = ["comfyui", "panel"];

const HEALTHY = { degraded: [], pending: [] };

describe("inspectMcpServers — what the session reports vs what it was given", () => {
  it("says nothing when every configured server connected", () => {
    expect(
      inspectMcpServers(CONFIGURED, [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ]),
    ).toEqual(HEALTHY);
  });

  it("names a server the session reports as failed", () => {
    // The reporter's shape: one half of the pair back, the other not.
    expect(
      inspectMcpServers(CONFIGURED, [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ]),
    ).toEqual({ degraded: [{ name: "panel", status: "failed" }], pending: [] });
  });

  it("names a server MISSING from a populated report", () => {
    // A connection that fails before the server is advertised is absent, not
    // failed. Both readings of the reporter's evidence land here: their
    // `ToolSearch` found the panel server genuinely gone from the session, not
    // merely un-indexed.
    expect(inspectMcpServers(CONFIGURED, [{ name: "comfyui", status: "connected" }])).toEqual({
      degraded: [{ name: "panel", status: null }],
      pending: [],
    });
  });

  it("says nothing when the report is absent or empty", () => {
    // A harness that does not populate the field tells us nothing about our
    // servers. Reading its silence as failure would fire on EVERY healthy
    // session — the one outcome worse than the bug being fixed.
    expect(inspectMcpServers(CONFIGURED, undefined)).toEqual(HEALTHY);
    expect(inspectMcpServers(CONFIGURED, [])).toEqual(HEALTHY);
  });

  it("treats an unrecognized status as connected", () => {
    // The status vocabulary belongs to the CLI and can grow. A new value must
    // not become an alarm here; only the ones that DO mean unusable are alarms.
    expect(
      inspectMcpServers(CONFIGURED, [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "some-future-status" },
      ]),
    ).toEqual(HEALTHY);
  });

  it("catches the failure vocabulary the CLI actually uses", () => {
    for (const status of ["failed", "needs-auth", "error", "disabled", "FAILED"]) {
      expect(inspectMcpServers(["panel"], [{ name: "panel", status }]).degraded).toHaveLength(1);
    }
  });

  it("holds a STILL-CONNECTING server apart from a failed one", () => {
    // `pending` is settled-later, not failed: server startup does not block the
    // session, so a slow server is legitimately pending in the init report and
    // connected a moment after. Reporting it would fire on healthy sessions…
    const health = inspectMcpServers(CONFIGURED, [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "pending" },
    ]);
    expect(health.degraded).toEqual([]);
    // …and dropping it would be the silence this whole change exists to end:
    // init is the only report the session pushes, so a pending server that goes
    // on to FAIL would never be mentioned anywhere. It is carried, not ignored.
    expect(health.pending).toEqual(["panel"]);
  });

  it("ignores servers we did not configure", () => {
    // `strictMcpConfig: true` means the set should be exactly ours, but a report
    // naming something else is not this message's business either way.
    expect(
      inspectMcpServers(["comfyui"], [
        { name: "comfyui", status: "connected" },
        { name: "somebody-elses", status: "failed" },
      ]),
    ).toEqual(HEALTHY);
  });
});

describe("degradedMcpNotice — states the observation, and stops", () => {
  it("is empty when nothing is degraded", () => {
    expect(degradedMcpNotice([])).toBe("");
  });

  it("names each server and its reported state", () => {
    const note = degradedMcpNotice([
      { name: "panel", status: "failed" },
      { name: "comfyui", status: null },
    ]);
    expect(note).toContain("panel");
    expect(note).toContain("failed");
    expect(note).toContain("comfyui");
    expect(note).toContain("not reported");
  });

  it("says the loss lasts until the server connects, without promising recovery works", () => {
    // Same discipline as NO_PANEL_TOOLS_OVERRIDE: a cause that persists survives
    // a reconnect and a restart alike, so "recovery restores them" is a claim
    // this cannot make. What it CAN say is what the session itself will do.
    const note = degradedMcpNotice([{ name: "panel", status: "failed" }]);
    expect(note).toMatch(/until the server connects/);
    expect(note).toMatch(/reconnect is attempted/);
    expect(note).toMatch(/[Ww]hether either succeeds depends on why this one did not/);
    expect(note).not.toMatch(/will fix|will restore|restores them/);
  });

  it("does not diagnose a cause it does not know", () => {
    // WHY a server goes missing is still open on #1524, and the candidates need
    // different fixes. Guessing here would be the same defect this replaces,
    // wearing the fix's clothes.
    const note = degradedMcpNotice([{ name: "panel", status: "failed" }]);
    expect(note).not.toMatch(/because|caused by|due to/i);
  });
});

describe("reconnectableMcpStatus — which failures an automatic retry can speak to", () => {
  it("retries the drop shapes", () => {
    expect(reconnectableMcpStatus("failed")).toBe(true);
    expect(reconnectableMcpStatus("error")).toBe(true);
    expect(reconnectableMcpStatus("FAILED")).toBe(true);
    // Absent from a populated report — the connection died before the server
    // was advertised — is a drop shape too.
    expect(reconnectableMcpStatus(null)).toBe(true);
  });

  it("does not retry what only the user or an explicit switch can change", () => {
    // needs-auth waits on the user completing auth; disabled is a deliberate
    // off switch. Retrying either claims effort that cannot land, or overrides
    // intent.
    expect(reconnectableMcpStatus("needs-auth")).toBe(false);
    expect(reconnectableMcpStatus("disabled")).toBe(false);
  });
});

describe("unrecoveredMcpNotice — says which dead end this is, and stops", () => {
  it("is empty when nothing is degraded", () => {
    expect(unrecoveredMcpNotice([], "reconnect-failed")).toBe("");
  });

  it("names the failed reconnect when one was tried", () => {
    const note = unrecoveredMcpNotice([{ name: "panel", status: "failed" }], "reconnect-failed");
    expect(note).toContain("panel");
    expect(note).toMatch(/automatic reconnect did not bring it back/);
  });

  it("claims no outcome when the reconnect's verdict could not be read back (#1228)", () => {
    // "We tried and it failed" is only sayable off the post-attempt status
    // re-read; when that read is unavailable the notice reports the attempt
    // without asserting an outcome nobody checked.
    const note = unrecoveredMcpNotice([{ name: "panel", status: "failed" }], "unverified");
    expect(note).toContain("panel");
    expect(note).toMatch(/reconnect was attempted/);
    expect(note).toMatch(/could not be read back/);
    expect(note).not.toMatch(/did not bring/);
  });

  it("says when nothing was attempted, and why", () => {
    // "We tried and failed" and "there was nothing to try" are different
    // situations; the reader must not have to guess which one they are in.
    const notRetriable = unrecoveredMcpNotice(
      [{ name: "panel", status: "needs-auth" }],
      "not-retriable",
    );
    expect(notRetriable).toMatch(/cannot clear this status/);
    expect(notRetriable).not.toMatch(/did not bring/);
    const unsupported = unrecoveredMcpNotice([{ name: "panel", status: "failed" }], "unsupported");
    expect(unsupported).toMatch(/no reconnect to ask for/);
    expect(unsupported).not.toMatch(/did not bring/);
  });

  it("does not promise a new session fixes it", () => {
    const note = unrecoveredMcpNotice([{ name: "panel", status: "failed" }], "reconnect-failed");
    expect(note).toMatch(/whether it succeeds depends on why the server is down/);
    expect(note).not.toMatch(/will fix|will restore/i);
  });
});

describe("recoveredMcpNotice — claims only what the status poll reported", () => {
  it("is empty when nothing came back", () => {
    expect(recoveredMcpNotice([], true)).toBe("");
  });

  it("credits the reconnect when the reconnect did it", () => {
    const note = recoveredMcpNotice(["panel"], true);
    expect(note).toContain("panel");
    expect(note).toMatch(/reconnect brought it back/);
    expect(note).toMatch(/available to the agent/);
  });

  it("does not take credit for a server the harness healed itself", () => {
    // The reporter watched `comfyui` come back on the harness's own reconnect
    // while `panel` stayed down. Claiming that recovery would be the same
    // dishonesty as claiming the drop was diagnosed.
    const note = recoveredMcpNotice(["comfyui"], false);
    expect(note).toMatch(/connected again/);
    expect(note).not.toMatch(/reconnect brought/);
  });
});

describe("reportedFromCodexMcpListing — live runtimeStatus, not cached tools (#1524)", () => {
  const CACHED = { panel_graph_outline: {}, panel_set_todo: {} };

  it("says nothing when the listing is absent or empty", () => {
    expect(reportedFromCodexMcpListing(undefined)).toBeUndefined();
    expect(reportedFromCodexMcpListing([])).toBeUndefined();
  });

  it("reads runtimeStatus=connected as connected", () => {
    expect(
      reportedFromCodexMcpListing([
        { name: "comfyui", runtimeStatus: "connected", tools: { list_tools: {} } },
        { name: "panel", runtimeStatus: "connected", tools: CACHED },
      ]),
    ).toEqual([
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "connected" },
    ]);
  });

  it("treats runtimeStatus=failed as a drop even when tools are still cached", () => {
    // The live app-server row after a dropped HTTP session: panel is named,
    // tools inventory is cached, runtimeStatus is failed. Cached tools must
    // not look like connected — that is the ALL_TOOLS gap in the report.
    const reported = reportedFromCodexMcpListing([
      { name: "comfyui", runtimeStatus: "connected", tools: { list_tools: {} } },
      { name: "panel", runtimeStatus: "failed", tools: CACHED },
    ]);
    expect(inspectMcpServers(CONFIGURED, reported)).toEqual({
      degraded: [{ name: "panel", status: "failed" }],
      pending: [],
    });
    expect(reconnectableMcpStatus("failed")).toBe(true);
  });

  it("treats runtimeStatus=failed with omitted tools as a drop", () => {
    const reported = reportedFromCodexMcpListing([
      { name: "comfyui", runtimeStatus: "connected" },
      { name: "panel", runtimeStatus: "failed" },
    ]);
    expect(inspectMcpServers(CONFIGURED, reported).degraded).toEqual([
      { name: "panel", status: "failed" },
    ]);
  });

  it("maps the rest of the live runtimeStatus vocabulary", () => {
    expect(reportedFromCodexMcpListing([{ name: "panel", runtimeStatus: "starting" }])).toEqual([
      { name: "panel", status: "pending" },
    ]);
    expect(
      reportedFromCodexMcpListing([{ name: "panel", runtimeStatus: "authenticationRequired" }]),
    ).toEqual([{ name: "panel", status: "needs-auth" }]);
    expect(reportedFromCodexMcpListing([{ name: "panel", runtimeStatus: "disabled" }])).toEqual([
      { name: "panel", status: "disabled" },
    ]);
    expect(reportedFromCodexMcpListing([{ name: "panel", runtimeStatus: "notStarted" }])).toEqual([
      { name: "panel", status: "failed" },
    ]);
    expect(reportedFromCodexMcpListing([{ name: "panel", runtimeStatus: "cancelled" }])).toEqual([
      { name: "panel", status: "failed" },
    ]);
  });

  it("starting with an empty tools map is pending, not a false drop", () => {
    const reported = reportedFromCodexMcpListing([
      { name: "panel", runtimeStatus: "starting", tools: {} },
    ]);
    expect(inspectMcpServers(["panel"], reported)).toEqual({ degraded: [], pending: ["panel"] });
  });

  it("treats a server MISSING from a populated listing as absent", () => {
    const reported = reportedFromCodexMcpListing([
      { name: "comfyui", runtimeStatus: "connected", tools: { list_tools: {} } },
    ]);
    expect(inspectMcpServers(CONFIGURED, reported)).toEqual({
      degraded: [{ name: "panel", status: null }],
      pending: [],
    });
  });

  it("empty tools is a drop only when runtimeStatus is omitted", () => {
    // Older app-servers, or a poll without threadId (runtimeStatus is null).
    expect(reportedFromCodexMcpListing([{ name: "panel", tools: {} }])).toEqual([
      { name: "panel", status: "failed" },
    ]);
    expect(reportedFromCodexMcpListing([{ name: "panel", tools: [] }])).toEqual([
      { name: "panel", status: "failed" },
    ]);
  });

  it("does not invent a failure from a listing that omits runtimeStatus and tools", () => {
    expect(reportedFromCodexMcpListing([{ name: "panel" }])).toEqual([
      { name: "panel", status: "connected" },
    ]);
  });
});

// #2742 — the variant `inspectMcpServers` cannot see. Five reports across
// 0.52.174-0.52.178: `panel=connected` every session, zero panel_* tools reaching
// the model, no notice. The init message carries the tool list; the emptiness was
// always there to read.
describe("a server that connected and contributed NO tools (#2742)", () => {
  const CONNECTED = [
    { name: "comfyui", status: "connected" },
    { name: "panel", status: "connected" },
  ];

  it("names the empty server", () => {
    expect(
      serversWithoutTools(["comfyui", "panel"], CONNECTED, [
        "Read",
        "mcp__comfyui__generate_image",
      ]),
    ).toEqual(["panel"]);
  });

  it("says nothing when every configured server contributed at least one tool", () => {
    expect(
      serversWithoutTools(["comfyui", "panel"], CONNECTED, [
        "mcp__comfyui__generate_image",
        "mcp__panel__panel_graph_outline",
      ]),
    ).toEqual([]);
  });

  it("is not fooled by a server whose name is a PREFIX of another's", () => {
    // `mcp__panel_extra__x` must not satisfy `panel`, or a live server could mask
    // an empty one whose name it happens to begin with.
    expect(
      serversWithoutTools(["panel"], [{ name: "panel", status: "connected" }], [
        "mcp__panel_extra__x",
      ]),
    ).toEqual(["panel"]);
  });

  it("stays silent when the harness lists no MCP tools at all", () => {
    // Indistinguishable from a harness that simply does not put MCP tools in this
    // list, and a false "your tools are gone" on every healthy session is worse
    // than the blind spot. Documented on the function.
    expect(serversWithoutTools(["comfyui", "panel"], CONNECTED, ["Read", "Bash"])).toEqual([]);
  });

  it("stays silent with no tool list, or an empty one", () => {
    expect(serversWithoutTools(["panel"], CONNECTED, undefined)).toEqual([]);
    expect(serversWithoutTools(["panel"], CONNECTED, [])).toEqual([]);
  });

  it("does not double-report a server that is already degraded or pending", () => {
    // It has no tools because it is not up. inspectMcpServers already says so, and
    // two notices in different words read as two faults.
    expect(
      serversWithoutTools(
        ["comfyui", "panel"],
        [
          { name: "comfyui", status: "connected" },
          { name: "panel", status: "failed" },
        ],
        ["mcp__comfyui__generate_image"],
      ),
    ).toEqual([]);
    expect(
      serversWithoutTools(
        ["comfyui", "panel"],
        [
          { name: "comfyui", status: "connected" },
          { name: "panel", status: "pending" },
        ],
        ["mcp__comfyui__generate_image"],
      ),
    ).toEqual([]);
  });
});

describe("the connected-but-empty notice (#2742)", () => {
  it("is empty for an empty list", () => {
    expect(emptyToolsMcpNotice([])).toBe("");
  });

  it("does NOT describe it as a session that started without the server", () => {
    // degradedMcpNotice's wording would send the reader hunting a connection
    // failure that did not happen — the distinction the whole report turns on.
    const msg = emptyToolsMcpNotice(["panel"]);
    expect(msg).not.toContain("started without");
    expect(msg).toContain("connected");
    expect(msg).toContain("ZERO tools");
  });

  it("names the recovery that works and the one that does not", () => {
    const msg = emptyToolsMcpNotice(["panel"]);
    expect(msg).toContain("Disconnect");
    expect(msg).toContain("orchestrator process");
  });

  it("does not claim to know why", () => {
    expect(emptyToolsMcpNotice(["panel"])).toContain("observation only");
  });
});
