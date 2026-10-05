"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const childProcess = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const formatter_1 = require("./formatter");
const ml = __importStar(require("./mlRanking"));
const cellUi_1 = require("./cellUi");
const editing_1 = require("./editing");
const interpreterUi_1 = require("./interpreterUi");
const quickMenu_1 = require("./quickMenu");
const repl_1 = require("./repl");
const semanticLegend = new vscode.SemanticTokensLegend(["variable", "method", "felidaeDefBinding", "felidaeDefFunction", "felidaeDefFact"], ["readonly"]);
// Language keywords: never variables, never declaration names.
const FELIDAE_KEYWORDS = new Set([
    "def", "class", "extend", "extends", "index", "where", "if", "else", "then", "end",
    "for", "in", "while", "switch", "case", "default", "break", "continue",
    "try", "catch", "new", "this", "super", "lambda", "nil", "true", "false"
]);
const FELIDAE_BUILTIN_TYPE_NAMES = new Set([
    "any", "array", "bool", "boolean", "decimal", "double", "float", "int", "number", "string"
]);
function loadBuiltinDocs() {
    try {
        const docsPath = path.join(__dirname, "..", "resources", "builtin-docs.json");
        const parsed = JSON.parse(fs.readFileSync(docsPath, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
const builtinDocs = loadBuiltinDocs();
function builtinSourceName(name) {
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
function quotePosixShell(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
// The "Felidae" output channel: interpreter discovery, every diagnostics
// check (timing, exit code, stderr, counts), run and debug launches, and the
// debug adapter's lifecycle. Levels follow VS Code's per-channel log level
// (Developer: Set Log Level...), so "trace" shows the raw debug protocol.
let outputChannel;
function log(level, message) {
    outputChannel?.[level](message);
}
function runInTerminal(executablePath, args, cwd) {
    log("info", "run: " + [executablePath, ...args].join(" ") + " (cwd " + cwd + ")");
    let command;
    const env = {};
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
    }
    else {
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
function documentRange(line, start, end) {
    return new vscode.Range(new vscode.Position(line, start), new vscode.Position(line, Math.max(end, start + 1)));
}
// Every provider asks for the tokens of the same document; lexing is the
// expensive part, so each (document, version) is lexed once and shared.
const lexCache = new WeakMap();
function lexDocument(document) {
    if (typeof document.version !== "number")
        return lexDocumentUncached(document);
    const cached = lexCache.get(document);
    if (cached && cached.version === document.version)
        return cached.result;
    const result = lexDocumentUncached(document);
    lexCache.set(document, { version: document.version, result });
    return result;
}
function lexDocumentUncached(document) {
    const tokens = [];
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
                if (i >= text.length)
                    break;
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
            const singleKinds = {
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
            i++;
        }
    }
    return { tokens };
}
function findMatchingParen(tokens, lparenIndex) {
    let depth = 0;
    for (let i = lparenIndex; i < tokens.length; i++) {
        if (tokens[i].kind === "lparen")
            depth++;
        if (tokens[i].kind === "rparen") {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    return undefined;
}
function collectGlobalBindings(tokens) {
    const globals = new Set();
    for (let i = 0; i + 1 < tokens.length; i++) {
        if (tokens[i].kind === "ident" && tokens[i + 1]?.kind === "bind") {
            globals.add(tokens[i].text);
        }
    }
    return globals;
}
function collectVariableNames(tokens, start, end) {
    const vars = new Set();
    for (let i = start; i < end; i++) {
        const token = tokens[i];
        if (token.kind !== "ident")
            continue;
        if (token.text === "_")
            continue;
        if (FELIDAE_KEYWORDS.has(token.text))
            continue;
        const prev = tokens[i - 1];
        const next = tokens[i + 1];
        const nextNext = tokens[i + 2];
        const prevPrev = tokens[i - 2];
        if ((next?.kind === "dot" || next?.kind === "colon") && isLibraryNamespace(token.text))
            continue;
        if (next?.kind === "arrow")
            continue;
        if (/^[A-Z]/.test(token.text) &&
            prev?.kind === "colon" &&
            tokens[i - 2]?.kind === "ident" &&
            ["type", "parent", "of"].includes(tokens[i - 2].text)) {
            const callName = enclosingCallName(tokens, i);
            if (callName === "instanceof")
                continue;
        }
        if (next?.kind === "colon")
            continue;
        if (prev?.kind === "lparen" && prevPrev?.kind === "ident" && builtinDocs[prevPrev.text] && /^[A-Z]/.test(token.text))
            continue;
        if (next?.kind === "dot" && nextNext?.kind === "ident") {
            vars.add(token.text);
            continue;
        }
        if (next?.kind === "lparen")
            continue;
        if (prev?.kind === "dot")
            continue;
        if (prev?.kind === "colon" && /^[A-Z]/.test(token.text))
            continue;
        vars.add(token.text);
    }
    return vars;
}
// Walks back from `index` to the unmatched `(` the cursor is inside, and
// reads the (possibly dotted/namespaced) call name in front of it.
function enclosingCall(tokens, index) {
    let depth = 0;
    for (let i = index; i >= 0; i--) {
        const kind = tokens[i].kind;
        if (kind === "rparen" || kind === "rbrace" || kind === "rbracket")
            depth++;
        if (kind === "lparen") {
            if (depth === 0 && tokens[i - 1]?.kind === "ident") {
                const nameParts = [tokens[i - 1].text];
                let cursor = i - 2;
                while (cursor >= 1 &&
                    (tokens[cursor].kind === "dot" || tokens[cursor].kind === "colon") &&
                    tokens[cursor - 1]?.kind === "ident") {
                    nameParts.unshift(tokens[cursor - 1].text);
                    cursor -= 2;
                }
                return { name: nameParts.join(":"), openParen: i };
            }
            depth--;
        }
        if (kind === "lbrace" || kind === "lbracket")
            depth--;
    }
    return undefined;
}
function enclosingCallName(tokens, index) {
    return enclosingCall(tokens, index)?.name;
}
// Which argument slot the cursor is in, and which keys the call already
// names, by scanning forward from the opening `(` at this call's own depth.
function callArgumentState(tokens, openParen, index) {
    const suppliedKeys = new Set();
    let activeParameter = 0;
    let depth = 0;
    for (let i = openParen + 1; i <= index && i < tokens.length; i++) {
        const kind = tokens[i].kind;
        if (kind === "lparen" || kind === "lbrace" || kind === "lbracket")
            depth++;
        else if (kind === "rparen" || kind === "rbrace" || kind === "rbracket")
            depth--;
        else if (kind === "comma" && depth === 0)
            activeParameter++;
        else if (kind === "ident" && depth === 0 && tokens[i + 1]?.kind === "colon") {
            suppliedKeys.add(tokens[i].text);
        }
    }
    return { activeParameter, suppliedKeys };
}
function importLinkTarget(document, rawPath) {
    const coreTarget = resolveCoreImport(document, rawPath);
    if (coreTarget)
        return coreTarget;
    const documentDir = path.dirname(document.uri.fsPath);
    const isWildcard = rawPath.endsWith("/*");
    const checkPath = isWildcard ? rawPath.slice(0, -2) : rawPath;
    const resolved = path.resolve(documentDir, checkPath);
    if (!fs.existsSync(resolved)) {
        return undefined;
    }
    return vscode.Uri.file(resolved);
}
function resolveCoreImport(document, rawPath) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawPath))
        return undefined;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const candidates = [];
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
function collectImportStrings(document) {
    const result = [];
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text;
        if (!/\bimport\b/.test(text))
            continue;
        const importIndex = text.indexOf("import");
        const commentIndex = text.indexOf("#");
        if (commentIndex >= 0 && commentIndex < importIndex)
            continue;
        const regex = /"([^"]+)"/g;
        let match;
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
function collectImportedModuleNames(document) {
    const names = new Set();
    for (const item of collectImportStrings(document)) {
        const normalized = item.value.replace(/\\/g, "/").replace(/\*$/, "");
        const base = path.basename(normalized, ".fx");
        if (base && /^[A-Za-z_][A-Za-z0-9_]*$/.test(base))
            names.add(base);
    }
    return names;
}
class FelidaeDocumentLinkProvider {
    provideDocumentLinks(document) {
        if (document.languageId !== "felidae")
            return [];
        return collectImportStrings(document)
            .map((item) => {
            const target = importLinkTarget(document, item.value);
            if (!target)
                return undefined;
            return new vscode.DocumentLink(documentRange(item.line, item.start, item.end), target);
        })
            .filter((link) => !!link);
    }
}
function getCallNameAtPosition(document, position) {
    const line = document.lineAt(position.line).text;
    let start = position.character;
    let end = position.character;
    const isNameChar = (ch) => !!ch && /[A-Za-z0-9_:.]/.test(ch);
    while (start > 0 && isNameChar(line[start - 1]))
        start--;
    while (end < line.length && isNameChar(line[end]))
        end++;
    const name = line.slice(start, end).replace(/^\.+|\.+$/g, "");
    if (!/^[A-Za-z_][A-Za-z0-9_:.]*$/.test(name))
        return undefined;
    const after = line.slice(end);
    const before = line.slice(0, start);
    if (/^\s*\(/.test(after) || /[A-Za-z0-9_:.]$/.test(before)) {
        return builtinDocs[name.replace(/\./g, ":")] ? name.replace(/\./g, ":") : name;
    }
    return undefined;
}
function definitionPattern(name) {
    const parts = name.split(/[:.]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const qualifiedName = parts.join("\\s*[:.]\\s*");
    // A function/method declaration line always starts with the mandatory
    // `def` keyword now (a bare fact never has one, and never has `extend`
    // followed by `(` either, so `def` is optional here without making this
    // match a fact by that name too eagerly). Only `class Name` itself has no
    // `def` prefix to allow for.
    return new RegExp(`^(?:(?:def\\s+)?${qualifiedName}(?:\\s+extend\\s+[A-Za-z_][A-Za-z0-9_]*)?\\s*\\(|class\\s+${qualifiedName}\\b)`);
}
class FelidaeHoverProvider {
    provideHover(document, position) {
        const name = getCallNameAtPosition(document, position);
        if (!name)
            return undefined;
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
        if (!resolved)
            return undefined;
        const signature = resolved.params
            .map((param) => (param.type ? `${param.name}: ${param.type}` : `${param.name}:`))
            .join(", ");
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`### ${resolved.label}\n\n`);
        markdown.appendMarkdown(`${resolved.detail}\n\n`);
        markdown.appendCodeblock(`${resolved.label}(${signature})`, "felidae");
        // The `#` comment lines directly above the declaration are its documentation.
        const declaration = declarationsOf(document).find((entry) => entry.name === resolved.label);
        if (declaration) {
            const lines = [];
            for (let line = 0; line < document.lineCount; line++)
                lines.push(document.lineAt(line).text);
            const doc = (0, editing_1.docCommentAbove)(lines, document.positionAt(declaration.nameOffset).line);
            if (doc.length > 0)
                markdown.appendMarkdown(doc.join("  \n") + "\n\n");
        }
        return new vscode.Hover(markdown);
    }
}
class FelidaeDefinitionProvider {
    async provideDefinition(document, position) {
        // Builtins resolve to their shipped core source; project declarations use
        // a conservative workspace scan until check-json grows cross-file
        // definition locations.
        const name = getCallNameAtPosition(document, position);
        if (!name)
            return undefined;
        const builtin = await builtinDefinition(document, name);
        if (builtin)
            return builtin;
        const pattern = definitionPattern(name);
        const locations = [];
        const files = await vscode.workspace.findFiles("**/*.fx", FX_EXCLUDE, 200);
        for (const file of files) {
            const candidate = await vscode.workspace.openTextDocument(file);
            for (let line = 0; line < candidate.lineCount; line++) {
                const text = candidate.lineAt(line).text;
                if (!pattern.test(text))
                    continue;
                if (file.toString() === document.uri.toString() && line === position.line)
                    continue;
                locations.push(new vscode.Location(file, new vscode.Position(line, text.search(/\S/))));
            }
        }
        return locations.length ? locations : undefined;
    }
}
async function builtinDefinition(document, name) {
    const moduleName = name.split(":")[0]?.split(".")[0];
    if (!moduleName)
        return undefined;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder)
        return undefined;
    const target = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, "core", `${moduleName}.fx`));
    if (!fs.existsSync(target.fsPath))
        return undefined;
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
function endBlockPairs(lines) {
    const defOpensBlock = (lineIndex) => {
        if (!/^\s*def\s+[A-Za-z_][A-Za-z0-9_:.]*\s*\(/.test(lines[lineIndex]))
            return false;
        let header = "";
        for (let index = lineIndex; index < lines.length; index++) {
            header += ` ${lines[index].replace(/#.*$/, "")}`;
            if (/=>\s*(?:\(\s*\))?\s*$/.test(header))
                return true;
            if (/\.\s*$/.test(header))
                return false;
            if (index > lineIndex + 32)
                return false;
        }
        return false;
    };
    const stack = [];
    const pairs = [];
    for (let line = 0; line < lines.length; line++) {
        const text = lines[line];
        const opener = /^\s*(class|def|for|while|switch|try)\b/.exec(text);
        const opens = !!opener && (opener[1] !== "def" || defOpensBlock(line));
        if (opener && opens) {
            stack.push({ line, start: opener.index + opener[0].lastIndexOf(opener[1]), length: opener[1].length });
            continue;
        }
        const closer = /^\s*(end)\b/.exec(text);
        if (!closer)
            continue;
        const start = stack.pop();
        if (!start)
            continue;
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
const blockStrongDecorations = Array.from({ length: BLOCK_LEVEL_COUNT }, (_, level) => vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor("felidae.blockLevel" + level),
    fontWeight: "bold",
    borderRadius: "3px",
    backgroundColor: new vscode.ThemeColor("felidae.blockHighlightBackground"),
    after: { color: "#6c7086", fontStyle: "italic", margin: "0 0 0 1.5em" }
}));
const blockSoftDecorations = Array.from({ length: BLOCK_LEVEL_COUNT }, (_, level) => vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor("felidae.blockLevel" + level),
    fontWeight: "bold",
    opacity: "0.55"
}));
function endBlockLabel(openerText) {
    const match = /^\s*(class|def|for|while|switch|try)\b\s*([A-Za-z_][A-Za-z0-9_:.]*)?/.exec(openerText);
    return match ? `${match[1]}${match[2] ? " " + match[2] : ""}` : "";
}
// Every block that contains the line, outermost first. Blocks that enclose a
// block also enclose the line, so the index in this list is the nesting depth.
function enclosingBlocks(pairs, line) {
    return pairs
        .filter((pair) => pair.openerLine <= line && pair.endLine >= line)
        .sort((a, b) => a.openerLine - b.openerLine);
}
const blockPairCache = new WeakMap();
function cachedEndBlockPairs(document) {
    const cached = blockPairCache.get(document);
    if (cached && cached.version === document.version)
        return cached;
    const lines = [];
    for (let line = 0; line < document.lineCount; line++)
        lines.push(document.lineAt(line).text);
    const entry = { version: document.version, lines, pairs: endBlockPairs(lines) };
    blockPairCache.set(document, entry);
    return entry;
}
// Typing fires both a document change and a selection change; the highlight
// depends only on the text version, the cursor line and the label setting, so
// an update for a state already drawn is skipped.
const drawnBlockState = new WeakMap();
function updateEndDecorations(editor) {
    if (editor.document.languageId !== "felidae")
        return;
    const showLabels = vscode.workspace.getConfiguration("felidae", editor.document.uri).get("endLabels", true);
    const stateKey = editor.document.version + ":" + editor.selection.active.line + ":" + showLabels;
    if (drawnBlockState.get(editor) === stateKey)
        return;
    drawnBlockState.set(editor, stateKey);
    const { lines, pairs } = cachedEndBlockPairs(editor.document);
    const chain = enclosingBlocks(pairs, editor.selection.active.line);
    const strong = blockStrongDecorations.map(() => []);
    const soft = blockSoftDecorations.map(() => []);
    chain.forEach((pair, depth) => {
        const level = depth % BLOCK_LEVEL_COUNT;
        const innermost = depth === chain.length - 1;
        const label = innermost && showLabels ? endBlockLabel(lines[pair.openerLine]) : "";
        const target = innermost ? strong[level] : soft[level];
        target.push({ range: new vscode.Range(pair.openerLine, pair.openerStart, pair.openerLine, pair.openerStart + pair.openerLength) }, {
            range: new vscode.Range(pair.endLine, pair.endStart, pair.endLine, pair.endStart + 3),
            renderOptions: label ? { after: { contentText: `← ${label}` } } : undefined
        });
    });
    blockStrongDecorations.forEach((type, level) => editor.setDecorations(type, strong[level]));
    blockSoftDecorations.forEach((type, level) => editor.setDecorations(type, soft[level]));
}
function refreshEndDecorations(document) {
    for (const editor of vscode.window.visibleTextEditors) {
        if (!document || editor.document === document)
            updateEndDecorations(editor);
    }
}
class FelidaeFoldingRangeProvider {
    provideFoldingRanges(document) {
        if (document.languageId !== "felidae")
            return [];
        const ranges = [];
        const lines = [];
        for (let i = 0; i < document.lineCount; i++)
            lines.push(document.lineAt(i).text);
        // A line beginning a new top-level construct ends the previous region.
        // The optional `extend Parent` clause must be allowed here, or a fact
        // written as `Child extend Parent(...)` is not seen as starting anything
        // and the whole run of facts collapses into one region. The optional
        // `def` prefix is the same story: every declaration except a bare fact
        // requires one now, so without allowing it here a run of `def`-prefixed
        // methods collapsed into one region the same way.
        const startsTopLevel = (line) => /^(?:def[ \t]+)?[A-Za-z_][A-Za-z0-9_:.]*(?:[ \t]+extend[ \t]+[A-Za-z_][A-Za-z0-9_]*)?[ \t]*\(/.test(line) ||
            /^import\b/.test(line) ||
            /^[A-Za-z_][A-Za-z0-9_]*[ \t]*:=/.test(line);
        // Explicit `end` is authoritative: fold precisely from its opening
        // declaration/class line to the matching closer, including nested blocks.
        const explicitlyFolded = new Set();
        for (const pair of endBlockPairs(lines)) {
            if (pair.endLine <= pair.openerLine)
                continue;
            ranges.push(new vscode.FoldingRange(pair.openerLine, pair.endLine, vscode.FoldingRangeKind.Region));
            explicitlyFolded.add(pair.openerLine);
        }
        for (let i = 0; i < lines.length; i++) {
            if (!startsTopLevel(lines[i]) || explicitlyFolded.has(i))
                continue;
            let end = i;
            for (let j = i + 1; j < lines.length; j++) {
                if (startsTopLevel(lines[j]))
                    break;
                // Blank lines and comments trailing a declaration belong to whatever
                // comes next - a comment here is the next declaration's doc. Ending
                // at the last real body line keeps a one-line fact unfoldable instead
                // of letting it swallow the following comment.
                if (lines[j].trim().length > 0 && !/^[ \t]*#/.test(lines[j]))
                    end = j;
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
            if (isComment && commentStart < 0)
                commentStart = i;
            else if (!isComment && commentStart >= 0) {
                if (i - 1 > commentStart) {
                    ranges.push(new vscode.FoldingRange(commentStart, i - 1, vscode.FoldingRangeKind.Comment));
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
class FelidaeInlayHintsProvider {
    provideInlayHints(document, range) {
        if (document.languageId !== "felidae")
            return [];
        const enabled = vscode.workspace
            .getConfiguration("felidae", document.uri)
            .get("inlayHints.parameterNames", true);
        if (!enabled)
            return [];
        const tokens = lexDocument(document).tokens;
        const hints = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.kind !== "ident" || tokens[i + 1]?.kind !== "lparen")
                continue;
            if (token.line < range.start.line || token.line > range.end.line)
                continue;
            // A declaration head already lists its parameters.
            if (tokens[i - 1]?.text === "def")
                continue;
            const close = findMatchingParen(tokens, i + 1);
            if (close === undefined)
                continue;
            const nameParts = [token.text];
            let cursor = i - 1;
            while (cursor >= 1 &&
                (tokens[cursor].kind === "dot" || tokens[cursor].kind === "colon") &&
                tokens[cursor - 1]?.kind === "ident") {
                nameParts.unshift(tokens[cursor - 1].text);
                cursor -= 2;
            }
            const resolved = resolveCall(document, nameParts.join(":"));
            if (!resolved || resolved.params.length === 0)
                continue;
            let depth = 0;
            let argument = 0;
            let argumentStart = i + 2;
            for (let j = i + 2; j <= close; j++) {
                const kind = tokens[j].kind;
                const atArgumentEnd = j === close || (kind === "comma" && depth === 0);
                if (!atArgumentEnd) {
                    if (kind === "lparen" || kind === "lbrace" || kind === "lbracket")
                        depth++;
                    else if (kind === "rparen" || kind === "rbrace" || kind === "rbracket")
                        depth--;
                    continue;
                }
                const first = tokens[argumentStart];
                const parameter = resolved.params[argument];
                const isNamed = first?.kind === "ident" && tokens[argumentStart + 1]?.kind === "colon";
                if (first && argumentStart < j && !isNamed && parameter && first.text !== parameter.name) {
                    const hint = new vscode.InlayHint(new vscode.Position(first.line, first.start), parameter.name + ":", vscode.InlayHintKind.Parameter);
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
function selectionChain(document, position) {
    const sameRange = (a, b) => a.start.line === b.start.line && a.start.character === b.start.character &&
        a.end.line === b.end.line && a.end.character === b.end.character;
    const chain = [];
    const push = (range) => {
        if (chain.length === 0 || !sameRange(chain[chain.length - 1], range))
            chain.push(range);
    };
    const word = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (word)
        push(word);
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
class FelidaeSelectionRangeProvider {
    provideSelectionRanges(document, positions) {
        return positions.map((position) => {
            let parent;
            const chain = selectionChain(document, position);
            for (let i = chain.length - 1; i >= 0; i--)
                parent = new vscode.SelectionRange(chain[i], parent);
            return parent ?? new vscode.SelectionRange(new vscode.Range(position, position));
        });
    }
}
const CLASS_DECLARATION_PATTERN = /^[ \t]*class[ \t]+([A-Za-z_][A-Za-z0-9_.]*)(?:[ \t]+extends?[ \t]+([^#\n]*))?/gm;
async function findClassDeclarations() {
    const found = [];
    for (const document of await felidaeDocuments()) {
        const text = document.getText();
        const pattern = new RegExp(CLASS_DECLARATION_PATTERN.source, "gm");
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const start = document.positionAt(match.index + match[0].indexOf(match[1]));
            const parents = (match[2] ?? "").split(",").map((part) => part.trim()).filter((part) => part.length > 0);
            found.push({ name: match[1], parents, document, line: start.line, nameStart: start.character });
        }
    }
    return found;
}
function typeHierarchyItem(declaration) {
    const range = new vscode.Range(declaration.line, declaration.nameStart, declaration.line, declaration.nameStart + declaration.name.length);
    return new vscode.TypeHierarchyItem(vscode.SymbolKind.Class, declaration.name, declaration.parents.length ? "extends " + declaration.parents.join(", ") : "class", declaration.document.uri, range, range);
}
class FelidaeTypeHierarchyProvider {
    async prepareTypeHierarchy(document, position) {
        const word = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_.]*/);
        if (!word)
            return undefined;
        const name = document.getText(word);
        const declarations = (await findClassDeclarations()).filter((declaration) => declaration.name === name);
        return declarations.length ? declarations.map(typeHierarchyItem) : undefined;
    }
    async provideTypeHierarchySupertypes(item) {
        const all = await findClassDeclarations();
        const self = all.find((declaration) => declaration.name === item.name);
        if (!self)
            return [];
        return self.parents.flatMap((parent) => all.filter((declaration) => declaration.name === parent).map(typeHierarchyItem));
    }
    async provideTypeHierarchySubtypes(item) {
        return (await findClassDeclarations())
            .filter((declaration) => declaration.parents.includes(item.name))
            .map(typeHierarchyItem);
    }
}
// Tasks: Terminal > Run Task > felidae. The "$felidae" problem matcher turns
// interpreter errors ("error: file.fx: ... at line N, column M") into entries
// in the Problems panel.
class FelidaeTaskProvider {
    provideTasks() {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || document.languageId !== "felidae")
            return [];
        return ["run", "check"].map((command) => this.build({ type: "felidae", command, file: document.uri.fsPath }, document.uri));
    }
    resolveTask(task) {
        const definition = task.definition;
        if (definition.type !== "felidae")
            return undefined;
        const active = vscode.window.activeTextEditor?.document;
        const file = definition.file ?? active?.uri.fsPath;
        if (!file)
            return undefined;
        return this.build({ type: "felidae", command: definition.command ?? "run", file }, vscode.Uri.file(file));
    }
    build(definition, uri) {
        const executable = resolveInterpreterPath(uri);
        const args = definition.command === "check" ? [definition.file, "--check-json"] : [definition.file];
        const execution = new vscode.ShellExecution({ value: executable, quoting: vscode.ShellQuoting.Strong }, args.map((value) => ({ value, quoting: vscode.ShellQuoting.Strong })));
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const task = new vscode.Task(definition, folder ?? vscode.TaskScope.Workspace, (definition.command === "check" ? "Check " : "Run ") + path.basename(definition.file), "felidae", execution, "$felidae");
        if (definition.command === "run")
            task.group = vscode.TaskGroup.Build;
        return task;
    }
}
// Auto-insert "end": pressing Enter after a block opener (def ... =>, class,
// for/while ... then, switch, try) that has no "end" at its own indentation adds
// one below, leaving the cursor in the body. Matching is by indentation, which
// is how the formatter lays blocks out, so a nested opener is never confused
// with its parent's "end".
function isBlockOpenerLine(text) {
    const code = text.replace(/#.*$/, "");
    return /^\s*(?:class\b|switch\b|try\s*$)/.test(code) ||
        /^\s*(?:for|while)\b.*\bthen\s*$/.test(code) ||
        /^\s*def\s+[A-Za-z_][A-Za-z0-9_:.]*\s*\([^)]*\)\s*=>\s*(?:\(\s*\))?\s*$/.test(code);
}
function indentOf(text) {
    return text.length - text.trimStart().length;
}
// True when the opener on openerLine is not closed by an "end" at its own
// indentation. The blank line the user just created (and any other blank or
// comment-only line) is skipped; the first line that is not indented deeper
// than the opener must be that "end".
function openerNeedsEnd(lines, openerLine) {
    if (!isBlockOpenerLine(lines[openerLine]))
        return false;
    const indent = indentOf(lines[openerLine]);
    for (let line = openerLine + 1; line < lines.length; line++) {
        const text = lines[line];
        if (text.trim() === "" || text.trim().startsWith("#"))
            continue;
        if (indentOf(text) > indent)
            continue;
        return !(indentOf(text) === indent && /^end\b/.test(text.trim()));
    }
    return true;
}
function autoInsertEnd(event) {
    const document = event.document;
    if (document.languageId !== "felidae" || event.reason !== undefined)
        return;
    if (event.contentChanges.length !== 1)
        return;
    const change = event.contentChanges[0];
    if (!/^\r?\n[ \t]*$/.test(change.text))
        return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document)
        return;
    if (!vscode.workspace.getConfiguration("felidae", document.uri).get("autoInsertEnd", true))
        return;
    const openerLine = change.range.start.line;
    const lines = [];
    for (let line = 0; line < document.lineCount; line++)
        lines.push(document.lineAt(line).text);
    if (!openerNeedsEnd(lines, openerLine))
        return;
    const cursorLine = openerLine + 1;
    const cursor = new vscode.Position(cursorLine, document.lineAt(cursorLine).text.length);
    const indent = lines[openerLine].slice(0, indentOf(lines[openerLine]));
    void editor
        .edit((builder) => builder.insert(cursor, "\n" + indent + "end"), { undoStopBefore: false, undoStopAfter: false })
        .then((applied) => {
        if (applied)
            editor.selection = new vscode.Selection(cursor, cursor);
    });
}
async function findMethodDeclarations() {
    const found = [];
    for (const document of await felidaeDocuments()) {
        for (const declaration of declarationsOf(document)) {
            if (declaration.terminator !== "=>")
                continue;
            const start = document.positionAt(declaration.nameOffset);
            found.push({ name: declaration.name, document, line: start.line, nameStart: start.character });
        }
    }
    return found;
}
function methodItem(declaration) {
    const { pairs } = cachedEndBlockPairs(declaration.document);
    const block = pairs.find((pair) => pair.openerLine === declaration.line);
    const endLine = block ? block.endLine : declaration.line;
    const selection = new vscode.Range(declaration.line, declaration.nameStart, declaration.line, declaration.nameStart + declaration.name.length);
    const whole = new vscode.Range(declaration.line, 0, endLine, declaration.document.lineAt(endLine).text.length);
    return new vscode.CallHierarchyItem(vscode.SymbolKind.Method, declaration.name, "", declaration.document.uri, whole, selection);
}
// Every "name(" call in the document, as the callee name plus its range.
function callSites(document) {
    const tokens = lexDocument(document).tokens;
    const sites = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind !== "ident" || tokens[i + 1]?.kind !== "lparen" || tokens[i - 1]?.text === "def")
            continue;
        sites.push({ name: token.text, range: new vscode.Range(token.line, token.start, token.line, token.end) });
    }
    return sites;
}
class FelidaeCallHierarchyProvider {
    async prepareCallHierarchy(document, position) {
        const word = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!word)
            return undefined;
        const name = document.getText(word);
        const declarations = (await findMethodDeclarations()).filter((declaration) => declaration.name === name);
        return declarations.length ? declarations.map(methodItem) : undefined;
    }
    async provideCallHierarchyIncomingCalls(item) {
        const declarations = await findMethodDeclarations();
        const result = [];
        for (const caller of declarations) {
            const { pairs } = cachedEndBlockPairs(caller.document);
            const block = pairs.find((pair) => pair.openerLine === caller.line);
            if (!block)
                continue;
            const ranges = callSites(caller.document)
                .filter((site) => site.name === item.name && site.range.start.line > block.openerLine && site.range.start.line < block.endLine)
                .map((site) => site.range);
            if (ranges.length)
                result.push(new vscode.CallHierarchyIncomingCall(methodItem(caller), ranges));
        }
        return result;
    }
    async provideCallHierarchyOutgoingCalls(item) {
        const declarations = await findMethodDeclarations();
        const owner = declarations.find((declaration) => declaration.name === item.name && declaration.document.uri.toString() === item.uri.toString());
        if (!owner)
            return [];
        const { pairs } = cachedEndBlockPairs(owner.document);
        const block = pairs.find((pair) => pair.openerLine === owner.line);
        if (!block)
            return [];
        const byCallee = new Map();
        for (const site of callSites(owner.document)) {
            if (site.range.start.line <= block.openerLine || site.range.start.line >= block.endLine)
                continue;
            const ranges = byCallee.get(site.name) ?? [];
            ranges.push(site.range);
            byCallee.set(site.name, ranges);
        }
        const result = [];
        for (const [name, ranges] of byCallee) {
            for (const callee of declarations.filter((declaration) => declaration.name === name)) {
                result.push(new vscode.CallHierarchyOutgoingCall(methodItem(callee), ranges));
            }
        }
        return result;
    }
}
class FelidaeCodeLensProvider {
    provideCodeLenses(document) {
        if (document.languageId !== "felidae")
            return [];
        const lenses = [];
        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            // Same column-0 anchoring as hasMainMethod: an indented `main(...)`
            // call is a call, not the entry point.
            if (!MAIN_DECLARATION_PATTERN.test(text))
                continue;
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
function defKindAt(tokens, defIndex) {
    if (tokens[defIndex + 2]?.kind !== "lparen")
        return "binding";
    const close = findMatchingParen(tokens, defIndex + 2);
    return close !== undefined && tokens[close + 1]?.kind === "arrow" ? "function" : "fact";
}
function classifyDefs(tokens) {
    const defs = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind !== "ident" || token.text !== "def" || tokens[i + 1]?.kind !== "ident")
            continue;
        defs.push({ kind: defKindAt(tokens, i), line: token.line, start: token.start, end: token.end });
    }
    return defs;
}
// The three kinds of def get three colours that do not depend on the active
// theme: TextMate scopes and semantic tokens only name the kind, and most
// themes paint every keyword alike, while decorations always win. The colours
// are theme colours (felidae.defFunction / defFact / defBinding).
const defDecorations = {
    function: vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor("felidae.defFunction"), fontWeight: "bold" }),
    fact: vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor("felidae.defFact"), fontWeight: "bold" }),
    binding: vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor("felidae.defBinding"), fontWeight: "bold" })
};
function updateDefDecorations(editor) {
    if (editor.document.languageId !== "felidae")
        return;
    const buckets = { function: [], fact: [], binding: [] };
    for (const def of classifyDefs(lexDocument(editor.document).tokens)) {
        buckets[def.kind].push(new vscode.Range(def.line, def.start, def.line, def.end));
    }
    Object.keys(buckets).forEach((kind) => editor.setDecorations(defDecorations[kind], buckets[kind]));
}
function refreshDefDecorations(document) {
    for (const editor of vscode.window.visibleTextEditors) {
        if (!document || editor.document === document)
            updateDefDecorations(editor);
    }
}
let defDecorationTimer;
function scheduleDefDecorations(document) {
    if (document.languageId !== "felidae")
        return;
    if (defDecorationTimer)
        clearTimeout(defDecorationTimer);
    defDecorationTimer = setTimeout(() => refreshDefDecorations(document), 120);
}
class FelidaeSemanticTokensProvider {
    provideDocumentSemanticTokens(document) {
        const builder = new vscode.SemanticTokensBuilder(semanticLegend);
        const tokens = lexDocument(document).tokens;
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.kind !== "ident" || token.text === "_")
                continue;
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
            if (isKeyword)
                continue;
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
            const isValuePosition = previous?.kind === "colon" ||
                previous?.kind === "comma" ||
                previous?.kind === "lparen" ||
                previous?.kind === "comparison" ||
                previous?.kind === "bind" ||
                next?.kind === "comparison";
            const isBareValueReference = !/^[A-Z]/.test(token.text) &&
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
function isInsideMethodHead(tokens, index) {
    let left = index;
    while (left >= 0 && tokens[left].kind !== "lparen" && tokens[left].kind !== "dot") {
        left--;
    }
    if (left < 1 || tokens[left].kind !== "lparen" || tokens[left - 1]?.kind !== "ident")
        return false;
    let depth = 0;
    for (let right = left; right < tokens.length; right++) {
        const token = tokens[right];
        if (token.kind === "lparen")
            depth++;
        if (token.kind === "rparen") {
            depth--;
            if (depth === 0) {
                return tokens[right + 1]?.kind === "arrow";
            }
        }
    }
    return false;
}
function collectHeadParams(argsText) {
    const params = [];
    const seen = new Set();
    let depth = 0;
    let segmentStart = 0;
    const flush = (end) => {
        const segment = argsText.slice(segmentStart, end).trim();
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!=)/.exec(segment);
        if (!match || seen.has(match[1]))
            return;
        seen.add(match[1]);
        const type = segment.slice(match[0].length).trim();
        params.push(type ? { name: match[1], type } : { name: match[1] });
    };
    for (let i = 0; i < argsText.length; i++) {
        const ch = argsText[i];
        if (ch === "(" || ch === "{" || ch === "[")
            depth++;
        else if (ch === ")" || ch === "}" || ch === "]")
            depth = Math.max(0, depth - 1);
        else if (ch === "," && depth === 0) {
            flush(i);
            segmentStart = i + 1;
        }
    }
    flush(argsText.length);
    return params;
}
function normalizeGraphName(name) {
    return name.replace(/\./g, ":");
}
const FELIDAE_LIBRARY_NAMES = "array|comparison|console|csv|db|exception|fact|fact_analysis|file|flibrary|fn|group|gtk|http|json|list|logic|math|ml|package|pair|plot|prelude|process|qt|set|smoke|str|system|thread|wordnet";
function isLibraryName(name) {
    return new RegExp(`^(${FELIDAE_LIBRARY_NAMES})(:|$)`).test(name);
}
function isLibraryNamespace(name) {
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
const DECLARATION_PATTERN = /^(?:def[ \t]+)?([A-Za-z_][A-Za-z0-9_:.]*)(?:[ \t]+extend[ \t]+([A-Za-z_][A-Za-z0-9_]*))?[ \t]*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)[ \t]*(=>|\.|$)/gm;
// A top-level binding: `def name := v.` or `def name: Type := v.` (an indented
// def is a local or a class field, not a top-level symbol).
const GLOBAL_BINDING_PATTERN = /^def[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?::[^=\n]*)?:=/gm;
const declarationCache = new WeakMap();
function scanDeclarations(document) {
    const text = document.getText();
    const pattern = new RegExp(DECLARATION_PATTERN);
    const items = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        items.push({ name: match[1], args: match[3], terminator: match[4], nameOffset: match.index + match[0].indexOf(match[1]) });
    }
    return items;
}
function declarationsOf(document) {
    if (typeof document.version !== "number")
        return scanDeclarations(document);
    const cached = declarationCache.get(document);
    if (cached && cached.version === document.version)
        return cached.items;
    const items = scanDeclarations(document);
    declarationCache.set(document, { version: document.version, items });
    return items;
}
const checkSymbolCache = new Map();
const checkSymbolsChanged = new vscode.EventEmitter();
function checkedPosition(document, position) {
    const line = Math.min(Math.max(0, Number(position?.line ?? 1) - 1), Math.max(0, document.lineCount - 1));
    const column = Math.min(Math.max(0, Number(position?.column ?? 1) - 1), document.lineAt(line).text.length);
    return new vscode.Position(line, column);
}
function checkedSymbol(document, value) {
    const start = checkedPosition(document, value.start);
    const rawEnd = checkedPosition(document, value.end);
    const end = rawEnd.isAfter(start) ? rawEnd : start.translate(0, 1);
    const range = new vscode.Range(start, end);
    const kinds = {
        binding: vscode.SymbolKind.Variable,
        call: vscode.SymbolKind.Function,
        class: vscode.SymbolKind.Class,
        fact: vscode.SymbolKind.Struct,
        function: vscode.SymbolKind.Function,
        import: vscode.SymbolKind.Module,
        method: vscode.SymbolKind.Method
    };
    const symbol = new vscode.DocumentSymbol(value.name, value.kind, kinds[value.kind] ?? vscode.SymbolKind.Object, range, range);
    symbol.children = (value.children ?? []).map((child) => checkedSymbol(document, child));
    return symbol;
}
class FelidaeDocumentSymbolProvider {
    constructor() {
        this.onDidChangeDocumentSymbol = checkSymbolsChanged.event;
    }
    provideDocumentSymbols(document) {
        if (document.languageId !== "felidae")
            return [];
        return (checkSymbolCache.get(document.uri.toString()) ?? [])
            .map((symbol) => checkedSymbol(document, symbol));
    }
}
function tokenIndexBefore(tokens, position) {
    let index = -1;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.line > position.line)
            break;
        if (token.line === position.line && token.start >= position.character)
            break;
        index = i;
    }
    return index;
}
function builtinDocKeysForNamespace(baseName) {
    const prefix = `${baseName}:`;
    return Object.keys(builtinDocs).filter((key) => key.startsWith(prefix));
}
function builtinDocCompletionsForNamespace(baseName) {
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
function namedArgCompletion(name, detail) {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
    item.insertText = new vscode.SnippetString(`${name}: $0`);
    if (detail)
        item.detail = detail;
    return item;
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
function resolveCall(document, callName) {
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
    const matchesName = (name) => name === normalized || name === simpleName || normalizeGraphName(name) === simpleName;
    const summary = symbolSummaryCache.get(document.uri.toString());
    if (summary) {
        for (const group of [summary.methods, summary.facts]) {
            for (const definition of group ?? []) {
                if (!matchesName(definition.name) || !definition.params?.length)
                    continue;
                return {
                    label: definition.name,
                    params: definition.params,
                    detail: group === summary.facts ? `fact ${definition.name}` : `method ${definition.name}`
                };
            }
        }
    }
    for (const declaration of declarationsOf(document)) {
        if (!matchesName(declaration.name))
            continue;
        return {
            label: declaration.name,
            params: collectHeadParams(declaration.args),
            detail: declaration.terminator === "=>" ? `method ${declaration.name}` : `fact ${declaration.name}`
        };
    }
    return undefined;
}
function completionsForCallFields(document, callName, suppliedKeys = new Set()) {
    const resolved = resolveCall(document, callName);
    if (!resolved)
        return [];
    return resolved.params
        // A key already written earlier in this same call is not a useful
        // suggestion for the argument currently being typed.
        .filter((param) => !suppliedKeys.has(param.name))
        .map((param) => namedArgCompletion(param.name, param.type ? `${resolved.detail} — ${param.type}` : resolved.detail));
}
function completionsForScope(document, tokens, index) {
    const items = new Map();
    const add = (name, kind, detail) => {
        if (!name || items.has(name))
            return;
        const item = new vscode.CompletionItem(name, kind);
        if (detail)
            item.detail = detail;
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
        if (key.includes(":") || key === "lambda")
            continue;
        add(key, vscode.CompletionItemKind.Function, builtinDocs[key].heading);
    }
    const text = document.getText();
    const classDeclaration = /^class[ \t]+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
    let classMatch;
    while ((classMatch = classDeclaration.exec(text)) !== null) {
        add(classMatch[1], vscode.CompletionItemKind.Class, "class");
    }
    for (const declaration of declarationsOf(document)) {
        if (isLibraryName(normalizeGraphName(declaration.name)))
            continue;
        const isMethod = declaration.terminator === "=>";
        add(declaration.name, isMethod ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Struct, isMethod ? "method" : "fact");
    }
    const cached = symbolSummaryCache.get(document.uri.toString());
    if (cached) {
        for (const method of cached.methods)
            add(method.name, vscode.CompletionItemKind.Method, "method (felidae)");
        for (const fact of cached.facts)
            add(fact.name, vscode.CompletionItemKind.Struct, "fact (felidae)");
        for (const global of cached.globals)
            add(global.name, vscode.CompletionItemKind.Constant, "global (felidae)");
    }
    return [...items.values()];
}
// Shows the expected `key:` parameters while the cursor is inside a call's
// parentheses, highlighting the argument slot being typed. Parameter data
// comes from resolveCall, the same resolver keyword-argument completion uses.
class FelidaeSignatureHelpProvider {
    provideSignatureHelp(document, position) {
        if (document.languageId !== "felidae")
            return undefined;
        const tokens = lexDocument(document).tokens;
        const index = tokenIndexBefore(tokens, position);
        const call = enclosingCall(tokens, index);
        if (!call)
            return undefined;
        const resolved = resolveCall(document, call.name);
        if (!resolved || resolved.params.length === 0)
            return undefined;
        const parameters = resolved.params.map((param) => new vscode.ParameterInformation(param.type ? `${param.name}: ${param.type}` : `${param.name}:`));
        const signature = new vscode.SignatureInformation(`${resolved.label}(${parameters.map((parameter) => parameter.label).join(", ")})`);
        signature.parameters = parameters;
        if (resolved.documentation)
            signature.documentation = resolved.documentation;
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
        }
        else {
            const firstUnsupplied = resolved.params.findIndex((param) => !suppliedKeys.has(param.name));
            help.activeParameter =
                firstUnsupplied >= 0 ? firstUnsupplied : Math.min(activeParameter, parameters.length - 1);
        }
        return help;
    }
    // The key of the argument currently being typed, i.e. the `ident` that
    // starts the slot the cursor is in (`foo(a: 1, bar|` -> "bar").
    keyBeingTyped(tokens, openParen, index) {
        let depth = 0;
        let slotStart = openParen + 1;
        for (let i = openParen + 1; i <= index && i < tokens.length; i++) {
            const kind = tokens[i].kind;
            if (kind === "lparen" || kind === "lbrace" || kind === "lbracket")
                depth++;
            else if (kind === "rparen" || kind === "rbrace" || kind === "rbracket")
                depth--;
            else if (kind === "comma" && depth === 0)
                slotStart = i + 1;
        }
        const first = tokens[slotStart];
        return first?.kind === "ident" ? first.text : undefined;
    }
}
class FelidaeCompletionItemProvider {
    provideCompletionItems(document, position) {
        if (document.languageId !== "felidae")
            return [];
        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(linePrefix);
        if (dotMatch) {
            const namespaceItems = builtinDocCompletionsForNamespace(dotMatch[1]);
            if (namespaceItems.length)
                return namespaceItems;
        }
        const tokens = lexDocument(document).tokens;
        const index = tokenIndexBefore(tokens, position);
        const items = new Map();
        // Keep named-argument completion active while its key is being typed
        // (`call(na|`), not only immediately after `(` or `,`.
        if (/[(,]\s*[A-Za-z_]*$/.test(linePrefix)) {
            const call = enclosingCall(tokens, index);
            if (call) {
                const { suppliedKeys } = callArgumentState(tokens, call.openParen, index);
                const fieldItems = completionsForCallFields(document, call.name, suppliedKeys);
                rankNamedArguments(document, call.name, suppliedKeys, fieldItems);
                for (const item of fieldItems) {
                    items.set(item.label, item);
                }
            }
        }
        const scopeItems = completionsForScope(document, tokens, index);
        rankScopeCompletions(document, position, scopeItems);
        for (const item of scopeItems) {
            if (!items.has(item.label))
                items.set(item.label, item);
        }
        return [...items.values()];
    }
}
// VS Code orders a completion list by `sortText`, so ranking is applied by
// assigning sort keys rather than by reordering the array. Items keep their
// existing labels/details; only their order changes. When no model is bundled
// (mlRanking finds no resources/models) both helpers no-op and the list stays
// exactly as it was before ranking existed.
function rankByScore(items, score) {
    const scored = items.map((item, position) => ({ item, position, score: score(item) }));
    scored.sort((a, b) => b.score - a.score || a.position - b.position);
    scored.forEach((entry, rank) => {
        // Zero-padded so lexicographic sortText matches numeric rank.
        entry.item.sortText = String(rank).padStart(4, "0");
    });
}
function completionKindOf(item) {
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
function rankScopeCompletions(document, position, items) {
    if (!ml.isCompletionRankingEnabled() || items.length < 2)
        return;
    const line = document.lineAt(position.line).text;
    const prefixMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(line.slice(0, position.character));
    const textAbove = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const context = ml.buildCompletionContext(textAbove, prefixMatch ? prefixMatch[1] : "");
    rankByScore(items, (item) => ml.scoreCompletion(item.label, completionKindOf(item), context));
}
function rankNamedArguments(document, callName, suppliedKeys, items) {
    if (!ml.isNextParamRankingEnabled() || items.length < 2)
        return;
    const resolved = resolveCall(document, callName);
    if (!resolved)
        return;
    const declIndexOf = new Map(resolved.params.map((param, i) => [param.name, i]));
    const firstUnsuppliedIndex = resolved.params.findIndex((param) => !suppliedKeys.has(param.name));
    const context = {
        paramsTotal: resolved.params.length,
        suppliedCount: suppliedKeys.size,
        firstUnsuppliedIndex,
        isBuiltinCall: builtinDocs[callName.replace(/\./g, ":")] !== undefined
    };
    rankByScore(items, (item) => {
        const name = item.label;
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
const occurrenceCache = new WeakMap();
function indexOccurrences(document) {
    const byName = new Map();
    for (const token of lexDocument(document).tokens) {
        if (token.kind !== "ident")
            continue;
        const ranges = byName.get(token.text) ?? [];
        ranges.push(new vscode.Range(new vscode.Position(token.line, token.start), new vscode.Position(token.line, token.end)));
        byName.set(token.text, ranges);
    }
    return byName;
}
function symbolOccurrences(document, name) {
    if (typeof document.version !== "number")
        return indexOccurrences(document).get(name) ?? [];
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
function scopedOccurrences(document, name, position) {
    const all = symbolOccurrences(document, name);
    if (isTopLevelSymbol(document, name))
        return all;
    let outer;
    for (const pair of cachedEndBlockPairs(document).pairs) {
        if (pair.openerLine > position.line || pair.endLine < position.line)
            continue;
        if (!outer || pair.openerLine < outer.openerLine)
            outer = pair;
    }
    if (!outer)
        return all;
    const { openerLine, endLine } = outer;
    return all.filter((range) => range.start.line >= openerLine && range.start.line <= endLine);
}
function identifierAt(document, position) {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!range)
        return undefined;
    return { name: document.getText(range), range };
}
/** True when `name` is declared at top level, i.e. visible to other files. */
const topLevelCache = new WeakMap();
function topLevelNames(document) {
    const names = new Set();
    for (const declaration of declarationsOf(document)) {
        names.add(declaration.name);
        names.add(normalizeGraphName(declaration.name));
    }
    const binding = new RegExp(GLOBAL_BINDING_PATTERN);
    const text = document.getText();
    let match;
    while ((match = binding.exec(text)) !== null)
        names.add(match[1]);
    return names;
}
function isTopLevelSymbol(document, name) {
    if (typeof document.version !== "number")
        return topLevelNames(document).has(name);
    let cached = topLevelCache.get(document);
    if (!cached || cached.version !== document.version) {
        cached = { version: document.version, names: topLevelNames(document) };
        topLevelCache.set(document, cached);
    }
    return cached.names.has(name);
}
// The workspace file list is cached and only refreshed when a .fx file is
// created or deleted (see the file watcher in activate).
// Generated and dependency folders are never searched for Felidae sources
// (build output and diagnostic probes live under build/).
const FX_EXCLUDE = "**/{node_modules,build,out,.git}/**";
let workspaceFileCache;
function invalidateWorkspaceFiles() {
    workspaceFileCache = undefined;
}
async function felidaeFileUris() {
    if (!workspaceFileCache) {
        workspaceFileCache = await vscode.workspace.findFiles("**/*.fx", FX_EXCLUDE, 500);
    }
    return workspaceFileCache;
}
// With "mentioning", only files whose text contains that name are opened:
// open editors are checked in memory and the rest are read as bytes, so a
// reference search over a large workspace opens a handful of documents rather
// than all of them.
async function felidaeDocuments(mentioning) {
    const open = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
    const documents = [];
    for (const uri of await felidaeFileUris()) {
        try {
            const live = open.get(uri.toString());
            if (live) {
                if (!mentioning || live.getText().includes(mentioning))
                    documents.push(live);
                continue;
            }
            if (mentioning) {
                const bytes = await vscode.workspace.fs.readFile(uri);
                if (!Buffer.from(bytes).toString("utf8").includes(mentioning))
                    continue;
            }
            documents.push(await vscode.workspace.openTextDocument(uri));
        }
        catch {
            // Unreadable or binary file: skip rather than fail the whole request.
        }
    }
    return documents;
}
class FelidaeDocumentHighlightProvider {
    provideDocumentHighlights(document, position) {
        const found = identifierAt(document, position);
        if (!found)
            return [];
        if (["class", "def", "for", "while", "switch", "try", "end"].includes(found.name)) {
            const pair = cachedEndBlockPairs(document).pairs.find((candidate) => (candidate.openerLine === position.line && found.name !== "end") ||
                (candidate.endLine === position.line && found.name === "end"));
            if (pair) {
                const opening = new vscode.Range(new vscode.Position(pair.openerLine, pair.openerStart), new vscode.Position(pair.openerLine, pair.openerStart + pair.openerLength));
                const closing = new vscode.Range(new vscode.Position(pair.endLine, pair.endStart), new vscode.Position(pair.endLine, pair.endStart + 3));
                return [opening, closing].map((range) => new vscode.DocumentHighlight(range, vscode.DocumentHighlightKind.Text));
            }
        }
        return scopedOccurrences(document, found.name, position).map((range) => new vscode.DocumentHighlight(range, vscode.DocumentHighlightKind.Text));
    }
}
class FelidaeReferenceProvider {
    async provideReferences(document, position) {
        const found = identifierAt(document, position);
        if (!found)
            return [];
        const locations = scopedOccurrences(document, found.name, position).map((range) => new vscode.Location(document.uri, range));
        // A local binding or parameter means nothing in another file, so only
        // top-level declarations are worth a workspace-wide scan.
        if (!isTopLevelSymbol(document, found.name))
            return locations;
        for (const other of await felidaeDocuments(found.name)) {
            if (other.uri.toString() === document.uri.toString())
                continue;
            for (const range of symbolOccurrences(other, found.name)) {
                locations.push(new vscode.Location(other.uri, range));
            }
        }
        return locations;
    }
}
class FelidaeRenameProvider {
    prepareRename(document, position) {
        const found = identifierAt(document, position);
        if (!found)
            throw new Error("Select a Felidae identifier to rename.");
        // Builtins live in the interpreter, not in the user's sources.
        if (builtinDocs[found.name] || isLibraryNamespace(found.name)) {
            throw new Error(`'${found.name}' is a Felidae builtin and cannot be renamed.`);
        }
        return found.range;
    }
    async provideRenameEdits(document, position, newName) {
        const found = identifierAt(document, position);
        if (!found)
            return undefined;
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
                if (other.uri.toString() === document.uri.toString())
                    continue;
                for (const range of symbolOccurrences(other, found.name)) {
                    edit.replace(other.uri, range, newName);
                }
            }
        }
        return edit;
    }
}
class FelidaeWorkspaceSymbolProvider {
    async provideWorkspaceSymbols(query) {
        const symbols = [];
        const needle = query.toLowerCase();
        for (const document of await felidaeDocuments()) {
            const text = document.getText();
            for (const declaration of declarationsOf(document)) {
                const name = declaration.name;
                if (needle && !name.toLowerCase().includes(needle))
                    continue;
                const start = document.positionAt(declaration.nameOffset);
                symbols.push(new vscode.SymbolInformation(name, declaration.terminator === "=>" ? vscode.SymbolKind.Method : vscode.SymbolKind.Struct, "", new vscode.Location(document.uri, new vscode.Range(start, start.translate(0, name.length)))));
            }
            const binding = new RegExp(GLOBAL_BINDING_PATTERN);
            let match;
            while ((match = binding.exec(text)) !== null) {
                const name = match[1];
                if (needle && !name.toLowerCase().includes(needle))
                    continue;
                const start = document.positionAt(match.index + match[0].indexOf(name, 3));
                symbols.push(new vscode.SymbolInformation(name, vscode.SymbolKind.Constant, "", new vscode.Location(document.uri, new vscode.Range(start, start.translate(0, name.length)))));
            }
        }
        return symbols;
    }
}
// Add the Windows executable suffix only on Windows; never select a foreign
// platform binary merely because its filename happens to exist.
function withPlatformExecutableSuffix(resolved) {
    if (process.platform === "win32" && !path.extname(resolved) && !isExecutableFile(resolved))
        return `${resolved}.exe`;
    return resolved;
}
function isExecutableFile(candidate) {
    try {
        if (!fs.statSync(candidate).isFile())
            return false;
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
// "felidae" is the one interpreter binary this project builds - it reads
// source.fx, parses it to an AST, and executes that AST directly; there is
// no separate compiler or VM binary to run first (see README.md/code.md).
// The interpreter for a file: the setting (or the workspace's .vscode/felidae.json),
// FELIDAE_PATH, a build under the workspace or the file's folder and its parents
// (release before debug, including build/debug/x64/Debug), then PATH.
function resolveInterpreterPath(documentUri) {
    return (0, interpreterUi_1.resolveInterpreterFor)(documentUri, workspaceExecutableSetting(documentUri, "interpreterPath")).path;
}
function workspaceExecutableSetting(documentUri, setting) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (!workspaceFolder)
        return undefined;
    const configPath = path.join(workspaceFolder.uri.fsPath, ".vscode", "felidae.json");
    if (!fs.existsSync(configPath))
        return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const value = parsed?.[setting];
        return typeof value === "string" && value.trim() ? value : undefined;
    }
    catch (error) {
        console.warn(`Felidae: unable to read ${configPath}: ${String(error)}`);
        return undefined;
    }
}
function releaseExecutableCandidates(name) {
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
function resolveReleaseExecutable(documentUri, configuredPath, name) {
    if (configuredPath?.trim()) {
        const configured = configuredPath.trim();
        const local = withPlatformExecutableSuffix(resolveConfiguredPath(documentUri, configured));
        if (isExecutableFile(local) || /[/\\]/.test(configured))
            return local;
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
function resolveToolingPath(documentUri) {
    return resolveInterpreterPath(documentUri);
}
function resolveConfiguredPath(documentUri, configuredPath) {
    if (path.isAbsolute(configuredPath)) {
        return configuredPath;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (workspaceFolder) {
        return path.join(workspaceFolder.uri.fsPath, configuredPath);
    }
    return configuredPath;
}
async function ensureInterpreterInstalled(interpreterPath, label, settingsQuery = "felidae.interpreterPath") {
    if (isExecutableFile(interpreterPath))
        return true;
    log("error", label + " is missing or not executable: " + interpreterPath);
    const downloadLabel = "Download Felidae";
    const choice = await vscode.window.showWarningMessage(`${label} is missing or is not executable: ${interpreterPath}`, "Select Interpreter", downloadLabel, "Open Settings");
    if (choice === "Select Interpreter") {
        await vscode.commands.executeCommand("felidae.selectInterpreter");
    }
    else if (choice === downloadLabel) {
        await vscode.env.openExternal(vscode.Uri.parse("https://github.com/xnvtserver/Felidae/releases"));
    }
    else if (choice === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", settingsQuery);
    }
    return false;
}
// AST-derived symbols returned by the same interpreter check that owns
// diagnostics. The summary shape is retained for completion/signature code,
// but there is no second parser process or extension-side semantic validator.
const symbolSummaryCache = new Map();
function cacheCheckSymbols(document, symbols) {
    const span = (symbol) => ({
        startLine: Number(symbol.start?.line ?? 1),
        startColumn: Number(symbol.start?.column ?? 1),
        endLine: Number(symbol.end?.line ?? symbol.start?.line ?? 1),
        endColumn: Number(symbol.end?.column ?? symbol.start?.column ?? 1)
    });
    const definition = (symbol) => ({
        name: symbol.name,
        count: 1,
        spans: [span(symbol)]
    });
    const summary = {
        methods: [], facts: [], globals: [], files: [document.uri.fsPath], unresolvedImports: []
    };
    for (const symbol of symbols) {
        if (symbol.kind === "function")
            summary.methods.push(definition(symbol));
        else if (symbol.kind === "fact" || symbol.kind === "class")
            summary.facts.push(definition(symbol));
        else if (symbol.kind === "binding")
            summary.globals.push(definition(symbol));
        for (const child of symbol.children ?? []) {
            if (child.kind === "method")
                summary.methods.push(definition(child));
        }
    }
    const key = document.uri.toString();
    checkSymbolCache.set(key, symbols);
    symbolSummaryCache.set(key, summary);
    checkSymbolsChanged.fire(document.uri);
}
const activeCheckProcesses = new Map();
function runtimeCheckDiagnostics(document) {
    return new Promise((resolve) => {
        if (document.uri.scheme !== "file") {
            resolve([]);
            return;
        }
        const interpreterPath = resolveToolingPath(document.uri);
        if (!isExecutableFile(interpreterPath)) {
            log("warn", "check skipped, interpreter not found: " + interpreterPath);
            const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1));
            resolve([new vscode.Diagnostic(range, `Felidae interpreter not found: ${interpreterPath}. Parser and AST validation via --check-json is disabled.`, vscode.DiagnosticSeverity.Warning)]);
            return;
        }
        const key = document.uri.toString();
        activeCheckProcesses.get(key)?.kill();
        const startedAt = Date.now();
        log("debug", "check: " + interpreterPath + " --check-json --stdin " + document.uri.fsPath);
        const check = childProcess.execFile(interpreterPath, ["--check-json", "--stdin", document.uri.fsPath], { cwd: path.dirname(document.uri.fsPath), windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
            if (activeCheckProcesses.get(key) === check)
                activeCheckProcesses.delete(key);
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
            const range = new vscode.Range(new vscode.Position(line, column), new vscode.Position(line, column + 1));
            resolve([...analyzerDiagnostics, new vscode.Diagnostic(range, message, severity)]);
        });
        activeCheckProcesses.set(key, check);
        check.stdin?.end(document.getText());
    });
}
// Where an interpreter error message points. Messages say "line N, column M"
// (older ones "at N:M"). A message that starts with a different file's path is
// about an imported file, so its line number must not be applied to this one.
function diagnosticPositionInMessage(message, documentPath) {
    const other = /^(.+?\.fx): /.exec(message);
    if (other && other[1].toLowerCase() !== documentPath.toLowerCase())
        return { line: 0, column: 0 };
    const match = /line (\d+), column (\d+)/.exec(message) ?? / at (\d+):(\d+)/.exec(message);
    return match
        ? { line: Math.max(0, Number(match[1]) - 1), column: Math.max(0, Number(match[2]) - 1) }
        : { line: 0, column: 0 };
}
// One entry per distinct problem, all tagged with the same source, so the
// Problems panel total equals the issues actually in the file even when the
// parser and the analyzer both report the same thing.
function dedupeDiagnostics(list) {
    const seen = new Set();
    const unique = [];
    for (const item of list) {
        const key = [item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character, item.severity, item.message].join("|");
        if (seen.has(key))
            continue;
        seen.add(key);
        item.source ?? (item.source = "felidae");
        unique.push(item);
    }
    return unique;
}
function parseRuntimeCheckResult(document, stdout) {
    const text = stdout.trim();
    if (!text.startsWith("{"))
        return undefined;
    try {
        const payload = JSON.parse(text);
        if (!Array.isArray(payload.diagnostics))
            return undefined;
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
            const endLine = Math.min(Math.max(0, Number(item.end?.line ?? item.start?.line ?? 1) - 1), document.lineCount - 1);
            const endText = document.lineAt(endLine).text;
            const rawEndColumn = Math.max(0, Number(item.end?.column ?? item.start?.column ?? 1) - 1);
            const endColumn = endLine === boundedLine
                ? Math.min(Math.max(boundedColumn + 1, rawEndColumn), endText.length)
                : Math.min(rawEndColumn, endText.length);
            const diagnostic = new vscode.Diagnostic(new vscode.Range(new vscode.Position(boundedLine, boundedColumn), new vscode.Position(endLine, endColumn)), item.message ?? "Felidae AST diagnostic", severity);
            // The parser reports a missing period where it noticed (the start of what
            // follows); the quick fix works out where the period belongs.
            if (/^Expected '\./.test(diagnostic.message))
                diagnostic.code = "expected-period";
            return diagnostic;
        });
        return {
            diagnostics,
            symbols: Array.isArray(payload.symbols) ? payload.symbols : []
        };
    }
    catch {
        return undefined;
    }
}
function parseRuntimeAnalyzerDiagnostics(document, stdout) {
    const diagnostics = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith("FELIDAE_DIAGNOSTIC "))
            continue;
        const severityMatch = /\bseverity=(error|warning|info|hint)\b/.exec(line);
        const lineMatch = /\bline=(\d+)\b/.exec(line);
        const columnMatch = /\bcolumn=(\d+)\b/.exec(line);
        const messageMatch = /\bmessage=(.*)$/.exec(line);
        const message = messageMatch?.[1]?.trim();
        if (!message)
            continue;
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
        diagnostics.push(new vscode.Diagnostic(new vscode.Range(new vscode.Position(boundedLine, boundedColumn), new vscode.Position(boundedLine, Math.min(boundedColumn + 1, document.lineAt(boundedLine).text.length))), message, severity));
    }
    return diagnostics;
}
function formatRuntimeCheckMessage(text) {
    const raw = text.trim();
    const severity = /^warning:/i.test(raw) ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
    let message = raw.replace(/^(error|warning):\s*/i, "");
    const factIteration = /^Fact type '([^']+)' is not implicitly iterable/.exec(message);
    if (factIteration) {
        const name = factIteration[1];
        message = `Fact type '${name}' is not implicitly iterable here. Direct ${name}(...) declarations and named queries are supported, but ${name}(item) in a method body does not scan facts. Query it with ${name}.where(...) or ${name}.all() and iterate the result.`;
    }
    else if (/^Module '.*' not found/.test(message)) {
        message = `${message}. Check the import path, native module name, or workspace-relative Felidae configuration.`;
    }
    else if (/expects argument/.test(message)) {
        message = `${message}. This was reported by felidae --check-json during parser and AST validation.`;
    }
    else if (/Unknown field/.test(message)) {
        message = `${message}. Named fact calls must match the declared fact fields.`;
    }
    return { message, severity };
}
// Quick fixes: insert the period a statement is missing (the commonest syntax
// error), and remove an unused one-line binding.
//   code "expected-period"  the parser's own position; where the period goes is worked out
//   code "missing-period"   a diagnostic whose range already ends where it goes (notebook cells)
//   code "unused-binding"   a local that is never used
class FelidaeCodeActionProvider {
    provideCodeActions(document, _range, context) {
        const actions = [];
        const linesOf = () => {
            const lines = [];
            for (let line = 0; line < document.lineCount; line++)
                lines.push(document.lineAt(line).text);
            return lines;
        };
        for (const diagnostic of context.diagnostics) {
            if (diagnostic.code === "expected-period" || diagnostic.code === "missing-period") {
                const at = diagnostic.code === "missing-period"
                    ? { line: diagnostic.range.end.line, column: diagnostic.range.end.character }
                    : (0, editing_1.periodInsertion)(linesOf(), diagnostic.range.start.line, diagnostic.range.start.character);
                if (!at)
                    continue;
                const action = new vscode.CodeAction("Insert the missing '.'", vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                action.edit = new vscode.WorkspaceEdit();
                action.edit.insert(document.uri, new vscode.Position(at.line, at.column), ".");
                actions.push(action);
            }
            else if (diagnostic.code === "unused-binding") {
                const line = diagnostic.range.start.line;
                const name = document.getText(diagnostic.range);
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                // Only a whole statement on one line can be removed safely.
                if (!new RegExp("^\\s*def\\s+" + escaped + "\\b.*\\.\\s*(#.*)?$").test(document.lineAt(line).text))
                    continue;
                const action = new vscode.CodeAction("Remove unused binding '" + name + "'", vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.edit = new vscode.WorkspaceEdit();
                action.edit.delete(document.uri, line + 1 < document.lineCount
                    ? new vscode.Range(line, 0, line + 1, 0)
                    : new vscode.Range(line, 0, line, document.lineAt(line).text.length));
                actions.push(action);
            }
        }
        return actions;
    }
}
FelidaeCodeActionProvider.providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];
async function getFelidaeDocument(uri) {
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
async function runQuery(uri) {
    const document = await getFelidaeDocument(uri);
    if (!document) {
        vscode.window.showWarningMessage("Open a Felidae .fx file before running a query.");
        return;
    }
    if (document.isDirty) {
        await document.save();
    }
    const config = vscode.workspace.getConfiguration("felidae");
    const defaultQuery = config.get("defaultQuery", "employee.where(active: true).");
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
    if (!installed)
        return;
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
function hasMainMethod(document) {
    return MAIN_DECLARATION_PATTERN.test(document.getText());
}
async function runMain(uri) {
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
    if (!installed)
        return;
    runInTerminal(interpreterPath, [programPath], path.dirname(programPath));
}
async function debugMain(uri) {
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
    if (!installed)
        return;
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
class FelidaeDebugAdapter {
    constructor() {
        this.emitter = new vscode.EventEmitter();
        this.currentLine = 1;
        this.stdoutBuffer = "";
        this.breakpoints = new Set();
        this.locals = [];
        this.configurationDone = new Promise((resolve) => { this.finishConfiguration = resolve; });
        this.onDidSendMessage = this.emitter.event;
    }
    handleMessage(message) {
        const request = message;
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
            const args = (request.arguments ?? {});
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
    dispose() {
        this.process?.kill();
        this.emitter.dispose();
    }
    async launch(request) {
        const args = (request.arguments ?? {});
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
        this.process.stdout.on("data", (data) => this.handleDebugStdout(data.toString()));
        this.process.stderr.on("data", (data) => this.sendOutput(data.toString(), "stderr"));
        this.process.on("error", (error) => {
            log("error", "debug process error: " + error.message);
            this.sendOutput(`${error.message}\n`, "stderr");
            this.process = undefined;
            this.finishConfiguration();
            this.resolvePendingStop();
            this.sendEvent("terminated");
        });
        this.process.on("close", (code) => {
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
        for (const line of this.breakpoints)
            this.process.stdin.write(`break ${line}\n`);
        this.sendResponse(request);
        if (args.stopOnEntry === false) {
            const stopped = this.waitForStop();
            this.process.stdin.write("continue\n");
            this.sendEvent("continued", { threadId: 1, allThreadsContinued: true });
            await stopped;
            if (this.process)
                this.sendEvent("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
        }
        else {
            this.sendEvent("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
        }
    }
    waitForStop() {
        return new Promise((resolve) => { this.pendingStop = resolve; });
    }
    resolvePendingStop() {
        const resolve = this.pendingStop;
        this.pendingStop = undefined;
        resolve?.();
    }
    setBreakpoints(request) {
        const args = (request.arguments ?? {});
        const requested = new Set((args.breakpoints ?? []).map((breakpoint) => breakpoint.line));
        for (const line of requested) {
            if (!this.breakpoints.has(line))
                this.process?.stdin.write(`break ${line}\n`);
        }
        for (const line of this.breakpoints) {
            if (!requested.has(line))
                this.process?.stdin.write(`clear ${line}\n`);
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
    async step(request, command) {
        if (!this.process) {
            this.sendResponse(request, undefined, false, "No active Felidae debug session.");
            return;
        }
        const stopped = this.waitForStop();
        this.process.stdin.write(`${command}\n`);
        this.sendResponse(request);
        await stopped;
        if (this.process)
            this.sendEvent("stopped", { reason: "step", threadId: 1, allThreadsStopped: true });
    }
    async continueExecution(request) {
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
        if (this.process)
            this.sendEvent("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
    }
    async evaluate(request) {
        const args = (request.arguments ?? {});
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
    refreshLocals() {
        return new Promise((resolve) => {
            this.pendingLocals = { resolve };
            this.process?.stdin.write("locals\n");
        });
    }
    handleDebugStdout(text) {
        this.stdoutBuffer += text;
        const lines = this.stdoutBuffer.split(/\r?\n/);
        this.stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
            this.handleDebugLine(line);
        }
    }
    flushDebugStdout() {
        if (!this.stdoutBuffer)
            return;
        this.handleDebugLine(this.stdoutBuffer);
        this.stdoutBuffer = "";
    }
    handleDebugLine(line) {
        if (!line)
            return;
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
            if (bound)
                this.locals.push({ name: bound[1], value: bound[2] });
            return;
        }
        const value = /^FELIDAE_DEBUG_VALUE (\S+) = (.*)$/.exec(line);
        if (value) {
            return;
        }
        this.sendOutput(`${line}\n`, "stdout");
    }
    sendResponse(request, body, success = true, message) {
        this.emitter.fire({
            type: "response",
            seq: 0,
            request_seq: request.seq ?? 0,
            command: request.command,
            success,
            message,
            body
        });
    }
    sendEvent(event, body) {
        this.emitter.fire({ type: "event", seq: 0, event, body });
    }
    sendOutput(output, category) {
        this.sendEvent("output", { category, output });
    }
}
FelidaeDebugAdapter.localVariablesReference = 1;
class FelidaeDebugAdapterFactory {
    createDebugAdapterDescriptor() {
        return new vscode.DebugAdapterInlineImplementation(new FelidaeDebugAdapter());
    }
}
class FelidaeDebugConfigurationProvider {
    resolveDebugConfiguration(folder, config) {
        const editor = vscode.window.activeTextEditor;
        const activeDocument = editor?.document.languageId === "felidae" ? editor.document : undefined;
        const workspacePath = folder?.uri.fsPath;
        config.type ?? (config.type = "felidae");
        config.name ?? (config.name = "Debug Felidae Query");
        config.request ?? (config.request = "launch");
        config.program ?? (config.program = activeDocument?.uri.fsPath ?? "${file}");
        const anchor = typeof config.program === "string" && path.isAbsolute(config.program)
            ? vscode.Uri.file(config.program)
            : folder?.uri ?? activeDocument?.uri ?? vscode.Uri.file(workspacePath ?? "");
        if (!config.interpreterPath?.trim())
            config.interpreterPath = resolveInterpreterPath(anchor);
        else if (!config.interpreterPath.includes("${"))
            config.interpreterPath = resolveReleaseExecutable(anchor, config.interpreterPath, "felidae");
        config.stopOnEntry ?? (config.stopOnEntry = true);
        return config;
    }
}
function activate(context) {
    // Ranking models are optional: if resources/models is absent the scorers
    // report themselves disabled and completion behaves exactly as before.
    ml.loadModels(context.extensionPath);
    outputChannel = vscode.window.createOutputChannel("Felidae", { log: true });
    context.subscriptions.push(outputChannel);
    const extensionVersion = context.extension?.packageJSON?.version ?? "unknown";
    log("info", "Felidae extension " + extensionVersion + " activated (" + process.platform + ", VS Code " + vscode.version + ")");
    const diagnostics = vscode.languages.createDiagnosticCollection("felidae");
    const debounceTimers = new Map();
    const DIAGNOSTICS_DEBOUNCE_MS = 350;
    // Only the newest check for a document may publish. An older check that
    // finishes late (or was killed by a newer one) is dropped, and the previous
    // diagnostics stay until the new result replaces them, so the Problems total
    // never flickers to zero or shows a superseded result.
    const checkGeneration = new Map();
    // Locals and parameters that are never used, faded and not counted as problems.
    const unusedDiagnostics = vscode.languages.createDiagnosticCollection("felidae-unused");
    context.subscriptions.push(unusedDiagnostics);
    const publishUnused = (document) => {
        const found = (0, editing_1.findUnusedLocals)(lexDocument(document).tokens, cachedEndBlockPairs(document).pairs);
        unusedDiagnostics.set(document.uri, found.map((entry) => {
            const diagnostic = new vscode.Diagnostic(new vscode.Range(entry.line, entry.start, entry.line, entry.end), "'" + entry.name + "' is never used", vscode.DiagnosticSeverity.Hint);
            diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
            diagnostic.source = "felidae";
            if (entry.kind === "binding")
                diagnostic.code = "unused-binding";
            return diagnostic;
        }));
    };
    // A check already done for this text and interpreter is not repeated (switching
    // tabs asks for one every time).
    const lastCheckStamp = new Map();
    // Files whose problems came from "Check All Felidae Files": they stay listed
    // after the file is closed, until it is checked again or deleted.
    const workspaceChecked = new Set();
    // felidae.check.run: "onType" (default), "onSave" or "off".
    const checkMode = (document) => vscode.workspace.getConfiguration("felidae", document.uri).get("check.run", "onType");
    const refreshDiagnostics = (document, fromEdit = false) => {
        if (document.languageId !== "felidae")
            return;
        const key = document.uri.toString();
        publishUnused(document);
        const mode = checkMode(document);
        if (mode === "off") {
            diagnostics.delete(document.uri);
            return;
        }
        if (fromEdit && mode !== "onType")
            return;
        const stamp = document.version + "|" + resolveInterpreterPath(document.uri);
        if (lastCheckStamp.get(key) === stamp)
            return;
        lastCheckStamp.set(key, stamp);
        const generation = (checkGeneration.get(key) ?? 0) + 1;
        checkGeneration.set(key, generation);
        const version = document.version;
        void runtimeCheckDiagnostics(document).then((runtimeDiagnostics) => {
            if (document.isClosed || document.version !== version || checkGeneration.get(key) !== generation) {
                lastCheckStamp.delete(key);
                return;
            }
            const published = dedupeDiagnostics(runtimeDiagnostics);
            diagnostics.set(document.uri, published);
            const count = (severity) => published.filter((item) => item.severity === severity).length;
            log("info", path.basename(document.uri.fsPath) + ": " + count(vscode.DiagnosticSeverity.Error) + " error(s), " +
                count(vscode.DiagnosticSeverity.Warning) + " warning(s), " + count(vscode.DiagnosticSeverity.Information) + " info");
        });
    };
    // Check every .fx file in the workspace, one interpreter process at a time (a
    // failing file is reported and the next one is still checked), like the
    // project-wide diagnostics of Erlang LS and ElixirLS.
    const checkWorkspace = async () => {
        const uris = await vscode.workspace.findFiles("**/*.fx", FX_EXCLUDE, 2000);
        if (uris.length === 0) {
            void vscode.window.showInformationMessage("No .fx files found in the workspace.");
            return;
        }
        const totals = { files: 0, errors: 0, warnings: 0 };
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Checking Felidae files", cancellable: true }, async (progress, token) => {
            for (const [index, uri] of uris.entries()) {
                if (token.isCancellationRequested)
                    break;
                progress.report({ message: path.basename(uri.fsPath) + " (" + (index + 1) + "/" + uris.length + ")", increment: 100 / uris.length });
                const document = await vscode.workspace.openTextDocument(uri);
                const key = uri.toString();
                const published = dedupeDiagnostics(await runtimeCheckDiagnostics(document));
                workspaceChecked.add(key);
                diagnostics.set(uri, published);
                lastCheckStamp.set(key, document.version + "|" + resolveInterpreterPath(uri));
                totals.files++;
                totals.errors += published.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length;
                totals.warnings += published.filter((item) => item.severity === vscode.DiagnosticSeverity.Warning).length;
            }
        });
        log("info", "check all: " + totals.files + " file(s), " + totals.errors + " error(s), " + totals.warnings + " warning(s)");
        void vscode.window.showInformationMessage("Checked " + totals.files + " Felidae file(s): " + totals.errors + " error(s), " + totals.warnings + " warning(s)." +
            (totals.errors + totals.warnings > 0 ? " See the Problems panel." : ""));
        if (totals.errors + totals.warnings > 0)
            void vscode.commands.executeCommand("workbench.actions.view.problems");
    };
    const scheduleDiagnosticsRefresh = (document) => {
        if (document.languageId !== "felidae")
            return;
        const key = document.uri.toString();
        const existing = debounceTimers.get(key);
        if (existing)
            clearTimeout(existing);
        debounceTimers.set(key, setTimeout(() => {
            debounceTimers.delete(key);
            refreshDiagnostics(document, true);
        }, DIAGNOSTICS_DEBOUNCE_MS));
    };
    const refreshMainContext = () => {
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
    statusItem.command = "felidae.menu";
    const refreshStatusItem = () => {
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
            "All checked Felidae files: " + totalErrors + " error(s), " + totalWarnings + " warning(s)\n" +
            "Click for the Felidae menu";
        statusItem.show();
    };
    refreshStatusItem();
    (0, cellUi_1.registerCells)(context, {
        resolveInterpreterPath,
        ensureInterpreterInstalled: (interpreterPath) => ensureInterpreterInstalled(interpreterPath, "Felidae interpreter"),
        blockPairs: (document) => cachedEndBlockPairs(document).pairs,
        log
    });
    const interpreterStatus = new interpreterUi_1.InterpreterStatus(context, (uri) => (uri ? workspaceExecutableSetting(uri, "interpreterPath") : undefined), () => {
        // A different interpreter: every open file is checked again.
        lastCheckStamp.clear();
        for (const document of vscode.workspace.textDocuments)
            refreshDiagnostics(document);
    });
    void interpreterStatus;
    (0, repl_1.registerRepl)(context, {
        resolveInterpreterPath,
        ensureInterpreterInstalled: (interpreterPath) => ensureInterpreterInstalled(interpreterPath, "Felidae interpreter"),
        blockPairs: (document) => cachedEndBlockPairs(document).pairs,
        log: (level, message) => log(level, message)
    });
    const fxWatcher = vscode.workspace.createFileSystemWatcher("**/*.fx");
    fxWatcher.onDidCreate(invalidateWorkspaceFiles);
    fxWatcher.onDidDelete(invalidateWorkspaceFiles);
    fxWatcher.onDidDelete((uri) => {
        diagnostics.delete(uri);
        unusedDiagnostics.delete(uri);
        workspaceChecked.delete(uri.toString());
    });
    refreshEndDecorations();
    refreshDefDecorations();
    context.subscriptions.push(fxWatcher, ...blockStrongDecorations, ...blockSoftDecorations, ...Object.values(defDecorations), vscode.window.onDidChangeVisibleTextEditors(() => refreshDefDecorations()), vscode.workspace.onDidChangeTextDocument((event) => scheduleDefDecorations(event.document)), vscode.window.onDidChangeTextEditorSelection((event) => updateEndDecorations(event.textEditor)), vscode.window.onDidChangeVisibleTextEditors(() => refreshEndDecorations()), vscode.workspace.onDidChangeTextDocument((event) => refreshEndDecorations(event.document)), vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("felidae.endLabels"))
            refreshEndDecorations();
        if (event.affectsConfiguration("felidae.check.run")) {
            lastCheckStamp.clear();
            for (const document of vscode.workspace.textDocuments)
                refreshDiagnostics(document);
        }
    }), diagnostics, vscode.commands.registerCommand("felidae.checkWorkspace", checkWorkspace), vscode.commands.registerCommand("felidae.checkFile", () => {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || document.languageId !== "felidae") {
            void vscode.window.showInformationMessage("Open a Felidae file to check it.");
            return;
        }
        lastCheckStamp.delete(document.uri.toString());
        refreshDiagnostics(document);
    }), vscode.commands.registerCommand("felidae.menu", async () => {
        const document = vscode.window.activeTextEditor?.document;
        const inFelidaeFile = !!document && document.languageId === "felidae";
        const list = inFelidaeFile ? diagnostics.get(document.uri) ?? [] : [];
        const picked = await vscode.window.showQuickPick((0, quickMenu_1.menuEntries)({
            inFelidaeFile,
            hasMain: inFelidaeFile && hasMainMethod(document),
            errors: list.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length,
            warnings: list.filter((item) => item.severity === vscode.DiagnosticSeverity.Warning).length
        }), { title: "Felidae", placeHolder: "What do you want to do?" });
        if (picked)
            await vscode.commands.executeCommand(picked.command);
    }), vscode.commands.registerCommand("felidae.clearProblems", () => {
        diagnostics.clear();
        workspaceChecked.clear();
        lastCheckStamp.clear();
    }), vscode.commands.registerCommand("felidae.showOutput", () => outputChannel?.show(true)), vscode.commands.registerCommand("felidae.runMain", runMain), vscode.commands.registerCommand("felidae.debugMain", debugMain), vscode.commands.registerCommand("felidae.runQuery", runQuery), vscode.commands.registerCommand("felidae.formatDocument", () => vscode.commands.executeCommand("editor.action.formatDocument")), vscode.workspace.onDidOpenTextDocument((document) => {
        refreshDiagnostics(document);
        refreshMainContext();
    }), vscode.workspace.onDidChangeTextDocument((event) => {
        scheduleDiagnosticsRefresh(event.document);
        refreshMainContext();
    }), vscode.workspace.onDidSaveTextDocument((document) => {
        refreshDiagnostics(document);
        refreshMainContext();
    }), vscode.workspace.onDidCloseTextDocument((document) => {
        if (!workspaceChecked.has(document.uri.toString()))
            diagnostics.delete(document.uri);
        unusedDiagnostics.delete(document.uri);
        lastCheckStamp.delete(document.uri.toString());
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
    }), vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor)
            refreshDiagnostics(editor.document);
        refreshMainContext();
    }), vscode.languages.registerDocumentLinkProvider({ language: "felidae" }, new FelidaeDocumentLinkProvider()), vscode.languages.registerHoverProvider({ language: "felidae" }, new FelidaeHoverProvider()), vscode.languages.registerDefinitionProvider({ language: "felidae" }, new FelidaeDefinitionProvider()), vscode.languages.registerFoldingRangeProvider({ language: "felidae" }, new FelidaeFoldingRangeProvider()), vscode.languages.registerCallHierarchyProvider({ language: "felidae" }, new FelidaeCallHierarchyProvider()), vscode.workspace.onDidChangeTextDocument((event) => autoInsertEnd(event)), vscode.languages.registerInlayHintsProvider({ language: "felidae" }, new FelidaeInlayHintsProvider()), vscode.languages.registerSelectionRangeProvider({ language: "felidae" }, new FelidaeSelectionRangeProvider()), 
    // Type hierarchy was finalised after the minimum supported VS Code; skip it there.
    ...(typeof vscode.languages.registerTypeHierarchyProvider === "function"
        ? [vscode.languages.registerTypeHierarchyProvider({ language: "felidae" }, new FelidaeTypeHierarchyProvider())]
        : []), vscode.tasks.registerTaskProvider("felidae", new FelidaeTaskProvider()), statusItem, vscode.languages.onDidChangeDiagnostics(() => refreshStatusItem()), vscode.window.onDidChangeActiveTextEditor(() => refreshStatusItem()), vscode.languages.registerCodeLensProvider({ scheme: "file", language: "felidae" }, new FelidaeCodeLensProvider()), vscode.languages.registerDocumentSemanticTokensProvider({ language: "felidae" }, new FelidaeSemanticTokensProvider(), semanticLegend), vscode.languages.registerDocumentSymbolProvider({ language: "felidae" }, new FelidaeDocumentSymbolProvider()), vscode.languages.registerCompletionItemProvider({ language: "felidae" }, new FelidaeCompletionItemProvider(), ".", "(", ","), vscode.languages.registerSignatureHelpProvider({ language: "felidae" }, new FelidaeSignatureHelpProvider(), { triggerCharacters: ["("], retriggerCharacters: [",", ":"] }), vscode.languages.registerCodeActionsProvider({ language: "felidae" }, new FelidaeCodeActionProvider(), { providedCodeActionKinds: FelidaeCodeActionProvider.providedCodeActionKinds }), vscode.languages.registerDocumentFormattingEditProvider({ language: "felidae" }, new formatter_1.FelidaeDocumentFormattingEditProvider()), vscode.languages.registerDocumentRangeFormattingEditProvider({ language: "felidae" }, new formatter_1.FelidaeDocumentRangeFormattingEditProvider()), vscode.languages.registerDocumentHighlightProvider({ language: "felidae" }, new FelidaeDocumentHighlightProvider()), vscode.languages.registerReferenceProvider({ language: "felidae" }, new FelidaeReferenceProvider()), vscode.languages.registerRenameProvider({ language: "felidae" }, new FelidaeRenameProvider()), vscode.languages.registerWorkspaceSymbolProvider(new FelidaeWorkspaceSymbolProvider()), vscode.debug.registerDebugConfigurationProvider("felidae", new FelidaeDebugConfigurationProvider()), vscode.debug.registerDebugAdapterDescriptorFactory("felidae", new FelidaeDebugAdapterFactory()));
}
function deactivate() {
    for (const process of activeCheckProcesses.values())
        process.kill();
    activeCheckProcesses.clear();
    checkSymbolsChanged.dispose();
}
//# sourceMappingURL=extension.js.map