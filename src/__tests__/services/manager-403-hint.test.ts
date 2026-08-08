// #1089 — a bare 403 from ComfyUI-Manager, and a reporter asking what permission
// they were missing.
//
// `install_comfyui(action:"update_all")` hit /v2/manager/queue/update_all and got
// HTTP 403. The tool returned NODE_MANAGEMENT_ERROR with nothing else, so the
// reporter asked us to "clarify required Manager permissions".
//
// The answer is that they were missing NONE. That 403 is ComfyUI-Manager's own
// security gate: Manager refuses installs/updates/uninstalls when it considers
// the instance exposed (a server bound to a non-loopback address — --listen, a
// container, a tunnel — is treated that way by default), and no credential this
// MCP could send would change it. That distinction is the entire value of the
// message, because the obvious reading of 403 is "authenticate" and there is
// nothing here to authenticate against.
//
// This file already NAMED the cause internally — two comments call 403
// "security_level gating" while deciding it is not a dialect signal — so the
// knowledge was present and simply never shown to anyone.

import { describe, expect, it } from "vitest";
import { managerStatusHint } from "../../services/node-management.js";

describe("a Manager 403 explains itself", () => {
  it("says it is a security gate and NOT an auth failure", () => {
    const hint = managerStatusHint(403, "/v2/manager/queue/update_all");

    expect(hint).toMatch(/SECURITY GATE/);
    expect(hint).toMatch(/not an authentication failure/i);
    // The actionable half of that: stop hunting for a token.
    expect(hint).toMatch(/no token or credential this MCP can send/i);
  });

  it("names security_level and says it is Manager's own setting, not ours", () => {
    const hint = managerStatusHint(403, "/v2/manager/queue/update_all");

    expect(hint).toMatch(/security_level/);
    expect(hint).toMatch(/config\.ini/);
    expect(hint).toMatch(/NOT anything this MCP controls/);
    // Why it fires on a server that works fine locally.
    expect(hint).toMatch(/non-loopback/);
  });

  it("offers the safe options first and the exposure decision last", () => {
    const hint = managerStatusHint(403, "/v2/manager/queue/update_all");

    const loopbackAt = hint.indexOf("over loopback");
    const lowerAt = hint.indexOf("lower `security_level`");
    expect(loopbackAt).toBeGreaterThan(-1);
    expect(lowerAt).toBeGreaterThan(-1);
    // Loosening the gate is listed LAST, and stated as a tradeoff rather than a step.
    expect(loopbackAt).toBeLessThan(lowerAt);
    expect(hint).toMatch(/install arbitrary packages/);
    expect(hint).toMatch(/listed last rather than recommended/);
  });

  it("names the risky-operation class for an install/update route", () => {
    expect(managerStatusHint(403, "/v2/manager/queue/update_all")).toMatch(
      /installs, updates and uninstalls/,
    );
    // A route that is not one of those gets the generic phrasing rather than a
    // claim about operations the caller did not attempt.
    expect(managerStatusHint(403, "/v2/manager/some_read")).toMatch(/this operation/);
  });

  // The noise guard. Every other status keeps its existing message untouched —
  // in particular 405, which this codebase reads as WRONG DIALECT (ComfyUI's
  // frontend catchall answers every unregistered POST with 405). Attaching a
  // security explanation there would send the reader down exactly the wrong path.
  it("adds nothing to any other status", () => {
    for (const status of [400, 404, 405, 409, 500, 502]) {
      expect(managerStatusHint(status, "/v2/manager/queue/update_all")).toBe("");
    }
  });
});
