// #2773 — the Manager body-read deadline is derived a SECOND time.
//
// `managerBodyTimeoutSignal` cannot call `defaultComfyTimeoutSignal`: suites that
// mock `comfyui/fetch.js` do not declare that export, so importing it would make
// those files fail to load. The workaround is a local copy of the derivation —
// and a copied constant with nothing comparing the two drifts silently. Raising
// DEFAULT_COMFY_HTTP_TIMEOUT_S would leave the Manager body read at 120s with
// every test still green.
//
// This is the comparison. It imports both REAL modules (no mocks) so it fails the
// moment the two rules disagree.
import { afterEach, describe, expect, it } from "vitest";
import { comfyHttpTimeoutSeconds } from "../../comfyui/fetch.js";
import { managerBodyTimeoutSeconds } from "../../services/node-management.js";

const KEY = "COMFYUI_MCP_HTTP_TIMEOUT_S";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("#2773 the Manager body deadline agrees with the shared HTTP deadline", () => {
  it("matches on the DEFAULT, which is the value that silently drifts", () => {
    delete process.env[KEY];
    expect(managerBodyTimeoutSeconds()).toBe(comfyHttpTimeoutSeconds());
  });

  it("matches when the env var is set, and on each way of being invalid", () => {
    for (const value of ["45", "0", "-1", "", "abc"]) {
      process.env[KEY] = value;
      expect(managerBodyTimeoutSeconds()).toBe(comfyHttpTimeoutSeconds());
    }
  });
});
