const path = require("path");
const { menuEntries } = require(path.resolve(__dirname, "..", "out", "quickMenu.js"));

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  ok  ", name); } else { fail++; console.log("  FAIL", name, "\n     exp", e, "\n     act", a); }
};
const commands = (state) => menuEntries(state).map((entry) => entry.command);

check("outside a Felidae file only the workspace-wide entries appear",
  commands({ inFelidaeFile: false, hasMain: false, errors: 0, warnings: 0 }),
  ["felidae.checkWorkspace", "workbench.actions.view.problems", "felidae.selectInterpreter", "felidae.showOutput"]);
check("Run and Debug appear only for a file with main",
  [true, false].map((hasMain) => commands({ inFelidaeFile: true, hasMain, errors: 0, warnings: 0 }).includes("felidae.runMain")),
  [true, false]);
check("a file without main can still run a def, open the REPL and be re-checked",
  commands({ inFelidaeFile: true, hasMain: false, errors: 0, warnings: 0 }).slice(0, 4),
  ["felidae.runCell", "felidae.runAllCells", "felidae.openRepl", "felidae.checkFile"]);
const problems = (errors, warnings) =>
  menuEntries({ inFelidaeFile: true, hasMain: false, errors, warnings }).find((entry) => entry.command === "workbench.actions.view.problems");
check("problem counts are in the menu", problems(2, 1), { label: "$(error) Problems", detail: "2 error(s), 1 warning(s) in this file", command: "workbench.actions.view.problems" });
check("warnings alone use the warning icon", problems(0, 3).label, "$(warning) Problems");
check("a clean file says so", [problems(0, 0).label, problems(0, 0).detail], ["$(pass) Problems", "None in this file"]);
check("every entry has a label, detail and command",
  menuEntries({ inFelidaeFile: true, hasMain: true, errors: 1, warnings: 1 }).every((entry) => entry.label && entry.detail && entry.command), true);

// Every command a menu entry runs must exist: ours are contributed in package.json,
// the Problems view is VS Code's.
const contributed = new Set(require(path.resolve(__dirname, "..", "package.json")).contributes.commands.map((command) => command.command));
const everyEntry = menuEntries({ inFelidaeFile: true, hasMain: true, errors: 1, warnings: 1 });
check("every menu command exists",
  everyEntry.filter((entry) => !contributed.has(entry.command) && entry.command !== "workbench.actions.view.problems").map((entry) => entry.command), []);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
