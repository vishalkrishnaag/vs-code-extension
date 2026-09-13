# Felidae for VS Code

Language support for .fx files: highlighting, completion, snippets, folding,
formatting, symbol navigation, diagnostics, Run, and Debug.

## Interpreter configuration

One executable, `felidae` (`felidae.exe` on Windows), provides execution,
debugging, diagnostics, symbol metadata, and LSP. Configure it in Settings:

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

Reload the window after changing the executable to restart its language server.

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
Debug Console accepts variable names; use **Felidae: Run Query** for fact queries.
Queries may include or omit the leading question mark.

Diagnostics use felidae --lsp, with --check-json as the fallback. Run and Debug
execute without an additional validation confirmation dialog.

## Development

Type-check without generating resources:

```sh
npx tsc -p . --noEmit
```

VS Code loads JavaScript from out/. Refresh that bundle before packaging;
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
