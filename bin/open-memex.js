#!/usr/bin/env node
// `open-memex` bin launcher: re-execs src/cli.ts with TypeScript type-stripping
// enabled, so the command works on Node 22.6+ without the user passing
// --experimental-strip-types themselves. (Plain JS — no build step.)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "cli.ts",
);

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("error", (err) => {
  console.error(`open-memex: failed to start: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
