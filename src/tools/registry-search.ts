import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchNodes, getNodePackDetails } from "../services/registry-client.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerRegistrySearchTools(server: McpServer): void {
  server.tool(
    "search_custom_nodes",
    "Search the public ComfyUI Registry (registry.comfy.org) for custom node packs by keyword. Read-only and network-only: queries the hosted registry over HTTP and does NOT require a running ComfyUI or COMFYUI_PATH. Returns a ranked list of packs with id, name, author, install count, and latest version. Use to discover packs to install; pass a returned id to get_node_pack_details for full info. This searches node PACKS, not models (use search_models) and not local installs (use list_local_models).",
    {
      query: z.string().describe("Keyword(s) to match against pack name/description, e.g. 'impact', 'controlnet aux'"),
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
    "Get full details for one ComfyUI custom node pack from the public ComfyUI Registry: description, author, license, repository, install count, latest version, the node types it provides, and recent version changelogs. Read-only and network-only (hosted registry over HTTP); does not require a running ComfyUI. Look up the pack id via search_custom_nodes first.",
    {
      id: z.string().describe("Exact registry pack id (the 'id' field from search_custom_nodes), e.g. 'comfyui-impact-pack'"),
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
            // #809: say how many were dropped. This preview has no parameter to raise,
            // so the honest remedy is the upstream index, not an invented lever.
            ...(details.versions.length > 5
              ? [
                  `- …and ${details.versions.length - 5} older version(s) not shown (fixed 5-version preview — full history at https://registry.comfy.org/)`,
                ]
              : []),
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
