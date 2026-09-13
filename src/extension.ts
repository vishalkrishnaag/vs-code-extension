import * as vscode from "vscode";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  FelidaeDocumentFormattingEditProvider,
  FelidaeDocumentRangeFormattingEditProvider
} from "./formatter";
import * as ml from "./mlRanking";
import * as languageClient from "./languageClient";

type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "import"
  | "lparen"
  | "rparen"
  | "lbrace"
  | "rbrace"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "colon"
  | "dot"
  | "pipe"
  | "question"
  | "bind"
  | "doubleColon"
  | "arrow"
  | "plus"
  | "comparison";

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  start: number;
  end: number;
}

interface LexResult {
  tokens: Token[];
  diagnostics: vscode.Diagnostic[];
}

interface PositionedString {
  value: string;
  line: number;
  start: number;
  end: number;
}

// One named argument a call accepts. `type` is only known for user-defined
// declarations (from felidae's AST, or scraped from the head text);
// builtins document names only.
interface FelidaeParam {
  name: string;
  type?: string;
}

interface BuiltinDoc {
  heading: string;
  description: string;
  example: string;
  // Derived at build time by scripts/generate-builtin-docs.js from `example`,
  // so neither this extension nor the IntelliJ plugin has to re-parse it.
  params?: FelidaeParam[];
}

interface DapRequest extends vscode.DebugProtocolMessage {
  type: "request";
  seq?: number;
  command: string;
  arguments?: unknown;
}

const semanticLegend = new vscode.SemanticTokensLegend(["variable", "method"], ["readonly"]);

const FELIDAE_BUILTIN_TYPE_NAMES = new Set([
  "any", "array", "bool", "boolean", "decimal", "double", "float", "int", "number", "string"
]);

function loadBuiltinDocs(): Record<string, BuiltinDoc> {
  try {
    const docsPath = path.join(__dirname, "..", "resources", "builtin-docs.json");
    const parsed = JSON.parse(fs.readFileSync(docsPath, "utf8")) as Record<string, BuiltinDoc>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const builtinDocs: Record<string, BuiltinDoc> = loadBuiltinDocs();


function builtinSourceName(name: string): string {
  const legacyColonBuiltins = new Set([
    "math:add", "math:sub", "math:mul", "math:div", "math:mod",
    "str:len", "str:contains", "str:concat", "str:lower", "str:upper",
    "str:trim", "str:split", "str:replace", "str:startsWith", "str:endsWith",
    "array:get", "array:len", "array:push",
    "fn:array", "fn:pair", "fn:tuple",
    "pair:first", "pair:second",
    "json:parse", "json:get", "json:has", "json:keys", "json:set", "json:remove", "json:toText",
    "csv:parse", "csv:toFacts", "csv:toText", "csv:toFelidaeFacts",
    "csv:addRow", "csv:findRows", "csv:updateRows", "csv:deleteRows",
    "file:readFile", "file:readLines", "file:readLine", "file:writeFile", "file:writeLines", "file:appendFile", "file:exists", "file:deleteFile"
  ]);
  return legacyColonBuiltins.has(name) ? name : name.replace(/:/g, ".");
}

function quotePosixShell(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runInTerminal(executablePath: string, args: string[], cwd: string): void {
  let command: string;
  const env: Record<string, string> = {};
  if (process.platform === "win32") {
    // Delayed expansion happens after CMD metacharacter parsing. Keep user
    // values out of command text; encode arguments for the native CRT parser.
    env.FELIDAE_RUN_EXE = executablePath;
    const argumentsText = args.map((arg, index) => {
      env[`FELIDAE_RUN_ARG_${index}`] = arg
        .replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1');
      return `"!FELIDAE_RUN_ARG_${index}!"`;
    });
    command = ['"!FELIDAE_RUN_EXE!"', ...argumentsText].join(" ");
  } else {
    command = [executablePath, ...args].map(quotePosixShell).join(" ");
  }
  const terminal = vscode.window.createTerminal({
    name: "Felidae", cwd, env,
    shellPath: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh",
    shellArgs: process.platform === "win32" ? ["/d", "/v:on"] : []
  });
  terminal.show();
  terminal.sendText(command);
}

function documentRange(document: vscode.TextDocument, line: number, start: number, end: number): vscode.Range {
  return new vscode.Range(
    new vscode.Position(line, start),
    new vscode.Position(line, Math.max(end, start + 1))
  );
}

function makeDiagnostic(
  document: vscode.TextDocument,
  line: number,
  start: number,
  end: number,
  message: string,
  severity: vscode.DiagnosticSeverity
): vscode.Diagnostic {
  return new vscode.Diagnostic(documentRange(document, line, start, end), message, severity);
}

function lexDocument(document: vscode.TextDocument): LexResult {
  const tokens: Token[] = [];
  const diagnostics: vscode.Diagnostic[] = [];

  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
    const text = document.lineAt(lineIndex).text;
    let i = 0;

    while (i < text.length) {
      const ch = text[i];

      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      if (ch === "#") {
        break;
      }

      if (ch === "\"") {
        const start = i;
        i++;
        while (i < text.length && text[i] !== "\"") {
          if (text[i] === "\\") {
            i++;
          }
          i++;
        }
        if (i >= text.length) {
          diagnostics.push(makeDiagnostic(document, lineIndex, start, text.length, "Unterminated string literal.", vscode.DiagnosticSeverity.Error));
          break;
        }
        i++;
        tokens.push({ kind: "string", text: text.slice(start + 1, i - 1), line: lineIndex, start, end: i });
        continue;
      }

      if (/[A-Za-z_]/.test(ch)) {
        const start = i;
        i++;
        while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) {
          i++;
        }
        const word = text.slice(start, i);
        tokens.push({ kind: word === "import" ? "import" : "ident", text: word, line: lineIndex, start, end: i });
        continue;
      }

      if (/\d/.test(ch)) {
        const start = i;
        i++;
        while (i < text.length && /\d/.test(text[i])) {
          i++;
        }
        if (text[i] === "." && /\d/.test(text[i + 1] ?? "")) {
          i++;
          while (i < text.length && /\d/.test(text[i])) {
            i++;
          }
        }
        tokens.push({ kind: "number", text: text.slice(start, i), line: lineIndex, start, end: i });
        continue;
      }

      const two = text.slice(i, i + 2);
      if (two === ":=") {
        tokens.push({ kind: "bind", text: two, line: lineIndex, start: i, end: i + 2 });
        i += 2;
        continue;
      }
      if (two === "::") {
        tokens.push({ kind: "doubleColon", text: two, line: lineIndex, start: i, end: i + 2 });
        i += 2;
        continue;
      }
      if (two === "=>") {
        tokens.push({ kind: "arrow", text: two, line: lineIndex, start: i, end: i + 2 });
        i += 2;
        continue;
      }
      if (["==", "!=", "<=", ">="].includes(two)) {
        tokens.push({ kind: "comparison", text: two, line: lineIndex, start: i, end: i + 2 });
        i += 2;
        continue;
      }
      if (ch === "<" || ch === ">") {
        tokens.push({ kind: "comparison", text: ch, line: lineIndex, start: i, end: i + 1 });
        i++;
        continue;
      }

      const singleKinds: Record<string, TokenKind> = {
        "(": "lparen",
        ")": "rparen",
        "{": "lbrace",
        "}": "rbrace",
        "[": "lbracket",
        "]": "rbracket",
        ",": "comma",
        ":": "colon",
        ".": "dot",
        "+": "plus",
        "|": "pipe",
        "?": "question"
      };
      const kind = singleKinds[ch];
      if (kind) {
        tokens.push({ kind, text: ch, line: lineIndex, start: i, end: i + 1 });
        i++;
        continue;
      }

      diagnostics.push(makeDiagnostic(document, lineIndex, i, i + 1, `Unexpected character '${ch}'.`, vscode.DiagnosticSeverity.Error));
      i++;
    }
  }

  return { tokens, diagnostics };
}

function validateImports(document: vscode.TextDocument, tokens: Token[], diagnostics: vscode.Diagnostic[]): void {
  const documentDir = path.dirname(document.uri.fsPath);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "import") {
      continue;
    }

    const pathToken = tokens[i + 1];
    if (!pathToken) {
      diagnostics.push(makeDiagnostic(document, token.line, token.start, token.end, "Import must be followed by a string path or parenthesized string list.", vscode.DiagnosticSeverity.Error));
      continue;
    }

    if (pathToken.kind === "lparen") {
      let cursor = i + 2;
      let sawPath = false;
      while (cursor < tokens.length && tokens[cursor].kind !== "rparen") {
        const item = tokens[cursor];
        if (item.kind !== "string") {
          diagnostics.push(makeDiagnostic(document, item.line, item.start, item.end, "Import lists can only contain string paths.", vscode.DiagnosticSeverity.Error));
          cursor++;
          continue;
        }
        sawPath = true;
        validateImportPath(document, documentDir, item, diagnostics);
        cursor++;
      }
      if (!sawPath) {
        diagnostics.push(makeDiagnostic(document, pathToken.line, pathToken.start, pathToken.end, "Import list must contain at least one path.", vscode.DiagnosticSeverity.Error));
      }
      if (cursor >= tokens.length || tokens[cursor].kind !== "rparen") {
        diagnostics.push(makeDiagnostic(document, pathToken.line, pathToken.start, pathToken.end, "Import list must end with ')'.", vscode.DiagnosticSeverity.Error));
        continue;
      }
      const dotToken = tokens[cursor + 1];
      if (!dotToken || dotToken.kind !== "dot") {
        diagnostics.push(makeDiagnostic(document, tokens[cursor].line, tokens[cursor].end, tokens[cursor].end + 1, "Import statement must end with '.'.", vscode.DiagnosticSeverity.Error));
      }
      continue;
    }

    const dotToken = tokens[i + 2];
    if (pathToken.kind !== "string") {
      diagnostics.push(makeDiagnostic(document, token.line, token.start, token.end, "Import must be followed by a string path or parenthesized string list.", vscode.DiagnosticSeverity.Error));
      continue;
    }
    if (!dotToken || dotToken.kind !== "dot") {
      diagnostics.push(makeDiagnostic(document, pathToken.line, pathToken.end, pathToken.end + 1, "Import statement must end with '.'.", vscode.DiagnosticSeverity.Error));
    }

    validateImportPath(document, documentDir, pathToken, diagnostics);
  }
}

function validateImportPath(
  document: vscode.TextDocument,
  documentDir: string,
  pathToken: Token,
  diagnostics: vscode.Diagnostic[]
): void {
  const rawPath = pathToken.text.trim();
  if (resolveCoreImport(document, rawPath)) {
    return;
  }
  const isWildcard = rawPath.endsWith("/*");
  const checkPath = isWildcard ? rawPath.slice(0, -2) : rawPath;
  const importPath = path.resolve(documentDir, checkPath);
  if (!fs.existsSync(importPath)) {
    diagnostics.push(makeDiagnostic(document, pathToken.line, pathToken.start, pathToken.end, `Import path not found: ${rawPath}`, vscode.DiagnosticSeverity.Warning));
    return;
  }
  if (!isWildcard && !fs.statSync(importPath).isDirectory() && path.extname(importPath) !== ".fx") {
    diagnostics.push(makeDiagnostic(document, pathToken.line, pathToken.start, pathToken.end, "Import files must use the .fx extension.", vscode.DiagnosticSeverity.Error));
  }
}

function isValueStart(token: Token | undefined): boolean {
  return !!token && ["ident", "string", "number", "lbrace", "lbracket"].includes(token.kind);
}

function isMapKey(tokens: Token[], index: number): boolean {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const kind = tokens[i].kind;
    if (kind === "rbrace" || kind === "rbracket" || kind === "rparen") depth++;
    if (kind === "lbrace" || kind === "lbracket" || kind === "lparen") {
      if (depth === 0) return kind === "lbrace";
      depth--;
    }
    if (depth === 0 && kind === "dot") return false;
  }
  return false;
}

function isNamedArgument(tokens: Token[], index: number): boolean {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const kind = tokens[i].kind;
    if (kind === "rbrace" || kind === "rbracket" || kind === "rparen") depth++;
    if (kind === "lbrace" || kind === "lbracket") {
      if (depth === 0) return false;
      depth--;
    }
    if (kind === "lparen") {
      if (depth === 0) return true;
      depth--;
    }
    if (depth === 0 && kind === "dot") return false;
  }
  return false;
}

function findMatchingParen(tokens: Token[], lparenIndex: number): number | undefined {
  let depth = 0;
  for (let i = lparenIndex; i < tokens.length; i++) {
    if (tokens[i].kind === "lparen") depth++;
    if (tokens[i].kind === "rparen") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function validateClauseHeadFields(document: vscode.TextDocument, tokens: Token[], diagnostics: vscode.Diagnostic[]): void {
  const globalBindings = collectGlobalBindings(tokens);
  const importedModules = collectImportedModuleNames(document);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].kind !== "ident" || tokens[i + 1].kind !== "lparen") continue;

    const close = findMatchingParen(tokens, i + 1);
    if (close === undefined) continue;

    const after = tokens[close + 1];
    if (!after || (after.kind !== "arrow" && after.kind !== "dot")) continue;
    const isRuleHead = after.kind === "arrow";
    const bodyEnd = statementEndIndex(tokens, close + 2);
    const methodStyle = isRuleHead && (headLooksMethodStyle(tokens, i + 2, close) || tokens[i].text === "main");
    const declared = collectHeadDeclaredVars(tokens, i + 2, close, methodStyle);
    for (const name of globalBindings) declared.add(name);
    for (const name of importedModules) declared.add(name);

    let depth = 0;
    let argStart = i + 2;
    let argValueStart: number | undefined;
    for (let cursor = i + 2; cursor < close; cursor++) {
      const token = tokens[cursor];
      if (token.kind === "lparen" || token.kind === "lbrace" || token.kind === "lbracket") depth++;
      if (token.kind === "rparen" || token.kind === "rbrace" || token.kind === "rbracket") depth--;
      if (depth !== 0) continue;

      if (token.kind === "comma") {
        const valueStart = argValueStart ?? argStart;
        if (isRuleHead && valueStart < cursor && containsMemberAccess(tokens, valueStart, cursor)) {
          diagnostics.push(makeDiagnostic(document, tokens[valueStart].line, tokens[valueStart].start, token.end, "Rule head fields cannot use member access. Bind a head variable in the body, e.g. Name == e.name.", vscode.DiagnosticSeverity.Error));
        }
        argStart = cursor + 1;
        argValueStart = undefined;
        continue;
      }

      if (cursor === argStart && token.kind === "ident" && tokens[cursor + 1]?.kind === "colon") {
        argValueStart = cursor + 2;
      }
    }
    const finalValueStart = argValueStart ?? argStart;
    if (isRuleHead && finalValueStart < close && containsMemberAccess(tokens, finalValueStart, close)) {
      diagnostics.push(makeDiagnostic(document, tokens[finalValueStart].line, tokens[finalValueStart].start, tokens[close - 1]?.end ?? tokens[finalValueStart].end, "Rule head fields cannot use member access. Bind a head variable in the body, e.g. Name == e.name.", vscode.DiagnosticSeverity.Error));
    }
    if (isRuleHead) {
      validateBodyDeclaredVars(document, tokens, close + 2, bodyEnd, declared, diagnostics);
    }
  }
}

function collectGlobalBindings(tokens: Token[]): Set<string> {
  const globals = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i].kind === "ident" && tokens[i + 1]?.kind === "bind") {
      globals.add(tokens[i].text);
    }
  }
  return globals;
}

function containsMemberAccess(tokens: Token[], start: number, end: number): boolean {
  for (let i = start; i + 2 < end; i++) {
    if (
      tokens[i].kind === "ident" &&
      (tokens[i + 1].kind === "dot" || tokens[i + 1].kind === "colon") &&
      tokens[i + 2].kind === "ident"
    ) {
      return true;
    }
  }
  return false;
}

function statementEndIndex(tokens: Token[], start: number): number {
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token.kind === "dot" && !(next?.kind === "ident" && next.line === token.line)) {
      return i;
    }
  }
  return tokens.length;
}

function collectVariableNames(tokens: Token[], start: number, end: number): Set<string> {
  const vars = new Set<string>();
  for (let i = start; i < end; i++) {
    const token = tokens[i];
    if (token.kind !== "ident") continue;
    if (token.text === "_") continue;
    if (token.text === "nil") continue;
    if (["else", "extend", "where", "return", "lambda", "then"].includes(token.text)) continue;

    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const nextNext = tokens[i + 2];
    const prevPrev = tokens[i - 2];

    if ((next?.kind === "dot" || next?.kind === "colon") && isLibraryNamespace(token.text)) continue;
    if (next?.kind === "arrow") continue;
    if (
      /^[A-Z]/.test(token.text) &&
      prev?.kind === "colon" &&
      tokens[i - 2]?.kind === "ident" &&
      ["type", "parent", "of"].includes(tokens[i - 2].text)
    ) {
      const callName = enclosingCallName(tokens, i);
      if (callName === "instanceof") continue;
    }
    if (next?.kind === "colon") continue;
    if (prev?.kind === "lparen" && prevPrev?.kind === "ident" && builtinDocs[prevPrev.text] && /^[A-Z]/.test(token.text)) continue;
    if (next?.kind === "dot" && nextNext?.kind === "ident") {
      vars.add(token.text);
      continue;
    }
    if (next?.kind === "lparen") continue;
    if (prev?.kind === "dot") continue;
    if (prev?.kind === "colon" && /^[A-Z]/.test(token.text)) continue;

    vars.add(token.text);
  }
  return vars;
}

interface EnclosingCall {
  name: string;
  // Token index of the `(` that opens the argument list the cursor sits in.
  openParen: number;
}

// Walks back from `index` to the unmatched `(` the cursor is inside, and
// reads the (possibly dotted/namespaced) call name in front of it.
function enclosingCall(tokens: Token[], index: number): EnclosingCall | undefined {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const kind = tokens[i].kind;
    if (kind === "rparen" || kind === "rbrace" || kind === "rbracket") depth++;
    if (kind === "lparen") {
      if (depth === 0 && tokens[i - 1]?.kind === "ident") {
        const nameParts = [tokens[i - 1].text];
        let cursor = i - 2;
        while (
          cursor >= 1 &&
          (tokens[cursor].kind === "dot" || tokens[cursor].kind === "colon") &&
          tokens[cursor - 1]?.kind === "ident"
        ) {
          nameParts.unshift(tokens[cursor - 1].text);
          cursor -= 2;
        }
        return { name: nameParts.join(":"), openParen: i };
      }
      depth--;
    }
    if (kind === "lbrace" || kind === "lbracket") depth--;
  }
  return undefined;
}

function enclosingCallName(tokens: Token[], index: number): string | undefined {
  return enclosingCall(tokens, index)?.name;
}

// Which argument slot the cursor is in, and which keys the call already
// names, by scanning forward from the opening `(` at this call's own depth.
function callArgumentState(
  tokens: Token[],
  openParen: number,
  index: number
): { activeParameter: number; suppliedKeys: Set<string> } {
  const suppliedKeys = new Set<string>();
  let activeParameter = 0;
  let depth = 0;
  for (let i = openParen + 1; i <= index && i < tokens.length; i++) {
    const kind = tokens[i].kind;
    if (kind === "lparen" || kind === "lbrace" || kind === "lbracket") depth++;
    else if (kind === "rparen" || kind === "rbrace" || kind === "rbracket") depth--;
    else if (kind === "comma" && depth === 0) activeParameter++;
    else if (kind === "ident" && depth === 0 && tokens[i + 1]?.kind === "colon") {
      suppliedKeys.add(tokens[i].text);
    }
  }
  return { activeParameter, suppliedKeys };
}

function headLooksMethodStyle(tokens: Token[], start: number, end: number): boolean {
  let depth = 0;
  let nameStart: number | undefined;
  let valueStart: number | undefined;
  let sawArg = false;
  let sawNamedArg = false;
  let sawNamedMethodArg = false;

  for (let i = start; i <= end; i++) {
    const token = tokens[i];
    if (i === end || (token.kind === "comma" && depth === 0)) {
      const value = valueStart !== undefined ? tokens[valueStart] : undefined;
      if (nameStart !== undefined && value?.kind === "ident" && (isTypeAnnotationName(value.text) || value.text !== tokens[nameStart].text)) {
        sawNamedMethodArg = true;
      } else if (nameStart === undefined && (value?.kind !== "ident" || !isTypeAnnotationName(value.text))) {
        return false;
      }
      if (nameStart !== undefined) sawNamedArg = true;
      sawArg = true;
      nameStart = undefined;
      valueStart = undefined;
      continue;
    }
    if (token.kind === "lparen" || token.kind === "lbrace" || token.kind === "lbracket") depth++;
    if (token.kind === "rparen" || token.kind === "rbrace" || token.kind === "rbracket") depth--;
    if (depth !== 0) continue;
    if (token.kind === "ident" && tokens[i + 1]?.kind === "colon") nameStart = i;
    if (token.kind === "colon") valueStart = i + 1;
  }

  return sawNamedMethodArg || sawNamedArg || (sawArg && !sawNamedArg);
}

function isTypeAnnotationName(name: string): boolean {
  return /^[A-Z]/.test(name) || ["any", "array", "bool", "boolean", "decimal", "double", "float", "int", "number", "string"].includes(name);
}

function collectHeadDeclaredVars(tokens: Token[], start: number, end: number, methodStyle: boolean): Set<string> {
  const declared = new Set<string>();
  let depth = 0;
  let argStart = start;
  let nameStart: number | undefined;
  let valueStart: number | undefined;

  for (let i = start; i <= end; i++) {
    const token = tokens[i];
    if (i === end || (token.kind === "comma" && depth === 0)) {
      if (methodStyle && nameStart !== undefined) {
        declared.add(tokens[nameStart].text);
      }
      if (valueStart !== undefined) {
        const value = tokens[valueStart];
        if (methodStyle && value?.kind === "ident") {
          if (!isTypeAnnotationName(value.text) && value.text !== tokens[nameStart ?? valueStart].text) {
            declared.add(value.text);
          }
        } else {
          for (const name of collectVariableNames(tokens, valueStart, i)) declared.add(name);
        }
      } else if (!methodStyle) {
        for (const name of collectVariableNames(tokens, argStart, i)) declared.add(name);
      }
      argStart = i + 1;
      nameStart = undefined;
      valueStart = undefined;
      continue;
    }

    if (token.kind === "lparen" || token.kind === "lbrace" || token.kind === "lbracket") depth++;
    if (token.kind === "rparen" || token.kind === "rbrace" || token.kind === "rbracket") depth--;
    if (depth !== 0) continue;

    if (i === argStart && token.kind === "ident" && tokens[i + 1]?.kind === "colon") nameStart = i;
    if (i === argStart + 1 && token.kind === "colon") valueStart = i + 1;
  }

  return declared;
}

function validateBodyDeclaredVars(document: vscode.TextDocument, tokens: Token[], start: number, end: number, declared: Set<string>, diagnostics: vscode.Diagnostic[]): void {
  let segmentStart = start;
  let depth = 0;

  const validateSegment = (from: number, to: number): void => {
    while (from < to && tokens[from].kind === "comma") from++;
    while (from < to && tokens[to - 1]?.kind === "comma") to--;
    if (from >= to) return;

    const isAssignment = tokens[from]?.kind === "ident" && tokens[from + 1]?.kind === "bind";
    const used = isAssignment ? collectVariableNames(tokens, from + 2, to) : collectVariableNames(tokens, from, to);
    for (const name of used) {
      if (!declared.has(name)) {
        diagnostics.push(makeDiagnostic(document, tokens[from].line, tokens[from].start, tokens[to - 1]?.end ?? tokens[from].end, `Variable '${name}' is used before declaration. Declare it in the rule head or assign it before use.`, vscode.DiagnosticSeverity.Error));
        break;
      }
    }
    if (isAssignment) declared.add(tokens[from].text);
  };

  for (let i = start; i <= end; i++) {
    const token = tokens[i];
    if (i === end || (((token.kind === "comma" || token.kind === "pipe") ||
      (token.kind === "ident" && token.text === "else")) && depth === 0)) {
      validateSegment(segmentStart, i);
      segmentStart = i + 1;
      continue;
    }
    if (token.kind === "lparen" || token.kind === "lbrace" || token.kind === "lbracket") depth++;
    if (token.kind === "rparen" || token.kind === "rbrace" || token.kind === "rbracket") depth--;
  }
}

function validateStatements(document: vscode.TextDocument, tokens: Token[], diagnostics: vscode.Diagnostic[]): void {
  const parenStack: Token[] = [];
  let statementStart: Token | undefined;
  let previous: Token | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    statementStart ??= token;

    if (token.kind === "lparen" || token.kind === "lbrace" || token.kind === "lbracket") {
      parenStack.push(token);
    } else if (token.kind === "rparen" || token.kind === "rbrace" || token.kind === "rbracket") {
      if (parenStack.length === 0) {
        diagnostics.push(makeDiagnostic(document, token.line, token.start, token.end, "Unmatched closing delimiter.", vscode.DiagnosticSeverity.Error));
      } else {
        const open = parenStack.pop();
        const matches =
          (open?.kind === "lparen" && token.kind === "rparen") ||
          (open?.kind === "lbrace" && token.kind === "rbrace") ||
          (open?.kind === "lbracket" && token.kind === "rbracket");
        if (!matches) {
          diagnostics.push(makeDiagnostic(document, token.line, token.start, token.end, "Mismatched closing delimiter.", vscode.DiagnosticSeverity.Error));
        }
      }
    }

    if (previous?.kind === "arrow" && (token.kind === "dot" || token.kind === "arrow")) {
      diagnostics.push(makeDiagnostic(document, previous.line, previous.start, previous.end, "Rule arrow must be followed by at least one goal.", vscode.DiagnosticSeverity.Error));
    }

    const next = tokens[i + 1];
    const isAccessorDot = token.kind === "dot" && next?.kind === "ident" && next.line === token.line;
    if (token.kind === "dot" && !isAccessorDot) {
      statementStart = undefined;
    }

    previous = token;
  }

  for (const open of parenStack) {
    diagnostics.push(makeDiagnostic(document, open.line, open.start, open.end, "Unclosed delimiter.", vscode.DiagnosticSeverity.Error));
  }

  if (statementStart && tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    diagnostics.push(makeDiagnostic(document, last.line, last.end, last.end + 1, "Statement should end with '.'. Queries may omit it at the command line, but source files should terminate statements.", vscode.DiagnosticSeverity.Warning));
  }
}

function validateCalls(document: vscode.TextDocument, tokens: Token[], diagnostics: vscode.Diagnostic[]): void {
  const lowercaseBuiltins = new Set(["throw", "lambda", "then", "type", "instanceof", "return"]);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if (token.kind === "doubleColon") {
      diagnostics.push(makeDiagnostic(document, token.line, token.start, token.end, "'::' is not supported in Felidae. Use '.' for top-level package/module calls.", vscode.DiagnosticSeverity.Error));
    }

    if (token.kind === "ident" && next?.kind === "lparen") {
      const previous = tokens[i - 1];
      const isNamespaced = previous?.kind === "colon" || previous?.kind === "dot";
      if (!isNamespaced && !lowercaseBuiltins.has(token.text) && !builtinDocs[token.text] && !/^[A-Z_]/.test(token.text)) {
        diagnostics.push(makeDiagnostic(document, token.line, token.start, token.end, "Predicate names usually start with an uppercase letter in this project.", vscode.DiagnosticSeverity.Warning));
      }
      continue;
    }

    if (token.kind === "ident" && next?.kind === "colon") {
      const value = tokens[i + 2];
      const nextNext = tokens[i + 2];
      const isNamespaceOrAccess = nextNext?.kind === "ident";
      if (!isNamespaceOrAccess && !isNamedArgument(tokens, i) && !isMapKey(tokens, i)) {
        continue;
      }
      if (!isNamespaceOrAccess && !isValueStart(value)) {
        diagnostics.push(makeDiagnostic(document, token.line, token.start, next.end, "Named argument must be followed by a value expression.", vscode.DiagnosticSeverity.Error));
      }
    }
  }
}

function validateDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
  void document;
  return [];
}

function importLinkTarget(document: vscode.TextDocument, rawPath: string): vscode.Uri | undefined {
  const coreTarget = resolveCoreImport(document, rawPath);
  if (coreTarget) return coreTarget;
  const documentDir = path.dirname(document.uri.fsPath);
  const isWildcard = rawPath.endsWith("/*");
  const checkPath = isWildcard ? rawPath.slice(0, -2) : rawPath;
  const resolved = path.resolve(documentDir, checkPath);
  if (!fs.existsSync(resolved)) {
    return undefined;
  }
  return vscode.Uri.file(resolved);
}

function resolveCoreImport(document: vscode.TextDocument, rawPath: string): vscode.Uri | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawPath)) return undefined;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates: string[] = [];
  for (const folder of folders) {
    candidates.push(path.join(folder.uri.fsPath, "core", `${rawPath}.fx`));
  }
  let current = path.dirname(document.uri.fsPath);
  while (current && current !== path.dirname(current)) {
    candidates.push(path.join(current, "core", `${rawPath}.fx`));
    current = path.dirname(current);
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return vscode.Uri.file(candidate);
    }
  }
  return undefined;
}

function collectImportStrings(document: vscode.TextDocument): PositionedString[] {
  const result: PositionedString[] = [];
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (!/\bimport\b/.test(text)) continue;
    const importIndex = text.indexOf("import");
    const commentIndex = text.indexOf("#");
    if (commentIndex >= 0 && commentIndex < importIndex) continue;
    const regex = /"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      result.push({
        value: match[1],
        line,
        start: match.index + 1,
        end: match.index + 1 + match[1].length
      });
    }
  }
  return result;
}

function collectImportedModuleNames(document: vscode.TextDocument): Set<string> {
  const names = new Set<string>();
  for (const item of collectImportStrings(document)) {
    const normalized = item.value.replace(/\\/g, "/").replace(/\*$/, "");
    const base = path.basename(normalized, ".fx");
    if (base && /^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) names.add(base);
  }
  return names;
}

class FelidaeDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.ProviderResult<vscode.DocumentLink[]> {
    if (document.languageId !== "felidae") return [];
    return collectImportStrings(document)
      .map((item) => {
        const target = importLinkTarget(document, item.value);
        if (!target) return undefined;
        return new vscode.DocumentLink(documentRange(document, item.line, item.start, item.end), target);
      })
      .filter((link): link is vscode.DocumentLink => !!link);
  }
}

function getCallNameAtPosition(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const line = document.lineAt(position.line).text;
  let start = position.character;
  let end = position.character;
  const isNameChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_:.]/.test(ch);

  while (start > 0 && isNameChar(line[start - 1])) start--;
  while (end < line.length && isNameChar(line[end])) end++;

  const name = line.slice(start, end).replace(/^\.+|\.+$/g, "");
  if (!/^[A-Za-z_][A-Za-z0-9_:.]*$/.test(name)) return undefined;

  const after = line.slice(end);
  const before = line.slice(0, start);
  if (/^\s*\(/.test(after) || /[A-Za-z0-9_:.]$/.test(before)) {
    return builtinDocs[name.replace(/\./g, ":")] ? name.replace(/\./g, ":") : name;
  }
  return undefined;
}

function definitionPattern(name: string): RegExp {
  const parts = name.split(/[:.]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const qualifiedName = parts.join("\\s*[:.]\\s*");
  return new RegExp(`^(?:${qualifiedName}(?:\\s+extend\\s+[A-Za-z_][A-Za-z0-9_]*)?\\s*\\(|class\\s+${qualifiedName}\\b)`);
}

class FelidaeHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const name = getCallNameAtPosition(document, position);
    if (!name) return undefined;

    const doc = builtinDocs[name];
    if (doc) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`### ${doc.heading}\n\n`);
      markdown.appendMarkdown(`${doc.description}\n\n`);
      markdown.appendCodeblock(doc.example, "felidae");
      return new vscode.Hover(markdown);
    }

    // Not a builtin: fall through to the user's own declarations so hovering
    // a fact or method shows its signature too, via the same resolver that
    // backs completion and signature help.
    const resolved = resolveCall(document, name);
    if (!resolved) return undefined;

    const signature = resolved.params
      .map((param) => (param.type ? `${param.name}: ${param.type}` : `${param.name}:`))
      .join(", ");
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`### ${resolved.label}\n\n`);
    markdown.appendMarkdown(`${resolved.detail}\n\n`);
    markdown.appendCodeblock(`${resolved.label}(${signature})`, "felidae");
    return new vscode.Hover(markdown);
  }
}

class FelidaeDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | undefined> {
    // The language server advertises definitionProvider, and VS Code merges
    // results from every registered provider - so answering here as well
    // would show each declaration twice. The server resolves against the real
    // parse, so it wins; this stays as the fallback when it is not running.
    if (languageClient.isRunning()) return undefined;
    const name = getCallNameAtPosition(document, position);
    if (!name) return undefined;
    const builtin = await builtinDefinition(document, name);
    if (builtin) return builtin;

    const pattern = definitionPattern(name);
    const locations: vscode.Location[] = [];
    const files = await vscode.workspace.findFiles("**/*.fx", "**/{node_modules,build,out}/**", 200);

    for (const file of files) {
      const candidate = await vscode.workspace.openTextDocument(file);
      for (let line = 0; line < candidate.lineCount; line++) {
        const text = candidate.lineAt(line).text;
        if (!pattern.test(text)) continue;
        if (file.toString() === document.uri.toString() && line === position.line) continue;
        locations.push(new vscode.Location(file, new vscode.Position(line, text.search(/\S/))));
      }
    }

    return locations.length ? locations : undefined;
  }
}

async function builtinDefinition(document: vscode.TextDocument, name: string): Promise<vscode.Location | undefined> {
  const moduleName = name.split(":")[0]?.split(".")[0];
  if (!moduleName) return undefined;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) return undefined;
  const target = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, "core", `${moduleName}.fx`));
  if (!fs.existsSync(target.fsPath)) return undefined;
  const sourceName = builtinSourceName(name);
  const declaration = definitionPattern(sourceName);
  const targetDocument = await vscode.workspace.openTextDocument(target);
  for (let line = 0; line < targetDocument.lineCount; line++) {
    const text = targetDocument.lineAt(line).text;
    if (declaration.test(text)) {
      return new vscode.Location(target, new vscode.Position(line, text.search(/\S/)));
    }
  }
  return new vscode.Location(target, new vscode.Position(0, 0));
}

// Folds whole declarations - a method from its head down to its final
// `return`, and a multi-line fact from its head to its closing paren - plus
// runs of comment lines.
//
// This used to fold only on a `.` terminator at depth 0, so the dotless style
// most Felidae code is written in produced no fold regions at all. Regions are
// now derived from where declarations start, which is the same thing the
// outline and the IntelliJ folding builder use.
class FelidaeFoldingRangeProvider implements vscode.FoldingRangeProvider {
  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    if (document.languageId !== "felidae") return [];
    const ranges: vscode.FoldingRange[] = [];
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);

    // A line beginning a new top-level construct ends the previous region.
    // The optional `extend Parent` clause must be allowed here, or a fact
    // written as `Child extend Parent(...)` is not seen as starting anything
    // and the whole run of facts collapses into one region.
    const startsTopLevel = (line: string) =>
      /^[A-Za-z_][A-Za-z0-9_:.]*(?:[ \t]+extend[ \t]+[A-Za-z_][A-Za-z0-9_]*)?[ \t]*\(/.test(line) ||
      /^import\b/.test(line) ||
      /^[A-Za-z_][A-Za-z0-9_]*[ \t]*:=/.test(line);
    const opensEndBlock = (line: string) =>
      /^\s*class\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+extend\b.*)?\s*$/.test(line) ||
      /^\s*[A-Za-z_][A-Za-z0-9_:.]*\s*\([^)]*\)\s*=>\s*(?:#.*)?$/.test(line);
    const closesEndBlock = (line: string) => /^\s*end\.?\s*(?:#.*)?$/.test(line);

    // Explicit `end` is authoritative: fold precisely from its opening
    // declaration/class line to the matching closer, including nested blocks.
    const endBlockStarts: number[] = [];
    const explicitlyFolded = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (opensEndBlock(lines[i])) {
        endBlockStarts.push(i);
      } else if (closesEndBlock(lines[i])) {
        const start = endBlockStarts.pop();
        if (start !== undefined && i > start) {
          ranges.push(new vscode.FoldingRange(start, i, vscode.FoldingRangeKind.Region));
          explicitlyFolded.add(start);
        }
      }
    }

    for (let i = 0; i < lines.length; i++) {
      if (!startsTopLevel(lines[i]) || explicitlyFolded.has(i)) continue;
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (startsTopLevel(lines[j])) break;
        // Blank lines and comments trailing a declaration belong to whatever
        // comes next - a comment here is the next declaration's doc. Ending
        // at the last real body line keeps a one-line fact unfoldable instead
        // of letting it swallow the following comment.
        if (lines[j].trim().length > 0 && !/^[ \t]*#/.test(lines[j])) end = j;
      }
      if (end > i) {
        ranges.push(new vscode.FoldingRange(i, end, vscode.FoldingRangeKind.Region));
      }
    }

    // Consecutive `#` lines fold as a comment block, which is what VS Code's
    // "Fold All Block Comments" acts on.
    let commentStart = -1;
    for (let i = 0; i <= lines.length; i++) {
      const isComment = i < lines.length && /^[ \t]*#/.test(lines[i]);
      if (isComment && commentStart < 0) commentStart = i;
      else if (!isComment && commentStart >= 0) {
        if (i - 1 > commentStart) {
          ranges.push(
            new vscode.FoldingRange(commentStart, i - 1, vscode.FoldingRangeKind.Comment)
          );
        }
        commentStart = -1;
      }
    }

    return ranges;
  }
}

class FelidaeCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== "felidae") return [];
    const lenses: vscode.CodeLens[] = [];
    for (let line = 0; line < document.lineCount; line++) {
      const text = document.lineAt(line).text;
      // Same column-0 anchoring as hasMainMethod: an indented `main(...)`
      // call is a call, not the entry point.
      if (!MAIN_DECLARATION_PATTERN.test(text)) continue;
      const range = new vscode.Range(line, text.indexOf("main"), line, text.indexOf("main") + 4);
      lenses.push(new vscode.CodeLens(range, {
        title: "$(play) Run",
        command: "felidae.runMain",
        arguments: [document.uri]
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: "| $(debug-alt) Debug",
        command: "felidae.debugMain",
        arguments: [document.uri]
      }));
    }
    return lenses;
  }
}

class FelidaeSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(semanticLegend);
    const lexed = lexDocument(document);
    const tokens = lexed.tokens;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.kind !== "ident" || token.text === "_") continue;

      const next = tokens[i + 1];
      const previous = tokens[i - 1];
      const nextNext = tokens[i + 2];
      const isHeadParam = next?.kind === "colon" && isInsideMethodHead(tokens, i);
      const isAssignmentTarget = next?.kind === "bind";
      const isLambdaItem = previous?.kind === "comma" && next?.kind === "arrow";
      const isMemberBase = (next?.kind === "dot" || next?.kind === "colon") && nextNext?.kind === "ident";
      const isKeyword = ["class", "end", "if", "else", "extend", "where", "return", "lambda", "then", "nil"].includes(token.text);
      const isCall = next?.kind === "lparen";

      if (isKeyword) continue;

      if (isCall) {
        // A call/rule/method head: `Name(...)` immediately followed by `=>`.
        // This never overlaps the variable checks below, which all require
        // `next` to be colon/bind/arrow/dot rather than lparen.
        const close = findMatchingParen(tokens, i + 1);
        const isMethodHead = close !== undefined && tokens[close + 1]?.kind === "arrow";
        if (isMethodHead) {
          builder.push(token.line, token.start, Math.max(1, token.end - token.start), 1, 0);
        }
        continue;
      }

      // A plain variable reference: a lowercase-leading identifier used as a
      // value (a call argument, list item, or comparison operand) rather than
      // a named-arg key, a type annotation, or a call/predicate name. Type
      // annotations (`input: Person`) are excluded by the leading-uppercase
      // check, matching the interpreter's own convention for type names.
      // Builtin primitive type names (`value: int`) are lowercase, so they
      // need their own exclusion alongside the uppercase-type-name check.
      const isBuiltinTypeName = FELIDAE_BUILTIN_TYPE_NAMES.has(token.text);
      const isValuePosition =
        previous?.kind === "colon" ||
        previous?.kind === "comma" ||
        previous?.kind === "lparen" ||
        previous?.kind === "comparison" ||
        previous?.kind === "bind" ||
        next?.kind === "comparison";
      const isBareValueReference =
        !/^[A-Z]/.test(token.text) &&
        !isBuiltinTypeName &&
        isValuePosition &&
        next?.kind !== "lparen" &&
        next?.kind !== "colon";

      if (isHeadParam || isAssignmentTarget || isLambdaItem || isMemberBase || isBareValueReference) {
        builder.push(token.line, token.start, Math.max(1, token.end - token.start), 0, 1);
      }
    }

    return builder.build();
  }
}

function isInsideMethodHead(tokens: Token[], index: number): boolean {
  let left = index;
  while (left >= 0 && tokens[left].kind !== "lparen" && tokens[left].kind !== "dot") {
    left--;
  }
  if (left < 1 || tokens[left].kind !== "lparen" || tokens[left - 1]?.kind !== "ident") return false;

  let depth = 0;
  for (let right = left; right < tokens.length; right++) {
    const token = tokens[right];
    if (token.kind === "lparen") depth++;
    if (token.kind === "rparen") {
      depth--;
      if (depth === 0) {
        return tokens[right + 1]?.kind === "arrow";
      }
    }
  }
  return false;
}

function collectHeadParams(argsText: string): FelidaeParam[] {
  const params: FelidaeParam[] = [];
  const seen = new Set<string>();
  let depth = 0;
  let segmentStart = 0;
  const flush = (end: number) => {
    const segment = argsText.slice(segmentStart, end).trim();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!=)/.exec(segment);
    if (!match || seen.has(match[1])) return;
    seen.add(match[1]);
    const type = segment.slice(match[0].length).trim();
    params.push(type ? { name: match[1], type } : { name: match[1] });
  };
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      flush(i);
      segmentStart = i + 1;
    }
  }
  flush(argsText.length);
  return params;
}

// Name-only view of collectHeadParams, for the callers that only label fields.
function collectHeadFields(argsText: string): string[] {
  return collectHeadParams(argsText).map((param) => param.name);
}

function normalizeGraphName(name: string): string {
  return name.replace(/\./g, ":");
}

const FELIDAE_LIBRARY_NAMES =
  "array|comparison|console|csv|db|exception|fact|fact_analysis|file|flibrary|fn|group|gtk|http|json|list|logic|math|ml|package|pair|plot|prelude|process|qt|set|smoke|str|system|thread|wordnet";

function isLibraryName(name: string): boolean {
  return new RegExp(`^(${FELIDAE_LIBRARY_NAMES})(:|$)`).test(name);
}

function isLibraryNamespace(name: string): boolean {
  return new RegExp(`^(${FELIDAE_LIBRARY_NAMES})$`).test(name);
}

// Declaration head: `Name(args)`, `Name extend Parent(args)`, optionally
// followed by `=>` (method) or `.` (dot-terminated fact).
//
// Two properties matter and both were wrong before:
//
//  * The argument list uses bounded nesting rather than `[\s\S]*?`. The lazy
//    form is unbounded across newlines, so a dotless fact - which has no `=>`
//    or `.` to stop at - made one match swallow every declaration up to the
//    next terminated one. In examples/timeline_facts.fx that hid 3 of 4
//    declarations from the outline, completion and the debug adapter.
//  * It anchors at column 0. Felidae declarations are always top level, so
//    allowing leading whitespace matched indented *calls*: `return (`,
//    `system.print(...)` and `instanceof(...)` were all reported as
//    declarations named `return`, `system.print` and `instanceof`.
//
// Across examples/ and v2_examples/ this takes true declarations found from
// 356 to 618 while removing those false positives.
const DECLARATION_PATTERN =
  /^([A-Za-z_][A-Za-z0-9_:.]*)(?:[ \t]+extend[ \t]+([A-Za-z_][A-Za-z0-9_]*))?[ \t]*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)[ \t]*(=>|\.|$)/gm;
const GLOBAL_BINDING_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=/gm;

class FelidaeDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.ProviderResult<vscode.DocumentSymbol[]> {
    if (document.languageId !== "felidae") return [];
    // Same reasoning as FelidaeDefinitionProvider: the server advertises
    // documentSymbolProvider, and VS Code concatenates outlines from all
    // providers, so answering here too would duplicate every entry.
    if (languageClient.isRunning()) return [];
    const text = document.getText();
    const symbols: vscode.DocumentSymbol[] = [];

    const declaration = new RegExp(DECLARATION_PATTERN);
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(text)) !== null) {
      const rawName = match[1];
      const normalized = normalizeGraphName(rawName);
      if (isLibraryName(normalized)) continue;

      const isMethod = match[4] === "=>";
      const nameStart = match.index + match[0].indexOf(rawName);
      const nameRange = new vscode.Range(
        document.positionAt(nameStart),
        document.positionAt(nameStart + rawName.length)
      );
      const fullRange = new vscode.Range(
        document.positionAt(match.index),
        document.positionAt(match.index + match[0].length)
      );
      const detail = isMethod ? (match[2] ? `extends ${match[2]}` : "") : "fact";
      const symbol = new vscode.DocumentSymbol(
        rawName,
        detail,
        isMethod ? vscode.SymbolKind.Method : vscode.SymbolKind.Struct,
        fullRange,
        nameRange
      );

      if (!isMethod) {
        for (const field of collectHeadFields(match[3])) {
          const fieldOffset = text.indexOf(field, match.index);
          const fieldPos = fieldOffset >= 0 && fieldOffset < match.index + match[0].length
            ? document.positionAt(fieldOffset)
            : nameRange.start;
          const fieldRange = new vscode.Range(fieldPos, fieldPos.translate(0, field.length));
          symbol.children.push(
            new vscode.DocumentSymbol(field, "field", vscode.SymbolKind.Field, fieldRange, fieldRange)
          );
        }
      }
      symbols.push(symbol);
    }

    const globalBinding = new RegExp(GLOBAL_BINDING_PATTERN);
    while ((match = globalBinding.exec(text)) !== null) {
      const name = match[1];
      const nameRange = new vscode.Range(
        document.positionAt(match.index),
        document.positionAt(match.index + name.length)
      );
      symbols.push(new vscode.DocumentSymbol(name, "global", vscode.SymbolKind.Variable, nameRange, nameRange));
    }

    return symbols;
  }
}

function tokenIndexBefore(tokens: Token[], position: vscode.Position): number {
  let index = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.line > position.line) break;
    if (token.line === position.line && token.start >= position.character) break;
    index = i;
  }
  return index;
}

function builtinDocKeysForNamespace(baseName: string): string[] {
  const prefix = `${baseName}:`;
  return Object.keys(builtinDocs).filter((key) => key.startsWith(prefix));
}

function builtinDocCompletionsForNamespace(baseName: string): vscode.CompletionItem[] {
  return builtinDocKeysForNamespace(baseName).map((key) => {
    const doc = builtinDocs[key];
    const functionName = key.slice(key.indexOf(":") + 1);
    const item = new vscode.CompletionItem(functionName, vscode.CompletionItemKind.Function);
    item.detail = doc.heading;
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`${doc.description}\n\n`);
    markdown.appendCodeblock(doc.example, "felidae");
    item.documentation = markdown;
    item.insertText = functionName;
    return item;
  });
}

function namedArgCompletion(name: string, detail?: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
  item.insertText = new vscode.SnippetString(`${name}: $0`);
  if (detail) item.detail = detail;
  return item;
}

interface ResolvedCall {
  label: string;
  params: FelidaeParam[];
  detail: string;
  documentation?: vscode.MarkdownString;
}

// The single place a call name is turned into its parameter list. Both
// keyword-argument completion and signature help go through this so they can
// never disagree about what a call accepts.
//
// Resolution order, most to least authoritative:
//   1. builtinDocs - params derived at build time from the documented example.
//   2. symbolSummaryCache - real parameters parsed by felidae from the
//      AST, including types, for user-defined methods and facts.
//   3. DECLARATION_PATTERN text scan - the fallback when felidae is
//      missing, older than --symbols-json, or has not answered yet.
function resolveCall(document: vscode.TextDocument, callName: string): ResolvedCall | undefined {
  const normalized = callName.replace(/\./g, ":");

  const builtin = builtinDocs[normalized];
  if (builtin) {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`${builtin.description}\n\n`);
    markdown.appendCodeblock(builtin.example, "felidae");
    return {
      label: builtin.heading,
      params: builtin.params ?? [],
      detail: builtin.heading,
      documentation: markdown
    };
  }

  const simpleName = normalized.split(":").pop() ?? normalized;
  const matchesName = (name: string) =>
    name === normalized || name === simpleName || normalizeGraphName(name) === simpleName;

  const summary = symbolSummaryCache.get(document.uri.toString());
  if (summary) {
    for (const group of [summary.methods, summary.facts]) {
      for (const definition of group ?? []) {
        if (!matchesName(definition.name) || !definition.params?.length) continue;
        return {
          label: definition.name,
          params: definition.params,
          detail: group === summary.facts ? `fact ${definition.name}` : `method ${definition.name}`
        };
      }
    }
  }

  const text = document.getText();
  const declaration = new RegExp(DECLARATION_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(text)) !== null) {
    if (!matchesName(match[1])) continue;
    return {
      label: match[1],
      params: collectHeadParams(match[3]),
      detail: match[4] === "=>" ? `method ${match[1]}` : `fact ${match[1]}`
    };
  }
  return undefined;
}

function completionsForCallFields(
  document: vscode.TextDocument,
  callName: string,
  suppliedKeys: ReadonlySet<string> = new Set()
): vscode.CompletionItem[] {
  const resolved = resolveCall(document, callName);
  if (!resolved) return [];
  return resolved.params
    // A key already written earlier in this same call is not a useful
    // suggestion for the argument currently being typed.
    .filter((param) => !suppliedKeys.has(param.name))
    .map((param) =>
      namedArgCompletion(
        param.name,
        param.type ? `${resolved.detail} — ${param.type}` : resolved.detail
      )
    );
}

function completionsForScope(
  document: vscode.TextDocument,
  tokens: Token[],
  index: number
): vscode.CompletionItem[] {
  const items = new Map<string, vscode.CompletionItem>();
  const add = (name: string, kind: vscode.CompletionItemKind, detail?: string) => {
    if (!name || items.has(name)) return;
    const item = new vscode.CompletionItem(name, kind);
    if (detail) item.detail = detail;
    items.set(name, item);
  };

  for (const name of collectVariableNames(tokens, 0, Math.max(0, index + 1))) {
    add(name, vscode.CompletionItemKind.Variable, "in scope");
  }
  for (const name of collectGlobalBindings(tokens)) {
    add(name, vscode.CompletionItemKind.Constant, "global");
  }
  for (const name of collectImportedModuleNames(document)) {
    add(name, vscode.CompletionItemKind.Module, "imported module");
  }
  for (const name of FELIDAE_LIBRARY_NAMES.split("|")) {
    add(name, vscode.CompletionItemKind.Module, "core library");
  }
  for (const key of Object.keys(builtinDocs)) {
    if (key.includes(":")) continue;
    add(key, vscode.CompletionItemKind.Function, builtinDocs[key].heading);
  }

  const text = document.getText();
  const classDeclaration = /^class[ \t]+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
  let classMatch: RegExpExecArray | null;
  while ((classMatch = classDeclaration.exec(text)) !== null) {
    add(classMatch[1], vscode.CompletionItemKind.Class, "class");
  }
  const declaration = new RegExp(DECLARATION_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(text)) !== null) {
    const normalized = normalizeGraphName(match[1]);
    if (isLibraryName(normalized)) continue;
    const isMethod = match[4] === "=>";
    add(match[1], isMethod ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Struct, isMethod ? "method" : "fact");
  }

  const cached = symbolSummaryCache.get(document.uri.toString());
  if (cached) {
    for (const method of cached.methods) add(method.name, vscode.CompletionItemKind.Method, "method (felidae)");
    for (const fact of cached.facts) add(fact.name, vscode.CompletionItemKind.Struct, "fact (felidae)");
    for (const global of cached.globals) add(global.name, vscode.CompletionItemKind.Constant, "global (felidae)");
  }

  return [...items.values()];
}

// Shows the expected `key:` parameters while the cursor is inside a call's
// parentheses, highlighting the argument slot being typed. Parameter data
// comes from resolveCall, the same resolver keyword-argument completion uses.
class FelidaeSignatureHelpProvider implements vscode.SignatureHelpProvider {
  provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.SignatureHelp> {
    if (document.languageId !== "felidae") return undefined;

    const tokens = lexDocument(document).tokens;
    const index = tokenIndexBefore(tokens, position);
    const call = enclosingCall(tokens, index);
    if (!call) return undefined;

    const resolved = resolveCall(document, call.name);
    if (!resolved || resolved.params.length === 0) return undefined;

    const parameters = resolved.params.map(
      (param) =>
        new vscode.ParameterInformation(
          param.type ? `${param.name}: ${param.type}` : `${param.name}:`
        )
    );
    const signature = new vscode.SignatureInformation(
      `${resolved.label}(${parameters.map((parameter) => parameter.label).join(", ")})`
    );
    signature.parameters = parameters;
    if (resolved.documentation) signature.documentation = resolved.documentation;

    const { activeParameter, suppliedKeys } = callArgumentState(tokens, call.openParen, index);

    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    // Named arguments may be written in any order, so the slot index only
    // tells us where the cursor is, not which parameter it belongs to. If the
    // argument being typed already names a key, highlight that key; otherwise
    // point at the first parameter still unsupplied, falling back to the slot.
    const typedKey = this.keyBeingTyped(tokens, call.openParen, index);
    const byName = typedKey
      ? resolved.params.findIndex((param) => param.name === typedKey)
      : -1;
    if (byName >= 0) {
      help.activeParameter = byName;
    } else {
      const firstUnsupplied = resolved.params.findIndex(
        (param) => !suppliedKeys.has(param.name)
      );
      help.activeParameter =
        firstUnsupplied >= 0 ? firstUnsupplied : Math.min(activeParameter, parameters.length - 1);
    }
    return help;
  }

  // The key of the argument currently being typed, i.e. the `ident` that
  // starts the slot the cursor is in (`foo(a: 1, bar|` -> "bar").
  private keyBeingTyped(tokens: Token[], openParen: number, index: number): string | undefined {
    let depth = 0;
    let slotStart = openParen + 1;
    for (let i = openParen + 1; i <= index && i < tokens.length; i++) {
      const kind = tokens[i].kind;
      if (kind === "lparen" || kind === "lbrace" || kind === "lbracket") depth++;
      else if (kind === "rparen" || kind === "rbrace" || kind === "rbracket") depth--;
      else if (kind === "comma" && depth === 0) slotStart = i + 1;
    }
    const first = tokens[slotStart];
    return first?.kind === "ident" ? first.text : undefined;
  }
}

class FelidaeCompletionItemProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (document.languageId !== "felidae") return [];
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);

    const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(linePrefix);
    if (dotMatch) {
      const namespaceItems = builtinDocCompletionsForNamespace(dotMatch[1]);
      if (namespaceItems.length) return namespaceItems;
    }

    const lexed = lexDocument(document);
    const tokens = lexed.tokens;
    const index = tokenIndexBefore(tokens, position);
    const items = new Map<string, vscode.CompletionItem>();

    // Keep named-argument completion active while its key is being typed
    // (`call(na|`), not only immediately after `(` or `,`.
    if (/[(,]\s*[A-Za-z_]*$/.test(linePrefix)) {
      const call = enclosingCall(tokens, index);
      if (call) {
        const { suppliedKeys } = callArgumentState(tokens, call.openParen, index);
        const fieldItems = completionsForCallFields(document, call.name, suppliedKeys);
        rankNamedArguments(document, call.name, suppliedKeys, fieldItems);
        for (const item of fieldItems) {
          items.set(item.label as string, item);
        }
      }
    }

    const scopeItems = completionsForScope(document, tokens, index);
    rankScopeCompletions(document, position, scopeItems);
    for (const item of scopeItems) {
      if (!items.has(item.label as string)) items.set(item.label as string, item);
    }

    return [...items.values()];
  }
}

// VS Code orders a completion list by `sortText`, so ranking is applied by
// assigning sort keys rather than by reordering the array. Items keep their
// existing labels/details; only their order changes. When no model is bundled
// (mlRanking finds no resources/models) both helpers no-op and the list stays
// exactly as it was before ranking existed.

function rankByScore(
  items: vscode.CompletionItem[],
  score: (item: vscode.CompletionItem) => number
): void {
  const scored = items.map((item, position) => ({ item, position, score: score(item) }));
  scored.sort((a, b) => b.score - a.score || a.position - b.position);
  scored.forEach((entry, rank) => {
    // Zero-padded so lexicographic sortText matches numeric rank.
    entry.item.sortText = String(rank).padStart(4, "0");
  });
}

function completionKindOf(item: vscode.CompletionItem): ml.CandidateKind {
  switch (item.kind) {
    case vscode.CompletionItemKind.Method:
    case vscode.CompletionItemKind.Function:
      return "method";
    case vscode.CompletionItemKind.Struct:
    case vscode.CompletionItemKind.Class:
      return "fact";
    case vscode.CompletionItemKind.Module:
      return "library";
    case vscode.CompletionItemKind.Field:
      return "param";
    default:
      return "local";
  }
}

function rankScopeCompletions(
  document: vscode.TextDocument,
  position: vscode.Position,
  items: vscode.CompletionItem[]
): void {
  if (!ml.isCompletionRankingEnabled() || items.length < 2) return;
  const line = document.lineAt(position.line).text;
  const prefixMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(line.slice(0, position.character));
  const textAbove = document.getText(
    new vscode.Range(new vscode.Position(0, 0), position)
  );
  const context = ml.buildCompletionContext(textAbove, prefixMatch ? prefixMatch[1] : "");
  rankByScore(items, (item) =>
    ml.scoreCompletion(item.label as string, completionKindOf(item), context)
  );
}

function rankNamedArguments(
  document: vscode.TextDocument,
  callName: string,
  suppliedKeys: ReadonlySet<string>,
  items: vscode.CompletionItem[]
): void {
  if (!ml.isNextParamRankingEnabled() || items.length < 2) return;
  const resolved = resolveCall(document, callName);
  if (!resolved) return;

  const declIndexOf = new Map(resolved.params.map((param, i) => [param.name, i]));
  const firstUnsuppliedIndex = resolved.params.findIndex(
    (param) => !suppliedKeys.has(param.name)
  );
  const context: ml.NextParamContext = {
    paramsTotal: resolved.params.length,
    suppliedCount: suppliedKeys.size,
    firstUnsuppliedIndex,
    isBuiltinCall: builtinDocs[callName.replace(/\./g, ":")] !== undefined
  };
  rankByScore(items, (item) => {
    const name = item.label as string;
    const declIndex = declIndexOf.get(name);
    return declIndex === undefined ? 0 : ml.scoreNextParam(name, declIndex, context);
  });
}

// --------------------------------------------------------------------------
// Symbol occurrences - the primitive behind highlight, find-references and
// rename. Built on lexDocument so occurrences inside strings and comments are
// never matched: those are separate token kinds, so filtering to `ident` is
// enough.
// --------------------------------------------------------------------------

function symbolOccurrences(document: vscode.TextDocument, name: string): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  for (const token of lexDocument(document).tokens) {
    if (token.kind !== "ident" || token.text !== name) continue;
    ranges.push(
      new vscode.Range(
        new vscode.Position(token.line, token.start),
        new vscode.Position(token.line, token.end)
      )
    );
  }
  return ranges;
}

function identifierAt(
  document: vscode.TextDocument,
  position: vscode.Position
): { name: string; range: vscode.Range } | undefined {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (!range) return undefined;
  return { name: document.getText(range), range };
}

/** True when `name` is declared at top level, i.e. visible to other files. */
function isTopLevelSymbol(document: vscode.TextDocument, name: string): boolean {
  const text = document.getText();
  const declaration = new RegExp(DECLARATION_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(text)) !== null) {
    if (match[1] === name || normalizeGraphName(match[1]) === name) return true;
  }
  const binding = new RegExp(GLOBAL_BINDING_PATTERN);
  while ((match = binding.exec(text)) !== null) {
    if (match[1] === name) return true;
  }
  return false;
}

async function felidaeDocuments(): Promise<vscode.TextDocument[]> {
  const uris = await vscode.workspace.findFiles("**/*.fx", "**/node_modules/**", 500);
  const documents: vscode.TextDocument[] = [];
  for (const uri of uris) {
    try {
      documents.push(await vscode.workspace.openTextDocument(uri));
    } catch {
      // Unreadable or binary file: skip rather than fail the whole request.
    }
  }
  return documents;
}

class FelidaeDocumentHighlightProvider implements vscode.DocumentHighlightProvider {
  provideDocumentHighlights(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.DocumentHighlight[]> {
    const found = identifierAt(document, position);
    if (!found) return [];
    return symbolOccurrences(document, found.name).map(
      (range) => new vscode.DocumentHighlight(range, vscode.DocumentHighlightKind.Text)
    );
  }
}

class FelidaeReferenceProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[]> {
    const found = identifierAt(document, position);
    if (!found) return [];

    const locations: vscode.Location[] = symbolOccurrences(document, found.name).map(
      (range) => new vscode.Location(document.uri, range)
    );

    // A local binding or parameter means nothing in another file, so only
    // top-level declarations are worth a workspace-wide scan.
    if (!isTopLevelSymbol(document, found.name)) return locations;

    for (const other of await felidaeDocuments()) {
      if (other.uri.toString() === document.uri.toString()) continue;
      for (const range of symbolOccurrences(other, found.name)) {
        locations.push(new vscode.Location(other.uri, range));
      }
    }
    return locations;
  }
}

class FelidaeRenameProvider implements vscode.RenameProvider {
  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Range> {
    const found = identifierAt(document, position);
    if (!found) throw new Error("Select a Felidae identifier to rename.");
    // Builtins live in the interpreter, not in the user's sources.
    if (builtinDocs[found.name] || isLibraryNamespace(found.name)) {
      throw new Error(`'${found.name}' is a Felidae builtin and cannot be renamed.`);
    }
    return found.range;
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const found = identifierAt(document, position);
    if (!found) return undefined;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
      throw new Error(`'${newName}' is not a valid Felidae identifier.`);
    }

    const edit = new vscode.WorkspaceEdit();
    for (const range of symbolOccurrences(document, found.name)) {
      edit.replace(document.uri, range, newName);
    }

    // Same reasoning as find-references: only a top-level name can be
    // referenced from another file, so only then is a workspace rename
    // correct. Renaming a local everywhere would corrupt unrelated files.
    if (isTopLevelSymbol(document, found.name)) {
      for (const other of await felidaeDocuments()) {
        if (other.uri.toString() === document.uri.toString()) continue;
        for (const range of symbolOccurrences(other, found.name)) {
          edit.replace(other.uri, range, newName);
        }
      }
    }
    return edit;
  }
}

class FelidaeWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  async provideWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    const symbols: vscode.SymbolInformation[] = [];
    const needle = query.toLowerCase();

    for (const document of await felidaeDocuments()) {
      const text = document.getText();
      const declaration = new RegExp(DECLARATION_PATTERN);
      let match: RegExpExecArray | null;
      while ((match = declaration.exec(text)) !== null) {
        const name = match[1];
        if (needle && !name.toLowerCase().includes(needle)) continue;
        const start = document.positionAt(match.index + match[0].indexOf(name));
        symbols.push(
          new vscode.SymbolInformation(
            name,
            match[4] === "=>" ? vscode.SymbolKind.Method : vscode.SymbolKind.Struct,
            "",
            new vscode.Location(document.uri, new vscode.Range(start, start.translate(0, name.length)))
          )
        );
      }
      const binding = new RegExp(GLOBAL_BINDING_PATTERN);
      while ((match = binding.exec(text)) !== null) {
        const name = match[1];
        if (needle && !name.toLowerCase().includes(needle)) continue;
        const start = document.positionAt(match.index);
        symbols.push(
          new vscode.SymbolInformation(
            name,
            vscode.SymbolKind.Constant,
            "",
            new vscode.Location(document.uri, new vscode.Range(start, start.translate(0, name.length)))
          )
        );
      }
    }
    return symbols;
  }
}

// Add the Windows executable suffix only on Windows; never select a foreign
// platform binary merely because its filename happens to exist.
function withPlatformExecutableSuffix(resolved: string): string {
  if (process.platform === "win32" && !path.extname(resolved) && !isExecutableFile(resolved))
    return `${resolved}.exe`;
  return resolved;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// "felidae" is the one interpreter binary this project builds - it reads
// source.fx, parses it to an AST, and executes that AST directly; there is
// no separate compiler or VM binary to run first (see README.md/code.md).
function resolveInterpreterPath(documentUri: vscode.Uri): string {
  const config = vscode.workspace.getConfiguration("felidae", documentUri);
  return resolveReleaseExecutable(
    documentUri,
    workspaceExecutableSetting(documentUri, "interpreterPath") ??
      (config.get<string>("interpreterPath", "") || process.env.FELIDAE_PATH),
    "felidae"
  );
}

type WorkspaceExecutableSetting = "interpreterPath";

interface FelidaeWorkspaceConfig {
  interpreterPath?: unknown;
}

function workspaceExecutableSetting(
  documentUri: vscode.Uri,
  setting: WorkspaceExecutableSetting
): string | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  if (!workspaceFolder) return undefined;

  const configPath = path.join(workspaceFolder.uri.fsPath, ".vscode", "felidae.json");
  if (!fs.existsSync(configPath)) return undefined;

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as FelidaeWorkspaceConfig;
    const value = parsed?.[setting];
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch (error) {
    console.warn(`Felidae: unable to read ${configPath}: ${String(error)}`);
    return undefined;
  }
}

function releaseExecutableCandidates(name: string): string[] {
  const executable = `${name}${process.platform === "win32" ? ".exe" : ""}`;
  if (process.platform === "win32") {
    return [
      `build/windows-x64/release/dist/bin/${executable}`,
      `build/release/dist/bin/${executable}`,
      `dist/bin/${executable}`,
      `release/bin/${executable}`
    ];
  }
  if (process.platform === "darwin") {
    const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
    return [
      `build/macos-${architecture}/release/dist/bin/${executable}`,
      `build/release/dist/bin/${executable}`,
      `dist/bin/${executable}`,
      `release/bin/${executable}`
    ];
  }
  return [
    `build/release/dist/bin/${executable}`,
    `dist/bin/${executable}`,
    `release/bin/${executable}`
  ];
}

function resolveReleaseExecutable(documentUri: vscode.Uri, configuredPath: string | undefined, name: string): string {
  if (configuredPath?.trim()) {
    const configured = configuredPath.trim();
    const local = withPlatformExecutableSuffix(resolveConfiguredPath(documentUri, configured));
    if (isExecutableFile(local) || /[/\\]/.test(configured)) return local;
    const executable = withPlatformExecutableSuffix(configured);
    return (process.env.PATH || "").split(path.delimiter).filter(Boolean)
      .map(directory => path.resolve(directory, executable)).find(isExecutableFile) || local;
  }
  const candidates = releaseExecutableCandidates(name)
    .map((candidate) => resolveConfiguredPath(documentUri, candidate));
  const executable = `${name}${process.platform === "win32" ? ".exe" : ""}`;
  candidates.push(...(process.env.PATH || "").split(path.delimiter).filter(Boolean)
    .map(directory => path.resolve(directory, executable)));
  return candidates.find(isExecutableFile) ?? candidates[0];
}

function resolveToolingPath(documentUri: vscode.Uri): string {
  return resolveInterpreterPath(documentUri);
}

function resolveConfiguredPath(documentUri: vscode.Uri, configuredPath: string): string {
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  if (workspaceFolder) {
    return path.join(workspaceFolder.uri.fsPath, configuredPath);
  }

  return configuredPath;
}

async function ensureInterpreterInstalled(
  interpreterPath: string,
  label: string,
  settingsQuery: "felidae.interpreterPath" = "felidae.interpreterPath"
): Promise<boolean> {
  if (isExecutableFile(interpreterPath)) return true;
  const downloadLabel = "Download Felidae";
  const choice = await vscode.window.showWarningMessage(
    `${label} is missing or is not executable: ${interpreterPath}`,
    downloadLabel,
    "Open Settings"
  );
  if (choice === downloadLabel) {
    await vscode.env.openExternal(vscode.Uri.parse("https://github.com/xnvtserver/Felidae/releases"));
  } else if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", settingsQuery);
  }
  return false;
}

interface FelidaeSymbolDefinition {
  name: string;
  count: number;
  spans: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number }>;
  // Declared head parameters, added by felidae --symbols-json. Optional
  // because an older build of that binary simply omits the field.
  params?: FelidaeParam[];
}

interface FelidaeSymbolSummary {
  methods: FelidaeSymbolDefinition[];
  facts: FelidaeSymbolDefinition[];
  globals: FelidaeSymbolDefinition[];
  files: string[];
  unresolvedImports: string[];
}

// Best-effort cache of `felidae <file> --symbols-json --load-imports`
// results, keyed by document URI. Populated in the background on the same
// debounce cycle as diagnostics; completion reads it synchronously and falls
// back to text-scanning when no entry exists yet (e.g. right after opening a
// file, or against a felidae build too old to support the flag).
const symbolSummaryCache = new Map<string, FelidaeSymbolSummary>();

function refreshSymbolCache(document: vscode.TextDocument): void {
  if (document.uri.scheme !== "file" || document.languageId !== "felidae") return;
  const interpreterPath = resolveToolingPath(document.uri);
  if (!isExecutableFile(interpreterPath)) return;
  childProcess.execFile(
    interpreterPath,
    [document.uri.fsPath, "--symbols-json", "--load-imports"],
    { cwd: path.dirname(document.uri.fsPath), windowsHide: true, timeout: 10000 },
    (error, stdout) => {
      if (error) return;
      try {
        const parsed = JSON.parse(stdout.trim()) as FelidaeSymbolSummary;
        if (parsed && Array.isArray(parsed.methods) && Array.isArray(parsed.facts)) {
          symbolSummaryCache.set(document.uri.toString(), parsed);
        }
      } catch {
        // Older felidae builds without --symbols-json, or a transient
        // parse failure mid-edit. Completion silently keeps using text scans.
      }
    }
  );
}

function runtimeCheckDiagnostics(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
  return new Promise((resolve) => {
    if (document.uri.scheme !== "file") {
      resolve([]);
      return;
    }
    const interpreterPath = resolveToolingPath(document.uri);
    if (!isExecutableFile(interpreterPath)) {
      const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1));
      resolve([new vscode.Diagnostic(
        range,
        `Felidae interpreter not found: ${interpreterPath}. Parser and AST validation via --check-json is disabled.`,
        vscode.DiagnosticSeverity.Warning
      )]);
      return;
    }
    childProcess.execFile(
      interpreterPath,
      [document.uri.fsPath, "--check-json"],
      { cwd: path.dirname(document.uri.fsPath), windowsHide: true, timeout: 15000 },
      (error, stdout, stderr) => {
        const jsonDiagnostics = parseRuntimeJsonDiagnostics(document, stdout);
        if (jsonDiagnostics) {
          resolve(jsonDiagnostics);
          return;
        }
        const analyzerDiagnostics = parseRuntimeAnalyzerDiagnostics(document, stdout);
        if (!error && stdout.includes("FELIDAE_CHECK_OK")) {
          resolve(analyzerDiagnostics);
          return;
        }
        const text = stderr.trim() || error?.message || "Felidae check failed.";
        const { message, severity } = formatRuntimeCheckMessage(text);
        const lineMatch = / at (\d+):(\d+)/.exec(message);
        const line = lineMatch ? Math.max(0, Number(lineMatch[1]) - 1) : 0;
        const column = lineMatch ? Math.max(0, Number(lineMatch[2]) - 1) : 0;
        const range = new vscode.Range(
          new vscode.Position(line, column),
          new vscode.Position(line, column + 1)
        );
        resolve([...analyzerDiagnostics, new vscode.Diagnostic(range, message, severity)]);
      }
    );
  });
}

function parseRuntimeJsonDiagnostics(document: vscode.TextDocument, stdout: string): vscode.Diagnostic[] | undefined {
  const text = stdout.trim();
  if (!text.startsWith("{")) return undefined;

  try {
    const payload = JSON.parse(text) as {
      diagnostics?: Array<{
        severity?: string;
        line?: number;
        column?: number;
        message?: string;
      }>;
    };
    if (!Array.isArray(payload.diagnostics)) return undefined;

    return payload.diagnostics
      .filter((item) => typeof item.message === "string" && item.message.trim().length > 0)
      .map((item) => {
        const sourceLine = Math.max(0, Number(item.line ?? 1) - 1);
        const sourceColumn = Math.max(0, Number(item.column ?? 1) - 1);
        const boundedLine = Math.min(sourceLine, Math.max(0, document.lineCount - 1));
        const lineText = document.lineAt(boundedLine).text;
        const boundedColumn = Math.min(sourceColumn, lineText.length);
        const severity = item.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : item.severity === "info"
            ? vscode.DiagnosticSeverity.Information
            : item.severity === "hint"
              ? vscode.DiagnosticSeverity.Hint
              : vscode.DiagnosticSeverity.Warning;
        return new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(boundedLine, boundedColumn),
            new vscode.Position(boundedLine, Math.min(boundedColumn + 1, lineText.length))
          ),
          item.message ?? "Felidae AST diagnostic",
          severity
        );
      });
  } catch {
    return undefined;
  }
}

function parseRuntimeAnalyzerDiagnostics(document: vscode.TextDocument, stdout: string): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("FELIDAE_DIAGNOSTIC ")) continue;
    const severityMatch = /\bseverity=(error|warning|info|hint)\b/.exec(line);
    const lineMatch = /\bline=(\d+)\b/.exec(line);
    const columnMatch = /\bcolumn=(\d+)\b/.exec(line);
    const messageMatch = /\bmessage=(.*)$/.exec(line);
    const message = messageMatch?.[1]?.trim();
    if (!message) continue;

    const sourceLine = Math.max(0, Number(lineMatch?.[1] ?? "1") - 1);
    const sourceColumn = Math.max(0, Number(columnMatch?.[1] ?? "1") - 1);
    const boundedLine = Math.min(sourceLine, Math.max(0, document.lineCount - 1));
    const boundedColumn = Math.min(sourceColumn, document.lineAt(boundedLine).text.length);
    const severity = severityMatch?.[1] === "error"
      ? vscode.DiagnosticSeverity.Error
      : severityMatch?.[1] === "info"
        ? vscode.DiagnosticSeverity.Information
        : severityMatch?.[1] === "hint"
          ? vscode.DiagnosticSeverity.Hint
          : vscode.DiagnosticSeverity.Warning;
    diagnostics.push(new vscode.Diagnostic(
      new vscode.Range(
        new vscode.Position(boundedLine, boundedColumn),
        new vscode.Position(boundedLine, Math.min(boundedColumn + 1, document.lineAt(boundedLine).text.length))
      ),
      message,
      severity
    ));
  }
  return diagnostics;
}

function formatRuntimeCheckMessage(text: string): { message: string; severity: vscode.DiagnosticSeverity } {
  const raw = text.trim();
  const severity = /^warning:/i.test(raw) ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
  let message = raw.replace(/^(error|warning):\s*/i, "");

  const factIteration = /^Fact type '([^']+)' is not implicitly iterable/.exec(message);
  if (factIteration) {
    const name = factIteration[1];
    message = `Fact type '${name}' is not implicitly iterable here. Direct ${name}(...) declarations and named queries are supported, but ${name}(item) in a method body does not scan facts. Use lambda(${name}, item => ...) or iterate an explicit list/array.`;
  } else if (/^Module '.*' not found/.test(message)) {
    message = `${message}. Check the import path, native module name, or workspace-relative Felidae configuration.`;
  } else if (/expects argument/.test(message)) {
    message = `${message}. This was reported by felidae --check-json during parser and AST validation.`;
  } else if (/Unknown field/.test(message)) {
    message = `${message}. Named fact calls must match the declared fact fields.`;
  }

  return { message, severity };
}

class FelidaeCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      const notIterable = /^Fact type '([^']+)' is not implicitly iterable/.exec(diagnostic.message);
      if (!notIterable) continue;
      const factName = notIterable[1];
      const line = diagnostic.range.start.line;
      const lineText = document.lineAt(line).text;
      const callPattern = new RegExp(
        `\\b${factName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\)`
      );
      const callMatch = callPattern.exec(lineText);
      if (!callMatch) continue;

      const itemName = callMatch[1];
      const startChar = callMatch.index;
      const endChar = callMatch.index + callMatch[0].length;
      const replacement = `lambda(${factName}, ${itemName} => ${itemName})`;

      const action = new vscode.CodeAction(
        `Rewrite as lambda(${factName}, ${itemName} => ...)`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(
        document.uri,
        new vscode.Range(new vscode.Position(line, startChar), new vscode.Position(line, endChar)),
        replacement
      );
      actions.push(action);
    }
    return actions;
  }
}

async function getFelidaeDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.languageId === "felidae") {
      return document;
    }
  }

  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === "felidae") {
    return editor.document;
  }

  return undefined;
}

async function runQuery(uri?: vscode.Uri): Promise<void> {
  const document = await getFelidaeDocument(uri);
  if (!document) {
    vscode.window.showWarningMessage("Open a Felidae .fx file before running a query.");
    return;
  }

  if (document.isDirty) {
    await document.save();
  }

  const config = vscode.workspace.getConfiguration("felidae");
  const defaultQuery = config.get<string>("defaultQuery", "? Engineer(name: name)");
  const editor = vscode.window.activeTextEditor;
  const selectedText = editor?.document.uri.toString() === document.uri.toString()
    ? editor.document.getText(editor.selection).trim()
    : "";
  const query = await vscode.window.showInputBox({
    title: "Run Felidae Query",
    prompt: "Enter a query for the current Felidae file.",
    value: selectedText || defaultQuery
  });

  if (!query) {
    return;
  }

  const interpreterPath = resolveInterpreterPath(document.uri);
  const programPath = document.uri.fsPath;
  const installed = await ensureInterpreterInstalled(interpreterPath, "Felidae interpreter");
  if (!installed) return;
  const normalizedQuery = query.trim().startsWith("?") ? query.trim() : `? ${query.trim()}`;
  runInTerminal(interpreterPath, [programPath, normalizedQuery], path.dirname(programPath));
}

// A `main` *declaration*, which like every Felidae declaration sits at column
// 0 and is followed by `=>`. Anchoring matters: `^\s*` also matched an
// indented `main(...)` call inside another method's body, which made Run and
// Debug appear for files that have no entry point to run.
const MAIN_DECLARATION_PATTERN = /^main[ \t]*\([^)]*\)[ \t]*=>/m;

function hasMainMethod(document: vscode.TextDocument): boolean {
  return MAIN_DECLARATION_PATTERN.test(document.getText());
}

async function runMain(uri?: vscode.Uri): Promise<void> {
  const document = await getFelidaeDocument(uri);
  if (!document) {
    vscode.window.showWarningMessage("Open a Felidae .fx file before running main.");
    return;
  }

  if (!hasMainMethod(document)) {
    vscode.window.showWarningMessage("This Felidae file does not define main(...).");
    return;
  }

  if (document.isDirty) {
    await document.save();
  }

  const interpreterPath = resolveInterpreterPath(document.uri);
  const programPath = document.uri.fsPath;
  const installed = await ensureInterpreterInstalled(interpreterPath, "Felidae interpreter");
  if (!installed) return;
  runInTerminal(interpreterPath, [programPath], path.dirname(programPath));
}

async function debugMain(uri?: vscode.Uri): Promise<void> {
  const document = await getFelidaeDocument(uri);
  if (!document) {
    vscode.window.showWarningMessage("Open a Felidae .fx file before debugging main.");
    return;
  }

  if (!hasMainMethod(document)) {
    vscode.window.showWarningMessage("This Felidae file does not define main(...).");
    return;
  }

  if (document.isDirty) {
    await document.save();
  }

  // The real debug session (Interpreter::setGoalHook, driven via `felidae
  // program.fx --debug`) runs in the interpreter itself, which also owns the
  // diagnostics and language-server tooling modes.
  const interpreterPath = resolveInterpreterPath(document.uri);
  const installed = await ensureInterpreterInstalled(interpreterPath, "Felidae interpreter");
  if (!installed) return;

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  await vscode.debug.startDebugging(workspaceFolder, {
    type: "felidae",
    request: "launch",
    name: "Debug Felidae Main",
    program: document.uri.fsPath,
    interpreterPath,
    stopOnEntry: true
  });
}

// Drives Interpreter::setGoalHook's real debug protocol (`felidae program.fx
// --debug`, src/main.cpp's DebugSession) over the child process's
// stdin/stdout - not a simulation. Every "stopped" event, stack line, and
// local variable value below comes from that child actually pausing and
// reporting its live Env, the same way `felidae --debug` behaves when driven
// by hand (see the FELIDAE_DEBUG_* marker protocol documented in main.cpp).
class FelidaeDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  private static readonly localVariablesReference = 1;
  private process?: childProcess.ChildProcessWithoutNullStreams;
  private currentProgram?: string;
  private currentLine = 1;
  private stdoutBuffer = "";
  private breakpoints = new Set<number>();
  private locals: Array<{ name: string, value: string }> = [];
  // Resolved from handleDebugLine once the child's next FELIDAE_DEBUG_STOPPED
  // (or process exit) arrives. Every step/continue/launch request awaits
  // this instead of replying immediately, so the "stopped" event (and the
  // stackTrace/variables requests VS Code sends right after it) reflect the
  // interpreter's real, current pause rather than a guess made before the
  // child actually got there.
  private pendingStop?: () => void;
  private finishConfiguration!: () => void;
  private readonly configurationDone = new Promise<void>((resolve) => { this.finishConfiguration = resolve; });
  private pendingLocals?: { resolve: () => void };
  readonly onDidSendMessage = this.emitter.event;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const request = message as DapRequest;
    if (request.type !== "request") {
      return;
    }

    if (request.command === "initialize") {
      this.sendResponse(request, {
        supportsEvaluateForHovers: true,
        supportsEvaluateForRepl: true,
        supportsConfigurationDoneRequest: true,
        supportsSetBreakpointsRequest: true,
        supportsTerminateRequest: true
      });
      this.sendEvent("initialized");
      return;
    }

    if (request.command === "configurationDone") {
      this.finishConfiguration();
      this.sendResponse(request);
      return;
    }

    if (request.command === "launch") {
      void this.launch(request);
      return;
    }

    if (request.command === "threads") {
      this.sendResponse(request, { threads: [{ id: 1, name: "Felidae" }] });
      return;
    }

    if (request.command === "stackTrace") {
      const source = this.currentProgram ? {
        name: path.basename(this.currentProgram),
        path: this.currentProgram
      } : undefined;
      // One real frame: the interpreter's stdin/stdout protocol reports the
      // current paused line, not a full call stack (Interpreter::solveIterative
      // doesn't yet publish per-call-frame names alongside method depth).
      this.sendResponse(request, {
        stackFrames: [{ id: 1, name: "Felidae program", source, line: this.currentLine, column: 1 }],
        totalFrames: 1
      });
      return;
    }

    if (request.command === "scopes") {
      this.sendResponse(request, {
        scopes: [{
          name: "Locals",
          variablesReference: FelidaeDebugAdapter.localVariablesReference,
          expensive: false
        }]
      });
      return;
    }

    if (request.command === "variables") {
      const args = (request.arguments ?? {}) as { variablesReference?: number };
      const variables = args.variablesReference === FelidaeDebugAdapter.localVariablesReference
        ? this.locals.map((variable) => ({ ...variable, variablesReference: 0 }))
        : [];
      this.sendResponse(request, { variables });
      return;
    }

    if (request.command === "evaluate") {
      void this.evaluate(request);
      return;
    }

    if (request.command === "setBreakpoints") {
      this.setBreakpoints(request);
      return;
    }

    if (request.command === "next" || request.command === "stepIn" || request.command === "stepOut") {
      void this.step(request, request.command);
      return;
    }

    if (request.command === "pause") {
      // The real protocol only pauses at a breakpoint or step target it
      // reaches on its own; there is no async "stop wherever you currently
      // are" command to send it, so reporting a fake stop here would show a
      // line the interpreter was never actually paused at.
      this.sendResponse(request, undefined, false, "Pause is not supported; set a breakpoint instead.");
      return;
    }

    if (request.command === "continue") {
      void this.continueExecution(request);
      return;
    }

    if (request.command === "disconnect" || request.command === "terminate") {
      this.process?.stdin.write("terminate\n");
      this.process?.kill();
      this.sendResponse(request);
      this.sendEvent("terminated");
      return;
    }

    this.sendResponse(request);
  }

  dispose(): void {
    this.process?.kill();
    this.emitter.dispose();
  }

  private async launch(request: DapRequest): Promise<void> {
    const args = (request.arguments ?? {}) as Record<string, unknown>;
    const interpreterPath = typeof args.interpreterPath === "string" ? args.interpreterPath : undefined;
    const program = typeof args.program === "string" ? args.program : undefined;
    const query = typeof args.query === "string" ? args.query : undefined;

    if (!interpreterPath || !program) {
      this.sendResponse(request, undefined, false, "Debug configuration requires interpreterPath and program.");
      this.sendEvent("terminated");
      return;
    }

    // --debug installs the goal hook regardless of what runs afterward, so
    // it composes with a query the same as with main(...): confirmed against
    // the real interpreter, `felidae program.fx '? Query(...)' --debug`
    // stops on entry and then reports the query's solutions once continued.
    const launchArgs = query ? [program, query, "--debug"] : [program, "--debug"];
    this.currentProgram = program;
    this.currentLine = 1;
    this.stdoutBuffer = "";
    this.sendOutput(`Felidae debugger launch\n${interpreterPath} ${launchArgs.join(" ")}\n`, "console");
    this.process = childProcess.spawn(interpreterPath, launchArgs, {
      cwd: path.dirname(program),
      windowsHide: true
    });

    this.process.stdout.on("data", (data: Buffer) => this.handleDebugStdout(data.toString()));
    this.process.stderr.on("data", (data: Buffer) => this.sendOutput(data.toString(), "stderr"));
    this.process.on("error", (error: Error) => {
      this.sendOutput(`${error.message}\n`, "stderr");
      this.process = undefined;
      this.finishConfiguration();
      this.resolvePendingStop();
      this.sendEvent("terminated");
    });
    this.process.on("close", (code: number | null) => {
      this.flushDebugStdout();
      this.sendOutput(`Felidae process exited with code ${code ?? "unknown"}.\n`, "console");
      this.process = undefined;
      this.finishConfiguration();
      this.resolvePendingStop();
      this.sendEvent("terminated");
    });

    // The interpreter always starts paused on entry (DebugSession::attach);
    // wait for that first real stop before replying, so the very first
    // "stopped" event corresponds to a line the child actually reported.
    await this.waitForStop();
    await this.configurationDone;
    if (!this.process) {
      this.sendResponse(request, undefined, false, "Interpreter exited before debugger startup completed. See Debug Console.");
      return;
    }
    for (const line of this.breakpoints) this.process.stdin.write(`break ${line}\n`);
    this.sendResponse(request);
    if (args.stopOnEntry === false) {
      const stopped = this.waitForStop();
      this.process.stdin.write("continue\n");
      this.sendEvent("continued", { threadId: 1, allThreadsContinued: true });
      await stopped;
      if (this.process) this.sendEvent("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
    } else {
      this.sendEvent("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
    }
  }

  private waitForStop(): Promise<void> {
    return new Promise((resolve) => { this.pendingStop = resolve; });
  }

  private resolvePendingStop(): void {
    const resolve = this.pendingStop;
    this.pendingStop = undefined;
    resolve?.();
  }

  private setBreakpoints(request: DapRequest): void {
    const args = (request.arguments ?? {}) as { breakpoints?: Array<{ line: number }> };
    const requested = new Set((args.breakpoints ?? []).map((breakpoint) => breakpoint.line));
    for (const line of requested) {
      if (!this.breakpoints.has(line)) this.process?.stdin.write(`break ${line}\n`);
    }
    for (const line of this.breakpoints) {
      if (!requested.has(line)) this.process?.stdin.write(`clear ${line}\n`);
    }
    this.breakpoints = requested;
    // Reported verified without a round-trip confirmation from the child
    // (the protocol has no "is this line executable" query yet) - optimistic,
    // like most debug adapters default to when a line's executability isn't
    // independently known ahead of time.
    this.sendResponse(request, {
      breakpoints: (args.breakpoints ?? []).map((breakpoint) => ({ verified: true, line: breakpoint.line }))
    });
  }

  private async step(request: DapRequest, command: "next" | "stepIn" | "stepOut"): Promise<void> {
    if (!this.process) {
      this.sendResponse(request, undefined, false, "No active Felidae debug session.");
      return;
    }
    const stopped = this.waitForStop();
    this.process.stdin.write(`${command}\n`);
    this.sendResponse(request);
    await stopped;
    if (this.process) this.sendEvent("stopped", { reason: "step", threadId: 1, allThreadsStopped: true });
  }

  private async continueExecution(request: DapRequest): Promise<void> {
    if (!this.process) {
      this.sendResponse(request, undefined, false, "No active Felidae debug session.");
      return;
    }
    const stopped = this.waitForStop();
    this.process.stdin.write("continue\n");
    this.sendResponse(request, { allThreadsContinued: true });
    this.sendEvent("continued", { threadId: 1, allThreadsContinued: true });
    await stopped;
    // A run that finishes rather than hitting another breakpoint resolves
    // this same promise from the "close" handler, with "terminated" already
    // sent and no further stop to report.
    if (this.process) this.sendEvent("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
  }

  private async evaluate(request: DapRequest): Promise<void> {
    const args = (request.arguments ?? {}) as { expression?: string };
    // The native protocol exposes bound names, not arbitrary expressions.
    const expression = (args.expression ?? "").trim();
    if (!expression) {
      this.sendResponse(request, { result: "", variablesReference: 0 });
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) {
      this.sendResponse(request, undefined, false, "Enter a variable name. Use Run Query for fact queries.");
      return;
    }
    // Locals are refreshed before each stopped event. Reading that snapshot
    // also supports simultaneous hover/watch requests without stdin races.
    const value = this.locals.find((local) => local.name === expression)?.value;
    this.sendResponse(request, { result: value ?? "<unbound>", variablesReference: 0 });
  }

  private refreshLocals(): Promise<void> {
    return new Promise((resolve) => {
      this.pendingLocals = { resolve };
      this.process?.stdin.write("locals\n");
    });
  }

  private handleDebugStdout(text: string): void {
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.handleDebugLine(line);
    }
  }

  private flushDebugStdout(): void {
    if (!this.stdoutBuffer) return;
    this.handleDebugLine(this.stdoutBuffer);
    this.stdoutBuffer = "";
  }

  private handleDebugLine(line: string): void {
    if (!line) return;
    const stopped = /^FELIDAE_DEBUG_STOPPED reason=(\S+) line=(\d+)/.exec(line);
    if (stopped) {
      this.currentLine = Number(stopped[2]);
      // Refresh locals before resolving the pause: `variables` fires right
      // after "stopped", so it must already have this stop's real bindings
      // rather than the previous pause's.
      void this.refreshLocals().then(() => this.resolvePendingStop());
      return;
    }
    if (line === "FELIDAE_DEBUG_CONTINUED" ||
        line === "FELIDAE_DEBUG_TERMINATED" ||
        line.startsWith("FELIDAE_DEBUG_BREAKPOINT_") ||
        line.startsWith("FELIDAE_DEBUG_ERROR")) {
      return;
    }
    if (line === "FELIDAE_DEBUG_LOCALS_BEGIN") {
      this.locals = [];
      return;
    }
    if (line === "FELIDAE_DEBUG_LOCALS_END") {
      this.pendingLocals?.resolve();
      this.pendingLocals = undefined;
      return;
    }
    if (this.pendingLocals) {
      const bound = /^(\S+) = (.*)$/.exec(line);
      if (bound) this.locals.push({ name: bound[1], value: bound[2] });
      return;
    }
    const value = /^FELIDAE_DEBUG_VALUE (\S+) = (.*)$/.exec(line);
    if (value) {
      return;
    }
    this.sendOutput(`${line}\n`, "stdout");
  }

  private sendResponse(request: DapRequest, body?: unknown, success = true, message?: string): void {
    this.emitter.fire({
      type: "response",
      seq: 0,
      request_seq: request.seq ?? 0,
      command: request.command,
      success,
      message,
      body
    } as vscode.DebugProtocolMessage);
  }

  private sendEvent(event: string, body?: unknown): void {
    this.emitter.fire({ type: "event", seq: 0, event, body } as vscode.DebugProtocolMessage);
  }

  private sendOutput(output: string, category: "console" | "stdout" | "stderr"): void {
    this.sendEvent("output", { category, output });
  }
}

class FelidaeDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new FelidaeDebugAdapter());
  }
}

class FelidaeDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.ProviderResult<vscode.DebugConfiguration> {
    const editor = vscode.window.activeTextEditor;
    const activeDocument = editor?.document.languageId === "felidae" ? editor.document : undefined;
    const workspacePath = folder?.uri.fsPath;

    config.type ??= "felidae";
    config.name ??= "Debug Felidae Query";
    config.request ??= "launch";
    config.program ??= activeDocument?.uri.fsPath ?? "${file}";
    const anchor = typeof config.program === "string" && path.isAbsolute(config.program)
      ? vscode.Uri.file(config.program)
      : folder?.uri ?? activeDocument?.uri ?? vscode.Uri.file(workspacePath ?? "");
    if (!config.interpreterPath?.trim()) config.interpreterPath = resolveInterpreterPath(anchor);
    else if (!config.interpreterPath.includes("${"))
      config.interpreterPath = resolveReleaseExecutable(anchor, config.interpreterPath, "felidae");
    config.stopOnEntry ??= true;
    return config;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Ranking models are optional: if resources/models is absent the scorers
  // report themselves disabled and completion behaves exactly as before.
  ml.loadModels(context.extensionPath);

  const diagnostics = vscode.languages.createDiagnosticCollection("felidae");

  // Start felidae --lsp if it is available. Everything below keeps
  // working when it is not; the client only takes over diagnostics, document
  // symbols and go-to-definition, which it computes from the real parse.
  const serverOutput = vscode.window.createOutputChannel("Felidae Language Server");
  context.subscriptions.push(serverOutput);
  // resolveDebugInterpreterPath resolves a configured relative path against
  // the file's workspace folder, so give it whatever anchor exists.
  const serverAnchor =
    vscode.window.activeTextEditor?.document.uri ??
    vscode.workspace.workspaceFolders?.[0]?.uri ??
    vscode.Uri.file(process.cwd());
  const serverPath = resolveToolingPath(serverAnchor);
  void languageClient.start(serverPath, serverOutput).then((started: boolean) => {
    if (!started) return;
    // The server's diagnostics supersede any the fallback path already
    // published for files opened before it finished starting.
    diagnostics.clear();
  });
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DIAGNOSTICS_DEBOUNCE_MS = 350;

  const refreshDiagnostics = (document: vscode.TextDocument, fromEdit = false): void => {
    if (document.languageId !== "felidae") return;
    // When the language server is running it publishes diagnostics itself,
    // over one long-lived connection. Spawning felidae again per edit
    // would duplicate every message and undo the reason for having a server.
    if (!languageClient.isRunning()) {
      const version = document.version;
      diagnostics.set(document.uri, []);
      void runtimeCheckDiagnostics(document).then((runtimeDiagnostics) => {
        if (document.isClosed || document.version !== version) return;
        diagnostics.set(document.uri, runtimeDiagnostics);
      });
    }
    // The symbol cache backs signature help with real parameter types. It is
    // another felidae spawn, so with the server running it refreshes on
    // open/save rather than on every edit - otherwise the per-keystroke
    // process cost the server was meant to remove just moves here. Signatures
    // change rarely, and resolveCall falls back to a text scan meanwhile.
    if (!(fromEdit && languageClient.isRunning())) {
      refreshSymbolCache(document);
    }
  };

  const scheduleDiagnosticsRefresh = (document: vscode.TextDocument): void => {
    if (document.languageId !== "felidae") return;
    const key = document.uri.toString();
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        refreshDiagnostics(document, true);
      }, DIAGNOSTICS_DEBOUNCE_MS)
    );
  };

  const refreshMainContext = (): void => {
    const document = vscode.window.activeTextEditor?.document;
    const enabled = !!document && document.languageId === "felidae" && hasMainMethod(document);
    void vscode.commands.executeCommand("setContext", "felidaeHasMain", enabled);
  };

  for (const document of vscode.workspace.textDocuments) {
    refreshDiagnostics(document);
  }
  refreshMainContext();

  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand("felidae.runMain", runMain),
    vscode.commands.registerCommand("felidae.debugMain", debugMain),
    vscode.commands.registerCommand("felidae.runQuery", runQuery),
    vscode.commands.registerCommand("felidae.formatDocument", () => vscode.commands.executeCommand("editor.action.formatDocument")),
    vscode.workspace.onDidOpenTextDocument((document) => {
      refreshDiagnostics(document);
      refreshMainContext();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      scheduleDiagnosticsRefresh(event.document);
      refreshMainContext();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      refreshDiagnostics(document);
      refreshMainContext();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      symbolSummaryCache.delete(document.uri.toString());
      const key = document.uri.toString();
      const timer = debounceTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(key);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) refreshDiagnostics(editor.document);
      refreshMainContext();
    }),
    vscode.languages.registerDocumentLinkProvider({ language: "felidae" }, new FelidaeDocumentLinkProvider()),
    vscode.languages.registerHoverProvider({ language: "felidae" }, new FelidaeHoverProvider()),
    vscode.languages.registerDefinitionProvider({ language: "felidae" }, new FelidaeDefinitionProvider()),
    vscode.languages.registerFoldingRangeProvider({ language: "felidae" }, new FelidaeFoldingRangeProvider()),
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", language: "felidae" },
      new FelidaeCodeLensProvider()
    ),
    vscode.languages.registerDocumentSemanticTokensProvider({ language: "felidae" }, new FelidaeSemanticTokensProvider(), semanticLegend),
    vscode.languages.registerDocumentSymbolProvider({ language: "felidae" }, new FelidaeDocumentSymbolProvider()),
    vscode.languages.registerCompletionItemProvider(
      { language: "felidae" },
      new FelidaeCompletionItemProvider(),
      ".", "(", ","
    ),
    vscode.languages.registerSignatureHelpProvider(
      { language: "felidae" },
      new FelidaeSignatureHelpProvider(),
      { triggerCharacters: ["("], retriggerCharacters: [",", ":"] }
    ),
    vscode.languages.registerCodeActionsProvider(
      { language: "felidae" },
      new FelidaeCodeActionProvider(),
      { providedCodeActionKinds: FelidaeCodeActionProvider.providedCodeActionKinds }
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      { language: "felidae" },
      new FelidaeDocumentFormattingEditProvider()
    ),
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      { language: "felidae" },
      new FelidaeDocumentRangeFormattingEditProvider()
    ),
    vscode.languages.registerDocumentHighlightProvider(
      { language: "felidae" },
      new FelidaeDocumentHighlightProvider()
    ),
    vscode.languages.registerReferenceProvider(
      { language: "felidae" },
      new FelidaeReferenceProvider()
    ),
    vscode.languages.registerRenameProvider(
      { language: "felidae" },
      new FelidaeRenameProvider()
    ),
    vscode.languages.registerWorkspaceSymbolProvider(new FelidaeWorkspaceSymbolProvider()),
    vscode.debug.registerDebugConfigurationProvider("felidae", new FelidaeDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory("felidae", new FelidaeDebugAdapterFactory())
  );
}

export function deactivate(): Thenable<void> {
  // Returned so VS Code waits for the server process to exit instead of
  // leaving an orphaned felidae process behind on reload.
  return languageClient.stop();
}
