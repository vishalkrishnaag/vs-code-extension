# Felidae for VS Code

Language support for .fx files: highlighting, completion, snippets, folding,
formatting, symbol navigation, diagnostics, Run, Debug, and a REPL for the Felidae compiler (felidae runs a program
by compiling it to JVM classes).

## What's new in 0.5.0

- **The new syntax.** Imports as in Java (`import java.util.ArrayList`, `import java.util.*`, `import com.acme.Box`),
  `package com.acme`, calls without parentheses (`print "a", 1`), positional or named arguments for any function,
  conditionals that end with `end`, and statements that end at the line break (no closing `.`). Highlighting,
  snippets, folding and the formatter (conditional blocks) follow it.
- **Type errors in the editor.** `felidae --check-json` now type-checks the program (unknown classes, mismatched
  types, a package that does not match its folder), not only the syntax.
- **Debugging** finds the sources of classes in packages (`com.acme.app`).
- **Primitive types** `int`, `long`, `float`, `double`, `boolean`, `char`, `byte`, `short` are types (highlighting, snippets); the compiler
  warns where `Integer` could be `int`, and the warning shows as a squiggle.
- **Facts** need `@fact` on the class and `import org.felidae.db.tidesdb` (snippets `fact` and `importdb`); `init.fx` is gone.
- The quick fix for a missing `.` is replaced by one for a missing conditional `end`.
- **Debugger**, brought up to what the Java and Kotlin extensions offer: conditional and hit-count breakpoints, log
  points, function breakpoints, caught/uncaught exception breakpoints (with the Felidae `kind`/`message` a catch
  gets), data breakpoints on fields, restart frame, run without debugging, loaded sources (including the embedded
  `org.felidae.*` packages, read from the compiler's own jar), and Felidae-expression evaluation in watches, hovers
  and the debug console, with completions. Fixed: a watch or a rendered List/Map/object value could invalidate the
  JDWP frame handles of the stopped thread, later failing a step or a variables read with "INVALID_FRAMEID";
  stepping out of the compiler's own exact-arithmetic helpers (`Math.divideExact`, ...) could stop one line early.
- Hover now shows a signature and a **Parameters** list, the way the Java and Kotlin extensions lay theirs out,
  instead of folding everything into one block of text; the worked example is its own section.
- Highlighting and hover docs catch up with the language: `Graph.Link`/`Graph.Unlink` (`Link`/`Unlink` moved under
  `Graph` and are a compile error on their own now), `length`, `console.write`/`console.writeLine`, `Character`,
  `key`, and the `db` static class's other members (`config`, `stats`, `stop`) are documented; `?.`/`?:` and the
  keywords the parser still reserves but rejects with a migration error (`if`, `elif`, `return`, `where`, `extend`,
  `lambda`) are recognized tokens again.
- The felidae command is now `build/java/felidae.jar`, run with `java -jar`: the compiler's `cli` Gradle module was
  folded into its root project, which no longer has an `installDist` task or a launcher script. `felidae.interpreterPath`
  is renamed `felidae.compilerPath` to match.

## What's new in 0.4.0

The extension follows the Java compiler (`felidae` compiles a program to JVM class files and runs them).

- **Debugging on the JVM.** *Debug* runs `felidae --debug --port 0 program.fx`: the compiler writes the source
  file, a line for every statement and the Felidae names of parameters and bindings into the classes, and the
  extension's debug adapter (`src/debug`) debugs the program's JVM over JDWP. Breakpoints on `.fx` lines (also in
  classes that load later), step over/in/out, pause, the call stack with `Class.method` names, locals and
  object fields, hover and *Debug Console* evaluation of variable names. Values are shown the way `print` shows them
  (`Box(n: 5, tags: [])`, atoms without quotes, `nil`). Attach to a program started with `felidae --debug` with a
  `"request": "attach"` configuration. No other VS Code extension is needed.
- **Cells and Run Query** run from a generated program that imports your file (`cell_run.fx`, removed afterwards),
  because `--query` no longer exists.
- **REPL.** *Open REPL* starts `felidae-repl`: it asks whether to append (all code is kept in `repl.fx` and the whole
  file runs each time) or not (each input replaces the file).
- **Language.** PascalCase types and generics, `define` (Java-style functions), `private class`, `static class`, `new`, `@mixfix`, `@override`, `Link`,
  `Unlink`; new snippets; new completion docs for the builtins and class members; the Gradle layout
  (`build/java/cli/install/felidae/bin/felidae`) is found automatically.
- **Removed:** the ranking models (trained on the old language) and the generators for the old library list.

## What's new in 0.3.2

- **The Felidae menu.** Click **Felidae** in the status bar (or run *Felidae: Menu*) for everything in one
  list: Run and Debug (for a file with `main`), run the def under the cursor or all defs, open the REPL,
  check this file or every file, the Problems panel with this file's counts, select the interpreter, show the log.
- **Felidae: Check This File** asks the interpreter's parser again now (the automatic check skips a file
  whose text has not changed).

## What's new in 0.3.1

- **Check All Felidae Files** checks every `.fx` file in the workspace (not `build/`, `out/`, `node_modules/`),
  one interpreter process at a time, and lists the problems in the Problems panel. A file that fails is
  reported and the next is still checked. They stay listed after a file is closed; *Clear Problems* empties the list.
- **`felidae.check.run`** chooses when open files are checked: `onType` (default), `onSave` or `off`.
- **Getting Started walkthrough** (Welcome page, or *Help: Open Walkthrough*): interpreter, run and debug, REPL, problems.
- **Fenced `felidae` code blocks in Markdown** are highlighted.
- **Editor defaults for Felidae files:** 4-space indent, semantic highlighting on, word-based suggestions off,
  this extension as the formatter. Override them under `[felidae]` in your settings.
- Workspace search (symbols, references, go to definition of library names) skips `build/` like the checks do.
- Removed code that was never read: lexical diagnostics that the interpreter's check had replaced.

## What's new in 0.3.0

Editing an interpreted language, where the loop is edit, try, fix:

- **Interpreter picker and status.** *Felidae: Select Interpreter* lists the builds it finds
  (workspace folders, the file's folder and its parents, `build/debug/x64/Debug`, `build/release`,
  `dist/bin`, `PATH`), lets you browse, or clears the setting. A status bar item shows which
  felidae a file will use and its version, with a warning when none is found or when the build
  cannot run a program from stdin. Before this, a debug build was never found without a manual setting.
- **REPL.** *Felidae: Open REPL* starts the interpreter's own `felidae-repl` in a terminal, in the
  file's folder (it reads `./init.fx`). *Felidae: Send to REPL* (also in the editor's right-click
  menu) sends the selection, else the `def` block under the cursor, else the current line. The REPL
  is the interpreter's normal interactive mode in a terminal you own: no session is kept, and while it
  is open it holds the project's database, so a cell run on the same project reports the lock error.
- **Quick fix: add the missing `end`** to a conditional, the commonest syntax error now that a line break ends a
  statement. The parser names the exact place, and the fix inserts the `end` there.
- **Unused locals and parameters** are shown faded (an editor hint, not counted as a problem), with a
  quick fix to remove an unused one-line binding. A name starting with `_` is taken as deliberate, and
  any other mention of a name counts as a use, so it errs on the side of staying quiet.
- **Hover shows the `#` comment lines directly above a function** as its documentation.
- **Fewer checks:** a check already done for the same text and interpreter is not repeated (switching
  tabs used to start one every time). The interpreter's check itself takes about 6 ms; almost all of the
  ~60 ms is Windows starting a process.
- `lambda` is no longer suggested: not in completions, quick fixes or error advice.

## What's new in 0.2.0

- **Run and Debug on every def, notebook style.** Each top-level `def` and
  `class` has `Run` (and `Debug` for functions and bindings) above it. A result
  appears after the def line (`→ 42 · 3 ms`, or `✗ error`; the first line, with a
  count if there are more), hover shows everything the process printed and any
  error, and each run is logged in the *Felidae Cells* output channel. Shift+Enter runs the cell and moves to the next;
  Ctrl+Alt+Enter runs without moving; *Run All Cells* and *Run Cell and Cells
  Below* run in order and stop at the first failure.
  - A function with parameters asks for its arguments (remembering the last ones).
  - A binding shows its value (read through a generated function run with `--stdin`, because a
    bare `--query "name."` prints the atom `name`; this needs a felidae build with `--stdin`
    runs); a fact or class shows its rows (`Name.all()`).
    Facts are persistent, so running one only reads them.
  - Each cell is its own ordinary process, `felidae file.fx --query "f(a: 1)."`,
    and ends when that process ends. Nothing stays running between cells and nothing
    is retried: if a cell fails, you see the interpreter's own error. Cells run one
    at a time, because RocksDB admits one process per database directory. A cell
    started while you are running or debugging the same project yourself will
    report the database lock error. *Stop Running Cell* (or the status bar item)
    kills the current one.
  - **Debug** on a function debugs just that call (`--debug` with `--query`).
- **Corrections and speed-ups.** Top-level `def name := v.` bindings are now
  recognised as top-level symbols (find-references and rename from inside a
  function were scoped too narrowly). Declarations are scanned once per edit
  instead of once per call, which makes inlay hints about 9x faster on a large
  file, block highlighting skips redundant redraws, and the extension no longer
  activates at every VS Code start, only for `.fx` files or workspaces containing
  them.
- **Rainbow block highlighting.** Click inside nested blocks and every enclosing
  block's opener and `end` are marked, in one colour per nesting level: the
  innermost strongly (with a `← def main` label), the outer ones quietly. Colours:
  `felidae.blockLevel0`–`3`, `felidae.blockHighlightBackground`.
- **Theme-independent `def` colours.** `def` for a function, a fact and a binding
  use three colours in every theme: `felidae.defFunction`, `felidae.defFact`,
  `felidae.defBinding`. Override any of them in `workbench.colorCustomizations`.
- The stdlib's native declarations (`def f(...) => ()` … `end`) now pair correctly.

### Also in 0.1.0

- **Block highlighting that stays quiet.** Only the block under the cursor is
  emphasised: its opener (`def`, `class`, `for`, `while`, `switch`, `try`) and
  its matching `end`, with a `← def main` label. Every other `end` stays plain,
  so a long function no longer ends in a wall of colour. Turn the label off with
  `felidae.endLabels`.
- **Three kinds of `def`, three colours.** A function (`def f(...) =>`), a
  persistent fact (`def Name(...).`) and a binding or field (`def x := 1.`,
  `def id: string.`) are coloured differently, in any theme, before semantic
  tokens arrive.
- **Folding for every `end` block**, nested blocks folding independently.
- **Current syntax throughout.** Snippets, formatter and indentation follow
  `def` / `:=` / `end`; `throw(kind:, message:)`; quoted atoms; `catch`,
  `case` and `default` branches. Hover and completion examples use `def`.
- **Inlay hints.** Positional call arguments show their parameter name
  (`Person("Ada", 3)` reads as `name: "Ada", age: 3`). Setting:
  `felidae.inlayHints.parameterNames`.
- **Smart Expand Selection** (Shift+Alt+Right): word, line, then each
  enclosing `def … end` block body and block, innermost first.
- **Auto-insert `end`.** Pressing Enter after a block opener (`def … =>`,
  `class`, `for`/`while … then`, `switch`, `try`) that has no `end` at its own
  indentation adds one below and leaves the cursor in the body. Setting:
  `felidae.autoInsertEnd`.
- **Call hierarchy** for methods: incoming callers and outgoing callees across
  the workspace.
- **Type hierarchy** for `class Name extends A, B`: show supertypes and subtypes.
- **Tasks and problem matcher.** *Terminal > Run Task > felidae* runs or checks
  the active file; the `$felidae` matcher turns interpreter errors into entries
  in the Problems panel.
- **Status bar** shows the active file's error and warning count and opens the
  Problems panel on click.
- **Bracket pair colourisation** and number-aware word selection.
- **Output channel.** *Felidae: Show Output* opens a log of interpreter
  discovery, every diagnostics check (duration, exit code, stderr, error and
  warning counts), run and debug launches, and the debug adapter. Use
  *Developer: Set Log Level* on the channel for `trace` (raw debug protocol).
- **Problems panel matches the code.** Only the newest check for a file may
  publish, previous results stay until replaced (no flicker to zero), duplicate
  reports collapse, every entry is tagged `felidae`, and an error that belongs
  to an imported file is not pinned to a line of the wrong file.
- **Faster find-references and rename.** Documents are tokenized once per edit,
  the workspace scan reads only files that contain the name, and a local
  variable or parameter is confined to its own `def … end` block.
- **Clearer diagnostics.** Parse errors always report `line N, column M`, and
  errors from imported files name the file.

## The felidae command

`felidae` compiles a program to JVM class files beside the source and runs them; the same command provides
`--check-json` (parse diagnostics and symbols), `--debug` (a suspended JVM for a debugger) and `--compile`.
Build it with `./gradlew felidaeJar` in the Felidae repository (JDK 25); that writes `build/java/felidae.jar`, which
the extension finds and runs with `java -jar` by itself. To use another one (a native wrapper, or a jar elsewhere):

```json
{
  "felidae.compilerPath": "/opt/felidae/bin/felidae"
}
```

Use an absolute path or a path relative to the workspace folder. `FELIDAE_PATH` is used when the setting is empty.
An optional `.vscode/felidae.json` overrides the setting for that workspace (`{"compilerPath": "..."}`).
In WSL, install the extension in the WSL window and configure the Linux command. Reload the window after changing it.

## Run and Debug

Use the Run/Debug buttons above `main()` or the Felidae commands. Run opens a terminal (Command Prompt on Windows,
/bin/sh elsewhere). Debug starts the program under the debugger described above:

```json
{
  "type": "felidae",
  "request": "launch",
  "name": "Debug Felidae",
  "program": "${file}",
  "stopOnEntry": false
}
```

Launch options: `program`, `compilerPath`, `args` (for `main`), `classpath` (Java libraries, `--classpath`),
`sourceDirs` (extra folders for imported sources) and `stopOnEntry`. A program that keeps facts opens its
database at the first fact written (`db.location(...)` in a `static init` block names the directory; the
default is `felidae-data` in the project folder), as for any run. The methods of a class `Box` appear as
`Box.twice` in the stack; the embedded fact store and list helpers have no lines, so stepping never enters them.

Diagnostics and document symbols use `felidae --check-json --stdin file.fx`. There is no extension-owned
language server or parallel semantic parser.

## Development

Type-check without generating resources:

```sh
npx tsc -p . --noEmit
```

VS Code loads the bundled JavaScript from `dist/extension.js`. Refresh that bundle before packaging;
it is extension code, not compiled Felidae source. Run packaging manually after
verification, then install the resulting VSIX and reload the window.

Packaging invokes vscode:prepublish to refresh JavaScript automatically without
regenerating language resources or ranking models. From the repository root:

```sh
mkdir -p build/extensions
cd vs-code-extension
npx vsce package --out ../build/extensions/felidae-vscode.vsix
```

Tests: `npm test` (the debug session test needs `./install.sh` in the Felidae repository, which builds
`build/java/felidae.jar`; it is skipped without it). Focused launch checks: `npm run test:runtime`. Windows/macOS shell selection is
tested with mocks; native installation and shell execution need verification
on those platforms.
