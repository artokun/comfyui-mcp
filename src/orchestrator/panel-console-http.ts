// Loopback HTTP console for MCP / orchestrator settings (control plane).
//
// The ComfyUI sidebar panel stays a canvas-focused client: provider, effort,
// context, storyboards. Service lifecycle, OAuth, MCP mappings, and advanced
// tool suites live here — opened from the panel's Advanced → "Open MCP Console".
//
// Bound to 127.0.0.1 only; never exposed off-host.

import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { allBackendReadiness } from "./backend-readiness.js";
import { getLoraCatalog, loraPreviewsDir } from "../services/lora-catalog.js";
import {
  setPanelSecret,
  clearPanelSecret,
  envFilePath as envStorePath,
  listPanelSecretsMasked,
  receiptDisclosures,
  atRiskNote,
  removeDisclosures,
  revokeIsClean,
  slotRevokeState,
  slotSaveConfirmed,
  slotShellProvidedKeys,
  unconfirmedSlotKeys,
  CREDENTIAL_SLOTS,
} from "../services/panel-secrets.js";
import {
  clearPromptOverride,
  isKnownPrompt,
  listPrompts,
  panelPromptsPath,
  setPromptOverride,
} from "../services/prompt-overrides.js";
import { OPENAI_KEY_PROVIDER_IDS } from "../services/openai-provider-registry.js";
import { processLocale, resolveLocale, trFor, type Locale } from "../i18n/index.js";
import { logger } from "../utils/logger.js";

// The simple api-key providers (glm/kimi/moonshot) are spliced in from the
// openai-provider-registry so a new one appears here by adding a registry entry.
const KNOWN_BACKENDS: string[] = [
  "claude",
  "codex",
  "chatgpt",
  "gemini",
  "antigravity",
  "grok",
  ...OPENAI_KEY_PROVIDER_IDS,
  "ollama",
  "copilot", // EXPERIMENTAL — see orchestrator/index.ts's copilotModel comment
];

export interface PanelConsoleHttpServer {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

const FRAME_ANCESTORS = "frame-ancestors http://127.0.0.1:8188 http://localhost:8188 'self'";
function sendFramedHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "Content-Security-Policy": FRAME_ANCESTORS,
  });
  res.end(html);
}

// ─── i18n for the two served pages ────────────────────────────────────────────
//
// These documents are read in a BROWSER, and the reader's language is not this
// process's: the panel's own language setting lives in ComfyUI's client settings and
// never reaches the orchestrator. `Accept-Language` is the closest thing to that
// reader's own choice that a request carries, so it decides; a browser that asks for
// nothing we ship falls back to the process locale, which honours an explicit `--lang`.

/** The language for a page served from here. */
function pageLocale(req: IncomingMessage): Locale {
  const header = String(req.headers["accept-language"] ?? "");
  // Ranked by q-value rather than trusting header order: descending order is a browser
  // convention, not a requirement, and `q=0` is an explicit REJECTION of a language —
  // picking it because it appeared first would be exactly backwards. Sort is stable, so
  // equal weights keep the order the browser sent.
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.split(";");
      // The parameter NAME is case-insensitive per RFC 9110, so `Q=0` is the same
      // rejection as `q=0`; matching only lowercase would read it as top preference.
      const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith("q="));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      // An UNPARSEABLE weight defaults to 1 (accept), never 0: proxies and older clients
      // do emit `q=` and `q=high`, and 0 is reserved for a language the reader explicitly
      // rejected. Treating a typo as a rejection silently deletes their language.
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 1 };
    })
    .filter((r) => r.tag && r.tag !== "*" && r.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  for (const { tag } of ranked) {
    const hit = resolveLocale(tag);
    if (hit) return hit;
  }
  return processLocale();
}

/** The right-to-left languages we ship — the same pair the panel mirrors its layout for.
 *  Keep in step with `LOCALES` in src/i18n/index.ts when a language is added. */
const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "fa"]);

/**
 * The language the page will ACTUALLY render in, which is not always the one negotiated.
 *
 * `lang`/`dir` describe the bytes on the page, not the reader's wishes. Until a catalog
 * for the negotiated locale is installed, those bytes are English — and stamping
 * `lang="fa" dir="rtl"` onto English prose is worse than saying nothing: it mirrors the
 * entire layout and tells a screen reader to pronounce English as Persian. So probe one
 * long sentence from the page: if the catalog answers with something other than the
 * English source, the page is genuinely translated and gets its real language; if it
 * hands the fallback straight back, the page is English and says so. The day a catalog
 * lands this starts reporting the real locale with no second change.
 */
function renderedLocale(negotiated: Locale, probeKey: string, probeFallback: string): Locale {
  if (negotiated === "en") return "en";
  return trFor(negotiated, probeKey, probeFallback) === probeFallback ? "en" : negotiated;
}

/** `<html>` attributes: the real language, plus `dir="rtl"` for Arabic and Persian so the
 *  browser mirrors the page instead of laying RTL text out left-to-right. */
function htmlAttrs(locale: Locale): string {
  return `lang="${locale}"${RTL_LOCALES.has(locale) ? ` dir="rtl"` : ""}`;
}

/**
 * Resolve a translation, but REJECT one that dropped a `{slot}`.
 *
 * A placeholder is not decoration — it carries the ComfyUI URL, the `~/.claude.json`
 * path, the masked key. A catalog entry written without one renders a page missing the
 * very fact it exists to state, with a 200 and nothing in the log. Falling back to the
 * English source is the honest failure: a sentence the reader may not speak still beats
 * a sentence with the answer cut out of it.
 */
function trSlots(locale: Locale, key: string, fallback: string, slots: string[]): string {
  const out = trFor(locale, key, fallback);
  return slots.every((s) => out.includes(`{${s}}`)) ? out : fallback;
}

/**
 * Translate one fragment of page prose into text that is SAFE to interpolate as markup.
 *
 * A catalog is data, not a template: whatever it returns is HTML-escaped before it
 * reaches the document, so a stray `<` in a translation cannot open a tag. Inline markup
 * therefore stays in the source here — the translatable text carries `{slot}`
 * placeholders and `markup` maps each one to a literal element, substituted AFTER
 * escaping so the tags stay byte-identical whatever the translation says (and so a
 * translator is free to move them, which word order in other languages requires).
 * Anything a caller interpolates INTO a `markup` value must be escaped by that caller.
 */
function trHtml(
  locale: Locale,
  key: string,
  fallback: string,
  markup: Record<string, string> = {},
): string {
  let out = escapeHtml(trSlots(locale, key, fallback, Object.keys(markup)));
  for (const [slot, html] of Object.entries(markup)) out = out.split(`{${slot}}`).join(html);
  return out;
}

/** A page builder's locale-bound translator, so neither document repeats the binding. */
function pageT(locale: Locale) {
  return (key: string, fallback: string, markup?: Record<string, string>) =>
    trHtml(locale, key, fallback, markup);
}

/**
 * A `<code>` element holding a left-to-right technical string (a URL, a path).
 *
 * On an RTL page the bidi algorithm reorders these against the surrounding text — two
 * URLs in one sentence swap visually and the reader cannot tell which is which — so an
 * RTL document pins them with `dir="ltr"`. LTR pages emit the bare tag they always did.
 */
function ltrCode(locale: Locale, inner: string): string {
  return RTL_LOCALES.has(locale) ? `<code dir="ltr">${inner}</code>` : `<code>${inner}</code>`;
}

/**
 * Serialize a value for embedding in an inline `<script>`.
 *
 * `JSON.stringify` does not escape `<`, so a value containing `</script>` would close the
 * element early and the remainder would render as page text. The `<` escape is the
 * same character to a JS parser and inert to the HTML one. Now that catalog strings flow
 * into these blocks, that is the difference between a bad translation and a broken page.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003C");
}

function tokenOk(req: IncomingMessage, expected?: string): boolean {
  if (!expected) return true; // no token configured → open (dev)
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const q = url.searchParams.get("token");
    const h = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    return q === expected || h === expected;
  } catch { return false; }
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    let oversized = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (c) => {
      if (oversized) return; // already over limit: drain and discard the rest, don't destroy mid-stream
      data += c;
      if (data.length > 1_000_000) {
        oversized = true;
        data = "";
        settle(() => reject(new Error("body too large")));
      }
    });
    req.on("end", () => { settle(() => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } }); });
    req.on("error", (e) => { settle(() => reject(e)); });
    req.on("close", () => { settle(() => reject(new Error("request closed before body was fully received"))); });
  });
}

const PREVIEW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function serveLoraPreview(req: IncomingMessage, res: ServerResponse): void {
  let id = "";
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    id = (url.searchParams.get("id") ?? "").trim();
  } catch {
    sendJson(res, 400, { ok: false, error: "bad request" });
    return;
  }
  if (!id) {
    sendJson(res, 400, { ok: false, error: "id required" });
    return;
  }
  const catalog = getLoraCatalog();
  const entry = catalog.get(id);
  if (!entry?.previewFile) {
    sendJson(res, 404, { ok: false, error: "no preview" });
    return;
  }
  const previewsRoot = resolve(loraPreviewsDir());
  const abs = resolve(join(previewsRoot, entry.previewFile));
  // Path containment: use the platform separator (sep) so the check also holds
  // on Windows, where resolve() yields backslash-separated paths.
  if (!abs.startsWith(previewsRoot + sep) && abs !== previewsRoot) {
    sendJson(res, 403, { ok: false, error: "invalid preview path" });
    return;
  }
  if (!existsSync(abs)) {
    sendJson(res, 404, { ok: false, error: "preview file missing" });
    return;
  }
  const mime = PREVIEW_MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": "private, max-age=3600",
  });
  createReadStream(abs).pipe(res);
}

/** English source for the landing page's subtitle — also its "is this page translated?"
 *  probe, so it is named once rather than repeated at two call sites that could drift. */
const LANDING_SUBTITLE_EN =
  "Control plane for the panel orchestrator — MCP servers, OAuth, and service settings. The ComfyUI sidebar panel stays focused on chat, providers, and the live canvas.";

function consoleLandingHtml(opts: {
  bridgePort: number;
  consolePort: number;
  comfyuiUrl: string;
  locale: Locale;
}): string {
  const { bridgePort, consolePort, comfyuiUrl } = opts;
  // The subtitle is the probe: the longest sentence on the page, so a translation of it
  // is never accidentally identical to the English.
  const locale = renderedLocale(opts.locale, "console.landing.subtitle", LANDING_SUBTITLE_EN);
  const t = pageT(locale);
  // The status line is written with innerHTML (it carries its own <span>), so these
  // strings are HTML-escaped like the rest of the page BEFORE being serialized into the
  // script — `t()` does that — and the object goes through scriptJson so no translation
  // can close the <script> element either.
  const T = scriptJson({
    running: t("console.landing.status.running", "Orchestrator running"),
    none: t("console.landing.status.none", "no backends"),
    ready: t("console.landing.status.ready", "ready"),
    signIn: t("console.landing.status.sign_in", "sign in"),
    installCli: t("console.landing.status.install_cli", "install CLI"),
    failed: t("console.landing.status.failed", "Could not load status"),
  });
  return `<!DOCTYPE html>
<html ${htmlAttrs(locale)}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${t("console.landing.title", "ComfyUI MCP Console")}</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #0f1115; color: #e8eaed; line-height: 1.5; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.25rem; }
    .sub { color: #9aa0a6; font-size: 0.9rem; margin-bottom: 1.5rem; }
    section { background: #181b22; border: 1px solid #2a2f3a; border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
    h2 { font-size: 0.95rem; margin: 0 0 0.6rem; color: #c4c7ce; }
    /* padding-INLINE-start, not padding-left: identical in LTR, but on an RTL page the
       physical property reserves the gutter on the wrong side and the bullets overhang. */
    ul { margin: 0.4rem 0 0; padding-inline-start: 1.2rem; }
    li { margin: 0.25rem 0; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
    pre { background: #0b0d11; border: 1px solid #2a2f3a; border-radius: 8px; padding: 0.75rem; overflow-x: auto; }
    .ok { color: #81c995; }
    .warn { color: #fdd663; }
    a { color: #8ab4f8; }
    #status { font-size: 0.85rem; }
  </style>
</head>
<body>
  <main>
    <h1>${t("console.landing.title", "ComfyUI MCP Console")}</h1>
    <p class="sub">${t("console.landing.subtitle", LANDING_SUBTITLE_EN)}</p>

    <section>
      <h2>${t("console.landing.connection.heading", "Connection")}</h2>
      <p>${t("console.landing.connection.endpoints", "Bridge {bridge} · ComfyUI {comfyui}", {
        bridge: ltrCode(locale, `ws://127.0.0.1:${bridgePort}`),
        comfyui: ltrCode(locale, escapeHtml(comfyuiUrl)),
      })}</p>
      <p id="status">${t("console.landing.status.loading", "Loading provider readiness…")}</p>
    </section>

    <section>
      <h2>${t("console.landing.here.heading", "Coming here (panel stays in ComfyUI)")}</h2>
      <ul>
        <li>${t("console.landing.here.lifecycle", "Start / stop / restart orchestrator")}</li>
        <li>${t("console.landing.here.mcp", "MCP server mappings & inherited {file} tools", {
          file: ltrCode(locale, "~/.claude.json"),
        })}</li>
        <li>${t("console.landing.here.oauth", "OAuth & API provider sign-in")}</li>
        <li>${t("console.landing.here.prompts", "Editable system prompts — {link}", {
          link: `<a href="/prompts" id="prompts-link">${t("console.landing.here.prompts_link", "open the editor")}</a>`,
        })}</li>
        <li>${t("console.landing.here.library", "LoRA library, image collections, Photomap-style tooling")}</li>
        <li>${t("console.landing.here.a2ui", "A2UI-rich tool surfaces")}</li>
      </ul>
    </section>

    <section>
      <h2>${t("console.landing.panel.heading", "Stays in the ComfyUI panel")}</h2>
      <ul>
        <li>${t("console.landing.panel.pickers", "Provider / model / effort pickers & context window meter")}</li>
        <li>${t("console.landing.panel.storyboards", "Video storyboards & live graph edits")}</li>
        <li>${t("console.landing.panel.connect", "Connect / Disconnect to this bridge")}</li>
      </ul>
    </section>

    <section>
      <h2>${t("console.landing.api.heading", "API")}</h2>
      <pre>GET  /api/status
GET  /api/prompts
POST /api/prompts</pre>
    </section>
  </main>
  <script>
    const T = ${T};
    // This page is open; the editor behind it is token-gated. If the console was opened
    // WITH a token (the panel's "Advanced ↗" does not, a hand-typed URL may), hand the
    // same one to the link so the editor is one click away instead of a 401 the reader
    // has to fix by pasting a secret they cannot see from here.
    const carried = new URLSearchParams(location.search).get('token');
    if (carried) document.getElementById('prompts-link').search = '?token=' + encodeURIComponent(carried);
    fetch('/api/status').then(r => r.json()).then(d => {
      const el = document.getElementById('status');
      const rows = (d.backends || []).map(b =>
        b.backend + ': ' + (b.ready ? T.ready : (b.cli ? T.signIn : T.installCli))
      ).join(' · ');
      el.innerHTML = '<span class="ok">' + T.running + '</span> — ' + (rows || T.none);
    }).catch(() => {
      document.getElementById('status').innerHTML = '<span class="warn">' + T.failed + '</span>';
    });
  </script>
</body>
</html>`;
}

/** English source for the API Keys footer — also that page's "is this translated?" probe. */
const CREDENTIALS_PRIVACY_EN = "Stored locally, per instance. Values never leave this machine.";

/** English source for the token-rejection fragment; it is its own translation probe. */
const UNAUTHORIZED_EN = "Unauthorized — reconnect the panel.";

function credentialsHtml(
  slots: { id: string; label: string; help?: string }[],
  consoleUrl: string,
  token: string,
  negotiatedLocale: Locale,
): string {
  // Probe on the footer sentence — the page's one piece of real prose; the rest is single
  // words a catalog might legitimately leave as-is. See renderedLocale.
  const locale = renderedLocale(negotiatedLocale, "console.credentials.privacy", CREDENTIALS_PRIVACY_EN);
  const t = pageT(locale);
  const rows = slots
    .map(
      (s) => `      <div class="row" data-slot="${escapeHtml(s.id)}">
        <div class="meta"><span class="label">${escapeHtml(s.label)}</span>${s.help ? `<span class="help">${escapeHtml(s.help)}</span>` : ""}</div>
        <div class="state"><span class="badge" data-badge>—</span></div>
        <div class="entry"><input type="password" placeholder="${t("console.credentials.paste_key", "Paste key…")}" data-input autocomplete="off" spellcheck="false" /><button data-save>${t("console.credentials.save", "Save")}</button></div>
      </div>`,
    )
    .join("\n");
  const cfg = scriptJson({ consoleUrl, token });
  // Unlike the landing page's status line, every string below is assigned to
  // `textContent`, never innerHTML — so these are NOT HTML-escaped (`&` would show up as
  // "&amp;" on screen); scriptJson alone keeps them from escaping the <script>.
  const T = scriptJson({
    loadFailed: trFor(locale, "console.credentials.load_failed", "Could not load status — reconnect the panel."),
    // `{masked}` is the masked key itself — a translation that drops it turns the badge
    // into a bare "set" and loses the confirmation the row exists to give.
    set: trSlots(locale, "console.credentials.badge_set", "set · {masked}", ["masked"]),
    notSet: trFor(locale, "console.credentials.badge_unset", "not set"),
    saving: trFor(locale, "console.credentials.saving", "Saving…"),
    saved: trFor(locale, "console.credentials.saved", "Saved ✓"),
    save: trFor(locale, "console.credentials.save", "Save"),
    saveFailed: trFor(locale, "console.credentials.save_failed", "save failed"),
  });
  return `<!DOCTYPE html>
<html ${htmlAttrs(locale)}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${t("console.credentials.title", "API Keys")}</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #0f1115; color: #e8eaed; }
    main { padding: 0.9rem 1rem 1.2rem; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0; }
    .close { background: none; border: none; color: #9aa0a6; font-size: 1.1rem; cursor: pointer; }
    .row { display: grid; grid-template-columns: 1fr auto; gap: 0.35rem 0.6rem; padding: 0.6rem 0; border-bottom: 1px solid #23272f; }
    .meta { display: flex; flex-direction: column; }
    .label { font-size: 0.9rem; font-weight: 500; }
    .help { font-size: 0.72rem; color: #9aa0a6; }
    .state { grid-column: 2; align-self: center; }
    .badge { font-size: 0.72rem; color: #9aa0a6; }
    .badge.set { color: #81c995; }
    .entry { grid-column: 1 / -1; display: flex; gap: 0.4rem; }
    input { flex: 1; background: #0b0d11; border: 1px solid #2a2f3a; border-radius: 7px; color: #e8eaed; padding: 0.4rem 0.5rem; font-size: 0.82rem; }
    button { background: #2a3140; border: 1px solid #3a4150; color: #e8eaed; border-radius: 7px; padding: 0.4rem 0.7rem; font-size: 0.82rem; cursor: pointer; }
    button:hover { background: #333c4d; }
    button[data-save].ok { color: #81c995; border-color: #2f6b41; }
    footer { margin-top: 0.9rem; display: flex; justify-content: space-between; align-items: center; }
    .advanced { background: none; border: 1px solid #2a2f3a; color: #8ab4f8; }
    .err { color: #f28b82; font-size: 0.75rem; }
  </style>
</head>
<body>
  <main>
    <header><h1>${t("console.credentials.title", "API Keys")}</h1><button class="close" data-close title="${t("console.credentials.close", "Close")}">✕</button></header>
    <div id="rows">
${rows}
    </div>
    <p class="err" id="err"></p>
    <footer>
      <span class="help">${t("console.credentials.privacy", CREDENTIALS_PRIVACY_EN)}</span>
      <button class="advanced" data-advanced>${t("console.credentials.advanced", "Advanced ↗")}</button>
    </footer>
  </main>
  <script>
    const CFG = ${cfg};
    const T = ${T};
    const q = (t) => "?token=" + encodeURIComponent(t);
    function postHeight() {
      try { parent.postMessage({ type: "resize", height: document.body.scrollHeight }, "*"); } catch {}
    }
    async function load() {
      try {
        const r = await fetch("/api/secrets" + q(CFG.token));
        const d = await r.json();
        for (const s of (d.slots || [])) {
          const row = document.querySelector('.row[data-slot="' + s.id + '"]');
          if (!row) continue;
          const badge = row.querySelector("[data-badge]");
          badge.textContent = s.set ? T.set.replace("{masked}", () => s.masked) : T.notSet;
          badge.classList.toggle("set", !!s.set);
        }
      } catch (e) { document.getElementById("err").textContent = T.loadFailed; }
      postHeight();
    }
    document.querySelectorAll(".row").forEach((row) => {
      const btn = row.querySelector("[data-save]");
      const input = row.querySelector("[data-input]");
      btn.addEventListener("click", async () => {
        const value = input.value.trim();
        if (!value) return;
        btn.disabled = true; btn.textContent = T.saving;
        try {
          const r = await fetch("/api/secrets" + q(CFG.token), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ slot: row.dataset.slot, value }),
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || T.saveFailed);
          input.value = "";
          const badge = row.querySelector("[data-badge]");
          badge.textContent = T.set.replace("{masked}", () => d.masked); badge.classList.add("set");
          btn.textContent = T.saved; btn.classList.add("ok");
          setTimeout(() => { btn.textContent = T.save; btn.classList.remove("ok"); btn.disabled = false; }, 1500);
        } catch (e) {
          document.getElementById("err").textContent = String(e.message || e);
          btn.textContent = T.save; btn.disabled = false;
        }
      });
    });
    document.querySelector("[data-close]").addEventListener("click", () => { try { parent.postMessage({ type: "close" }, "*"); } catch {} });
    document.querySelector("[data-advanced]").addEventListener("click", () => { window.open(CFG.consoleUrl + "/console", "_blank", "noopener"); });
    window.addEventListener("load", load);
    new ResizeObserver(postHeight).observe(document.body);
  </script>
</body>
</html>`;
}

/** English source for the prompts editor's intro — also that page's translation probe.
 *  It is the one full sentence on the page; every other string is a button or a badge. */
const PROMPTS_INTRO_EN =
  "Every system prompt the orchestrator controls, as the agent actually receives it. Your text is stored in {file} — the built-in stays untouched, so Reset always brings it back.";

/**
 * The system-prompt editor.
 *
 * Rows are built in the BROWSER from /api/prompts rather than baked in here, for two
 * reasons: the registry is populated at orchestrator startup (a page rendered before a
 * backend registered its prompt would be permanently stale), and a prompt is thousands of
 * characters — serializing every default into the document AND into the editor's state
 * would send each one twice. The client builds nodes with textContent, never innerHTML,
 * so prompt text that contains markup stays text.
 */
function promptsHtml(consoleUrl: string, token: string, negotiatedLocale: Locale): string {
  const locale = renderedLocale(negotiatedLocale, "console.prompts.intro", PROMPTS_INTRO_EN);
  const t = pageT(locale);
  const cfg = scriptJson({ consoleUrl, token });
  // Every one of these reaches the page as `textContent` or as a DOM property, never as
  // innerHTML, so they are NOT HTML-escaped (`&` would otherwise show up as "&amp;" on
  // screen) — scriptJson alone keeps a translation from escaping the <script> element.
  const T = scriptJson({
    loadFailed: trFor(locale, "console.prompts.load_failed", "Could not load the prompts — reconnect the panel."),
    empty: trFor(locale, "console.prompts.empty", "No editable prompts are registered yet. Start the orchestrator, then reload this page."),
    custom: trFor(locale, "console.prompts.badge_custom", "customised"),
    builtin: trFor(locale, "console.prompts.badge_default", "built-in default"),
    placeholder: trFor(locale, "console.prompts.placeholder", "Using the built-in default — type here to override it."),
    save: trFor(locale, "console.prompts.save", "Save"),
    saving: trFor(locale, "console.prompts.saving", "Saving…"),
    saved: trFor(locale, "console.prompts.saved", "Saved ✓"),
    saveFailed: trFor(locale, "console.prompts.save_failed", "save failed"),
    reset: trFor(locale, "console.prompts.reset", "Reset to built-in"),
    resetting: trFor(locale, "console.prompts.resetting", "Resetting…"),
    resetFailed: trFor(locale, "console.prompts.reset_failed", "reset failed"),
    viewDefault: trFor(locale, "console.prompts.view_default", "View the built-in default"),
    copyDefault: trFor(locale, "console.prompts.copy_default", "Copy it into the editor"),
  });
  return `<!DOCTYPE html>
<html ${htmlAttrs(locale)}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${t("console.prompts.title", "System Prompts")}</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #0f1115; color: #e8eaed; line-height: 1.5; }
    main { max-width: 60rem; margin: 0 auto; padding: 0.9rem 1rem 1.2rem; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.35rem; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0; }
    .close { background: none; border: none; color: #9aa0a6; font-size: 1.1rem; cursor: pointer; }
    .intro { font-size: 0.78rem; color: #9aa0a6; margin: 0 0 0.9rem; }
    .row { padding: 0.75rem 0; border-bottom: 1px solid #23272f; }
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; }
    .label { font-size: 0.9rem; font-weight: 500; }
    .help { font-size: 0.72rem; color: #9aa0a6; }
    .badge { font-size: 0.72rem; color: #9aa0a6; white-space: nowrap; }
    .badge.custom { color: #fdd663; }
    textarea { display: block; width: 100%; box-sizing: border-box; margin: 0.45rem 0 0.4rem;
      min-height: 6.5rem; resize: vertical; background: #0b0d11; border: 1px solid #2a2f3a;
      border-radius: 7px; color: #e8eaed; padding: 0.5rem 0.6rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; line-height: 1.45; }
    /* The editor is code-shaped text in every language, so it stays left-to-right even when
       the page around it is mirrored — an RTL textarea reorders a prompt's punctuation. */
    textarea { direction: ltr; text-align: start; }
    .actions { display: flex; gap: 0.4rem; align-items: center; }
    button { background: #2a3140; border: 1px solid #3a4150; color: #e8eaed; border-radius: 7px;
      padding: 0.35rem 0.7rem; font-size: 0.8rem; cursor: pointer; }
    button:hover:not(:disabled) { background: #333c4d; }
    button:disabled { opacity: 0.55; cursor: default; }
    button.ok { color: #81c995; border-color: #2f6b41; }
    button.ghost { background: none; border-color: #2a2f3a; color: #9aa0a6; }
    details { margin-top: 0.35rem; }
    summary { font-size: 0.72rem; color: #8ab4f8; cursor: pointer; }
    details button { margin-top: 0.4rem; }
    details pre { margin: 0.35rem 0 0; background: #0b0d11; border: 1px solid #2a2f3a; border-radius: 7px;
      padding: 0.5rem 0.6rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
      direction: ltr; text-align: start;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.74rem; color: #c4c7ce; }
    .err { color: #f28b82; font-size: 0.75rem; min-height: 1rem; }
    footer { margin-top: 0.9rem; display: flex; justify-content: flex-end; }
    .advanced { background: none; border: 1px solid #2a2f3a; color: #8ab4f8; }
  </style>
</head>
<body>
  <main>
    <header><h1>${t("console.prompts.title", "System Prompts")}</h1><button class="close" data-close title="${t("console.prompts.close", "Close")}">✕</button></header>
    <p class="intro">${t("console.prompts.intro", PROMPTS_INTRO_EN, {
      file: ltrCode(locale, escapeHtml(panelPromptsPath())),
    })}</p>
    <div id="rows"></div>
    <p class="err" id="err"></p>
    <footer><button class="advanced" data-advanced>${t("console.prompts.advanced", "Advanced ↗")}</button></footer>
  </main>
  <script>
    const CFG = ${cfg};
    const T = ${T};
    const q = (t) => "?token=" + encodeURIComponent(t);
    const err = document.getElementById("err");
    function postHeight() {
      try { parent.postMessage({ type: "resize", height: document.body.scrollHeight }, "*"); } catch {}
    }
    function el(tag, cls, text) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }
    /** Paint a row's badge and its Reset button from the server's view of that prompt. */
    function mark(row, item) {
      const badge = row.querySelector("[data-badge]");
      badge.textContent = item.overridden ? T.custom : T.builtin;
      badge.classList.toggle("custom", !!item.overridden);
      row.querySelector("[data-reset]").disabled = !item.overridden;
    }
    function build(items) {
      const host = document.getElementById("rows");
      host.textContent = "";
      if (!items.length) { host.appendChild(el("p", "help", T.empty)); postHeight(); return; }
      for (const item of items) {
        const row = el("div", "row");
        const head = el("div", "head");
        const meta = el("div", "meta");
        meta.appendChild(el("div", "label", item.label || item.id));
        if (item.help) meta.appendChild(el("div", "help", item.help));
        head.appendChild(meta);
        const badge = el("span", "badge", "");
        badge.setAttribute("data-badge", "");
        head.appendChild(badge);
        row.appendChild(head);

        const ta = el("textarea");
        ta.setAttribute("spellcheck", "false");
        ta.placeholder = T.placeholder;
        // The DEFAULT is shown greyed via placeholder-only when unset; the editor itself
        // carries the override so saving an untouched row cannot silently promote a
        // built-in into a stored override.
        ta.value = item.override || "";
        row.appendChild(ta);

        const actions = el("div", "actions");
        const save = el("button", "", T.save);
        save.setAttribute("data-save", "");
        const reset = el("button", "ghost", T.reset);
        reset.setAttribute("data-reset", "");
        actions.appendChild(save);
        actions.appendChild(reset);
        row.appendChild(actions);

        const det = el("details");
        det.appendChild(el("summary", "", T.viewDefault));
        det.appendChild(el("pre", "", item.default || ""));
        // Editing usually means "the built-in, but with one paragraph changed", and the
        // editor starts EMPTY on purpose (see above) — so the default is one click away
        // rather than a selection drag across a few thousand characters.
        const copy = el("button", "ghost", T.copyDefault);
        copy.addEventListener("click", () => { ta.value = item.default || ""; ta.focus(); postHeight(); });
        det.appendChild(copy);
        row.appendChild(det);

        save.addEventListener("click", () => send(row, { id: item.id, value: ta.value }, save, T.saving, T.saved, T.save, T.saveFailed));
        reset.addEventListener("click", () => {
          ta.value = "";
          send(row, { id: item.id, reset: true }, reset, T.resetting, T.saved, T.reset, T.resetFailed);
        });
        host.appendChild(row);
        mark(row, item);
      }
      postHeight();
    }
    async function send(row, body, btn, busyLabel, doneLabel, idleLabel, failLabel) {
      err.textContent = "";
      const wasDisabled = btn.disabled;
      btn.disabled = true; btn.textContent = busyLabel;
      try {
        const r = await fetch("/api/prompts" + q(CFG.token), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || failLabel);
        mark(row, d.prompt);
        btn.textContent = doneLabel; btn.classList.add("ok");
        setTimeout(() => {
          btn.textContent = idleLabel; btn.classList.remove("ok");
          // Re-read the CURRENT disabled state rather than restoring the old one: Reset
          // disables itself the moment the override is gone, and restoring the captured
          // flag would hand it back enabled against a prompt that has no override now.
          btn.disabled = btn.hasAttribute("data-reset") ? !row.querySelector("[data-badge]").classList.contains("custom") : false;
        }, 1500);
      } catch (e) {
        err.textContent = String(e.message || e);
        btn.textContent = idleLabel; btn.disabled = wasDisabled;
      }
      postHeight();
    }
    async function load() {
      try {
        const r = await fetch("/api/prompts" + q(CFG.token));
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || T.loadFailed);
        build(d.prompts || []);
      } catch (e) { err.textContent = T.loadFailed; }
      postHeight();
    }
    document.querySelector("[data-close]").addEventListener("click", () => { try { parent.postMessage({ type: "close" }, "*"); } catch {} });
    document.querySelector("[data-advanced]").addEventListener("click", () => { window.open(CFG.consoleUrl + "/console", "_blank", "noopener"); });
    window.addEventListener("load", load);
    new ResizeObserver(postHeight).observe(document.body);
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function startPanelConsoleHttpServer(opts: {
  port: number;
  host?: string;
  bridgePort: number;
  comfyuiUrl: string;
  token?: string;
}): Promise<PanelConsoleHttpServer> {
  const host = opts.host ?? "127.0.0.1";

  // The panel calls /api/secrets from the ComfyUI page origin (e.g.
  // http://127.0.0.1:8188 → this console's port), which is CROSS-origin — without
  // CORS headers the browser hard-fails the fetch ("Couldn't load credentials")
  // even though the request itself is loopback + token-gated. Allow exactly the
  // ComfyUI origin (plus its localhost↔127.0.0.1 twin, since the page may be
  // open under either name). Never "*": the token would otherwise be callable
  // from any web page the user has open.
  const allowedOrigins = new Set<string>();
  try {
    const u = new URL(opts.comfyuiUrl);
    const twins = new Set([u.hostname, u.hostname === "localhost" ? "127.0.0.1" : "localhost"]);
    for (const h of twins) allowedOrigins.add(`${u.protocol}//${h}${u.port ? `:${u.port}` : ""}`);
  } catch {
    allowedOrigins.add("http://127.0.0.1:8188");
    allowedOrigins.add("http://localhost:8188");
  }

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      // Preflight for the authorized JSON POST (Authorization + content-type).
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api/secrets") {
      if (!tokenOk(req, opts.token)) { sendJson(res, 401, { ok: false, error: "unauthorized" }); return; }
      if (req.method === "GET") { sendJson(res, 200, { ok: true, slots: listPanelSecretsMasked() }); return; }
      if (req.method === "POST") {
        let body: any;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: "bad json" }); return; }
        const slot = String(body?.slot ?? "");
        const value = String(body?.value ?? "");
        const clear = body?.clear === true;
        if (!slot || (!value && !clear)) {
          sendJson(res, 400, { ok: false, error: "slot and value required (or clear: true to revoke)" });
          return;
        }
        try {
          if (clear) {
            // Revoke path (issue #203): remove every alias key of the slot, then
            // VERIFY the slot no longer resolves. Reporting `cleared:true` from
            // "a line was removed" alone would call the credential revoked while
            // another form of the assignment still supplies it (codex gate,
            // round 3, finding 2).
            // Captured BEFORE the clear: keys a real environment variable
            // supplies come back on the next start, so the revoke is only
            // effective for this process and must not be reported as complete.
            const shellKeys = slotShellProvidedKeys(slot);
            const clearOutcome = clearPanelSecret(slot);
            const removed = clearOutcome.changed;
            // The removal ALREADY HAPPENED. Anything it cost is disclosed here,
            // with `ok:false` so no UI can render it as a clean revoke — it is
            // never re-thrown, because the previous version's throw became a
            // generic `ok:false` in the catch below and the caller retried a
            // removal that had already run, against a store that had already
            // lost keys (codex gate).
            // Everything the removal owes the caller — lost keys, an incomplete
            // loss account, dropped comments, a write that is not crash-durable,
            // a legacy purge that failed. Built from the one shared list, not
            // from this endpoint's own idea of which fields matter, and computed
            // BEFORE any branch returns: the damage branch used to return in
            // front of this and in front of the end-state check, so a revoke that
            // lost keys reported neither its other obligations nor whether the
            // credential still resolves (codex gate).
            const clearWarnings = removeDisclosures(clearOutcome, envStorePath());
            const state = slotRevokeState(slot);
            if (clearOutcome.lostKeys.length) {
              sendJson(res, 500, {
                ok: false,
                slot,
                cleared: removed,
                lost_keys: clearOutcome.lostKeys,
                // The verified end state, which this branch skipped entirely.
                still_resolves: state === "unknown" ? null : state === "still-resolves",
                ...(clearWarnings.length ? { warnings: clearWarnings } : {}),
                error:
                  `"${slot}" WAS removed from the credential store, but the store no longer carries ${clearOutcome.lostKeys.join(", ")} — ` +
                  `${clearOutcome.lostKeys.length > 1 ? "those credentials were" : "that credential was"} lost during the rewrite. ` +
                  `Do NOT repeat the revoke: it already happened, and another write would rewrite an already-damaged store. Inspect the file and restore the missing entries first.`,
              });
              return;
            }
            if (state === "still-resolves") {
              sendJson(res, 500, {
                ok: false,
                slot,
                cleared: false,
                still_resolves: true,
                error:
                  `Removed an entry for "${slot}", but the credential still resolves — something else is still providing it. It is NOT revoked.`,
              });
              return;
            }
            if (state === "unknown") {
              // The store could not be read, so we cannot say the credential is
              // gone: a tool process that CAN read it may still find the old
              // value there. Report the uncertainty instead of either verdict.
              //
              // `ok:false`, deliberately. The warning below said the end state
              // was UNKNOWN while the success flag next to it said the revoke
              // worked — and a consumer reads the flag (codex gate). This is a
              // DISCLOSURE, not a refusal: `cleared` still reports that the
              // removal happened, so nobody is invited to retry it.
              sendJson(res, 500, {
                ok: false,
                slot,
                cleared: removed,
                still_resolves: null,
                warning:
                  `"${slot}" no longer applies to this process, but the credential store could not be re-read, so whether it is gone from disk is UNKNOWN. ` +
                  `A tool session that can read the store may still find the old value. Re-check before relying on the revoke.`,
                ...(clearWarnings.length ? { warnings: clearWarnings } : {}),
              });
              return;
            }
            // `ok` asks the same question everywhere: is this a CLEAN revoke?
            // The end state being verified "gone" is not enough — a revoke whose
            // loss account was never completed, that the boot migration will
            // undo, or that only partly ran was green-lit here while a warning
            // beside it said exactly that, and a consumer reads the flag
            // (codex gate). Comment loss and a durability gap stay warnings:
            // they are what the revoke COST, not doubt about the revoke.
            const cleanRevoke = revokeIsClean(clearOutcome);
            sendJson(res, cleanRevoke ? 200 : 500, {
              ok: cleanRevoke,
              slot,
              // `cleared` keeps its established meaning — an entry was removed
              // from the credential STORE — and `still_resolves` reports the
              // verified end state. Two fields, each true to its own question:
              // conflating them is how `cleared:false` ended up sitting next to
              // a "cleared for this session" note (codex gate, round 4,
              // finding 5).
              cleared: removed,
              // Scoped claim: it no longer resolves HERE. A tool session that
              // was already running keeps the value it was spawned with until it
              // is rebuilt — the clear schedules that rebuild, it does not
              // perform it, so the two are reported separately.
              still_resolves: false,
              live_sessions_rebuild_at_idle: true,
              ...(shellKeys.length
                ? {
                    warning:
                      `${shellKeys.join(", ")} ${shellKeys.length > 1 ? "are" : "is"} set as a real environment variable outside this app, not in the credential store. ` +
                      `It no longer applies to the running process, but it returns on the next start — unset it where it is defined to revoke it permanently.`,
                  }
                : {}),
              ...(clearWarnings.length ? { warnings: clearWarnings } : {}),
            });
            return;
          }
          // Report what the read-back PROVED, not that the call returned. The
          // same failure panel_request_secret refuses was answered ok:true here.
          const outcome = setPanelSecret(slot, value);
          if (!slotSaveConfirmed(outcome)) {
            // DATA LOSS FIRST. This endpoint answered `200 {ok:true, masked}`
            // from `slotSaveConfirmed` alone, so a save that destroyed the
            // user's other tokens was reported to the panel as a clean success —
            // the PR's original defect, one layer further out (codex gate). It
            // cannot recur by omission now: a damaged receipt is `persisted:
            // "damaged"`, which is not "yes", so `confirmed` is false and this
            // branch is the only way out.
            if (outcome.lostKeys.length) {
              // Say which post-state we are ACTUALLY in. "Nothing was rolled
              // back" was asserted unconditionally here, but this branch is also
              // reached when a FAILED save rolled back and the rollback is what
              // lost the keys — so it stated a post-state that had not happened
              // (codex gate). `rolledBack` is the outcome's own answer.
              const rollbackNote = outcome.receipts.some((r) => r.persisted === "damaged")
                ? `Nothing was rolled back: a rollback cannot bring them back and would be one more rewrite of a damaged store.`
                : outcome.rolledBack
                  ? `The slot itself was rolled back, but that rollback is what the store lost these entries during — it cannot be undone by repeating it.`
                  : `The slot was NOT left in its previous state either; see stranded_keys / unverified_restore_keys.`;
              sendJson(res, 500, {
                ok: false,
                slot,
                // Key NAMES only — never a value.
                lost_keys: outcome.lostKeys,
                saved_but_damaged: true,
                rolled_back: outcome.rolledBack,
                ...(outcome.strandedKeys.length ? { stranded_keys: outcome.strandedKeys } : {}),
                ...(outcome.unverifiedKeys.length
                  ? { unverified_restore_keys: outcome.unverifiedKeys }
                  : {}),
                ...(outcome.restoreWarnings?.length ? { warnings: outcome.restoreWarnings } : {}),
                error:
                  `"${slot}" was written to the credential store, but the store no longer carries ${outcome.lostKeys.join(", ")} — ` +
                  `${outcome.lostKeys.length > 1 ? "those credentials were" : "that credential was"} lost during the write. This is NOT a successful save. ` +
                  `${rollbackNote} ` +
                  `Inspect the file and restore the missing ${outcome.lostKeys.length > 1 ? "entries" : "entry"} before relying on anything in it.`,
              });
              return;
            }
            const unconfirmed = unconfirmedSlotKeys(outcome.receipts);
            const failed = unconfirmed.filter((u) => u.persisted === "no");
            // Describe the state we LEFT, not the state we intended. A slot with
            // alias keys is written serially, so a failure part-way can leave an
            // earlier alias live; `strandedKeys` names exactly that case, and
            // "nothing was half-applied" is only claimed when the restore is
            // proven complete.
            const stranded = outcome.strandedKeys;
            const unverifiedRestore = outcome.unverifiedKeys;
            const aftermath = stranded.length
              ? `Restoring the slot did not take effect for ${stranded.join(", ")}, which still carr${stranded.length > 1 ? "y" : "ies"} the new value — the slot is in a MIXED state; set it again, or clear it, before relying on it.`
              : unverifiedRestore.length
                ? `Restoring the slot could NOT be verified for ${unverifiedRestore.join(", ")} (the store was unreadable), so whether anything was half-applied is unknown — re-check before relying on it.`
                : `The change was rolled back, so nothing was half-applied.`;
            // `unknown` is NOT a success. Answering 200 ok:true for a write
            // whose read-back could not be performed asserts a definite
            // configured state from a failed verification — the #826 shape
            // reappearing inside the vocabulary introduced to prevent it
            // (coordinator finding). `ok` is true only for a PROVEN save, which
            // this branch is not, by construction.
            const unverifiedSave = unconfirmed.filter((u) => u.persisted === "unknown");
            sendJson(res, 500, {
              ok: false,
              slot,
              // Key NAMES and verdicts only — never a value.
              unconfirmed,
              rolled_back: outcome.rolledBack,
              ...(unverifiedSave.length ? { unverified_keys: unverifiedSave.map((u) => u.key) } : {}),
              ...(stranded.length ? { stranded_keys: stranded } : {}),
              ...(unverifiedRestore.length ? { unverified_restore_keys: unverifiedRestore } : {}),
              // What the ROLLBACK's own writes cost — a rollback is a store
              // write the user never asked for, and it was reported nowhere.
              ...(outcome.restoreWarnings?.length ? { warnings: outcome.restoreWarnings } : {}),
              ...(failed.length
                ? {
                    error:
                      `"${slot}" was NOT saved: the credential store does not come back carrying ${failed.map((f) => f.key).join(", ")}. ${aftermath}`,
                  }
                : stranded.length
                  ? { error: `"${slot}" could not be saved cleanly. ${aftermath}` }
                  : {
                      // The REASON comes from the receipt. "unknown" no longer
                      // means only "the file could not be re-read" — it also
                      // covers a save whose key read back fine but whose loss
                      // account a concurrent writer made impossible to complete,
                      // and asserting the wrong one sends the user to check the
                      // wrong thing (codex gate).
                      error:
                        `"${slot}" was written but the save is NOT confirmed (${unconfirmed.map((u) => u.key).join(", ")}), so treat it as UNKNOWN: ` +
                        `${outcome.receipts.find((r) => r.uncertainty)?.uncertainty ?? "the store could not be re-read to confirm it"}. ` +
                        `Do not treat it as configured. ${aftermath}`,
                    }),
            });
            return;
          }
          const masked = listPanelSecretsMasked().find((s) => s.id === slot)?.masked ?? null;
          // A CONFIRMED save can still owe the user a disclosure — comment lines
          // the rewrite dropped, or a write that could not be made crash-durable.
          // Built from the one shared list, so a new obligation on the receipt
          // reaches this endpoint without anyone remembering to wire it up here.
          const warnings = [
            // The slot fan-out suspends per-alias emits and makes ONE at the end, so the
            // respawn cost belongs to the OUTCOME, not to any single receipt — every
            // receipt here carries an empty list by construction. Rendering only the
            // receipts is why this endpoint warned about nothing while orphaning the same
            // transfers the agent-facing path warns about (codex).
            ...(atRiskNote(outcome.atRiskDownloads, undefined) ? [atRiskNote(outcome.atRiskDownloads, undefined)!] : []),
            ...outcome.receipts.flatMap((r) => receiptDisclosures(r)),
            // A confirmed slot save performs no rollback, so this is normally
            // empty — but it is included from the same place either way, so the
            // rollback's own costs can never be the field nobody rendered.
            ...(outcome.restoreWarnings ?? []),
          ];
          sendJson(res, 200, {
            ok: true,
            slot,
            masked,
            ...(warnings.length ? { warnings } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, /unknown credential slot/i.test(msg) ? 400 : 500, { ok: false, error: msg });
        }
        return;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (path === "/api/prompts") {
      if (!tokenOk(req, opts.token)) { sendJson(res, 401, { ok: false, error: "unauthorized" }); return; }
      if (req.method === "GET") { sendJson(res, 200, { ok: true, prompts: listPrompts() }); return; }
      if (req.method === "POST") {
        let body: any;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: "bad json" }); return; }
        const id = String(body?.id ?? "");
        if (!id) { sendJson(res, 400, { ok: false, error: "id required" }); return; }
        // Only prompts the orchestrator REGISTERED may be written. Without this an
        // arbitrary key lands in panel-prompts.json, where nothing ever reads it and
        // nothing ever offers to remove it — a typo'd id would look saved forever.
        if (!isKnownPrompt(id)) { sendJson(res, 400, { ok: false, error: `unknown prompt "${id}"` }); return; }
        try {
          // `reset` and an empty/whitespace `value` mean the same thing to the store —
          // drop the override — but they are kept distinct on the wire because a UI that
          // sends an accidentally-empty textarea should not be indistinguishable from one
          // whose user pressed Reset.
          if (body?.reset === true) clearPromptOverride(id);
          else setPromptOverride(id, String(body?.value ?? ""));
        } catch (err) {
          // setPromptOverride refuses rather than clobber an unreadable overrides file.
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
          return;
        }
        // Echo the stored state rather than the request: whitespace-only text clears the
        // override, so what the caller sent is not always what the row now is.
        const prompt = listPrompts().find((entry) => entry.id === id);
        sendJson(res, 200, { ok: true, prompt });
        return;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (req.method === "GET" && path === "/api/status") {
      const { backends, any_ready } = allBackendReadiness(KNOWN_BACKENDS);
      const bound = server.address();
      const boundPort =
        bound && typeof bound === "object" ? bound.port : opts.port;
      const liveUrl = `http://${host}:${boundPort}`;
      sendJson(res, 200, {
        ok: true,
        console_url: liveUrl,
        bridge_port: opts.bridgePort,
        bridge_url: `ws://${host}:${opts.bridgePort}`,
        comfyui_url: opts.comfyuiUrl,
        backends,
        any_ready,
      });
      return;
    }
    if (req.method === "GET" && path === "/api/lora-preview") {
      serveLoraPreview(req, res);
      return;
    }
    if (req.method === "GET" && path === "/credentials") {
      // The rejection is a page the same person reads, so it follows the same language as
      // the page they were trying to open — not English-only because the token was wrong.
      const locale = pageLocale(req);
      if (!tokenOk(req, opts.token)) {
        // A bare fragment has no <html> to carry the language, so the <p> carries it —
        // otherwise an Arabic or Persian rejection lays out left-to-right. The fragment
        // is a single sentence, so it is its own translated-or-not probe.
        const shown = renderedLocale(locale, "console.unauthorized", UNAUTHORIZED_EN);
        sendHtml(
          res,
          401,
          `<p ${htmlAttrs(shown)}>${trHtml(shown, "console.unauthorized", UNAUTHORIZED_EN)}</p>`,
        );
        return;
      }
      const bound = server.address();
      const boundPort = bound && typeof bound === "object" ? bound.port : opts.port;
      sendFramedHtml(
        res,
        200,
        credentialsHtml(CREDENTIAL_SLOTS, `http://${host}:${boundPort}`, opts.token ?? "", locale),
      );
      return;
    }
    if (req.method === "GET" && path === "/prompts") {
      // Same language as the page it guards — see /credentials.
      const locale = pageLocale(req);
      if (!tokenOk(req, opts.token)) {
        const shown = renderedLocale(locale, "console.unauthorized", UNAUTHORIZED_EN);
        sendHtml(
          res,
          401,
          `<p ${htmlAttrs(shown)}>${trHtml(shown, "console.unauthorized", UNAUTHORIZED_EN)}</p>`,
        );
        return;
      }
      const bound = server.address();
      const boundPort = bound && typeof bound === "object" ? bound.port : opts.port;
      sendFramedHtml(res, 200, promptsHtml(`http://${host}:${boundPort}`, opts.token ?? "", locale));
      return;
    }
    if (req.method === "GET" && (path === "/" || path === "/console")) {
      sendHtml(
        res,
        200,
        consoleLandingHtml({
          bridgePort: opts.bridgePort,
          consolePort: opts.port,
          comfyuiUrl: opts.comfyuiUrl,
          locale: pageLocale(req),
        }),
      );
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.removeListener("error", reject);
      const bound = server.address();
      const boundPort =
        bound && typeof bound === "object" ? bound.port : opts.port;
      const url = `http://${host}:${boundPort}`;
      logger.info(`[panel-console] MCP console listening on ${url} (loopback)`);
      resolve({
        port: boundPort,
        url,
        stop: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}