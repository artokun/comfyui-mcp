import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  uploadImage,
  extractWorkflowFromImage,
  listOutputImages,
} from "../services/image-management.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerImageManagementTools(server: McpServer): void {
  server.tool(
    "upload_image",
    "Copy a local image file into ComfyUI's input/ directory so it can be used in img2img, inpaint, or ControlNet workflows. Returns the filename to use in LoadImage nodes.",
    {
      source_path: z
        .string()
        .describe("Absolute path to the local image file to upload"),
      filename: z
        .string()
        .optional()
        .describe(
          "Override the filename in ComfyUI's input/ directory. Auto-detected from source path if omitted.",
        ),
    },
    async (args) => {
      try {
        const result = await uploadImage(args.source_path, args.filename);
        return {
          content: [
            {
              type: "text" as const,
              text: `Image uploaded successfully.\n\nFilename: ${result.filename}\nPath: ${result.path}\n\nUse "${result.filename}" as the \`image\` input in LoadImage nodes.`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "workflow_from_image",
    "Extract embedded ComfyUI workflow metadata from a PNG file. ComfyUI stores the full workflow (API format) and prompt data in PNG tEXt chunks. Use this to reverse-engineer how any ComfyUI image was generated.",
    {
      image_path: z
        .string()
        .describe("Absolute path to a ComfyUI-generated PNG file"),
    },
    async (args) => {
      try {
        const result = await extractWorkflowFromImage(args.image_path);

        const sections: string[] = [];

        if (result.prompt) {
          sections.push("## API Format (prompt)\n\nThis is the executable workflow format:\n```json\n" + JSON.stringify(result.prompt, null, 2) + "\n```");
        }

        if (result.workflow) {
          sections.push("## UI Format (workflow)\n\nThis is the ComfyUI web UI format with layout data:\n```json\n" + JSON.stringify(result.workflow, null, 2) + "\n```");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `# Workflow extracted from ${args.image_path}\n\n${sections.join("\n\n")}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_output_images",
    "List recently generated images from ComfyUI's output directory. Returns filenames, sizes, and timestamps sorted newest-first.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max images to return (default: 20)"),
      pattern: z
        .string()
        .optional()
        .describe("Filter by filename pattern (case-insensitive substring match)"),
    },
    async (args) => {
      try {
        const images = await listOutputImages({
          limit: args.limit,
          pattern: args.pattern,
        });

        if (images.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: args.pattern
                  ? `No output images found matching "${args.pattern}".`
                  : "No output images found.",
              },
            ],
          };
        }

        const lines = images.map((img, i) => {
          const sizeMB = (img.size / 1024 / 1024).toFixed(1);
          const date = new Date(img.modified).toLocaleString();
          return `${i + 1}. **${img.filename}** (${sizeMB} MB) — ${date}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${images.length} image(s):\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
