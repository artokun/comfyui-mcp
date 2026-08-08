// #1086 — a Manager dispatch must not promise where the file lands.
//
// The reply used to end "the file lists under /models when complete". That is a
// PREDICTION. For the reporter it was false: Manager installed into the container
// base root while the server read models from /workspace/models via
// extra_model_paths, the file never listed, and the ephemeral overlay was
// discarded on restart — losing a multi-GB model we had reported as in flight.

import { describe, expect, it } from "vitest";
import { managerDestinationCaveat } from "../../services/model-resolver.js";

describe("#1086 Manager dispatch does not establish the destination", () => {
  const text = managerDestinationCaveat();

  it("states plainly that the destination is NOT established", () => {
    expect(text).toMatch(/NOT established where the file lands/);
    expect(text).toMatch(/does not necessarily honour/);
    expect(text).toMatch(/extra_model_paths/);
  });

  it("names the check, so it is a route rather than a warning", () => {
    // "verify it yourself" without saying how is a dead end. list_local_models
    // reads through the SAME roots the server reads, so a file that appears there
    // is genuinely reachable by a workflow.
    expect(text).toMatch(/list_local_models/);
  });

  it("explains what a MISSING file means, including the restart hazard", () => {
    expect(text).toMatch(/never appears/);
    expect(text).toMatch(/ephemeral overlay/);
    expect(text).toMatch(/loses the file on restart/);
  });

  it("makes no promise about where the bytes go", () => {
    // The exact failure being removed: any forward-looking claim about the file
    // being listed, present, or available once the transfer finishes.
    expect(text).not.toMatch(/lists under/);
    expect(text).not.toMatch(/will (be|appear|land)/i);
    expect(text).not.toMatch(/when complete/i);
  });

  it("does not name a destination it cannot know", () => {
    // We cannot read the target's extra_model_paths.yaml, so asserting any
    // concrete path would be the same defect in the other direction.
    expect(text).not.toMatch(/\/workspace\/models|\/opt\/ComfyUI/);
  });
});
