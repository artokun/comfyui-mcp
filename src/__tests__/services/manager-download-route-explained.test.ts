// #1374 — a LOCAL download hard-failed with "ComfyUI-Manager's queue API is not reachable",
// blocking ~45 GB of weights on an install that needs no Manager at all. The reporter used
// curl instead.
//
// The error is raised deep in generic Manager code that cannot know it is serving a
// download, so it named the thing that BROKE (Manager) and not the decision that made
// Manager necessary (this MCP could not resolve where the server keeps its models). Only
// the second has a remedy the user can apply, and nothing in the reply distinguished it
// from "your ComfyUI is remote, this is normal".
//
// THIS IS NOT A ROUTING CHANGE, and the tests say so. I could not reproduce the reporter's
// decision here — a live ComfyUI on this machine reports a relative main.py and NO cwd and
// still resolves, because the process-table probe anchors it. Guessing at which of six
// conditions fires for them, and "fixing" that, is the unverified confidence this codebase
// keeps paying for. What ships is the answer being visible in their next report.

import { describe, expect, it, vi, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  remote: { value: false },
  stats: { value: undefined as unknown },
}));

vi.mock("../../config.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isRemoteMode: () => hoisted.remote.value,
}));

// The live-probe gate (#1263) is right to demand this: `resolveLiveInterpreter` shells out
// to find the python actually serving the port on THIS machine, so without the stub these
// tests assert one thing where ComfyUI is running and another where it is not — and CI is
// one of the machines where they pass. That is the exact defect class the gate exists for,
// and it caught me one commit after I wrote a test asserting a message about process
// resolution.
vi.mock("../../services/live-interpreter.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../services/live-interpreter.js")),
  resolveLiveInterpreter: () => undefined,
}));

vi.mock("../../comfyui/client.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSystemStats: async () => {
    if (hoisted.stats.value === undefined) throw new Error("unreachable");
    return hoisted.stats.value;
  },
}));

const { explainManagerDownloadRoute, shouldDispatchDownloadToManager, resetRouteObservationForTests } =
  await import("../../services/model-resolver.js");

afterEach(() => {
  hoisted.remote.value = false;
  hoisted.stats.value = undefined;
  // The observation is process-global, so a test that does not clear it inherits the
  // previous test's decision — which is the same staleness the production comment calls out.
  resetRouteObservationForTests();
});

describe("the download route explains ITSELF when Manager is the reason (#1374)", () => {
  it("REMOTE mode is normal and says so — not a misconfiguration", async () => {
    hoisted.remote.value = true;
    await shouldDispatchDownloadToManager();
    const why = explainManagerDownloadRoute();
    expect(why).toMatch(/REMOTE mode/);
    expect(why).toMatch(/by design/);
    // Must NOT tell a remote user to set COMFYUI_PATH — there is no local dir to stream to.
    expect(why).not.toMatch(/set COMFYUI_PATH/);
  });

  it("explains NOTHING when no route was decided — it does not take a fresh reading", () => {
    // The round-1 defect: the explainer re-read /system_stats on the error path, so a server
    // that restarted in between was described as "did not answer", a state that routes LOCAL
    // and therefore cannot be why Manager was chosen. It narrated a decision that never
    // happened. With no recorded decision there is nothing truthful to say.
    expect(explainManagerDownloadRoute()).toBe("");
  });

  it("an UNREACHABLE server explains nothing, because that state routes LOCAL", async () => {
    // Reaching the explainer with this observation would mean the record and the route
    // disagree. Inventing a reason there is how a diagnostic starts lying.
    hoisted.stats.value = undefined;
    await shouldDispatchDownloadToManager();
    expect(explainManagerDownloadRoute()).toBe("");
  });

  it("names the ARGV AND CWD it actually saw, because that is what identifies the case", async () => {
    // The reporter's report had no argv, and without it neither they nor I can tell which
    // of the conditions fired. Putting the observation in the message is the whole point.
    // The real shape a Windows ComfyUI reports: a RELATIVE main.py and no cwd at all.
    const argv0 = String.raw`ComfyUI\main.py`;
    hoisted.stats.value = { system: { argv: [argv0, "--listen"], cwd: undefined } };
    await shouldDispatchDownloadToManager();
    const why = explainManagerDownloadRoute();
    expect(why).toContain(argv0);
    expect(why).toMatch(/cwd=\(not reported\)/);
    expect(why).toMatch(/set COMFYUI_PATH/);
    expect(why).toMatch(/#1374/);
  });

  it("a RELATIVE --base-directory with no cwd is called out specifically", async () => {
    // This one has a different remedy (an absolute --base-directory), and lumping it in
    // with the generic case would send the user to a fix that does not apply.
    hoisted.stats.value = {
      system: { argv: ["main.py", "--base-directory", "./models"], cwd: undefined },
    };
    await shouldDispatchDownloadToManager();
    const why = explainManagerDownloadRoute();
    expect(why).toMatch(/RELATIVE --base-directory/);
    expect(why).toMatch(/ABSOLUTE --base-directory/);
  });
});
