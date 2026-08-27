import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoveryCallKey } from "../../orchestrator/ollama-backend.js";

const SRC = readFileSync(
  fileURLToPath(new URL("../../orchestrator/ollama-backend.ts", import.meta.url)),
  "utf8",
);

/**
 * #2429 — compact-mode enumeration is not a catalog hunt.
 *
 * The discovery breaker keys per tool (or per `name action:"…"`). Counting
 * `list_tools` / `panel_list_tools` by bare name treats a category walk as
 * the Civitai-hunt wedge: each `list_tools {category}` has distinct args so
 * the exact-repeat breaker stays at 1–2, while one discovery key climbs to 8
 * and kills the turn. That is the log `repeats=2 discovery=9`.
 *
 * These tests drive the shipped `discoveryCallKey` (the loop's only keying
 * function). They fail if list/panel_list are counted without a non-empty
 * `search`.
 */
describe("discoveryCallKey (#2429)", () => {
  it("the tool loop keys discovery through the shipped function, not a bare-name Set", () => {
    expect(SRC).toMatch(/const discoveryKey = discoveryCallKey\(name, args\)/);
    expect(SRC).not.toMatch(/DISCOVERY_TOOLS\.has\(name\)/);
  });

  it("does not count compact-mode enumeration: bare, empty search, or category", () => {
    expect(discoveryCallKey("list_tools", {})).toBeUndefined();
    expect(discoveryCallKey("list_tools", { category: "generation" })).toBeUndefined();
    expect(discoveryCallKey("list_tools", { category: "models" })).toBeUndefined();
    expect(discoveryCallKey("list_tools", { search: "" })).toBeUndefined();
    expect(discoveryCallKey("list_tools", { search: "   " })).toBeUndefined();
    expect(discoveryCallKey("panel_list_tools", {})).toBeUndefined();
    expect(discoveryCallKey("panel_list_tools", { search: "" })).toBeUndefined();
  });

  it("still counts a keyword search on the catalog listers (the Civitai-hunt wedge)", () => {
    expect(discoveryCallKey("list_tools", { search: "civitai" })).toBe("list_tools");
    expect(discoveryCallKey("list_tools", { category: "models", search: "lora" })).toBe("list_tools");
    expect(discoveryCallKey("list_tools", '{"search":"flux"}')).toBe("list_tools");
    expect(discoveryCallKey("panel_list_tools", { search: "add node" })).toBe("panel_list_tools");
  });

  it("still keys consolidated tools on the SEARCH action, never the other actions (#839)", () => {
    expect(discoveryCallKey("download_model", { action: "download", url: "https://h/1.safetensors" })).toBeUndefined();
    expect(discoveryCallKey("download_model", { action: "search", query: "flux" })).toBe(
      'download_model action:"search"',
    );
    expect(discoveryCallKey("search_custom_nodes", { action: "details", id: "a-pack" })).toBeUndefined();
    expect(discoveryCallKey("search_custom_nodes", { action: "search", query: "lora" })).toBe(
      'search_custom_nodes action:"search"',
    );
  });

  it("does not count describe/call — those are progress, not a hunt", () => {
    expect(discoveryCallKey("describe_tool", { name: "generate_image" })).toBeUndefined();
    expect(discoveryCallKey("call_tool", { name: "generate_image", args: {} })).toBeUndefined();
    expect(discoveryCallKey("panel_describe_tool", { name: "panel_add_node" })).toBeUndefined();
  });
});
