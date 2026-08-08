// #1089 — a Manager 403 already says WHY; we were dropping it.
//
// Reported against a remote ComfyUI 0.30.1: install_comfyui (action:"update_all")
// got 403 and the tool returned a bare NODE_MANAGEMENT_ERROR, so the reporter had
// to ask which permission was even involved.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explainManagerForbidden } from "../../services/node-management.js";

const j = (o: unknown) => JSON.stringify(o);

describe("#1089 Manager 403 names its own reason", () => {
  it("security_level: names the setting, its allowed values, and the tradeoff", () => {
    const t = explainManagerForbidden(403, j({ error: "security_level" }));
    expect(t).toMatch(/security level/i);
    expect(t).toMatch(/weak, normal or normal-/);
    expect(t).toMatch(/restart ComfyUI/);
    // It is a real decision about exposure, not a step to rubber-stamp.
    expect(t).toMatch(/deliberate choice/);
    expect(t).toMatch(/shell on the machine itself/);
    // And it corrects the two things a reader would otherwise assume.
    expect(t).toMatch(/not on credentials/);
    expect(t).toMatch(/not\s+because the server is remote/);
  });

  it("comfyui_outdated: sends the reader to the right fix, not to settings", () => {
    const t = explainManagerForbidden(403, j({ error: "comfyui_outdated" }));
    expect(t).toMatch(/too OLD/);
    expect(t).toMatch(/Update ComfyUI itself/);
    expect(t).toMatch(/changing Manager settings will not clear this/);
    expect(t).not.toMatch(/weak, normal or normal-/);
  });

  it("an unrecognised flag token is REPORTED, never explained away", () => {
    // Manager names a specific install flag. Inventing a remedy for a flag we do
    // not know would be the same defect as a userdata 400 blaming the filename.
    const t = explainManagerForbidden(403, j({ error: "some_install_flag" }));
    expect(t).toMatch(/"some_install_flag"/);
    expect(t).toMatch(/consult\s+ComfyUI-Manager/);
    expect(t).not.toMatch(/security_level to be weak/);
  });

  it("says NOTHING for a non-403", () => {
    for (const s of [200, 401, 404, 409, 500]) {
      expect(explainManagerForbidden(s, j({ error: "security_level" }))).toBe("");
    }
  });

  it("says NOTHING when the body is not Manager's JSON", () => {
    // An unparseable body means something else answered — a proxy, an auth gate.
    // Attributing a Manager reason to it would be a fabricated diagnosis.
    for (const b of ["", "Forbidden", "<html>nginx</html>", "{oops"]) {
      expect(explainManagerForbidden(403, b)).toBe("");
    }
    // Valid JSON with no usable error field is the same case.
    expect(explainManagerForbidden(403, j({}))).toBe("");
    expect(explainManagerForbidden(403, j({ error: "   " }))).toBe("");
    expect(explainManagerForbidden(403, j({ error: 7 }))).toBe("");
  });
  it("WIRING: managerFetch appends it to the thrown message", () => {
    // The helper being right proves nothing if the throw site does not call it.
    // A mutation that removed exactly this call SURVIVED the helper-only tests.
    const src = readFileSync(new URL("../../services/node-management.ts", import.meta.url), "utf8");
    const i = src.indexOf("ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}");
    expect(i).toBeGreaterThan(-1);
    const window = src.slice(i, i + 240);
    expect(window).toMatch(/explainManagerForbidden\(res\.status, text\)/);
    // …and the raw body is still carried in details, so nothing is LOST by
    // summarising it in the message.
    expect(window).toMatch(/body: text/);
  });
});
