// Pure editing helpers for the Felidae extension (no vscode import, so they are
// unit-testable): the doc comment above a declaration, where a missing period
// goes, and which locals and parameters are never used.

// The `#` comment lines directly above `line` (no blank line between), without
// the `#`, as one paragraph per original line. Empty when there is none.
export function docCommentAbove(lines: readonly string[], line: number): string[] {
  const comment: string[] = [];
  for (let index = line - 1; index >= 0; index--) {
    const text = lines[index].trim();
    if (!text.startsWith("#")) break;
    comment.unshift(text.replace(/^#+\s?/, ""));
  }
  return comment;
}

// The code of a line without a trailing `# comment`, ignoring a # inside a string.
function codeOf(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

// "Expected '.'" is reported where the parser noticed: the start of whatever
// follows the statement. The missing period belongs at the end of the last real
// line (or, mid-line, just before that position). Returns where to insert it.
export function periodInsertion(
  lines: readonly string[],
  diagnosticLine: number,
  diagnosticColumn: number
): { line: number; column: number } | undefined {
  if (diagnosticColumn > 0) {
    const before = lines[diagnosticLine].slice(0, diagnosticColumn).replace(/\s+$/, "");
    return before === "" ? undefined : { line: diagnosticLine, column: before.length };
  }
  for (let index = Math.min(diagnosticLine, lines.length) - 1; index >= 0; index--) {
    const code = codeOf(lines[index]).replace(/\s+$/, "");
    if (code.trim() !== "") return { line: index, column: code.length };
  }
  return undefined;
}

export interface EditToken {
  kind: string;
  text: string;
  line: number;
  start: number;
  end: number;
}

export interface UnusedLocal {
  name: string;
  kind: "binding" | "parameter";
  line: number;
  start: number;
  end: number;
}

// Locals and parameters of function blocks whose name appears nowhere else in
// the block. Conservative on purpose: any other occurrence (even a named-argument
// key) counts as a use, and a name starting with `_` is taken as deliberately
// unused. `blocks` are the matched def ... end line ranges.
export function findUnusedLocals(
  tokens: readonly EditToken[],
  blocks: ReadonlyArray<{ openerLine: number; endLine: number }>
): UnusedLocal[] {
  const unused: UnusedLocal[] = [];
  const byOpener = new Map<number, number>();
  for (const block of blocks) byOpener.set(block.openerLine, block.endLine);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ident" || token.text !== "def" || tokens[i + 1]?.kind !== "ident" || tokens[i + 2]?.kind !== "lparen") continue;
    const endLine = byOpener.get(token.line);
    if (endLine === undefined) continue;

    // The head's closing parenthesis, to be a function (`=>` follows).
    let depth = 0;
    let close = -1;
    for (let j = i + 2; j < tokens.length; j++) {
      if (tokens[j].kind === "lparen") depth++;
      else if (tokens[j].kind === "rparen" && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close < 0 || tokens[close + 1]?.kind !== "arrow") continue;

    // Everything in the block, by identifier.
    const counts = new Map<string, number>();
    let last = close;
    for (let j = i + 1; j < tokens.length && tokens[j].line <= endLine; j++) {
      last = j;
      if (tokens[j].kind === "ident") counts.set(tokens[j].text, (counts.get(tokens[j].text) ?? 0) + 1);
    }

    const candidates: Array<{ at: number; kind: UnusedLocal["kind"] }> = [];
    // Parameters: `name:` at the head's own depth.
    depth = 0;
    for (let j = i + 2; j <= close; j++) {
      if (tokens[j].kind === "lparen") depth++;
      else if (tokens[j].kind === "rparen") depth--;
      else if (depth === 1 && tokens[j].kind === "ident" && tokens[j + 1]?.kind === "colon" && (tokens[j - 1]?.kind === "lparen" || tokens[j - 1]?.kind === "comma")) {
        candidates.push({ at: j, kind: "parameter" });
      }
    }
    // Locals: `def name :=` or `def name: Type :=` inside the body.
    for (let j = close + 1; j <= last; j++) {
      if (tokens[j].text === "def" && tokens[j].kind === "ident" && tokens[j + 1]?.kind === "ident") {
        const after = tokens[j + 2]?.kind;
        if (after === "bind" || after === "colon") candidates.push({ at: j + 1, kind: "binding" });
      }
    }

    for (const candidate of candidates) {
      const name = tokens[candidate.at];
      if (name.text === "_" || name.text.startsWith("_")) continue;
      if ((counts.get(name.text) ?? 0) === 1) {
        unused.push({ name: name.text, kind: candidate.kind, line: name.line, start: name.start, end: name.end });
      }
    }
  }
  return unused;
}
