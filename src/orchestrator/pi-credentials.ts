// pi.dev (#491) credential DETECTION — "does a usable provider credential exist
// on this machine?", answered from disk + env only.
//
// Why this is its own module: `pi --list-models` is NOT an auth probe (it prints
// the built-in catalog with no key at all), so unlike every other CLI backend the
// connect-time model probe cannot tell us whether pi can actually authenticate.
// Readiness therefore has to reproduce pi's own credential resolution. The rules
// below are transcribed from pi's source (earendil-works/pi @ main) rather than
// guessed; each is cited at its use site so a future reader can re-verify:
//
//   packages/ai/src/env-api-keys.ts          — `envMap` + the anthropic/copilot specials
//   packages/ai/src/auth/types.ts            — ApiKeyCredential / OAuthCredential shapes
//   packages/coding-agent/src/core/auth-storage.ts — auth.json is stripBom + plain JSON.parse
//   packages/coding-agent/src/core/model-config.ts — models.json is stripBom + JSONC + `{providers:{…}}`
//   packages/coding-agent/src/utils/text.ts  — stripBom (leading U+FEFF only)
//   packages/coding-agent/src/utils/json.ts  — the exact stripJsonComments behaviour
//   packages/ai/src/providers/google-vertex.ts — Vertex ADC (creds path + project + location)
//
// PRECISION BAR (deliberate): "ready" means a plausible, WELL-FORMED, PRESENT
// credential source — not a proven-working one. A revoked key, an exhausted quota
// or a typo'd secret is invisible from disk and still fails on the first turn;
// that residual is accepted and the panel/banner wording must not over-promise.
// What we do NOT accept is greening on a source that CANNOT authenticate no
// matter what: a record with no key at all, a credentials path pointing at a file
// that isn't there, or an empty provider stanza.
//
// Scope note: this is accidental-wrongness only. There is no adversarial model
// here — a user who hand-edits their own auth.json to lie is out of scope (this
// is a local single-trust-domain project).

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { TOOL_ONLY_SECRET_ENV_KEYS } from "../services/panel-secrets.js";

/**
 * Every env var pi reads as a provider credential.
 *
 * Transcribed from `envMap` in packages/ai/src/env-api-keys.ts, plus the three
 * exported anthropic constants (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_OAUTH_TOKEN /
 * ANTHROPIC_API_KEY) and the github-copilot special case, which live outside the
 * map. Ordered by provider id to keep it diff-able against pi's file.
 *
 * NOT every entry here necessarily reaches pi's subprocess — see
 * `piEnvKeysReachingPi()`, which subtracts the ComfyUI tool-only secrets that
 * buildAgentSpawnEnv() strips. Keep this list a faithful copy of pi's map; do the
 * subtraction there, not by editing this array.
 */
export const PI_PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  // anthropic is special-cased in pi: three accepted vars, any one suffices.
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
  // envMap, in pi's own order.
  "ant-ling": ["ANT_LING_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"], // stripped before it reaches pi — see below
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  huggingface: ["HF_TOKEN"], // stripped before it reaches pi — see below
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"], // special-cased in pi
  // Documented in packages/coding-agent/docs/providers.md but absent from
  // `envMap`, which only covers the api-key providers.
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
};

/**
 * Extra env vars a provider needs ALONGSIDE its key when authenticating purely
 * from the environment. pi's cloudflare-auth.ts returns undefined unless both the
 * key and the account id are present (plus the gateway id for the AI Gateway),
 * so the key alone is not a credential. Only providers whose companion
 * requirement is confirmed in pi's source are listed here.
 */
const PI_PROVIDER_ENV_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  "cloudflare-workers-ai": ["CLOUDFLARE_ACCOUNT_ID"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
};

/** Flat view of every credential env var pi reads. */
export const PI_ENV_API_KEYS: readonly string[] = Object.values(PI_PROVIDER_ENV_KEYS).flat();

/**
 * The subset of `PI_ENV_API_KEYS` that actually SURVIVES into pi's spawn env.
 *
 * pi is spawned with `buildAgentSpawnEnv()` (no keep-list), which deletes the
 * ComfyUI tool-only secrets. A key that gets stripped must never green pi:
 * `GEMINI_API_KEY` and `HF_TOKEN` are ComfyUI tool secrets, so a user whose ONLY
 * credential is one of those has a pi that cannot authenticate — its first turn
 * would fail. Those users must put the key in ~/.pi/agent/auth.json instead.
 *
 * Derived (not hand-maintained) so that changing the secret allowlists in
 * panel-secrets.ts automatically keeps pi's readiness honest.
 */
export function piEnvKeysReachingPi(): string[] {
  const stripped = new Set<string>(TOOL_ONLY_SECRET_ENV_KEYS);
  return PI_ENV_API_KEYS.filter((k) => !stripped.has(k));
}

/**
 * pi's JSONC pre-pass, byte-for-byte the same behaviour as `stripJsonComments`
 * in packages/coding-agent/src/utils/json.ts: strips `//` line comments and
 * trailing commas before `}`/`]`, while leaving anything inside a string literal
 * alone. Block comments are deliberately NOT handled — pi doesn't handle them
 * either, and a models.json using slash-star comments fails to load for pi too,
 * so accepting it here would green a file pi itself rejects.
 */
export function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/** Valid env-var name per pi's resolver (`[A-Za-z_][A-Za-z0-9_]*`). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Every env var a credential value interpolates, in pi's parse order.
 *
 * Hand-scanned rather than regex'd because pi's resolver has escapes: in a
 * non-command value `$$` is a literal `$` and `$!` a literal `!`. A regex would
 * read `"$$MY_KEY"` as a reference to MY_KEY when pi reads it as the literal
 * string `$MY_KEY` — that mis-parse false-REDs a perfectly good key.
 */
function envRefsIn(value: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "$") continue;
    const next = value[i + 1];
    if (next === "$" || next === "!") {
      i++; // escaped literal — consume both, reference nothing
      continue;
    }
    if (next === "{") {
      const end = value.indexOf("}", i + 2);
      if (end === -1) continue;
      const name = value.slice(i + 2, end);
      if (ENV_NAME.test(name) && ENV_NAME.exec(name)?.[0] === name) {
        names.push(name);
        i = end;
      }
      continue;
    }
    const m = ENV_NAME.exec(value.slice(i + 1));
    if (m) {
      names.push(m[0]);
      i += m[0].length;
    }
  }
  return names;
}

/**
 * Is a stored credential VALUE (auth.json `key`, models.json `apiKey`) plausibly
 * resolvable? pi accepts three forms (docs/providers.md + resolveConfigValue):
 *
 *   `!some command`  → executed, output cached. We cannot verify it without
 *                      running it, and running a user command during a readiness
 *                      probe is not acceptable — so we accept it unverified.
 *   `$VAR` / `${VAR}` → interpolated from the entry's own `env` block first, then
 *                      the process env. pi resolves the WHOLE template to
 *                      undefined if any referenced var is unset, so one missing
 *                      var means this is not a credential.
 *   literal          → accepted as-is (including `$$`/`$!` escapes).
 *
 * Empty / non-string / whitespace-only is never a credential.
 */
export function credentialValueUsable(
  raw: unknown,
  entryEnv?: Record<string, unknown>,
  procEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (!value) return false;
  // `!command` — unverifiable without executing it; err toward ready.
  // pi executes the text AFTER `!`; an empty command resolves to undefined, so
  // it cannot authenticate. Do not let a lone `!` greet the user green.
  if (value.startsWith("!")) return value.slice(1).trim() !== "";
  // Every referenced var must resolve to something non-empty IN THE ENV PI WILL
  // ACTUALLY SEE. `resolveEnvConfigValue` uses the entry's own `env` block with
  // `||` fallback to the inherited process env — but a var our spawn
  // env STRIPS is never inherited, so `"key": "$GEMINI_API_KEY"` resolves for us
  // and to nothing for pi. Treating it as present would be exactly the false
  // green this whole module exists to prevent.
  const stripped = new Set<string>(TOOL_ONLY_SECRET_ENV_KEYS);
  for (const name of envRefsIn(value)) {
    const fromEntry = entryEnv?.[name];
    // pi's resolver is exactly `entryEnv?.[name] || process.env[name]`. An
    // empty entry therefore falls through to process.env; whitespace remains
    // truthy, wins, and cannot authenticate.
    const resolved = fromEntry || procEnv[name];
    if (stripped.has(name) && !fromEntry) return false;
    if (!nonEmptyString(resolved)) return false;
  }
  return true;
}

/**
 * Read a provider-scoped value with pi's `??` merge semantics.  A number of
 * bespoke providers deliberately let an explicitly-empty stored setting block
 * the ambient value; do not accidentally turn that into `||` fallback.
 */
function readNullishScoped(
  entryEnv: Record<string, unknown> | undefined,
  procEnv: NodeJS.ProcessEnv,
  key: string,
): unknown {
  const fromEntry = entryEnv?.[key];
  return fromEntry ?? procEnv[key];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/** pi refreshes any OAuth token with less than this much life left
 *  (DEFAULT_OAUTH_MINIMUM_VALIDITY_MS in packages/ai/src/auth/resolve.ts). */
const OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
// Providers whose current pi resolver accepts auth.json OAuth credentials.
// Radius OAuth is configured through models.json (`oauth: "radius"` + baseUrl),
// not an auth.json OAuth record, so it is deliberately not listed here.
const PI_OAUTH_AUTH_PROVIDERS = new Set([
  "anthropic", "github-copilot", "kimi-coding", "openai-codex", "openrouter", "xai",
]);

function expiresUsableWithoutRefresh(expires: unknown, nowMs: number): boolean {
  if (typeof expires !== "number" || !Number.isFinite(expires)) return false;
  return expires > nowMs + OAUTH_MINIMUM_VALIDITY_MS;
}

/**
 * Does one ~/.pi/agent/auth.json record carry a usable credential?
 *
 * Shapes from packages/ai/src/auth/types.ts:
 *   ApiKeyCredential { type: "api_key"; key?: string; env?: ProviderEnv }
 *   OAuthCredential  { type: "oauth"; refresh: string; access: string; expires: number }
 *
 * Note `key` is OPTIONAL in pi's TYPE. Whether a keyless api-key record is
 * usable is provider-specific: Vertex and Bedrock deliberately support it,
 * while ordinary key providers can fall back to their ambient key.
 *
 * An UNRECOGNISED `type` is not a credential either: pi's resolveProviderAuth
 * dispatches only "oauth" and "api_key" and returns undefined for anything else
 * (packages/ai/src/auth/resolve.ts) — and, because a stored credential owns the
 * provider, it does not fall back to the env. So such a record is strictly worse
 * than no record at all.
 */
export function authRecordUsable(
  record: unknown,
  procEnv: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
  ctx: { provider?: string; home?: string } = {},
): boolean {
  if (!isPlainObject(record)) return false;
  const provider = ctx.provider;
  const type = record.type;
  if (type === "api_key") {
    const entryEnv = isPlainObject(record.env) ? record.env : undefined;
    if (provider === "amazon-bedrock") {
      // Bedrock is deliberately unlike ordinary api-key providers: its resolver
      // falls through from a keyless stored record to AWS's credential chain.
      return credentialValueUsable(record.key, entryEnv, procEnv) || piBedrockCredentialUsable(entryEnv, procEnv);
    }
    // pi's Vertex `/login` writes `{type:"api_key", env:{GOOGLE_CLOUD_PROJECT, …}}`
    // with a falsy `key`, and its resolver tests `if (key)` before falling
    // falls back to ADC. So a keyless vertex record IS a credential when the ADC
    // trio resolves (from the record's own env first, then the process env) — it
    // used to read as "not signed in" for a working Vertex login.
    if (!record.key && provider === "google-vertex") {
      // google-vertex reads `credential.key ?? ctx.env(...)`: scoped `env` does
      // not supply GOOGLE_CLOUD_API_KEY, and only the process env is ambient.
      if (credentialValueUsable(procEnv.GOOGLE_CLOUD_API_KEY, undefined, procEnv))
        return true;
      return piVertexAdcUsable(ctx.home ?? homedir(), procEnv, entryEnv);
    }
    if (!credentialValueUsable(record.key, entryEnv, procEnv)) return false;
    // Companion config (cloudflare's account/gateway ids) may come from the
    // record's own `env` block or the environment; without it pi's resolver
    // returns undefined and the stored key is useless.
    const required = provider ? PI_PROVIDER_ENV_REQUIRED[provider] : undefined;
    if (required) {
      return required.every((k) => {
        const fromEntry = entryEnv?.[k];
        return (typeof fromEntry === "string" && fromEntry.trim() !== "") || !!procEnv[k]?.trim();
      });
    }
    return true;
  }
  if (type === "oauth") {
    // pi only dispatches OAuth records to providers that implement that flow.
    // An OAuth-shaped record for an API-key-only provider is not a credential.
    if (provider !== undefined && !PI_OAUTH_AUTH_PROVIDERS.has(provider)) return false;
    // A refresh token lets pi re-mint access, so a partial migrated record with
    // one remains usable even when its stored access token is expired. Without
    // it, an access token needs to survive pi's five-minute refresh window.
    if (nonEmptyString(record.refresh)) return true;
    return nonEmptyString(record.access) && expiresUsableWithoutRefresh(record.expires, nowMs);
  }
  return false;
}

/**
 * Read a pi config file the way pi does: decoded as UTF-8 with a leading byte
 * order mark REMOVED. pi passes every config read through `stripBom`
 * (packages/coding-agent/src/utils/text.ts — used by both auth-storage.ts and
 * model-config.ts since pi #8337), so a BOM'd file is perfectly valid FOR PI.
 * `JSON.parse` throws on U+FEFF, and on Windows a BOM is what PowerShell's
 * `Out-File` / `>` writes by default — without this strip a hand-edited
 * models.json or auth.json false-REDs a working install (#2995).
 */
function readFileOrNull(file: string): string | null {
  try {
    const raw = readFileSync(file, "utf8");
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } catch {
    return null;
  }
}

/**
 * Parse ~/.pi/agent/auth.json and report whether ANY provider record is usable.
 * Plain `JSON.parse` (after the BOM strip in readFileOrNull) — pi reads this
 * file with `JSON.parse(stripBom(…))` (auth-storage.ts), NOT the JSONC path it
 * uses for models.json, so a commented auth.json is broken for pi and must not
 * green here. Never throws.
 */
export function piAuthJsonUsable(
  file: string,
  procEnv: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): boolean {
  return Object.entries(piAuthRecords(file)).some(([provider, rec]) =>
    authRecordUsable(rec, procEnv, nowMs, { provider }),
  );
}

/** The parsed auth.json map, or `{}` when missing/corrupt. Used both for
 *  usability and to know WHICH providers have a stored record at all — pi's
 *  resolver states "a stored credential owns the provider: ambient/env is
 *  consulted only when nothing is stored", so a stored record suppresses that
 *  provider's env keys whether or not it works. Never throws. */
/** True only when auth.json parses to literal `null`. pi stores the parsed value
 *  as-is and then indexes it (`this.data[provider]`), which THROWS for null — so
 *  no provider resolves at all and even a good ambient env key cannot be used.
 *  Deliberately narrow: `[]`, a string or a number all index harmlessly to
 *  undefined for pi, so those must NOT suppress ambient credentials. */
function piAuthStoreBroken(file: string): boolean {
  const raw = readFileOrNull(file);
  if (raw === null) return false;
  try {
    return JSON.parse(raw) === null;
  } catch {
    return false;
  }
}

function piAuthRecords(file: string): Record<string, unknown> {
  const raw = readFileOrNull(file);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parse ~/.pi/agent/models.json and report whether a CUSTOM provider carries its
 * own credential.
 *
 * Two corrections over "the file is a non-empty object":
 *  - JSONC: pi runs stripJsonComments() before JSON.parse (model-config.ts), so a
 *    models.json with `//` comments or trailing commas is perfectly valid FOR PI.
 *    Rejecting it read as "not signed in" for a working install.
 *  - Shape + emptiness: the schema is `{ providers: { <id>: {…} } }`. The old
 *    check counted top-level keys, so `{"providers":{}}` (one key) and even
 *    `{"note":"todo"}` greened pi. A provider entry only supplies auth when it
 *    has a resolvable `apiKey` or an `oauth` mode; per docs/models.md an entry
 *    without one is loaded but its models stay UNAVAILABLE, so it is not a
 *    credential.
 *
 * Never throws.
 */
export function piModelsJsonUsable(
  file: string,
  procEnv: NodeJS.ProcessEnv = process.env,
  provider?: string,
): boolean {
  const raw = readFileOrNull(file);
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(raw));
    if (!isPlainObject(parsed)) return false;
    const providers = parsed.providers;
    if (!isPlainObject(providers)) return false;
    const entries = Object.values(providers);
    // pi validates the WHOLE file against ModelsConfigSchema and DISCARDS it on
    // any violation — so one malformed sibling provider means none of the file's
    // credentials reach pi. Reproduce that all-or-nothing behaviour rather than
    // greening off a single good-looking entry.
    if (!entries.every((p) => providerEntryValid(p))) return false;
    return Object.entries(providers).some(([id, p]) =>
      (!provider || id === provider) &&
      isPlainObject(p) &&
      (credentialValueUsable(p.apiKey, undefined, procEnv) || p.oauth === "radius"),
    );
  } catch {
    return false;
  }
}

/*
 * models.json schema validation, transcribed from pi's TypeBox schemas in
 * packages/coding-agent/src/core/model-config.ts:
 *
 *   ModelsConfigSchema   { providers: Record<string, ProviderConfig> }
 *   ProviderConfigSchema { name?, baseUrl?, apiKey?, api?: String{minLength:1},
 *                          oauth?: Literal"radius", headers?: Record<string,string>,
 *                          compat?, authHeader?: Boolean,
 *                          models?: ModelDefinition[], modelOverrides?: Record<…> }
 *   ModelDefinitionSchema{ id: String{minLength:1}, name?/api?/baseUrl?: String{minLength:1},
 *                          reasoning?: Boolean, thinkingLevelMap?, input?: ("text"|"image")[],
 *                          cost?, contextWindow?/maxTokens?: Number, headers?: Record<string,string>,
 *                          compat? }
 *
 * This matters because pi validates the file as a UNIT and DISCARDS it whole on
 * any violation — so one malformed provider means none of the file's credentials
 * reach pi. Fields whose sub-schemas we have not transcribed (compat, cost,
 * thinkingLevelMap, modelOverrides) are only shape-checked, and UNDECLARED extra
 * keys are left alone because the schemas declare no additionalProperties
 * restriction — being stricter than pi there would false-red a file it loads.
 */
function optNonEmptyString(v: unknown): boolean {
  return v === undefined || (typeof v === "string" && v.length > 0);
}

function optBoolean(v: unknown): boolean {
  return v === undefined || typeof v === "boolean";
}

/** Type.Record(Type.String(), Type.String()) — every value must be a string. */
function optStringRecord(v: unknown): boolean {
  return v === undefined || (isPlainObject(v) && Object.values(v).every((x) => typeof x === "string"));
}

/** Type.Number(), plus provider-composer's runtime `<= 0` rejection. */
function optPositiveNumber(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isFinite(v) && v > 0);
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

/** Type.Number() with no positivity constraint — ModelOverride's contextWindow /
 *  maxTokens, which provider-composer's `<= 0` check does NOT apply to (that
 *  check is on ModelDefinition only), so 0 is a config pi accepts. */
function optFiniteNumber(v: unknown): boolean {
  return v === undefined || isFiniteNumber(v);
}

/** ModelCostSchema: input/output/cacheRead/cacheWrite are REQUIRED Type.Number();
 *  `tiers` is an optional array. A `cost: {}` (or a string rate) fails the schema
 *  and pi throws the whole models.json away. */
function optModelCost(v: unknown, required: boolean): boolean {
  if (v === undefined) return true;
  if (!isPlainObject(v)) return false;
  for (const f of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (v[f] === undefined) {
      // Required on ModelDefinition's cost, optional on a ModelOverride's.
      if (required) return false;
      continue;
    }
    if (!isFiniteNumber(v[f])) return false;
  }
  if (v.tiers !== undefined && (!Array.isArray(v.tiers) || !v.tiers.every(costTierValid))) return false;
  return true;
}

/** ModelCostTierSchema: inputTokensAbove + the four rates, all required numbers. */
function costTierValid(tier: unknown): boolean {
  if (!isPlainObject(tier)) return false;
  return ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"].every((f) =>
    isFiniteNumber(tier[f]),
  );
}

/** ThinkingLevelMapSchema: each DECLARED level maps to a string or null. Only the
 *  declared keys are checked — pi's object schemas set no additionalProperties
 *  restriction, so an unknown key is fine and rejecting it would false-red. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function optThinkingLevelMap(v: unknown): boolean {
  if (v === undefined) return true;
  if (!isPlainObject(v)) return false;
  return THINKING_LEVELS.every((lvl) => {
    const x = v[lvl];
    return x === undefined || x === null || typeof x === "string";
  });
}

/** ModelOverrideSchema — the same fields as a model definition, all optional and
 *  with no `id`. */
function modelOverrideValid(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (!optNonEmptyString(v.name)) return false;
  if (!optBoolean(v.reasoning)) return false;
  if (!optThinkingLevelMap(v.thinkingLevelMap)) return false;
  if (!optModelInput(v.input)) return false;
  if (!optModelCost(v.cost, false)) return false;
  if (!optFiniteNumber(v.contextWindow) || !optFiniteNumber(v.maxTokens)) return false;
  if (!optStringRecord(v.headers)) return false;
  if (v.compat !== undefined && !isPlainObject(v.compat)) return false;
  return true;
}

/** Type.Array(Type.Union([Literal"text", Literal"image"])). */
function optModelInput(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every((x) => x === "text" || x === "image"));
}

function modelDefinitionValid(model: unknown): boolean {
  if (!isPlainObject(model)) return false;
  if (typeof model.id !== "string" || model.id.length === 0) return false;
  if (!optNonEmptyString(model.name) || !optNonEmptyString(model.api) || !optNonEmptyString(model.baseUrl))
    return false;
  if (!optBoolean(model.reasoning)) return false;
  if (!optPositiveNumber(model.contextWindow) || !optPositiveNumber(model.maxTokens)) return false;
  if (!optStringRecord(model.headers)) return false;
  if (!optModelInput(model.input)) return false;
  if (!optModelCost(model.cost, true)) return false;
  if (!optThinkingLevelMap(model.thinkingLevelMap)) return false;
  // ProviderCompatSchema is a union of three all-optional shapes; a shape check
  // is the faithful limit without transcribing 24 fields whose only effect is
  // wire-format tweaks.
  if (model.compat !== undefined && !isPlainObject(model.compat)) return false;
  return true;
}

function providerEntryValid(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (
    !optNonEmptyString(entry.name) ||
    !optNonEmptyString(entry.baseUrl) ||
    !optNonEmptyString(entry.apiKey) ||
    !optNonEmptyString(entry.api)
  )
    return false;
  if (entry.oauth !== undefined) {
    if (entry.oauth !== "radius") return false;
    // provider-composer.ts throws `"baseUrl" is required when "oauth" is set`.
    if (typeof entry.baseUrl !== "string" || entry.baseUrl.length === 0) return false;
  }
  if (!optStringRecord(entry.headers)) return false;
  if (!optBoolean(entry.authHeader)) return false;
  if (entry.compat !== undefined && !isPlainObject(entry.compat)) return false;
  if (entry.modelOverrides !== undefined) {
    if (!isPlainObject(entry.modelOverrides)) return false;
    if (!Object.values(entry.modelOverrides).every(modelOverrideValid)) return false;
  }
  if (entry.models !== undefined && (!Array.isArray(entry.models) || !entry.models.every(modelDefinitionValid)))
    return false;
  return true;
}

/** True only for an existing REGULAR file — a directory at a credentials path is
 *  not a credential (existsSync alone would say yes). Never throws. */
function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Google Vertex via Application Default Credentials.
 *
 * pi's google-vertex provider (packages/ai/src/providers/google-vertex.ts) needs
 * ALL THREE of a credentials FILE, a project and a location for the ADC/service-
 * account path — GOOGLE_APPLICATION_CREDENTIALS alone cannot authenticate. It
 * also falls back to gcloud's well-known ADC file when the var is unset, which we
 * now honour (that user IS ready and used to read as not).
 *
 * The two real corrections here: the referenced file must EXIST (a stale
 * GOOGLE_APPLICATION_CREDENTIALS pointing at a deleted key file used to green
 * pi), and project/location must be set.
 */
export function piVertexAdcUsable(
  home: string,
  procEnv: NodeJS.ProcessEnv = process.env,
  entryEnv?: Record<string, unknown>,
): boolean {
  // Vertex uses nullish (not truthy) per-field fallback. An explicitly-empty
  // stored project/path therefore blocks the ambient value just as it does in
  // pi; treating it as `||` would false-green a broken stored record.
  // google-vertex resolves the project as stored GOOGLE_CLOUD_PROJECT, ambient
  // GOOGLE_CLOUD_PROJECT, then ambient GCLOUD_PROJECT. GCLOUD_PROJECT is never
  // read from a stored auth record. In particular, an explicitly-empty stored
  // primary still blocks both ambient fallbacks under nullish semantics.
  const project =
    readNullishScoped(entryEnv, procEnv, "GOOGLE_CLOUD_PROJECT") ??
    procEnv.GCLOUD_PROJECT;
  const location = readNullishScoped(entryEnv, procEnv, "GOOGLE_CLOUD_LOCATION");
  if (!nonEmptyString(project) || !nonEmptyString(location)) return false;
  // NOT trimmed: pi uses the literal value, so a space-padded path that
  // resolves for us would not resolve for pi.
  const explicit = readNullishScoped(entryEnv, procEnv, "GOOGLE_APPLICATION_CREDENTIALS");
  if (explicit !== undefined) {
    // Must point at a file that is actually there. A RELATIVE path resolves
    // against pi's cwd, which readiness cannot know — so it is unverifiable, and
    // "unverifiable" has to mean not-ready here or a dangling `missing.json`
    // greens pi. gcloud always writes an absolute path, so this costs nothing
    // real.
    return typeof explicit === "string" && isAbsolute(explicit) && isRegularFile(explicit);
  }
  // gcloud's well-known ADC file — pi's fallback is this literal POSIX path, so
  // we probe exactly that and no other location (a %APPDATA%\gcloud file would
  // green a credential pi does not look for).
  return isRegularFile(join(home, ".config", "gcloud", "application_default_credentials.json"));
}

/**
 * pi's agent config directory — where auth.json and models.json live.
 *
 * pi resolves this as `PI_CODING_AGENT_DIR` (with `~` expansion) falling back to
 * `<home>/.pi/agent` (packages/coding-agent/src/config.ts). The override is not a
 * secret, so buildAgentSpawnEnv passes it straight through to pi — meaning a user
 * who relocated their pi config was reading as "not signed in" while pi itself
 * found the credentials fine.
 */
export function piAgentDir(home: string, procEnv: NodeJS.ProcessEnv = process.env): string | null {
  // NOT trimmed, for the same reason as GOOGLE_APPLICATION_CREDENTIALS above.
  const override = procEnv.PI_CODING_AGENT_DIR;
  if (override) {
    if (override === "~") return home;
    // pi expands `~\` only on Windows; on POSIX that string is a RELATIVE path
    // (a directory literally named "~\cfg"), so expanding it here would green a
    // config pi reads from somewhere else entirely.
    const tildeSlash =
      override.startsWith("~/") || (process.platform === "win32" && override.startsWith("~\\"));
    if (tildeSlash) return join(home, override.slice(2));
    // A RELATIVE override resolves against pi's own cwd, which readiness cannot
    // know — so we cannot say whether a config lives there. Null (= don't read
    // file-backed credentials) rather than guessing against OUR cwd, which could
    // green a config pi will never see. Same stance as a relative
    // GOOGLE_APPLICATION_CREDENTIALS.
    return isAbsolute(override) ? override : null;
  }
  return join(home, ".pi", "agent");
}

/**
 * The AWS sources accepted by pi's amazon-bedrock provider. Unlike ordinary
 * provider records, a keyless Bedrock `api_key` record deliberately falls
 * through to these sources (amazon-bedrock.ts): an explicit stored AWS_PROFILE,
 * an ambient profile, static access-key pair, ECS task role, or web identity.
 * Only the PROFILE comes from a stored `env` block. Every other AWS source is
 * read from ctx.env (the ambient spawn environment).
 */
function piBedrockCredentialUsable(
  entryEnv: Record<string, unknown> | undefined,
  procEnv: NodeJS.ProcessEnv,
): boolean {
  if (nonEmptyString(procEnv.AWS_BEARER_TOKEN_BEDROCK)) return true;
  const storedProfile = entryEnv?.AWS_PROFILE;
  // `credential.env?.AWS_PROFILE ?? ctx.env("AWS_PROFILE")`: an explicitly
  // empty stored profile suppresses the ambient profile, but no stored property
  // (or null) falls through to it.
  const profile = storedProfile ?? procEnv.AWS_PROFILE;
  if (nonEmptyString(profile)) return true;
  if (nonEmptyString(procEnv.AWS_ACCESS_KEY_ID) && nonEmptyString(procEnv.AWS_SECRET_ACCESS_KEY)) return true;
  if (nonEmptyString(procEnv.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)) return true;
  if (nonEmptyString(procEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI)) return true;
  return nonEmptyString(procEnv.AWS_WEB_IDENTITY_TOKEN_FILE);
}

/** The effective provider selected by the pi spawn flags. `--provider` wins;
 * otherwise pi treats the prefix of `--model provider/model` as the provider.
 * A bare model has no reliable static provider mapping, so it retains pi's
 * normal default-selection behaviour rather than guessing. */
function configuredPiProvider(procEnv: NodeJS.ProcessEnv): string | undefined {
  const explicit = procEnv.COMFYUI_MCP_PI_PROVIDER;
  if (explicit) return explicit;
  const model = procEnv.COMFYUI_MCP_PI_MODEL;
  const slash = model?.indexOf("/") ?? -1;
  return slash > 0 ? model!.slice(0, slash) : undefined;
}

/**
 * Is any provider authenticated purely by an env var?
 *
 * Per pi's resolver, "a stored credential owns the provider: ambient/env is
 * consulted only when nothing is stored" — so a provider that HAS a record in
 * auth.json never falls back to its env key. If we got here the stored record was
 * not usable, which means that provider is dead and its env key must not green
 * pi. Every OTHER provider's env keys still count.
 */
function piEnvCredentialPresent(
  storedProviders: Record<string, unknown>,
  procEnv: NodeJS.ProcessEnv,
  onlyProvider?: string,
): boolean {
  const stripped = new Set<string>(TOOL_ONLY_SECRET_ENV_KEYS);
  for (const [provider, keys] of Object.entries(PI_PROVIDER_ENV_KEYS)) {
    if (onlyProvider && provider !== onlyProvider) continue;
    const stored = storedProviders[provider];
    // Pi's ordinary api-key helper falls back to ctx.env when its stored key is
    // absent, falsy, or cannot resolve. A record's mere existence must not hide
    // that same provider's working ambient key.
    const storedEnv = isPlainObject(stored) && isPlainObject(stored.env) ? stored.env : undefined;
    const storedTemplateResolvesTruthy =
      isPlainObject(stored) && typeof stored.key === "string" &&
      envRefsIn(stored.key).every((name) => !!(storedEnv?.[name] || procEnv[name]));
    const storedCanSupplyKey =
      isPlainObject(stored) &&
      stored.type === "api_key" &&
      (credentialValueUsable(stored.key, storedEnv, procEnv) || storedTemplateResolvesTruthy);
    const storedIsOrdinaryApiKey = isPlainObject(stored) && stored.type === "api_key";
    if (providerHasStoredCredential(storedProviders, provider) && (!storedIsOrdinaryApiKey || storedCanSupplyKey)) continue;
    if (!keys.some((k) => !stripped.has(k) && !!procEnv[k]?.trim())) continue;
    // Some providers need companion config alongside the key — without it pi's
    // resolver returns undefined and the key is useless on its own.
    const required = PI_PROVIDER_ENV_REQUIRED[provider];
    if (required && !required.every((k) => !!procEnv[k]?.trim())) continue;
    return true;
  }
  return false;
}

/** Does auth.json carry a stored credential for `provider`? pi's resolver gates
 *  on `if (stored)`, so a null/false entry is NOT a stored credential and the
 *  ambient env is still consulted — only a truthy record takes ownership. */
function providerHasStoredCredential(storedProviders: Record<string, unknown>, provider: string): boolean {
  return !!storedProviders[provider];
}

/**
 * True when a pi provider credential is detectable from ANY source pi documents.
 * This — not the CLI's presence — is the honest "ready" signal for pi, and the
 * connect handler uses it too so a credential-less pi is degraded up front
 * instead of greeted green (#491).
 */
export function piCredentialPresent(
  home: string = homedir(),
  procEnv: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): boolean {
  const agentDir = piAgentDir(home, procEnv);
  // agentDir null = a relative PI_CODING_AGENT_DIR we cannot resolve; the
  // file-backed sources are unreadable, but env/ADC still apply.
  const authFile = agentDir ? join(agentDir, "auth.json") : null;
  // A `null` auth.json breaks pi's auth layer outright — nothing resolves, so no
  // source counts, not even an otherwise-good env key.
  if (authFile && piAuthStoreBroken(authFile)) return false;
  const stored = authFile ? piAuthRecords(authFile) : {};
  const selectedProvider = configuredPiProvider(procEnv);
  if (selectedProvider) {
    const selected = stored[selectedProvider];
    if (authRecordUsable(selected, procEnv, nowMs, { provider: selectedProvider, home })) return true;
    // Bedrock's own resolver intentionally consults the AWS chain even with a
    // keyless stored record; generic stored-record ownership does not apply.
    if (
      selectedProvider === "amazon-bedrock" &&
      (!providerHasStoredCredential(stored, "amazon-bedrock") ||
        (isPlainObject(selected) && selected.type === "api_key")) &&
      piBedrockCredentialUsable(
        isPlainObject(selected) && isPlainObject(selected.env) ? selected.env : undefined,
        procEnv,
      )
    )
      return true;
    if (piEnvCredentialPresent(stored, procEnv, selectedProvider)) return true;
    if (
      selectedProvider === "google-vertex" &&
      !providerHasStoredCredential(stored, "google-vertex") &&
      piVertexAdcUsable(home, procEnv)
    )
      return true;
    return !!agentDir && piModelsJsonUsable(join(agentDir, "models.json"), procEnv, selectedProvider);
  }
  if (
    Object.entries(stored).some(([provider, rec]) =>
      authRecordUsable(rec, procEnv, nowMs, { provider, home }),
    )
  )
    return true;
  const bedrockStored = stored["amazon-bedrock"];
  // The Bedrock resolver is the one exception to ordinary stored-record
  // ownership: a valid api_key record with no `key` still falls through to the
  // AWS chain. An unrecognised/non-api-key stored record remains dead, as pi's
  // generic credential resolver never hands it to the provider.
  if (
    (!providerHasStoredCredential(stored, "amazon-bedrock") ||
      (isPlainObject(bedrockStored) && bedrockStored.type === "api_key")) &&
    piBedrockCredentialUsable(
      isPlainObject(bedrockStored) && isPlainObject(bedrockStored.env) ? bedrockStored.env : undefined,
      procEnv,
    )
  )
    return true;
  if (piEnvCredentialPresent(stored, procEnv)) return true;
  // Vertex ADC is ambient credential too, so a stored google-vertex record owns
  // that provider and suppresses it (same rule as the env keys above).
  if (!providerHasStoredCredential(stored, "google-vertex") && piVertexAdcUsable(home, procEnv))
    return true;
  if (agentDir && piModelsJsonUsable(join(agentDir, "models.json"), procEnv)) return true;
  return false;
}
