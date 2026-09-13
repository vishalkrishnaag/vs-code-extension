// Focused source-level launch regressions; transpilation stays in memory.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const vscode = require('./vscode-stub');
const outputs = [];
vscode.EventEmitter = class {
  event = () => ({ dispose() {} });
  fire(message) { outputs.push(message); }
  dispose() {}
};
const children = [];
const processStub = {
  spawn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.writes = [];
    child.stdin = { write(line) {
      child.writes.push(line);
      if (line === 'locals\n') queueMicrotask(() => child.stdout.emit('data',
        Buffer.from('FELIDAE_DEBUG_LOCALS_BEGIN\nanswer = 42\nFELIDAE_DEBUG_LOCALS_END\n')));
    } };
    child.kill = () => {};
    children.push(child);
    return child;
  }
};
const previousLoad = Module._load;
Module._load = function(name, parent, main) {
  if (name === 'vscode') return vscode;
  if (name === 'child_process') return processStub;
  if (name === './languageClient' || name === './mlRanking') return {};
  return previousLoad.call(this, name, parent, main);
};
const sourceDir = path.resolve(__dirname, '../src');
const previousTs = Module._extensions['.ts'];
Module._extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(
  fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
).outputText, filename);
const filename = path.join(sourceDir, 'extension.ts');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(sourceDir);
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8') +
  '\nexport { FelidaeDebugAdapter, runInTerminal };',
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
).outputText, filename);
Module._load = previousLoad;
Module._extensions['.ts'] = previousTs;
const { FelidaeDebugAdapter, runInTerminal } = mod.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (adapter, command, args = {}, seq = 1) => adapter.handleMessage({
  type: 'request', command, arguments: args, seq
});

(async () => {
  for (const stopOnEntry of [true, false]) {
    outputs.length = 0;
    const adapter = new FelidaeDebugAdapter();
    request(adapter, 'setBreakpoints', { breakpoints: [{ line: 7 }] });
    request(adapter, 'launch', { interpreterPath: '/felidae', program: '/sample.fx', stopOnEntry });
    request(adapter, 'configurationDone');
    const child = children.at(-1);
    child.stdout.emit('data', Buffer.from('FELIDAE_DEBUG_STOPPED reason=step line=3\n'));
    await tick();
    assert(child.writes.includes('break 7\n'), 'pre-launch breakpoint retained');
    assert.equal(child.writes.includes('continue\n'), !stopOnEntry);
    request(adapter, 'evaluate', { expression: 'answer' }, 10);
    request(adapter, 'evaluate', { expression: 'answer' }, 11);
    await tick();
    for (const seq of [10, 11]) assert.equal(outputs.find(x => x.request_seq === seq).body.result, '42');
    request(adapter, 'evaluate', { expression: '? Fact(x: x)' }, 12);
    assert.equal(outputs.find(x => x.request_seq === 12).success, false);
    child.emit('close', 0);
    await tick();
  }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    for (const os of ['win32', 'linux', 'darwin']) {
      Object.defineProperty(process, 'platform', { value: os });
      let options, command;
      vscode.window.createTerminal = opts => { options = opts; return { show() {}, sendText(text) { command = text; } }; };
      runInTerminal('/space dir/felidae', ['/a b.fx', '? Fact(value: "a&b!%PATH%")'], '/');
      if (os === 'win32') {
        assert(options.shellPath.toLowerCase().endsWith('cmd.exe'));
        assert.deepEqual(options.shellArgs, ['/d', '/v:on']);
        assert(!command.includes('a&b'), 'user input is carried in the environment');
        assert(options.env.FELIDAE_RUN_ARG_1.includes('\\"'));
      } else {
        assert.equal(options.shellPath, '/bin/sh');
        assert(command.startsWith("'/space dir/felidae'"));
        const payload = 'spaces, single\' and "double" quotes; $PATH & | ! %';
        runInTerminal('/usr/bin/printf', ['%s', payload], '/');
        if (platform.value !== 'win32')
          assert.equal(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }), payload);
      }
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
  outputs.length = 0;
  const failed = new FelidaeDebugAdapter();
  request(failed, 'launch', { interpreterPath: '/missing', program: '/sample.fx' }, 90);
  const child = children.at(-1);
  child.emit('error', new Error('ENOENT'));
  child.emit('close', -2);
  await tick();
  assert.equal(outputs.find(x => x.request_seq === 90).success, false);
  console.log('Launch, breakpoint, stopOnEntry, concurrent evaluation, and platform command checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
