// #1077 Finding 1 — a relay-backend session could NEVER adopt a workflow fence.
//
// The workflow-instance fence is scoped to the connection's server-observed
// `Origin`. The primary loopback listener reads it off the handshake and passes
// it through; `attachRelayConnection(sock)` passed nothing at all, so every
// relay-multiplexed connection had `serverOrigin === undefined`,
// `workflowIdentityParts()` returned undefined, and the validator refused
// unconditionally. `panel_graph_outline` and
// `panel_set_workflow_target({mode:"current"})` were permanently stuck for the
// whole session: the reporter hard-refreshed, closed and reopened the tab, and
// finally traced it to source — nothing they could do would have worked.
//
// The reporter marked this upstream-only, expecting the relay protocol to have
// to forward the browser's handshake Origin. It does not: the Origin identifies
// WHERE THE PANEL PAGE IS SERVED FROM, and that is the ComfyUI the session is
// already pointed at. `setupRelayBridge` holds that URL, so it supplies it.
//
// DERIVED, not observed — it asserts what the loopback path proves. On one
// machine pointed at one ComfyUI those are the same fact, and the alternative it
// replaces is a fence nobody can ever adopt.

import { describe, expect, it } from "vitest";
import { UiBridge } from "../../services/ui-bridge.js";
import { relayIdentityOrigin } from "../../services/secure-bridge.js";

describe("relayIdentityOrigin (#1077)", () => {
  it.each([
    ["http://127.0.0.1:8188", "http://127.0.0.1:8188"],
    ["https://abc-8188.proxy.runpod.net", "https://abc-8188.proxy.runpod.net"],
    // A path, a trailing slash and a query are not part of an Origin.
    ["https://host.example/comfy/?x=1", "https://host.example"],
    // Default ports are omitted, exactly as a browser omits them — otherwise the
    // derived origin would never match one an observed handshake produced.
    ["https://host.example:443/", "https://host.example"],
    ["http://host.example:80", "http://host.example"],
    // Case-normalised on the host.
    ["http://LOCALHOST:8188", "http://localhost:8188"],
  ])("derives %s -> %s", (url, expected) => {
    expect(relayIdentityOrigin(url)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["not a url", "unparseable"],
    [undefined, "absent"],
  ])("returns undefined for %s input (%s)", (url) => {
    // A WRONG origin is worse than none: none refuses adoption visibly, while a
    // wrong one scopes the fence to an identity no other transport reproduces.
    expect(relayIdentityOrigin(url as string | undefined)).toBeUndefined();
  });

  it("does not invent an origin for a scheme that has none", () => {
    // `new URL("file:///x").origin` is the string "null" — which is truthy, and
    // would sail through as a real origin.
    expect(relayIdentityOrigin("file:///c:/comfy/index.html")).toBeUndefined();
  });
});

/** The minimum of `BridgeSocket` the connection path touches. */
function fakeSocket() {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  return {
    readyState: 1,
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
    close() {},
    terminate() {},
    ping() {},
    on(event: string, listener: (...a: unknown[]) => void) {
      handlers[event] = listener;
    },
    emit(event: string, ...a: unknown[]) {
      handlers[event]?.(...a);
    },
  };
}

describe("attachRelayConnection carries the origin to the fence (#1077)", () => {
  const ORIGIN = "https://abc-8188.proxy.runpod.net";

  function attach(origin?: string) {
    const bridge = new UiBridge(0);
    const sock = fakeSocket();
    bridge.attachRelayConnection(sock as never, origin);
    // The panel announces itself exactly as it does over loopback.
    sock.emit(
      "message",
      JSON.stringify({ type: "hello", tab_id: "tab-1", title: "wf" }),
    );
    return { bridge, sock };
  }

  it("reports the supplied origin for the attached tab", () => {
    const { bridge } = attach(ORIGIN);
    expect(bridge.tabServerOrigin("tab-1")).toBe(ORIGIN);
  });

  it("still reports NO origin when none is supplied — the pre-fix behaviour", () => {
    // The regression guard for the fix itself: if the call site stops passing the
    // origin, this is what the session goes back to, and the fence dies again.
    const { bridge } = attach(undefined);
    expect(bridge.tabServerOrigin("tab-1")).toBeUndefined();
  });
});

// THE WIRING. Both halves above pass with `setupRelayBridge` still calling
// `attachRelayConnection(sock)` with one argument — which IS the bug. Reaching
// the real call site needs a live relay Worker, so this asserts it at the source,
// the same way this repo pins other call-site-blind wiring.
describe("setupRelayBridge actually passes the origin (#1077)", () => {
  it("attaches with a derived origin, not bare", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../services/secure-bridge.ts", import.meta.url), "utf-8");

    const call = src.match(/bridge\.attachRelayConnection\([^)]*\)/);
    expect(call, "the relay attach call site moved or vanished").toBeTruthy();
    expect(call![0], "it must pass an origin, or the fence can never be adopted").toMatch(
      /relayIdentityOrigin\(/,
    );
  });
});
