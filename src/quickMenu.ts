// The entries of the Felidae quick menu, the one place from which everything
// the extension does can be reached: click the "Felidae" item in the status bar,
// or run "Felidae: Menu". Pure data, so the choice of entries can be tested
// without a VS Code host.

export interface MenuState {
  // The active editor holds a Felidae file.
  inFelidaeFile: boolean;
  // That file defines main(...), so Run and Debug apply to it.
  hasMain: boolean;
  errors: number;
  warnings: number;
}

export interface MenuEntry {
  label: string;
  detail: string;
  command: string;
}

export function menuEntries(state: MenuState): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (state.inFelidaeFile) {
    if (state.hasMain) {
      entries.push({ label: "$(play) Run", detail: "Run this file's main(...) in a terminal", command: "felidae.runMain" });
      entries.push({ label: "$(debug-alt) Debug", detail: "Debug this file's main(...)", command: "felidae.debugMain" });
    }
    entries.push({ label: "$(run) Run the def under the cursor", detail: "Shift+Enter runs it and moves to the next def", command: "felidae.runCell" });
    entries.push({ label: "$(run-all) Run all defs", detail: "Every def in this file, one after another", command: "felidae.runAllCells" });
    entries.push({ label: "$(terminal) Open REPL", detail: "felidae --repl in this file's folder", command: "felidae.openRepl" });
    entries.push({ label: "$(sync) Check this file", detail: "Ask the interpreter's parser again now", command: "felidae.checkFile" });
  }
  entries.push({ label: "$(checklist) Check all Felidae files", detail: "Every .fx file in the workspace", command: "felidae.checkWorkspace" });
  const problems = state.errors + state.warnings;
  entries.push({
    label: (state.errors > 0 ? "$(error)" : state.warnings > 0 ? "$(warning)" : "$(pass)") + " Problems",
    detail: problems === 0 ? "None in this file" : state.errors + " error(s), " + state.warnings + " warning(s) in this file",
    command: "workbench.actions.view.problems"
  });
  entries.push({ label: "$(settings-gear) Select interpreter", detail: "Choose the felidae executable", command: "felidae.selectInterpreter" });
  entries.push({ label: "$(output) Show output", detail: "The extension's log", command: "felidae.showOutput" });
  return entries;
}
