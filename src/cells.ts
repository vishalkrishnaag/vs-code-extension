// Cells: the units a file is run in, one declaration at a time.
//
// Pure text analysis (no vscode import) so it can be unit-tested. Everything lives in a class, so a cell is a
// member `def` indented one level inside a column-0 `static class` (its `owner`), or a column-0 `class`; everything
// indented deeper belongs to the cell above it.
//
//   static class U / def f(a: Integer) => ... end   function  (block, ends at its `end`; run as U.f(a: ...))
//   static class U / def x := expr                  binding   (run as U.x)
//   class Name ... end                              class     (a fact class runs as Name.all())
//   static class U / def main() => ... end          entry     (run through the normal Run/Debug)

export type CellKind = "function" | "fact" | "binding" | "class" | "entry";

export interface CellParam {
  name: string;
  type?: string;
}

export interface Cell {
  kind: CellKind;
  name: string;
  // The static class a function or binding is a member of; empty for a class cell.
  owner?: string;
  params: CellParam[];
  // The line holding "def name": where the lens and the inline result go.
  headerLine: number;
  // First line of the cell including a comment block directly above it.
  startLine: number;
  endLine: number;
}

// Only the block boundaries are needed, so this module does not depend on the
// extension's own pair type.
export interface BlockPair {
  openerLine: number;
  endLine: number;
}

// A ':' or '.' belongs to a name only when an identifier follows it, so
// "def label: string" names `label`, not `label:`.
const NAME = "[A-Za-z_][A-Za-z0-9_]*(?:[:.][A-Za-z_][A-Za-z0-9_]*)*";
const DEF_HEAD = new RegExp("^(?:async\\s+)?(?:def|define)\\s+(" + NAME + ")");
const CLASS_HEAD = /^(?:private\s+)?(static\s+)?(?:class|interface)\s+([A-Za-z_][A-Za-z0-9_.]*)/;
const MEMBER_HEAD = new RegExp("^    (?:async\\s+)?(?:def|define)\\s+(" + NAME + ")");

// A line that is only a comment: `// ...`, or part of a `/* ... */` / `/** ... */` block written one line each.
function isCommentLine(line: string): boolean {
  const text = line.trimStart();
  return text.startsWith("//") || text.startsWith("/*") || text.startsWith("*");
}

// The line without its trailing `// comment`, ignoring a // inside a string.
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

// Net open brackets on a line, ignoring brackets inside strings.
function bracketDelta(code: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if ("([{".includes(ch)) {
      depth++;
    } else if (")]}".includes(ch)) {
      depth--;
    }
  }
  return depth;
}

// "(a: number, b)" -> [{name:"a",type:"number"},{name:"b"}]
function parseParams(head: string): CellParam[] {
  const open = head.indexOf("(");
  if (open < 0) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < head.length; i++) {
    if (head[i] === "(") depth++;
    else if (head[i] === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return [];
  const inside = head.slice(open + 1, close);
  const parts: string[] = [];
  let level = 0;
  let current = "";
  for (const ch of inside) {
    if ("([{<".includes(ch)) level++;
    else if (")]}>".includes(ch)) level--;
    if (ch === "," && level === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const colon = part.indexOf(":");
      return colon < 0
        ? { name: part }
        : { name: part.slice(0, colon).trim(), type: part.slice(colon + 1).trim() || undefined };
    });
}

// The header of a block-opening def, which may continue over several lines
// until the `=>`.
function blockHead(lines: readonly string[], line: number): string {
  let head = "";
  for (let i = line; i < lines.length && i <= line + 32; i++) {
    head += " " + stripComment(lines[i]);
    if (/=>\s*(?:\(\s*\))?\s*$/.test(head)) break;
  }
  return head;
}

// The member cells of the static class `owner` written on lines open..close.
function memberCells(lines: readonly string[], open: number, close: number, owner: string, endOfBlock: ReadonlyMap<number, number>): Cell[] {
  const cells: Cell[] = [];
  for (let line = open + 1; line < close; line++) {
    const code = stripComment(lines[line]);
    const member = MEMBER_HEAD.exec(code);
    if (!member) continue;
    const name = member[1];
    const blockEnd = endOfBlock.get(line);
    let start = line;
    while (start > open + 1 && isCommentLine(lines[start - 1])) start--;
    if (blockEnd !== undefined) {
      cells.push({
        kind: name === "main" ? "entry" : "function",
        name,
        owner,
        params: parseParams(blockHead(lines, line)),
        headerLine: line,
        startLine: start,
        endLine: blockEnd
      });
      line = blockEnd;
    } else {
      cells.push({ kind: "binding", name, owner, params: [], headerLine: line, startLine: start, endLine: line });
    }
  }
  return cells;
}

export function splitCells(lines: readonly string[], pairs: readonly BlockPair[]): Cell[] {
  const endOfBlock = new Map<number, number>();
  for (const pair of pairs) endOfBlock.set(pair.openerLine, pair.endLine);

  const cells: Cell[] = [];
  let line = 0;
  while (line < lines.length) {
    const text = lines[line];
    const code = stripComment(text);
    // Only a column-0 statement starts a cell; indented lines belong to one.
    if (code.trim() === "" || /^\s/.test(text)) {
      line++;
      continue;
    }

    let cell: Cell | undefined;
    let next = line + 1;
    const classMatch = CLASS_HEAD.exec(code);
    if (classMatch) {
      const end = endOfBlock.get(line) ?? line;
      if (classMatch[1]) {
        // a static class: its members are the cells
        cells.push(...memberCells(lines, line, end, classMatch[2], endOfBlock));
      } else {
        cell = { kind: "class", name: classMatch[2], params: [], headerLine: line, startLine: line, endLine: end };
      }
      next = end + 1;
    }

    if (cell) {
      // A comment block directly above (no blank line between) belongs to it.
      let start = cell.headerLine;
      while (start > 0 && isCommentLine(lines[start - 1])) start--;
      cell.startLine = start;
      cells.push(cell);
    }
    line = next;
  }
  return cells;
}

// The cell the cursor is in, or the next one below when it sits between cells.
export function cellAtLine(cells: readonly Cell[], line: number): Cell | undefined {
  return cells.find((cell) => line >= cell.startLine && line <= cell.endLine) ??
    cells.find((cell) => cell.startLine > line);
}

// "a: , b: " - a template the user completes in the argument prompt.
export function defaultArguments(cell: Cell): string {
  return cell.params.map((param) => param.name + ": ").join(", ");
}

// The expression a cell runs: a member is called through its static class.
//   function  U.f(a: 1)       binding  U.x       fact/class  Name.all()
export function buildCellExpression(cell: Cell, args = ""): string {
  switch (cell.kind) {
    case "function":
      return (cell.owner ? cell.owner + "." : "") + cell.name + "(" + args.trim() + ")";
    case "binding":
      return (cell.owner ? cell.owner + "." : "") + cell.name;
    case "fact":
    case "class":
      return cell.name + ".all()";
    default:
      throw new Error("The entry function runs through Run/Debug, not as a cell.");
  }
}

// The file a cell is run from. A cell is a definition of the document, so the program imports the document and
// the `main()` of its class CellRun runs the cell's expression (a call, a binding's name, `Class.all()`). The document keeps
// its own `main()` (it is in another file), and the expression names the document's static classes.
export const CELL_FILE = "cell_run.fx";

export function cellProgram(documentFileName: string, expression: string): string {
  return 'import "' + documentFileName.replace(/\\/g, "/").replace(/"/g, '\\"') + '"\n\nstatic class CellRun\n    def main() =>\n        ' + expression + "\n    end\nend\n";
}

// Small stable hash, enough to tell whether a cell's source changed.
export function hashText(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return hash;
}
