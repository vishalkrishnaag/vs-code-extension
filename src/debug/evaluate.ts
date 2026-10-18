// Felidae expressions evaluated in a stopped program: breakpoint conditions, logpoint `{...}` parts, watch and hover
// expressions and the debug console.
//
// The language is the expression subset of Felidae itself, so a condition reads like the code around it:
//
//   literals        1  2.5  5L  2.5f  "text"  'atom'  true  false  nil
//   names           a local or parameter, `this`, a field of `this`, a shared field of the frame's class, a class
//   members         a.field   a.method(1, 2)   Name.field   Name.method(x: 1)   (named arguments are passed in order)
//   indexing        xs[0]     (a List or a Java array)
//   operators       not  -  * / %  + -  = != < <= > >=  and  or     (Felidae's precedence; `=` is equality)
//
// A bare name that is neither a variable nor a class is a data atom, as in the language. Nothing is assigned: a value
// never changes in Felidae, so there is no assignment to offer. A method call runs in the debuggee (single threaded), as
// it does in Java and Kotlin debuggers.
//
// No vscode and no JDWP import: the host interface below is all it needs, so it is testable on its own.

/** An atom: Felidae's immutable symbolic value, distinct from a string with the same spelling. */
export class Atom {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

/** A value that lives in the debuggee: an object (or a primitive the host keeps typed). */
export interface Remote {
  remote: true;
  // JDWP tag and id (objects), or tag and primitive value.
  tag: string;
  value: bigint | number | boolean | null;
}

export type Local = number | bigint | string | boolean | null | Atom;
export type Value = Local | Remote;

export function isRemote(value: Value): value is Remote {
  return typeof value === "object" && value !== null && (value as Remote).remote === true;
}

/** What the evaluator needs from the stopped program. */
export interface EvalHost {
  /** A local, parameter, `this`, a field of `this` or a shared field of the frame's class; undefined when there is none. */
  variable(name: string): Promise<Value | undefined>;
  /** A class by its Felidae or Java simple name (or qualified name); undefined when none is loaded. */
  classNamed(name: string): Promise<bigint | undefined>;
  field(target: Remote, name: string): Promise<Value>;
  staticField(classId: bigint, name: string): Promise<Value>;
  invoke(target: Remote, name: string, args: Value[]): Promise<Value>;
  invokeStatic(classId: bigint, name: string, args: Value[]): Promise<Value>;
  index(target: Remote, index: number): Promise<Value>;
  /** The JavaScript value of a boxed number, string, boolean, character or atom; undefined for any other object. */
  unbox(value: Remote): Promise<Local | undefined>;
  /** `a.equals(b)` in the debuggee. */
  equals(a: Remote, b: Value): Promise<boolean>;
}

// ------------------------------------------------------------------------------------------------- tokens

type TokenKind = "number" | "string" | "atom" | "name" | "op" | "end";

interface Token {
  kind: TokenKind;
  text: string;
  value?: Local;
}

const OPERATORS = ["!=", "<=", ">=", ":=", "=", "<", ">", "+", "-", "*", "/", "%", "(", ")", "[", "]", ".", ",", ":"];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/\d/.test(ch)) {
      const match = /^\d+(?:\.\d+)?[Lf]?/.exec(source.slice(i))!;
      const text = match[0];
      const value = text.endsWith("L") ? BigInt(text.slice(0, -1)) : Number(text.replace(/f$/, ""));
      tokens.push({ kind: "number", text, value });
      i += text.length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = "";
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\" && j + 1 < source.length) {
          const escaped = source[j + 1];
          text += ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" } as Record<string, string>)[escaped] ?? escaped;
          j += 2;
        } else {
          text += source[j++];
        }
      }
      if (j >= source.length) throw new Error("A string literal is not closed");
      tokens.push({ kind: "string", text: source.slice(i, j + 1), value: text });
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      const close = source.indexOf("'", i + 1);
      if (close < 0) throw new Error("An atom literal is not closed");
      tokens.push({ kind: "atom", text: source.slice(i, close + 1), value: new Atom(source.slice(i + 1, close)) });
      i = close + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const text = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i))![0];
      tokens.push({ kind: "name", text });
      i += text.length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new Error("Unexpected '" + ch + "'");
    if (op === ":=") throw new Error("Values never change in Felidae: an expression cannot assign");
    tokens.push({ kind: "op", text: op });
    i += op.length;
  }
  tokens.push({ kind: "end", text: "" });
  return tokens;
}

// ------------------------------------------------------------------------------------------------- syntax tree

export type Node =
  | { type: "literal"; value: Local }
  | { type: "name"; name: string }
  | { type: "member"; target: Node; name: string }
  | { type: "call"; target: Node | undefined; name: string; args: Node[] }
  | { type: "index"; target: Node; index: Node }
  | { type: "unary"; op: "-" | "not"; operand: Node }
  | { type: "binary"; op: string; left: Node; right: Node };

class Parser {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.or();
    if (this.peek().kind !== "end") throw new Error("Unexpected '" + this.peek().text + "'");
    return node;
  }

  private peek(): Token {
    return this.tokens[this.at];
  }

  private accept(text: string): boolean {
    const token = this.peek();
    if ((token.kind === "op" || token.kind === "name") && token.text === text) {
      this.at++;
      return true;
    }
    return false;
  }

  private expect(text: string): void {
    if (!this.accept(text)) throw new Error("Expected '" + text + "'");
  }

  private or(): Node {
    let left = this.and();
    while (this.accept("or")) left = { type: "binary", op: "or", left, right: this.and() };
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.accept("and")) left = { type: "binary", op: "and", left, right: this.not() };
    return left;
  }

  private not(): Node {
    if (this.accept("not")) return { type: "unary", op: "not", operand: this.not() };
    return this.comparison();
  }

  private comparison(): Node {
    const left = this.additive();
    for (const op of ["=", "!=", "<=", ">=", "<", ">"]) {
      if (this.accept(op)) return { type: "binary", op, left, right: this.additive() };
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    for (;;) {
      if (this.accept("+")) left = { type: "binary", op: "+", left, right: this.multiplicative() };
      else if (this.accept("-")) left = { type: "binary", op: "-", left, right: this.multiplicative() };
      else return left;
    }
  }

  private multiplicative(): Node {
    let left = this.unary();
    for (;;) {
      const op = ["*", "/", "%"].find((candidate) => this.accept(candidate));
      if (!op) return left;
      left = { type: "binary", op, left, right: this.unary() };
    }
  }

  private unary(): Node {
    if (this.accept("-")) return { type: "unary", op: "-", operand: this.unary() };
    return this.postfix(this.primary());
  }

  private postfix(node: Node): Node {
    for (;;) {
      if (this.accept(".")) {
        const name = this.peek();
        if (name.kind !== "name") throw new Error("Expected a member name after '.'");
        this.at++;
        node = this.peek().text === "(" && this.peek().kind === "op"
          ? { type: "call", target: node, name: name.text, args: this.args() }
          : { type: "member", target: node, name: name.text };
      } else if (this.accept("[")) {
        const index = this.or();
        this.expect("]");
        node = { type: "index", target: node, index };
      } else {
        return node;
      }
    }
  }

  // `(a, b)` or `(x: a, y: b)`: named arguments are passed in the order written.
  private args(): Node[] {
    this.expect("(");
    const args: Node[] = [];
    if (this.accept(")")) return args;
    do {
      if (this.peek().kind === "name" && this.tokens[this.at + 1]?.text === ":") this.at += 2;
      args.push(this.or());
    } while (this.accept(","));
    this.expect(")");
    return args;
  }

  private primary(): Node {
    const token = this.peek();
    if (token.kind === "number" || token.kind === "string" || token.kind === "atom") {
      this.at++;
      return { type: "literal", value: token.value! };
    }
    if (token.kind === "name") {
      this.at++;
      if (token.text === "true") return { type: "literal", value: true };
      if (token.text === "false") return { type: "literal", value: false };
      if (token.text === "nil") return { type: "literal", value: null };
      if (this.peek().text === "(" && this.peek().kind === "op") return { type: "call", target: undefined, name: token.text, args: this.args() };
      return { type: "name", name: token.text };
    }
    if (this.accept("(")) {
      const inner = this.or();
      this.expect(")");
      return inner;
    }
    throw new Error(token.kind === "end" ? "The expression is incomplete" : "Unexpected '" + token.text + "'");
  }
}

export function parseExpression(source: string): Node {
  if (source.trim() === "") throw new Error("Empty expression");
  return new Parser(tokenize(source)).parse();
}

// ------------------------------------------------------------------------------------------------- evaluation

// A name that is a class rather than a value: the left side of `Name.member`.
interface ClassRef {
  classRef: bigint;
}

type Resolved = Value | ClassRef;

function isClassRef(value: Resolved): value is ClassRef {
  return typeof value === "object" && value !== null && "classRef" in value;
}

export class Evaluator {
  constructor(private readonly host: EvalHost) {}

  async evaluate(source: string): Promise<Value> {
    return this.value(await this.node(parseExpression(source)));
  }

  /** A breakpoint condition: true only for the boolean true. */
  async condition(source: string): Promise<boolean> {
    const result = await this.local(await this.evaluate(source));
    if (typeof result !== "boolean") throw new Error("The condition '" + source + "' is not a boolean");
    return result;
  }

  private value(resolved: Resolved): Value {
    if (isClassRef(resolved)) throw new Error("A class is not a value; name one of its members");
    return resolved;
  }

  private async node(node: Node): Promise<Resolved> {
    switch (node.type) {
      case "literal":
        return node.value;
      case "name": {
        const found = await this.host.variable(node.name);
        if (found !== undefined) return found;
        const classId = await this.host.classNamed(node.name);
        if (classId !== undefined) return { classRef: classId };
        return new Atom(node.name);
      }
      case "member": {
        const target = await this.node(node.target);
        if (isClassRef(target)) return this.host.staticField(target.classRef, node.name);
        return this.host.field(this.remote(target, node.name), node.name);
      }
      case "call": {
        const args: Value[] = [];
        for (const arg of node.args) args.push(this.value(await this.node(arg)));
        if (!node.target) throw new Error("Call '" + node.name + "' on its class, as Name." + node.name + "(...)");
        const target = await this.node(node.target);
        if (isClassRef(target)) return this.host.invokeStatic(target.classRef, node.name, args);
        return this.host.invoke(this.remote(target, node.name), node.name, args);
      }
      case "index": {
        const target = this.remote(this.value(await this.node(node.target)), "[]");
        const index = await this.local(this.value(await this.node(node.index)));
        if (typeof index !== "number" || !Number.isInteger(index)) throw new Error("An index is an int");
        return this.host.index(target, index);
      }
      case "unary": {
        const operand = await this.local(this.value(await this.node(node.operand)));
        if (node.op === "not") {
          if (typeof operand !== "boolean") throw new Error("'not' needs a boolean");
          return !operand;
        }
        if (typeof operand === "number") return -operand;
        if (typeof operand === "bigint") return -operand;
        throw new Error("'-' needs a number");
      }
      case "binary":
        return this.binary(node);
    }
  }

  private remote(value: Value, member: string): Remote {
    if (isRemote(value) && value.value !== null && typeof value.value === "bigint") return value;
    if (value === null || (isRemote(value) && value.value === null)) throw new Error("'" + member + "' of nil");
    throw new Error("A " + describe(value) + " has no member '" + member + "'");
  }

  /** The JavaScript value of `value`: a primitive as it is, a box unboxed; an object that is no box stays remote. */
  private async local(value: Value): Promise<Local | Remote> {
    if (!isRemote(value)) return value;
    if (value.value === null) return null;
    if (typeof value.value !== "bigint" || "BZCSIJFD".includes(value.tag)) {
      if (value.tag === "C") return String.fromCharCode(Number(value.value));
      return value.value as Local;
    }
    const unboxed = await this.host.unbox(value);
    return unboxed === undefined ? value : unboxed;
  }

  private async binary(node: Extract<Node, { type: "binary" }>): Promise<Value> {
    if (node.op === "and" || node.op === "or") {
      const left = await this.local(this.value(await this.node(node.left)));
      if (typeof left !== "boolean") throw new Error("'" + node.op + "' needs booleans");
      if (node.op === "and" ? !left : left) return left;
      const right = await this.local(this.value(await this.node(node.right)));
      if (typeof right !== "boolean") throw new Error("'" + node.op + "' needs booleans");
      return right;
    }
    const leftRaw = this.value(await this.node(node.left));
    const rightRaw = this.value(await this.node(node.right));
    const left = await this.local(leftRaw);
    const right = await this.local(rightRaw);
    if (node.op === "=" || node.op === "!=") {
      const equal = await this.equal(left, right);
      return node.op === "=" ? equal : !equal;
    }
    if (node.op === "+" && (typeof left === "string" || typeof right === "string")) {
      if (typeof left !== "string" || typeof right !== "string") throw new Error("'+' joins two strings");
      return left + right;
    }
    if (!isNumber(left) || !isNumber(right)) throw new Error("'" + node.op + "' needs numbers, not " + describe(left) + " and " + describe(right));
    if (typeof left === "bigint" || typeof right === "bigint") {
      if (typeof left !== "bigint" || typeof right !== "bigint") throw new Error("'" + node.op + "' mixes a long with another number type");
      return arithmetic(node.op, left, right);
    }
    return arithmetic(node.op, left, right);
  }

  private async equal(left: Local | Remote, right: Local | Remote): Promise<boolean> {
    if (isRemote(left)) return this.host.equals(left, right);
    if (isRemote(right)) return this.host.equals(right, left);
    if (left instanceof Atom || right instanceof Atom) {
      return left instanceof Atom && right instanceof Atom && left.name === right.name;
    }
    return left === right;
  }
}

function isNumber(value: unknown): value is number | bigint {
  return typeof value === "number" || typeof value === "bigint";
}

function arithmetic<T extends number | bigint>(op: string, left: T, right: T): Value {
  switch (op) {
    case "<": return left < right;
    case "<=": return left <= right;
    case ">": return left > right;
    case ">=": return left >= right;
    case "+": return (left as number) + (right as number);
    case "-": return (left as number) - (right as number);
    case "*": return (left as number) * (right as number);
    case "/":
      if (right === 0 || right === 0n) throw new Error("/ by zero");
      if (typeof left === "bigint") return (left as bigint) / (right as bigint);
      // int division truncates toward zero, as in the language; a fractional operand divides as a double
      return Number.isInteger(left) && Number.isInteger(right) ? Math.trunc((left as number) / (right as number)) : (left as number) / (right as number);
    case "%":
      if (right === 0 || right === 0n) throw new Error("/ by zero");
      return (left as number) % (right as number);
    default:
      throw new Error("Unknown operator " + op);
  }
}

export function describe(value: unknown): string {
  if (value === null) return "nil";
  if (value instanceof Atom) return "atom";
  if (isRemote(value as Value)) return "object";
  return typeof value === "bigint" ? "long" : typeof value;
}

/** The text of a local value as the Variables view writes it (a string quoted, an atom bare). */
export function formatLocal(value: Local): string {
  if (value === null) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/**
 * A logpoint message: the text with each `{expression}` replaced by its value; `{{` and `}}` are braces. An expression
 * that fails shows its error in its place, so a typo never stops the program.
 */
export async function interpolate(message: string, evaluate: (expression: string) => Promise<string>): Promise<string> {
  let out = "";
  for (let i = 0; i < message.length; i++) {
    const ch = message[i];
    if ((ch === "{" || ch === "}") && message[i + 1] === ch) {
      out += ch;
      i++;
      continue;
    }
    if (ch !== "{") {
      out += ch;
      continue;
    }
    const close = message.indexOf("}", i + 1);
    if (close < 0) {
      out += message.slice(i);
      break;
    }
    const expression = message.slice(i + 1, close);
    try {
      out += await evaluate(expression);
    } catch (error) {
      out += "<" + (error instanceof Error ? error.message : String(error)) + ">";
    }
    i = close;
  }
  return out;
}

/** A DAP hit condition: `5` or `= 5` (the fifth hit), `>= 5`, `> 5`, `< 5`, `<= 5`, `% 5` (every fifth). */
export function hitConditionMet(condition: string, hits: number): boolean {
  const match = /^\s*(==|=|>=|>|<=|<|%)?\s*(\d+)\s*$/.exec(condition);
  if (!match) throw new Error("A hit count is a number, optionally after =, >, >=, <, <= or %");
  const n = Number(match[2]);
  switch (match[1]) {
    case ">=": return hits >= n;
    case ">": return hits > n;
    case "<=": return hits <= n;
    case "<": return hits < n;
    case "%": return n > 0 && hits % n === 0;
    default: return hits === n;
  }
}
