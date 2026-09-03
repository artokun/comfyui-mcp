// #2529 — VHS_VideoCombine (and any class with object_info.output_node) is a
// terminal output. Classification must follow live /object_info, not a name list.

import { afterEach, describe, expect, it } from "vitest";
import {
  isOutputNodeType,
  parseNotOutputNodeRefusal,
  setOutputNodeObjectInfoForTests,
  stampOutputNodeFlags,
} from "../../services/output-node.js";
import type { ObjectInfo } from "../../comfyui/types.js";

const VHS_REFUSAL =
  `node 380 (VHS_VideoCombine) is not an output node — "run to node" can ` +
  `only target an output node such as SaveImage, PreviewImage, or SaveVideo.`;

function def(outputNode: boolean): ObjectInfo[string] {
  return {
    input: { required: {} },
    output: [],
    output_is_list: [],
    output_name: [],
    name: "x",
    display_name: "x",
    description: "",
    category: "video",
    output_node: outputNode,
  };
}

afterEach(() => {
  setOutputNodeObjectInfoForTests(undefined);
});

describe("output-node classification from object_info (#2529)", () => {
  it("treats VHS_VideoCombine as an output only when object_info.output_node is true", () => {
    expect(isOutputNodeType("VHS_VideoCombine", undefined)).toBe(false);
    expect(isOutputNodeType("VHS_VideoCombine", {})).toBe(false);
    expect(
      isOutputNodeType("VHS_VideoCombine", { VHS_VideoCombine: def(false) }),
    ).toBe(false);
    expect(
      isOutputNodeType("VHS_VideoCombine", { VHS_VideoCombine: def(true) }),
    ).toBe(true);
  });

  it("does not hardcode VHS_VideoCombine — an unknown OUTPUT_NODE class is accepted too", () => {
    expect(
      isOutputNodeType("SomeCustomSave", { SomeCustomSave: def(true) }),
    ).toBe(true);
    expect(isOutputNodeType("SaveImage", { SaveImage: def(false) })).toBe(false);
  });

  it("parses the panel's not-an-output-node refusal", () => {
    expect(parseNotOutputNodeRefusal(VHS_REFUSAL)).toEqual({
      nodeId: 380,
      classType: "VHS_VideoCombine",
    });
    expect(parseNotOutputNodeRefusal("node 8 is not an output node")).toBeNull();
    expect(parseNotOutputNodeRefusal("prompt_no_outputs")).toBeNull();
  });

  it("stamps is_output:true on query rows from object_info, not from the class name", () => {
    const payload = {
      text: JSON.stringify({ id: 380, type: "VHS_VideoCombine" }),
      nodes: [
        { id: 380, type: "VHS_VideoCombine" },
        { id: 1, type: "KSampler" },
      ],
    };
    const stamped = stampOutputNodeFlags(payload, {
      VHS_VideoCombine: def(true),
      KSampler: def(false),
    });
    expect(stamped.nodes).toEqual([
      { id: 380, type: "VHS_VideoCombine", is_output: true },
      { id: 1, type: "KSampler" },
    ]);
    expect(JSON.parse(String(stamped.text))).toMatchObject({
      id: 380,
      type: "VHS_VideoCombine",
      is_output: true,
    });
  });
});
