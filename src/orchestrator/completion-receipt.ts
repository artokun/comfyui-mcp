/**
 * Build the panel receipt for a keyed run-completion frame.
 *
 * A negative receipt is still an acknowledgement of the panel-to-orchestrator
 * delivery. It says the frame reached the journal, but its key cannot be
 * accepted for the current ticket generation. The panel must retire its
 * transport retry in that case; otherwise it spends its bounded replay budget
 * repeating a frame the orchestrator already has (#2700, recurrence of #925).
 */
export type CompletionReceipt = {
  type: "ack";
  ok: boolean;
  kind: "completion";
  prompt_id: string;
  completion_key: string;
  reason?: "uncorrelated";
};

/** The prompt-id spelling shared by journal correlation and Panel map keys. */
export function canonicalPromptId(promptId: unknown): string | undefined {
  if (typeof promptId !== "string") return undefined;
  const canonical = promptId.trim();
  return canonical || undefined;
}

export function buildCompletionReceipt(
  promptId: unknown,
  completionKey: unknown,
  accepted: boolean,
): CompletionReceipt | undefined {
  const canonicalId = canonicalPromptId(promptId);
  if (
    canonicalId === undefined ||
    typeof completionKey !== "string" ||
    completionKey.length === 0 ||
    completionKey.length > 512
  ) {
    return undefined;
  }

  return {
    type: "ack",
    ok: accepted,
    kind: "completion",
    prompt_id: canonicalId,
    completion_key: completionKey,
    ...(accepted ? {} : { reason: "uncorrelated" as const }),
  };
}
