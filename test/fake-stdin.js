// Stand-in that reports what it received on stdin, to test the runner's stdin delivery.
let received = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (received += chunk));
process.stdin.on("end", () => console.log("stdin=" + received.length + " args=" + process.argv.slice(2).join(" ")));
