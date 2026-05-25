import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the service so the tool layer is tested in isolation: we assert it maps
// schema args -> service options and wraps results/errors correctly.
const scaffoldMock = vi.fn();
const publishMock = vi.fn();
vi.mock("../../services/node-authoring.js", () => ({
  scaffoldCustomNode: (...a: unknown[]) => scaffoldMock(...a),
  publishCustomNode: (...a: unknown[]) => publishMock(...a),
}));

import { registerNodeAuthoringTools } from "../../tools/node-authoring.js";
import { ValidationError } from "../../utils/errors.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

function makeServer() {
  const tools = new Map<string, Registered>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: ToolHandler,
    ) => {
      tools.set(name, { name, description, schema, handler });
    },
  };
  registerNodeAuthoringTools(server as never);
  return tools;
}

beforeEach(() => {
  scaffoldMock.mockReset();
  publishMock.mockReset();
});

describe("registerNodeAuthoringTools", () => {
  it("registers both tools with descriptive, local-only descriptions", () => {
    const tools = makeServer();
    expect(tools.has("scaffold_custom_node")).toBe(true);
    expect(tools.has("publish_custom_node")).toBe(true);

    const scaffold = tools.get("scaffold_custom_node")!;
    expect(scaffold.description).toMatch(/LOCAL-ONLY/i);
    expect(scaffold.description.length).toBeGreaterThan(200);

    const publish = tools.get("publish_custom_node")!;
    expect(publish.description).toMatch(/IRREVERSIBLE|cannot.*undo/i);
    expect(publish.description).toMatch(/LOCAL-ONLY/i);
  });

  it("maps scaffold snake_case args to service camelCase options", async () => {
    const tools = makeServer();
    scaffoldMock.mockReturnValue({ name: "p", path: "/x", files: [], withFrontend: true, message: "ok" });

    const res = await tools.get("scaffold_custom_node")!.handler({
      name: "my-pack",
      display_name: "My Pack",
      category: "cat",
      description: "desc",
      publisher_id: "acme",
      with_frontend: true,
      overwrite: true,
    });

    expect(scaffoldMock).toHaveBeenCalledWith({
      name: "my-pack",
      displayName: "My Pack",
      category: "cat",
      description: "desc",
      publisherId: "acme",
      withFrontend: true,
      overwrite: true,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"name": "p"');
  });

  it("wraps scaffold errors via errorToToolResult", async () => {
    const tools = makeServer();
    scaffoldMock.mockImplementation(() => {
      throw new ValidationError("bad name");
    });
    const res = await tools.get("scaffold_custom_node")!.handler({
      name: "../x",
      display_name: "X",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("bad name");
  });

  it("maps publish args and returns structured status", async () => {
    const tools = makeServer();
    publishMock.mockReturnValue({
      published: true,
      packName: "mypack",
      version: "0.0.1",
      publisherId: "acme",
      path: "/p",
      registryUrl: "https://registry.comfy.org/nodes/mypack",
      message: "done",
    });
    const res = await tools.get("publish_custom_node")!.handler({ name: "mypack" });
    expect(publishMock).toHaveBeenCalledWith({ name: "mypack", path: undefined });
    expect(res.content[0].text).toContain("registry.comfy.org");
  });

  it("wraps publish errors", async () => {
    const tools = makeServer();
    publishMock.mockImplementation(() => {
      throw new ValidationError("REGISTRY_ACCESS_TOKEN is not set");
    });
    const res = await tools.get("publish_custom_node")!.handler({ name: "mypack" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("REGISTRY_ACCESS_TOKEN");
  });
});
