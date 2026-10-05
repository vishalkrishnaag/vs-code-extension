## Try things in the REPL

**Open REPL** starts `felidae --repl` in a terminal, in your file's folder (it reads `./init.fx`).
**Send to REPL** sends the selection, else the `def` block under the cursor, else the current line.

While the REPL is open it holds the project's database, so a run on the same project reports RocksDB's lock error. Close the REPL first.
