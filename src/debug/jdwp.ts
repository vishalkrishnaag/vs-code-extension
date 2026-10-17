// A minimal JDWP (Java Debug Wire Protocol) client: just the commands the Felidae debugger needs.
//
// `felidae --debug program.fx` starts the program's JVM suspended with a JDWP agent listening on a port. The compiler
// writes a SourceFile attribute, a LineNumberTable and a LocalVariableTable into every class it generates, so
// everything the debugger shows (files, lines, names) comes from the VM itself. No vscode import: unit-testable.

import * as net from "net";

export interface IdSizes {
  field: number;
  method: number;
  object: number;
  referenceType: number;
  frame: number;
}

export const enum EventKind {
  SingleStep = 1,
  Breakpoint = 2,
  ClassPrepare = 8,
  VmStart = 90,
  VmDeath = 99
}

export const enum SuspendPolicy {
  None = 0,
  EventThread = 1,
  All = 2
}

export interface Location {
  typeTag: number;
  classId: bigint;
  methodId: bigint;
  index: bigint;
}

export interface JdwpEvent {
  kind: number;
  requestId: number;
  thread?: bigint;
  location?: Location;
  // ClassPrepare
  typeTag?: number;
  typeId?: bigint;
  signature?: string;
}

export interface JdwpValue {
  tag: string;
  // A primitive's value, a string/object id, or null for a null reference.
  value: bigint | number | boolean | string | null;
}

export interface LineEntry {
  codeIndex: bigint;
  line: number;
}

export interface VariableEntry {
  codeIndex: bigint;
  name: string;
  signature: string;
  length: number;
  slot: number;
}

export interface Frame {
  frameId: bigint;
  location: Location;
}

export interface MethodInfo {
  methodId: bigint;
  name: string;
  signature: string;
}

export interface FieldInfo {
  fieldId: bigint;
  name: string;
  signature: string;
  modifiers: number;
}

export class Writer {
  private chunks: Buffer[] = [];
  constructor(private readonly sizes?: IdSizes) {}
  u8(value: number): this { const b = Buffer.alloc(1); b.writeUInt8(value); this.chunks.push(b); return this; }
  i32(value: number): this { const b = Buffer.alloc(4); b.writeInt32BE(value); this.chunks.push(b); return this; }
  u64(value: bigint): this { const b = Buffer.alloc(8); b.writeBigUInt64BE(value); this.chunks.push(b); return this; }
  string(value: string): this {
    const bytes = Buffer.from(value, "utf8");
    this.i32(bytes.length);
    this.chunks.push(bytes);
    return this;
  }
  id(value: bigint, size: number): this {
    const b = Buffer.alloc(size);
    for (let i = size - 1, v = value; i >= 0; --i, v >>= 8n) b[i] = Number(v & 0xffn);
    this.chunks.push(b);
    return this;
  }
  object(value: bigint): this { return this.id(value, this.sizes!.object); }
  referenceType(value: bigint): this { return this.id(value, this.sizes!.referenceType); }
  method(value: bigint): this { return this.id(value, this.sizes!.method); }
  frame(value: bigint): this { return this.id(value, this.sizes!.frame); }
  location(value: Location): this {
    return this.u8(value.typeTag).referenceType(value.classId).method(value.methodId).u64(value.index);
  }
  build(): Buffer { return Buffer.concat(this.chunks); }
}

export class Reader {
  pos = 0;
  constructor(private readonly buffer: Buffer, private readonly sizes?: IdSizes) {}
  u8(): number { const v = this.buffer.readUInt8(this.pos); this.pos += 1; return v; }
  i32(): number { const v = this.buffer.readInt32BE(this.pos); this.pos += 4; return v; }
  i64(): bigint { const v = this.buffer.readBigInt64BE(this.pos); this.pos += 8; return v; }
  u64(): bigint { const v = this.buffer.readBigUInt64BE(this.pos); this.pos += 8; return v; }
  string(): string {
    const length = this.i32();
    const v = this.buffer.toString("utf8", this.pos, this.pos + length);
    this.pos += length;
    return v;
  }
  id(size: number): bigint {
    let v = 0n;
    for (let i = 0; i < size; ++i) v = (v << 8n) | BigInt(this.buffer[this.pos + i]);
    this.pos += size;
    return v;
  }
  object(): bigint { return this.id(this.sizes!.object); }
  referenceType(): bigint { return this.id(this.sizes!.referenceType); }
  method(): bigint { return this.id(this.sizes!.method); }
  field(): bigint { return this.id(this.sizes!.field); }
  frame(): bigint { return this.id(this.sizes!.frame); }
  location(): Location {
    return { typeTag: this.u8(), classId: this.referenceType(), methodId: this.method(), index: this.u64() };
  }
  // A tagged value: one tag byte, then a value whose width the tag decides.
  value(tag?: number): JdwpValue {
    const t = tag ?? this.u8();
    const c = String.fromCharCode(t);
    switch (c) {
      case "B": { const v = this.buffer.readInt8(this.pos); this.pos += 1; return { tag: c, value: v }; }
      case "Z": return { tag: c, value: this.u8() !== 0 };
      case "C": { const v = this.buffer.readUInt16BE(this.pos); this.pos += 2; return { tag: c, value: v }; }
      case "S": { const v = this.buffer.readInt16BE(this.pos); this.pos += 2; return { tag: c, value: v }; }
      case "I": return { tag: c, value: this.i32() };
      case "J": return { tag: c, value: this.i64() };
      case "F": { const v = this.buffer.readFloatBE(this.pos); this.pos += 4; return { tag: c, value: v }; }
      case "D": { const v = this.buffer.readDoubleBE(this.pos); this.pos += 8; return { tag: c, value: v }; }
      case "V": return { tag: c, value: null };
      default: {
        const id = this.object();
        return { tag: c, value: id === 0n ? null : id };
      }
    }
  }
  remaining(): number { return this.buffer.length - this.pos; }
}

interface Pending {
  resolve: (reader: Reader) => void;
  reject: (error: Error) => void;
}

const HANDSHAKE = Buffer.from("JDWP-Handshake", "ascii");

export class JdwpConnection {
  sizes: IdSizes = { field: 8, method: 8, object: 8, referenceType: 8, frame: 8 };
  onEvents?: (policy: number, events: JdwpEvent[]) => void;
  onClose?: () => void;

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private closed = false;

  private constructor(private readonly socket: net.Socket) {}

  static connect(host: string, port: number): Promise<JdwpConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host);
      const connection = new JdwpConnection(socket);
      socket.setNoDelay(true);
      socket.once("error", reject);
      socket.on("data", (data) => connection.receive(data, () => resolve(connection)));
      socket.on("close", () => connection.close());
      socket.once("connect", () => socket.write(HANDSHAKE));
    }).then(async (connection) => {
      const c = connection as JdwpConnection;
      const sizes = await c.send(1, 7);
      c.sizes = { field: sizes.i32(), method: sizes.i32(), object: sizes.i32(), referenceType: sizes.i32(), frame: sizes.i32() };
      return c;
    });
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("The debuggee disconnected"));
    this.pending.clear();
    this.onClose?.();
  }

  private receive(data: Buffer, handshaken: () => void): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (!this.handshakeDone) {
      if (this.buffer.length < HANDSHAKE.length) return;
      this.buffer = this.buffer.subarray(HANDSHAKE.length);
      this.handshakeDone = true;
      handshaken();
    }
    while (this.buffer.length >= 11) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < length) return;
      const id = this.buffer.readUInt32BE(4);
      const flags = this.buffer.readUInt8(8);
      const packet = this.buffer.subarray(11, length);
      const header = this.buffer.subarray(9, 11);
      this.buffer = this.buffer.subarray(length);
      if (flags & 0x80) {
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        const errorCode = header.readUInt16BE(0);
        if (errorCode !== 0) pending.reject(new Error("JDWP error " + errorCode));
        else pending.resolve(new Reader(packet, this.sizes));
      } else if (header[0] === 64 && header[1] === 100) {
        this.composite(new Reader(packet, this.sizes));
      }
    }
  }

  private composite(reader: Reader): void {
    const policy = reader.u8();
    const count = reader.i32();
    const events: JdwpEvent[] = [];
    for (let i = 0; i < count; ++i) {
      const kind = reader.u8();
      const requestId = reader.i32();
      const event: JdwpEvent = { kind, requestId };
      switch (kind) {
        case EventKind.VmStart: event.thread = reader.object(); break;
        case EventKind.SingleStep:
        case EventKind.Breakpoint:
        case 40:
        case 41:
          event.thread = reader.object();
          event.location = reader.location();
          break;
        case EventKind.ClassPrepare:
          event.thread = reader.object();
          event.typeTag = reader.u8();
          event.typeId = reader.referenceType();
          event.signature = reader.string();
          reader.i32();
          break;
        case 6:
        case 7:
          event.thread = reader.object();
          break;
        case EventKind.VmDeath: break;
        default: break; // an event kind this client never asks for
      }
      events.push(event);
    }
    this.onEvents?.(policy, events);
  }

  send(commandSet: number, command: number, data: Buffer = Buffer.alloc(0)): Promise<Reader> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error("The debuggee disconnected")); return; }
      const id = this.nextId++;
      const header = Buffer.alloc(11);
      header.writeUInt32BE(11 + data.length, 0);
      header.writeUInt32BE(id, 4);
      header.writeUInt8(0, 8);
      header.writeUInt8(commandSet, 9);
      header.writeUInt8(command, 10);
      this.pending.set(id, { resolve, reject });
      this.socket.write(Buffer.concat([header, data]));
    });
  }

  w(): Writer { return new Writer(this.sizes); }

  destroy(): void {
    this.socket.destroy();
  }

  // ---- VirtualMachine ------------------------------------------------------

  resume(): Promise<Reader> { return this.send(1, 9); }
  suspend(): Promise<Reader> { return this.send(1, 8); }
  exit(code: number): Promise<Reader> { return this.send(1, 10, this.w().i32(code).build()); }

  async classesBySignature(signature: string): Promise<Array<{ typeTag: number; typeId: bigint }>> {
    const r = await this.send(1, 2, this.w().string(signature).build());
    const n = r.i32();
    const result: Array<{ typeTag: number; typeId: bigint }> = [];
    for (let i = 0; i < n; ++i) {
      const typeTag = r.u8();
      const typeId = r.referenceType();
      r.i32();
      result.push({ typeTag, typeId });
    }
    return result;
  }

  async allClasses(): Promise<Array<{ typeTag: number; typeId: bigint; signature: string }>> {
    const r = await this.send(1, 3);
    const n = r.i32();
    const result: Array<{ typeTag: number; typeId: bigint; signature: string }> = [];
    for (let i = 0; i < n; ++i) {
      const typeTag = r.u8();
      const typeId = r.referenceType();
      const signature = r.string();
      r.i32();
      result.push({ typeTag, typeId, signature });
    }
    return result;
  }

  async allThreads(): Promise<bigint[]> {
    const r = await this.send(1, 4);
    const n = r.i32();
    const result: bigint[] = [];
    for (let i = 0; i < n; ++i) result.push(r.object());
    return result;
  }

  // ---- ReferenceType -------------------------------------------------------

  async sourceFile(typeId: bigint): Promise<string | undefined> {
    try {
      return (await this.send(2, 7, this.w().referenceType(typeId).build())).string();
    } catch {
      return undefined; // ABSENT_INFORMATION: a class without a SourceFile
    }
  }

  async signature(typeId: bigint): Promise<string> {
    return (await this.send(2, 1, this.w().referenceType(typeId).build())).string();
  }

  async methods(typeId: bigint): Promise<MethodInfo[]> {
    const r = await this.send(2, 5, this.w().referenceType(typeId).build());
    const n = r.i32();
    const result: MethodInfo[] = [];
    for (let i = 0; i < n; ++i) {
      const methodId = r.method();
      const name = r.string();
      const signature = r.string();
      r.i32();
      result.push({ methodId, name, signature });
    }
    return result;
  }

  async fields(typeId: bigint): Promise<FieldInfo[]> {
    const r = await this.send(2, 4, this.w().referenceType(typeId).build());
    const n = r.i32();
    const result: FieldInfo[] = [];
    for (let i = 0; i < n; ++i) {
      result.push({ fieldId: r.field(), name: r.string(), signature: r.string(), modifiers: r.i32() });
    }
    return result;
  }

  async superclass(typeId: bigint): Promise<bigint> {
    return (await this.send(3, 1, this.w().referenceType(typeId).build())).referenceType();
  }

  // ---- Method --------------------------------------------------------------

  async lineTable(typeId: bigint, methodId: bigint): Promise<LineEntry[]> {
    try {
      const r = await this.send(6, 1, this.w().referenceType(typeId).method(methodId).build());
      r.u64();
      r.u64();
      const n = r.i32();
      const result: LineEntry[] = [];
      for (let i = 0; i < n; ++i) result.push({ codeIndex: r.u64(), line: r.i32() });
      return result;
    } catch {
      return []; // a method without line information (generated plumbing)
    }
  }

  async variableTable(typeId: bigint, methodId: bigint): Promise<VariableEntry[]> {
    try {
      const r = await this.send(6, 2, this.w().referenceType(typeId).method(methodId).build());
      r.i32();
      const n = r.i32();
      const result: VariableEntry[] = [];
      for (let i = 0; i < n; ++i) {
        result.push({ codeIndex: r.u64(), name: r.string(), signature: r.string(), length: r.i32(), slot: r.i32() });
      }
      return result;
    } catch {
      return [];
    }
  }

  // ---- ObjectReference and StringReference ----------------------------------

  async objectType(objectId: bigint): Promise<{ typeTag: number; typeId: bigint }> {
    const r = await this.send(9, 1, this.w().object(objectId).build());
    return { typeTag: r.u8(), typeId: r.referenceType() };
  }

  async objectFields(objectId: bigint, fieldIds: bigint[]): Promise<JdwpValue[]> {
    const w = this.w().object(objectId).i32(fieldIds.length);
    for (const id of fieldIds) w.id(id, this.sizes.field);
    const r = await this.send(9, 2, w.build());
    const n = r.i32();
    const result: JdwpValue[] = [];
    for (let i = 0; i < n; ++i) result.push(r.value());
    return result;
  }

  async invoke(objectId: bigint, thread: bigint, classId: bigint, methodId: bigint): Promise<{ value: JdwpValue; exception: bigint | null }> {
    const w = this.w().object(objectId).object(thread).referenceType(classId).method(methodId).i32(0).i32(0);
    const r = await this.send(9, 6, w.build());
    const value = r.value();
    const exception = r.value();
    return { value, exception: exception.value as bigint | null };
  }

  async stringValue(stringId: bigint): Promise<string> {
    return (await this.send(10, 1, this.w().object(stringId).build())).string();
  }

  // ---- ThreadReference and StackFrame ---------------------------------------

  async threadName(thread: bigint): Promise<string> {
    return (await this.send(11, 1, this.w().object(thread).build())).string();
  }

  async frames(thread: bigint): Promise<Frame[]> {
    const r = await this.send(11, 6, this.w().object(thread).i32(0).i32(-1).build());
    const n = r.i32();
    const result: Frame[] = [];
    for (let i = 0; i < n; ++i) result.push({ frameId: r.frame(), location: r.location() });
    return result;
  }

  async frameValues(thread: bigint, frame: bigint, slots: Array<{ slot: number; signature: string }>): Promise<JdwpValue[]> {
    const w = this.w().object(thread).frame(frame).i32(slots.length);
    for (const s of slots) w.i32(s.slot).u8(s.signature.charCodeAt(0));
    const r = await this.send(16, 1, w.build());
    const n = r.i32();
    const result: JdwpValue[] = [];
    for (let i = 0; i < n; ++i) result.push(r.value());
    return result;
  }

  async thisObject(thread: bigint, frame: bigint): Promise<bigint | null> {
    const r = await this.send(16, 3, this.w().object(thread).frame(frame).build());
    return r.value().value as bigint | null;
  }

  // ---- EventRequest --------------------------------------------------------

  /** Modifiers are pre-encoded: see the helpers below. */
  async setEvent(kind: number, policy: number, modifiers: Buffer[]): Promise<number> {
    const w = this.w().u8(kind).u8(policy).i32(modifiers.length);
    const head = w.build();
    const r = await this.send(15, 1, Buffer.concat([head, ...modifiers]));
    return r.i32();
  }

  async clearEvent(kind: number, requestId: number): Promise<void> {
    await this.send(15, 2, this.w().u8(kind).i32(requestId).build());
  }

  countModifier(count: number): Buffer { return this.w().u8(1).i32(count).build(); }
  classExcludeModifier(pattern: string): Buffer { return this.w().u8(6).string(pattern).build(); }
  locationModifier(location: Location): Buffer { return this.w().u8(7).location(location).build(); }
  stepModifier(thread: bigint, size: number, depth: number): Buffer {
    return this.w().u8(10).object(thread).i32(size).i32(depth).build();
  }
  sourceNameModifier(pattern: string): Buffer { return this.w().u8(12).string(pattern).build(); }
}

// Step sizes and depths of the Step modifier.
export const STEP_LINE = 1;
export const STEP_INTO = 0;
export const STEP_OVER = 1;
export const STEP_OUT = 2;
