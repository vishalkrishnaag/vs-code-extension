## Pick the felidae compiler

The extension runs your code with the felidae compiler, which compiles a `.fx` file to JVM bytecode and runs it. The
real build produces one jar, `build/java/felidae.jar` (`./gradlew felidaeJar`), launched with `java -jar`. The
extension looks in the workspace, beside your file and in its parent folders, then on `PATH` for a native wrapper.

The **Felidae** item in the status bar shows which one a file will use, with its version.
Click it, or use the button below, to choose another or browse for one.
