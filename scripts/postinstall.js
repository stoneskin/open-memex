#!/usr/bin/env node
// D50: `npm install -g open-memex` only puts the CLI on PATH — the editor
// wiring is `init`'s job. postinstall must never prompt (it runs in CI,
// Docker builds and `npm ci` where stdin isn't a terminal), so this only
// prints the pointer. Plain JS, no dependencies.
console.log(
  "\nopen-memex installed. Run `open-memex init` to wire it into your editors — " +
    "it auto-detects VS Code, Cursor and opencode (and Visual Studio for solution projects).\n",
);
