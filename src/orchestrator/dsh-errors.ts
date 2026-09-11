/** Categorize errors without rendering raw provider bodies, endpoints or credentials. */
export function turnErrorMessage(error: unknown): string {
  const record =
    error && typeof error === "object"
      ? (error as {
          message?: unknown;
          code?: unknown;
          data?: { details?: unknown };
        })
      : {};
  const text = [record.message, record.data?.details]
    .filter((value) => typeof value === "string")
    .join(" ");
  const imageLimit = /At most (\d+) image\(s\) may be provided/i.exec(text);
  let reason: string;
  if (/finish_reason\s*:\s*sensitive/i.test(text))
    reason =
      "The provider declined the content. Adjust the request to meet its rules.";
  else if (imageLimit)
    reason = `The provider accepts at most ${imageLimit[1]} images per request, including history.`;
  else if (/GoUsageLimitError/i.test(text))
    reason =
      "The OpenCode Go usage limit was reached. Wait for the limit to reset or choose another provider.";
  else if (
    /cannot admit this image|does not declare image input|image prompts were not advertised/i.test(
      text,
    )
  )
    reason = "This model or connection does not advertise image input.";
  else if (/blind mode|changing blind/i.test(text))
    reason =
      "Blind mode prevents this image-bearing request. Use a session matching the selected mode.";
  else if (/\b401\b|\b403\b|MISSING_CREDENTIAL|INVALID_CREDENTIAL/.test(text))
    reason = "The provider rejected authentication or access.";
  else if (
    /\b429\b|RATE_LIMIT|QUOTA_EXCEEDED/.test(text) ||
    record.code === "QUOTA"
  )
    reason = "The provider reported a quota or rate limit.";
  else if (/DSH_IMAGE_READ_TIMEOUT/.test(text))
    reason =
      "Reading the ComfyUI image timed out before model delivery. Retrieve the existing output again.";
  else if (/DSH_IMAGE_READ_FAILED/.test(text))
    reason = "The ComfyUI image could not be read before model delivery.";
  else if (
    record.code === "EMPTY_RESPONSE" ||
    /EMPTY_RESPONSE|returned a completed response with no content/i.test(text)
  )
    reason =
      "The provider returned an empty response; this reply is incomplete.";
  else if (/timeout|timed out|TIMEOUT/i.test(text))
    reason = "The model request timed out.";
  else if (/connection.*closed|disconnect/i.test(text))
    reason = "The DSH connection closed.";
  else if (
    /connection error|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i.test(
      text,
    )
  )
    reason =
      "The server could not reach the model provider. Check its network, DNS and proxy configuration.";
  else reason = "The model request failed.";
  return `DSH: ${reason} This turn was not automatically retried. The original session was retained. Check the original prompt ID before resubmitting any generation.`;
}
