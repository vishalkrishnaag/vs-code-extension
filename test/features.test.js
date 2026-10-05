// Built-in VS Code feature providers: inlay hints, expand selection, block
// highlighting, def classification in the grammar. Pure text analysis against
// the stubbed `vscode` module, same approach as providers.test.js.
const path = require("path"), fs = require("fs"), Module = require("module");
const stub = path.resolve(__dirname, "vscode-stub.js");
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { if (r === "vscode") return stub; return orig.call(this, r, ...a); };
const vscode = require(stub);
vscode.InlayHint = class { constructor(position, label, kind) { Object.assign(this, { position, label, kind }); } };
vscode.InlayHintKind = { Parameter: 2 };
vscode.SelectionRange = class { constructor(range, parent) { this.range = range; this.parent = parent; } };
vscode.Range = class {
  constructor(a, b, c, d) {
    if (typeof a === "number") { this.start = new vscode.Position(a, b); this.end = new vscode.Position(c, d); }
    else { this.start = a; this.end = b; }
  }
};

const EXT = path.resolve(__dirname, "..", "out", "extension.js");
const src = fs.readFileSync(EXT, "utf8") + `
module.exports.__f = { FelidaeInlayHintsProvider, FelidaeSelectionRangeProvider, selectionChain, endBlockPairs, enclosingBlock, openerNeedsEnd, isBlockOpenerLine, scopedOccurrences, symbolOccurrences, dedupeDiagnostics, diagnosticPositionInMessage, classifyDefs, enclosingBlocks, lexDocument, isTopLevelSymbol };`;
const mod = new Module(EXT); mod.filename = EXT; mod.paths = Module._nodeModulePaths(path.dirname(EXT));
mod._compile(src, EXT);
const F = mod.exports.__f;

function doc(text) {
  const lines = text.split("\n");
  return {
    languageId: "felidae", eol: 1, version: 1, lineCount: lines.length,
    uri: vscode.Uri.file("c:/t.fx"),
    getText: (r) => { if (!r) return text; return lines[r.start.line].slice(r.start.character, r.end.character); },
    lineAt: (n) => ({ text: lines[n] }),
    getWordRangeAtPosition: (p, re) => {
      const m = [...lines[p.line].matchAll(new RegExp(re, "g"))].find((x) => x.index <= p.character && p.character <= x.index + x[0].length);
      return m ? new vscode.Range(p.line, m.index, p.line, m.index + m[0].length) : undefined;
    }
  };
}

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  ok  ", name); } else { fail++; console.log("  FAIL", name, "\n     exp", e, "\n     act", a); }
};

const program = `def Person(name: string, age: number).
def greet(p: string, loud: bool) =>
    p.
end
def main() =>
    greet("Ada", true).
    greet(p: "Ada", loud: true).
    Person("Ada", 3).
    for i in range(0, 5) then
        greet("x", false).
    end
end`;
const d = doc(program);

// --- inlay hints
const wholeRange = new vscode.Range(0, 0, 20, 0);
const hints = new F.FelidaeInlayHintsProvider().provideInlayHints(d, wholeRange)
  .map((h) => [h.position.line, h.position.character, h.label]);
check("positional arguments get parameter-name hints", hints, [
  [5, 10, "p:"], [5, 17, "loud:"],
  [7, 11, "name:"], [7, 18, "age:"],
  [9, 14, "p:"], [9, 19, "loud:"]
]);

// --- expand selection
const chain = F.selectionChain(d, new vscode.Position(9, 10)).map((r) => [r.start.line, r.end.line]);
check("selection grows word, line, for body, for block, main body, main block", chain, [[9, 9], [9, 9], [9, 9], [8, 10], [5, 10], [4, 11]]);
const lineSpans = chain.map(([a, b]) => b - a);
check("selection ranges only ever grow", lineSpans.every((v, i) => i === 0 || v >= lineSpans[i - 1]), true);
check("outermost selection is the whole main block", chain[chain.length - 1], [4, 11]);
check("innermost enclosing block of a body line is the for loop",
  (() => { const p = F.enclosingBlock(F.endBlockPairs(program.split("\n")), 9); return [p.openerLine, p.endLine]; })(), [8, 10]);
check("an end line selects its own block, not the parent",
  (() => { const p = F.enclosingBlock(F.endBlockPairs(program.split("\n")), 10); return [p.openerLine, p.endLine]; })(), [8, 10]);
check("a line outside every block selects nothing",
  F.enclosingBlock(F.endBlockPairs(program.split("\n")), 0), undefined);

// --- grammar: three kinds of def
const grammar = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "syntaxes", "felidae.tmLanguage.json"), "utf8"));
const declarations = grammar.repository.keywords.patterns.filter((p) => /declaration/.test(p.name));
const kindOf = (line) => (declarations.find((p) => new RegExp(p.match).test(line)) || { name: "generic" }).name.replace(/^keyword\.declaration\.|\.felidae$/g, "");
check("def f(...) => is a function", kindOf("def add(a: number, b: number) =>"), "function");
check("def x := v is a binding", kindOf("def x := 1."), "variable");
check("def x: T := v is a binding", kindOf("def x: number := 1."), "variable");
check("class field def id: T is a binding", kindOf("def id: string."), "variable");
check("def Name(...). is a fact", kindOf("def Employee(id: \"e1\", state: active)."), "struct");

// --- auto-insert end: only an opener without its own end needs one
const needs = (text, line) => F.openerNeedsEnd(text.split("\n"), line);
check("new def block at end of file needs end", needs("def main() =>\n    ", 0), true);
check("def block already closed does not", needs("def main() =>\n    \nend", 0), false);
check("new nested for inside an already-closed def needs its own end",
  needs("def main() =>\n    for i in xs then\n        \nend", 1), true);
check("nested for closed at its indentation does not",
  needs("def main() =>\n    for i in xs then\n        \n    end\nend", 1), false);
check("opener followed by a dedented non-end needs end",
  needs("def a() =>\n    \ndef b() =>\n    1.\nend", 0), true);
check("non-opener lines never need end", needs("    def x := 1.\n", 0), false);
check("def with a body on the same line is not an opener", F.isBlockOpenerLine("def f(a: number) => a + 1."), false);

// --- find references: a local stays inside its own declaration
const scopeSrc = [
  "def total(x: number) =>",
  "    def y := x + 1.",
  "    y.",
  "end",
  "def other(x: number) =>",
  "    x * 2.",
  "end",
  "def main() =>",
  "    total(1).",
  "    other(2).",
  "end"
].join("\n");
const sd = doc(scopeSrc);
const lineSet = (ranges) => [...new Set(ranges.map((r) => r.start.line))];
check("a parameter's references stay inside its own function",
  lineSet(F.scopedOccurrences(sd, "x", new vscode.Position(0, 11))), [0, 1]);
check("the same name in another function is a separate symbol",
  lineSet(F.scopedOccurrences(sd, "x", new vscode.Position(4, 11))), [4, 5]);
check("a top-level function name finds every use in the file",
  lineSet(F.scopedOccurrences(sd, "total", new vscode.Position(0, 5))), [0, 8]);
check("symbol lookup is indexed and repeatable",
  F.symbolOccurrences(sd, "x").length === 4 && F.symbolOccurrences(sd, "x").length === 4, true);

// --- diagnostics: Problems totals match real issues
const diag = (line, col, severity, message) => ({
  range: { start: { line, character: col }, end: { line, character: col + 1 } }, severity, message
});
const merged = F.dedupeDiagnostics([
  diag(3, 4, "Error", "Expected '.' after statement"),
  diag(3, 4, "Error", "Expected '.' after statement"),
  diag(3, 4, "Warning", "Expected '.' after statement"),
  diag(7, 0, "Error", "Unknown field 'z'")
]);
check("identical diagnostics collapse, different severities do not", merged.length, 3);
check("every published diagnostic is tagged with the felidae source", merged.every((d) => d.source === "felidae"), true);
check("message position: line N, column M",
  F.diagnosticPositionInMessage("Expected '.' after statement at line 40, column 12", "c:/t.fx"), { line: 39, column: 11 });
check("message position: legacy N:M",
  F.diagnosticPositionInMessage("bad token at 5:3", "c:/t.fx"), { line: 4, column: 2 });
check("an error located in another file is not pinned to this file's line",
  F.diagnosticPositionInMessage("C:\\other\\mod.fx: Expected '.' at line 9, column 2", "c:/t.fx"), { line: 0, column: 0 });
check("an error in this very file keeps its position",
  F.diagnosticPositionInMessage("c:/t.fx: Expected '.' at line 9, column 2", "c:/t.fx"), { line: 8, column: 1 });
check("a message without a position goes to the first line",
  F.diagnosticPositionInMessage("Felidae check failed.", "c:/t.fx"), { line: 0, column: 0 });

// --- three def colours come from one classification
const defSrc = [
  "def Person(name: string).",
  "def total := 3.",
  "def add(a: number, b: number) =>",
  "    def inner := a + b.",
  "    def Person(name: \"x\").",
  "    inner.",
  "end"
].join("\n");
check("def kinds: fact, binding, function, binding, fact",
  F.classifyDefs(F.lexDocument(doc(defSrc)).tokens).map((d) => d.kind),
  ["fact", "binding", "function", "binding", "fact"]);

// --- the whole ancestor chain, outermost first
const nested = [
  "def outer() =>",
  "    for i in xs then",
  "        while ok then",
  "            work(i).",
  "        end",
  "    end",
  "end"
].join("\n");
const np = F.endBlockPairs(nested.split("\n"));
const chainAt = (line) => F.enclosingBlocks(np, line).map((p) => [p.openerLine, p.endLine]);
check("deepest line sees all three enclosing blocks, outermost first", chainAt(3), [[0, 6], [1, 5], [2, 4]]);
check("an inner end line still includes its own block", chainAt(4), [[0, 6], [1, 5], [2, 4]]);
check("the for line is inside def and for only", chainAt(1), [[0, 6], [1, 5]]);
check("the outer end line is inside def only", chainAt(6), [[0, 6]]);
check("outside every block there is no chain", chainAt(7).length, 0);

// --- top-level bindings are "def name := v." (not the retired "name := v.")
const bindingSrc = [
  "def limit := 10.",
  "def label: string := \"x\".",
  "def check(n: number) =>",
  "    def local := n + 1.",
  "    n < limit.",
  "end",
  "def other() =>",
  "    limit.",
  "end"
].join("\n");
const bd = doc(bindingSrc);
check("an untyped top-level binding is a top-level symbol", F.isTopLevelSymbol(bd, "limit"), true);
check("a typed top-level binding is a top-level symbol", F.isTopLevelSymbol(bd, "label"), true);
check("an indented def is local, not top-level", F.isTopLevelSymbol(bd, "local"), false);
check("a parameter is not top-level", F.isTopLevelSymbol(bd, "n"), false);
check("references to a global from inside a function span the whole file",
  [...new Set(F.scopedOccurrences(bd, "limit", new vscode.Position(4, 9)).map((r) => r.start.line))], [0, 4, 7]);
check("a local keeps to its own function",
  [...new Set(F.scopedOccurrences(bd, "local", new vscode.Position(3, 9)).map((r) => r.start.line))], [3]);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
