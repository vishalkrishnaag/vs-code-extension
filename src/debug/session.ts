// The Felidae debug adapter: Debug Adapter Protocol on one side, the JVM's JDWP on the other.
//
// `felidae --debug --port N program.fx` compiles the program and starts its JVM suspended with a JDWP agent; the
// generated classes carry SourceFile, LineNumberTable and LocalVariableTable attributes (written by the compiler), so
// breakpoints on `.fx` lines, the stack, and the locals under their Felidae names all come from the VM. Values are
// rendered by the program's own `$show` (the text `print` would give), called in the stopped VM.
//
// What it offers is what the Java and Kotlin debuggers offer, where Felidae has the concept:
//   line breakpoints with conditions, hit counts and log messages; function breakpoints (`Box.twice`, `main`);
//   caught/uncaught exception breakpoints with the Felidae kind and message; data breakpoints on fields;
//   step over/into/out (the embedded packages and the JDK are stepped over); restart frame; pause;
//   Locals and Statics scopes; objects, lists, maps and arrays expanded; watch, hover and debug-console evaluation of
//   Felidae expressions (see evaluate.ts); completions in the debug console; loaded sources; run without debugging;
//   the program in the debug console or in the integrated terminal (so it can read its input).
// Values never change in Felidae, so there is no "set value".
//
// No vscode import: the session takes and emits plain DAP messages, so it can be tested without VS Code.

import * as childProcess from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import {
  EventKind,
  FieldInfo,
  Frame,
  JdwpConnection,
  JdwpEvent,
  JdwpValue,
  LineEntry,
  Location,
  MethodInfo,
  STEP_INTO,
  STEP_LINE,
  STEP_OUT,
  STEP_OVER,
  SuspendPolicy,
  VariableEntry
} from "./jdwp";
import { Atom, EvalHost, Evaluator, Local, Remote, Value, formatLocal, hitConditionMet, interpolate, isRemote } from "./evaluate";
import { ZipArchive } from "../zip";

export interface DapMessage {
  seq: number;
  type: string;
  [key: string]: any;
}

interface MethodData {
  info: MethodInfo;
  lines: LineEntry[]; // by increasing code index
}

interface ClassData {
  typeId: bigint;
  signature: string;
  // The class's JVM package as a folder (`com/acme`), empty for the default package.
  packagePath: string;
  sourceFile: string;
  methods: Map<bigint, MethodData>;
}

interface Breakpoint {
  id: number;
  // Line breakpoints: the source; function breakpoints: the name.
  source?: { path: string };
  functionName?: string;
  requestedLine: number;
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  hits: number;
  // The JDWP requests that implement it: one per class that has code at (or around) the line.
  requestIds: number[];
  classes: Set<bigint>;
}

type Handle =
  | { kind: "locals"; thread: bigint; frame: Frame }
  | { kind: "statics"; thread: bigint; classId: bigint }
  | { kind: "object"; thread: bigint; context: bigint; objectId: bigint; classId: bigint; view: "fields" | "list" | "map" | "array" }
  | { kind: "entry"; thread: bigint; context: bigint; key: JdwpValue; value: JdwpValue };

interface StoppedException {
  thread: bigint;
  exception: bigint;
  context: bigint;
  uncaught: boolean;
}

// Classes the debugger never steps into: the embedded Felidae packages (the fact store, graphs, lists) and the JDK
// and its drivers. A step that would enter one steps over it instead.
const STEP_EXCLUDES = ["org.felidae.*", "java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "com.tidesdb.*", "com.fasterxml.*"];
// Classes that are never Felidae classes, so attaching does not ask each of them for its source file.
const SYSTEM_CLASS_PREFIXES = ["Ljava/", "Ljavax/", "Ljdk/", "Lsun/", "Lcom/sun/", "Lcom/tidesdb/", "Lcom/fasterxml/", "Lpicocli/", "["];

const LISTENING = /Listening for transport dt_socket at address:\s*(\d+)/;
const CAUGHT_FILTER = "caught";
const UNCAUGHT_FILTER = "uncaught";

/** `twice$k` and `add$1` (older compiler outputs) are shown as `twice` and `add`. */
export function displayName(jvmName: string): string {
  const dollar = jvmName.indexOf("$", 1);
  return jvmName.startsWith("$") || dollar < 0 ? jvmName : jvmName.slice(0, dollar);
}

/** `Ljava/lang/Integer;` -> `Integer`, `Ljava/util/Optional;` -> `Atom`, `[I` -> `int[]`. */
export function typeDisplayName(signature: string): string {
  if (signature.startsWith("[")) return typeDisplayName(signature.slice(1)) + "[]";
  const names: Record<string, string> = { B: "byte", C: "char", D: "double", F: "float", I: "int", J: "long", S: "short", Z: "boolean", V: "void" };
  if (names[signature]) return names[signature];
  const name = signature.replace(/^L/, "").replace(/;$/, "");
  if (name === "java/util/Optional") return "Atom";
  if (name === "java/lang/Object") return "Any";
  return name.slice(name.lastIndexOf("/") + 1);
}

/** The Felidae name of a generated class: `app$Box` (class Box of app.fx) -> `Box`; a file class keeps its name. */
export function felidaeClassName(signature: string): string {
  const simple = typeDisplayName(signature);
  const dollar = simple.indexOf("$");
  return dollar < 0 ? simple : simple.slice(dollar + 1);
}

/** The JVM package of a class signature as a folder: `Lcom/acme/app$Box;` -> `com/acme`. */
export function packagePathOf(signature: string): string {
  const name = signature.replace(/^L/, "").replace(/;$/, "");
  const slash = name.lastIndexOf("/");
  return slash < 0 ? "" : name.slice(0, slash);
}

/** The path a source has in its project: `com/acme/app.fx`, or `app.fx` in the default package. */
export function sourceKey(packagePath: string, sourceFile: string): string {
  return packagePath ? packagePath + "/" + sourceFile : sourceFile;
}

/** True when `file` is the source `key` names: it ends with the key's folders and name. */
export function pathMatchesKey(file: string, key: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return normalized === key || normalized.endsWith("/" + key);
}

/** The parameter descriptors of a method signature: `(ILjava/lang/String;)V` -> [`I`, `Ljava/lang/String;`]. */
export function parameterTypes(signature: string): string[] {
  const types: string[] = [];
  let i = 1;
  while (i < signature.length && signature[i] !== ")") {
    const start = i;
    while (signature[i] === "[") i++;
    if (signature[i] === "L") i = signature.indexOf(";", i) + 1;
    else i++;
    types.push(signature.slice(start, i));
  }
  return types;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FelidaeDebugSession {
  private seq = 1;
  private conn?: JdwpConnection;
  private proc?: childProcess.ChildProcess;
  private attached = false;
  private program = "";
  private interpreter = "";
  private sourceDirs: string[] = [];
  private stopOnEntry = false;
  private entryRequest?: number;
  private terminated = false;
  private clientSupportsTerminal = false;
  private pendingReverse = new Map<number, (message: DapMessage) => void>();

  private classes = new Map<bigint, ClassData>();
  private notFelidae = new Set<bigint>();
  private breakpoints = new Map<number, Breakpoint>();
  private bySource = new Map<string, number[]>();
  private functionBreakpoints: number[] = [];
  private nextBreakpointId = 1;
  private requestToBreakpoint = new Map<number, Breakpoint>();
  private exceptionRequest?: number;
  private exceptionFilters = new Set<string>();
  private dataRequests = new Map<number, string>();
  private stoppedException?: StoppedException;

  private threadIds = new Map<bigint, number>();
  private threadById = new Map<number, bigint>();
  private stoppedThread?: bigint;
  private frames = new Map<number, { thread: bigint; frame: Frame }>();
  private handles = new Map<number, Handle>();
  private nextHandle = 1;
  private stepRequest?: number;
  private stepReason = "step";
  private sourcePaths = new Map<string, string | undefined>();
  private sourceReferences = new Map<string, number>();
  private sourceContents = new Map<number, string>();
  private showMethods = new Map<bigint, bigint>();
  private caughtMethods = new Map<bigint, bigint>();
  private typeCache = new Map<bigint, { signature: string; supers: bigint[] }>();

  private events: Promise<void> = Promise.resolve();

  constructor(private readonly emit: (message: DapMessage) => void) {}

  // ---------------------------------------------------------------- DAP plumbing

  async handleMessage(message: DapMessage): Promise<void> {
    if (message.type === "response") {
      this.pendingReverse.get(message.request_seq)?.(message);
      this.pendingReverse.delete(message.request_seq);
      return;
    }
    if (message.type !== "request") return;
    try {
      const body = await this.dispatch(message.command, message.arguments ?? {});
      this.respond(message, true, body);
    } catch (error) {
      this.respond(message, false, undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private respond(request: DapMessage, success: boolean, body?: unknown, message?: string): void {
    this.emit({ seq: this.seq++, type: "response", request_seq: request.seq, success, command: request.command, body, message });
  }

  private event(event: string, body?: unknown): void {
    this.emit({ seq: this.seq++, type: "event", event, body });
  }

  private reverseRequest(command: string, args: unknown): Promise<DapMessage> {
    const seq = this.seq++;
    return new Promise((resolve) => {
      this.pendingReverse.set(seq, resolve);
      this.emit({ seq, type: "request", command, arguments: args });
    });
  }

  private output(text: string, category: "stdout" | "stderr" | "console" | "important" = "stdout"): void {
    if (text.length > 0) this.event("output", { category, output: text });
  }

  private async dispatch(command: string, args: any): Promise<unknown> {
    switch (command) {
      case "initialize":
        this.clientSupportsTerminal = args.supportsRunInTerminalRequest === true;
        return {
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportsConditionalBreakpoints: true,
          supportsHitConditionalBreakpoints: true,
          supportsLogPoints: true,
          supportsFunctionBreakpoints: true,
          supportsDataBreakpoints: true,
          supportsExceptionInfoRequest: true,
          exceptionBreakpointFilters: [
            { filter: UNCAUGHT_FILTER, label: "Uncaught Exceptions", description: "Stop where an exception is thrown that nothing in the program catches", default: true },
            { filter: CAUGHT_FILTER, label: "Caught Exceptions", description: "Stop where an exception is thrown that a try/catch of the program catches", default: false }
          ],
          supportsRestartFrame: true,
          supportsCompletionsRequest: true,
          completionTriggerCharacters: ["."],
          supportsLoadedSourcesRequest: true,
          supportsBreakpointLocationsRequest: true,
          supportsTerminateRequest: true,
          supportTerminateDebuggee: true,
          supportsSetVariable: false
        };
      case "launch": return args.noDebug === true ? this.run(args) : this.launch(args);
      case "attach": return this.attach(args);
      case "setBreakpoints": return this.setBreakpoints(args);
      case "setFunctionBreakpoints": return this.setFunctionBreakpoints(args);
      case "setExceptionBreakpoints": return this.setExceptionBreakpoints(args);
      case "dataBreakpointInfo": return this.dataBreakpointInfo(args);
      case "setDataBreakpoints": return this.setDataBreakpoints(args);
      case "breakpointLocations": return this.breakpointLocations(args);
      case "configurationDone": return this.configurationDone();
      case "threads": return this.threads();
      case "stackTrace": return this.stackTrace(args);
      case "scopes": return this.scopes(args);
      case "variables": return this.variables(args);
      case "evaluate": return this.evaluate(args);
      case "completions": return this.completions(args);
      case "exceptionInfo": return this.exceptionInfo(args);
      case "loadedSources": return this.loadedSources();
      case "source": return this.source(args);
      case "continue": await this.resume(); return { allThreadsContinued: true };
      case "next": return this.step(args, STEP_OVER);
      case "stepIn": return this.step(args, STEP_INTO);
      case "stepOut": return this.step(args, STEP_OUT);
      case "restartFrame": return this.restartFrame(args);
      case "pause": return this.pause();
      case "terminate": return this.disconnect({ terminateDebuggee: true });
      case "disconnect": return this.disconnect(args);
      default: throw new Error("Unsupported request: " + command);
    }
  }

  // ---------------------------------------------------------------- launch

  // The felidae command line for `program`: a felidae launcher, or felidae.jar run by java.
  private commandLine(args: any, felidaeArguments: string[]): [string, string[]] {
    const options: string[] = [];
    if (args.classpath) options.push("--classpath", String(args.classpath));
    if (args.libraryPath) options.push("--library-path", String(args.libraryPath));
    const all = [...felidaeArguments, ...options, this.program, ...((args.args as string[] | undefined) ?? []).map(String)];
    return this.interpreter.endsWith(".jar")
      ? [String(args.javaPath ?? "java"), ["-jar", this.interpreter, ...all]]
      : [this.interpreter, all];
  }

  private prepare(args: any): { cwd: string; env: NodeJS.ProcessEnv } {
    this.program = path.resolve(String(args.program));
    this.interpreter = String(args.interpreterPath || "felidae");
    this.stopOnEntry = args.stopOnEntry === true;
    this.sourceDirs = [path.dirname(this.program), ...((args.sourceDirs as string[] | undefined) ?? [])];
    const env = { ...process.env };
    for (const [key, value] of Object.entries((args.env as Record<string, string | null> | undefined) ?? {})) {
      if (value === null) delete env[key];
      else env[key] = String(value);
    }
    return { cwd: args.cwd ? String(args.cwd) : path.dirname(this.program), env };
  }

  // Forwards a child's output, a line at a time, so a line is never split between two events.
  private pipe(child: childProcess.ChildProcess, onLine?: (line: string, stream: "stdout" | "stderr") => boolean): void {
    const buffers = { stdout: "", stderr: "" };
    const take = (stream: "stdout" | "stderr", chunk: Buffer) => {
      buffers[stream] += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffers[stream].indexOf("\n")) >= 0) {
        const line = buffers[stream].slice(0, newline + 1);
        buffers[stream] = buffers[stream].slice(newline + 1);
        if (!onLine?.(line, stream)) this.output(line, stream);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => take("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => take("stderr", chunk));
    child.on("exit", () => {
      for (const stream of ["stdout", "stderr"] as const) if (buffers[stream]) this.output(buffers[stream], stream);
    });
  }

  // Run without debugging: felidae runs the program and the session ends with it.
  private async run(args: any): Promise<unknown> {
    const { cwd, env } = this.prepare(args);
    const [command, commandArguments] = this.commandLine(args, []);
    if (args.console === "integratedTerminal" && this.clientSupportsTerminal) {
      await this.reverseRequest("runInTerminal", { kind: "integrated", title: "Felidae: " + path.basename(this.program), cwd, args: [command, ...commandArguments], env: args.env ?? {} });
      setTimeout(() => this.finish(), 0);
      return {};
    }
    const child = childProcess.spawn(command, commandArguments, { cwd, env });
    this.proc = child;
    this.pipe(child);
    child.on("error", (error) => {
      this.output("Cannot start " + command + ": " + error.message + "\n", "stderr");
      this.finish();
    });
    child.on("exit", (code) => {
      this.event("exited", { exitCode: code ?? 1 });
      this.finish();
    });
    return {};
  }

  private async launch(args: any): Promise<unknown> {
    const { cwd, env } = this.prepare(args);
    if (args.console === "integratedTerminal" && this.clientSupportsTerminal) {
      // The program runs in a terminal the user can type into; the session attaches to the port it was given.
      const port = await freePort();
      const [command, commandArguments] = this.commandLine(args, ["--debug", "--port", String(port)]);
      const response = await this.reverseRequest("runInTerminal", {
        kind: "integrated", title: "Felidae: " + path.basename(this.program), cwd, args: [command, ...commandArguments], env: args.env ?? {}
      });
      if (!response.success) throw new Error("Cannot start the program in a terminal: " + (response.message ?? "refused"));
      await this.connectWithRetry("127.0.0.1", port, 60000);
      this.event("initialized");
      return {};
    }
    const [command, commandArguments] = this.commandLine(args, ["--debug", "--port", "0"]);
    const port = await new Promise<number>((resolve, reject) => {
      const child = childProcess.spawn(command, commandArguments, { cwd, env });
      this.proc = child;
      let found = false;
      let errors = "";
      this.pipe(child, (line, stream) => {
        const match = LISTENING.exec(line);
        if (match && !found) {
          found = true;
          resolve(Number(match[1]));
          return true;
        }
        if (!found && stream === "stderr") errors += line;
        return false;
      });
      child.on("error", (error) => reject(new Error("Cannot start " + command + ": " + error.message)));
      child.on("exit", (code) => {
        if (!found) reject(new Error(errors.trim() || "felidae exited with status " + code + " before the program started"));
        else {
          this.event("exited", { exitCode: code ?? 1 });
          this.finish();
        }
      });
    });
    await this.connect("127.0.0.1", port);
    this.event("initialized");
    return {};
  }

  // Attach to a program that was started with `felidae --debug`.
  private async attach(args: any): Promise<unknown> {
    this.attached = true;
    this.program = args.program ? path.resolve(String(args.program)) : "";
    this.interpreter = String(args.interpreterPath ?? "");
    this.sourceDirs = [...((args.sourceDirs as string[] | undefined) ?? []), ...(this.program ? [path.dirname(this.program)] : [])];
    this.stopOnEntry = args.stopOnEntry === true;
    await this.connectWithRetry(String(args.host ?? "127.0.0.1"), Number(args.port), Number(args.timeout ?? 10000));
    this.event("initialized");
    return {};
  }

  private async connectWithRetry(host: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.connect(host, port);
        return;
      } catch (error) {
        if (Date.now() > deadline || this.terminated) {
          throw new Error("Cannot connect to the program at " + host + ":" + port + ": " + (error instanceof Error ? error.message : String(error)));
        }
        await delay(250);
      }
    }
  }

  private async connect(host: string, port: number): Promise<void> {
    const conn = await JdwpConnection.connect(host, port);
    this.conn = conn;
    conn.onEvents = (policy, events) => {
      this.events = this.events.then(() => this.onEvents(policy, events)).catch((error) => this.output(String(error) + "\n", "stderr"));
    };
    conn.onClose = () => this.finish();
    // Every class compiled from a .fx file: its breakpoints are set when it loads, before it runs.
    await conn.setEvent(EventKind.ClassPrepare, SuspendPolicy.All, [conn.sourceNameModifier("*.fx")]);
    await conn.setEvent(EventKind.ThreadStart, SuspendPolicy.None, []);
    await conn.setEvent(EventKind.ThreadDeath, SuspendPolicy.None, []);
    // Classes already loaded (attaching to a running program).
    for (const loaded of await conn.allClasses()) {
      if (!SYSTEM_CLASS_PREFIXES.some((prefix) => loaded.signature.startsWith(prefix))) await this.loadClass(loaded.typeId);
    }
  }

  private finish(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.event("terminated");
  }

  private async configurationDone(): Promise<unknown> {
    await this.conn?.resume();
    return {};
  }

  private async disconnect(args: any): Promise<unknown> {
    const conn = this.conn;
    const child = this.proc;
    this.conn = undefined;
    // An attached program runs on unless asked to end; a launched one ends with the session.
    const terminate = args?.terminateDebuggee ?? !this.attached;
    if (conn) {
      try {
        await Promise.race([terminate ? conn.exit(0) : conn.dispose(), delay(1000)]);
      } catch {
        // the VM is already gone
      }
      conn.destroy();
    }
    if (child && child.exitCode === null && terminate) setTimeout(() => child.kill(), 1500).unref();
    this.finish();
    return {};
  }

  // ---------------------------------------------------------------- classes and breakpoints

  private async loadClass(typeId: bigint): Promise<ClassData | undefined> {
    const known = this.classes.get(typeId);
    if (known || this.notFelidae.has(typeId)) return known;
    const conn = this.conn!;
    const sourceFile = await conn.sourceFile(typeId);
    if (!sourceFile || !sourceFile.endsWith(".fx")) {
      this.notFelidae.add(typeId);
      return undefined;
    }
    const signature = await conn.signature(typeId);
    const data: ClassData = { typeId, signature, packagePath: packagePathOf(signature), sourceFile, methods: new Map() };
    for (const info of await conn.methods(typeId)) {
      const lines = (await conn.lineTable(typeId, info.methodId)).sort((a, b) => (a.codeIndex < b.codeIndex ? -1 : a.codeIndex > b.codeIndex ? 1 : 0));
      data.methods.set(info.methodId, { info, lines });
    }
    this.classes.set(typeId, data);
    return data;
  }

  private keyOf(data: ClassData): string {
    return sourceKey(data.packagePath, data.sourceFile);
  }

  private lineAt(method: MethodData, index: bigint): number | undefined {
    let line: number | undefined;
    for (const entry of method.lines) {
      if (entry.codeIndex > index) break;
      line = entry.line;
    }
    return line;
  }

  // Where `line` is in one class: its own code, else (a line inside a method with no code of its own, such as a
  // blank line or `end`) the next line of that method that has code. A line outside every method is not in the class.
  private resolveIn(data: ClassData, line: number): { location: Location; line: number } | undefined {
    let exact: { location: Location; line: number } | undefined;
    let adjusted: { location: Location; line: number } | undefined;
    for (const method of data.methods.values()) {
      if (method.lines.length === 0) continue;
      const first = method.lines.reduce((low, entry) => Math.min(low, entry.line), Infinity);
      const last = method.lines.reduce((high, entry) => Math.max(high, entry.line), 0);
      for (const entry of method.lines) {
        const location = { typeTag: 1, classId: data.typeId, methodId: method.info.methodId, index: entry.codeIndex };
        if (entry.line === line) {
          if (!exact || entry.codeIndex < exact.location.index) exact = { location, line };
        } else if (entry.line > line && line > first && line < last) {
          if (!adjusted || entry.line < adjusted.line || (entry.line === adjusted.line && entry.codeIndex < adjusted.location.index)) {
            adjusted = { location, line: entry.line };
          }
        }
      }
    }
    return exact ?? adjusted;
  }

  // The first code of the methods a function breakpoint names: `name` or `Class.name`.
  private functionLocations(data: ClassData, name: string): Array<{ location: Location; line: number }> {
    const dot = name.lastIndexOf(".");
    const owner = dot < 0 ? undefined : name.slice(0, dot);
    const method = dot < 0 ? name : name.slice(dot + 1);
    if (owner !== undefined && felidaeClassName(data.signature) !== owner && typeDisplayName(data.signature) !== owner) return [];
    const found: Array<{ location: Location; line: number }> = [];
    for (const candidate of data.methods.values()) {
      if (displayName(candidate.info.name) !== method || candidate.lines.length === 0) continue;
      const first = candidate.lines[0];
      found.push({ location: { typeTag: 1, classId: data.typeId, methodId: candidate.info.methodId, index: first.codeIndex }, line: first.line });
    }
    return found;
  }

  // Sets the breakpoint in every loaded class it applies to (or just `only`); true once any class holds it.
  private async installBreakpoint(breakpoint: Breakpoint, only?: ClassData): Promise<boolean> {
    if (!this.conn) return breakpoint.requestIds.length > 0;
    for (const data of only ? [only] : this.classes.values()) {
      if (breakpoint.classes.has(data.typeId)) continue;
      let found: Array<{ location: Location; line: number }>;
      if (breakpoint.functionName) {
        found = this.functionLocations(data, breakpoint.functionName);
      } else {
        if (!pathMatchesKey(breakpoint.source!.path, this.keyOf(data))) continue;
        const at = this.resolveIn(data, breakpoint.requestedLine);
        found = at ? [at] : [];
      }
      if (found.length === 0) continue;
      breakpoint.classes.add(data.typeId);
      for (const at of found) {
        const requestId = await this.conn.setEvent(EventKind.Breakpoint, SuspendPolicy.All, [this.conn.locationModifier(at.location)]);
        if (breakpoint.requestIds.length === 0) breakpoint.line = at.line;
        breakpoint.requestIds.push(requestId);
        this.requestToBreakpoint.set(requestId, breakpoint);
      }
    }
    return breakpoint.requestIds.length > 0;
  }

  private async removeBreakpoint(id: number): Promise<void> {
    const old = this.breakpoints.get(id);
    for (const requestId of old?.requestIds ?? []) {
      await this.conn?.clearEvent(EventKind.Breakpoint, requestId).catch(() => undefined);
      this.requestToBreakpoint.delete(requestId);
    }
    this.breakpoints.delete(id);
  }

  private describeBreakpoint(breakpoint: Breakpoint): unknown {
    const verified = breakpoint.requestIds.length > 0;
    return {
      id: breakpoint.id,
      verified,
      line: breakpoint.source ? breakpoint.line : undefined,
      message: verified ? undefined : breakpoint.functionName ? "No loaded method is named " + breakpoint.functionName + " yet" : "The class of this line is not loaded yet"
    };
  }

  private newBreakpoint(item: any, fields: Partial<Breakpoint>): Breakpoint {
    const breakpoint: Breakpoint = {
      id: this.nextBreakpointId++,
      requestedLine: Number(item.line ?? 0),
      line: Number(item.line ?? 0),
      condition: item.condition?.trim() || undefined,
      hitCondition: item.hitCondition?.trim() || undefined,
      logMessage: item.logMessage || undefined,
      hits: 0,
      requestIds: [],
      classes: new Set(),
      ...fields
    };
    this.breakpoints.set(breakpoint.id, breakpoint);
    return breakpoint;
  }

  private async setBreakpoints(args: any): Promise<unknown> {
    const file = path.resolve(String(args.source?.path ?? args.source?.name ?? ""));
    for (const id of this.bySource.get(file) ?? []) await this.removeBreakpoint(id);
    const requested: any[] = args.breakpoints ?? (args.lines ?? []).map((line: number) => ({ line }));
    const ids: number[] = [];
    const result: unknown[] = [];
    for (const item of requested) {
      const breakpoint = this.newBreakpoint(item, { source: { path: file } });
      ids.push(breakpoint.id);
      await this.installBreakpoint(breakpoint);
      result.push(this.describeBreakpoint(breakpoint));
    }
    this.bySource.set(file, ids);
    return { breakpoints: result };
  }

  private async setFunctionBreakpoints(args: any): Promise<unknown> {
    for (const id of this.functionBreakpoints) await this.removeBreakpoint(id);
    this.functionBreakpoints = [];
    const result: unknown[] = [];
    for (const item of (args.breakpoints ?? []) as any[]) {
      const breakpoint = this.newBreakpoint(item, { functionName: String(item.name).trim() });
      this.functionBreakpoints.push(breakpoint.id);
      await this.installBreakpoint(breakpoint);
      result.push(this.describeBreakpoint(breakpoint));
    }
    return { breakpoints: result };
  }

  // One JDWP request covers both filters; which of them a thrown exception meets is decided where it is caught.
  private async setExceptionBreakpoints(args: any): Promise<unknown> {
    this.exceptionFilters = new Set((args.filters ?? []) as string[]);
    const conn = this.conn;
    if (!conn) return {};
    if (this.exceptionRequest !== undefined) {
      await conn.clearEvent(EventKind.Exception, this.exceptionRequest).catch(() => undefined);
      this.exceptionRequest = undefined;
    }
    if (this.exceptionFilters.size > 0) {
      this.exceptionRequest = await conn.setEvent(EventKind.Exception, SuspendPolicy.All, [conn.exceptionOnlyModifier(0n, true, true)]);
    }
    return {};
  }

  // A field of an object (or a shared field in Statics) can be watched for being bound or read.
  private async dataBreakpointInfo(args: any): Promise<unknown> {
    const handle = this.handles.get(args.variablesReference);
    const none = { dataId: null, description: "Only a field of an object or a shared field can be watched" };
    if (!handle || (handle.kind !== "object" && handle.kind !== "statics")) return none;
    if (handle.kind === "object" && handle.view !== "fields") return none;
    const field = (await this.allFields(handle.classId)).find((candidate) => candidate.field.name === args.name);
    if (!field) return none;
    const objectId = handle.kind === "object" ? handle.objectId : 0n;
    return {
      dataId: field.owner + "/" + field.field.fieldId + "/" + objectId,
      description: args.name,
      accessTypes: ["write", "read", "readWrite"],
      canPersist: false
    };
  }

  private async setDataBreakpoints(args: any): Promise<unknown> {
    const conn = this.conn;
    for (const [requestId, kind] of this.dataRequests) {
      await conn?.clearEvent(kind === "read" ? EventKind.FieldAccess : EventKind.FieldModification, requestId).catch(() => undefined);
    }
    this.dataRequests.clear();
    const result: unknown[] = [];
    for (const item of (args.breakpoints ?? []) as any[]) {
      const [classId, fieldId, objectId] = String(item.dataId).split("/").map((part) => BigInt(part));
      const access = String(item.accessType ?? "write");
      const ok = !!conn;
      if (conn) {
        for (const kind of access === "readWrite" ? ["write", "read"] : [access]) {
          const modifiers = [conn.fieldOnlyModifier(classId, fieldId)];
          if (objectId !== 0n) modifiers.push(conn.instanceOnlyModifier(objectId));
          const requestId = await conn.setEvent(kind === "read" ? EventKind.FieldAccess : EventKind.FieldModification, SuspendPolicy.All, modifiers);
          this.dataRequests.set(requestId, kind);
        }
      }
      result.push({ verified: ok });
    }
    return { breakpoints: result };
  }

  private breakpointLocations(args: any): unknown {
    const file = path.resolve(String(args.source?.path ?? ""));
    const from = Number(args.line);
    const to = Number(args.endLine ?? args.line);
    const lines = new Set<number>();
    for (const data of this.classes.values()) {
      if (!pathMatchesKey(file, this.keyOf(data))) continue;
      for (const method of data.methods.values()) {
        for (const entry of method.lines) if (entry.line >= from && entry.line <= to) lines.add(entry.line);
      }
    }
    return { breakpoints: [...lines].sort((a, b) => a - b).map((line) => ({ line })) };
  }

  // ---------------------------------------------------------------- events

  private async onEvents(policy: number, events: JdwpEvent[]): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    let stop: { thread: bigint; reason: string; description?: string; text?: string; hitBreakpointIds?: number[] } | undefined;
    let resume = false;
    for (const event of events) {
      switch (event.kind) {
        case EventKind.ClassPrepare: {
          const data = await this.loadClass(event.typeId!);
          if (data) await this.classPrepared(data);
          resume = resume || policy !== SuspendPolicy.None;
          break;
        }
        case EventKind.Breakpoint: {
          const user = this.requestToBreakpoint.get(event.requestId);
          if (user) {
            const decision = await this.breakpointHit(user, event.thread!);
            if (decision.stop) stop ??= { thread: event.thread!, reason: user.functionName ? "function breakpoint" : "breakpoint", description: decision.description, text: decision.text, hitBreakpointIds: [user.id] };
            else resume = true;
          } else if (event.requestId === this.entryRequest) {
            await conn.clearEvent(EventKind.Breakpoint, event.requestId).catch(() => undefined);
            this.entryRequest = undefined;
            stop ??= { thread: event.thread!, reason: "entry" };
          } else {
            resume = true;
          }
          break;
        }
        case EventKind.SingleStep: {
          if (this.stepRequest !== undefined) {
            await conn.clearEvent(EventKind.SingleStep, this.stepRequest).catch(() => undefined);
            this.stepRequest = undefined;
          }
          // A step that ended in generated plumbing (the entry point, no line information) just runs on.
          const location = event.location!;
          const method = (await this.loadClass(location.classId))?.methods.get(location.methodId);
          if (method && method.lines.length > 0) stop ??= { thread: event.thread!, reason: this.stepReason };
          else resume = true;
          this.stepReason = "step";
          break;
        }
        case EventKind.Exception: {
          const reported = await this.exceptionReported(event);
          if (reported) {
            this.stoppedException = reported;
            stop ??= { thread: event.thread!, reason: "exception", description: reported.uncaught ? "Uncaught exception" : "Caught exception", text: await this.exceptionText(reported) };
          } else {
            resume = true;
          }
          break;
        }
        case EventKind.FieldAccess:
        case EventKind.FieldModification:
          stop ??= { thread: event.thread!, reason: "data breakpoint", description: event.kind === EventKind.FieldAccess ? "Field read" : "Field bound" };
          break;
        case EventKind.ThreadStart:
          this.event("thread", { reason: "started", threadId: this.threadId(event.thread!) });
          break;
        case EventKind.ThreadDeath:
          this.event("thread", { reason: "exited", threadId: this.threadId(event.thread!) });
          break;
        case EventKind.VmDeath:
          this.finish();
          return;
        default:
          break;
      }
    }
    if (stop) {
      if (stop.reason !== "exception") this.stoppedException = undefined;
      this.stoppedThread = stop.thread;
      this.frames.clear();
      this.handles.clear();
      this.event("stopped", {
        reason: stop.reason,
        threadId: this.threadId(stop.thread),
        allThreadsStopped: true,
        description: stop.description,
        text: stop.text,
        hitBreakpointIds: stop.hitBreakpointIds
      });
    } else if (resume && policy !== SuspendPolicy.None) {
      await conn.resume().catch(() => undefined);
    }
  }

  // Conditions, hit counts and log messages decide whether a breakpoint stops the program.
  private async breakpointHit(breakpoint: Breakpoint, thread: bigint): Promise<{ stop: boolean; description?: string; text?: string }> {
    if (breakpoint.condition) {
      try {
        if (!(await this.topEvaluator(thread).condition(breakpoint.condition))) return { stop: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.output("Breakpoint condition '" + breakpoint.condition + "' failed: " + message + "\n", "important");
        return { stop: true, description: "Breakpoint condition error", text: message };
      }
    }
    breakpoint.hits++;
    if (breakpoint.hitCondition) {
      try {
        if (!hitConditionMet(breakpoint.hitCondition, breakpoint.hits)) return { stop: false };
      } catch (error) {
        return { stop: true, description: "Hit count error", text: error instanceof Error ? error.message : String(error) };
      }
    }
    if (breakpoint.logMessage) {
      const evaluator = this.topEvaluator(thread);
      const text = await interpolate(breakpoint.logMessage, async (expression) => this.renderValue(await evaluator.evaluate(expression), thread, await this.topContext(thread)).then((r) => r.text));
      this.output(text + "\n", "console");
      return { stop: false };
    }
    return { stop: true };
  }

  // Whether an exception stops the program: uncaught means nothing in the program catches it (the generated entry
  // point's handler, which prints `error: ...` and exits, does not count); caught means a try/catch of the program does.
  // An exception thrown and caught inside the JDK or a driver is theirs, and never shown.
  private async exceptionReported(event: JdwpEvent): Promise<StoppedException | undefined> {
    if (this.exceptionFilters.size === 0) return undefined;
    const thrownIn = await this.loadClass(event.location!.classId);
    let uncaught = event.catchLocation === undefined;
    let caughtByProgram = false;
    if (event.catchLocation) {
      const catcher = await this.loadClass(event.catchLocation.classId);
      if (catcher) {
        const method = catcher.methods.get(event.catchLocation.methodId);
        if (method?.info.name === "main" && method.info.signature === "([Ljava/lang/String;)V") uncaught = true;
        else caughtByProgram = true;
      }
    }
    const report = (uncaught && this.exceptionFilters.has(UNCAUGHT_FILTER)) || (caughtByProgram && this.exceptionFilters.has(CAUGHT_FILTER));
    if (!report) return undefined;
    // The exception's Felidae view needs a class of the program to call $caught on.
    let context = thrownIn?.typeId;
    if (context === undefined) {
      for (const frame of await this.conn!.frames(event.thread!)) {
        if (await this.loadClass(frame.location.classId)) {
          context = frame.location.classId;
          break;
        }
      }
    }
    if (context === undefined) context = this.classes.keys().next().value;
    if (context === undefined) return undefined;
    return { thread: event.thread!, exception: event.exception!, context, uncaught };
  }

  // The (kind, message) a catch variable would hold, from the program's own $caught.
  private async exceptionView(stopped: StoppedException): Promise<{ kind: string; message: string; type: string }> {
    const conn = this.conn!;
    const type = (await this.typeOf(stopped.exception)).signature;
    let kind = typeDisplayName(type);
    let message = "";
    try {
      const caught = await this.caughtMethod(stopped.context);
      const view = await conn.invokeStatic(stopped.context, stopped.thread, caught, [{ tag: "L", value: stopped.exception }]);
      if (view.exception === null && typeof view.value.value === "bigint") {
        const map: Remote = { remote: true, tag: "L", value: view.value.value };
        const host = this.host(stopped.thread, undefined, stopped.context);
        const kindValue = await host.invoke(map, "get", ["kind"]);
        const messageValue = await host.invoke(map, "get", ["message"]);
        const kindText = isRemote(kindValue) ? await host.unbox(kindValue) : kindValue;
        const messageText = isRemote(messageValue) ? await host.unbox(messageValue) : messageValue;
        if (kindText !== undefined && kindText !== null) kind = String(kindText);
        if (messageText !== undefined && messageText !== null) message = String(messageText);
      }
    } catch {
      // fall back to the class name
    }
    return { kind, message, type: type.replace(/^L/, "").replace(/;$/, "").replace(/\//g, ".") };
  }

  private async exceptionText(stopped: StoppedException): Promise<string> {
    const view = await this.exceptionView(stopped);
    return view.kind + (view.message ? ": " + view.message : "");
  }

  private async exceptionInfo(args: any): Promise<unknown> {
    const stopped = this.stoppedException;
    const thread = this.threadById.get(args.threadId);
    if (!stopped || (thread !== undefined && thread !== stopped.thread)) throw new Error("The thread is not stopped at an exception");
    const view = await this.exceptionView(stopped);
    return {
      exceptionId: view.kind,
      description: view.message || view.kind,
      breakMode: stopped.uncaught ? "unhandled" : "always",
      details: { message: view.message, typeName: typeDisplayName("L" + view.type.replace(/\./g, "/") + ";"), fullTypeName: view.type }
    };
  }

  // A class compiled from a .fx file has loaded: set the breakpoints waiting for it, and the entry stop.
  private async classPrepared(data: ClassData): Promise<void> {
    for (const breakpoint of this.breakpoints.values()) {
      const wasVerified = breakpoint.requestIds.length > 0;
      if ((await this.installBreakpoint(breakpoint, data)) && !wasVerified) {
        this.event("breakpoint", { reason: "changed", breakpoint: this.describeBreakpoint(breakpoint) });
      }
    }
    if (this.stopOnEntry && this.entryRequest === undefined && this.program && data.sourceFile === path.basename(this.program)) {
      for (const method of data.methods.values()) {
        if (method.info.name === "main" && method.info.signature.startsWith("()") && method.lines.length > 0) {
          const first = method.lines[0];
          this.entryRequest = await this.conn!.setEvent(EventKind.Breakpoint, SuspendPolicy.All, [
            this.conn!.locationModifier({ typeTag: 1, classId: data.typeId, methodId: method.info.methodId, index: first.codeIndex })
          ]);
          break;
        }
      }
    }
    this.event("loadedSource", { reason: "new", source: this.sourceOf(data) });
  }

  // ---------------------------------------------------------------- running

  private invalidate(): void {
    this.frames.clear();
    this.handles.clear();
    this.stoppedThread = undefined;
    this.stoppedException = undefined;
  }

  private async resume(): Promise<void> {
    this.invalidate();
    await this.conn!.resume();
  }

  private async step(args: any, depth: number): Promise<unknown> {
    const conn = this.conn!;
    const thread = this.threadById.get(args.threadId) ?? this.stoppedThread;
    if (thread === undefined) throw new Error("The program is not stopped");
    if (this.stepRequest !== undefined) await conn.clearEvent(EventKind.SingleStep, this.stepRequest).catch(() => undefined);
    // The count goes last: modifiers apply in order, and a count in front would be used up by an event the
    // filters behind it then drop.
    this.stepRequest = await conn.setEvent(EventKind.SingleStep, SuspendPolicy.All, [
      conn.stepModifier(thread, STEP_LINE, depth),
      ...STEP_EXCLUDES.map((pattern) => conn.classExcludeModifier(pattern)),
      conn.countModifier(1)
    ]);
    await this.resume();
    return {};
  }

  // Pops the frame and steps into the call again: the function runs anew from its first line, with the same
  // arguments (they never changed, so this is exactly a fresh call).
  private async restartFrame(args: any): Promise<unknown> {
    const found = this.frames.get(args.frameId);
    if (!found) throw new Error("Unknown frame");
    await this.conn!.popFrames(found.thread, found.frame.frameId);
    this.stepReason = "restart";
    await this.step({ threadId: this.threadId(found.thread) }, STEP_INTO);
    return {};
  }

  private async pause(): Promise<unknown> {
    const conn = this.conn!;
    await conn.suspend();
    let main: bigint | undefined;
    for (const thread of await conn.allThreads()) {
      if ((await conn.threadName(thread)) === "main") main = thread;
    }
    if (main === undefined) throw new Error("The program has no main thread");
    this.stoppedThread = main;
    this.event("stopped", { reason: "pause", threadId: this.threadId(main), allThreadsStopped: true });
    return {};
  }

  // ---------------------------------------------------------------- stack and sources

  private threadId(thread: bigint): number {
    let id = this.threadIds.get(thread);
    if (id === undefined) {
      id = this.threadIds.size + 1;
      this.threadIds.set(thread, id);
      this.threadById.set(id, thread);
    }
    return id;
  }

  private async threads(): Promise<unknown> {
    const conn = this.conn;
    if (!conn) return { threads: [] };
    const result: Array<{ id: number; name: string }> = [];
    for (const thread of await conn.allThreads()) {
      result.push({ id: this.threadId(thread), name: await conn.threadName(thread).catch(() => "thread") });
    }
    return { threads: result };
  }

  // The file of a source key: a breakpoint's file, else one found from the program's folder (and the folders above
  // it, since a package puts a file several folders below the project root) or the configured source folders.
  private findSource(key: string): string | undefined {
    if (this.sourcePaths.has(key)) return this.sourcePaths.get(key);
    let found: string | undefined;
    for (const file of this.bySource.keys()) if (pathMatchesKey(file, key)) found = file;
    if (!found && this.program && pathMatchesKey(this.program, key)) found = this.program;
    const bases: string[] = [];
    for (const directory of this.sourceDirs) {
      let current = path.resolve(directory);
      for (let depth = 0; depth < 8; depth++) {
        bases.push(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    for (const base of bases) {
      if (found) break;
      const candidate = path.join(base, ...key.split("/"));
      if (fs.existsSync(candidate)) found = candidate;
    }
    this.sourcePaths.set(key, found);
    return found;
  }

  // An embedded package (org/felidae/db/tidesdb.fx) has no file: its source is read from the compiler's jar.
  private embeddedSource(key: string): string | undefined {
    if (!this.interpreter) return undefined;
    const interpreter = path.resolve(this.interpreter);
    const jars = interpreter.endsWith(".jar") ? [interpreter] : (() => {
      const lib = path.join(path.dirname(path.dirname(interpreter)), "lib");
      try {
        return fs.readdirSync(lib).filter((name) => name.endsWith(".jar")).map((name) => path.join(lib, name));
      } catch {
        return [];
      }
    })();
    for (const jar of jars) {
      const text = ZipArchive.open(jar)?.readText(key);
      if (text !== undefined) return text;
    }
    return undefined;
  }

  private sourceOf(data: ClassData): { name: string; path?: string; sourceReference?: number; presentationHint?: string; origin?: string } {
    const key = this.keyOf(data);
    const file = this.findSource(key);
    if (file) return { name: data.sourceFile, path: file };
    let reference = this.sourceReferences.get(key);
    if (reference === undefined) {
      const content = this.embeddedSource(key);
      if (content !== undefined) {
        reference = this.sourceReferences.size + 1;
        this.sourceReferences.set(key, reference);
        this.sourceContents.set(reference, content);
      }
    }
    return reference !== undefined
      ? { name: data.sourceFile, sourceReference: reference, presentationHint: "deemphasize", origin: "embedded package " + key.replace(/\.fx$/, "").replace(/\//g, ".") }
      : { name: data.sourceFile, presentationHint: "deemphasize" };
  }

  private source(args: any): unknown {
    const content = this.sourceContents.get(Number(args.sourceReference ?? args.source?.sourceReference));
    if (content === undefined) throw new Error("No source is available for this frame");
    return { content, mimeType: "text/x-felidae" };
  }

  private loadedSources(): unknown {
    const seen = new Set<string>();
    const sources: unknown[] = [];
    for (const data of this.classes.values()) {
      const key = this.keyOf(data);
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(this.sourceOf(data));
    }
    return { sources };
  }

  private async stackTrace(args: any): Promise<unknown> {
    const thread = this.threadById.get(args.threadId) ?? this.stoppedThread;
    if (thread === undefined || !this.conn) return { stackFrames: [], totalFrames: 0 };
    const stackFrames: unknown[] = [];
    for (const frame of await this.conn.frames(thread)) {
      const data = await this.loadClass(frame.location.classId);
      const method = data?.methods.get(frame.location.methodId);
      if (!data || !method || method.lines.length === 0) continue; // the JDK, drivers and generated plumbing
      const line = this.lineAt(method, frame.location.index) ?? method.lines[0].line;
      const id = 1000 + this.frames.size;
      this.frames.set(id, { thread, frame });
      const owner = felidaeClassName(data.signature);
      const fileClass = owner === path.basename(data.sourceFile, ".fx");
      const source = this.sourceOf(data);
      stackFrames.push({
        id,
        name: (fileClass ? "" : owner + ".") + displayName(method.info.name),
        source,
        line,
        column: 1,
        canRestart: true,
        presentationHint: source.path ? "normal" : "subtle"
      });
    }
    const start = Number(args.startFrame ?? 0);
    const levels = Number(args.levels ?? 0);
    return { stackFrames: levels > 0 ? stackFrames.slice(start, start + levels) : stackFrames.slice(start), totalFrames: stackFrames.length };
  }

  // ---------------------------------------------------------------- scopes and variables

  private newHandle(handle: Handle): number {
    const id = this.nextHandle++;
    this.handles.set(id, handle);
    return id;
  }

  private async scopes(args: any): Promise<unknown> {
    const found = this.frames.get(args.frameId);
    if (!found) return { scopes: [] };
    const scopes: unknown[] = [{ name: "Locals", presentationHint: "locals", variablesReference: this.newHandle({ kind: "locals", thread: found.thread, frame: found.frame }), expensive: false }];
    if ((await this.staticFields(found.frame.location.classId)).length > 0) {
      const data = this.classes.get(found.frame.location.classId);
      scopes.push({
        name: "Statics" + (data ? " (" + felidaeClassName(data.signature) + ")" : ""),
        variablesReference: this.newHandle({ kind: "statics", thread: found.thread, classId: found.frame.location.classId }),
        expensive: false
      });
    }
    return { scopes };
  }

  // The variables of a frame that are in scope at its position, innermost declaration winning.
  private async visibleVariables(frame: Frame): Promise<VariableEntry[]> {
    const table = await this.conn!.variableTable(frame.location.classId, frame.location.methodId);
    const byName = new Map<string, VariableEntry>();
    for (const entry of table) {
      if (entry.name.startsWith("$")) continue;
      if (entry.codeIndex > frame.location.index || frame.location.index >= entry.codeIndex + BigInt(entry.length)) continue;
      const previous = byName.get(entry.name);
      if (!previous || previous.codeIndex <= entry.codeIndex) byName.set(entry.name, entry);
    }
    return [...byName.values()].sort((a, b) => (a.name === "this" ? -1 : b.name === "this" ? 1 : a.slot - b.slot));
  }

  // The runtime class of an object, its signature, and every supertype (classes first, then interfaces).
  private async typeInfo(typeId: bigint): Promise<{ signature: string; supers: bigint[] }> {
    const cached = this.typeCache.get(typeId);
    if (cached) return cached;
    const conn = this.conn!;
    const signature = await conn.signature(typeId);
    const supers: bigint[] = [];
    const seen = new Set<bigint>();
    const classes: bigint[] = [];
    for (let current = typeId; current !== 0n; current = await conn.superclass(current).catch(() => 0n)) classes.push(current);
    const queue = [...classes];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      supers.push(next);
      for (const implemented of await conn.interfaces(next).catch(() => [] as bigint[])) queue.push(implemented);
    }
    const info = { signature, supers };
    this.typeCache.set(typeId, info);
    return info;
  }

  private async typeOf(objectId: bigint): Promise<{ typeId: bigint; signature: string; supers: bigint[] }> {
    const { typeId } = await this.conn!.objectType(objectId);
    return { typeId, ...(await this.typeInfo(typeId)) };
  }

  private async implementsType(typeId: bigint, signature: string): Promise<boolean> {
    for (const candidate of (await this.typeInfo(typeId)).supers) {
      if ((await this.typeInfo(candidate)).signature === signature) return true;
    }
    return false;
  }

  // The instance fields of a class and its superclasses (the superclass's first, as the constructor takes them).
  private async allFields(typeId: bigint): Promise<Array<{ owner: bigint; field: FieldInfo }>> {
    const conn = this.conn!;
    const chain: bigint[] = [];
    for (let current = typeId; current !== 0n; current = await conn.superclass(current).catch(() => 0n)) chain.unshift(current);
    const result: Array<{ owner: bigint; field: FieldInfo }> = [];
    for (const owner of chain) {
      for (const field of await conn.fields(owner)) {
        if (!(field.modifiers & 0x8) && !field.name.startsWith("$")) result.push({ owner, field });
      }
    }
    return result;
  }

  private async staticFields(typeId: bigint): Promise<FieldInfo[]> {
    if (!this.classes.has(typeId)) return [];
    return (await this.conn!.fields(typeId)).filter((field) => (field.modifiers & 0x8) && !field.name.startsWith("$"));
  }

  private async variables(args: any): Promise<unknown> {
    const handle = this.handles.get(args.variablesReference);
    if (!handle) return { variables: [] };
    const conn = this.conn!;
    const variables: unknown[] = [];
    const start = Number(args.start ?? 0);
    const count = Number(args.count ?? 0);
    switch (handle.kind) {
      case "locals": {
        const visible = await this.visibleVariables(handle.frame);
        if (visible.length === 0) break;
        const values = await conn.frameValues(handle.thread, handle.frame.frameId, visible.map((v) => ({ slot: v.slot, signature: v.signature })));
        for (let i = 0; i < visible.length; ++i) {
          variables.push(await this.variable(visible[i].name, values[i], handle.thread, handle.frame.location.classId, visible[i].signature, visible[i].name));
        }
        break;
      }
      case "statics": {
        const fields = await this.staticFields(handle.classId);
        const values = await conn.staticValues(handle.classId, fields.map((f) => f.fieldId));
        const owner = felidaeClassName(this.classes.get(handle.classId)?.signature ?? "");
        for (let i = 0; i < fields.length; ++i) {
          variables.push(await this.variable(fields[i].name, values[i], handle.thread, handle.classId, fields[i].signature, owner + "." + fields[i].name));
        }
        break;
      }
      case "entry": {
        variables.push(await this.variable("key", handle.key, handle.thread, handle.context, "Ljava/lang/Object;"));
        variables.push(await this.variable("value", handle.value, handle.thread, handle.context, "Ljava/lang/Object;"));
        break;
      }
      case "object": {
        if (handle.view === "fields") {
          const fields = await this.allFields(handle.classId);
          const values = await conn.objectFields(handle.objectId, fields.map((f) => f.field.fieldId));
          for (let i = 0; i < fields.length; ++i) {
            variables.push(await this.variable(fields[i].field.name, values[i], handle.thread, handle.context, fields[i].field.signature));
          }
          break;
        }
        const elements = await this.elements(handle);
        const slice = count > 0 ? elements.slice(start, start + count) : elements.slice(start);
        for (let i = 0; i < slice.length; i++) {
          const index = start + i;
          if (handle.view === "map") {
            const [key, value] = slice[i] as [JdwpValue, JdwpValue];
            const keyText = (await this.render(key, handle.thread, handle.context, "Ljava/lang/Object;")).text;
            const rendered = await this.render(value, handle.thread, handle.context, "Ljava/lang/Object;");
            variables.push({ name: keyText, value: rendered.text, type: rendered.type, variablesReference: rendered.reference ?? 0, indexedVariables: rendered.indexed });
          } else {
            variables.push(await this.variable("[" + index + "]", slice[i] as JdwpValue, handle.thread, handle.context, "Ljava/lang/Object;"));
          }
        }
        break;
      }
    }
    return { variables };
  }

  // The elements of a list or array, or the [key, value] pairs of a map, read in the debuggee.
  private async elements(handle: Extract<Handle, { kind: "object" }>): Promise<Array<JdwpValue | [JdwpValue, JdwpValue]>> {
    const conn = this.conn!;
    const host = this.host(handle.thread, undefined, handle.context);
    const self: Remote = { remote: true, tag: "L", value: handle.objectId };
    const arrayOf = async (array: Value): Promise<JdwpValue[]> => {
      if (!isRemote(array) || typeof array.value !== "bigint") return [];
      const length = await conn.arrayLength(array.value);
      return length === 0 ? [] : conn.arrayValues(array.value, 0, Math.min(length, 10000));
    };
    if (handle.view === "array") return arrayOf(self);
    if (handle.view === "list") return arrayOf(await host.invoke(self, "toArray", []));
    const entries = await arrayOf(await host.invoke(await host.invoke(self, "entrySet", []) as Remote, "toArray", []));
    const pairs: Array<[JdwpValue, JdwpValue]> = [];
    for (const entry of entries) {
      const remote: Remote = { remote: true, tag: entry.tag, value: entry.value as bigint };
      const key = await host.invoke(remote, "getKey", []);
      const value = await host.invoke(remote, "getValue", []);
      pairs.push([this.toJdwp(key), this.toJdwp(value)]);
    }
    return pairs;
  }

  private toJdwp(value: Value): JdwpValue {
    if (isRemote(value)) return { tag: value.tag, value: value.value };
    if (value === null) return { tag: "L", value: null };
    throw new Error("not a debuggee value");
  }

  private async variable(name: string, value: JdwpValue, thread: bigint, context: bigint, signature: string, evaluateName?: string): Promise<unknown> {
    const rendered = await this.render(value, thread, context, signature);
    return {
      name,
      value: rendered.text,
      type: rendered.type,
      variablesReference: rendered.reference ?? 0,
      indexedVariables: rendered.indexed,
      evaluateName,
      presentationHint: name === "this" ? { kind: "virtual" } : { attributes: ["readOnly"] }
    };
  }

  // The text `print` would show for the value, and a reference when it has parts worth expanding.
  private async render(value: JdwpValue, thread: bigint, context: bigint, declared: string): Promise<{ text: string; type: string; reference?: number; indexed?: number }> {
    if (value.value === null) return { text: "nil", type: typeDisplayName(declared) };
    if (typeof value.value !== "bigint" || "BZCSIJFD".includes(value.tag)) {
      return { text: value.tag === "C" ? JSON.stringify(String.fromCharCode(Number(value.value))) : String(value.value), type: typeDisplayName(value.tag) };
    }
    const objectId = value.value;
    const runtime = await this.typeOf(objectId);
    const signature = runtime.signature;
    let text: string;
    try {
      text = await this.show(objectId, thread, context);
    } catch {
      text = typeDisplayName(signature);
    }
    const felidaeClass = this.classes.has(runtime.typeId);
    const type = felidaeClass ? felidaeClassName(signature) : declared !== "Ljava/lang/Object;" && !declared.startsWith("[") && declared.length > 1 ? typeDisplayName(declared) : typeDisplayName(signature);
    let view: "fields" | "list" | "map" | "array" | undefined;
    let indexed: number | undefined;
    if (signature.startsWith("[")) {
      view = "array";
      indexed = await this.conn!.arrayLength(objectId);
    } else if (felidaeClass) {
      view = "fields";
    } else if (await this.implementsType(runtime.typeId, "Ljava/util/Map;")) {
      view = "map";
    } else if (await this.implementsType(runtime.typeId, "Ljava/util/Collection;")) {
      view = "list";
    } else if (!/^Ljava\/lang\/(String|Integer|Long|Short|Byte|Double|Float|Boolean|Character);$/.test(signature) && signature !== "Ljava/util/Optional;") {
      view = "fields"; // a Java object: its fields, as a Java debugger shows them
    }
    if (!view || (view === "array" && indexed === 0)) return { text, type };
    if (view === "fields" && (await this.allFields(runtime.typeId)).length === 0) return { text, type };
    const reference = this.newHandle({ kind: "object", thread, context, objectId, classId: runtime.typeId, view });
    return { text, type, reference, indexed };
  }

  private async renderValue(value: Value, thread: bigint, context: bigint): Promise<{ text: string; type: string; reference?: number; indexed?: number }> {
    if (isRemote(value)) return this.render({ tag: value.tag, value: value.value }, thread, context, "Ljava/lang/Object;");
    return { text: value instanceof Atom ? value.name : formatLocal(value as Local), type: value instanceof Atom ? "Atom" : typeof value === "bigint" ? "long" : typeof value === "string" ? "String" : typeof value === "boolean" ? "boolean" : value === null ? "Any" : Number.isInteger(value) ? "int" : "double" };
  }

  private async findMethod(typeId: bigint, name: string, cache: Map<bigint, bigint>, signature?: string): Promise<bigint> {
    const known = cache.get(typeId);
    if (known !== undefined) return known;
    const found = (await this.conn!.methods(typeId)).find((m) => m.name === name && (!signature || m.signature === signature));
    if (!found) throw new Error("no " + name);
    cache.set(typeId, found.methodId);
    return found.methodId;
  }

  private caughtMethod(context: bigint): Promise<bigint> {
    return this.findMethod(context, "$caught", this.caughtMethods);
  }

  // Calls the generated class's `$show(value, true)` in the stopped VM.
  private async show(objectId: bigint, thread: bigint, context: bigint): Promise<string> {
    const conn = this.conn!;
    const method = await this.findMethod(context, "$show", this.showMethods);
    const result = await conn.invokeStatic(context, thread, method, [{ tag: "L", value: objectId }, { tag: "Z", value: true }]);
    if (result.exception !== null || typeof result.value.value !== "bigint") throw new Error("$show failed");
    return conn.stringValue(result.value.value);
  }

  // ---------------------------------------------------------------- evaluation

  private async topContext(thread: bigint): Promise<bigint> {
    const [top] = await this.conn!.frames(thread);
    return top.location.classId;
  }

  private topEvaluator(thread: bigint): Evaluator {
    return new Evaluator(this.host(thread, undefined, undefined));
  }

  // The stopped program as the evaluator sees it: `frame` (default: the thread's top frame) and its class.
  private host(thread: bigint, givenFrame: Frame | undefined, givenContext: bigint | undefined): EvalHost {
    const conn = this.conn!;
    let framePromise: Promise<Frame | undefined> | undefined;
    const frame = () => (framePromise ??= givenFrame ? Promise.resolve(givenFrame) : conn.frames(thread).then((frames) => frames[0]));
    const context = async () => givenContext ?? (await frame())?.location.classId ?? this.classes.keys().next().value!;
    const remote = (value: JdwpValue): Value => {
      if (value.value === null) return null;
      if (typeof value.value === "bigint" && !"BZCSIJFD".includes(value.tag)) return { remote: true, tag: value.tag, value: value.value };
      if (value.tag === "C") return String.fromCharCode(Number(value.value));
      return value.value as Local;
    };
    const classBySignature = async (signature: string): Promise<bigint | undefined> => (await conn.classesBySignature(signature))[0]?.typeId;
    const boxer = async (box: string, primitive: string, value: JdwpValue): Promise<JdwpValue> => {
      const classId = await classBySignature("Ljava/lang/" + box + ";");
      if (classId === undefined) throw new Error("java.lang." + box + " is not loaded");
      const method = (await conn.methods(classId)).find((m) => m.name === "valueOf" && m.signature === "(" + primitive + ")Ljava/lang/" + box + ";");
      if (!method) throw new Error("no " + box + ".valueOf");
      const result = await conn.invokeStatic(classId, thread, method.methodId, [value]);
      return result.value;
    };
    // A value as an argument of the given parameter type.
    const argument = async (value: Value, parameter: string): Promise<JdwpValue> => {
      if (isRemote(value)) {
        if ("BZCSIJFD".includes(parameter)) {
          const unboxed = await host.unbox(value);
          if (unboxed === undefined) throw new Error("an object where a " + typeDisplayName(parameter) + " is expected");
          return argument(unboxed, parameter);
        }
        return { tag: value.tag, value: value.value };
      }
      if (value === null) return { tag: "L", value: null };
      if ("BCSIJFD".includes(parameter)) {
        if (parameter === "C" && typeof value === "string") return { tag: "C", value: value.charCodeAt(0) };
        if (typeof value !== "number" && typeof value !== "bigint") throw new Error("a " + typeDisplayName(parameter) + " is expected");
        return { tag: parameter, value: parameter === "J" ? BigInt(value) : Number(value) };
      }
      if (parameter === "Z") {
        if (typeof value !== "boolean") throw new Error("a boolean is expected");
        return { tag: "Z", value };
      }
      if (typeof value === "string") return { tag: "s", value: await conn.createString(value) };
      if (typeof value === "boolean") return boxer("Boolean", "Z", { tag: "Z", value });
      if (typeof value === "bigint") return boxer("Long", "J", { tag: "J", value });
      if (typeof value === "number") return Number.isInteger(value) ? boxer("Integer", "I", { tag: "I", value }) : boxer("Double", "D", { tag: "D", value });
      if (value instanceof Atom) {
        const optional = await classBySignature("Ljava/util/Optional;");
        const of = optional === undefined ? undefined : (await conn.methods(optional)).find((m) => m.name === "of");
        if (optional === undefined || !of) throw new Error("java.util.Optional is not loaded");
        return (await conn.invokeStatic(optional, thread, of.methodId, [{ tag: "s", value: await conn.createString(value.name) }])).value;
      }
      throw new Error("cannot pass this value");
    };
    // The method of `typeId` (or a supertype) named `name` that takes `args`.
    const method = async (typeId: bigint, name: string, args: Value[], statics: boolean): Promise<{ owner: bigint; info: MethodInfo; params: string[] }> => {
      const owners = statics ? [typeId] : (await this.typeInfo(typeId)).supers;
      for (const owner of owners) {
        for (const info of await conn.methods(owner)) {
          if (info.name !== name && displayName(info.name) !== name) continue;
          const params = parameterTypes(info.signature);
          if (params.length === args.length) return { owner, info, params };
        }
      }
      throw new Error("No method " + name + " taking " + args.length + " argument(s)");
    };
    const outcome = async (result: { value: JdwpValue; exception: bigint | null }, ctx: bigint): Promise<Value> => {
      if (result.exception !== null) {
        const text = await this.exceptionText({ thread, exception: result.exception, context: ctx, uncaught: false });
        throw new Error("The call threw " + text);
      }
      return remote(result.value);
    };
    const host: EvalHost = {
      variable: async (name) => {
        const current = await frame();
        if (!current) return undefined;
        const visible = await this.visibleVariables(current);
        const entry = visible.find((v) => v.name === name);
        if (entry) return remote((await conn.frameValues(thread, current.frameId, [{ slot: entry.slot, signature: entry.signature }]))[0]);
        const self = visible.find((v) => v.name === "this");
        if (self) {
          const value = (await conn.frameValues(thread, current.frameId, [{ slot: self.slot, signature: self.signature }]))[0];
          if (typeof value.value === "bigint") {
            const field = (await this.allFields((await conn.objectType(value.value)).typeId)).find((f) => f.field.name === name);
            if (field) return remote((await conn.objectFields(value.value, [field.field.fieldId]))[0]);
          }
        }
        const shared = (await this.staticFields(current.location.classId)).find((f) => f.name === name);
        if (shared) return remote((await conn.staticValues(current.location.classId, [shared.fieldId]))[0]);
        return undefined;
      },
      classNamed: async (name) => {
        for (const data of this.classes.values()) {
          if (felidaeClassName(data.signature) === name || typeDisplayName(data.signature) === name) return data.typeId;
        }
        return name.includes(".") ? classBySignature("L" + name.replace(/\./g, "/") + ";") : classBySignature("Ljava/lang/" + name + ";");
      },
      field: async (target, name) => {
        const typeId = (await conn.objectType(target.value as bigint)).typeId;
        const field = (await this.allFields(typeId)).find((f) => f.field.name === name);
        if (field) return remote((await conn.objectFields(target.value as bigint, [field.field.fieldId]))[0]);
        // `xs.len` and other zero-argument members read like fields
        return host.invoke(target, name, []);
      },
      staticField: async (classId, name) => {
        const field = (await conn.fields(classId)).find((f) => f.name === name && (f.modifiers & 0x8));
        if (!field) return host.invokeStatic(classId, name, []);
        return remote((await conn.staticValues(classId, [field.fieldId]))[0]);
      },
      invoke: async (target, name, args) => {
        const runtime = await this.typeOf(target.value as bigint);
        if (runtime.signature.startsWith("[")) {
          if (name === "len" && args.length === 0) return conn.arrayLength(target.value as bigint);
          if (name === "get" && args.length === 1) return host.index(target, Number(args[0]));
          throw new Error("An array has len(), get(pos:) and set(pos:, value:)");
        }
        const found = await method(runtime.typeId, name, args, false);
        const values: JdwpValue[] = [];
        for (let i = 0; i < args.length; i++) values.push(await argument(args[i], found.params[i]));
        return outcome(await conn.invoke(target.value as bigint, thread, found.owner, found.info.methodId, values), await context());
      },
      invokeStatic: async (classId, name, args) => {
        const found = await method(classId, name, args, true);
        const values: JdwpValue[] = [];
        for (let i = 0; i < args.length; i++) values.push(await argument(args[i], found.params[i]));
        return outcome(await conn.invokeStatic(classId, thread, found.info.methodId, values), await context());
      },
      index: async (target, index) => {
        const runtime = await this.typeOf(target.value as bigint);
        if (runtime.signature.startsWith("[")) {
          const length = await conn.arrayLength(target.value as bigint);
          if (index < 0 || index >= length) throw new Error("Index " + index + " out of bounds for length " + length);
          return remote((await conn.arrayValues(target.value as bigint, index, 1))[0]);
        }
        return host.invoke(target, "get", [index]);
      },
      unbox: async (value) => {
        const objectId = value.value as bigint;
        const signature = (await this.typeOf(objectId)).signature;
        if (signature === "Ljava/lang/String;") return conn.stringValue(objectId);
        if (signature === "Ljava/util/Optional;") {
          const inner = await host.invoke(value, "get", []);
          return isRemote(inner) ? new Atom(await conn.stringValue(inner.value as bigint)) : null;
        }
        const box = /^Ljava\/lang\/(Integer|Long|Short|Byte|Double|Float|Boolean|Character);$/.exec(signature);
        if (!box) return undefined;
        const typeId = (await conn.objectType(objectId)).typeId;
        const field = (await conn.fields(typeId)).find((f) => f.name === "value");
        if (!field) return undefined;
        const raw = (await conn.objectFields(objectId, [field.fieldId]))[0];
        return raw.tag === "C" ? String.fromCharCode(Number(raw.value)) : (raw.value as Local);
      },
      equals: async (a, b) => {
        const unboxed = await host.unbox(a);
        if (unboxed !== undefined && !isRemote(b)) {
          if (unboxed instanceof Atom || b instanceof Atom) return unboxed instanceof Atom && b instanceof Atom && unboxed.name === b.name;
          return unboxed === b || (typeof unboxed === "number" && typeof b === "number" && unboxed === b);
        }
        const result = await host.invoke(a, "equals", [b]);
        return result === true;
      }
    };
    return host;
  }

  private async evaluate(args: any): Promise<unknown> {
    const found = args.frameId !== undefined ? this.frames.get(args.frameId) : undefined;
    const thread = found?.thread ?? this.stoppedThread;
    if (thread === undefined || !this.conn) throw new Error("The program is not stopped");
    const expression = String(args.expression ?? "").trim();
    const context = found?.frame.location.classId ?? (await this.topContext(thread));
    const evaluator = new Evaluator(this.host(thread, found?.frame, context));
    const value = await evaluator.evaluate(expression);
    const rendered = await this.renderValue(value, thread, context);
    return { result: rendered.text, type: rendered.type, variablesReference: rendered.reference ?? 0, indexedVariables: rendered.indexed };
  }

  // Debug-console completion: the names in scope, or the members of the value before a dot.
  private async completions(args: any): Promise<unknown> {
    const found = args.frameId !== undefined ? this.frames.get(args.frameId) : undefined;
    const thread = found?.thread ?? this.stoppedThread;
    if (thread === undefined || !this.conn) return { targets: [] };
    const text = String(args.text ?? "").slice(0, Number(args.column ?? 1) - 1);
    const member = /([A-Za-z_$][\w$.]*)\.([A-Za-z_$][\w$]*)?$/.exec(text);
    const targets: Array<{ label: string; type: string }> = [];
    const seen = new Set<string>();
    const add = (label: string, type: string) => {
      if (!label.startsWith("$") && !seen.has(label)) {
        seen.add(label);
        targets.push({ label, type });
      }
    };
    const context = found?.frame.location.classId ?? (await this.topContext(thread));
    if (member) {
      try {
        const evaluator = new Evaluator(this.host(thread, found?.frame, context));
        const value = await evaluator.evaluate(member[1]);
        if (isRemote(value) && typeof value.value === "bigint") {
          const runtime = await this.typeOf(value.value);
          for (const field of await this.allFields(runtime.typeId)) add(field.field.name, "field");
          for (const owner of runtime.supers) {
            for (const method of await this.conn.methods(owner)) if (!method.name.startsWith("<")) add(displayName(method.name), "method");
          }
        }
      } catch {
        // nothing to complete
      }
      return { targets };
    }
    const frame = found?.frame ?? (await this.conn.frames(thread))[0];
    for (const variable of await this.visibleVariables(frame)) add(variable.name, "variable");
    for (const field of await this.staticFields(frame.location.classId)) add(field.name, "field");
    for (const data of this.classes.values()) add(felidaeClassName(data.signature), "class");
    return { targets };
  }
}
