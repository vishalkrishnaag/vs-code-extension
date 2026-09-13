// Bundles src/extension.ts (and everything it imports, including
// vscode-languageclient) into one dist/extension.js. This is the fix for
// vsce's own "you should bundle your extension" warning: without it, the
// packaged VSIX ships node_modules verbatim - dependency-tree JS files a
// bundler would otherwise inline - which is what "565 files, 189 of them
// JavaScript" for four hand-written source files was actually counting.
//
// `vscode` is the one import left external: it isn't a real package, it's
// the API surface the VS Code host injects at load time, so bundling it is
// both impossible (there's nothing on disk to inline) and unnecessary.
//
// Usage: node esbuild.js [--watch] [--production]
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: ["vscode"],
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
