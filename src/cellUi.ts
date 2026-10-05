// Cells in the editor: Run / Debug on every top-level def, with the result
// beside the code. Splitting lives in cells.ts and process handling in
// cellRunner.ts; this file is only the VS Code glue.
//
// A cell runs as an ordinary `felidae file.fx --query "expr."` process, one at
// a time, and ends when that process ends. There is no background process, no
// session and no retry: whatever the interpreter reports is what is shown.

import * as path from "path";
import * as vscode from "vscode";
import { BlockPair, Cell, RESULT_FUNCTION, bindingProgram, buildCellExpression, cellAtLine, defaultArguments, hashText, splitCells } from "./cells";
import { CellRunner, describeCellRun } from "./cellRunner";
import { CellMetrics, summarizeMetrics } from "./metrics";

export type CellLogLevel = "trace" | "debug" | "info" | "warn" | "error";

// What the glue needs from the extension, passed in rather than imported so
// the two modules do not depend on each other.
export interface CellHost {
  resolveInterpreterPath(uri: vscode.Uri): string;
  ensureInterpreterInstalled(interpreterPath: string): Promise<boolean>;
  blockPairs(document: vscode.TextDocument): BlockPair[];
  log(level: CellLogLevel, message: string): void;
}

interface CellResult {
  state: "running" | "ok" | "error";
  expression: string;
  // Everything the process wrote (print output and the value), or the error.
  text: string;
  // Whole process time, including loading the file.
  elapsedMs?: number;
  // The interpreter's own account of the run (--metrics-json).
  metrics?: CellMetrics;
  // Hash of the cell's source when it ran; a different hash means the cell
  // was edited afterwards and the result is stale.
  sourceHash: number;
}

export function registerCells(context: vscode.ExtensionContext, host: CellHost): void {
  new CellSession(context, host).register();
}

const cellKey = (cell: Cell) => cell.kind + ":" + cell.name;

class CellSession {
  private readonly runner = new CellRunner();
  private readonly results = new Map<string, Map<string, CellResult>>();
  private readonly cellCache = new WeakMap<vscode.TextDocument, { version: number; cells: Cell[] }>();
  private readonly channel: vscode.OutputChannel;
  private readonly status: vscode.StatusBarItem;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private pending = 0;

  private readonly okDecoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor("editorCodeLens.foreground"), fontStyle: "italic", margin: "0 0 0 2em" }
  });
  private readonly errorDecoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor("editorError.foreground"), fontStyle: "italic", margin: "0 0 0 2em" }
  });
  private readonly staleDecoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor("editorCodeLens.foreground"), fontStyle: "italic", margin: "0 0 0 2em" },
    opacity: "0.55"
  });

  constructor(private readonly context: vscode.ExtensionContext, private readonly host: CellHost) {
    this.channel = vscode.window.createOutputChannel("Felidae Cells");
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 89);
    this.status.command = "felidae.stopCell";
    this.status.text = "$(sync~spin) Felidae cell running";
    this.status.tooltip = "A cell is running as its own felidae process. Click to stop it.";
  }

  register(): void {
    // Real files only: a notebook cell is also a "felidae" document, and it
    // must not get this extension's file-cell lenses.
    const selector = { language: "felidae", scheme: "file" };
    this.context.subscriptions.push(
      this.channel,
      this.status,
      this.okDecoration,
      this.errorDecoration,
      this.staleDecoration,
      vscode.languages.registerCodeLensProvider(selector, { provideCodeLenses: (document) => this.lenses(document) }),
      vscode.commands.registerCommand("felidae.runCell", (uri?: vscode.Uri, line?: number) => this.command(uri, line, "run")),
      vscode.commands.registerCommand("felidae.runCellAndAdvance", (uri?: vscode.Uri, line?: number) => this.command(uri, line, "advance")),
      vscode.commands.registerCommand("felidae.runCellsBelow", (uri?: vscode.Uri, line?: number) => this.command(uri, line, "below")),
      vscode.commands.registerCommand("felidae.runAllCells", (uri?: vscode.Uri) => this.command(uri, undefined, "all")),
      vscode.commands.registerCommand("felidae.debugCell", (uri?: vscode.Uri, line?: number) => this.debugCell(uri, line)),
      vscode.commands.registerCommand("felidae.stopCell", () => this.runner.cancel()),
      vscode.commands.registerCommand("felidae.clearCellResults", () => this.clearResults()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.workspace.onDidChangeTextDocument((event) => this.scheduleDecorations(event.document)),
      { dispose: () => this.runner.cancel() }
    );
  }

  // ------------------------------------------------------------------ cells

  private cellsOf(document: vscode.TextDocument): Cell[] {
    const cached = this.cellCache.get(document);
    if (cached && cached.version === document.version) return cached.cells;
    const lines: string[] = [];
    for (let line = 0; line < document.lineCount; line++) lines.push(document.lineAt(line).text);
    const cells = splitCells(lines, this.host.blockPairs(document));
    this.cellCache.set(document, { version: document.version, cells });
    return cells;
  }

  private sourceHash(document: vscode.TextDocument, cell: Cell): number {
    const lines: string[] = [];
    for (let line = cell.startLine; line <= cell.endLine; line++) lines.push(document.lineAt(line).text);
    return hashText(lines.join("\n"));
  }

  // ------------------------------------------------------------------ lenses

  private lenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    // The entry function keeps the existing Run / Debug lens.
    const cells = this.cellsOf(document).filter((cell) => cell.kind !== "entry");
    if (cells.length === 0) return lenses;

    lenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      title: "$(run-all) Run All Cells",
      command: "felidae.runAllCells",
      arguments: [document.uri]
    }));
    for (const cell of cells) {
      const range = new vscode.Range(cell.headerLine, 0, cell.headerLine, 0);
      const args = [document.uri, cell.headerLine];
      lenses.push(new vscode.CodeLens(range, { title: "$(play) Run", command: "felidae.runCell", arguments: args }));
      if (cell.kind === "function" || cell.kind === "binding") {
        lenses.push(new vscode.CodeLens(range, { title: "$(debug-alt) Debug", command: "felidae.debugCell", arguments: args }));
      }
    }
    return lenses;
  }

  // ------------------------------------------------------------------ commands

  private async command(uri: vscode.Uri | undefined, line: number | undefined, mode: "run" | "advance" | "below" | "all"): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const document = uri
      ? await vscode.workspace.openTextDocument(uri)
      : editor?.document.languageId === "felidae" ? editor.document : undefined;
    if (!document || document.languageId !== "felidae") {
      void vscode.window.showWarningMessage("Open a Felidae .fx file to run its cells.");
      return;
    }
    if (document.uri.scheme !== "file") {
      void vscode.window.showInformationMessage("This is a notebook cell. Run it with the notebook's Run button or Shift+Enter (Felidae Notebook).");
      return;
    }
    const cells = this.cellsOf(document).filter((cell) => cell.kind !== "entry");
    const cursorLine = line ?? (editor && editor.document === document ? editor.selection.active.line : 0);
    const current = cellAtLine(cells, cursorLine);

    if (mode === "run" || mode === "advance") {
      if (!current) {
        void vscode.window.showInformationMessage("No cell at the cursor. A cell is a top-level def or class.");
        return;
      }
      const done = await this.runCell(document, current, true);
      if (done && mode === "advance" && editor && editor.document === document) {
        const next = cells[cells.indexOf(current) + 1];
        if (next) {
          const target = new vscode.Position(next.headerLine, 0);
          editor.selection = new vscode.Selection(target, target);
          editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
      }
      return;
    }

    // Batch: functions that need arguments are skipped rather than prompting
    // dozens of times; the first cell that fails stops the run.
    const batch = mode === "all" ? cells : cells.slice(current ? cells.indexOf(current) : cells.length);
    for (const cell of batch) {
      if (cell.kind === "function" && cell.params.length > 0) {
        this.host.log("info", "run cells: skipped " + cell.name + " (needs arguments)");
        continue;
      }
      if (!(await this.runCell(document, cell, false))) break;
    }
  }

  // True when the cell succeeded; false when it was cancelled or failed, which
  // also ends a batch run.
  private async runCell(document: vscode.TextDocument, cell: Cell, mayPrompt: boolean): Promise<boolean> {
    const args = await this.argumentsFor(document, cell, mayPrompt);
    if (args === undefined) return false;
    const expression = buildCellExpression(cell, args);

    // The process reads the file from disk, so unsaved edits must be saved.
    if (document.isDirty) await document.save();
    const interpreter = this.host.resolveInterpreterPath(document.uri);
    if (!(await this.host.ensureInterpreterInstalled(interpreter))) return false;

    const hash = this.sourceHash(document, cell);
    this.setResult(document, cell, { state: "running", expression, text: "", sourceHash: hash });
    const timeoutMs = this.timeoutMs(document);
    // A binding is read through a generated function (see bindingProgram); every
    // other cell is a plain --query on the file.
    const readsBinding = cell.kind === "binding";
    const processArgs = readsBinding
      ? [document.uri.fsPath, "--stdin", "--query", RESULT_FUNCTION + "().", "--metrics-json"]
      : [document.uri.fsPath, "--query", expression, "--metrics-json"];
    const commandLine = [interpreter, ...processArgs];
    this.host.log("info", "cell: " + commandLine.join(" "));

    this.setPending(1);
    let result: CellResult;
    try {
      const run = await this.runner.run({
        command: interpreter,
        args: processArgs,
        cwd: path.dirname(document.uri.fsPath),
        timeoutMs,
        stdin: readsBinding ? bindingProgram(document.getText(), cell.name) : undefined
      });
      const described = describeCellRun(run, timeoutMs);
      if (!described.ok && /--stdin is valid only with --check-json/.test(described.text)) {
        described.text += "\nReading a binding needs a felidae build that can run a program from stdin (--stdin). Rebuild the interpreter.";
      }
      result = { state: described.ok ? "ok" : "error", expression, text: described.text, elapsedMs: run.elapsedMs, metrics: run.metrics, sourceHash: hash };
    } finally {
      this.setPending(-1);
    }
    this.setResult(document, cell, result);
    this.logCell(document, cell, result);
    return result.state === "ok";
  }

  // The status item is visible only while a cell process exists or is queued.
  private setPending(delta: number): void {
    this.pending += delta;
    if (this.pending > 0) this.status.show();
    else this.status.hide();
  }

  // A function with parameters asks for its arguments, offering what was
  // typed last time; undefined means the user cancelled.
  private async argumentsFor(document: vscode.TextDocument, cell: Cell, mayPrompt: boolean): Promise<string | undefined> {
    if (cell.kind !== "function" || cell.params.length === 0) return "";
    if (!mayPrompt) return "";
    const memoryKey = "felidae.cellArgs:" + document.uri.toString() + ":" + cell.name;
    const typed = await vscode.window.showInputBox({
      title: "Run " + cell.name,
      prompt: cell.name + "(" + cell.params.map((p) => (p.type ? p.name + ": " + p.type : p.name)).join(", ") + ")",
      value: this.context.workspaceState.get<string>(memoryKey) ?? defaultArguments(cell),
      ignoreFocusOut: true
    });
    if (typed === undefined) return undefined;
    await this.context.workspaceState.update(memoryKey, typed);
    return typed;
  }

  private async debugCell(uri: vscode.Uri | undefined, line: number | undefined): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
    if (!document || document.languageId !== "felidae" || document.uri.scheme !== "file") return;
    const cell = cellAtLine(this.cellsOf(document), line ?? editor?.selection.active.line ?? 0);
    if (!cell) return;
    if (cell.kind === "entry") {
      await vscode.commands.executeCommand("felidae.debugMain", document.uri);
      return;
    }
    const args = await this.argumentsFor(document, cell, true);
    if (args === undefined) return;
    const expression = buildCellExpression(cell, args);

    if (document.isDirty) await document.save();
    const interpreter = this.host.resolveInterpreterPath(document.uri);
    if (!(await this.host.ensureInterpreterInstalled(interpreter))) return;
    // felidae program.fx --debug --query "expression."
    await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(document.uri), {
      type: "felidae",
      request: "launch",
      name: "Debug " + cell.name,
      program: document.uri.fsPath,
      interpreterPath: interpreter,
      stopOnEntry: true,
      query: expression
    });
  }

  private timeoutMs(document: vscode.TextDocument): number {
    const seconds = vscode.workspace.getConfiguration("felidae", document.uri).get<number>("cells.runTimeoutSeconds", 60);
    return Math.max(1, seconds) * 1000;
  }

  // ------------------------------------------------------------------ results

  private setResult(document: vscode.TextDocument, cell: Cell, result: CellResult): void {
    const key = document.uri.toString();
    const perDocument = this.results.get(key) ?? new Map<string, CellResult>();
    perDocument.set(cellKey(cell), result);
    this.results.set(key, perDocument);
    this.refreshDecorations(document);
  }

  private clearResults(): void {
    this.results.clear();
    this.refreshDecorations();
  }

  private scheduleDecorations(document: vscode.TextDocument): void {
    if (document.languageId !== "felidae" || !this.results.has(document.uri.toString())) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshDecorations(document), 150);
  }

  private refreshDecorations(only?: vscode.TextDocument): void {
    const inline = vscode.workspace.getConfiguration("felidae").get<boolean>("cells.inlineResults", true);
    for (const editor of vscode.window.visibleTextEditors) {
      const document = editor.document;
      if (document.languageId !== "felidae" || (only && document !== only)) continue;
      const ok: vscode.DecorationOptions[] = [];
      const failed: vscode.DecorationOptions[] = [];
      const stale: vscode.DecorationOptions[] = [];
      const perDocument = this.results.get(document.uri.toString());
      if (inline && perDocument) {
        for (const cell of this.cellsOf(document)) {
          const result = perDocument.get(cellKey(cell));
          if (!result) continue;
          const isStale = result.state !== "running" && result.sourceHash !== this.sourceHash(document, cell);
          const lineEnd = document.lineAt(cell.headerLine).text.length;
          const option: vscode.DecorationOptions = {
            range: new vscode.Range(cell.headerLine, lineEnd, cell.headerLine, lineEnd),
            hoverMessage: this.hover(result, isStale),
            renderOptions: { after: { contentText: this.inlineText(result, isStale) } }
          };
          (isStale ? stale : result.state === "error" ? failed : ok).push(option);
        }
      }
      editor.setDecorations(this.okDecoration, ok);
      editor.setDecorations(this.errorDecoration, failed);
      editor.setDecorations(this.staleDecoration, stale);
    }
  }

  // First line of the text, with how many more there are; the full text is in
  // the hover and in the Felidae Cells channel.
  private summary(text: string, limit = 80): string {
    const lines = text.split(/\r?\n/).filter((part) => part.trim().length > 0);
    if (lines.length === 0) return "";
    const first = lines[0].length > limit ? lines[0].slice(0, limit - 1) + "…" : lines[0];
    return lines.length > 1 ? first + "  (+" + (lines.length - 1) + " more)" : first;
  }

  private inlineText(result: CellResult, isStale: boolean): string {
    // The interpreter's own run time for the cell when it reported one;
    // otherwise the whole process time.
    const shown = result.metrics?.executionMs ?? result.elapsedMs;
    const timing = shown !== undefined ? " · " + (shown < 10 ? shown.toFixed(1) : Math.round(shown)) + " ms" : "";
    const prefix = isStale ? "(stale) " : "";
    switch (result.state) {
      case "running":
        return "⏳ running…";
      case "ok":
        return prefix + "→ " + (this.summary(result.text) || "ok") + timing;
      default:
        return prefix + "✗ " + this.summary(result.text);
    }
  }

  private hover(result: CellResult, isStale: boolean): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    if (isStale) markdown.appendMarkdown("_The cell changed after this result._\n\n");
    markdown.appendCodeblock(result.expression, "felidae");
    if (result.state === "ok") markdown.appendMarkdown("**Output**\n").appendCodeblock(result.text || "(none)", "text");
    if (result.state === "error") markdown.appendMarkdown("**Error**\n").appendCodeblock(result.text, "text");
    if (result.metrics) {
      const summary = summarizeMetrics(result.metrics);
      markdown.appendMarkdown("**Metrics**\n\n" + summary.lines.map((line) => "- " + line).join("\n") + "\n");
      if (summary.hints.length > 0) markdown.appendMarkdown("\n" + summary.hints.map((hint) => "- ⚠ " + hint).join("\n") + "\n");
    }
    return markdown;
  }

  private logCell(document: vscode.TextDocument, cell: Cell, result: CellResult): void {
    const stamp = new Date().toLocaleTimeString();
    this.channel.appendLine("[" + stamp + "] " + path.basename(document.uri.fsPath) + " · " + cell.kind + " " + cell.name);
    this.channel.appendLine("  > " + result.expression);
    const body = result.text.trimEnd().split("\n").map((line) => (result.state === "ok" ? "  | " : "  ! ") + line).join("\n");
    this.channel.appendLine(body || "  | (no output)");
    if (result.metrics) {
      const summary = summarizeMetrics(result.metrics);
      for (const line of summary.lines) this.channel.appendLine("  · " + line);
      for (const hint of summary.hints) this.channel.appendLine("  ⚠ " + hint);
    } else if (result.elapsedMs !== undefined) {
      this.channel.appendLine("  (" + result.elapsedMs.toFixed(0) + " ms)");
    }
    this.channel.appendLine("");
  }
}
