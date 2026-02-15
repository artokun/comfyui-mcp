import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateSkill } from "../services/skill-generator.js";
import { errorToToolResult } from "../utils/errors.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export function registerSkillGeneratorTools(server: McpServer): void {
  server.tool(
    "generate_node_skill",
    "Analyze a ComfyUI custom node pack and generate a Claude skill (.md) file describing all its nodes, inputs/outputs, and usage examples. Accepts a ComfyUI Registry ID or a GitHub repository URL as the source.",
    {
      source: z
        .string()
        .describe(
          "ComfyUI Registry node ID (e.g. 'comfyui-impact-pack') or GitHub repository URL",
        ),
      install_in: z
        .string()
        .optional()
        .describe(
          "Optional directory path to save the generated SKILL.md file",
        ),
    },
    async (args) => {
      try {
        const markdown = await generateSkill(args.source);

        // Optionally write to disk
        if (args.install_in) {
          const dir = args.install_in;
          await mkdir(dir, { recursive: true });
          const filePath = join(dir, "SKILL.md");
          await writeFile(filePath, markdown, "utf-8");
          return {
            content: [
              {
                type: "text" as const,
                text: `Skill file written to ${filePath}\n\n${markdown}`,
              },
            ],
          };
        }

        return {
          content: [{ type: "text" as const, text: markdown }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
