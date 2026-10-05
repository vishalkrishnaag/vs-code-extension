// Cell splitting and the one-process-per-cell runner. Pure Node: out/cells.js and
// out/kernel.js do not import vscode; the block pairs come from the extension's
// own endBlockPairs, loaded with the vscode stub like the other suites.
const path = require("path"), fs = require("fs"), Module = require("module");
const stub = path.resolve(__dirname, "vscode-stub.js");
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { if (r === "vscode") return stub; return orig.call(this, r, ...a); };
require(stub);

const EXT = path.resolve(__dirname, "..", "out", "extension.js");
const src = fs.readFileSync(EXT, "utf8") + "\nmodule.exports.__p = { endBlockPairs };";
const mod = new Module(EXT); mod.filename = EXT; mod.paths = Module._nodeModulePaths(path.dirname(EXT));
mod._compile(src, EXT);
const { endBlockPairs } = mod.exports.__p;

const cells = require(path.resolve(__dirname, "..", "out", "cells.js"));
const { CellRunner, describeCellRun } = require(path.resolve(__dirname, "..", "out", "cellRunner.js"));
const { extractMetrics, summarizeMetrics } = require(path.resolve(__dirname, "..", "out", "metrics.js"));

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  ok  ", name); } else { fail++; console.log("  FAIL", name, "\n     exp", e, "\n     act", a); }
};

// ---------------------------------------------------------------- cell splitting
const program = [
  "import \"math\".",              // 0
  "",                              // 1
  "# Employees seeded on load.",   // 2
  "def Employee(id: \"e1\",",      // 3  multi-line fact
  "             state: active).",  // 4
  "def limit := 10.",              // 5  binding
  "def label: string := \"x\".",   // 6  typed binding
  "",                              // 7
  "# Adds two numbers.",           // 8
  "def add(a: number, b: number) =>", // 9
  "    def total := a + b.",       // 10 inner def is not a cell
  "    for i in xs then",          // 11
  "        total.",                // 12
  "    end",                       // 13
  "    total.",                    // 14
  "end",                           // 15
  "",                              // 16
  "class Visit",                   // 17
  "    key(id).",                  // 18
  "    def id: string.",           // 19
  "end",                           // 20
  "def main() =>",                 // 21
  "    add(a: 1, b: 2).",          // 22
  "end"                            // 23
];
const found = cells.splitCells(program, endBlockPairs(program));
const brief = (c) => [c.kind, c.name, c.headerLine, c.startLine, c.endLine];
check("cells found, in file order, inner defs excluded", found.map(brief), [
  ["fact", "Employee", 3, 2, 4],
  ["binding", "limit", 5, 5, 5],
  ["binding", "label", 6, 6, 6],
  ["function", "add", 9, 8, 15],
  ["class", "Visit", 17, 17, 20],
  ["entry", "main", 21, 21, 23]
]);
check("function parameters keep their types", found[3].params, [{ name: "a", type: "number" }, { name: "b", type: "number" }]);
check("a fact has no parameters", found[0].params, []);

// ---------------------------------------------------------------- cell at a line
check("a line inside a block finds that cell", cells.cellAtLine(found, 12).name, "add");
check("a comment above a cell belongs to it", cells.cellAtLine(found, 8).name, "add");
check("a blank line between cells finds the next one", cells.cellAtLine(found, 16).name, "Visit");
check("past the last cell there is none", cells.cellAtLine(found, 99), undefined);

// ---------------------------------------------------------------- expressions
check("function with arguments", cells.buildCellExpression(found[3], " a: 1, b: 2 "), "add(a: 1, b: 2).");
check("function without arguments", cells.buildCellExpression({ kind: "function", name: "now", params: [] }), "now().");
check("binding reads the global", cells.buildCellExpression(found[1]), "limit.");
check("fact shows its rows", cells.buildCellExpression(found[0]), "Employee.all().");
check("class shows its instances", cells.buildCellExpression(found[4]), "Visit.all().");
check("argument template names every parameter", cells.defaultArguments(found[3]), "a: , b: ");
check("the entry function is not a cell expression",
  (() => { try { cells.buildCellExpression(found[5]); return "no error"; } catch (e) { return "throws"; } })(), "throws");
check("hash differs when the source differs", cells.hashText("def a := 1.") !== cells.hashText("def a := 2."), true);

// stdlib native declarations: "def f(...) => ()" still closes with end
const native = [
  "# Native math declarations.",
  "def math.pi() => ()",
  "end",
  "def math.pow(base: number, exponent: number) => ()",
  "end"
];
const nativeCells = cells.splitCells(native, endBlockPairs(native));
check("native declarations are function cells with their own end",
  nativeCells.map((c) => [c.kind, c.name, c.headerLine, c.endLine]),
  [["function", "math.pi", 1, 2], ["function", "math.pow", 3, 4]]);
check("native declaration parameters are read", nativeCells[1].params.map((p) => p.name), ["base", "exponent"]);

// robustness on odd input
check("an empty file has no cells", cells.splitCells([""], []).length, 0);
check("an unclosed def is a single-line cell, not a crash",
  cells.splitCells(["def broken(", "    x"], []).length, 1);

// ---------------------------------------------------------------- metrics (--metrics-json)
// Exactly the shape the interpreter prints: stderr, with newlines before the commas.
const realBlock = 'FELIDAE_METRICS {"loadMs":155.674\n,"executionMs":19.249\n,"queryRuns":1\n,"firstQueryMs":18.7216\n,"repeatedQueryAverageMs":0\n,"runtime":{"durableStore":true,"clauseAttempts":0,"unificationAttempts":165,"factCandidates":0,"rocksPointReads":0,"rocksTypeScans":0,"rocksFullScans":0,"rocksIndexScans":0,"rocksLinkScans":0,"rocksFactRowsScanned":0,"rocksIndexRowsScanned":0,"rocksLinksVisited":0,"rocksFactWrites":0,"rocksLinkWrites":0,"solutionMaterializations":55,"moduleLoads":3,"parserTokensLexed":1471,"streamedModuleMicros":35740,"dispatchCacheHits":2009,"dispatchCacheMisses":18}}\n';
const extracted = extractMetrics(realBlock);
check("the interpreter's multi-line metrics block is parsed", [extracted.metrics.loadMs, extracted.metrics.executionMs, extracted.metrics.runtime.unificationAttempts], [155.674, 19.249, 165]);
check("nothing is left over once the block is removed", extracted.rest, "");
check("text before the block is kept as the remaining stderr", extractMetrics("warning: x\n" + realBlock).rest, "warning: x\n");
check("text after the block is kept too", extractMetrics(realBlock + "trailing note\n").rest, "trailing note\n");
check("stderr without metrics is returned untouched", extractMetrics("error: boom\n"), { rest: "error: boom\n" });
check("a damaged block is left in place, not guessed at", extractMetrics("FELIDAE_METRICS {\"loadMs\":1,").metrics, undefined);

const quiet = summarizeMetrics(extracted.metrics);
check("a read-only cell has no hints", quiet.hints, []);
check("the summary separates run time from load time", /^run 19 ms · load 156 ms/.test(quiet.lines[0]), true);
check("the dispatch cache hit rate is reported", quiet.lines.some((l) => /99% hits of 2027/.test(l)), true);
const heavy = summarizeMetrics({ loadMs: 5, executionMs: 40, runtime: { durableStore: true, rocksFullScans: 2, rocksFactRowsScanned: 120, rocksFactWrites: 1, rocksLinkWrites: 3 } });
check("a full scan produces an index hint", heavy.hints.some((h) => /whole fact store 2 times \(120 rows\)/.test(h) && /index/.test(h)), true);
check("a write is called out as a side effect", heavy.hints.some((h) => /wrote to the database \(1 fact, 3 links\)/.test(h)), true);
check("database lines appear when the store was used", heavy.lines.some((l) => /database writes: 1 fact, 3 links/.test(l)), true);

// ---------------------------------------------------------------- cell runner
const FAKE = path.resolve(__dirname, "fake-felidae.js");
const options = (expression, extra = {}) => ({
  command: process.execPath,
  args: [FAKE, "program.fx", "--query", expression],
  cwd: __dirname,
  timeoutMs: 5000,
  ...extra
});

(async () => {
  const runner = new CellRunner();

  const ok = await runner.run(options("f(a: 1)."));
  check("a successful cell returns its stdout", [ok.ok, ok.exitCode, ok.stdout.trim()], [true, 0, "echo:f(a: 1)."]);
  check("a finished cell leaves no process behind", runner.running, false);
  check("a successful run is described by its output", describeCellRun(ok, 5000), { ok: true, text: "echo:f(a: 1)." });

  const withMetrics = await runner.run({ ...options("m."), args: [FAKE, "program.fx", "--query", "m.", "--metrics-json"] });
  check("metrics are taken from stderr and the cell still succeeds", [withMetrics.ok, withMetrics.metrics && withMetrics.metrics.executionMs], [true, 0.8]);
  check("stderr no longer contains the metrics block", withMetrics.stderr, "");
  check("the output is only the cell's own output", withMetrics.stdout.trim(), "echo:m.");

  const printed = await runner.run(options("print."));
  check("print output and the value arrive together, in order", printed.stdout, "hello\n42\n");

  const failed = await runner.run(options("fail."));
  check("a failing cell reports its own error and exit code", [failed.ok, failed.exitCode], [false, 1]);
  check("the error is shown as the interpreter wrote it, without the prefix",
    describeCellRun(failed, 5000), { ok: false, text: "boom at line 1, column 2" });

  // Runs are queued: only one felidae process exists at a time (RocksDB allows one per directory).
  const order = [];
  await Promise.all([
    runner.run(options("slow.")).then(() => order.push("slow")),
    runner.run(options("quick.")).then(() => order.push("quick"))
  ]);
  check("a queued cell starts only after the one before it finished", order, ["slow", "quick"]);

  const hung = await new CellRunner().run(options("hang.", { timeoutMs: 150 }));
  check("a hung cell is stopped at the timeout", [hung.ok, hung.timedOut], [false, true]);
  check("a timeout is described with the limit", /within 0\.15 s/.test(describeCellRun(hung, 150).text), true);

  const cancelling = new CellRunner();
  const pendingRun = cancelling.run(options("hang."));
  await new Promise((resolve) => setTimeout(resolve, 100));
  check("a running cell reports running", cancelling.running, true);
  cancelling.cancel();
  const cancelled = await pendingRun;
  check("a cancelled cell is reported as stopped", [cancelled.ok, cancelled.cancelled, describeCellRun(cancelled, 5000).text], [false, true, "Stopped."]);

  const missing = await new CellRunner().run({ command: "definitely-not-a-real-felidae", args: [], cwd: __dirname, timeoutMs: 5000 });
  check("a missing executable fails with a message instead of throwing", [missing.ok, missing.stderr.length > 0], [false, true]);

  const unsupported = await new CellRunner().run({ command: process.execPath, args: [FAKE, "program.fx", "--nope", "x."], cwd: __dirname, timeoutMs: 5000 });
  check("an interpreter that rejects the arguments surfaces its message",
    describeCellRun(unsupported, 5000).text, "Unknown option: --nope");

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
