/**
 * #2790 — `panel_set_widget` forwards the panel's MiniMaxH3Director derived-widget
 * refusal, which recommended a frontend PrimitiveNode for
 * `external_prompt_overwrite`. `panel_connect` refuses that pairing (#2536)
 * because the socket is forceInput-only. Rewrite the producer advice with the
 * same helper `panel_connect` uses so the two tools cannot diverge.
 */

import { backendStringProducerConnectAdvice } from "./primitive-force-input-connect.js";

export const MINIMAX_H3_DIRECTOR_TYPE = "MiniMaxH3Director";
export const MINIMAX_H3_DIRECTOR_EXTERNAL_PROMPT_INPUT = "external_prompt_overwrite";

const PANEL_PRIMITIVE_NODE_WORKAROUND =
  /connect a PrimitiveNode STRING output to "external_prompt_overwrite", then set the PrimitiveNode's STRING value with panel_set_widget\.?/g;

const PANEL_PRIMITIVE_NODE_WORKAROUND_SENTENCE =
  /Use the node's supported external_prompt_overwrite path instead: connect a PrimitiveNode STRING output to "external_prompt_overwrite", then set the PrimitiveNode's STRING value with panel_set_widget\.?/g;

export function miniMaxH3DirectorExternalPromptAdvice(): string {
  return (
    `Use the node's supported ${MINIMAX_H3_DIRECTOR_EXTERNAL_PROMPT_INPUT} path instead: ` +
    backendStringProducerConnectAdvice(MINIMAX_H3_DIRECTOR_EXTERNAL_PROMPT_INPUT)
  );
}

/**
 * Replace a MiniMaxH3Director refusal's PrimitiveNode producer with the shared
 * backend STRING producer. Leaves unrelated text (and other node types) alone.
 */
export function rewriteMiniMaxH3DirectorPrimitiveAdvice(text: string): string {
  if (!text.includes(MINIMAX_H3_DIRECTOR_TYPE)) return text;
  if (!text.includes(MINIMAX_H3_DIRECTOR_EXTERNAL_PROMPT_INPUT)) return text;
  if (!text.includes("PrimitiveNode")) return text;
  const sentence = text.replace(
    PANEL_PRIMITIVE_NODE_WORKAROUND_SENTENCE,
    miniMaxH3DirectorExternalPromptAdvice(),
  );
  if (sentence !== text) return sentence;
  return text.replace(
    PANEL_PRIMITIVE_NODE_WORKAROUND,
    backendStringProducerConnectAdvice(MINIMAX_H3_DIRECTOR_EXTERNAL_PROMPT_INPUT),
  );
}
