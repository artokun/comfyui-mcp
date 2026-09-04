/**
 * Extract string literals from TypeScript source, with line numbers.
 *
 * A scanner rather than a regex, and a mode STACK rather than a brace count,
 * because two simpler versions of this each missed real findings (#2849):
 *
 *   - `[^"'`]{40,}` cannot cross a quote character, so a literal containing an
 *     escaped backtick or a nested double quote is chopped into fragments too
 *     short to match. Both of the sites it missed were prose quoting a command.
 *   - Skipping `${…}` by counting braces desyncs on a brace inside a nested
 *     string (`${x ? "}" : ""}`), and everything after that point in the file is
 *     read in the wrong mode. That silently lost a finding 4000 lines later.
 *
 * Comments are a mode for the same reason: an apostrophe in prose ("the user's
 * key") would otherwise open a string literal and swallow the rest of the file.
 */

const REGEX_PRECEDERS = /[(,=:[!&|?{};+\-~*%^<>]/;

export function stringLiterals(src) {
  const out = [];
  const stack = [{ kind: "code", brace: 0 }];
  let line = 1;
  let prev = "";
  let i = 0;
  const n = src.length;

  const readQuoted = (quote) => {
    const startLine = line;
    let buf = "";
    i++;
    for (; i < n; i++) {
      const c = src[i];
      if (c === "\\") {
        // Keep the escaped character, drop the backslash: \` reads as prose `.
        if (src[i + 1] === "\n") line++;
        buf += src[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === quote) break;
      if (c === "\n") line++;
      buf += c;
    }
    out.push({ text: buf, line: startLine });
  };

  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];

    if (top.kind === "tmpl") {
      if (c === "\\") {
        if (src[i + 1] === "\n") line++;
        top.buf += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === "`") {
        out.push({ text: top.buf, line: top.line });
        stack.pop();
        i++;
        prev = "x";
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        // The interpolated expression is code, not prose. Read it in code mode so
        // its own strings and braces cannot desync the template.
        top.buf += " ";
        stack.push({ kind: "code", brace: 0 });
        i += 2;
        prev = "{";
        continue;
      }
      if (c === "\n") line++;
      top.buf += c;
      i++;
      continue;
    }

    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      i += 2;
      continue;
    }
    if (c === "/" && REGEX_PRECEDERS.test(prev)) {
      i++;
      let inClass = false;
      for (; i < n; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "\n") break;
        else if (src[i] === "/" && !inClass) break;
      }
      i++;
      prev = "/";
      continue;
    }
    if (c === '"' || c === "'") { readQuoted(c); i++; prev = "x"; continue; }
    if (c === "`") { stack.push({ kind: "tmpl", buf: "", line }); i++; continue; }
    if (c === "{") { top.brace++; prev = c; i++; continue; }
    if (c === "}") {
      // Closing the interpolation returns to the template that opened it.
      if (top.brace === 0 && stack.length > 1) stack.pop();
      else top.brace--;
      prev = c;
      i++;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
