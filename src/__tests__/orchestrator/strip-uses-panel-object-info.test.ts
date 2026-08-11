// #1359 — `panel_strip_workflow` captured the graph from the connected panel and then
// fetched node definitions through the global client, which resolves COMFYUI_URL. One
// machine locally; two whenever the panel is remote. The reporter's canvas was on a
// runpod proxy URL and the definitions request went to 127.0.0.1:8188, so a remote panel
// could not strip its own canvas at all.
//
// A partial fix already shipped (5eeca00): the failure names which host was asked and why.
// Its own comment says it "does NOT fix the split authority — that needs the panel to
// serve its own /object_info, a protocol change tracked separately."
//
// That panel change had ALREADY SHIPPED, in panel 0.13.0 (#1006). Nothing called it. This
// is the wiring, and the tests below are mostly about the direction that must NOT happen:
// falling back to COMFYUI_URL when the panel cannot answer. Both hosts can respond, and if
// they disagree a fallback returns a confidently wrong workflow — converted against a
// different ComfyUI's schema, with wrong widget order and input names, silently. That is
// worse than the ECONNREFUSED this issue was filed about, which at least failed loudly.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  BRIDGE_CMD_MIN_PANEL_VERSION,
  BRIDGE_READONLY_CMDS,
  GRAPH_CMD_EFFECT,
} from "../../services/ui-bridge.js";

/** Source with comments stripped — a comment must never satisfy a wiring assertion. */
function panelToolsCode(): string {
  return readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "");
}

describe("the live canvas is converted with ITS OWN ComfyUI's definitions (#1359)", () => {
  it("WIRING: a live-canvas strip asks the PANEL, not the global client", () => {
    const src = panelToolsCode();
    const at = src.indexOf("const liveCanvasSource =");
    expect(at, "the live-canvas discriminator must still exist").toBeGreaterThan(-1);
    const block = src.slice(at, at + 1200);
    expect(block).toMatch(/if \(liveCanvasSource\)/);
    // Passes the graph's node types now, so the reply can be judged against the canvas it
    // is meant to describe rather than against its own shape (codex round 3).
    expect(block).toMatch(/panelObjectInfo\(ctx, collectNodeTypes\(ui\)\)/);
    // …and the global client is still used for the sources that genuinely belong to it.
    expect(block).toMatch(/getObjectInfo\(\)/);
  });

  it("the panel helper sends the command the panel actually implements", () => {
    const src = panelToolsCode();
    const at = src.indexOf("async function panelObjectInfo");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 1400);
    expect(body).toContain('cmd: "graph_get_object_info"');
    // The panel fetches a full /object_info, which outruns the default ack on a large
    // install — a false timeout would read as "the panel cannot serve definitions".
    expect(body).toContain("OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS");
  });

  it("NO FALLBACK: the BACKFILL is skipped too, or the guarantee leaks one line later", () => {
    // `backfillObjectInfo` fetches each type it lacks from
    // `${getComfyUIBaseUrl()}/object_info/<Type>` — COMFYUI_URL, the host the live path
    // just refused. Refusing the bulk fetch and then backfilling from that server merges a
    // DIFFERENT ComfyUI's definitions into the panel's map, which is exactly the silent
    // wrong-schema outcome the refusal exists to prevent. It fails soft, so it degrades to
    // "type absent" when that host is unreachable and to a quietly wrong schema when it is
    // not.
    const src = panelToolsCode();
    const at = src.indexOf("const objectInfo =");
    expect(at).toBeGreaterThan(-1);
    const line = src.slice(at, at + 200);
    expect(line).toMatch(/liveCanvasSource\s*\?\s*bulk/);
    expect(line).toMatch(/backfillObjectInfo\(bulk, collectNodeTypes\(ui\)\)/);
  });

  it("NO FALLBACK: the live-canvas path never reaches getObjectInfo() on a panel failure", () => {
    // THE TEST THIS FILE EXISTS FOR. A fallback is the tempting shape and the dangerous
    // one, and it would pass every other assertion here.
    const src = panelToolsCode();
    const at = src.indexOf("async function panelObjectInfo");
    const body = src.slice(at, src.indexOf("function objectInfoHostMismatchMessage"));
    expect(
      body.includes("getObjectInfo("),
      "the panel-sourced path must not call the global client, on any branch",
    ).toBe(false);

    // …and the caller returns on a failure rather than continuing.
    const call = src.indexOf("const liveCanvasSource =");
    const callBlock = src.slice(call, call + 1200);
    expect(callBlock).toMatch(/if \(!reply\.ok\) return fail\(reply\.message\)/);
  });
});

describe("the bridge knows what this command is (#1359)", () => {
  it("is registered as a READ, so it is not fenced or retried as a mutation", () => {
    expect(BRIDGE_READONLY_CMDS.has("graph_get_object_info")).toBe(true);
    expect(GRAPH_CMD_EFFECT.graph_get_object_info).toBe("inert");
  });

  it("carries an AUTHORITATIVE minimum panel version", () => {
    // Without one the command falls back to the bridge baseline and an older panel answers
    // the raw dispatch error `Unknown command "graph_get_object_info"` — which reads like a
    // broken ComfyUI rather than an old panel.
    //
    // 0.13.0 is from the RELEASE COMMIT, not from tags. The panel repo does not tag its
    // releases, so `git tag --contains` on the commit that added the command finds only the
    // two tags that happen to exist and would have named a version four releases too late.
    expect(BRIDGE_CMD_MIN_PANEL_VERSION.graph_get_object_info).toBe("0.13.0");
  });
});

describe("the panel's replies are handled as the panel documents them (#1359)", () => {
  // The panel's contract: `{ok:false, reason, detail, served_by}` when it cannot get a
  // usable schema; `{ok:true, object_info, served_by, fingerprint}` on success; and
  // `{ok:true, unchanged:true}` with NO payload when an if_none_match fingerprint matches.
  // This caller sends no fingerprint, so an `unchanged` reply would be a contract
  // violation — and, critically, a payload-free success is the shape most likely to be
  // read as "fine, carry on" and converted against an empty schema.
  it("a payload-free success is refused, not treated as an empty schema", () => {
    const src = panelToolsCode();
    const at = src.indexOf("async function panelObjectInfo");
    const body = src.slice(at, at + 2600);
    expect(body).toMatch(/!r\.object_info \|\| typeof r\.object_info !== "object"/);
  });

  it("a declared failure surfaces the panel's own detail and the origin that answered", () => {
    const src = panelToolsCode();
    const at = src.indexOf("async function panelObjectInfo");
    const body = src.slice(at, at + 2600);
    expect(body).toMatch(/r\.ok === false/);
    expect(body).toContain("r.served_by");
    expect(body).toContain("r.detail");
  });
});
