const path = require("path");
const {
  executableName, replExecutable, relativeCandidates, searchBases, discoverCompilers, resolveCompiler, parseVersion, searchedLocations,
  compilerCommandLine
} = require(path.resolve(__dirname, "..", "out", "compiler.js"));

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
const jar = path.join(repo, "build", "java", "felidae.jar");
const onPathExe = path.join(repo, "bin-elsewhere", "felidae.bat");
const base = { platform: "win32", arch: "x64", workspaceFolders: [], pathDirectories: [] };

check("the executable name follows the platform", [executableName("win32"), executableName("linux")], ["felidae.bat", "felidae"]);
check("the real build's jar is the only search candidate", relativeCandidates("win32", "x64"), ["build/java/felidae.jar"]);
check("the candidate is the same jar on every platform", relativeCandidates("darwin", "arm64")[0], "build/java/felidae.jar");

// ---- where it looks
check("workspace folders come first, then the notebook folder and its parents",
  searchBases([path.resolve("ws")], path.join(repo, "tests", "notebooks")).slice(0, 4),
  [path.resolve("ws"), path.join(repo, "tests", "notebooks"), path.join(repo, "tests"), repo]);
check("the walk up stops at the root and never repeats a folder",
  new Set(searchBases([], path.join(repo, "a"))).size, searchBases([], path.join(repo, "a")).length);

// ---- a notebook outside any workspace, the compiler only in the Gradle build folder
const notebookFolder = path.join(repo, "v2_examples");
const found = resolveCompiler({ ...base, notebookFolder, isFile: world(jar) });
check("a notebook inside the repository finds the repository's build with no workspace open", [found.path, found.source], [jar, "search"]);
const lost = resolveCompiler({ ...base, notebookFolder: path.resolve("elsewhere", "Downloads"), isFile: world(jar) });
check("a notebook elsewhere, with nothing configured, finds nothing", [lost.path, lost.source], ["", "none"]);

// ---- the setting and the environment
const configuredAbsolute = path.resolve("tools", "felidae.bat");
const viaSetting = resolveCompiler({ ...base, notebookFolder: path.resolve("elsewhere"), configured: configuredAbsolute, isFile: world() });
check("a configured path is used even if it does not exist (a wrong setting must fail loudly)", [viaSetting.path, viaSetting.source], [configuredAbsolute, "setting"]);
check("a configured path wins over a build folder", resolveCompiler({ ...base, notebookFolder, configured: configuredAbsolute, isFile: world(jar) }).path, configuredAbsolute);
check("a relative setting is resolved against the notebook's folders",
  resolveCompiler({ ...base, notebookFolder: path.join(repo, "v2_examples"), configured: "build/java/felidae.jar", isFile: world(jar) }).path, jar);
const onPath = path.resolve("bin");
check("a bare command in the setting is found on PATH",
  resolveCompiler({ ...base, configured: "felidae", pathDirectories: [onPath], isFile: world(path.join(onPath, "felidae.bat")) }).path, path.join(onPath, "felidae.bat"));
const viaEnvironment = resolveCompiler({ ...base, environment: configuredAbsolute, isFile: world() });
check("FELIDAE_PATH is used when nothing is configured", [viaEnvironment.path, viaEnvironment.source], [configuredAbsolute, "environment"]);
check("the setting wins over FELIDAE_PATH", resolveCompiler({ ...base, configured: "a.exe", environment: "b.exe", isFile: world() }).source, "setting");
check("PATH is the last resort",
  resolveCompiler({ ...base, pathDirectories: [onPath], isFile: world(path.join(onPath, "felidae.bat")) }).source, "path");

// ---- the picker's list
const listed = discoverCompilers({ ...base, notebookFolder, pathDirectories: [onPath], isFile: world(jar, path.join(onPath, "felidae.bat")) });
check("it lists two distinct compilers", listed.length, 2);
check("build folders are listed before PATH", listed.map((choice) => choice.source), ["search", "path"]);
check("a missing compiler's message can say where it looked", searchedLocations({ ...base, notebookFolder, isFile: world() }).slice(-1)[0], "felidae on PATH");

// ---- what a build reports
check("the version is read from --version output", parseVersion("Felidae Logic Programming Language v0.2.3-beta.1\n"), "0.2.3-beta.1");
check("no version in the output gives undefined", parseVersion("something else"), undefined);

// ---- the REPL command that goes with a felidae compiler path
check("the Gradle jars sit side by side",
  replExecutable("/r/build/java/felidae.jar", "linux"), "/r/build/java/felidae-repl.jar");
check("a packaged felidae has its REPL beside it", replExecutable("/opt/felidae/bin/felidae", "linux"), "/opt/felidae/bin/felidae-repl");
check("a bare command is looked for on PATH", replExecutable("felidae", "win32"), "felidae-repl.bat");

// ---- launching: a jar needs `java -jar`, a native wrapper is run directly
check("a jar path is launched with java -jar", compilerCommandLine("/r/build/java/felidae.jar", ["program.fx"]),
  { command: "java", args: ["-jar", "/r/build/java/felidae.jar", "program.fx"] });
check("a non-jar path is run directly", compilerCommandLine("/opt/felidae/bin/felidae", ["program.fx"]),
  { command: "/opt/felidae/bin/felidae", args: ["program.fx"] });
check("the java binary can be overridden", compilerCommandLine("felidae.jar", [], "/jdk/bin/java"),
  { command: "/jdk/bin/java", args: ["-jar", "felidae.jar"] });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
