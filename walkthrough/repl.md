## Try things in the REPL

**Open REPL** starts `felidae-repl` in a terminal, in your file's folder. It asks whether to run in append mode: in append
mode every declaration you type is kept in `repl.fx` and the whole file runs after each input; otherwise each input
replaces the file. A `def`, `class` or `import` is a declaration; anything else is run and its result printed.
**Send to REPL** sends the selection, else the `def` block under the cursor, else the current line.

Build it with `./gradlew :repl:replJar`, which writes `build/java/felidae-repl.jar` beside `felidae.jar`. A program
that keeps facts opens its database at the first fact written (`db.location(...)` in a `static init` block names
the directory; the default is `felidae-data` in the project folder).
