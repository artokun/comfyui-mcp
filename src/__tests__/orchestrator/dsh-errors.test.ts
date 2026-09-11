import { it, expect } from "vitest";
import { turnErrorMessage } from "../../orchestrator/dsh-errors.js";
it("does not expose raw upstream credentials or endpoints", () => {
  const text = turnErrorMessage({
    message:
      "HTTP 401: api_key=fixture-private-value https://private.invalid/request",
  });
  expect(text).toContain("authentication");
  expect(text).not.toContain("fixture-private-value");
  expect(text).not.toContain("private.invalid");
});
it("does not mislabel a weekly quota as a five-hour quota", () => {
  const text = turnErrorMessage({
    message: "GoUsageLimitError Weekly usage limit reached",
  });
  expect(text).toContain("OpenCode Go usage limit");
  expect(text).not.toContain("5-hour");
});
it("keeps an empty response distinct from a connection failure", () => {
  const text = turnErrorMessage({ code: "EMPTY_RESPONSE" });
  expect(text).toContain("empty response");
  expect(text).toContain("not automatically retried");
  expect(text).toContain("original prompt ID");
});
