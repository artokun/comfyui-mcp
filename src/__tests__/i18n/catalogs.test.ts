/**
 * The SHIPPED catalogs, rendered through the real runtime.
 *
 * i18n-check.mjs already compares the files to each other: same keys, same placeholders, right
 * plural categories. What it cannot see is whether the running process can find and use them —
 * a catalog can be perfect JSON in a directory `catalogFor` never looks in, under a code
 * `resolveLocale` maps somewhere else, and the only symptom is that every language quietly
 * renders English. That failure looks identical to "translation not started yet" and is exactly
 * what this repo shipped before these files existed.
 *
 * So every assertion here goes through `trFor` rather than through the JSON, and the load-
 * bearing one is the sentinel: a fallback string no catalog contains, which comes back
 * unchanged if and only if the lookup missed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { trFor, LOCALES, __resetI18nForTest } from "../../i18n/index.js";
import { displayWidth, RULE_MAX } from "../../i18n/terminal-layout.js";

afterEach(() => __resetI18nForTest());

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TRANSLATED = LOCALES.filter((l) => l !== "en");

function flatten(node: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries((node ?? {}) as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else if (typeof v === "string") out[key] = v;
  }
  return out;
}

const english = flatten(JSON.parse(readFileSync(join(ROOT, "locales", "en", "main.json"), "utf8")));
const KEYS = Object.keys(english).sort();

/** Placeholder names a value declares, e.g. `{url}` -> "url". */
const holes = (s: string): string[] => (s.match(/\{(\w+)\}/g) ?? []).map((h) => h.slice(1, -1));

/**
 * Substitution values chosen to be findable in the output. `count` stays a NUMBER because
 * `trFor` only takes the plural path when it is one — passing a string everywhere would leave
 * the counted strings' branch untested.
 */
function varsFor(text: string): Record<string, string | number> {
  const vars: Record<string, string | number> = {};
  for (const name of holes(text)) vars[name] = name === "count" ? 7 : `«${name}»`;
  return vars;
}

/**
 * Status markers are NOT decoration: they are what a reader scans before reading a word, and
 * `ready-banner.ts` states outright that every translation must reproduce them. A catalog that
 * drops the 🟢 changes what the line asserts; one that keeps a ⚠️ the frame re-adds prints two.
 */
const MARKERS = ["🟢", "⚠️", "✓", "✅", "🔒", "⏸", "🕶️", "👁️", "ℹ️"];

describe("English is generated, not written", () => {
  it("locales/en/main.json still matches what the call sites declare", () => {
    // Same contract as the docs:gen gate — a committed generated file that no longer matches
    // its source is a silent lie, and here the lie is "these keys are the ones we render".
    const fresh = execFileSync(process.execPath, [join(ROOT, "scripts", "i18n-build-en.mjs"), "--print"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
    expect(fresh).toBe(readFileSync(join(ROOT, "locales", "en", "main.json"), "utf8"));
  });

  it("declares a catalog worth translating", () => {
    expect(KEYS.length).toBeGreaterThan(100);
  });
});

describe.each(TRANSLATED)("%s renders through the real runtime", (locale) => {
  it("answers EVERY key — a sentinel fallback never survives", () => {
    // The whole point. `«no catalog»` appears in no file, so getting it back means the lookup
    // missed: wrong directory, wrong locale code, a nesting level `flatten` did not descend.
    const missed = KEYS.filter((key) => trFor(locale, key, "«no catalog»") === "«no catalog»");
    expect(missed).toEqual([]);
  });

  it("never renders a key as its own name", () => {
    const leaked = KEYS.filter((key) => {
      const out = trFor(locale, key, english[key], varsFor(english[key]));
      return out === key || out.includes(key);
    });
    expect(leaked).toEqual([]);
  });

  it("substitutes every placeholder and leaves none behind", () => {
    const broken: string[] = [];
    for (const key of KEYS) {
      const vars = varsFor(english[key]);
      const out = trFor(locale, key, english[key], vars);
      for (const [name, value] of Object.entries(vars)) {
        if (!out.includes(String(value))) broken.push(`${key}: {${name}} did not substitute`);
      }
      // A `{leftover}` means the translation renamed or invented a placeholder: the runtime
      // leaves an unknown hole verbatim, so the reader sees braces instead of the answer.
      const leftover = out.match(/\{\w+\}/g);
      if (leftover) broken.push(`${key}: unresolved ${leftover.join(", ")}`);
    }
    expect(broken).toEqual([]);
  });

  it("renders no empty value", () => {
    const empty = KEYS.filter((key) => !trFor(locale, key, english[key], varsFor(english[key])).trim());
    expect(empty).toEqual([]);
  });

  it("keeps the status marker the English line opens with", () => {
    const dropped: string[] = [];
    for (const key of KEYS) {
      const marker = MARKERS.find((m) => english[key].startsWith(m));
      if (!marker) continue;
      const out = trFor(locale, key, english[key], varsFor(english[key]));
      if (!out.startsWith(marker)) dropped.push(`${key}: expected to start with ${marker}`);
    }
    expect(dropped).toEqual([]);
  });

  it("keeps every backticked command and every ENV_VAR verbatim", () => {
    // These are things the reader TYPES. A translated `codex login` or a localised
    // OPENROUTER_API_KEY is an instruction that cannot work, and no shape check sees it.
    const lost: string[] = [];
    for (const key of KEYS) {
      const out = trFor(locale, key, english[key], varsFor(english[key]));
      for (const cmd of english[key].match(/`[^`]+`/g) ?? []) {
        if (!out.includes(cmd)) lost.push(`${key}: lost ${cmd}`);
      }
      for (const env of english[key].match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g) ?? []) {
        if (!out.includes(env)) lost.push(`${key}: lost ${env}`);
      }
    }
    expect(lost).toEqual([]);
  });
});

/**
 * Strings that land INSIDE one of the two `════` boxes the CLI draws.
 *
 * Enumerated rather than matched on a `cli.connect_`/`cli.tunnel_` prefix: `connect_url_invalid`
 * and `cannot_start` share those prefixes and are free-flowing fatal lines with no box around
 * them, so a keyword rule would hold them to a width they have no reason to respect — and the
 * repo has been bitten before by a guard whose over-broad direction is invisible in its own
 * output. A key added to a banner has to be added here too; the render in the PR is the
 * backstop that notices if it is not.
 */
const BOXED_KEYS = [
  "connect_title",
  "connect_bridge_secure",
  "connect_label_bridge",
  "connect_label_driving",
  "connect_label_secure",
  "connect_secure_note",
  "connect_next_steps",
  "connect_step_open_comfyui",
  "connect_step_click_connect",
  "connect_quiet_note",
  "tunnel_title",
  "tunnel_label_public_url",
  "tunnel_label_token",
  "tunnel_desktop_connector_path",
  "tunnel_field_header",
  "tunnel_field_name",
  "tunnel_field_url",
  "tunnel_header_alt",
  "tunnel_headless_snippet",
  "tunnel_keep_open",
];

describe("box-drawn banners survive translation", () => {
  it.each(LOCALES)("%s keeps every boxed line inside the rule", (locale) => {
    // CJK is TWO cells per character and the box caps its rule at RULE_MAX, so a sentence that
    // is a comfortable 70 characters in English can be a 140-cell line that walks straight out
    // of the frame. This is a NECESSARY condition, not a sufficient one — every boxed line also
    // carries a prefix (a label column, a step number) that this cannot know — which is why the
    // PR pastes real renders. What it does catch, cheaply and forever, is the gross case.
    const budget = RULE_MAX - 1; // every free-standing banner line is written as ` ${text}`
    const tooWide: string[] = [];
    for (const key of BOXED_KEYS) {
      const full = `cli.${key}`;
      expect(english[full], `${full} is not in the English catalog — was a banner key renamed?`).toBeTypeOf(
        "string",
      );
      const rendered = trFor(locale, full, english[full], varsFor(english[full]));
      for (const line of rendered.split("\n")) {
        const w = displayWidth(line);
        if (w > budget) tooWide.push(`${full}: ${w} cells > ${budget} — ${line}`);
      }
    }
    expect(tooWide).toEqual([]);
  });
});

describe("the catalogs are actually being read", () => {
  it("translates every key that is prose rather than an acronym", () => {
    // Guards the case a sentinel cannot: a file that loads but is a copy of English. The
    // exemption is i18n-check's own rule — a value with no run of four lowercase letters is
    // "API", "URL", "PANEL / COMFYUI", which are the same word in every language and would
    // be WRONG to change. Using the same rule here keeps the two gates from disagreeing.
    const isProse = (s: string) => /[a-z]{4}/.test(s);
    for (const locale of TRANSLATED) {
      const same = KEYS.filter((key) => isProse(english[key]) && trFor(locale, key, english[key]) === english[key]);
      expect(`${locale}: ${same.join(", ") || "none"}`).toBe(`${locale}: none`);
    }
  });

  it("resolves the regional codes the way the files are named", () => {
    // `pt-BR` and `zh-TW` are the two codes where a directory name and a resolved locale could
    // disagree; if they did, those two languages would silently render English forever.
    expect(trFor("pt_BR.UTF-8", "console.credentials.save", "Save")).not.toBe("Save");
    expect(trFor("zh-HK", "console.credentials.save", "Save")).not.toBe("Save");
  });
});
