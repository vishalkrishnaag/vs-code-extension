"use strict";
// End to end: drives the Felidae debug session (out/debug/session.js) against a real `felidae --debug` run. Needs
// build/java/felidae.jar (./install.sh in the Felidae repository); skipped when it is not there.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function findJar() {
  if (process.env.FELIDAE_JAR) return process.env.FELIDAE_JAR;
  for (let dir = __dirname, depth = 0; depth < 6; dir = path.dirname(dir), depth++) {
    const candidate = path.join(dir, "build", "java", "felidae.jar");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const jar = findJar();
if (!jar) {
  console.log("skipped: build/java/felidae.jar not found (run ./install.sh)");
  process.exit(0);
}

const { FelidaeDebugSession, displayName, typeDisplayName } = require("../out/debug/session");

assert.strictEqual(displayName("twice$k"), "twice");
assert.strictEqual(displayName("$show"), "$show");
assert.strictEqual(displayName("add"), "add");
assert.strictEqual(typeDisplayName("Ldbg$Box;"), "dbg$Box");
assert.strictEqual(typeDisplayName("Ljava/lang/Integer;"), "Integer");
assert.strictEqual(typeDisplayName("Ljava/util/Optional;"), "Atom");

const PROGRAM = [
  "class Box",                                      // 1
  "    def n: Integer := 1.",                       // 2
  "    def tags: List<Integer> := [].",             // 3
  "",                                               // 4
  "    def twice(k: Integer) =>",                   // 5
  "        def doubled := this.n * k * 2.",         // 6
  "        doubled.",                               // 7
  "    end",                                        // 8
  "end",                                            // 9
  "",                                               // 10
  "def risky(x: Integer) =>",                       // 11
  "    try",                                        // 12
  "        def r := 10 / x.",                       // 13
  "    catch e then",                               // 14
  "        def r := -1.",                           // 15
  "    end",                                        // 16
  "    r.",                                         // 17
  "end",                                            // 18
  "",                                               // 19
  "def main() =>",                                  // 20
  "    def total := 5.",                            // 21
  "    def b := new Box(n: 5).",                    // 22
  "    (twice: b.twice(k: 3), safe: risky(x: 0)).", // 23
  "end",
  ""].join("\n");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "felidae-debug-"));
const program = path.join(directory, "dbg.fx");
fs.writeFileSync(program, PROGRAM);

const messages = [];
const waiters = [];
const session = new FelidaeDebugSession((message) => {
  messages.push(message);
  for (const waiter of [...waiters]) if (waiter.test(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
});
let seq = 1;

function waitFor(test, label) {
  const existing = messages.find(test);
  if (existing) { messages.splice(messages.indexOf(existing), 1); return Promise.resolve(existing); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for " + label + "; pending messages: " + JSON.stringify(messages.map((m) => m.event || m.command)))), 20000);
    waiters.push({ test, resolve: (m) => { clearTimeout(timer); messages.splice(messages.indexOf(m), 1); resolve(m); } });
  });
}

async function request(command, args) {
  const id = seq++;
  const response = waitFor((m) => m.type === "response" && m.request_seq === id, command);
  await session.handleMessage({ seq: id, type: "request", command, arguments: args });
  const message = await response;
  assert.ok(message.success, command + " failed: " + message.message);
  return message.body;
}

const event = (name) => waitFor((m) => m.type === "event" && m.event === name, name + " event");

async function variablesOfTopFrame(threadId) {
  const { stackFrames } = await request("stackTrace", { threadId });
  const { scopes } = await request("scopes", { frameId: stackFrames[0].id });
  const { variables } = await request("variables", { variablesReference: scopes[0].variablesReference });
  return { frames: stackFrames, variables: Object.fromEntries(variables.map((v) => [v.name, v])) };
}

(async () => {
  await request("initialize", {});
  const initialized = event("initialized");
  await request("launch", { program, interpreterPath: jar, stopOnEntry: true });
  await initialized;
  const set = await request("setBreakpoints", { source: { path: program }, breakpoints: [{ line: 7 }, { line: 13 }] });
  assert.strictEqual(set.breakpoints.length, 2);
  await request("configurationDone", {});

  // stop on entry: the first statement of main()
  let stopped = await event("stopped");
  assert.strictEqual(stopped.body.reason, "entry");
  let state = await variablesOfTopFrame(stopped.body.threadId);
  assert.strictEqual(state.frames[0].name, "main");
  assert.strictEqual(state.frames[0].line, 21);
  assert.strictEqual(state.frames[0].source.path, program);

  // continue to the breakpoint inside Box.twice (line 7)
  await request("continue", { threadId: stopped.body.threadId });
  stopped = await event("stopped");
  assert.strictEqual(stopped.body.reason, "breakpoint");
  state = await variablesOfTopFrame(stopped.body.threadId);
  assert.strictEqual(state.frames[0].line, 7);
  assert.strictEqual(state.frames[0].name, "Box.twice");
  assert.strictEqual(state.frames[1].name, "main");
  assert.strictEqual(state.frames[1].line, 23);
  assert.strictEqual(state.variables.k.value, "3");
  assert.strictEqual(state.variables.doubled.value, "30");
  assert.ok(state.variables.this.value.startsWith("Box("), state.variables.this.value);
  assert.ok(state.variables.this.variablesReference > 0);
  const fields = await request("variables", { variablesReference: state.variables.this.variablesReference });
  assert.deepStrictEqual(fields.variables.map((v) => v.name + "=" + v.value), ["n=5", "tags=[]"]);

  // continue to the breakpoint in risky (line 13), evaluate x, step over into the catch
  await request("continue", { threadId: stopped.body.threadId });
  stopped = await event("stopped");
  state = await variablesOfTopFrame(stopped.body.threadId);
  assert.strictEqual(state.frames[0].line, 13);
  assert.strictEqual(state.frames[0].name, "risky");
  assert.strictEqual(state.variables.x.value, "0");
  const { stackFrames } = await request("stackTrace", { threadId: stopped.body.threadId });
  const evaluated = await request("evaluate", { frameId: stackFrames[0].id, expression: "x" });
  assert.strictEqual(evaluated.result, "0");

  await request("next", { threadId: stopped.body.threadId });
  stopped = await event("stopped");
  assert.strictEqual(stopped.body.reason, "step");
  state = await variablesOfTopFrame(stopped.body.threadId);
  assert.strictEqual(state.frames[0].line, 15);
  assert.ok(state.variables.e.value.includes("ArithmeticException"), state.variables.e.value);

  // run to the end: the program's output arrives, then the session ends
  await request("continue", { threadId: stopped.body.threadId });
  const output = await waitFor((m) => m.type === "event" && m.event === "output" && /twice: 30/.test(m.body.output), "program output");
  assert.ok(output.body.output.includes("safe: -1"));
  await event("terminated");
  await request("disconnect", {});
  console.log("debug session: 1 scenario passed");
  process.exit(0);
})().catch(async (error) => {
  console.error("FAILED:", error && error.stack || error);
  try { await session.handleMessage({ seq: 999, type: "request", command: "disconnect", arguments: {} }); } catch { /* ignore */ }
  process.exit(1);
});
