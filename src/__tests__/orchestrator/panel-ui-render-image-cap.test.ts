// #2796 — panel_ui_render's declared manual listed the 64-component ceiling but
// omitted the validator's four-Image cap. A valid-looking five-image approval
// card was rejected as `too many images (5 > 4)` after the caller had already
// authored it from the tool description.
//
// This pins the two surfaces to the SAME number: the shipped description must
// name A2UI_CAPS.maxImages, and the shipped handler must reject one more.
import { describe, expect, it } from "vitest";
import { A2UI_CAPS } from "../../services/a2ui-spec.js";
import {
  buildPanelToolDefs,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

function uiRenderDef() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_ui_render");
  if (!def) throw new Error("panel_ui_render is not registered");
  return def;
}

function imageCard(n: number): Record<string, unknown> {
  const ids = Array.from({ length: n }, (_, i) => `img${i}`);
  return {
    root: "root",
    title: "Approve these",
    components: [
      { id: "root", type: "Column", children: ids },
      ...ids.map((id) => ({ id, type: "Image", src: "/view?filename=x.png" })),
    ],
  };
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => ("text" in c ? c.text : "")).join(" ");
}

describe("panel_ui_render Image cap (#2796)", () => {
  it("the shipped description names the validator's Image cap", () => {
    const desc = uiRenderDef().description;
    const mentioned = desc.match(/≤(\d+) Image/);
    expect(mentioned, "panel_ui_render must disclose the Image component cap").not.toBeNull();
    expect(Number(mentioned![1])).toBe(A2UI_CAPS.maxImages);
    expect(desc).toContain(`≤${A2UI_CAPS.maxComponents} components`);
  });

  it("rejects one more Image than the documented cap without reaching the panel", async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx = {
      call: async (cmd: Record<string, unknown>) => {
        calls.push(cmd);
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    } as PanelToolCtx;
    const n = A2UI_CAPS.maxImages + 1;
    const res = await uiRenderDef().handler({ spec: imageCard(n) }, ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`invalid a2ui spec: too many images (${n} > ${A2UI_CAPS.maxImages})`);
    expect(calls).toEqual([]);
  });

  it("forwards a card at the documented Image cap", async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx = {
      call: async (cmd: Record<string, unknown>) => {
        calls.push(cmd);
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    } as PanelToolCtx;
    const res = await uiRenderDef().handler({ spec: imageCard(A2UI_CAPS.maxImages) }, ctx);
    expect(res.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("ui_render");
  });
});
