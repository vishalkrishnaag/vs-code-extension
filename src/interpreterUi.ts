// Choosing and showing the interpreter for .fx files. The lookup itself is in
// interpreter.ts; this is the VS Code side: a search built from the open file
// and workspace, a status bar item saying which felidae will run and whether it
// can run a program from stdin, and a picker.

import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  InterpreterChoice,
  InterpreterSearch,
  discoverInterpreters,
  parseVersion,
  relativeCandidates,
  resolveInterpreter,
  searchedLocations,
  supportsStdinRuns
} from "./interpreter";

// The search for a file: the setting (or the workspace's .vscode/felidae.json,
// which the caller reads), FELIDAE_PATH, the workspace folders and the file's own
// folder and parents, and PATH.
export function interpreterSearchFor(uri: vscode.Uri | undefined, workspaceOverride: string | undefined): InterpreterSearch {
  return {
    platform: process.platform,
    arch: process.arch,
    configured: workspaceOverride ?? vscode.workspace.getConfiguration("felidae", uri).get<string>("interpreterPath", ""),
    environment: process.env.FELIDAE_PATH,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    notebookFolder: uri && uri.scheme === "file" ? path.dirname(uri.fsPath) : undefined,
    pathDirectories: (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  };
}

// The interpreter path for a file. When nothing is found it still returns a
// plausible path (the first known build location), so a message can name it.
export function resolveInterpreterFor(uri: vscode.Uri | undefined, workspaceOverride: string | undefined): InterpreterChoice {
  const search = interpreterSearchFor(uri, workspaceOverride);
  const choice = resolveInterpreter(search);
  if (choice.path) return choice;
  const base = search.workspaceFolders[0] ?? search.notebookFolder ?? "";
  return { path: path.join(base, relativeCandidates(search.platform, search.arch)[0]), source: "none" };
}

interface Probe {
  version?: string;
  runsFromStdin: boolean;
}

export class InterpreterStatus {
  private readonly item: vscode.StatusBarItem;
  private readonly probes = new Map<string, Promise<Probe>>();

  constructor(
    context: vscode.ExtensionContext,
    private readonly workspaceOverride: (uri: vscode.Uri | undefined) => string | undefined,
    private readonly onChanged: () => void
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 91);
    this.item.command = "felidae.selectInterpreter";
    context.subscriptions.push(
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("felidae.interpreterPath")) {
          this.refresh();
          this.onChanged();
        }
      }),
      vscode.commands.registerCommand("felidae.selectInterpreter", () => this.select())
    );
    this.refresh();
  }

  private activeFelidaeUri(): vscode.Uri | undefined {
    const document = vscode.window.activeTextEditor?.document;
    return document && document.languageId === "felidae" && document.uri.scheme === "file" ? document.uri : undefined;
  }

  private choiceFor(uri: vscode.Uri | undefined): InterpreterChoice {
    return resolveInterpreterFor(uri, this.workspaceOverride(uri));
  }

  // `felidae --version` and `--help`, once per file version. --help tells whether
  // this build can run a program from stdin (reading a binding needs that).
  private probe(interpreter: string): Promise<Probe> {
    let key = interpreter;
    try {
      key += "@" + fs.statSync(interpreter).mtimeMs;
    } catch {
      // Missing file: reported by the caller.
    }
    let probe = this.probes.get(key);
    if (!probe) {
      const run = (argument: string) =>
        new Promise<string>((resolve) => {
          childProcess.execFile(interpreter, [argument], { timeout: 5000, windowsHide: true }, (_error, stdout) => resolve(String(stdout ?? "")));
        });
      probe = Promise.all([run("--version"), run("--help")]).then(([version, help]) => ({
        version: parseVersion(version),
        runsFromStdin: supportsStdinRuns(help)
      }));
      this.probes.set(key, probe);
    }
    return probe;
  }

  refresh(): void {
    const uri = this.activeFelidaeUri();
    if (!uri) {
      this.item.hide();
      return;
    }
    const choice = this.choiceFor(uri);
    if (choice.source === "none" || !fs.existsSync(choice.path)) {
      this.item.text = "$(warning) felidae: not found";
      this.item.tooltip = this.missingMessage(uri, choice);
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.show();
      return;
    }
    this.item.backgroundColor = undefined;
    this.item.text = "$(terminal) felidae";
    this.item.tooltip = choice.path + " (" + choice.source + "). Click to choose another interpreter.";
    this.item.show();
    void this.probe(choice.path).then((probe) => {
      if (this.choiceFor(this.activeFelidaeUri()).path !== choice.path) return;
      this.item.text = "$(terminal) felidae " + (probe.version ?? "");
      this.item.tooltip = choice.path + " (" + choice.source + ")" +
        (probe.runsFromStdin ? "" : "\nThis build cannot run a program from stdin (--stdin), which reading a binding and the notebook need. Rebuild felidae.") +
        "\nClick to choose another interpreter.";
    });
  }

  missingMessage(uri: vscode.Uri | undefined, choice: InterpreterChoice): string {
    if (choice.source === "setting" || choice.source === "environment") {
      return "The felidae interpreter " + (choice.source === "setting" ? "set in felidae.interpreterPath" : "named by FELIDAE_PATH") +
        " does not exist: " + choice.path + ". Run 'Felidae: Select Interpreter' to choose another.";
    }
    return "No felidae interpreter was found. Looked in: " +
      searchedLocations(interpreterSearchFor(uri, this.workspaceOverride(uri))).join("; ") +
      ". Run 'Felidae: Select Interpreter' to choose one.";
  }

  async select(): Promise<void> {
    const uri = this.activeFelidaeUri() ?? vscode.window.activeTextEditor?.document.uri;
    const search = interpreterSearchFor(uri, this.workspaceOverride(uri));
    const current = resolveInterpreter(search);
    const found = discoverInterpreters({ ...search, configured: undefined, environment: undefined });

    type Item = vscode.QuickPickItem & { action: "use" | "browse" | "auto"; path?: string };
    const items: Item[] = found.map((choice) => ({
      label: "$(terminal) " + choice.path,
      description: (choice.source === "path" ? "on PATH" : "build folder") + (choice.path === current.path ? " · in use" : ""),
      action: "use",
      path: choice.path
    }));
    items.push(
      { label: "", kind: vscode.QuickPickItemKind.Separator, action: "browse" },
      { label: "$(folder-opened) Browse for felidae…", action: "browse" },
      { label: "$(sync) Detect automatically", description: "clear felidae.interpreterPath", action: "auto" }
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: "Select the felidae interpreter",
      placeHolder: found.length === 0 ? "None found in the usual build folders or on PATH" : "Currently: " + (current.path || "none")
    });
    if (!picked) return;

    let value: string | undefined;
    if (picked.action === "browse") {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Use this interpreter",
        filters: process.platform === "win32" ? { Executable: ["exe"] } : undefined
      });
      if (!chosen || chosen.length === 0) return;
      value = chosen[0].fsPath;
    } else if (picked.action === "use") {
      value = picked.path;
    }

    const target = (vscode.workspace.workspaceFolders?.length ?? 0) > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    try {
      await vscode.workspace.getConfiguration("felidae").update("interpreterPath", value, target);
    } catch (error) {
      void vscode.window.showErrorMessage("Could not save felidae.interpreterPath: " + (error as Error).message);
      return;
    }
    void vscode.window.showInformationMessage(
      value
        ? "Felidae interpreter set to " + value + " (" + (target === vscode.ConfigurationTarget.Workspace ? "workspace" : "user") + " setting)."
        : "Felidae interpreter will be detected automatically."
    );
    this.refresh();
    this.onChanged();
  }
}
