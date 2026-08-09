// Detect — and NAME — a ComfyUI HTTP response that promised JSON and delivered
// something else (issue #828).
//
// On a remote/reverse-proxied target, `/api/workflow_templates`, `/system_stats`
// and `/object_info` routinely come back as an HTML document: a proxy error page,
// an SSO sign-in page, or the ComfyUI frontend's catch-all index.html for a route
// the proxy never forwarded to the API. Feeding that to `res.json()` produced
//
//     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
//
// which tells the user nothing about what actually answered them, and pushed
// callers toward the wrong conclusion — the runtime check reported "could
// not reach the ComfyUI server" for a server that answered perfectly well.
//
// The fix is to DETECT and SAY WHICH, not to parse harder. We look at the status
// and the content type, then at the shape of the body, and produce a message
// that names the most likely thing in front of ComfyUI. Where the evidence does
// not single one out we say so rather than picking one — a confident wrong
// diagnosis costs more than an honest "the body is HTML; here is its first line".

import { ComfyUIError } from "../utils/errors.js";
import { config, getComfyUIAuthHeaders, getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch, targetOf } from "./fetch.js";

/** What answered instead of the ComfyUI JSON API. */
export type NonJsonKind =
  /** 401/403, or an HTML page whose body looks like a sign-in form. */
  | "login"
  /** A gateway/proxy error page (502/503/504, or nginx/cloudflare/traefik markers). */
  | "proxy-error"
  /** A 2xx HTML document — almost always the frontend's SPA index.html served as
   *  a catch-all for a path the proxy did not route to the ComfyUI API. */
  | "html-page"
  /** 404 with an HTML body — the route does not exist on whatever is answering. */
  | "not-found"
  /** A body that is neither JSON nor HTML (or an empty one). */
  | "not-json";

export interface NonJsonDiagnosis {
  kind: NonJsonKind;
  url: string;
  status: number;
  contentType: string;
  /** First ~160 chars of the body, whitespace-collapsed. Diagnostic only. */
  bodyPrefix: string;
  /** Human-readable, actionable explanation. Contains no credential. */
  message: string;
}

/** A ComfyUI endpoint answered with something that is not the JSON it promised. */
export class NonJsonResponseError extends ComfyUIError {
  readonly diagnosis: NonJsonDiagnosis;
  constructor(diagnosis: NonJsonDiagnosis) {
    super(diagnosis.message, "NON_JSON_RESPONSE");
    this.name = "NonJsonResponseError";
    this.diagnosis = diagnosis;
  }
}

export function isNonJsonResponseError(err: unknown): err is NonJsonResponseError {
  return err instanceof NonJsonResponseError;
}

const REDACTED = "«redacted»";

/**
 * The same marker, spelled for a URL component.
 *
 * `«redacted»` is non-ASCII, so putting it in a query value, a path segment or
 * userinfo gets it percent-encoded to `%C2%ABredacted%C2%BB` on the way out.
 * That leaves one message carrying two spellings of the same word, and — the
 * part that actually costs something — a triage grep for `«redacted»` silently
 * misses every URL occurrence. ASCII here keeps one greppable spelling.
 */
const URL_REDACTED = "REDACTED";

/**
 * Collapse a body to a short single-line prefix for the message.
 *
 * The prefix is diagnostic — it is what lets a user recognise the page that
 * answered. But a gateway that REFLECTS the request (an "invalid token: …"
 * page, a debug echo) can put our own ComfyUI credential in that body, and this
 * prefix goes into an error the agent sees.
 *
 * Matching the KNOWN VALUE is a blocklist, and a proxy can percent-encode,
 * HTML-entity-encode, case-fold or line-wrap what it echoes — so a reflected
 * `Bearer abc/def` comes back as `?token=abc%2Fdef` and no known-value match
 * fires. `scrubSecretShapedText` therefore redacts by SHAPE as well as by
 * value: anything credential-shaped goes, whether or not we can prove it is
 * ours. A diagnostic that can print a secret is not worth the diagnosis.
 */
export function bodyPrefixOf(body: string): string {
  const redacted = scrubSecretShapedText(body);
  if (redacted === null) {
    // A configured credential is present in the body but too short to replace
    // without mangling unrelated text. FAIL CLOSED: withhold the prefix rather
    // than hand the credential back through a tool result.
    return "(body withheld: it contains the configured ComfyUI credential)";
  }
  const flat = redacted.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/**
 * Every encoding of `value` a responder might plausibly echo it back in.
 *
 * Each encoding here is a FAMILY with independent axes, and the way this list
 * has failed by enumerating some members of a family by hand and missing one.
 * Base64 has two axes — alphabet (standard / url-safe) and padding (kept /
 * stripped) — so it has four members, and all four are generated here.
 *
 * This matters precisely because the shape passes below cannot cover these: a
 * short, punctuation-bearing credential encodes to a short opaque string, under
 * the 24-char run threshold and carrying no `token=` label. We HOLD the secret;
 * we do not have to infer it.
 *
 * PERCENT-ENCODING AND HEX ARE NOT HERE. Their axis is the CASE of each hex
 * digit, which is per-digit, not per-string: enumerating "all upper" and "all
 * lower" leaves every mixed-case spelling — `%2F%3f`, `6a7B` — uncovered, and
 * enumerating all of them is 2^n strings (codex gate). Those two families are
 * matched by PATTERN instead, in `reflectionPatterns`, which is the only form of
 * the answer that has no members to miss.
 */
function reflectionVariants(value: string): string[] {
  const html = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // BASE64 family: axes = alphabet × padding, i.e. four members, all generated.
  // (Base64's alphabet is case-SENSITIVE — `a` and `A` are different bytes — so
  // unlike hex it genuinely is a fixed set of strings.)
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const urlSafe = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_");
  const stripPad = (s: string) => s.replace(/=+$/, "");
  const base64Forms = [b64, stripPad(b64), urlSafe(b64), stripPad(urlSafe(b64))];

  return [value, html, value.toLowerCase(), value.toUpperCase(), ...base64Forms];
}

/** Regex-escape a literal. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex atom matching `c` in either case when it is a letter, else literally. */
function eitherCase(c: string): string {
  const lower = c.toLowerCase();
  const upper = c.toUpperCase();
  return lower === upper ? reEscape(c) : `[${lower}${upper}]`;
}

/**
 * The encodings whose spelling is case-INSENSITIVE per hex digit, as patterns.
 *
 * `%2F` and `%2f` are the same byte, and so are `6A` and `6a` in hex — the case
 * of each digit is an independent choice the responder makes, so a fixed list of
 * strings would have to contain 2^(digits) members to be complete. A pattern has
 * none to miss. The NON-hex parts of a percent-encoded value stay case-SENSITIVE,
 * because there they are the credential's own characters.
 *
 * Every returned pattern matches text of exactly `length` characters, so the
 * caller can apply the same "too short to substitute safely" rule it applies to
 * the literal candidates.
 */
function reflectionPatterns(value: string): { pattern: RegExp; length: number }[] {
  const out: { pattern: RegExp; length: number }[] = [];

  // PERCENT-ENCODING: only the two digits after each `%` are case-free.
  for (const encoded of [encodeURIComponent(value), encodeURI(value)]) {
    let source = "";
    for (let i = 0; i < encoded.length; i++) {
      const esc = /^%[0-9A-Fa-f]{2}/.exec(encoded.slice(i, i + 3));
      if (esc) {
        source += `%${eitherCase(encoded[i + 1])}${eitherCase(encoded[i + 2])}`;
        i += 2;
      } else {
        source += reEscape(encoded[i]);
      }
    }
    out.push({ pattern: new RegExp(source, "g"), length: encoded.length });
  }

  // HEX: every character is a hex digit, so the whole string is case-free.
  const hex = Buffer.from(value, "utf8").toString("hex");
  if (hex) {
    out.push({
      pattern: new RegExp([...hex].map(eitherCase).join(""), "g"),
      length: hex.length,
    });
  }

  // HTML ENTITIES: another family that cannot be enumerated. Only the five
  // NAMED entities were generated, so a responder that emits the numeric forms
  // — `&#38;` or `&#x26;`, which any HTML escaper may — got a reflected
  // credential through in recoverable form (codex gate). And the choice is
  // PER CHARACTER, so the list would again be exponential. Each character
  // becomes "itself, or any entity spelling of itself"; a match is therefore
  // always exactly this value, however it was escaped.
  const NAMED: Record<string, string> = {
    "&": "amp",
    "<": "lt",
    ">": "gt",
    '"': "quot",
    "'": "apos",
  };
  const chars = [...value];
  if (chars.some((c) => NAMED[c] !== undefined || c.charCodeAt(0) < 128)) {
    const atoms = chars.map((c) => {
      const code = c.codePointAt(0)!;
      const alts = [
        reEscape(c),
        `&#0*${code};`, // decimal, with the leading zeros some escapers emit
        `&#[xX]0*${[...code.toString(16)].map(eitherCase).join("")};`, // hex, case-free
      ];
      // HTML accepts `&AMP;` as well as `&amp;`, so the NAME is case-free too.
      if (NAMED[c]) alts.push(`&${[...NAMED[c]].map(eitherCase).join("")};`);
      return `(?:${alts.join("|")})`;
    });
    out.push({
      // The shortest possible match is the value written out literally, so that
      // is the length the "too short to substitute safely" rule must use.
      pattern: new RegExp(atoms.join(""), "g"),
      length: value.length,
    });
  }
  return out;
}

/**
 * Remove anything credential-shaped from text that is about to be shown.
 *
 * Three passes, in order:
 *   1. KNOWN values — every configured ComfyUI auth header value, and its bare
 *      token, in each encoding a responder might echo. Returns `null` when one
 *      occurs but is too SHORT (< 8 chars) to substitute without mangling
 *      unrelated text: the caller must then withhold the text entirely.
 *   2. KEYED assignments — `token=…`, `api_key: …`, `Authorization: Bearer …`.
 *      A secret introduced by its own name is a secret whoever it belongs to.
 *   3. OPAQUE RUNS — any long unbroken run of credential alphabet characters.
 *      This is what catches an encoding we did not anticipate, and it is why the
 *      redaction is a shape rule rather than a list of known strings.
 *
 * Passes 2 and 3 run whether or not a credential is configured: a reflected
 * body can carry someone else's secret too, and this text goes to an agent.
 */
/**
 * Every credential this process is configured with, as raw values (#1191).
 *
 * Deliberately broader than `getComfyUIAuthHeaders()`, which is about what to
 * SEND: this is about what must never come BACK. A reflected body can echo any
 * of them, and the scrubber should not have to know which endpoint it is looking
 * at to redact the right one.
 *
 * Empty values are dropped by the caller's own guard; nothing here is logged.
 */
function knownCredentialValues(): string[] {
  const out = Object.values(getComfyUIAuthHeaders());
  for (const v of [config.comfyuiApiKey, config.huggingfaceToken, config.civitaiApiToken]) {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

export function scrubSecretShapedText(text: string): string | null {
  let out = text;

  // 1. Known configured values, in every encoding we can anticipate.
  //
  // #1191 (codex review) — getComfyUIAuthHeaders() carries ONLY the ComfyUI auth
  // token and the Cloudflare Access pair. It does NOT carry the Comfy Cloud API
  // key, which cloud-client sends as `X-API-Key` — so the cloud enqueue error
  // path, the one whose body is most likely to reflect that key back, had no
  // known-value pass for it at all. The by-name pass below catches a LABELLED
  // reflection, but an unlabelled echo of a short key has neither a recognized
  // label nor the 24-char opaque-run shape, and would have gone straight out.
  //
  // The download tokens are here for the same reason: a reflected body on any of
  // these paths reaches the agent, and which credential leaked is not something
  // to decide per call site.
  for (const headerValue of knownCredentialValues()) {
    if (!headerValue) continue;
    // The header value may be "Bearer <token>"; handle the whole thing and the
    // bare token, so neither form survives.
    for (const base of [headerValue, headerValue.replace(/^\S+\s+/, "")]) {
      if (!base) continue;
      for (const candidate of reflectionVariants(base)) {
        if (!candidate || !out.includes(candidate)) continue;
        if (candidate.length < 8) return null; // too short to replace safely
        out = out.split(candidate).join(REDACTED);
      }
      // The case-insensitive families (percent-encoding, hex), matched by
      // pattern rather than by an enumeration that could never be complete.
      for (const { pattern, length } of reflectionPatterns(base)) {
        // A fresh regex per use: `lastIndex` on a /g pattern makes `test` and
        // `replace` interfere otherwise, and a guard that mis-fires because of
        // its own bookkeeping is not a guard.
        if (!new RegExp(pattern.source, "g").test(out)) continue;
        if (length < 8) return null; // too short to replace safely
        out = out.replace(new RegExp(pattern.source, "g"), REDACTED);
      }
      // LINE-WRAPPED reflections. Everything above matches CONTIGUOUS text, so a
      // proxy that wraps a long token across lines — or inserts a soft break
      // into it — leaves fragments that are individually under the 24-char
      // opaque-run threshold and carry no `token=` label: every pass misses
      // them, and the whole credential goes out in pieces (codex gate). The
      // wrapping is not reversible in place, so this DETECTS in a
      // whitespace-free view and FAILS CLOSED. It is the same policy as a
      // too-short credential: a diagnostic is never worth a credential.
      const compact = out.replace(/\s+/g, "");
      if (compact !== out) {
        for (const candidate of reflectionVariants(base)) {
          if (candidate && candidate.length >= 8 && compact.includes(candidate)) return null;
        }
        for (const { pattern, length } of reflectionPatterns(base)) {
          if (length >= 8 && new RegExp(pattern.source, "g").test(compact)) return null;
        }
      }
    }
  }

  // 2. Anything introduced BY NAME as a credential, however short.
  out = out.replace(
    /\b(authorization|auth[-_]?token|access[-_]?token|api[-_]?key|apikey|client[-_]?secret|secret|password|passwd|token|key)\b(\s*(?:[:=]|&#61;|%3D)\s*)(?:(bearer|token|basic)(\s+))?["']?([^"'\s&<>,;)]{3,})/gi,
    (_m, name: string, sep: string, scheme: string | undefined, gap: string | undefined, _v: string) =>
      `${name}${sep}${scheme ? `${scheme}${gap ?? " "}` : ""}${REDACTED}`,
  );

  // 3. Long opaque runs of the credential alphabet (base64 / hex / url-safe /
  //    percent-encoded). Ordinary prose and HTML break well before 24 chars —
  //    tags, spaces and punctuation are all outside this class.
  out = out.replace(/[A-Za-z0-9\-._~+/=%]{24,}/g, REDACTED);

  return out;
}

/**
 * Query parameters worth PRINTING, which is the only list that can be complete.
 *
 * The first version of this went the other way — a list of credential-ish NAMES
 * (`token`, `secret`, `signature`, …) to redact. Probing it with sixteen
 * credential-carrying URLs leaked nine of them: `?t=`, `?jwt=`, `?ticket=`,
 * `?nonce=`, `?otp=`, `?hmac=`, `?bearer=`, `?SAMLResponse=` and a
 * `;jsessionid=` matrix parameter all sailed through, because the set of names
 * a gateway might use for a credential is open and the set I can think of is
 * not. That is the same failure the credential-encoding list in
 * `reflectionVariants` documents above: enumerate a family by hand and you miss
 * a member.
 *
 * So this is inverted and FAILS CLOSED. Only parameters this codebase itself
 * sends to ComfyUI are shown; every other value is redacted whatever it is
 * called. The cost is bounded and small — the origin, the path and every
 * parameter NAME still print, which is what identifies the responder — while
 * the benefit is that an unfamiliar parameter cannot leak by default.
 */
const SHOWABLE_PARAMS: ReadonlySet<string> = new Set([
  "clientid",
  "client_id",
  "filename",
  "subfolder",
  "type",
  "types",
  "dir",
  "recurse",
  "split",
  "node_id",
  "ref",
  "name",
  "mode",
  "raw",
  "template",
  "max_items",
  "version_id",
  "id",
  "ui_id",
  "format",
  "channel",
  "preview",
  "overwrite",
  "skip_update",
  "blobs",
  "input",
  "response_type",
  "scope",
  "code_challenge_method",
]);

/**
 * The subset of SHOWABLE_PARAMS whose values are legitimately LONG free text —
 * user-supplied paths and titles — and so must not be length-checked.
 *
 * Everything else on the allowlist keeps the opaque-run check on its value. The
 * names there are generic enough (`id`, `ref`, `type`, `mode`, `input`, `raw`,
 * `channel`) that a third-party gateway is as likely to pick one as ComfyUI is,
 * and a JWT under `?id=` or an access key under `?ref=` should not print merely
 * because ComfyUI also happens to use that word. Dropping the check for ALL 31
 * names — which is what the long-filename fix did — was wider than the evidence
 * justified (review finding 2).
 *
 * `redirect_uri` was removed from the allowlist entirely rather than added here:
 * its value is an arbitrary URL, so a nested `?session=…` prints whole and no
 * length rule can see it, `:` and `?` being outside the opaque alphabet.
 */
const LONG_TEXT_PARAMS: ReadonlySet<string> = new Set([
  "filename",
  "subfolder",
  "dir",
  "template",
]);
// `name` is deliberately NOT here, though it was in the review's suggested set:
// probing found `?name=AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMI` printing in full. A
// pack or model name long enough to trip the length check is rare and costs
// only a redacted word in a diagnostic; an access key printing costs more.

/** A single opaque run long enough to be a credential and nothing else. Reused
 *  from the body scrubber's pass 3, but applied PER COMPONENT so an ordinary
 *  host+path — which is one long run of exactly this alphabet — survives. */
const OPAQUE_RUN = /^[A-Za-z0-9\-._~+/=%]{24,}$/;

/**
 * A parameter value may be printed only if we recognise the NAME, and — unless
 * the name is one that legitimately carries long free text — only if the value
 * is not itself credential-shaped.
 *
 * The long-text exemption exists because live-testing a missing `/view` produced
 *
 *     /view?filename=«redacted»&type=input&subfolder=
 *
 * — the opaque-run alphabet is letters, digits, `-`, `.` and `_`, so any
 * filename of 24 characters or more matched it, and the message threw away the
 * single most useful fact it had. The exemption is scoped to LONG_TEXT_PARAMS
 * rather than applied to the whole allowlist: a JWT under `?id=` is still a JWT.
 */
function isShowableParam(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (!SHOWABLE_PARAMS.has(n)) return false;
  return LONG_TEXT_PARAMS.has(n) || !OPAQUE_RUN.test(value);
}

/**
 * One path segment, with the parts that can carry a credential removed.
 *
 * Two shapes hide in a path. A whole segment can BE a token (`/t/<40 chars>/x`),
 * and a MATRIX PARAMETER can append one to an ordinary segment
 * (`/logs;jsessionid=…`) — the latter is under the opaque-run threshold and was
 * missed entirely by the first version. The head of the segment is kept either
 * way, because that is the route and the route is the diagnosis.
 */
function scrubPathSegment(segment: string): string {
  if (OPAQUE_RUN.test(segment)) return URL_REDACTED;
  if (!segment.includes(";") && !segment.includes("=")) return segment;
  const [head, ...matrix] = segment.split(";");
  const eq = head.indexOf("=");
  const safeHead = eq === -1 ? head : `${head.slice(0, eq)}=${URL_REDACTED}`;
  return matrix.length > 0 ? `${safeHead};${URL_REDACTED}` : safeHead;
}

/**
 * A URL that is safe to put in an error message (codex gate, finding 6).
 *
 * `bodyPrefixOf` scrubs the BODY, and until now nothing scrubbed the URL —
 * which was fine while every diagnosis was built from a base URL we composed
 * ourselves, and stopped being fine once `guardClientFetch` started reporting
 * `Response.url`. That is the url AFTER redirects, so an identity proxy that
 * bounces the request to an SSO endpoint (`?code=…&state=…`), or a gateway that
 * hands back a presigned object URL (`?X-Amz-Signature=…`), puts a live
 * credential in it. The diagnosis is shown to the agent and routinely pasted
 * into bug reports.
 *
 * `scrubSecretShapedText` cannot be used for this: its opaque-run pass matches
 * 24+ characters of an alphabet that includes `/`, `.` and `-`, so an ordinary
 * `https://comfy.example.com/api/v1/internal/logs` collapses to `https:«redacted»`
 * and the diagnosis loses the one fact it exists to report. This redacts by URL
 * STRUCTURE instead, and FAILS CLOSED on the parts that can carry a secret:
 *
 *   - userinfo                → always redacted
 *   - query/fragment values   → redacted unless the NAME is one this codebase
 *                               sends (SHOWABLE_PARAMS); for those, the value is
 *                               additionally length-checked unless the name is
 *                               one that carries long free text (LONG_TEXT_PARAMS)
 *   - path segments           → redacted when opaque, or when carrying a matrix
 *                               parameter (`;jsessionid=…`); applied to a
 *                               RELATIVE target too, not only an absolute one
 *   - non-http(s) schemes     → refused outright rather than parsed
 *   - origin, route, param NAMES → always kept; they are the diagnosis
 *
 * Residual, stated rather than papered over: a SHORT secret sitting in a bare
 * path segment (`/t/abc123/logs`) is indistinguishable from a route and is not
 * redacted. Redacting it would mean redacting every path, which would leave the
 * message unable to say what was requested.
 *
 * Returns the ORIGINAL string when nothing needed redacting, so a clean URL is
 * never reformatted by a round-trip through the URL parser.
 */
export function redactUrlForDiagnosis(raw: string): string {
  let u: URL | null = null;
  try {
    const parsed = new URL(raw);
    // `data:`, `blob:` and `about:` DO parse, but they are "cannot-be-a-base"
    // URLs whose `pathname` setter is a spec'd silent no-op — so the path scrub
    // below would report success and change nothing, the sole fail-OPEN path in
    // a function documented as fail-closed (review finding 5). A ComfyUI target
    // is always http(s); anything else is refused rather than trusted.
    if (parsed.protocol === "http:" || parsed.protocol === "https:") u = parsed;
  } catch {
    u = null;
  }
  if (!u) {
    // Relative (`/settings/<id>`, a test double's target), malformed, or an
    // opaque scheme. There is no origin to reason about, but a relative path can
    // still carry an opaque segment or a matrix parameter, so it gets the SAME
    // per-segment scrub as an absolute one (review finding 4) — an asymmetry
    // here is a trap for the next caller. The query/fragment cannot be parsed
    // safely, so it is withheld rather than printed unexamined.
    const cut = raw.search(/[?#]/);
    const path = cut === -1 ? raw : raw.slice(0, cut);
    const scrubbedPath = path.split("/").map(scrubPathSegment).join("/");
    return cut === -1 ? scrubbedPath : `${scrubbedPath} (query withheld: unparsable URL)`;
  }

  let changed = false;
  if (u.username || u.password) {
    u.username = URL_REDACTED;
    u.password = "";
    changed = true;
  }
  // Rebuilt rather than mutated in place: `searchParams.set` COLLAPSES repeated
  // keys onto the first occurrence, so `?a=1&code=…&a=2` would silently lose a
  // value while claiming only to redact one.
  const rebuilt = new URLSearchParams();
  let paramsChanged = false;
  for (const [name, value] of u.searchParams) {
    if (value && !isShowableParam(name, value)) {
      rebuilt.append(name, URL_REDACTED);
      paramsChanged = true;
    } else {
      rebuilt.append(name, value);
    }
  }
  if (paramsChanged) {
    u.search = rebuilt.toString();
    changed = true;
  }
  // The FRAGMENT is where an OAuth implicit flow puts its access token, and it
  // is never needed to identify a route. Any fragment carrying `=` goes.
  if (u.hash.includes("=")) {
    u.hash = URL_REDACTED;
    changed = true;
  }
  // A token can also ride in the path (`/api/v1/<opaque>/logs`, or a
  // `;jsessionid=` matrix parameter). Judge each segment on its own so a long
  // ROUTE is not mistaken for a long secret.
  const segments = u.pathname.split("/");
  const scrubbed = segments.map(scrubPathSegment);
  if (scrubbed.some((s, i) => s !== segments[i])) {
    u.pathname = scrubbed.join("/");
    changed = true;
  }

  return changed ? u.href : raw;
}

/** Back-compat alias: the known-value redaction is now one pass of the
 *  shape-based scrubber. Callers that only want "is this safe to print" should
 *  use `scrubSecretShapedText`/`bodyPrefixOf`. */
export function redactComfyAuthValues(text: string): string | null {
  return scrubSecretShapedText(text);
}

/**
 * Is the BODY actually markup?
 *
 * The Content-Type header is a CLAIM, not evidence — a `200 text/html` carrying
 * a truncated `{"devices":[` was reported as "an HTML page" from "some HTTP
 * responder other than the ComfyUI JSON API", sending the user to blame their
 * base URL or their proxy when the real problem was a cut-off response
 * (coordinator finding). A truncated body and a proxy error page have entirely
 * different remedies, so the header alone must never pick one.
 */
function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype\b|<html\b|<\?xml\b|<[a-z!/])/i.test(body);
}

/**
 * The body BEGINS like JSON and does not parse.
 *
 * That is the WHOLE of what this predicate establishes: the body is malformed
 * JSON. It does NOT establish truncation. A complete gateway payload such as
 * `{"error": invalid}` satisfies it exactly as a cut-off body does, and so does
 * a JSON-shaped body from a responder that is not the ComfyUI API. Naming it
 * `looksLikeTruncatedJson` and narrating it as "a truncated or cut-off response
 * rather than a different responder" handed one candidate's remedy to all three
 * and explicitly ruled out another — the same defect as inferring HTML from the
 * Content-Type header, relocated to the body (codex gate).
 */
function looksLikeMalformedJson(body: string): boolean {
  const t = body.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(t);
    return false; // it parses; not our case
  } catch {
    return true;
  }
}

/**
 * Is this body ACTUALLY a sign-in page?
 *
 * A bare `login` / `authenticate` anywhere in the body is not evidence — an
 * nginx 502 with a "login" link in its footer would be reported as a
 * body-CONFIRMED auth gate, sending the user to configure gateway credentials
 * instead of diagnosing a proxy failure. Require something only a sign-in page
 * has: a password field, a form that posts to a sign-in route, or a title that
 * says so.
 */
function looksLikeLoginPage(body: string): boolean {
  return (
    /<input[^>]+type=["']?password/i.test(body) ||
    /<form[^>]+action=["'][^"']*(?:login|signin|sign-in|auth|sso|saml|oauth)/i.test(body) ||
    /<title>[^<]*\b(sign[- ]?in|log[- ]?in|authentication required|single sign-on)\b/i.test(body)
  );
}

/** Does this HTML actually carry ComfyUI's own frontend markers? Only then may
 *  we name the frontend as the responder rather than listing candidates. */
function looksLikeComfyFrontend(body: string): boolean {
  return /<title>[^<]*comfyui/i.test(body) || /\bid=["']?vue-app\b/i.test(body) || /comfyui[.-]frontend/i.test(body);
}

function looksLikeProxyErrorPage(body: string): boolean {
  return /\b(bad gateway|gateway time-?out|service unavailable|nginx|cloudflare|traefik|haproxy|envoy)\b/i.test(
    body,
  );
}

/**
 * `503` or `503 Origin warming up` — the code, plus the reason phrase when the
 * responder wrote one worth reading.
 *
 * A CUSTOM phrase is often the single most useful token in the whole response:
 * a CDN's "Origin warming up", a gateway's "Backend read timeout". The standard
 * phrase for a code is noise beside the code itself, so it is dropped.
 */
export function describeStatus(status: number, statusText?: string): string {
  const text = (statusText ?? "").trim();
  if (!text) return String(status);
  if (STANDARD_REASON_PHRASES.has(text.toLowerCase())) return String(status);
  // A phrase is a short label, not a document. Anything longer is a body that
  // escaped into the status line and is not worth the room.
  const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  // Reason phrases are attacker-influenceable on a hostile proxy, and this one
  // is interpolated into a message the agent reads. Same scrub the body gets.
  const safe = scrubSecretShapedText(clipped);
  return safe === null ? String(status) : `${status} ${safe}`;
}

/** Reason phrases that merely restate their code. Lowercased for comparison. */
const STANDARD_REASON_PHRASES: ReadonlySet<string> = new Set([
  "ok",
  "no content",
  "moved permanently",
  "found",
  "not modified",
  "bad request",
  "unauthorized",
  "forbidden",
  "not found",
  "method not allowed",
  "request timeout",
  "conflict",
  "payload too large",
  "unprocessable entity",
  "too many requests",
  "internal server error",
  "not implemented",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
]);

/**
 * Classify a non-JSON response body. Pure (no I/O) so the classification rules
 * are unit-testable without a server.
 */
export function classifyNonJson(args: {
  url: string;
  status: number;
  /** The reason phrase, when the responder sent a meaningful one. `503 Origin
   *  warming up` says more than `503`, and it was being dropped. Standard
   *  phrases add nothing next to the code and are omitted. */
  statusText?: string;
  contentType: string;
  body: string;
}): NonJsonDiagnosis {
  const { status, contentType, body } = args;
  // Redacted HERE rather than at the call sites, so no future caller can
  // reintroduce the leak by composing a url that carries a credential.
  const url = redactUrlForDiagnosis(args.url);
  const reason = describeStatus(status, args.statusText);
  const bodyPrefix = bodyPrefixOf(body);
  // EVIDENCE, not the header's claim. `claimsHtml` is reported as a claim; only
  // `html` (the body really is markup) may drive a diagnosis.
  const html = looksLikeHtml(body);
  const claimsHtml = /\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
  const malformedJson = looksLikeMalformedJson(body);

  // A STATUS alone never proves who produced it — ComfyUI, or an application
  // layer in front of it, can emit 401/403 and 502/503/504 alike. Assert a cause
  // only when the BODY carries the corresponding markers; otherwise name the
  // likely candidates and say the response does not settle it (codex gate,
  // round 2, finding 6).
  // BODY EVIDENCE OUTRANKS STATUS, and a confirmed PROXY page outranks a
  // status-only auth guess. An nginx 502 whose footer happens to link to a
  // login page must be diagnosed as the proxy failure it is, not as a
  // "body-confirmed" auth gate that sends the user to configure gateway
  // credentials (coordinator finding).
  const proxyPage = html && looksLikeProxyErrorPage(body);
  const loginPage = html && looksLikeLoginPage(body);
  const gatewayStatus = status === 502 || status === 503 || status === 504;
  const authStatus = status === 401 || status === 403;
  // An EMPTY body is its own observation and deserves its own sentence. It is
  // what a parser reports as "Unexpected end of JSON input" — the message #828
  // and #1160 were reported as — and the generic "did not parse as JSON and is
  // not markup either" reads as though there WAS a body to inspect, sending the
  // reader to look at a body prefix that says "(empty)".
  const empty = body.trim() === "";

  let kind: NonJsonKind;
  let cause: string;
  if (proxyPage || (gatewayStatus && !loginPage)) {
    kind = "proxy-error";
    cause = proxyPage
      ? "a reverse proxy in front of ComfyUI returned its OWN error page (its markers are in the body) — the proxy is up but could not reach, or timed out talking to, ComfyUI itself"
      : `a gateway-class status (${status}) came back with a non-JSON body; ComfyUI does not normally emit these, so something between you and it most likely did, though this response does not identify what`;
  } else if (authStatus || loginPage) {
    kind = "login";
    cause = loginPage
      ? "an authentication gate answered with a SIGN-IN PAGE (a password field, a sign-in form action, or a sign-in title is in the body) rather than letting the request through to ComfyUI — typically an identity proxy such as Cloudflare Access or an SSO portal"
      : `the request was rejected with ${status} and the body is not JSON; this is most often an identity proxy or sign-in gate in front of ComfyUI, but ComfyUI behind your own auth layer can return it too, and this response does not distinguish them`;
  } else if (status === 404 && html) {
    kind = "not-found";
    cause = "whatever is answering this host does not serve that route at all";
  } else if (html) {
    kind = "html-page";
    // Do NOT assert which HTML this is. A generic 2xx HTML body is consistent
    // with the ComfyUI frontend's SPA catch-all, a reverse proxy that forwards
    // the UI but not the API routes, a maintenance page, a WAF, or an unrelated
    // web app on this host — and nothing in the response singles one out (codex
    // gate, round 1, finding 4). List the candidates; name one only when the
    // body actually carries ComfyUI's own frontend markers.
    cause = looksLikeComfyFrontend(body)
      ? "the ComfyUI web FRONTEND answered this path (its markers are in the body) instead of the ComfyUI HTTP API — typically a reverse proxy that forwards the UI but not the API routes, or a base URL pointing at the frontend's catch-all"
      : "some HTTP responder other than the ComfyUI JSON API answered this path; this body alone does not identify which. The usual candidates are the ComfyUI frontend's SPA catch-all, a reverse proxy that forwards the UI but not the API routes, a maintenance/WAF page, or an unrelated web app on this host";
  } else if (empty) {
    // A 404 with nothing in it is still "that route is not served here", and
    // saying so is more use than a generic parse complaint.
    kind = status === 404 ? "not-found" : "not-json";
    cause =
      `NOTHING was sent back — the response carried no body at all, so the ${status} status is the entire message ` +
      `and this response does not identify what produced it. That is what a JSON parser reports as ` +
      `"Unexpected end of JSON input", and it is equally consistent with ComfyUI itself answering the status ` +
      `without an error document, with a proxy or gateway ending the exchange after the headers, and with a route ` +
      `that is not served here at all. Nothing in this response distinguishes them` +
      (status >= 200 && status < 300
        ? `, and note the status is a SUCCESS one — an empty 2xx where a JSON document was promised points at ` +
          `something answering on ComfyUI's behalf rather than at ComfyUI`
        : ``);
  } else if (malformedJson) {
    kind = "not-json";
    // OBSERVED: the body starts with `{` or `[` and JSON.parse rejects it. That
    // is malformed JSON and nothing more. Calling it "a truncated or cut-off
    // response rather than a different responder" asserted BOTH a cause and the
    // exclusion of a rival cause from a predicate that supports neither (codex
    // gate). Name what was seen, list every candidate it is consistent with, and
    // assert none of them.
    cause =
      "the body BEGINS like JSON and does not parse — that is all this response establishes. " +
      "It is equally consistent with a body cut off mid-document (a dropped connection, a proxy read/body-size or buffer limit, a stream that ended early), " +
      "with a COMPLETE but invalid JSON payload (a gateway, WAF or error handler that emits malformed JSON), " +
      "and with a JSON-shaped body from a responder that is not the ComfyUI API. " +
      "Nothing in this response distinguishes them, so compare the body prefix below against the length the response declared, and check whatever sits between you and ComfyUI, before assuming truncation";
  } else {
    kind = "not-json";
    cause =
      `the body did not parse as JSON and is not markup either` +
      (claimsHtml
        ? ", although the response DECLARES itself text/html — the declaration and the body disagree, so neither settles what answered" : "") +
      ". The candidates are a truncated response, a non-JSON error payload, or a responder that is not the ComfyUI JSON API; this response does not identify which";
  }

  const what = html
    ? "an HTML page"
    : empty
      ? "an EMPTY body"
      : malformedJson
        ? "a body that begins like JSON but does not parse"
        : contentType
          ? `a ${contentType} body that did not parse as JSON`
          : "a body that did not parse as JSON";
  const message =
    `${url} answered ${reason} with ${what} where JSON was expected. This means ${cause}. ` +
    `Content-Type: ${contentType || "(none)"}. Body starts: ${bodyPrefix || "(empty)"}. ` +
    `Confirm the configured ComfyUI base URL really is a ComfyUI API root — a URL that loads the ComfyUI UI in a browser is not proof, because the UI is served by the same catch-all that produced this page. ` +
    `The check is that ${redactUrlForDiagnosis(getComfyUIBaseUrl())}/system_stats returns JSON with a "system"/"devices" shape; if it returns HTML too, the base URL, its path prefix, or the proxy's route map is wrong` +
    // The credential instruction must follow the same evidence rule as the
    // diagnosis above. Only a body-confirmed sign-in page justifies "give it to
    // the gateway"; a bare 401/403 could equally be ComfyUI's own auth layer, and
    // sending the user to configure the wrong side wastes the round trip (codex
    // gate, round 5, finding 4).
    (kind === "login"
      ? loginPage
        ? `, and the credential belongs to that GATEWAY, not to ComfyUI: set COMFYUI_AUTH_TOKEN / COMFYUI_AUTH_HEADER, or the CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET pair.`
        : `. Whichever layer rejected the request is the one that needs the credential — this response does not say which; the connector sends COMFYUI_AUTH_TOKEN / COMFYUI_AUTH_HEADER (and the CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET pair) on every ComfyUI request, so configure them for whichever layer is doing the rejecting.`
      : `.`);

  return { kind, url, status, contentType, bodyPrefix, message };
}

/**
 * Read a ComfyUI response as JSON, or throw a NonJsonResponseError that says what
 * actually answered. Use instead of `await res.json()` on every endpoint whose
 * contract is JSON — the raw SyntaxError ("Unexpected token '<'") names neither
 * the URL nor the responder and is what #828 was reported as.
 *
 * `expectShape`, when given, is a predicate on the PARSED value: a 200 that
 * parses as JSON but is not the document this endpoint returns is also a failure
 * to report, not a value to hand on.
 */
export async function readComfyJson<T = unknown>(
  res: Response,
  opts: { url: string; expectShape?: (v: unknown) => boolean; shapeHint?: string },
): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const jsonish = /\bjson\b/i.test(contentType);
  let parsed: unknown;
  try {
    // Trust the body over the header: some proxies serve JSON as text/plain, and
    // some serve HTML while claiming application/json. Parsing decides.
    parsed = JSON.parse(body);
  } catch {
    throw new NonJsonResponseError(
      classifyNonJson({
        url: opts.url,
        status: res.status,
        statusText: res.statusText,
        contentType,
        body,
      }),
    );
  }
  // Every url that reaches a MESSAGE goes through the same redaction as the one
  // in classifyNonJson — these two paths build their text by hand.
  const safeUrl = redactUrlForDiagnosis(opts.url);
  if (!res.ok) {
    // Valid JSON, but an error status — surface it verbatim rather than as a
    // shape failure; the server told us something specific.
    throw new ComfyUIError(
      `${safeUrl} returned ${describeStatus(res.status, res.statusText)}: ${bodyPrefixOf(body)}`,
      "HTTP_ERROR",
    );
  }
  if (opts.expectShape && !opts.expectShape(parsed)) {
    throw new NonJsonResponseError({
      kind: "not-json",
      url: safeUrl,
      status: res.status,
      contentType,
      bodyPrefix: bodyPrefixOf(body),
      message:
        `${safeUrl} answered ${res.status} with valid JSON that is not ${opts.shapeHint ?? "the expected document"}. ` +
        `Something other than ComfyUI is very likely answering this route (an API gateway's own JSON error envelope, or a different service on this host). ` +
        `Body starts: ${bodyPrefixOf(body)}.` +
        (jsonish ? "" : ` (Content-Type was ${contentType || "(none)"}.)`),
    });
  }
  return parsed as T;
}

/**
 * Wrap the `fetch` handed to the ComfyUI client library so the library's own
 * error path cannot EAT the response (#828, #1160).
 *
 * `Client.fetchApi` does this on every status outside [200, 400):
 *
 *     if (status < 200 || status >= 400)
 *       return res.json().then(body => { throw new Error(`Endpoint Bad Request (${status} ${statusText}): ${url}`) })
 *
 * — it reads the ERROR body as JSON in order to attach it to the error it is
 * about to throw. When that body is not JSON, `res.json()` rejects FIRST, and
 * its bare SyntaxError propagates in place of the library's error, so the
 * status, the statusText and the URL are all lost. The failure is upstream of
 * every `client.fetchApi` call site, which is why guarding them one at a time
 * kept missing it:
 *
 *   - #828: a remote `/internal/logs` answered non-2xx with an empty body after
 *     a reconnect, and surfaced as
 *     `Failed to fetch ComfyUI logs after reconnect retry: Unexpected end of JSON input`.
 *   - #1160: `upload_image` on an authenticated remote surfaced as a bare
 *     `Unexpected end of JSON input` even though `uploadImageHttp`'s SUCCESS
 *     path already runs `readComfyJson` — the auth gate's 401/403 made the
 *     library throw before that code ever saw the response, so its own
 *     `if (!res.ok)` branch was unreachable.
 *
 * The wrapper overrides `json()` on the returned Response so a parse failure
 * throws the diagnosis instead of a SyntaxError. It deliberately does NOT read
 * the body up front: the override consumes the stream at exactly the moment the
 * original `json()` would have, so `text()`, `body` and `bodyUsed` are unchanged
 * for every caller that does not call `json()` — including `readComfyJson`,
 * which reads `text()` and keeps its own richer shape checking.
 *
 * KNOWN GAP, written down because the override is otherwise invisible: it is an
 * OWN property of this Response, so it does NOT survive `res.clone()` or
 * `new Response(res.body)` — a clone's `json()` is the prototype's again and
 * throws a bare SyntaxError. Nothing in src/ clones a guarded response today
 * (checked), so this is latent rather than live; anything that starts to should
 * read `text()` and classify it directly instead.
 *
 * Applied to ALL statuses, not just the ones the library throws on: a 200 that
 * carries an HTML catch-all is the same defect one layer over, and the override
 * costs nothing on a response nobody parses.
 */
export function guardClientFetch(
  base: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const res = await base(input, init);
    // Bind before overriding: the override must reach the REAL reader, and
    // `res.text` would otherwise still resolve through the prototype anyway —
    // binding makes that independent of anything else patching the instance.
    const readText = res.text.bind(res);
    // `url` on a real fetch Response is the FINAL url after redirects, which is
    // the more useful one to name. Falling back to the request target keeps the
    // message honest for a synthesised response (a test double, a mock).
    const url = res.url || targetOf(input);
    Object.defineProperty(res, "json", {
      configurable: true,
      writable: true,
      value: async (): Promise<unknown> => {
        const body = await readText();
        try {
          return JSON.parse(body);
        } catch {
          throw new NonJsonResponseError(
            classifyNonJson({
              url,
              status: res.status,
              statusText: res.statusText,
              contentType: res.headers.get("content-type") ?? "",
              body,
            }),
          );
        }
      },
    });
    return res;
  };
}

/** Fetch a ComfyUI endpoint and parse it as JSON with the guard above. */
export async function fetchComfyJson<T = unknown>(
  url: string,
  opts: {
    init?: RequestInit;
    expectShape?: (v: unknown) => boolean;
    shapeHint?: string;
  } = {},
): Promise<T> {
  const res = await comfyuiFetch(url, opts.init ?? {});
  return readComfyJson<T>(res, {
    url,
    expectShape: opts.expectShape,
    shapeHint: opts.shapeHint,
  });
}

/**
 * An error's message with any configured ComfyUI credential removed — for the
 * parser errors that QUOTE the body they choked on, which a reflecting gateway
 * can have filled with our own token. Falls back to a placeholder when the
 * credential is too short to substitute safely: a message is never worth
 * handing a credential back through.
 */
export function redactErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return (
    redactComfyAuthValues(raw) ??
    "(message withheld: it contains the configured ComfyUI credential)"
  );
}

/**
 * The error itself, safe to propagate: the SAME object when its message carries
 * no configured credential (so identity, type and stack survive for callers that
 * match on them), and a redacted copy when it does.
 *
 * Every rethrow path must go through this. Redacting only the branch that builds
 * a diagnosis left the inconclusive-probe branch rethrowing the library's raw
 * parse message — which quotes the body — straight into a tool result (codex
 * gate, round 6, finding 2).
 */
export function redactedError(err: unknown): unknown {
  const raw = err instanceof Error ? err.message : String(err);
  const safe = redactErrorMessage(err);
  if (safe === raw) return err;
  const copy = new Error(safe);
  if (err instanceof Error) {
    copy.name = err.name;
    // A Node stack EMBEDS the message in its first line, so copying it verbatim
    // would carry the credential straight past the redaction and into any
    // unhandled-rejection log (codex gate, round 8, finding 3). Redact the stack
    // with the same substitution, and drop it entirely when that is not safe —
    // a stack trace is never worth handing a credential back through.
    const stack = err.stack ? redactComfyAuthValues(err.stack) : undefined;
    if (stack) copy.stack = stack;
  }
  return copy;
}

/**
 * True when an error looks like `JSON.parse` choking on a markup body — the
 * signature of a client library that called `res.json()` itself and so gave us
 * no URL, status, or content type to report.
 */
/**
 * Did this error PROVE the response was not JSON?
 *
 * Two shapes prove it now, and code that picks between competing errors has to
 * accept both. `looksLikeHtmlParsedAsJson` recognises a raw parser message, which
 * was the only shape available while the client library did the parsing. Since
 * `guardClientFetch`, that same failure arrives as a NonJsonResponseError whose
 * message contains no parser text at all — so a predicate written against the
 * old shape silently answers "no" for the strongest evidence we have.
 */
export function provesNonJsonAnswer(err: unknown): boolean {
  return isNonJsonResponseError(err) || looksLikeHtmlParsedAsJson(err);
}

export function looksLikeHtmlParsedAsJson(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Require a MARKUP indicator, not merely "is not valid JSON" (codex gate,
  // round 1, finding 5): a bare JSON-syntax complaint can come from a truncated
  // or malformed JSON body, and triggering a speculative re-probe on it risks
  // replacing a truthful error with one about a DIFFERENT, later response.
  const markup = msg.includes("<");
  const jsonSyntax =
    /is not valid JSON/.test(msg) ||
    /in JSON at position/.test(msg) ||
    /Unexpected token/.test(msg);
  return markup && jsonSyntax;
}

/**
 * Re-probe `url` ONCE to turn an opaque JSON-parse failure into a diagnosis that
 * names the responder. Returns null when the probe cannot establish that the
 * body was non-JSON — an inconclusive probe must NOT be reported as a verdict,
 * so callers keep the original error in that case.
 *
 * Only called on the failure path, so the happy path costs nothing.
 */
export async function diagnoseComfyEndpoint(url: string): Promise<NonJsonDiagnosis | null> {
  try {
    const res = await comfyuiFetch(url, { signal: AbortSignal.timeout(8000) });
    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();
    try {
      JSON.parse(body);
      return null; // it parses now — we cannot claim the earlier body was HTML
    } catch {
      return classifyNonJson({
        url,
        status: res.status,
        statusText: res.statusText,
        contentType,
        body,
      });
    }
  } catch {
    return null; // probe failed; we learned nothing and must not invent a cause
  }
}

/**
 * Wrap an error thrown by a client library that parsed JSON internally. When it
 * smells like markup-parsed-as-JSON, re-probe `url` and rethrow the precise
 * diagnosis; otherwise rethrow the original, unchanged except that a configured
 * credential is redacted out of its message (the message quotes the body, and
 * the body may reflect our own token — that must not depend on whether the probe
 * happened to be conclusive).
 */
export async function rethrowWithJsonDiagnosis(err: unknown, url: string): Promise<never> {
  // Already a FIRST-HAND diagnosis of the response that actually failed — since
  // guardClientFetch, the library's own parse throws one of these. Re-probing
  // would replace evidence from the failing response with a guess from a
  // different, later one, which is the exact trade this function's own comment
  // warns against.
  if (isNonJsonResponseError(err)) throw err;
  if (looksLikeHtmlParsedAsJson(err)) {
    const diagnosis = await diagnoseComfyEndpoint(url);
    if (diagnosis) {
      // The probe is a SEPARATE, later request — it does not prove it saw the
      // same response that failed. Say so, keep the original message, and chain
      // the original as `cause`, so a transient change between the two requests
      // cannot silently rewrite a truthful error into a speculative one (codex
      // gate, round 1, finding 5).
      // The library's raw parse message quotes the body it choked on, so it can
      // carry a credential a reflecting gateway echoed back. Redact it like any
      // other body text, and withhold it entirely when redaction cannot be done
      // safely (codex gate, round 5, finding 5).
      const original = redactErrorMessage(err);
      throw new NonJsonResponseError({
        ...diagnosis,
        message:
          `The request failed while parsing the response as JSON: ${original} ` +
          `A follow-up probe of ${redactUrlForDiagnosis(url)} — a separate request, so not necessarily the same response — found: ${diagnosis.message}`,
      });
    }
  }
  throw redactedError(err);
}
