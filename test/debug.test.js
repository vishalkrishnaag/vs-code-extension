"use strict";
// End to end: drives the Felidae debug session (out/debug/session.js) against a real `felidae --debug` run. Needs a
// built felidae command (FELIDAE_PATH, or ./gradlew installDist in the Felidae repository); skipped when there is none.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The felidae command to debug with: FELIDAE_PATH, else the Gradle distribution of the repository this extension sits
// in (./gradlew installDist writes build/java/root/install/felidae/bin/felidae). A stale build/java/felidae.jar is
// not used.
function findFelidae() {
  if (process.env.FELIDAE_PATH) return process.env.FELIDAE_PATH;
  const name = process.platform === "win32" ? "felidae.bat" : "felidae";
  // build/java/root: the root project's own installDist, since the former cli module was folded into it;
  // build/java/cli: the layout from before that merge, kept so an older build still runs this test.
  for (const module of ["root", "cli"]) {
    for (let dir = __dirname, depth = 0; depth < 6; dir = path.dirname(dir), depth++) {
      const candidate = path.join(dir, "build", "java", module, "install", "felidae", "bin", name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const felidae = findFelidae();
if (!felidae) {
  console.log("skipped: no felidae command (set FELIDAE_PATH or run ./gradlew installDist)");
  process.exit(0);
}

const { FelidaeDebugSession, displayName, typeDisplayName, felidaeClassName, packagePathOf, sourceKey, pathMatchesKey, parameterTypes } = require("../out/debug/session");
const { Evaluator, Atom, hitConditionMet, interpolate, parseExpression } = require("../out/debug/evaluate");

assert.strictEqual(displayName("twice$k"), "twice");
assert.strictEqual(displayName("$show"), "$show");
assert.strictEqual(displayName("add"), "add");
assert.strictEqual(typeDisplayName("Ljava/lang/Integer;"), "Integer");
assert.strictEqual(typeDisplayName("Ljava/util/Optional;"), "Atom");
assert.strictEqual(typeDisplayName("[I"), "int[]");
assert.strictEqual(felidaeClassName("Ldbg$Box;"), "Box");
assert.strictEqual(felidaeClassName("Lcom/acme/app;"), "app");
assert.strictEqual(packagePathOf("Lcom/acme/app$Box;"), "com/acme");
assert.strictEqual(packagePathOf("Ldbg;"), "");
assert.strictEqual(sourceKey("com/acme", "app.fx"), "com/acme/app.fx");
assert.ok(pathMatchesKey("/work/root/com/acme/app.fx", "com/acme/app.fx"));
assert.ok(!pathMatchesKey("/work/root/other/app.fx", "com/acme/app.fx"));
assert.ok(pathMatchesKey("C:\\work\\dbg.fx", "dbg.fx"));
assert.deepStrictEqual(parameterTypes("(I[JLjava/lang/String;Z)V"), ["I", "[J", "Ljava/lang/String;", "Z"]);
assert.ok(hitConditionMet("3", 3) && !hitConditionMet("3", 2) && hitConditionMet(">= 2", 5) && hitConditionMet("% 2", 4) && !hitConditionMet("%2", 3));

// The evaluator against a stand-in program.
(async () => {
  const vars = { a: 2, b: 10, s: "hi", flag: true };
  const host = {
    variable: async (name) => (name in vars ? vars[name] : undefined),
    classNamed: async () => undefined,
    field: async () => { throw new Error("no fields"); },
    staticField: async () => { throw new Error("no statics"); },
    invoke: async () => { throw new Error("no calls"); },
    invokeStatic: async () => { throw new Error("no calls"); },
    index: async () => { throw new Error("no index"); },
    unbox: async () => undefined,
    equals: async () => false
  };
  const evaluator = new Evaluator(host);
  assert.strictEqual(await evaluator.evaluate("a * b + 1"), 21);
  assert.strictEqual(await evaluator.evaluate("b / 3"), 3);
  assert.strictEqual(await evaluator.evaluate("s + \"!\""), "hi!");
  assert.strictEqual(await evaluator.condition("a = 2 and not (b < 5)"), true);
  assert.strictEqual(await evaluator.condition("flag or nope"), true);
  assert.ok((await evaluator.evaluate("ready")) instanceof Atom);
  assert.strictEqual(await evaluator.condition("ready = 'ready'"), true);
  assert.strictEqual(await evaluator.evaluate("5L + 2L"), 7n);
  await assert.rejects(evaluator.evaluate("a := 1"), /never change/);
  await assert.rejects(evaluator.condition("a + 1"), /not a boolean/);
  assert.strictEqual(await interpolate("a={a} {{b}} {b * 2}", async (e) => String(await evaluator.evaluate(e))), "a=2 {b} 20");
  assert.strictEqual(await interpolate("{oops(}", async (e) => String(await evaluator.evaluate(e))), "<Expected ')'>".replace("Expected ')'", (() => { try { parseExpression("oops("); } catch (error) { return error.message; } })()));
})().catch((error) => { console.error("FAILED evaluator:", error); process.exit(1); });

const PROGRAM = [
  "class Box",                                          // 1
  "    def n: int := 1",                                // 2
  "    def tags: List<Integer> := []",                  // 3
  "",                                                   // 4
  "    def twice(k: int) =>",                           // 5
  "        def doubled := this.n * k * 2",              // 6
  "        doubled",                                    // 7
  "    end",                                            // 8
  "end",                                                // 9
  "",                                                   // 10
  "static class Dbg",                                   // 11
  "    def limit: int := 7",                            // 12
  "",                                                   // 13
  "    def risky(x: int) =>",                           // 14
  "        try",                                        // 15
  "            def r := 10 / x",                        // 16
  "        catch e then",                               // 17
  "            def r := -1",                            // 18
  "        end",                                        // 19
  "        r",                                          // 20
  "    end",                                            // 21
  "",                                                   // 22
  "    def count(n: int) =>",                           // 23
  "        def items := [n, n + 1]",                    // 24
  "        length(items)",                              // 25
  "    end",                                            // 26
  "",                                                   // 27
  "    def main() =>",                                  // 28
  "        def total := 5",                             // 29
  "        def b := new Box(n: 5, tags: [1, 2])",       // 30
  "        def loops := count(n: 1) + count(n: 2) + count(n: 3)", // 31
  "        (twice: b.twice(k: 3), safe: risky(x: 0), loops: loops, total: total)", // 32
  "    end",                                            // 33
  "end",
  ""].join("\n");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "felidae-debug-"));
const program = path.join(directory, "dbg.fx");
fs.writeFileSync(program, PROGRAM);

function newSession() {
  const messages = [];
  const waiters = [];
  const session = new FelidaeDebugSession((message) => {
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.test(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  let seq = 1;
  const waitFor = (test, label) => {
    const existing = messages.find(test);
    if (existing) { messages.splice(messages.indexOf(existing), 1); return Promise.resolve(existing); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for " + label + "; pending messages: " + JSON.stringify(messages.map((m) => m.event || m.command)))), 30000);
      waiters.push({ test, resolve: (m) => { clearTimeout(timer); if (messages.includes(m)) messages.splice(messages.indexOf(m), 1); resolve(m); } });
    });
  };
  const request = async (command, args) => {
    const id = seq++;
    const response = waitFor((m) => m.type === "response" && m.request_seq === id, command);
    await session.handleMessage({ seq: id, type: "request", command, arguments: args });
    const message = await response;
    assert.ok(message.success, command + " failed: " + message.message);
    return message.body;
  };
  const event = (name) => waitFor((m) => m.type === "event" && m.event === name, name + " event");
  return { session, request, event, waitFor, messages };
}

const { session, request, event, waitFor } = newSession();

async function topFrame(threadId) {
  const { stackFrames } = await request("stackTrace", { threadId });
  const { scopes } = await request("scopes", { frameId: stackFrames[0].id });
  const { variables } = await request("variables", { variablesReference: scopes[0].variablesReference });
  return { frames: stackFrames, scopes, variables: Object.fromEntries(variables.map((v) => [v.name, v])) };
}

const childValues = async (reference) =>
  (await request("variables", { variablesReference: reference })).variables.map((v) => v.name + "=" + v.value);

(async () => {
  const capabilities = await request("initialize", {});
  assert.ok(capabilities.supportsConditionalBreakpoints && capabilities.supportsLogPoints && capabilities.supportsFunctionBreakpoints);
  assert.deepStrictEqual(capabilities.exceptionBreakpointFilters.map((f) => f.filter), ["uncaught", "caught"]);
  const initialized = event("initialized");
  await request("launch", { program, compilerPath: felidae, stopOnEntry: true });
  await initialized;
  const set = await request("setBreakpoints", {
    source: { path: program },
    breakpoints: [{ line: 7 }, { line: 24, logMessage: "count {n} of {limit}" }, { line: 25, condition: "n = 2" }]
  });
  assert.strictEqual(set.breakpoints.length, 3);
  const fn = await request("setFunctionBreakpoints", { breakpoints: [{ name: "Box.twice" }] });
  assert.strictEqual(fn.breakpoints.length, 1);
  await request("setExceptionBreakpoints", { filters: ["caught"] });
  await request("configurationDone", {});

  // stop on entry: the first statement of main(); the static class's shared field is in Statics
  let stopped = await event("stopped");
  assert.strictEqual(stopped.body.reason, "entry");
  let state = await topFrame(stopped.body.threadId);
  assert.strictEqual(state.frames[0].name, "Dbg.main");
  assert.strictEqual(state.frames[0].line, 29);
  assert.strictEqual(state.frames[0].source.path, program);
  assert.strictEqual(state.scopes.length, 2);
  assert.deepStrictEqual(await childValues(state.scopes[1].variablesReference), ["limit=7"]);

  // the logpoint prints for n = 1 and n = 2 without stopping; the condition stops at n = 2
  await request("continue", { threadId: stopped.body.threadId });
  stopped = await event("stopped");
  assert.strictEqual(stopped.body.reason, "breakpoint");
  await waitFor((m) => m.event === "output" && m.body.output === "count 1 of 7\n", "logpoint 1");
  await waitFor((m) => m.event === "output" && m.body.output === "count 2 of 7\n", "logpoint 2");
  state = await topFrame(stopped.body.threadId);
  assert.strictEqual(state.frames[0].line, 25);
  assert.strictEqual(state.frames[0].name, "Dbg.count");
  assert.strictEqual(state.variables.n.value, "2");
  assert.strictEqual(state.variables.items.value, "[2, 3]");
  assert.deepStrictEqual(await childValues(state.variables.items.variablesReference), ["[0]=2", "[1]=3"]);
  const frameId = state.frames[0].id;
  assert.strictEqual((await request("evaluate", { frameId, expression: "n + 1", context: "watch" })).result, "3");
  assert.strictEqual((await request("evaluate", { frameId, expression: "items.size()", context: "repl" })).result, "2");
  assert.strictEqual((await request("evaluate", { frameId, expression: "items[1] * limit", context: "repl" })).result, "21");
  const completions = await request("completions", { frameId, text: "it", column: 3 });
  assert.ok(completions.targets.some((t) => t.label === "items"));

  // the function breakpoint stops at the first line of Box.twice, the line breakpoint at its second
  await request("continue", { threadId: stopped.body.threadId });
  stopped = await event("stopped");
  assert.strictEqual(stopped.body.reason, "function breakpoint");
  await waitFor((m) => m.event === "output" && m.body.output === "count 3 of 7\n", "logpoint 3");
  state = await topFrame(stopped.body.threadId);
  assert.strictEqual(state.frames[0].line, 6);
  await request("continue", { threadId: stopped.body.threadId });
  stopped = await event("stopped");
  state = await topFrame(stopped.body.threadId);
  assert.strictEqual(state.frames[0].line, 7);
  assert.strictEqual(state.frames[0].name, "Box.twice");
  assert.strictEqual(state.frames[1].name, "Dbg.main");
  assert.strictEqual(state.frames[1].line, 32);
  assert.strictEqual(state.variables.k.value, "3");
  assert.strictEqual(state.variables.doubled.value, "30");
  assert.ok(state.variables.this.value.startsWith("Box("), state.variables.this.value);
  assert.strictEqual(state.variables.this.type, "Box");
  assert.deepStrictEqual(await childValues(state.variables.this.variablesReference), ["n=5", "tags=[1, 2]"]);
  assert.strictEqual((await request("evaluate", { frameId: state.frames[0].id, expression: "this.n * k", context: "hover" })).result, "15");
  assert.strictEqual((await request("evaluate", { frameId: state.frames[0].id, expression: "n = 5 and doubled > 20", context: "watch" })).result, "true");

  // the caught exception stops where it is thrown, with the kind and message a catch variable gets
  await request("continue", { threadId: stopped.body.threadId });
  stopped = await event("stopped");
  assert.strictEqual(stopped.body.reason, "exception");
  state = await topFrame(stopped.body.threadId);
  assert.strictEqual(state.frames[0].line, 16);
  assert.strictEqual(state.frames[0].name, "Dbg.risky");
  const info = await request("exceptionInfo", { threadId: stopped.body.threadId });
  assert.strictEqual(info.exceptionId, "ArithmeticException");
  assert.strictEqual(info.description, "/ by zero");
  assert.strictEqual(info.breakMode, "always");

  // stepping goes into the catch
  await request("next", { threadId: stopped.body.threadId });
  stopped = await event("stopped");
  assert.strictEqual(stopped.body.reason, "step");
  state = await topFrame(stopped.body.threadId);
  assert.ok([17, 18].includes(state.frames[0].line), "after the throw: line " + state.frames[0].line);

  // run to the end: the program's output arrives, then the session ends with the exit code
  await request("continue", { threadId: stopped.body.threadId });
  const output = await waitFor((m) => m.type === "event" && m.event === "output" && /twice: 30/.test(m.body.output), "program output");
  assert.ok(output.body.output.includes("safe: -1"), output.body.output);
  const exited = await event("exited");
  assert.strictEqual(exited.body.exitCode, 0);
  await event("terminated");
  await request("disconnect", {});

  // run without debugging
  const plain = newSession();
  await plain.request("initialize", {});
  await plain.request("launch", { program, compilerPath: felidae, noDebug: true });
  await plain.waitFor((m) => m.type === "event" && m.event === "output" && /loops: 6/.test(m.body.output), "noDebug output");
  await plain.event("terminated");
  console.log("debug session: 2 scenarios passed");
  process.exit(0);
})().catch(async (error) => {
  console.error("FAILED:", error && error.stack || error);
  try { await session.handleMessage({ seq: 999, type: "request", command: "disconnect", arguments: {} }); } catch { /* ignore */ }
  process.exit(1);
});
