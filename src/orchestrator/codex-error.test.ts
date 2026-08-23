import { describe, expect, it } from "vitest";
import { formatCodexTurnError } from "./codex-error.js";

describe("formatCodexTurnError (#2112)", () => {
  it("turns the reported JSON-string Bad Request into an actionable unknown-400 diagnosis", () => {
    const text = formatCodexTurnError({ message: '{"detail":"Bad Request"}' });

    expect(text).toContain("HTTP 400 Bad Request");
    expect(text).toContain("no error code or request id");
    expect(text).toContain("oversized context or tool history");
    expect(text).toContain("Retry once");
    expect(text).not.toContain('{"detail":"Bad Request"}');
  });

  it("preserves safe provider diagnostics without dumping arbitrary request data", () => {
    const text = formatCodexTurnError({
      status: 400,
      message: "Bad Request",
      code: "invalid_request_error",
      type: "invalid_request",
      request_id: "req_abc123",
      input: "secret prompt content that must not reach the panel",
      data: { raw_body: "do not copy this" },
    });

    expect(text).toContain("code=invalid_request_error");
    expect(text).toContain("type=invalid_request");
    expect(text).toContain("request_id=req_abc123");
    expect(text).not.toContain("secret prompt");
    expect(text).not.toContain("do not copy this");
    expect(text).not.toContain("no error code or request id");
  });

  it("finds diagnostics nested in the app-server data envelope", () => {
    const text = formatCodexTurnError({
      message: "Bad Request",
      data: { code: "context_length_exceeded", type: "invalid_request_error", request_id: "req_nested" },
    });

    expect(text).toContain("code=context_length_exceeded");
    expect(text).toContain("type=invalid_request_error");
    expect(text).toContain("request_id=req_nested");
  });

  it("recognizes numeric and nested 400 markers without reflecting a prompt-bearing message", () => {
    const text = formatCodexTurnError({
      code: 400,
      message: "Bad Request: secret prompt content",
      details: { status: 400, request_id: "req_numeric" },
    });

    expect(text).toContain("HTTP 400 Bad Request");
    expect(text).toContain("request_id=req_numeric");
    expect(text).not.toContain("secret prompt");
  });

  it("keeps a numeric 400 marker when a nested provider code wins display precedence (#2114)", () => {
    const text = formatCodexTurnError({
      code: 400,
      message: "Invalid request",
      data: { code: "invalid_request_error" },
    });

    expect(text).toContain("HTTP 400 Bad Request");
    expect(text).toContain("code=invalid_request_error");
    expect(text).not.toContain("Invalid request");
  });

  it("does not treat a non-400 transport marker as an HTTP 400", () => {
    expect(
      formatCodexTurnError({
        code: -32600,
        message: "Invalid request",
        data: { code: "invalid_request_error" },
      }),
    ).toBe("Invalid request");
  });

  it("does not rewrite non-400 provider errors", () => {
    expect(formatCodexTurnError({ message: "provider unavailable", status: 503 })).toBe("provider unavailable");
    expect(formatCodexTurnError({ message: "" })).toBe("");
    expect(formatCodexTurnError({})).toBe("Codex error");
  });
});
