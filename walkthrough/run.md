## Run and debug

A file with a `main(...)` method shows **Run | Debug** above it. Every `def` can also be run as a cell:

- **Shift+Enter** runs the `def` under the cursor and moves to the next one.
- **Ctrl+Alt+Enter** runs it and stays.
- The result appears beside the code, with timing from the interpreter's own metrics.

Each run is one plain interpreter process: nothing is kept between runs except the facts in the database.
