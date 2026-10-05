// Stand-in for `felidae program.fx --query "expression."`: same arguments, the
// same stdout / stderr / exit-code behaviour. The expression picks the outcome.
const [, flag, expression = ""] = process.argv.slice(2);
const wantsMetrics = process.argv.includes("--metrics-json");
// Same shape as the interpreter's block: stderr, newlines before the commas.
const metricsBlock = () => process.stderr.write(
  'FELIDAE_METRICS {"loadMs":12.5\n,"executionMs":0.8\n,"queryRuns":1\n,"firstQueryMs":0.7\n,"repeatedQueryAverageMs":0\n,' +
  '"runtime":{"durableStore":true,"clauseAttempts":4,"unificationAttempts":9,"factCandidates":3,"rocksPointReads":1,' +
  '"rocksTypeScans":0,"rocksFullScans":2,"rocksIndexScans":0,"rocksLinkScans":0,"rocksFactRowsScanned":120,' +
  '"rocksIndexRowsScanned":0,"rocksLinksVisited":0,"rocksFactWrites":1,"rocksLinkWrites":0,"solutionMaterializations":2,' +
  '"moduleLoads":1,"parserTokensLexed":300,"streamedModuleMicros":2500,"dispatchCacheHits":9,"dispatchCacheMisses":1}}\n');
if (flag !== "--query") {
  process.stderr.write("error: Unknown option: " + flag + "\n");
  process.exit(1);
}
if (expression.startsWith("fail")) {
  process.stderr.write("error: boom at line 1, column 2\n");
  process.exit(1);
} else if (expression.startsWith("hang")) {
  setInterval(() => {}, 1000);
} else if (expression.startsWith("slow")) {
  setTimeout(() => console.log("slow done"), 150);
} else if (expression.startsWith("print")) {
  console.log("hello");
  console.log("42");
} else {
  console.log("echo:" + expression);
  if (wantsMetrics) metricsBlock();
}
