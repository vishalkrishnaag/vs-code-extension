const path = require("path");
const { docCommentAbove, conditionalEndInsertion, findUnusedLocals } = require(path.resolve(__dirname, "..", "out", "editing.js"));

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  ok  ", name); } else { fail++; console.log("  FAIL", name, "\n     exp", e, "\n     act", a); }
};

// ---- doc comments
const src = ["# Adds one.", "# Used by main.", "def inc(x: number) =>", "    x + 1.", "end", "", "# unrelated", "", "def other() =>", "    1.", "end"];
check("the comment lines directly above a def are its doc", docCommentAbove(src, 2), ["Adds one.", "Used by main."]);
check("a comment separated by a blank line is not its doc", docCommentAbove(src, 8), []);
check("a def with nothing above has no doc", docCommentAbove(["def f() =>", "end"], 0), []);
check("the # and one space are removed, deeper indentation kept", docCommentAbove(["#   indented note", "def f() =>"], 1), ["  indented note"]);
check("a code line stops the comment", docCommentAbove(["x := 1.", "# note", "def f() =>"], 2), ["note"]);

// ---- where a missing conditional `end` goes
check("the parser's message names the place, which is returned zero-based",
  conditionalEndInsertion("A conditional ends with 'end': add it after the last branch at line 2, column 37"), { line: 1, column: 36 });
check("any other message gives nothing", conditionalEndInsertion("Expected an expression at line 1, column 2"), undefined);

// ---- unused locals and parameters (tokens as the extension's lexer makes them)
function lex(text) {
  const tokens = [];
  text.split("\n").forEach((line, lineIndex) => {
    const re = /[A-Za-z_][A-Za-z0-9_]*|:=|=>|[():,.]|"[^"]*"|\d+/g;
    let m;
    while ((m = re.exec(line.replace(/#.*$/, ""))) !== null) {
      const t = m[0];
      const kind = t === ":=" ? "bind" : t === "=>" ? "arrow" : t === "(" ? "lparen" : t === ")" ? "rparen" : t === ":" ? "colon" : t === "," ? "comma" : t === "." ? "dot" : /^\d/.test(t) ? "number" : t[0] === '"' ? "string" : "ident";
      tokens.push({ kind, text: t, line: lineIndex, start: m.index, end: m.index + t.length });
    }
  });
  return tokens;
}
const blocks = (text) => {
  const lines = text.split("\n"), out = [], stack = [];
  lines.forEach((l, i) => { if (/^def .*=>\s*$/.test(l)) stack.push(i); else if (/^end\s*$/.test(l)) out.push({ openerLine: stack.pop(), endLine: i }); });
  return out;
};
const unusedIn = (text) => findUnusedLocals(lex(text), blocks(text)).map((u) => [u.kind, u.name, u.line]);

check("an unused parameter and an unused local are found",
  unusedIn("def f(a: number, b: number) =>\n    def temp := a + 1.\n    def kept := a.\n    kept.\nend"),
  [["parameter", "b", 0], ["binding", "temp", 1]]);
check("names that are used are not reported", unusedIn("def f(a: number) =>\n    def x := a.\n    x.\nend"), []);
check("a name starting with an underscore is deliberately unused", unusedIn("def f(_ignored: number, a: number) =>\n    a.\nend"), []);
check("a name used only as a named-argument key still counts as used (conservative)",
  unusedIn("def f(value: number) =>\n    g(value: 1).\nend"), []);
check("a typed local is found too", unusedIn("def f() =>\n    def n: number := 3.\n    1.\nend"), [["binding", "n", 1]]);
check("facts and top-level bindings are never reported",
  unusedIn("def Employee(id: \"e1\").\ndef total := 1.\ndef f() =>\n    total.\nend"), []);
check("two functions are judged separately",
  unusedIn("def f(a: number) =>\n    a.\nend\ndef g(a: number) =>\n    1.\nend"), [["parameter", "a", 3]]);
check("a function with no parameters and no locals reports nothing", unusedIn("def f() =>\n    1.\nend"), []);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
