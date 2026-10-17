const path = require("path");
const {
  executableName, replExecutable, relativeCandidates, searchBases, discoverInterpreters, resolveInterpreter, parseVersion, searchedLocations
} = require(path.resolve(__dirname, "..", "out", "interpreter.js"));

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  ok  ", name); } else { fail++; console.log("  FAIL", name, "\n     exp", e, "\n     act", a); }
};

// A fake file system: only these files exist.
const world = (...files) => {
  const set = new Set(files.map((file) => path.resolve(file).toLowerCase()));
  return (candidate) => set.has(path.resolve(candidate).toLowerCase());
};
const repo = path.resolve("fake-repo");
const exeDebug = path.join(repo, "build", "java", "cli", "install", "felidae", "bin", "felidae.bat");
const exeRelease = path.join(repo, "dist", "bin", "felidae.bat");
const base = { platform: "win32", arch: "x64", workspaceFolders: [], pathDirectories: [] };

check("the executable name follows the platform", [executableName("win32"), executableName("linux")], ["felidae.bat", "felidae"]);
const winCandidates = relativeCandidates("win32", "x64");
check("the Gradle distribution is preferred over a packaged one", winCandidates.indexOf("build/java/cli/install/felidae/bin/felidae.bat") < winCandidates.indexOf("dist/bin/felidae.bat"), true);
check("the Gradle distribution is a known location", winCandidates.includes("build/java/cli/install/felidae/bin/felidae.bat"), true);
check("non-Windows locations have no .bat", relativeCandidates("linux", "x64").every((candidate) => !candidate.endsWith(".bat")), true);
check("the first location is the Gradle distribution on every platform", relativeCandidates("darwin", "arm64")[0], "build/java/cli/install/felidae/bin/felidae");

// ---- where it looks
check("workspace folders come first, then the notebook folder and its parents",
  searchBases([path.resolve("ws")], path.join(repo, "tests", "notebooks")).slice(0, 4),
  [path.resolve("ws"), path.join(repo, "tests", "notebooks"), path.join(repo, "tests"), repo]);
check("the walk up stops at the root and never repeats a folder",
  new Set(searchBases([], path.join(repo, "a"))).size, searchBases([], path.join(repo, "a")).length);

// ---- your case: a notebook outside any workspace, interpreter only in the debug build folder
const notebookFolder = path.join(repo, "v2_examples");
const found = resolveInterpreter({ ...base, notebookFolder, isFile: world(exeDebug) });
check("a notebook inside the repository finds the repository's build with no workspace open", [found.path, found.source], [exeDebug, "search"]);
const both = resolveInterpreter({ ...base, notebookFolder, isFile: world(exeDebug, exeRelease) });
check("with both builds present the Gradle distribution wins", both.path, exeDebug);
const lost = resolveInterpreter({ ...base, notebookFolder: path.resolve("elsewhere", "Downloads"), isFile: world(exeDebug) });
check("a notebook elsewhere, with nothing configured, finds nothing", [lost.path, lost.source], ["", "none"]);

// ---- the setting and the environment
const configuredAbsolute = path.resolve("tools", "felidae.bat");
const viaSetting = resolveInterpreter({ ...base, notebookFolder: path.resolve("elsewhere"), configured: configuredAbsolute, isFile: world() });
check("a configured path is used even if it does not exist (a wrong setting must fail loudly)", [viaSetting.path, viaSetting.source], [configuredAbsolute, "setting"]);
check("a configured path wins over a build folder", resolveInterpreter({ ...base, notebookFolder, configured: configuredAbsolute, isFile: world(exeDebug) }).path, configuredAbsolute);
check("a relative setting is resolved against the notebook's folders",
  resolveInterpreter({ ...base, notebookFolder: path.join(repo, "v2_examples"), configured: "build/java/cli/install/felidae/bin/felidae.bat", isFile: world(exeDebug) }).path, exeDebug);
const onPath = path.resolve("bin");
check("a bare command in the setting is found on PATH",
  resolveInterpreter({ ...base, configured: "felidae", pathDirectories: [onPath], isFile: world(path.join(onPath, "felidae.bat")) }).path, path.join(onPath, "felidae.bat"));
const viaEnvironment = resolveInterpreter({ ...base, environment: configuredAbsolute, isFile: world() });
check("FELIDAE_PATH is used when nothing is configured", [viaEnvironment.path, viaEnvironment.source], [configuredAbsolute, "environment"]);
check("the setting wins over FELIDAE_PATH", resolveInterpreter({ ...base, configured: "a.exe", environment: "b.exe", isFile: world() }).source, "setting");
check("PATH is the last resort",
  resolveInterpreter({ ...base, pathDirectories: [onPath], isFile: world(path.join(onPath, "felidae.bat")) }).source, "path");

// ---- the picker's list
const listed = discoverInterpreters({ ...base, notebookFolder, pathDirectories: [onPath], isFile: world(exeDebug, exeRelease, path.join(onPath, "felidae.bat")) });
check("it lists three distinct interpreters", listed.length, 3);
check("build folders are listed before PATH", listed.map((choice) => choice.source), ["search", "search", "path"]);
check("a missing interpreter's message can say where it looked", searchedLocations({ ...base, notebookFolder, isFile: world() }).slice(-1)[0], "felidae on PATH");

// ---- what a build reports
check("the version is read from --version output", parseVersion("Felidae Logic Programming Language v0.2.3-beta.1\n"), "0.2.3-beta.1");
check("no version in the output gives undefined", parseVersion("something else"), undefined);
// ---- the REPL command that goes with a felidae command
check("the Gradle distributions sit side by side",
  replExecutable("/r/build/java/cli/install/felidae/bin/felidae", "linux"), "/r/build/java/repl/install/felidae-repl/bin/felidae-repl");
check("a packaged felidae has its REPL beside it", replExecutable("/opt/felidae/bin/felidae", "linux"), "/opt/felidae/bin/felidae-repl");
check("a bare command is looked for on PATH", replExecutable("felidae", "win32"), "felidae-repl.bat");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

