// Copied from felidae_jupyter_notebook/src/compiler.ts (the same compiler lookup the
// notebook extension uses, so both find the same felidae).

// Finding the felidae compiler, and listing the ones there are to choose from.
//
// felidae compiles a .fx source file to JVM bytecode and runs it; it is not an
// interpreter. The real build produces one fat jar, build/java/felidae.jar (the
// merged root `compiler` Gradle module's `felidaeJar` task - there is no more
// separate `cli` module and no installDist launcher script), run via `java -jar`.
//
// Resolution order, first match wins:
//   1. the felidae.compilerPath setting (also read from .vscode/felidae.json)
//   2. the FELIDAE_PATH environment variable
//   3. the first compiler found at a known build location, looked for under
//      every workspace folder and under the notebook's own folder and its
//      parents (so a notebook inside the repository finds the repository's
//      build, with or without an open workspace)
//   4. felidae on PATH
//
// A configured path is used as it is, even when it does not exist: a wrong
// setting should fail loudly rather than be silently replaced by a search.
// No vscode import, so it is unit-testable.

import * as fs from "fs";
import * as path from "path";

export type CompilerSource = "setting" | "environment" | "search" | "path" | "none";

export interface CompilerChoice {
  path: string;
  source: CompilerSource;
}

export interface CompilerSearch {
  platform: NodeJS.Platform;
  arch: string;
  // felidae.compilerPath (or the workspace's felidae.json), if set.
  configured?: string;
  // FELIDAE_PATH, if set.
  environment?: string;
  workspaceFolders: string[];
  // The folder holding the notebook file, if it has one.
  notebookFolder?: string;
  pathDirectories: string[];
  isFile?: (candidate: string) => boolean;
}

const defaultIsFile = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

// On PATH (or as a hand-placed override), felidae may be a native wrapper of this name;
// the normal case is a jar launched with `java -jar`, which relativeCandidates finds instead.
export function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "felidae.bat" : "felidae";
}

// Where the build puts the felidae compiler, relative to a repository root: `./gradlew
// felidaeJar` (also run by install.sh) writes build/java/felidae.jar. There is no launcher
// script; the jar is run with `java -jar`.
export function relativeCandidates(_platform: NodeJS.Platform, _arch: string): string[] {
  return ["build/java/felidae.jar"];
}

/**
 * The REPL command that goes with a felidae compiler path: `./gradlew :repl:replJar` writes
 * build/java/felidae-repl.jar beside build/java/felidae.jar, so a resolved compilerPath ending
 * in felidae.jar under a build/java folder has its REPL jar as a sibling. Otherwise
 * `felidae-repl` is looked for next to the compiler executable, then on PATH.
 */
export function replExecutable(compilerPath: string, platform: NodeJS.Platform): string {
  const name = platform === "win32" ? "felidae-repl.bat" : "felidae-repl";
  const jarName = "felidae-repl.jar";
  const normalized = compilerPath.replace(/\\/g, "/");
  if (/\/build\/java\/felidae\.jar$/i.test(normalized)) {
    return path.normalize(normalized.replace(/felidae\.jar$/i, jarName));
  }
  if (path.isAbsolute(compilerPath)) return path.join(path.dirname(compilerPath), name);
  return name;
}

// The workspace folders, then the notebook's folder and its parents, nearest first.
export function searchBases(workspaceFolders: string[], notebookFolder?: string): string[] {
  const bases: string[] = [...workspaceFolders];
  if (notebookFolder) {
    let folder = path.resolve(notebookFolder);
    for (let depth = 0; depth < 8; depth++) {
      bases.push(folder);
      const parent = path.dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
  }
  return [...new Set(bases)];
}

// Every felidae compiler that exists at a known location or on PATH, in the order
// resolution would prefer them. Used by the picker.
export function discoverCompilers(search: CompilerSearch): CompilerChoice[] {
  const isFile = search.isFile ?? defaultIsFile;
  const found: CompilerChoice[] = [];
  const seen = new Set<string>();
  const add = (candidate: string, source: CompilerSource) => {
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key) || !isFile(candidate)) return;
    seen.add(key);
    found.push({ path: path.resolve(candidate), source });
  };
  for (const base of searchBases(search.workspaceFolders, search.notebookFolder)) {
    for (const relative of relativeCandidates(search.platform, search.arch)) add(path.join(base, relative), "search");
  }
  for (const directory of search.pathDirectories) add(path.join(directory, executableName(search.platform)), "path");
  return found;
}

// A configured value may be absolute, relative to a workspace or notebook
// folder, or a bare command found on PATH. Anything else is used as written.
function resolveConfigured(value: string, search: CompilerSearch): string {
  const isFile = search.isFile ?? defaultIsFile;
  const withSuffix = (candidate: string) =>
    search.platform === "win32" && !path.extname(candidate) && !isFile(candidate) ? candidate + ".bat" : candidate;
  const trimmed = value.trim();
  if (path.isAbsolute(trimmed)) return withSuffix(trimmed);
  for (const base of searchBases(search.workspaceFolders, search.notebookFolder)) {
    const local = withSuffix(path.join(base, trimmed));
    if (isFile(local)) return local;
  }
  if (!/[/\\]/.test(trimmed)) {
    for (const directory of search.pathDirectories) {
      const onPath = withSuffix(path.join(directory, trimmed));
      if (isFile(onPath)) return onPath;
    }
  }
  return withSuffix(path.resolve(search.workspaceFolders[0] ?? search.notebookFolder ?? ".", trimmed));
}

export function resolveCompiler(search: CompilerSearch): CompilerChoice {
  if (search.configured?.trim()) return { path: resolveConfigured(search.configured, search), source: "setting" };
  if (search.environment?.trim()) return { path: resolveConfigured(search.environment, search), source: "environment" };
  const found = discoverCompilers(search)[0];
  return found ?? { path: "", source: "none" };
}

// Where a missing compiler was looked for, to tell the user.
export function searchedLocations(search: CompilerSearch): string[] {
  const relative = relativeCandidates(search.platform, search.arch);
  const bases = searchBases(search.workspaceFolders, search.notebookFolder);
  return [
    ...bases.slice(0, 3).map((base) => path.join(base, relative[0]) + "  (and the other known build folders)"),
    "felidae on PATH"
  ];
}

// `felidae --version` prints e.g. "Felidae Logic Programming Language v0.2.3-beta.1".
export function parseVersion(output: string): string | undefined {
  return /\bv(\d[^\s]*)/.exec(output)?.[1];
}

// felidae.jar (and felidae-repl.jar) are plain jars with no launcher script: running them
// needs `java -jar <path>`. A hand-placed native wrapper (on PATH, or a configured override)
// is still run directly. Every Run/Debug/REPL code path launches through this helper so the
// jar-vs-wrapper distinction is handled in exactly one place.
export function compilerCommandLine(
  compilerPath: string,
  args: string[],
  javaPath = "java"
): { command: string; args: string[] } {
  return compilerPath.toLowerCase().endsWith(".jar")
    ? { command: javaPath, args: ["-jar", compilerPath, ...args] }
    : { command: compilerPath, args };
}
