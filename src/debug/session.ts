// The Felidae debug adapter: Debug Adapter Protocol on one side, the JVM's JDWP on the other.
//
// `felidae --debug --port 0 program.fx` compiles the program and starts its JVM suspended with a JDWP agent; the
// generated classes carry SourceFile, LineNumberTable and LocalVariableTable attributes (written by the compiler), so
// breakpoints on `.fx` lines, the stack, and the locals under their Felidae names all come from the VM. Values are
// rendered by the program's own `$show` (the text `print` would give), called in the stopped VM.
//
// No vscode import: the session takes and emits plain DAP messages, so it can be tested without VS Code.

import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  EventKind,
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
  sourceFile: string;
  methods: Map<bigint, MethodData>;
}

interface Breakpoint {
  id: number;
  sourceName: string;
  requestedLine: number;
  line: number;
  // The JDWP requests that implement it: one per class that has code at (or around) the line.
  requestIds: number[];
  classes: Set<bigint>;
}

type Handle =
  | { kind: "scope"; thread: bigint; frame: Frame }
  | { kind: "object"; thread: bigint; objectId: bigint; classId: bigint };

// Classes the debugger never steps into: the embedded fact store and list helpers, and the JDK.
const STEP_EXCLUDES = ["felidae_*", "java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "com.tidesdb.*", "com.fasterxml.*"];

const LISTENING = /Listening for transport dt_socket at address:\s*(\d+)/;

/** `twice$k` (a method with named parameters) and `add$1` (an overload) are shown as `twice` and `add`. */
export function displayName(jvmName: string): string {
  const dollar = jvmName.indexOf("$", 1);
  return jvmName.startsWith("$") || dollar < 0 ? jvmName : jvmName.slice(0, dollar);
}

/** `Ldbg$Box;` -> `dbg$Box`, `Ljava/lang/Integer;` -> `Integer`. */
export function typeDisplayName(signature: string): string {
  if (signature.startsWith("[")) return typeDisplayName(signature.slice(1)) + "[]";
  const names: Record<string, string> = { B: "byte", C: "char", D: "double", F: "float", I: "int", J: "long", S: "short", Z: "boolean", V: "void" };
  if (names[signature]) return names[signature];
  const name = signature.replace(/^L/, "").replace(/;$/, "");
  if (name === "java/util/Optional") return "Atom";
  return name.slice(name.lastIndexOf("/") + 1);
}

export class FelidaeDebugSession {
  private seq = 1;
  private conn?: JdwpConnection;
  private proc?: childProcess.ChildProcess;
  private program = "";
  private sourceDirs: string[] = [];
  private stopOnEntry = false;
  private entryRequest?: number;
  private terminated = false;

  private classes = new Map<bigint, ClassData>();
  private breakpoints = new Map<number, Breakpoint>();
  private bySource = new Map<string, number[]>();
  private nextBreakpointId = 1;
  private requestToBreakpoint = new Map<number, Breakpoint>();

  private threadIds = new Map<bigint, number>();
  private threadById = new Map<number, bigint>();
  private stoppedThread?: bigint;
  private frames = new Map<number, { thread: bigint; frame: Frame }>();
  private handles = new Map<number, Handle>();
  private nextHandle = 1;
  private stepRequest?: number;
  private sourceCache = new Map<string, string | undefined>();
  private showMethods = new Map<bigint, bigint>();

  private events: Promise<void> = Promise.resolve();

  constructor(private readonly emit: (message: DapMessage) => void) {}

  // ---------------------------------------------------------------- DAP plumbing

  async handleMessage(message: DapMessage): Promise<void> {
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

  private output(text: string, category: "stdout" | "stderr" | "console" = "stdout"): void {
    if (text.length > 0) this.event("output", { category, output: text });
  }

  private async dispatch(command: string, args: any): Promise<unknown> {
    switch (command) {
      case "initialize":
        return {
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportsTerminateRequest: true,
          supportTerminateDebuggee: true
        };
      case "launch": return this.launch(args);
      case "attach": return this.attach(args);
      case "setBreakpoints": return this.setBreakpoints(args);
      case "setExceptionBreakpoints": return {};
      case "configurationDone": return this.configurationDone();
      case "threads": return this.threads();
      case "stackTrace": return this.stackTrace(args);
      case "scopes": return this.scopes(args);
      case "variables": return this.variables(args);
      case "evaluate": return this.evaluate(args);
      case "continue": await this.resume(); return { allThreadsContinued: true };
      case "next": return this.step(args, STEP_OVER);
      case "stepIn": return this.step(args, STEP_INTO);
      case "stepOut": return this.step(args, STEP_OUT);
      case "pause": return this.pause();
      case "terminate":
      case "disconnect": return this.disconnect();
      default: throw new Error("Unsupported request: " + command);
    }
  }

  // ---------------------------------------------------------------- launch

  private async launch(args: any): Promise<unknown> {
    this.program = path.resolve(String(args.program));
    this.stopOnEntry = args.stopOnEntry === true;
    this.sourceDirs = [path.dirname(this.program), ...((args.sourceDirs as string[] | undefined) ?? [])];
    const interpreter = String(args.interpreterPath ?? "felidae");
    const debugArguments = ["--debug", "--port", "0"];
    if (args.classpath) debugArguments.push("--classpath", String(args.classpath));
    debugArguments.push(this.program, ...((args.args as string[] | undefined) ?? []));
    const [command, commandArguments] = interpreter.endsWith(".jar")
      ? [String(args.javaPath ?? "java"), ["-jar", interpreter, ...debugArguments]]
      : [interpreter, debugArguments];

    const port = await new Promise<number>((resolve, reject) => {
      const child = childProcess.spawn(command, commandArguments, { cwd: args.cwd ?? path.dirname(this.program) });
      this.proc = child;
      let found = false;
      let errors = "";
      const buffers = { out: "", err: "" };
      const lines = (stream: "out" | "err", chunk: Buffer) => {
        buffers[stream] += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffers[stream].indexOf("\n")) >= 0) {
          const line = buffers[stream].slice(0, newline + 1);
          buffers[stream] = buffers[stream].slice(newline + 1);
          const match = LISTENING.exec(line);
          if (match && !found) {
            found = true;
            resolve(Number(match[1]));
          } else if (!match) {
            if (!found && stream === "err") errors += line;
            this.output(line, stream === "out" ? "stdout" : "stderr");
          }
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => lines("out", chunk));
      child.stderr?.on("data", (chunk: Buffer) => lines("err", chunk));
      child.on("error", (error) => reject(new Error("Cannot start " + command + ": " + error.message)));
      child.on("exit", (code) => {
        if (!found) reject(new Error(errors.trim() || "felidae exited with status " + code + " before the program started"));
        else this.finish();
      });
    });
    await this.connect("127.0.0.1", port);
    this.event("initialized");
    return {};
  }

  // Attach to a program that was started with `felidae --debug`.
  private async attach(args: any): Promise<unknown> {
    this.program = args.program ? path.resolve(String(args.program)) : "";
    this.sourceDirs = [...((args.sourceDirs as string[] | undefined) ?? []), ...(this.program ? [path.dirname(this.program)] : [])];
    this.stopOnEntry = args.stopOnEntry === true;
    await this.connect(String(args.host ?? "127.0.0.1"), Number(args.port));
    this.event("initialized");
    return {};
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
    // Classes already loaded (attaching to a running program): a class from a .fx file has no package.
    for (const loaded of await conn.allClasses()) {
      if (!loaded.signature.includes("/")) await this.loadClass(loaded.typeId);
    }
  }

  private finish(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.event("terminated");
  }

  private async configurationDone(): Promise<unknown> {
    await this.conn!.resume();
    return {};
  }

  private async disconnect(): Promise<unknown> {
    const conn = this.conn;
    const child = this.proc;
    this.conn = undefined;
    if (conn) {
      try {
        if (child) await Promise.race([conn.exit(0), new Promise((resolve) => setTimeout(resolve, 1000))]);
      } catch {
        // the VM is already gone
      }
      conn.destroy();
    }
    if (child && child.exitCode === null) setTimeout(() => child.kill(), 1500).unref();
    this.finish();
    return {};
  }

  // ---------------------------------------------------------------- classes and breakpoints

  private async loadClass(typeId: bigint): Promise<ClassData | undefined> {
    const known = this.classes.get(typeId);
    if (known) return known;
    const conn = this.conn!;
    const sourceFile = await conn.sourceFile(typeId);
    if (!sourceFile || !sourceFile.endsWith(".fx")) return undefined;
    const data: ClassData = { typeId, signature: await conn.signature(typeId), sourceFile, methods: new Map() };
    for (const info of await conn.methods(typeId)) {
      const lines = (await conn.lineTable(typeId, info.methodId)).sort((a, b) => (a.codeIndex < b.codeIndex ? -1 : a.codeIndex > b.codeIndex ? 1 : 0));
      data.methods.set(info.methodId, { info, lines });
    }
    this.classes.set(typeId, data);
    return data;
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

  // Sets the breakpoint in every loaded class of its file (or just `only`); true once any class holds it.
  private async installBreakpoint(breakpoint: Breakpoint, only?: ClassData): Promise<boolean> {
    if (!this.conn) return breakpoint.requestIds.length > 0;
    for (const data of only ? [only] : this.classes.values()) {
      if (data.sourceFile !== breakpoint.sourceName || breakpoint.classes.has(data.typeId)) continue;
      const found = this.resolveIn(data, breakpoint.requestedLine);
      if (!found) continue;
      const requestId = await this.conn.setEvent(EventKind.Breakpoint, SuspendPolicy.All, [this.conn.locationModifier(found.location)]);
      breakpoint.classes.add(data.typeId);
      if (breakpoint.requestIds.length === 0) breakpoint.line = found.line;
      breakpoint.requestIds.push(requestId);
      this.requestToBreakpoint.set(requestId, breakpoint);
    }
    return breakpoint.requestIds.length > 0;
  }

  private async setBreakpoints(args: any): Promise<unknown> {
    const sourceName = path.basename(String(args.source?.path ?? args.source?.name ?? ""));
    for (const id of this.bySource.get(sourceName) ?? []) {
      const old = this.breakpoints.get(id);
      for (const requestId of old?.requestIds ?? []) {
        await this.conn?.clearEvent(EventKind.Breakpoint, requestId).catch(() => undefined);
        this.requestToBreakpoint.delete(requestId);
      }
      this.breakpoints.delete(id);
    }
    const requested: Array<{ line: number }> = args.breakpoints ?? (args.lines ?? []).map((line: number) => ({ line }));
    const ids: number[] = [];
    const result: Array<{ id: number; verified: boolean; line: number }> = [];
    for (const item of requested) {
      const breakpoint: Breakpoint = { id: this.nextBreakpointId++, sourceName, requestedLine: item.line, line: item.line, requestIds: [], classes: new Set() };
      this.breakpoints.set(breakpoint.id, breakpoint);
      ids.push(breakpoint.id);
      const verified = await this.installBreakpoint(breakpoint);
      result.push({ id: breakpoint.id, verified, line: breakpoint.line });
    }
    this.bySource.set(sourceName, ids);
    return { breakpoints: result };
  }

  // ---------------------------------------------------------------- events

  private async onEvents(policy: number, events: JdwpEvent[]): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    let stop: { thread: bigint; reason: string; description?: string } | undefined;
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
            stop = { thread: event.thread!, reason: "breakpoint" };
          } else if (event.requestId === this.entryRequest) {
            await conn.clearEvent(EventKind.Breakpoint, event.requestId).catch(() => undefined);
            this.entryRequest = undefined;
            stop ??= { thread: event.thread!, reason: "entry" };
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
          const method = this.classes.get(location.classId)?.methods.get(location.methodId);
          if (method && method.lines.length > 0) stop = { thread: event.thread!, reason: "step" };
          else resume = true;
          break;
        }
        case EventKind.VmDeath:
          this.finish();
          return;
        default:
          break;
      }
    }
    if (stop) {
      this.stoppedThread = stop.thread;
      this.frames.clear();
      this.handles.clear();
      this.event("stopped", { reason: stop.reason, threadId: this.threadId(stop.thread), allThreadsStopped: true, description: stop.description });
    } else if (resume) {
      await conn.resume().catch(() => undefined);
    }
  }

  // A class compiled from a .fx file has loaded: set the breakpoints waiting for it, and the entry stop.
  private async classPrepared(data: ClassData): Promise<void> {
    for (const id of this.bySource.get(data.sourceFile) ?? []) {
      const breakpoint = this.breakpoints.get(id)!;
      const wasVerified = breakpoint.requestIds.length > 0;
      if ((await this.installBreakpoint(breakpoint, data)) && !wasVerified) {
        this.event("breakpoint", { reason: "changed", breakpoint: { id: breakpoint.id, verified: true, line: breakpoint.line } });
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
  }

  // ---------------------------------------------------------------- running

  private invalidate(): void {
    this.frames.clear();
    this.handles.clear();
    this.stoppedThread = undefined;
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

  // ---------------------------------------------------------------- stack and variables

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
    const conn = this.conn!;
    const result: Array<{ id: number; name: string }> = [];
    for (const thread of await conn.allThreads()) {
      result.push({ id: this.threadId(thread), name: await conn.threadName(thread).catch(() => "thread") });
    }
    return { threads: result };
  }

  private findSource(name: string): string | undefined {
    if (this.sourceCache.has(name)) return this.sourceCache.get(name);
    let found: string | undefined;
    const search = (directory: string, depth: number): void => {
      if (found || depth < 0) return;
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) { found = candidate; return; }
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") search(path.join(directory, entry.name), depth - 1);
      }
    };
    for (const directory of this.sourceDirs) search(directory, 8); // a package puts a file several folders deep
    this.sourceCache.set(name, found);
    return found;
  }

  private async stackTrace(args: any): Promise<unknown> {
    const thread = this.threadById.get(args.threadId) ?? this.stoppedThread;
    if (thread === undefined) return { stackFrames: [], totalFrames: 0 };
    const stackFrames: unknown[] = [];
    for (const frame of await this.conn!.frames(thread)) {
      const data = this.classes.get(frame.location.classId) ?? (await this.loadClass(frame.location.classId));
      const method = data?.methods.get(frame.location.methodId);
      if (!data || !method || method.lines.length === 0) continue; // generated plumbing
      const line = this.lineAt(method, frame.location.index) ?? method.lines[0].line;
      const id = 1000 + this.frames.size;
      this.frames.set(id, { thread, frame });
      const owner = typeDisplayName(data.signature);
      const sourcePath = this.findSource(data.sourceFile);
      stackFrames.push({
        id,
        name: (owner === path.basename(data.sourceFile, ".fx") ? "" : owner.slice(owner.lastIndexOf("$") + 1) + ".") + displayName(method.info.name),
        source: { name: data.sourceFile, path: sourcePath },
        line,
        column: 1
      });
    }
    return { stackFrames, totalFrames: stackFrames.length };
  }

  private scopes(args: any): unknown {
    const found = this.frames.get(args.frameId);
    if (!found) return { scopes: [] };
    const handle = this.nextHandle++;
    this.handles.set(handle, { kind: "scope", thread: found.thread, frame: found.frame });
    return { scopes: [{ name: "Locals", variablesReference: handle, expensive: false }] };
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

  private async variables(args: any): Promise<unknown> {
    const handle = this.handles.get(args.variablesReference);
    if (!handle) return { variables: [] };
    const conn = this.conn!;
    const variables: unknown[] = [];
    if (handle.kind === "scope") {
      const visible = await this.visibleVariables(handle.frame);
      if (visible.length === 0) return { variables: [] };
      const values = await conn.frameValues(handle.thread, handle.frame.frameId, visible.map((v) => ({ slot: v.slot, signature: v.signature })));
      for (let i = 0; i < visible.length; ++i) {
        variables.push(await this.variable(visible[i].name, values[i], handle.thread, handle.frame.location.classId, visible[i].signature));
      }
    } else {
      const fields = (await conn.fields(handle.classId)).filter((f) => !(f.modifiers & 0x8) && !f.name.startsWith("$"));
      const values = await conn.objectFields(handle.objectId, fields.map((f) => f.fieldId));
      for (let i = 0; i < fields.length; ++i) {
        variables.push(await this.variable(fields[i].name, values[i], handle.thread, handle.classId, fields[i].signature));
      }
    }
    return { variables };
  }

  private async variable(name: string, value: JdwpValue, thread: bigint, context: bigint, signature: string): Promise<unknown> {
    const rendered = await this.render(value, thread, context, signature);
    return { name, value: rendered.text, type: rendered.type, variablesReference: rendered.reference ?? 0 };
  }

  // The text `print` would show for the value, and a reference when it is an object of a Felidae class.
  private async render(value: JdwpValue, thread: bigint, context: bigint, declared: string): Promise<{ text: string; type: string; reference?: number }> {
    if (value.value === null) return { text: "nil", type: typeDisplayName(declared) };
    if (typeof value.value !== "bigint" || !"Ls[tgl".includes(value.tag)) {
      return { text: value.tag === "C" ? String.fromCharCode(Number(value.value)) : String(value.value), type: typeDisplayName(value.tag) };
    }
    const conn = this.conn!;
    const objectId = value.value;
    const objectType = await conn.objectType(objectId);
    const signature = await conn.signature(objectType.typeId);
    let text: string;
    try {
      text = await this.show(objectId, thread, context);
    } catch {
      text = typeDisplayName(signature);
    }
    const felidaeClass = !signature.startsWith("Ljava/") && !signature.startsWith("[");
    if (!felidaeClass) return { text, type: typeDisplayName(signature) };
    const reference = this.nextHandle++;
    this.handles.set(reference, { kind: "object", thread, objectId, classId: objectType.typeId });
    return { text, type: typeDisplayName(signature), reference };
  }

  // Calls the generated class's `$show(value, true)` in the stopped VM.
  private async show(objectId: bigint, thread: bigint, context: bigint): Promise<string> {
    const conn = this.conn!;
    let method = this.showMethods.get(context);
    if (method === undefined) {
      const found = (await conn.methods(context)).find((m) => m.name === "$show");
      if (!found) throw new Error("no $show");
      method = found.methodId;
      this.showMethods.set(context, method);
    }
    const w = conn.w().referenceType(context).object(thread).method(method).i32(2);
    w.u8("L".charCodeAt(0)).object(objectId);
    w.u8("Z".charCodeAt(0)).u8(1);
    w.i32(0);
    const r = await conn.send(3, 3, w.build());
    const result = r.value();
    const exception = r.value();
    if (exception.value !== null || typeof result.value !== "bigint") throw new Error("$show failed");
    return conn.stringValue(result.value);
  }

  private async evaluate(args: any): Promise<unknown> {
    const found = this.frames.get(args.frameId);
    const expression = String(args.expression ?? "").trim();
    if (!found || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) {
      throw new Error("Only the name of a variable can be evaluated");
    }
    const visible = await this.visibleVariables(found.frame);
    const index = visible.findIndex((v) => v.name === expression);
    if (index < 0) throw new Error("'" + expression + "' is not in scope");
    const values = await this.conn!.frameValues(found.thread, found.frame.frameId, [{ slot: visible[index].slot, signature: visible[index].signature }]);
    const rendered = await this.render(values[0], found.thread, found.frame.location.classId, visible[index].signature);
    return { result: rendered.text, type: rendered.type, variablesReference: rendered.reference ?? 0 };
  }
}
