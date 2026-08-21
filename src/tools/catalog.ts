import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger.js";

export interface CatalogedTool {
  name: string;
  description: string;
  category: string;
  /** Zod raw shape as passed to server.tool(); undefined for zero-arg tools. */
  schema: z.ZodRawShape | undefined;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * The one member of McpServer the registrar wrappers (asRegistrar below, the
 * blind-image gate, the tool-surface filter) implement or forward: `tool()`,
 * called with whatever argument list the SDK overload in use takes.
 *
 * Written as a METHOD signature on purpose. TypeScript relates method parameters
 * bivariantly, so the SDK's overloaded `tool()` is assignable here as-is; a
 * function-typed property would be checked contravariantly and need an assertion.
 */
export interface ToolRegistrar {
  tool(...args: unknown[]): unknown;
}

/**
 * Captures server.tool(...) registrations into a plain map instead of a live
 * MCP server. This powers the compact tool mode (COMFYUI_MCP_TOOL_MODE=compact)
 * for small/local LLMs: the full ~200-schema surface overwhelms their context,
 * so the real server registers only meta-tools (list_tools / describe_tool /
 * call_tool) that consult this catalog and dispatch to the original handlers.
 * Every file in src/tools registers via the 4-arg
 * server.tool(name, description, zodRawShape, handler) overload; capture()
 * parses defensively so other SDK overloads degrade to warn-and-skip rather
 * than breaking startup.
 */
export class ToolCatalog {
  readonly tools = new Map<string, CatalogedTool>();
  private category = "general";

  /** Category applied to subsequent captures (set per register-group). */
  setCategory(category: string): void {
    this.category = category;
  }

  get(name: string): CatalogedTool | undefined {
    return this.tools.get(name);
  }

  /** Categories in first-seen order, each with its tools in registration order. */
  byCategory(): Map<string, CatalogedTool[]> {
    const grouped = new Map<string, CatalogedTool[]>();
    for (const tool of this.tools.values()) {
      const list = grouped.get(tool.category);
      if (list) list.push(tool);
      else grouped.set(tool.category, [tool]);
    }
    return grouped;
  }

  /**
   * Duck-typed stand-in accepted by the registerXxxTools(server) functions.
   * Only .tool() is implemented — a grep of src/tools confirms no register
   * function touches any other McpServer member.
   */
  asRegistrar(): McpServer {
    const registrar: ToolRegistrar = {
      tool: (...args: unknown[]): Record<string, never> => {
        this.capture(args);
        return {};
      },
    };
    return registrar as McpServer;
  }

  private capture(args: unknown[]): void {
    const name = args[0];
    const handler = args[args.length - 1];
    if (typeof name !== "string" || typeof handler !== "function" || args.length < 2) {
      logger.warn("ToolCatalog: skipped a server.tool() call with an unrecognized shape", {
        argTypes: args.map((a) => typeof a),
      });
      return;
    }
    let description = "";
    let schema: z.ZodRawShape | undefined;
    for (const arg of args.slice(1, -1)) {
      if (typeof arg === "string") description = arg;
      else if (arg && typeof arg === "object" && schema === undefined) schema = arg as z.ZodRawShape;
    }
    if (this.tools.has(name)) {
      logger.warn(`ToolCatalog: duplicate tool '${name}' — keeping the first registration`);
      return;
    }
    this.tools.set(name, {
      name,
      description,
      category: this.category,
      schema,
      handler: handler as CatalogedTool["handler"],
    });
  }
}
