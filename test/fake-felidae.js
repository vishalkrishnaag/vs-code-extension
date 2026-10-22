// Stand-in for felidae running a generated cell program: one positional argument (the cell's
// expression, standing in for the content cellProgram would have written into the file - see
// cellRunner.ts/cellUi.ts), the same stdout / stderr / exit-code behaviour. The expression
// text picks the outcome.
const [expression = ""] = process.argv.slice(2);
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
} else if (expression.startsWith("unsupported")) {
  process.stderr.write("error: Unknown option: --nope\n");
  process.exit(1);
} else {
  console.log("echo:" + expression);
}
