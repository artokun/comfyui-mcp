import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchNodes, getNodePackDetails } from "../services/registry-client.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerRegistrySearchTools(server: McpServer): void {
  server.tool(
    "search_custom_nodes",
    "Search the ComfyUI Registry for custom node packs by keyword",
    {
      query: z.string().describe("Search query for custom node packs"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default 10)"),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number for pagination (default 1)"),
    },
    async (args) => {
      try {
        const results = await searchNodes(args.query, {
          limit: args.limit,
          page: args.page,
        });

        const text = results.length === 0
          ? `No custom nodes found for "${args.query}".`
          : results
              .map(
                (r, i) =>
                  `${i + 1}. **${r.name}** (${r.id})\n` +
                  `   ${r.description ?? "No description"}\n` +
                  `   Author: ${r.author} | Installs: ${r.total_install ?? "N/A"} | Version: ${r.latest_version ?? "N/A"}`,
              )
              .join("\n\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_node_pack_details",
    "Get detailed information about a specific ComfyUI custom node pack from the Registry",
    {
      id: z.string().describe("Node pack ID (e.g. 'comfyui-impact-pack')"),
    },
    async (args) => {
      try {
        const details = await getNodePackDetails(args.id);

        const lines = [
          `# ${details.name}`,
          "",
          details.description ?? "",
          "",
          `- **Author**: ${details.author}`,
          `- **License**: ${details.license ?? "N/A"}`,
          `- **Repository**: ${details.repository ?? "N/A"}`,
          `- **Total Installs**: ${details.total_install ?? "N/A"}`,
          `- **Latest Version**: ${details.latest_version ?? "N/A"}`,
          `- **Created**: ${details.created_at ?? "N/A"}`,
          `- **Updated**: ${details.updated_at ?? "N/A"}`,
        ];

        if (details.nodes?.length) {
          lines.push("", "## Nodes Provided", ...details.nodes.map((n) => `- ${n}`));
        }

        if (details.versions?.length) {
          lines.push(
            "",
            "## Recent Versions",
            ...details.versions.slice(0, 5).map(
              (v) => `- **${v.version}**${v.changelog ? `: ${v.changelog}` : ""}`,
            ),
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
