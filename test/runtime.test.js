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
const spawned = [];
const processStub = {
  spawn(command, args) {
    spawned.push([command, args]);
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
  if (name === './mlRanking') return {};
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
  // The debug session itself is checked end to end in debug.test.js; here: how a launch that never starts fails.
  outputs.length = 0;
  const missing = new FelidaeDebugAdapter();
  request(missing, 'launch', { compilerPath: '/missing', program: '/sample.fx' }, 90);
  children.at(-1).emit('error', new Error('ENOENT'));
  await tick();
  const refused = outputs.find(x => x.request_seq === 90);
  assert.equal(refused.success, false);
  assert(refused.message.includes('Cannot start /missing'), refused.message);

  outputs.length = 0;
  const failing = new FelidaeDebugAdapter();
  request(failing, 'launch', { compilerPath: '/felidae', program: '/sample.fx' }, 91);
  const compiler = children.at(-1);
  compiler.stderr.emit('data', Buffer.from('error: Cannot compare Integer and String at line 3, column 5\n'));
  compiler.emit('exit', 1);
  await tick();
  const failed = outputs.find(x => x.request_seq === 91);
  assert.equal(failed.success, false);
  assert(failed.message.includes('Cannot compare Integer and String'), failed.message);

  // the command line: felidae --debug --port 0 program
  assert.deepEqual(spawned.at(-1).slice(0, 2), ['/felidae', ['--debug', '--port', '0', '/sample.fx']]);
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
  console.log('Launch failure and platform command checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
