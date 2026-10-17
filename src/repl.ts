// The interpreter's own REPL, inside VS Code, for trying code as you edit it.
//
//   Felidae: Open REPL          starts `felidae-repl` in a terminal, in the
//                               current file's folder (it saves repl.fx there, and a
//                               program that keeps facts reads ./init.fx beside it)
//   Felidae: Send to REPL       sends the selection, or else the def block under
//                               the cursor, or else the current line
//
// The REPL is the interpreter's normal interactive mode, run in a terminal you
// own: the extension keeps no session of its own, and when the REPL exits (or you
// close the terminal) it is gone. The REPL asks whether to run in append mode (all
// code is kept in repl.fx and the whole file runs each time) or not (each input
// replaces the file). A program that keeps facts holds its TidesDB database open
// while it runs, so a second program on the same project at the same time reports
// the store's lock error.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { BlockPair, cellAtLine, splitCells } from "./cells";
import { replExecutable } from "./interpreter";

export interface ReplHost {
  resolveInterpreterPath(uri: vscode.Uri): string;
  ensureInterpreterInstalled(interpreterPath: string): Promise<boolean>;
  blockPairs(document: vscode.TextDocument): BlockPair[];
  log(level: "info" | "warn" | "error", message: string): void;
}

// What to send for the cursor: the selection, else the whole def/class block it
// is in (the REPL needs a block complete), else the current line.
export function replTextFor(lines: readonly string[], pairs: readonly BlockPair[], selectionText: string, cursorLine: number): string {
  if (selectionText.trim() !== "") return selectionText.replace(/\s+$/, "");
  const cell = cellAtLine(splitCells(lines, pairs), cursorLine);
  if (cell && cursorLine >= cell.startLine && cursorLine <= cell.endLine) {
    return lines.slice(cell.startLine, cell.endLine + 1).join("\n");
  }
  return (lines[cursorLine] ?? "").trim();
}

export function registerRepl(context: vscode.ExtensionContext, host: ReplHost): void {
  let terminal: vscode.Terminal | undefined;

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) terminal = undefined;
    })
  );

  const open = async (document: vscode.TextDocument | undefined): Promise<vscode.Terminal | undefined> => {
    if (terminal && terminal.exitStatus === undefined) {
      terminal.show(true);
      return terminal;
    }
    if (!document || document.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Open a saved Felidae file first: the REPL starts in that file's folder.");
      return undefined;
    }
    const folder = path.dirname(document.uri.fsPath);
    const interpreter = host.resolveInterpreterPath(document.uri);
    const repl = replExecutable(interpreter, process.platform);
    if (path.isAbsolute(repl) && !fs.existsSync(repl)) {
      void vscode.window.showWarningMessage("The REPL is not built: " + repl + " is missing. Run ./gradlew installDist in the Felidae repository.");
      return undefined;
    }
    host.log("info", "repl: " + repl + " " + folder);
    // The terminal runs felidae-repl itself, not a shell, so it ends when the REPL does.
    terminal = vscode.window.createTerminal({ name: "Felidae REPL", cwd: folder, shellPath: repl, shellArgs: [folder] });
    terminal.show(true);
    return terminal;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("felidae.openRepl", async () => {
      await open(vscode.window.activeTextEditor?.document);
    }),
    vscode.commands.registerCommand("felidae.sendToRepl", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "felidae") {
        void vscode.window.showWarningMessage("Open a Felidae file to send code to the REPL.");
        return;
      }
      const document = editor.document;
      const lines: string[] = [];
      for (let line = 0; line < document.lineCount; line++) lines.push(document.lineAt(line).text);
      const text = replTextFor(lines, host.blockPairs(document), document.getText(editor.selection), editor.selection.active.line);
      if (text.trim() === "") return;
      const target = await open(document);
      if (!target) return;
      target.sendText(text, true);
    })
  );
}
