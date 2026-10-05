# Felidae for VS Code

Language support for .fx files: highlighting, completion, snippets, folding,
formatting, symbol navigation, diagnostics, Run, and Debug.

## What's new in 0.2.0

- **Run and Debug on every def, notebook style.** Each top-level `def` and
  `class` has `Run` (and `Debug` for functions and bindings) above it. A result
  appears after the def line (`→ 42 · 3 ms`, or `✗ error`; the first line, with a
  count if there are more), hover shows everything the process printed and any
  error, and each run is logged in the *Felidae Cells* output channel. Shift+Enter runs the cell and moves to the next;
  Ctrl+Alt+Enter runs without moving; *Run All Cells* and *Run Cell and Cells
  Below* run in order and stop at the first failure.
  - A function with parameters asks for its arguments (remembering the last ones).
  - A binding shows its value; a fact or class shows its rows (`Name.all()`).
    Facts are persistent, so running one only reads them.
  - Each cell is its own ordinary process, `felidae file.fx --query "f(a: 1)."`,
    and ends when that process ends. Nothing stays running between cells and nothing
    is retried: if a cell fails, you see the interpreter's own error. Cells run one
    at a time, because RocksDB admits one process per database directory. A cell
    started while you are running or debugging the same project yourself will
    report the database lock error. *Stop Running Cell* (or the status bar item)
    kills the current one.
  - **Debug** on a function debugs just that call (`--debug` with `--query`).
- **Interpreter metrics on every cell.** Cells run with `--metrics-json`, and
  the extension shows what the interpreter reports: the cell's own run time next
  to its result (separate from the time to load the file), and in the hover and
  *Felidae Cells* channel the work it did (clause attempts, unifications, fact
  candidates), dispatch cache hit rate, RocksDB reads and scans, rows scanned and
  writes. It says so plainly when a cell scanned the whole fact store (an index
  would avoid that) or wrote to the database.
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

## Interpreter configuration

One executable, `felidae` (`felidae.exe` on Windows), provides execution,
debugging, parse diagnostics, and AST-derived symbol metadata. Configure it in Settings:

```json
{
  "felidae.interpreterPath": "dist/bin/felidae"
}
```

Use an absolute path or a path relative to the workspace folder. On Windows,
use `dist/bin/felidae.exe`. In WSL, install the extension in the WSL window
and configure the Linux executable. `FELIDAE_PATH` is used when the setting
is empty; otherwise staged release locations are searched.

An optional `.vscode/felidae.json` overrides the setting for that workspace:

```json
{
  "interpreterPath": "dist/bin/felidae"
}
```

Reload the window after changing the executable so extension commands use the new path.

## Run and Debug

Use the Run/Debug buttons above main(...) or the corresponding Felidae commands.
Run opens Command Prompt on Windows and /bin/sh on Linux/macOS. Debug launches
the interpreter directly over its stdin/stdout protocol. Source files execute
directly; no program binary is generated.

```json
{
  "type": "felidae",
  "request": "launch",
  "name": "Debug Felidae",
  "program": "${file}",
  "stopOnEntry": true
}
```

The debugger supports stepping, breakpoints, and live locals. Set stopOnEntry
to false to continue after initialization. The current native protocol reports
a line and one frame; imported source locations and full stacks remain limited.
Debug Console accepts variable names; use **Felidae: Run Query** for
period-terminated bucket expressions.

Diagnostics and document symbols use `felidae --check-json --stdin file.fx`.
There is no extension-owned language server or parallel semantic parser. Run and
Debug execute without an additional validation confirmation dialog.

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

Focused launch checks: `npm run test:runtime`. Windows/macOS shell selection is
tested with mocks; native installation and shell execution need verification
on those platforms.
