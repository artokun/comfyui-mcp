import { randomInt } from "node:crypto";

/**
 * Safe batch expression evaluator — zero dependencies, no `eval`/`new Function`.
 *
 * A tiny hand-rolled tokenizer + Pratt parser that evaluates arithmetic
 * directly (no retained AST). Numbers only: no strings, arrays, objects, or
 * property access. Statement-level assignment (`name = expr`) persists across
 * lines. Seeded RNG (mulberry32) makes `rand`/`uniform`/`randint` reproducible.
 *
 * See docs/design/calculate-tool.md for the full design.
 */

/** Hard caps to keep a single call bounded. */
export const MAX_EXPRESSIONS = 1000;
export const MAX_EXPR_CHARS = 10_000;

export interface BatchError {
  line: number;
  expr: string;
  message: string;
}

export interface BatchResult {
  results: (number | null)[];
  variables: Record<string, number>;
  errors: BatchError[];
  seed: number;
}

// ---------------------------------------------------------------------------
// Seeded RNG — mulberry32
// ---------------------------------------------------------------------------

/** mulberry32: a fast, decent 32-bit seeded PRNG. Returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = "number" | "ident" | "op" | "lparen" | "rparen" | "comma" | "eof";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

// Multi-char operators must be tried before their single-char prefixes.
const OPERATORS = ["**", "//", "<=", ">=", "==", "!=", "+", "-", "*", "/", "%", "<", ">", "="];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }

    // numbers: int / float / scientific
    if (ch >= "0" && ch <= "9") {
      const start = i;
      while (i < n && src[i] >= "0" && src[i] <= "9") i++;
      if (src[i] === ".") {
        i++;
        while (i < n && src[i] >= "0" && src[i] <= "9") i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (j < n && src[j] >= "0" && src[j] <= "9") {
          i = j;
          while (i < n && src[i] >= "0" && src[i] <= "9") i++;
        }
      }
      tokens.push({ type: "number", value: src.slice(start, i), pos: start });
      continue;
    }

    // leading-dot floats: `.5`
    if (ch === "." && src[i + 1] >= "0" && src[i + 1] <= "9") {
      const start = i;
      i++;
      while (i < n && src[i] >= "0" && src[i] <= "9") i++;
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (j < n && src[j] >= "0" && src[j] <= "9") {
          i = j;
          while (i < n && src[i] >= "0" && src[i] <= "9") i++;
        }
      }
      tokens.push({ type: "number", value: src.slice(start, i), pos: start });
      continue;
    }

    // identifiers: letter or underscore, then alphanumerics/underscore
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      const start = i;
      while (
        i < n &&
        ((src[i] >= "a" && src[i] <= "z") ||
          (src[i] >= "A" && src[i] <= "Z") ||
          (src[i] >= "0" && src[i] <= "9") ||
          src[i] === "_")
      )
        i++;
      tokens.push({ type: "ident", value: src.slice(start, i), pos: start });
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen", value: "(", pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ")", pos: i });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ",", pos: i });
      i++;
      continue;
    }

    // operators (multi-char first)
    let matched = false;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        tokens.push({ type: "op", value: op, pos: i });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  tokens.push({ type: "eof", value: "", pos: n });
  return tokens;
}

// ---------------------------------------------------------------------------
// Constants & function table
// ---------------------------------------------------------------------------

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

function radians(x: number): number {
  return (x * Math.PI) / 180;
}
function degrees(x: number): number {
  return (x * 180) / Math.PI;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/**
 * Function table. Each entry declares an arity range [min, max] and the impl.
 * RNG-backed functions receive the per-call `rng` closure.
 */
interface FnDef {
  min: number;
  max: number;
  fn: (args: number[], rng: () => number) => number;
}

const FUNCTIONS: Record<string, FnDef> = {
  abs: { min: 1, max: 1, fn: (a) => Math.abs(a[0]) },
  round: { min: 1, max: 1, fn: (a) => Math.round(a[0]) },
  min: { min: 1, max: Infinity, fn: (a) => Math.min(...a) },
  max: { min: 1, max: Infinity, fn: (a) => Math.max(...a) },
  pow: { min: 2, max: 2, fn: (a) => Math.pow(a[0], a[1]) },
  sqrt: { min: 1, max: 1, fn: (a) => Math.sqrt(a[0]) },
  floor: { min: 1, max: 1, fn: (a) => Math.floor(a[0]) },
  ceil: { min: 1, max: 1, fn: (a) => Math.ceil(a[0]) },
  sin: { min: 1, max: 1, fn: (a) => Math.sin(a[0]) },
  cos: { min: 1, max: 1, fn: (a) => Math.cos(a[0]) },
  tan: { min: 1, max: 1, fn: (a) => Math.tan(a[0]) },
  asin: { min: 1, max: 1, fn: (a) => Math.asin(a[0]) },
  acos: { min: 1, max: 1, fn: (a) => Math.acos(a[0]) },
  atan: { min: 1, max: 1, fn: (a) => Math.atan(a[0]) },
  atan2: { min: 2, max: 2, fn: (a) => Math.atan2(a[0], a[1]) },
  sinh: { min: 1, max: 1, fn: (a) => Math.sinh(a[0]) },
  cosh: { min: 1, max: 1, fn: (a) => Math.cosh(a[0]) },
  tanh: { min: 1, max: 1, fn: (a) => Math.tanh(a[0]) },
  exp: { min: 1, max: 1, fn: (a) => Math.exp(a[0]) },
  log: { min: 1, max: 2, fn: (a) => (a.length === 2 ? Math.log(a[0]) / Math.log(a[1]) : Math.log(a[0])) },
  log10: { min: 1, max: 1, fn: (a) => Math.log10(a[0]) },
  log2: { min: 1, max: 1, fn: (a) => Math.log2(a[0]) },
  hypot: { min: 1, max: Infinity, fn: (a) => Math.hypot(...a) },
  radians: { min: 1, max: 1, fn: (a) => radians(a[0]) },
  degrees: { min: 1, max: 1, fn: (a) => degrees(a[0]) },
  sign: { min: 1, max: 1, fn: (a) => Math.sign(a[0]) },
  trunc: { min: 1, max: 1, fn: (a) => Math.trunc(a[0]) },
  clamp: { min: 3, max: 3, fn: (a) => clamp(a[0], a[1], a[2]) },
  // RNG-backed
  rand: { min: 0, max: 0, fn: (_a, rng) => rng() },
  random: { min: 0, max: 0, fn: (_a, rng) => rng() },
  uniform: { min: 2, max: 2, fn: (a, rng) => a[0] + rng() * (a[1] - a[0]) },
  // inclusive both ends, matching Python's random.randint
  randint: {
    min: 2,
    max: 2,
    fn: (a, rng) => {
      const lo = Math.ceil(a[0]);
      const hi = Math.floor(a[1]);
      if (hi < lo) throw new Error(`randint: empty range [${a[0]}, ${a[1]}]`);
      return lo + Math.floor(rng() * (hi - lo + 1));
    },
  },
};

// ---------------------------------------------------------------------------
// Pratt parser + direct evaluator (single expression)
// ---------------------------------------------------------------------------

// Binary operator binding powers. Higher binds tighter. `**` is right-assoc.
const BINARY_BP: Record<string, number> = {
  "==": 1,
  "!=": 1,
  "<": 1,
  "<=": 1,
  ">": 1,
  ">=": 1,
  "+": 2,
  "-": 2,
  "*": 3,
  "/": 3,
  "//": 3,
  "%": 3,
  "**": 5, // above unary (4) so `-2**2` = -(2**2)
};

class Evaluator {
  private tokens: Token[];
  private idx = 0;

  constructor(
    tokens: Token[],
    private env: Map<string, number>,
    private rng: () => number,
  ) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.idx];
  }
  private next(): Token {
    return this.tokens[this.idx++];
  }

  /** Parse+evaluate a full statement (top level). Handles `name = expr`. */
  evalStatement(): number {
    // Assignment: `ident = expr` (only as a full statement, no chaining).
    if (
      this.peek().type === "ident" &&
      this.tokens[this.idx + 1]?.type === "op" &&
      this.tokens[this.idx + 1].value === "="
    ) {
      const name = this.next().value; // ident
      this.next(); // '='
      if (Object.hasOwn(CONSTANTS, name)) {
        throw new Error(`Cannot assign to constant '${name}'`);
      }
      if (Object.hasOwn(FUNCTIONS, name)) {
        throw new Error(`Cannot assign to function name '${name}'`);
      }
      const value = this.parseExpr(0);
      this.expectEof();
      this.env.set(name, value);
      return value;
    }

    const value = this.parseExpr(0);
    this.expectEof();
    return value;
  }

  private expectEof(): void {
    if (this.peek().type !== "eof") {
      const t = this.peek();
      throw new Error(`Unexpected token '${t.value || t.type}' at position ${t.pos}`);
    }
  }

  /** Pratt loop: parse a prefix, then fold in binary operators >= minBp. */
  private parseExpr(minBp: number): number {
    let left = this.parsePrefix();

    for (;;) {
      const t = this.peek();
      if (t.type !== "op") break;
      const op = t.value;
      if (op === "=") break; // assignment is statement-only
      const bp = BINARY_BP[op];
      if (bp === undefined || bp < minBp) break;

      this.next(); // consume operator
      const rightAssoc = op === "**";
      const right = this.parseExpr(rightAssoc ? bp : bp + 1);
      left = this.applyBinary(op, left, right);
    }

    return left;
  }

  private parsePrefix(): number {
    const t = this.peek();

    // unary minus / plus (binding power 4 — below **, above binary +/-)
    if (t.type === "op" && (t.value === "-" || t.value === "+")) {
      this.next();
      const operand = this.parseExpr(4);
      return t.value === "-" ? -operand : operand;
    }

    if (t.type === "number") {
      this.next();
      return Number(t.value);
    }

    if (t.type === "lparen") {
      this.next();
      const value = this.parseExpr(0);
      const close = this.next();
      if (close.type !== "rparen") {
        throw new Error(`Expected ')' at position ${close.pos}`);
      }
      return value;
    }

    if (t.type === "ident") {
      this.next();
      const name = t.value;

      // function call?
      if (this.peek().type === "lparen") {
        const fnDef = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
        if (!fnDef) throw new Error(`Unknown function '${name}'`);
        const args = this.parseArgs();
        if (args.length < fnDef.min || args.length > fnDef.max) {
          const arity =
            fnDef.min === fnDef.max
              ? `${fnDef.min}`
              : fnDef.max === Infinity
                ? `${fnDef.min}+`
                : `${fnDef.min}-${fnDef.max}`;
          throw new Error(`${name}() expects ${arity} argument(s), got ${args.length}`);
        }
        return fnDef.fn(args, this.rng);
      }

      // constant?
      if (Object.hasOwn(CONSTANTS, name)) return CONSTANTS[name];

      // variable?
      if (this.env.has(name)) return this.env.get(name)!;

      // Bare function name used as a value, or truly unknown.
      if (Object.hasOwn(FUNCTIONS, name)) {
        throw new Error(`'${name}' is a function; call it as ${name}(...)`);
      }
      throw new Error(`Unknown identifier '${name}'`);
    }

    throw new Error(`Unexpected token '${t.value || t.type}' at position ${t.pos}`);
  }

  private parseArgs(): number[] {
    this.next(); // consume '('
    const args: number[] = [];
    if (this.peek().type === "rparen") {
      this.next();
      return args;
    }
    for (;;) {
      args.push(this.parseExpr(0));
      const t = this.peek();
      if (t.type === "comma") {
        this.next();
        continue;
      }
      if (t.type === "rparen") {
        this.next();
        break;
      }
      throw new Error(`Expected ',' or ')' at position ${t.pos}`);
    }
    return args;
  }

  private applyBinary(op: string, l: number, r: number): number {
    switch (op) {
      case "+":
        return l + r;
      case "-":
        return l - r;
      case "*":
        return l * r;
      case "/":
        return l / r;
      case "//":
        return Math.floor(l / r);
      case "%": {
        // Python-style modulo (result takes sign of divisor).
        return ((l % r) + r) % r;
      }
      case "**":
        return Math.pow(l, r);
      case "<":
        return l < r ? 1 : 0;
      case "<=":
        return l <= r ? 1 : 0;
      case ">":
        return l > r ? 1 : 0;
      case ">=":
        return l >= r ? 1 : 0;
      case "==":
        return l === r ? 1 : 0;
      case "!=":
        return l !== r ? 1 : 0;
      default:
        throw new Error(`Unknown operator '${op}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a batch of expressions with persistent assignments.
 *
 * @param spec       One expression per array item. `name = expr` assigns and
 *                   persists into later lines.
 * @param variables  Initial variable environment (not mutated).
 * @param seed       Seed for rand()/uniform()/randint(). When omitted, a seed
 *                   is drawn via crypto and echoed in the result.
 */
export function evaluateBatch(
  spec: string[],
  variables?: Record<string, number>,
  seed?: number,
): BatchResult {
  if (spec.length > MAX_EXPRESSIONS) {
    throw new Error(`Too many expressions: ${spec.length} (max ${MAX_EXPRESSIONS})`);
  }

  // Resolve the seed: explicit (coerced to uint32) or drawn from crypto.
  const resolvedSeed = seed === undefined ? randomInt(0, 0x1_0000_0000) : seed >>> 0;
  const rng = mulberry32(resolvedSeed);

  // Environment seeded from input variables; the input object is never mutated.
  const env = new Map<string, number>();
  if (variables) {
    for (const [k, v] of Object.entries(variables)) env.set(k, v);
  }

  const results: (number | null)[] = [];
  const errors: BatchError[] = [];

  for (let i = 0; i < spec.length; i++) {
    const expr = spec[i];
    try {
      if (expr.length > MAX_EXPR_CHARS) {
        throw new Error(`Expression too long: ${expr.length} chars (max ${MAX_EXPR_CHARS})`);
      }
      const tokens = tokenize(expr);
      // Bare comment/blank guard: a statement with no real tokens.
      if (tokens.length === 1 && tokens[0].type === "eof") {
        throw new Error("Empty expression");
      }
      const value = new Evaluator(tokens, env, rng).evalStatement();
      results.push(value);
    } catch (err) {
      results.push(null);
      errors.push({
        line: i + 1,
        expr,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    results,
    variables: Object.fromEntries(env),
    errors,
    seed: resolvedSeed,
  };
}
