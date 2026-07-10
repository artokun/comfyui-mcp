import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorToToolResult } from "../utils/errors.js";
import { evaluateBatch } from "../services/calc-evaluator.js";

/**
 * Split a spec string into individual expressions. We split ONLY on newlines
 * and semicolons — never commas, since commas are argument separators inside
 * call lists like `min(1, 2)`. Blank lines are dropped.
 */
function splitSpec(spec: string): string[] {
  return spec
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function renderNumber(n: number | null): string {
  if (n === null) return "null";
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : "-Infinity";
  return String(n);
}

export function registerCalculateTools(server: McpServer): void {
  server.tool(
    "calculate",
    "Evaluate a batch of math expressions exactly — no ComfyUI connection needed, so it works even in cloud mode or when ComfyUI is down. A safe, zero-dependency expression evaluator (no eval): numbers only, no strings/arrays/property access. Handy for the arithmetic agents get wrong token-by-token.\n\n" +
      "Each line is one expression. `name = expr` assigns a variable that persists into later lines. Lines are separated by newlines or semicolons ONLY — commas are argument separators (e.g. min(a, b)), never expression separators.\n\n" +
      "Operators: + - * / // (floor div) % (modulo) ** (power, right-assoc), comparisons < <= > >= == != (return 1/0), unary minus. Constants: pi, e, tau. Functions: abs round min max pow sqrt floor ceil sin cos tan asin acos atan atan2 sinh cosh tanh exp log log10 log2 hypot radians degrees sign trunc clamp(x,lo,hi), plus seeded RNG rand() random() uniform(a,b) randint(a,b) (inclusive). Pass `seed` for reproducible RNG; it is echoed back when omitted.\n\n" +
      "Examples:\n" +
      "• SDXL-legal resolution from an aspect ratio, snapped to /64:\n" +
      "    variables={ar: 1.5}; spec=\"w = floor(sqrt(1024*1024*ar)/64)*64\\nh = floor(sqrt(1024*1024/ar)/64)*64\"\n" +
      "• Reproducible seed batch (one 32-bit seed per line):\n" +
      "    spec=\"randint(0, 2**32-1)\\nrandint(0, 2**32-1)\\nrandint(0, 2**32-1)\", seed=42\n" +
      "• CFG sweep:\n" +
      "    spec=\"3 + 0*0.5\\n3 + 1*0.5\\n3 + 2*0.5\\n3 + 3*0.5\"",
    {
      spec: z
        .union([z.string(), z.array(z.string())])
        .describe(
          "Expressions to evaluate, separated by newlines/semicolons (string) or one per array item. `name = expr` assigns; assignments persist across subsequent lines. NOTE: comma is an argument separator (min(a,b)), NOT an expression separator.",
        ),
      variables: z
        .record(z.string(), z.number())
        .optional()
        .describe('Initial variable environment, e.g. {"w": 1024, "ar": 1.5}.'),
      seed: z
        .number()
        .int()
        .optional()
        .describe(
          "Seed for rand()/uniform(a,b)/randint(a,b). Same seed => identical sequence (mulberry32). Omit for a random seed (echoed in the result).",
        ),
    },
    async (args) => {
      try {
        const exprs = Array.isArray(args.spec)
          ? args.spec.map((s) => s.trim()).filter((s) => s.length > 0)
          : splitSpec(args.spec);

        if (exprs.length === 0) {
          throw new Error("No expressions to evaluate (spec was empty after splitting).");
        }

        const { results, variables, errors, seed } = evaluateBatch(
          exprs,
          args.variables,
          args.seed,
        );

        // Rendered text summary.
        const lines: string[] = [];
        for (let i = 0; i < exprs.length; i++) {
          const r = results[i];
          const rendered = renderNumber(r);
          const flag =
            r !== null && (Number.isNaN(r) || !Number.isFinite(r)) ? "  ⚠ non-finite" : "";
          lines.push(`  [${i + 1}] ${exprs[i]}  =>  ${rendered}${flag}`);
        }

        const varKeys = Object.keys(variables);
        const varLine =
          varKeys.length > 0
            ? varKeys.map((k) => `${k}=${renderNumber(variables[k])}`).join(", ")
            : "(none)";

        const parts: string[] = [];
        parts.push("results:");
        parts.push(lines.join("\n"));
        parts.push("");
        parts.push(`variables: ${varLine}`);
        parts.push(`seed: ${seed}`);
        if (errors.length > 0) {
          parts.push("");
          parts.push("errors:");
          for (const e of errors) {
            parts.push(`  line ${e.line}: ${e.expr}  —  ${e.message}`);
          }
        }

        const text = parts.join("\n");

        return {
          content: [
            { type: "text" as const, text },
            {
              type: "text" as const,
              text: JSON.stringify({ results, variables, errors, seed }),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
