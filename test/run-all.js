#!/usr/bin/env node
"use strict";
// Runs every checked-in verification for the VS Code extension.
//
//   npm test
//
// These are plain Node harnesses rather than @vscode/test-electron: they load
// out/extension.js against a stubbed `vscode` module and exercise the pure
// text-analysis providers directly. That covers the logic where this
// extension's bugs actually live - declaration scanning, signature
// resolution, folding, formatting - without needing to download and launch an
// Electron VS Code instance in CI.
//
// It does NOT cover extension activation, provider registration or anything
// requiring a real editor host; those still need a manual smoke test, or a
// future @vscode/test-electron suite.

const path = require("path");
const { execFileSync } = require("child_process");
const fs = require("fs");

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, "..", "..");

function corpusFiles() {
  const files = [];
  for (const dir of ["examples", "v2_examples"]) {
    const full = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith(".fx")) files.push(path.join(full, name));
    }
  }
  return files;
}

// The folding smoke check just needs one real corpus file - any v2 source
// of reasonable size must produce at least one fold region (see
// folding.test.js). Picking the first one corpusFiles() finds keeps this
// suite from rotting the way a single hardcoded filename already did once
// (examples/advanced_mortality_fact_reasoning.fx, from before the corpus
// moved to v2_examples/ - the file didn't move with it, it was retired
// outright, and nothing here noticed until this test failed).
const foldingCorpusFile = corpusFiles()[0];

const suites = [
  { name: "runtime launch and debugger", args: [path.join(HERE, "runtime.test.js")] },
  { name: "providers (rename/references/highlight)", args: [path.join(HERE, "providers.test.js")] },
  { name: "signature help + completion", args: [path.join(HERE, "signature.test.js")] },
  {
    name: "folding",
    args: [path.join(HERE, "folding.test.js"), ...(foldingCorpusFile ? [foldingCorpusFile] : [])]
  },
  {
    name: "formatter corpus (idempotency)",
    args: [path.join(HERE, "formatter.test.js"), path.join(HERE, "..", "out", "formatter.js"), ...corpusFiles()]
  }
];

let failed = 0;
for (const suite of suites) {
  process.stdout.write(`\n=== ${suite.name} ===\n`);
  try {
    const out = execFileSync(process.execPath, suite.args, {
      cwd: path.join(HERE, ".."),
      encoding: "utf8",
      env: { ...process.env }
    });
    // The formatter suite prints one line per file; only surface the summary
    // and any non-idempotent result, which is the invariant that must hold.
    const lines = out.trimEnd().split("\n");
    if (suite.name.startsWith("formatter")) {
      // Count per-file result lines specifically. Subtracting from
      // lines.length counted every other line the suite printed - diff
      // output, headers - as a "reformatted" file, so the reported figure
      // was larger than the number of files that even exist.
      const results = lines.filter((l) => l.includes("identical="));
      const identical = results.filter((l) => l.includes("identical=true")).length;
      const broken = lines.filter((l) => l.includes("NOT IDEMPOTENT"));
      console.log(
        `${results.length} files checked: ${identical} already canonical, ` +
        `${results.length - identical} reformatted`
      );
      if (broken.length) {
        broken.forEach((l) => console.log("  " + l));
        throw new Error(`${broken.length} file(s) are not idempotent`);
      }
      console.log("0 non-idempotent — invariant holds");
    } else {
      console.log(lines.slice(-1)[0]);
    }
  } catch (error) {
    failed++;
    console.log(`FAILED: ${error.stdout || error.message}`);
  }
}

console.log(
  failed === 0
    ? "\nall suites passed"
    : `\n${failed} suite(s) failed`
);
process.exit(failed === 0 ? 0 : 1);
