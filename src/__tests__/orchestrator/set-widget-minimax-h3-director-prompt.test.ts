// #2790 — panel_set_widget correctly refuses MiniMaxH3Director.prompt, but the
// panel's recovery instruction used to recommend a frontend PrimitiveNode for
// external_prompt_overwrite. panel_connect refuses that forceInput-only STRING
// and names PrimitiveStringMultiline. Tests drive the shipped panel_set_widget
// handler so a missing rewrite stays red.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  backendStringProducerConnectAdvice,
  primitiveForceInputRefusal,
} from "../../services/primitive-force-input-connect.js";
import {
  miniMaxH3DirectorExternalPromptAdvice,
  rewriteMiniMaxH3DirectorPrimitiveAdvice,
} from "../../services/minimax-h3-director-widget.js";
import {
  buildPanelToolDefs,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const PANEL_SRC = readFileSync(
  fileURLToPath(new URL("../../orchestrator/panel-tools.ts", import.meta.url)),
  "utf8",
);

const NODE_ID = 17;

/** Exact panel MiniMaxH3Director derived-widget refusal (comfyui-mcp-panel
 *  `web/js/lib/minimax-h3-director.js` miniMaxH3DirectorPromptRefusal). */
function panelMiniMaxH3DirectorRefusal(widgetName: string, nodeId: number): string {
  return (
    `panel_set_widget cannot drive "${widgetName}" on MiniMaxH3Director node ${nodeId}: ` +
    `timeline_data, builder_state, and prompt are DERIVED write-backs of the node's in-memory ` +
    `builderState. The Director editor parses timeline_data once at install, then emit() ` +
    `regenerates all three from that closure, so a raw write shows in panel_query_graph while ` +
    `prompt and builder_state stay stale and the next UI touch reverts it (#1935, #1679). ` +
    `Python execute() prefers the builder_state widget over timeline_data.builder_state when ` +
    `the widget is non-empty, so a successful timeline_data result does not mean the prompt ` +
    `changed. Use the node's supported external_prompt_overwrite path instead: connect a ` +
    `PrimitiveNode STRING output to "external_prompt_overwrite", then set the PrimitiveNode's ` +
    `STRING value with panel_set_widget. The write was refused before any graph mutation; ` +
    `other widgets and node types are unaffected.`
  );
}

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  return def;
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(" ");
}

function errResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${text}` }] };
}

function okResult(body: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

async function runSetWidget(
  call: PanelToolCtx["call"],
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return defByName("panel_set_widget").handler(args as never, {
    call,
    confirm: async () => "yes" as const,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "t-2790",
  } as PanelToolCtx);
}

describe("shared backend STRING producer advice (#2790 / #2536)", () => {
  it("is the exact recovery clause in panel_connect's PrimitiveNode refusal", () => {
    const advice = backendStringProducerConnectAdvice("external_prompt_overwrite");
    expect(advice).toContain("PrimitiveStringMultiline");
    expect(advice).not.toContain("PrimitiveNode");
    const connect = primitiveForceInputRefusal({
      fromNodeId: 12,
      toNodeId: 5,
      toType: "MiniMaxH3Director",
      inputName: "external_prompt_overwrite",
      inputType: "STRING",
      disconnected: true,
    });
    expect(connect).toContain(advice);
  });

  it("is the exact recovery clause in the MiniMaxH3Director rewrite", () => {
    const advice = backendStringProducerConnectAdvice("external_prompt_overwrite");
    expect(miniMaxH3DirectorExternalPromptAdvice()).toContain(advice);
    const rewritten = rewriteMiniMaxH3DirectorPrimitiveAdvice(
      panelMiniMaxH3DirectorRefusal("prompt", NODE_ID),
    );
    expect(rewritten).toContain(advice);
    expect(rewritten).not.toMatch(/connect a PrimitiveNode/);
    expect(rewritten).not.toMatch(/set the PrimitiveNode's/);
  });
});

describe("panel_set_widget MiniMaxH3Director prompt workaround (#2790)", () => {
  it("handlers rewrite the panel refusal through rewriteMiniMaxH3DirectorPrimitiveAdvice", () => {
    expect(PANEL_SRC).toMatch(/rewriteMiniMaxH3DirectorWidgetRefusal\(/);
    expect(PANEL_SRC).toMatch(/rewriteMiniMaxH3DirectorPrimitiveAdvice\(/);
  });

  it("THE REPORTED CASE: prompt refusal recommends PrimitiveStringMultiline, not PrimitiveNode", async () => {
    const cmds: string[] = [];
    const panelText = panelMiniMaxH3DirectorRefusal("prompt", NODE_ID);
    expect(panelText).toMatch(/connect a PrimitiveNode STRING output/);

    const res = await runSetWidget(
      async (cmd) => {
        cmds.push(String(cmd.cmd));
        if (cmd.cmd === "graph_set_widget") return errResult(panelText);
        return okResult({});
      },
      { node_id: NODE_ID, widget: "prompt", value: "a new shot" },
    );

    const text = textOf(res);
    expect(cmds).toContain("graph_set_widget");
    expect(res.isError).toBe(true);
    expect(text).toContain("MiniMaxH3Director");
    expect(text).toContain("external_prompt_overwrite");
    expect(text).toContain("PrimitiveStringMultiline");
    expect(text).toContain(backendStringProducerConnectAdvice("external_prompt_overwrite"));
    expect(text).not.toMatch(/connect a PrimitiveNode/);
    expect(text).not.toMatch(/set the PrimitiveNode's/);
  });

  it.each(["builder_state", "timeline_data"] as const)(
    "rewrites the %s derived-widget refusal the same way",
    async (widget) => {
      const res = await runSetWidget(
        async (cmd) => {
          if (cmd.cmd === "graph_set_widget") {
            return errResult(panelMiniMaxH3DirectorRefusal(widget, NODE_ID));
          }
          return okResult({});
        },
        { node_id: NODE_ID, widget, value: "{}" },
      );
      const text = textOf(res);
      expect(res.isError).toBe(true);
      expect(text).toContain("PrimitiveStringMultiline");
      expect(text).not.toMatch(/connect a PrimitiveNode/);
    },
  );

  it("does not rewrite an unrelated PrimitiveNode error", async () => {
    const other =
      `Cannot set widget "text" on node 3: connect a PrimitiveNode STRING output ` +
      `to "text", then set the PrimitiveNode's STRING value with panel_set_widget.`;
    const res = await runSetWidget(
      async (cmd) => {
        if (cmd.cmd === "graph_set_widget") return errResult(other);
        return okResult({});
      },
      { node_id: 3, widget: "text", value: "hello" },
    );
    expect(textOf(res)).toMatch(/connect a PrimitiveNode STRING output/);
    expect(textOf(res)).not.toMatch(/PrimitiveStringMultiline/);
  });

  it("documents PrimitiveStringMultiline for MiniMaxH3Director on the tool itself", () => {
    const description = defByName("panel_set_widget").description;
    expect(description).toContain("MiniMaxH3Director");
    expect(description).toContain("external_prompt_overwrite");
    expect(description).toContain("PrimitiveStringMultiline");
    expect(description).toContain("PrimitiveNode");
  });
});
