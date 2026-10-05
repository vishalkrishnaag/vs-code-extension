import * as vscode from "vscode";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  FelidaeDocumentFormattingEditProvider,
  FelidaeDocumentRangeFormattingEditProvider
} from "./formatter";
import * as ml from "./mlRanking";
import { registerCells } from "./cellUi";

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

const semanticLegend = new vscode.SemanticTokensLegend(
  ["variable", "method", "felidaeDefBinding", "felidaeDefFunction", "felidaeDefFact"],
  ["readonly"]
);

// Language keywords: never variables, never declaration names.
const FELIDAE_KEYWORDS = new Set([
  "def", "class", "extend", "extends", "index", "where", "if", "else", "then", "end",
  "for", "in", "while", "switch", "case", "default", "break", "continue",
  "try", "catch", "new", "this", "super", "lambda", "nil", "true", "false"
]);

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

// The "Felidae" output channel: interpreter discovery, every diagnostics
// check (timing, exit code, stderr, counts), run and debug launches, and the
// debug adapter's lifecycle. Levels follow VS Code's per-channel log level
// (Developer: Set Log Level...), so "trace" shows the raw debug protocol.
let outputChannel: vscode.LogOutputChannel | undefined;

function log(level: "trace" | "debug" | "info" | "warn" | "error", message: string): void {
  outputChannel?.[level](message);
}

function runInTerminal(executablePath: string, args: string[], cwd: string): void {
  log("info", "run: " + [executablePath, ...args].join(" ") + " (cwd " + cwd + ")");
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

// Every provider asks for the tokens of the same document; lexing is the
// expensive part, so each (document, version) is lexed once and shared.
const lexCache = new WeakMap<vscode.TextDocument, { version: number; result: LexResult }>();

function lexDocument(document: vscode.TextDocument): LexResult {
  if (typeof document.version !== "number") return lexDocumentUncached(document);
  const cached = lexCache.get(document);
  if (cached && cached.version === document.version) return cached.result;
  const result = lexDocumentUncached(document);
  lexCache.set(document, { version: document.version, result });
  return result;
}

function lexDocumentUncached(document: vscode.TextDocument): LexResult {
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

function collectGlobalBindings(tokens: Token[]): Set<string> {
  const globals = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i].kind === "ident" && tokens[i + 1]?.kind === "bind") {
      globals.add(tokens[i].text);
    }
  }
  return globals;
}

function collectVariableNames(tokens: Token[], start: number, end: number): Set<string> {
  const vars = new Set<string>();
  for (let i = start; i < end; i++) {
    const token = tokens[i];
    if (token.kind !== "ident") continue;
    if (token.text === "_") continue;
    if (FELIDAE_KEYWORDS.has(token.text)) continue;

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
  // A function/method declaration line always starts with the mandatory
  // `def` keyword now (a bare fact never has one, and never has `extend`
  // followed by `(` either, so `def` is optional here without making this
  // match a fact by that name too eagerly). Only `class Name` itself has no
  // `def` prefix to allow for.
  return new RegExp(`^(?:(?:def\\s+)?${qualifiedName}(?:\\s+extend\\s+[A-Za-z_][A-Za-z0-9_]*)?\\s*\\(|class\\s+${qualifiedName}\\b)`);
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
    // Builtins resolve to their shipped core source; project declarations use
    // a conservative workspace scan until check-json grows cross-file
    // definition locations.
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

interface EndBlockPair {
  openerLine: number;
  openerStart: number;
  openerLength: number;
  endLine: number;
  endStart: number;
}

function endBlockPairs(lines: readonly string[]): EndBlockPair[] {
  const defOpensBlock = (lineIndex: number): boolean => {
    if (!/^\s*def\s+[A-Za-z_][A-Za-z0-9_:.]*\s*\(/.test(lines[lineIndex])) return false;
    let header = "";
    for (let index = lineIndex; index < lines.length; index++) {
      header += ` ${lines[index].replace(/#.*$/, "")}`;
      if (/=>\s*(?:\(\s*\))?\s*$/.test(header)) return true;
      if (/\.\s*$/.test(header)) return false;
      if (index > lineIndex + 32) return false;
    }
    return false;
  };
  const stack: Array<{ line: number; start: number; length: number }> = [];
  const pairs: EndBlockPair[] = [];
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    const opener = /^\s*(class|def|for|while|switch|try)\b/.exec(text);
    const opens = !!opener && (opener[1] !== "def" || defOpensBlock(line));
    if (opener && opens) {
      stack.push({ line, start: opener.index + opener[0].lastIndexOf(opener[1]), length: opener[1].length });
      continue;
    }
    const closer = /^\s*(end)\b/.exec(text);
    if (!closer) continue;
    const start = stack.pop();
    if (!start) continue;
    pairs.push({
      openerLine: start.line,
      openerStart: start.start,
      openerLength: start.length,
      endLine: line,
      endStart: closer.index + closer[0].lastIndexOf(closer[1])
    });
  }
  return pairs;
}

// The blocks around the cursor are emphasised, nothing else: the innermost one
// strongly (opener, matching `end` and a label naming it), each enclosing block
// quietly in the same colour at reduced opacity. Colour follows nesting depth
// (rainbow style) and a block keeps its colour while the cursor moves, so the
// stack of `end`s closing a long function can be read at a glance. Colours are
// theme colours (felidae.blockLevel0..3), overridable in workbench.colorCustomizations.
const BLOCK_LEVEL_COUNT = 4;
const blockStrongDecorations = Array.from({ length: BLOCK_LEVEL_COUNT }, (_, level) =>
  vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor("felidae.blockLevel" + level),
    fontWeight: "bold",
    borderRadius: "3px",
    backgroundColor: new vscode.ThemeColor("felidae.blockHighlightBackground"),
    after: { color: "#6c7086", fontStyle: "italic", margin: "0 0 0 1.5em" }
  })
);
const blockSoftDecorations = Array.from({ length: BLOCK_LEVEL_COUNT }, (_, level) =>
  vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor("felidae.blockLevel" + level),
    fontWeight: "bold",
    opacity: "0.55"
  })
);

function endBlockLabel(openerText: string): string {
  const match = /^\s*(class|def|for|while|switch|try)\b\s*([A-Za-z_][A-Za-z0-9_:.]*)?/.exec(openerText);
  return match ? `${match[1]}${match[2] ? " " + match[2] : ""}` : "";
}

// Every block that contains the line, outermost first. Blocks that enclose a
// block also enclose the line, so the index in this list is the nesting depth.
function enclosingBlocks(pairs: readonly EndBlockPair[], line: number): EndBlockPair[] {
  return pairs
    .filter((pair) => pair.openerLine <= line && pair.endLine >= line)
    .sort((a, b) => a.openerLine - b.openerLine);
}

// The innermost block that contains the line: the enclosing pair whose opener
// is closest above it.
function enclosingBlock(pairs: readonly EndBlockPair[], line: number): EndBlockPair | undefined {
  let best: EndBlockPair | undefined;
  for (const pair of pairs) {
    if (pair.openerLine > line || pair.endLine < line) continue;
    if (!best || pair.openerLine > best.openerLine) best = pair;
  }
  return best;
}

const blockPairCache = new WeakMap<vscode.TextDocument, { version: number; lines: string[]; pairs: EndBlockPair[] }>();

function cachedEndBlockPairs(document: vscode.TextDocument): { lines: string[]; pairs: EndBlockPair[] } {
  const cached = blockPairCache.get(document);
  if (cached && cached.version === document.version) return cached;
  const lines: string[] = [];
  for (let line = 0; line < document.lineCount; line++) lines.push(document.lineAt(line).text);
  const entry = { version: document.version, lines, pairs: endBlockPairs(lines) };
  blockPairCache.set(document, entry);
  return entry;
}

// Typing fires both a document change and a selection change; the highlight
// depends only on the text version, the cursor line and the label setting, so
// an update for a state already drawn is skipped.
const drawnBlockState = new WeakMap<vscode.TextEditor, string>();

function updateEndDecorations(editor: vscode.TextEditor): void {
  if (editor.document.languageId !== "felidae") return;
  const showLabels = vscode.workspace.getConfiguration("felidae", editor.document.uri).get<boolean>("endLabels", true);
  const stateKey = editor.document.version + ":" + editor.selection.active.line + ":" + showLabels;
  if (drawnBlockState.get(editor) === stateKey) return;
  drawnBlockState.set(editor, stateKey);
  const { lines, pairs } = cachedEndBlockPairs(editor.document);
  const chain = enclosingBlocks(pairs, editor.selection.active.line);
  const strong: vscode.DecorationOptions[][] = blockStrongDecorations.map(() => []);
  const soft: vscode.DecorationOptions[][] = blockSoftDecorations.map(() => []);

  chain.forEach((pair, depth) => {
    const level = depth % BLOCK_LEVEL_COUNT;
    const innermost = depth === chain.length - 1;
    const label = innermost && showLabels ? endBlockLabel(lines[pair.openerLine]) : "";
    const target = innermost ? strong[level] : soft[level];
    target.push(
      { range: new vscode.Range(pair.openerLine, pair.openerStart, pair.openerLine, pair.openerStart + pair.openerLength) },
      {
        range: new vscode.Range(pair.endLine, pair.endStart, pair.endLine, pair.endStart + 3),
        renderOptions: label ? { after: { contentText: `← ${label}` } } : undefined
      }
    );
  });
  blockStrongDecorations.forEach((type, level) => editor.setDecorations(type, strong[level]));
  blockSoftDecorations.forEach((type, level) => editor.setDecorations(type, soft[level]));
}

function refreshEndDecorations(document?: vscode.TextDocument): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (!document || editor.document === document) updateEndDecorations(editor);
  }
}

class FelidaeFoldingRangeProvider implements vscode.FoldingRangeProvider {
  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    if (document.languageId !== "felidae") return [];
    const ranges: vscode.FoldingRange[] = [];
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);

    // A line beginning a new top-level construct ends the previous region.
    // The optional `extend Parent` clause must be allowed here, or a fact
    // written as `Child extend Parent(...)` is not seen as starting anything
    // and the whole run of facts collapses into one region. The optional
    // `def` prefix is the same story: every declaration except a bare fact
    // requires one now, so without allowing it here a run of `def`-prefixed
    // methods collapsed into one region the same way.
    const startsTopLevel = (line: string) =>
      /^(?:def[ \t]+)?[A-Za-z_][A-Za-z0-9_:.]*(?:[ \t]+extend[ \t]+[A-Za-z_][A-Za-z0-9_]*)?[ \t]*\(/.test(line) ||
      /^import\b/.test(line) ||
      /^[A-Za-z_][A-Za-z0-9_]*[ \t]*:=/.test(line);
    // Explicit `end` is authoritative: fold precisely from its opening
    // declaration/class line to the matching closer, including nested blocks.
    const explicitlyFolded = new Set<number>();
    for (const pair of endBlockPairs(lines)) {
      if (pair.endLine <= pair.openerLine) continue;
      ranges.push(new vscode.FoldingRange(pair.openerLine, pair.endLine, vscode.FoldingRangeKind.Region));
      explicitlyFolded.add(pair.openerLine);
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

// Inlay hints: positional call arguments get their parameter name, so
// "Employee(\"Alice\", 3)" reads as "Employee(name: \"Alice\", level: 3)" without
// the source changing. Named arguments already say what they are and get none.
class FelidaeInlayHintsProvider implements vscode.InlayHintsProvider {
  provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
    if (document.languageId !== "felidae") return [];
    const enabled = vscode.workspace
      .getConfiguration("felidae", document.uri)
      .get<boolean>("inlayHints.parameterNames", true);
    if (!enabled) return [];

    const tokens = lexDocument(document).tokens;
    const hints: vscode.InlayHint[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.kind !== "ident" || tokens[i + 1]?.kind !== "lparen") continue;
      if (token.line < range.start.line || token.line > range.end.line) continue;
      // A declaration head already lists its parameters.
      if (tokens[i - 1]?.text === "def") continue;
      const close = findMatchingParen(tokens, i + 1);
      if (close === undefined) continue;

      const nameParts = [token.text];
      let cursor = i - 1;
      while (
        cursor >= 1 &&
        (tokens[cursor].kind === "dot" || tokens[cursor].kind === "colon") &&
        tokens[cursor - 1]?.kind === "ident"
      ) {
        nameParts.unshift(tokens[cursor - 1].text);
        cursor -= 2;
      }
      const resolved = resolveCall(document, nameParts.join(":"));
      if (!resolved || resolved.params.length === 0) continue;

      let depth = 0;
      let argument = 0;
      let argumentStart = i + 2;
      for (let j = i + 2; j <= close; j++) {
        const kind = tokens[j].kind;
        const atArgumentEnd = j === close || (kind === "comma" && depth === 0);
        if (!atArgumentEnd) {
          if (kind === "lparen" || kind === "lbrace" || kind === "lbracket") depth++;
          else if (kind === "rparen" || kind === "rbrace" || kind === "rbracket") depth--;
          continue;
        }
        const first = tokens[argumentStart];
        const parameter = resolved.params[argument];
        const isNamed = first?.kind === "ident" && tokens[argumentStart + 1]?.kind === "colon";
        if (first && argumentStart < j && !isNamed && parameter && first.text !== parameter.name) {
          const hint = new vscode.InlayHint(
            new vscode.Position(first.line, first.start),
            parameter.name + ":",
            vscode.InlayHintKind.Parameter
          );
          hint.paddingRight = true;
          hints.push(hint);
        }
        argument++;
        argumentStart = j + 1;
      }
    }
    return hints;
  }
}

// Expand Selection (Shift+Alt+Right): word, line, then each enclosing block's
// body and whole block, innermost first.
function selectionChain(document: vscode.TextDocument, position: vscode.Position): vscode.Range[] {
  const sameRange = (a: vscode.Range, b: vscode.Range) =>
    a.start.line === b.start.line && a.start.character === b.start.character &&
    a.end.line === b.end.line && a.end.character === b.end.character;
  const chain: vscode.Range[] = [];
  const push = (range: vscode.Range) => {
    if (chain.length === 0 || !sameRange(chain[chain.length - 1], range)) chain.push(range);
  };

  const word = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (word) push(word);
  const text = document.lineAt(position.line).text;
  const indent = text.length - text.trimStart().length;
  push(new vscode.Range(position.line, indent, position.line, text.length));

  const { pairs } = cachedEndBlockPairs(document);
  const enclosing = pairs
    .filter((pair) => pair.openerLine <= position.line && pair.endLine >= position.line)
    .sort((a, b) => b.openerLine - a.openerLine);
  for (const pair of enclosing) {
    if (position.line > pair.openerLine && position.line < pair.endLine && pair.endLine - pair.openerLine > 1) {
      const lastBodyLine = pair.endLine - 1;
      push(new vscode.Range(pair.openerLine + 1, 0, lastBodyLine, document.lineAt(lastBodyLine).text.length));
    }
    push(new vscode.Range(pair.openerLine, 0, pair.endLine, document.lineAt(pair.endLine).text.length));
  }
  return chain;
}

class FelidaeSelectionRangeProvider implements vscode.SelectionRangeProvider {
  provideSelectionRanges(document: vscode.TextDocument, positions: vscode.Position[]): vscode.SelectionRange[] {
    return positions.map((position) => {
      let parent: vscode.SelectionRange | undefined;
      const chain = selectionChain(document, position);
      for (let i = chain.length - 1; i >= 0; i--) parent = new vscode.SelectionRange(chain[i], parent);
      return parent ?? new vscode.SelectionRange(new vscode.Range(position, position));
    });
  }
}

// Type hierarchy for "class Name extends A, B": supertypes are the declared
// parents, subtypes are the classes that list this one as a parent.
interface FelidaeClassDeclaration {
  name: string;
  parents: string[];
  document: vscode.TextDocument;
  line: number;
  nameStart: number;
}

const CLASS_DECLARATION_PATTERN = /^[ \t]*class[ \t]+([A-Za-z_][A-Za-z0-9_.]*)(?:[ \t]+extends?[ \t]+([^#\n]*))?/gm;

async function findClassDeclarations(): Promise<FelidaeClassDeclaration[]> {
  const found: FelidaeClassDeclaration[] = [];
  for (const document of await felidaeDocuments()) {
    const text = document.getText();
    const pattern = new RegExp(CLASS_DECLARATION_PATTERN.source, "gm");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = document.positionAt(match.index + match[0].indexOf(match[1]));
      const parents = (match[2] ?? "").split(",").map((part) => part.trim()).filter((part) => part.length > 0);
      found.push({ name: match[1], parents, document, line: start.line, nameStart: start.character });
    }
  }
  return found;
}

function typeHierarchyItem(declaration: FelidaeClassDeclaration): vscode.TypeHierarchyItem {
  const range = new vscode.Range(declaration.line, declaration.nameStart, declaration.line, declaration.nameStart + declaration.name.length);
  return new vscode.TypeHierarchyItem(
    vscode.SymbolKind.Class,
    declaration.name,
    declaration.parents.length ? "extends " + declaration.parents.join(", ") : "class",
    declaration.document.uri,
    range,
    range
  );
}

class FelidaeTypeHierarchyProvider implements vscode.TypeHierarchyProvider {
  async prepareTypeHierarchy(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.TypeHierarchyItem[] | undefined> {
    const word = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_.]*/);
    if (!word) return undefined;
    const name = document.getText(word);
    const declarations = (await findClassDeclarations()).filter((declaration) => declaration.name === name);
    return declarations.length ? declarations.map(typeHierarchyItem) : undefined;
  }

  async provideTypeHierarchySupertypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[]> {
    const all = await findClassDeclarations();
    const self = all.find((declaration) => declaration.name === item.name);
    if (!self) return [];
    return self.parents.flatMap((parent) =>
      all.filter((declaration) => declaration.name === parent).map(typeHierarchyItem)
    );
  }

  async provideTypeHierarchySubtypes(item: vscode.TypeHierarchyItem): Promise<vscode.TypeHierarchyItem[]> {
    return (await findClassDeclarations())
      .filter((declaration) => declaration.parents.includes(item.name))
      .map(typeHierarchyItem);
  }
}

// Tasks: Terminal > Run Task > felidae. The "$felidae" problem matcher turns
// interpreter errors ("error: file.fx: ... at line N, column M") into entries
// in the Problems panel.
class FelidaeTaskProvider implements vscode.TaskProvider {
  provideTasks(): vscode.Task[] {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "felidae") return [];
    return (["run", "check"] as const).map((command) =>
      this.build({ type: "felidae", command, file: document.uri.fsPath }, document.uri)
    );
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const definition = task.definition;
    if (definition.type !== "felidae") return undefined;
    const active = vscode.window.activeTextEditor?.document;
    const file: string | undefined = definition.file ?? active?.uri.fsPath;
    if (!file) return undefined;
    return this.build({ type: "felidae", command: definition.command ?? "run", file }, vscode.Uri.file(file));
  }

  private build(definition: vscode.TaskDefinition, uri: vscode.Uri): vscode.Task {
    const executable = resolveInterpreterPath(uri);
    const args = definition.command === "check" ? [definition.file, "--check-json"] : [definition.file];
    const execution = new vscode.ShellExecution(
      { value: executable, quoting: vscode.ShellQuoting.Strong },
      args.map((value: string) => ({ value, quoting: vscode.ShellQuoting.Strong }))
    );
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const task = new vscode.Task(
      definition,
      folder ?? vscode.TaskScope.Workspace,
      (definition.command === "check" ? "Check " : "Run ") + path.basename(definition.file),
      "felidae",
      execution,
      "$felidae"
    );
    if (definition.command === "run") task.group = vscode.TaskGroup.Build;
    return task;
  }
}

// Auto-insert "end": pressing Enter after a block opener (def ... =>, class,
// for/while ... then, switch, try) that has no "end" at its own indentation adds
// one below, leaving the cursor in the body. Matching is by indentation, which
// is how the formatter lays blocks out, so a nested opener is never confused
// with its parent's "end".
function isBlockOpenerLine(text: string): boolean {
  const code = text.replace(/#.*$/, "");
  return /^\s*(?:class\b|switch\b|try\s*$)/.test(code) ||
    /^\s*(?:for|while)\b.*\bthen\s*$/.test(code) ||
    /^\s*def\s+[A-Za-z_][A-Za-z0-9_:.]*\s*\([^)]*\)\s*=>\s*(?:\(\s*\))?\s*$/.test(code);
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

// True when the opener on openerLine is not closed by an "end" at its own
// indentation. The blank line the user just created (and any other blank or
// comment-only line) is skipped; the first line that is not indented deeper
// than the opener must be that "end".
function openerNeedsEnd(lines: readonly string[], openerLine: number): boolean {
  if (!isBlockOpenerLine(lines[openerLine])) return false;
  const indent = indentOf(lines[openerLine]);
  for (let line = openerLine + 1; line < lines.length; line++) {
    const text = lines[line];
    if (text.trim() === "" || text.trim().startsWith("#")) continue;
    if (indentOf(text) > indent) continue;
    return !(indentOf(text) === indent && /^end\b/.test(text.trim()));
  }
  return true;
}

function autoInsertEnd(event: vscode.TextDocumentChangeEvent): void {
  const document = event.document;
  if (document.languageId !== "felidae" || event.reason !== undefined) return;
  if (event.contentChanges.length !== 1) return;
  const change = event.contentChanges[0];
  if (!/^\r?\n[ \t]*$/.test(change.text)) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) return;
  if (!vscode.workspace.getConfiguration("felidae", document.uri).get<boolean>("autoInsertEnd", true)) return;

  const openerLine = change.range.start.line;
  const lines: string[] = [];
  for (let line = 0; line < document.lineCount; line++) lines.push(document.lineAt(line).text);
  if (!openerNeedsEnd(lines, openerLine)) return;

  const cursorLine = openerLine + 1;
  const cursor = new vscode.Position(cursorLine, document.lineAt(cursorLine).text.length);
  const indent = lines[openerLine].slice(0, indentOf(lines[openerLine]));
  void editor
    .edit((builder) => builder.insert(cursor, "\n" + indent + "end"), { undoStopBefore: false, undoStopAfter: false })
    .then((applied) => {
      if (applied) editor.selection = new vscode.Selection(cursor, cursor);
    });
}

// Call hierarchy: who calls a method, and what a method calls. Only methods
// declared as "def name(...) =>" anywhere in the workspace take part.
interface FelidaeMethodDeclaration {
  name: string;
  document: vscode.TextDocument;
  line: number;
  nameStart: number;
}

async function findMethodDeclarations(): Promise<FelidaeMethodDeclaration[]> {
  const found: FelidaeMethodDeclaration[] = [];
  for (const document of await felidaeDocuments()) {
    for (const declaration of declarationsOf(document)) {
      if (declaration.terminator !== "=>") continue;
      const start = document.positionAt(declaration.nameOffset);
      found.push({ name: declaration.name, document, line: start.line, nameStart: start.character });
    }
  }
  return found;
}

function methodItem(declaration: FelidaeMethodDeclaration): vscode.CallHierarchyItem {
  const { pairs } = cachedEndBlockPairs(declaration.document);
  const block = pairs.find((pair) => pair.openerLine === declaration.line);
  const endLine = block ? block.endLine : declaration.line;
  const selection = new vscode.Range(declaration.line, declaration.nameStart, declaration.line, declaration.nameStart + declaration.name.length);
  const whole = new vscode.Range(declaration.line, 0, endLine, declaration.document.lineAt(endLine).text.length);
  return new vscode.CallHierarchyItem(vscode.SymbolKind.Method, declaration.name, "", declaration.document.uri, whole, selection);
}

// Every "name(" call in the document, as the callee name plus its range.
function callSites(document: vscode.TextDocument): Array<{ name: string; range: vscode.Range }> {
  const tokens = lexDocument(document).tokens;
  const sites: Array<{ name: string; range: vscode.Range }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ident" || tokens[i + 1]?.kind !== "lparen" || tokens[i - 1]?.text === "def") continue;
    sites.push({ name: token.text, range: new vscode.Range(token.line, token.start, token.line, token.end) });
  }
  return sites;
}

class FelidaeCallHierarchyProvider implements vscode.CallHierarchyProvider {
  async prepareCallHierarchy(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CallHierarchyItem[] | undefined> {
    const word = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!word) return undefined;
    const name = document.getText(word);
    const declarations = (await findMethodDeclarations()).filter((declaration) => declaration.name === name);
    return declarations.length ? declarations.map(methodItem) : undefined;
  }

  async provideCallHierarchyIncomingCalls(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyIncomingCall[]> {
    const declarations = await findMethodDeclarations();
    const result: vscode.CallHierarchyIncomingCall[] = [];
    for (const caller of declarations) {
      const { pairs } = cachedEndBlockPairs(caller.document);
      const block = pairs.find((pair) => pair.openerLine === caller.line);
      if (!block) continue;
      const ranges = callSites(caller.document)
        .filter((site) => site.name === item.name && site.range.start.line > block.openerLine && site.range.start.line < block.endLine)
        .map((site) => site.range);
      if (ranges.length) result.push(new vscode.CallHierarchyIncomingCall(methodItem(caller), ranges));
    }
    return result;
  }

  async provideCallHierarchyOutgoingCalls(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyOutgoingCall[]> {
    const declarations = await findMethodDeclarations();
    const owner = declarations.find((declaration) =>
      declaration.name === item.name && declaration.document.uri.toString() === item.uri.toString());
    if (!owner) return [];
    const { pairs } = cachedEndBlockPairs(owner.document);
    const block = pairs.find((pair) => pair.openerLine === owner.line);
    if (!block) return [];
    const byCallee = new Map<string, vscode.Range[]>();
    for (const site of callSites(owner.document)) {
      if (site.range.start.line <= block.openerLine || site.range.start.line >= block.endLine) continue;
      const ranges = byCallee.get(site.name) ?? [];
      ranges.push(site.range);
      byCallee.set(site.name, ranges);
    }
    const result: vscode.CallHierarchyOutgoingCall[] = [];
    for (const [name, ranges] of byCallee) {
      for (const callee of declarations.filter((declaration) => declaration.name === name)) {
        result.push(new vscode.CallHierarchyOutgoingCall(methodItem(callee), ranges));
      }
    }
    return result;
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

// What a `def` declares, by the tokens that follow it:
//   def name(...) =>   a function
//   def Name(...).     a persistent fact (or a fact pattern inside a rule)
//   def name := v.  /  def name: T.   a binding or class field
type DefKind = "function" | "fact" | "binding";

function defKindAt(tokens: Token[], defIndex: number): DefKind {
  if (tokens[defIndex + 2]?.kind !== "lparen") return "binding";
  const close = findMatchingParen(tokens, defIndex + 2);
  return close !== undefined && tokens[close + 1]?.kind === "arrow" ? "function" : "fact";
}

function classifyDefs(tokens: Token[]): Array<{ kind: DefKind; line: number; start: number; end: number }> {
  const defs: Array<{ kind: DefKind; line: number; start: number; end: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ident" || token.text !== "def" || tokens[i + 1]?.kind !== "ident") continue;
    defs.push({ kind: defKindAt(tokens, i), line: token.line, start: token.start, end: token.end });
  }
  return defs;
}

// The three kinds of def get three colours that do not depend on the active
// theme: TextMate scopes and semantic tokens only name the kind, and most
// themes paint every keyword alike, while decorations always win. The colours
// are theme colours (felidae.defFunction / defFact / defBinding).
const defDecorations: Record<DefKind, vscode.TextEditorDecorationType> = {
  function: vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor("felidae.defFunction"), fontWeight: "bold" }),
  fact: vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor("felidae.defFact"), fontWeight: "bold" }),
  binding: vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor("felidae.defBinding"), fontWeight: "bold" })
};

function updateDefDecorations(editor: vscode.TextEditor): void {
  if (editor.document.languageId !== "felidae") return;
  const buckets: Record<DefKind, vscode.Range[]> = { function: [], fact: [], binding: [] };
  for (const def of classifyDefs(lexDocument(editor.document).tokens)) {
    buckets[def.kind].push(new vscode.Range(def.line, def.start, def.line, def.end));
  }
  (Object.keys(buckets) as DefKind[]).forEach((kind) => editor.setDecorations(defDecorations[kind], buckets[kind]));
}

function refreshDefDecorations(document?: vscode.TextDocument): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (!document || editor.document === document) updateDefDecorations(editor);
  }
}

let defDecorationTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleDefDecorations(document: vscode.TextDocument): void {
  if (document.languageId !== "felidae") return;
  if (defDecorationTimer) clearTimeout(defDecorationTimer);
  defDecorationTimer = setTimeout(() => refreshDefDecorations(document), 120);
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
      const isKeyword = FELIDAE_KEYWORDS.has(token.text);
      const isCall = next?.kind === "lparen";

      if (token.text === "def" && next?.kind === "ident") {
        const semanticType = { binding: 2, function: 3, fact: 4 }[defKindAt(tokens, i)];
        builder.push(token.line, token.start, token.end - token.start, semanticType, 0);
        continue;
      }

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
//
// The leading `(?:def[ \t]+)?` is later still: every declaration except a
// bare fact now requires that keyword, so without allowing it here this
// stopped matching any method or function at all - only bare facts (which
// never had `def`) kept working, which is why the outline, completion, go-
// to-definition and every other provider built on this pattern went quiet
// for `def`-prefixed source the moment that keyword became mandatory.
// Non-capturing, so match[1..4] keep meaning name/extends/args/terminator.
const DECLARATION_PATTERN =
  /^(?:def[ \t]+)?([A-Za-z_][A-Za-z0-9_:.]*)(?:[ \t]+extend[ \t]+([A-Za-z_][A-Za-z0-9_]*))?[ \t]*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)[ \t]*(=>|\.|$)/gm;
// A top-level binding: `def name := v.` or `def name: Type := v.` (an indented
// def is a local or a class field, not a top-level symbol).
const GLOBAL_BINDING_PATTERN = /^def[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?::[^=\n]*)?:=/gm;

// Declarations in a document, scanned once per version. Signature help,
// completion, call hierarchy, inlay hints and find-references all need them,
// and re-scanning the whole text per call made inlay hints quadratic.
interface DeclarationMatch {
  name: string;
  args: string;
  // "=>" for a method, "." or "" for a fact.
  terminator: string;
  // Offset of the name in the document text.
  nameOffset: number;
}

const declarationCache = new WeakMap<vscode.TextDocument, { version: number; items: DeclarationMatch[] }>();

function scanDeclarations(document: vscode.TextDocument): DeclarationMatch[] {
  const text = document.getText();
  const pattern = new RegExp(DECLARATION_PATTERN);
  const items: DeclarationMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    items.push({ name: match[1], args: match[3], terminator: match[4], nameOffset: match.index + match[0].indexOf(match[1]) });
  }
  return items;
}

function declarationsOf(document: vscode.TextDocument): DeclarationMatch[] {
  if (typeof document.version !== "number") return scanDeclarations(document);
  const cached = declarationCache.get(document);
  if (cached && cached.version === document.version) return cached.items;
  const items = scanDeclarations(document);
  declarationCache.set(document, { version: document.version, items });
  return items;
}

interface FelidaeCheckPosition {
  line?: number;
  column?: number;
}

interface FelidaeCheckSymbol {
  name: string;
  kind: string;
  start?: FelidaeCheckPosition;
  end?: FelidaeCheckPosition;
  children?: FelidaeCheckSymbol[];
}

const checkSymbolCache = new Map<string, FelidaeCheckSymbol[]>();
const checkSymbolsChanged = new vscode.EventEmitter<vscode.Uri>();

function checkedPosition(document: vscode.TextDocument, position: FelidaeCheckPosition | undefined): vscode.Position {
  const line = Math.min(
    Math.max(0, Number(position?.line ?? 1) - 1),
    Math.max(0, document.lineCount - 1)
  );
  const column = Math.min(
    Math.max(0, Number(position?.column ?? 1) - 1),
    document.lineAt(line).text.length
  );
  return new vscode.Position(line, column);
}

function checkedSymbol(document: vscode.TextDocument, value: FelidaeCheckSymbol): vscode.DocumentSymbol {
  const start = checkedPosition(document, value.start);
  const rawEnd = checkedPosition(document, value.end);
  const end = rawEnd.isAfter(start) ? rawEnd : start.translate(0, 1);
  const range = new vscode.Range(start, end);
  const kinds: Record<string, vscode.SymbolKind> = {
    binding: vscode.SymbolKind.Variable,
    call: vscode.SymbolKind.Function,
    class: vscode.SymbolKind.Class,
    fact: vscode.SymbolKind.Struct,
    function: vscode.SymbolKind.Function,
    import: vscode.SymbolKind.Module,
    method: vscode.SymbolKind.Method
  };
  const symbol = new vscode.DocumentSymbol(
    value.name,
    value.kind,
    kinds[value.kind] ?? vscode.SymbolKind.Object,
    range,
    range
  );
  symbol.children = (value.children ?? []).map((child) => checkedSymbol(document, child));
  return symbol;
}

class FelidaeDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  readonly onDidChangeDocumentSymbol = checkSymbolsChanged.event;

  provideDocumentSymbols(document: vscode.TextDocument): vscode.ProviderResult<vscode.DocumentSymbol[]> {
    if (document.languageId !== "felidae") return [];
    return (checkSymbolCache.get(document.uri.toString()) ?? [])
      .map((symbol) => checkedSymbol(document, symbol));
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
//   2. symbolSummaryCache - declarations returned by felidae --check-json.
//   3. DECLARATION_PATTERN text scan - parameter fallback while a check is
//      pending, because the current check schema intentionally omits params.
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

  for (const declaration of declarationsOf(document)) {
    if (!matchesName(declaration.name)) continue;
    return {
      label: declaration.name,
      params: collectHeadParams(declaration.args),
      detail: declaration.terminator === "=>" ? `method ${declaration.name}` : `fact ${declaration.name}`
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
  for (const declaration of declarationsOf(document)) {
    if (isLibraryName(normalizeGraphName(declaration.name))) continue;
    const isMethod = declaration.terminator === "=>";
    add(declaration.name, isMethod ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Struct, isMethod ? "method" : "fact");
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

const occurrenceCache = new WeakMap<vscode.TextDocument, { version: number; byName: Map<string, vscode.Range[]> }>();

function indexOccurrences(document: vscode.TextDocument): Map<string, vscode.Range[]> {
  const byName = new Map<string, vscode.Range[]>();
  for (const token of lexDocument(document).tokens) {
    if (token.kind !== "ident") continue;
    const ranges = byName.get(token.text) ?? [];
    ranges.push(new vscode.Range(new vscode.Position(token.line, token.start), new vscode.Position(token.line, token.end)));
    byName.set(token.text, ranges);
  }
  return byName;
}

function symbolOccurrences(document: vscode.TextDocument, name: string): vscode.Range[] {
  if (typeof document.version !== "number") return indexOccurrences(document).get(name) ?? [];
  let cached = occurrenceCache.get(document);
  if (!cached || cached.version !== document.version) {
    cached = { version: document.version, byName: indexOccurrences(document) };
    occurrenceCache.set(document, cached);
  }
  return cached.byName.get(name) ?? [];
}

// A name that is not a top-level declaration is local: a parameter or binding
// of the declaration around the cursor. Its uses are confined to that
// declaration's block, so another function's variable that happens to share
// the name is not a reference to it.
function scopedOccurrences(document: vscode.TextDocument, name: string, position: vscode.Position): vscode.Range[] {
  const all = symbolOccurrences(document, name);
  if (isTopLevelSymbol(document, name)) return all;
  let outer: EndBlockPair | undefined;
  for (const pair of cachedEndBlockPairs(document).pairs) {
    if (pair.openerLine > position.line || pair.endLine < position.line) continue;
    if (!outer || pair.openerLine < outer.openerLine) outer = pair;
  }
  if (!outer) return all;
  const { openerLine, endLine } = outer;
  return all.filter((range) => range.start.line >= openerLine && range.start.line <= endLine);
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
const topLevelCache = new WeakMap<vscode.TextDocument, { version: number; names: Set<string> }>();

function topLevelNames(document: vscode.TextDocument): Set<string> {
  const names = new Set<string>();
  for (const declaration of declarationsOf(document)) {
    names.add(declaration.name);
    names.add(normalizeGraphName(declaration.name));
  }
  const binding = new RegExp(GLOBAL_BINDING_PATTERN);
  const text = document.getText();
  let match: RegExpExecArray | null;
  while ((match = binding.exec(text)) !== null) names.add(match[1]);
  return names;
}

function isTopLevelSymbol(document: vscode.TextDocument, name: string): boolean {
  if (typeof document.version !== "number") return topLevelNames(document).has(name);
  let cached = topLevelCache.get(document);
  if (!cached || cached.version !== document.version) {
    cached = { version: document.version, names: topLevelNames(document) };
    topLevelCache.set(document, cached);
  }
  return cached.names.has(name);
}

// The workspace file list is cached and only refreshed when a .fx file is
// created or deleted (see the file watcher in activate).
let workspaceFileCache: vscode.Uri[] | undefined;

function invalidateWorkspaceFiles(): void {
  workspaceFileCache = undefined;
}

async function felidaeFileUris(): Promise<vscode.Uri[]> {
  if (!workspaceFileCache) {
    workspaceFileCache = await vscode.workspace.findFiles("**/*.fx", "**/node_modules/**", 500);
  }
  return workspaceFileCache;
}

// With "mentioning", only files whose text contains that name are opened:
// open editors are checked in memory and the rest are read as bytes, so a
// reference search over a large workspace opens a handful of documents rather
// than all of them.
async function felidaeDocuments(mentioning?: string): Promise<vscode.TextDocument[]> {
  const open = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
  const documents: vscode.TextDocument[] = [];
  for (const uri of await felidaeFileUris()) {
    try {
      const live = open.get(uri.toString());
      if (live) {
        if (!mentioning || live.getText().includes(mentioning)) documents.push(live);
        continue;
      }
      if (mentioning) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (!Buffer.from(bytes).toString("utf8").includes(mentioning)) continue;
      }
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
    if (["class", "def", "for", "while", "switch", "try", "end"].includes(found.name)) {
      const pair = cachedEndBlockPairs(document).pairs.find((candidate) =>
        (candidate.openerLine === position.line && found.name !== "end") ||
        (candidate.endLine === position.line && found.name === "end")
      );
      if (pair) {
        const opening = new vscode.Range(
          new vscode.Position(pair.openerLine, pair.openerStart),
          new vscode.Position(pair.openerLine, pair.openerStart + pair.openerLength)
        );
        const closing = new vscode.Range(
          new vscode.Position(pair.endLine, pair.endStart),
          new vscode.Position(pair.endLine, pair.endStart + 3)
        );
        return [opening, closing].map(
          (range) => new vscode.DocumentHighlight(range, vscode.DocumentHighlightKind.Text)
        );
      }
    }
    return scopedOccurrences(document, found.name, position).map(
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

    const locations: vscode.Location[] = scopedOccurrences(document, found.name, position).map(
      (range) => new vscode.Location(document.uri, range)
    );

    // A local binding or parameter means nothing in another file, so only
    // top-level declarations are worth a workspace-wide scan.
    if (!isTopLevelSymbol(document, found.name)) return locations;

    for (const other of await felidaeDocuments(found.name)) {
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
    for (const range of scopedOccurrences(document, found.name, position)) {
      edit.replace(document.uri, range, newName);
    }

    // Same reasoning as find-references: only a top-level name can be
    // referenced from another file, so only then is a workspace rename
    // correct. Renaming a local everywhere would corrupt unrelated files.
    if (isTopLevelSymbol(document, found.name)) {
      for (const other of await felidaeDocuments(found.name)) {
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
      for (const declaration of declarationsOf(document)) {
        const name = declaration.name;
        if (needle && !name.toLowerCase().includes(needle)) continue;
        const start = document.positionAt(declaration.nameOffset);
        symbols.push(
          new vscode.SymbolInformation(
            name,
            declaration.terminator === "=>" ? vscode.SymbolKind.Method : vscode.SymbolKind.Struct,
            "",
            new vscode.Location(document.uri, new vscode.Range(start, start.translate(0, name.length)))
          )
        );
      }
      const binding = new RegExp(GLOBAL_BINDING_PATTERN);
      let match: RegExpExecArray | null;
      while ((match = binding.exec(text)) !== null) {
        const name = match[1];
        if (needle && !name.toLowerCase().includes(needle)) continue;
        const start = document.positionAt(match.index + match[0].indexOf(name, 3));
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
  log("error", label + " is missing or not executable: " + interpreterPath);
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
  // Reserved for a future check-json schema revision that reports parameters.
  params?: FelidaeParam[];
}

interface FelidaeSymbolSummary {
  methods: FelidaeSymbolDefinition[];
  facts: FelidaeSymbolDefinition[];
  globals: FelidaeSymbolDefinition[];
  files: string[];
  unresolvedImports: string[];
}

// AST-derived symbols returned by the same interpreter check that owns
// diagnostics. The summary shape is retained for completion/signature code,
// but there is no second parser process or extension-side semantic validator.
const symbolSummaryCache = new Map<string, FelidaeSymbolSummary>();

function cacheCheckSymbols(document: vscode.TextDocument, symbols: FelidaeCheckSymbol[]): void {
  const span = (symbol: FelidaeCheckSymbol) => ({
    startLine: Number(symbol.start?.line ?? 1),
    startColumn: Number(symbol.start?.column ?? 1),
    endLine: Number(symbol.end?.line ?? symbol.start?.line ?? 1),
    endColumn: Number(symbol.end?.column ?? symbol.start?.column ?? 1)
  });
  const definition = (symbol: FelidaeCheckSymbol): FelidaeSymbolDefinition => ({
    name: symbol.name,
    count: 1,
    spans: [span(symbol)]
  });
  const summary: FelidaeSymbolSummary = {
    methods: [], facts: [], globals: [], files: [document.uri.fsPath], unresolvedImports: []
  };
  for (const symbol of symbols) {
    if (symbol.kind === "function") summary.methods.push(definition(symbol));
    else if (symbol.kind === "fact" || symbol.kind === "class") summary.facts.push(definition(symbol));
    else if (symbol.kind === "binding") summary.globals.push(definition(symbol));
    for (const child of symbol.children ?? []) {
      if (child.kind === "method") summary.methods.push(definition(child));
    }
  }
  const key = document.uri.toString();
  checkSymbolCache.set(key, symbols);
  symbolSummaryCache.set(key, summary);
  checkSymbolsChanged.fire(document.uri);
}

const activeCheckProcesses = new Map<string, childProcess.ChildProcess>();

function runtimeCheckDiagnostics(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
  return new Promise((resolve) => {
    if (document.uri.scheme !== "file") {
      resolve([]);
      return;
    }
    const interpreterPath = resolveToolingPath(document.uri);
    if (!isExecutableFile(interpreterPath)) {
      log("warn", "check skipped, interpreter not found: " + interpreterPath);
      const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1));
      resolve([new vscode.Diagnostic(
        range,
        `Felidae interpreter not found: ${interpreterPath}. Parser and AST validation via --check-json is disabled.`,
        vscode.DiagnosticSeverity.Warning
      )]);
      return;
    }
    const key = document.uri.toString();
    activeCheckProcesses.get(key)?.kill();
    const startedAt = Date.now();
    log("debug", "check: " + interpreterPath + " --check-json --stdin " + document.uri.fsPath);
    const check = childProcess.execFile(
      interpreterPath,
      ["--check-json", "--stdin", document.uri.fsPath],
      { cwd: path.dirname(document.uri.fsPath), windowsHide: true, timeout: 15000 },
      (error, stdout, stderr) => {
        if (activeCheckProcesses.get(key) === check) activeCheckProcesses.delete(key);
        log(error ? "warn" : "debug", "check finished in " + (Date.now() - startedAt) + " ms for " + path.basename(document.uri.fsPath) +
          (error ? " (" + (error.killed ? "superseded or timed out" : "exit " + error.code) + ")" : "") +
          (stderr.trim() ? "\n" + stderr.trim() : ""));
        const checkResult = parseRuntimeCheckResult(document, stdout);
        if (checkResult) {
          cacheCheckSymbols(document, checkResult.symbols);
          resolve(checkResult.diagnostics);
          return;
        }
        const analyzerDiagnostics = parseRuntimeAnalyzerDiagnostics(document, stdout);
        if (!error && stdout.includes("FELIDAE_CHECK_OK")) {
          resolve(analyzerDiagnostics);
          return;
        }
        const text = stderr.trim() || error?.message || "Felidae check failed.";
        const { message, severity } = formatRuntimeCheckMessage(text);
        const { line, column } = diagnosticPositionInMessage(message, document.uri.fsPath);
        const range = new vscode.Range(
          new vscode.Position(line, column),
          new vscode.Position(line, column + 1)
        );
        resolve([...analyzerDiagnostics, new vscode.Diagnostic(range, message, severity)]);
      }
    );
    activeCheckProcesses.set(key, check);
    check.stdin?.end(document.getText());
  });
}

// Where an interpreter error message points. Messages say "line N, column M"
// (older ones "at N:M"). A message that starts with a different file's path is
// about an imported file, so its line number must not be applied to this one.
function diagnosticPositionInMessage(message: string, documentPath: string): { line: number; column: number } {
  const other = /^(.+?\.fx): /.exec(message);
  if (other && other[1].toLowerCase() !== documentPath.toLowerCase()) return { line: 0, column: 0 };
  const match = /line (\d+), column (\d+)/.exec(message) ?? / at (\d+):(\d+)/.exec(message);
  return match
    ? { line: Math.max(0, Number(match[1]) - 1), column: Math.max(0, Number(match[2]) - 1) }
    : { line: 0, column: 0 };
}

// One entry per distinct problem, all tagged with the same source, so the
// Problems panel total equals the issues actually in the file even when the
// parser and the analyzer both report the same thing.
function dedupeDiagnostics(list: readonly vscode.Diagnostic[]): vscode.Diagnostic[] {
  const seen = new Set<string>();
  const unique: vscode.Diagnostic[] = [];
  for (const item of list) {
    const key = [item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character, item.severity, item.message].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    item.source ??= "felidae";
    unique.push(item);
  }
  return unique;
}

function parseRuntimeCheckResult(
  document: vscode.TextDocument,
  stdout: string
): { diagnostics: vscode.Diagnostic[]; symbols: FelidaeCheckSymbol[] } | undefined {
  const text = stdout.trim();
  if (!text.startsWith("{")) return undefined;

  try {
    const payload = JSON.parse(text) as {
      diagnostics?: Array<{
        severity?: string;
        start?: { line?: number; column?: number };
        end?: { line?: number; column?: number };
        message?: string;
      }>;
      symbols?: FelidaeCheckSymbol[];
    };
    if (!Array.isArray(payload.diagnostics)) return undefined;

    const diagnostics = payload.diagnostics
      .filter((item) => typeof item.message === "string" && item.message.trim().length > 0)
      .map((item) => {
        const sourceLine = Math.max(0, Number(item.start?.line ?? 1) - 1);
        const sourceColumn = Math.max(0, Number(item.start?.column ?? 1) - 1);
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
        const endLine = Math.min(
          Math.max(0, Number(item.end?.line ?? item.start?.line ?? 1) - 1),
          document.lineCount - 1
        );
        const endText = document.lineAt(endLine).text;
        const rawEndColumn = Math.max(0, Number(item.end?.column ?? item.start?.column ?? 1) - 1);
        const endColumn = endLine === boundedLine
          ? Math.min(Math.max(boundedColumn + 1, rawEndColumn), endText.length)
          : Math.min(rawEndColumn, endText.length);
        return new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(boundedLine, boundedColumn),
            new vscode.Position(endLine, endColumn)
          ),
          item.message ?? "Felidae AST diagnostic",
          severity
        );
      });
    return {
      diagnostics,
      symbols: Array.isArray(payload.symbols) ? payload.symbols : []
    };
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
  const defaultQuery = config.get<string>("defaultQuery", "employee.where(active: true).");
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
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.endsWith(".") ? trimmedQuery : `${trimmedQuery}.`;
  runInTerminal(interpreterPath, [programPath, "--query", normalizedQuery], path.dirname(programPath));
}

// A `main` *declaration*, which like every Felidae declaration sits at column
// 0, starts with the mandatory `def` keyword, and is followed by `=>`.
// Anchoring matters: `^\s*` also matched an indented `main(...)` call inside
// another method's body, which made Run and Debug appear for files that have
// no entry point to run. The `def` prefix is not optional here either - a
// bare `main() =>` with no `def` is no longer valid Felidae at all (every
// declaration except a bare fact requires it), so this pattern requiring it
// matches exactly what can actually run, not a syntax this language used to
// accept.
const MAIN_DECLARATION_PATTERN = /^def[ \t]+main[ \t]*\([^)]*\)[ \t]*=>/m;

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
    log("trace", "debug request: " + request.command);

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

    if (!interpreterPath || !program) {
      this.sendResponse(request, undefined, false, "Debug configuration requires interpreterPath and program.");
      this.sendEvent("terminated");
      return;
    }

    // With a query the debugger runs that one expression (a cell) instead of main.
    const query = typeof args.query === "string" && args.query.trim() ? args.query : undefined;
    const launchArgs = query ? [program, "--debug", "--query", query] : [program, "--debug"];
    this.currentProgram = program;
    this.currentLine = 1;
    this.stdoutBuffer = "";
    this.sendOutput(`Felidae debugger launch\n${interpreterPath} ${launchArgs.join(" ")}\n`, "console");
    log("info", "debug launch: " + interpreterPath + " " + launchArgs.join(" "));
    this.process = childProcess.spawn(interpreterPath, launchArgs, {
      cwd: path.dirname(program),
      windowsHide: true
    });

    this.process.stdout.on("data", (data: Buffer) => this.handleDebugStdout(data.toString()));
    this.process.stderr.on("data", (data: Buffer) => this.sendOutput(data.toString(), "stderr"));
    this.process.on("error", (error: Error) => {
      log("error", "debug process error: " + error.message);
      this.sendOutput(`${error.message}\n`, "stderr");
      this.process = undefined;
      this.finishConfiguration();
      this.resolvePendingStop();
      this.sendEvent("terminated");
    });
    this.process.on("close", (code: number | null) => {
      this.flushDebugStdout();
      log(code === 0 || code === null ? "info" : "warn", "debug process exited with code " + (code ?? "unknown"));
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

  outputChannel = vscode.window.createOutputChannel("Felidae", { log: true });
  context.subscriptions.push(outputChannel);
  const extensionVersion = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "unknown";
  log("info", "Felidae extension " + extensionVersion + " activated (" + process.platform + ", VS Code " + vscode.version + ")");

  const diagnostics = vscode.languages.createDiagnosticCollection("felidae");

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DIAGNOSTICS_DEBOUNCE_MS = 350;

  // Only the newest check for a document may publish. An older check that
  // finishes late (or was killed by a newer one) is dropped, and the previous
  // diagnostics stay until the new result replaces them, so the Problems total
  // never flickers to zero or shows a superseded result.
  const checkGeneration = new Map<string, number>();
  const refreshDiagnostics = (document: vscode.TextDocument, fromEdit = false): void => {
    if (document.languageId !== "felidae") return;
    const key = document.uri.toString();
    const generation = (checkGeneration.get(key) ?? 0) + 1;
    checkGeneration.set(key, generation);
    const version = document.version;
    void runtimeCheckDiagnostics(document).then((runtimeDiagnostics) => {
      if (document.isClosed || document.version !== version || checkGeneration.get(key) !== generation) return;
      const published = dedupeDiagnostics(runtimeDiagnostics);
      diagnostics.set(document.uri, published);
      const count = (severity: vscode.DiagnosticSeverity) => published.filter((item) => item.severity === severity).length;
      log("info", path.basename(document.uri.fsPath) + ": " + count(vscode.DiagnosticSeverity.Error) + " error(s), " +
        count(vscode.DiagnosticSeverity.Warning) + " warning(s), " + count(vscode.DiagnosticSeverity.Information) + " info");
    });
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

  // Status bar: shows the active Felidae file's error/warning count and opens
  // the Problems panel on click.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = "workbench.actions.view.problems";
  const refreshStatusItem = (): void => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "felidae") {
      statusItem.hide();
      return;
    }
    const list = diagnostics.get(document.uri) ?? [];
    const errors = list.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = list.filter((item) => item.severity === vscode.DiagnosticSeverity.Warning).length;
    statusItem.text = errors > 0 ? "$(error) Felidae " + errors : warnings > 0 ? "$(warning) Felidae " + warnings : "$(check) Felidae";
    let totalErrors = 0;
    let totalWarnings = 0;
    diagnostics.forEach((_uri, items) => {
      totalErrors += items.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length;
      totalWarnings += items.filter((item) => item.severity === vscode.DiagnosticSeverity.Warning).length;
    });
    statusItem.tooltip = path.basename(document.uri.fsPath) + ": " + errors + " error(s), " + warnings + " warning(s)\n" +
      "All checked Felidae files: " + totalErrors + " error(s), " + totalWarnings + " warning(s)";
    statusItem.show();
  };
  refreshStatusItem();

  registerCells(context, {
    resolveInterpreterPath,
    ensureInterpreterInstalled: (interpreterPath) => ensureInterpreterInstalled(interpreterPath, "Felidae interpreter"),
    blockPairs: (document) => cachedEndBlockPairs(document).pairs,
    log
  });

  const fxWatcher = vscode.workspace.createFileSystemWatcher("**/*.fx");
  fxWatcher.onDidCreate(invalidateWorkspaceFiles);
  fxWatcher.onDidDelete(invalidateWorkspaceFiles);

  refreshEndDecorations();
  refreshDefDecorations();
  context.subscriptions.push(
    fxWatcher,
    ...blockStrongDecorations,
    ...blockSoftDecorations,
    ...Object.values(defDecorations),
    vscode.window.onDidChangeVisibleTextEditors(() => refreshDefDecorations()),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleDefDecorations(event.document)),
    vscode.window.onDidChangeTextEditorSelection((event) => updateEndDecorations(event.textEditor)),
    vscode.window.onDidChangeVisibleTextEditors(() => refreshEndDecorations()),
    vscode.workspace.onDidChangeTextDocument((event) => refreshEndDecorations(event.document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("felidae.endLabels")) refreshEndDecorations();
    }),
    diagnostics,
    vscode.commands.registerCommand("felidae.showOutput", () => outputChannel?.show(true)),
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
      checkSymbolCache.delete(document.uri.toString());
      symbolSummaryCache.delete(document.uri.toString());
      const key = document.uri.toString();
      const timer = debounceTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(key);
      }
      activeCheckProcesses.get(key)?.kill();
      activeCheckProcesses.delete(key);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) refreshDiagnostics(editor.document);
      refreshMainContext();
    }),
    vscode.languages.registerDocumentLinkProvider({ language: "felidae" }, new FelidaeDocumentLinkProvider()),
    vscode.languages.registerHoverProvider({ language: "felidae" }, new FelidaeHoverProvider()),
    vscode.languages.registerDefinitionProvider({ language: "felidae" }, new FelidaeDefinitionProvider()),
    vscode.languages.registerFoldingRangeProvider({ language: "felidae" }, new FelidaeFoldingRangeProvider()),
    vscode.languages.registerCallHierarchyProvider({ language: "felidae" }, new FelidaeCallHierarchyProvider()),
    vscode.workspace.onDidChangeTextDocument((event) => autoInsertEnd(event)),
    vscode.languages.registerInlayHintsProvider({ language: "felidae" }, new FelidaeInlayHintsProvider()),
    vscode.languages.registerSelectionRangeProvider({ language: "felidae" }, new FelidaeSelectionRangeProvider()),
    // Type hierarchy was finalised after the minimum supported VS Code; skip it there.
    ...(typeof vscode.languages.registerTypeHierarchyProvider === "function"
      ? [vscode.languages.registerTypeHierarchyProvider({ language: "felidae" }, new FelidaeTypeHierarchyProvider())]
      : []),
    vscode.tasks.registerTaskProvider("felidae", new FelidaeTaskProvider()),
    statusItem,
    vscode.languages.onDidChangeDiagnostics(() => refreshStatusItem()),
    vscode.window.onDidChangeActiveTextEditor(() => refreshStatusItem()),
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

export function deactivate(): void {
  for (const process of activeCheckProcesses.values()) process.kill();
  activeCheckProcesses.clear();
  checkSymbolsChanged.dispose();
}
