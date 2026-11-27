#!/usr/bin/env node
// Runs the prebuilt x-mcp binary for this platform (installed as an optional dependency).
// stdio is inherited, so MCP frames flow straight between the client and the binary.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const pkg = `@el4cteo/x-mcp-${process.platform}-${process.arch}`;
const exe = process.platform === "win32" ? "x-mcp.exe" : "x-mcp";
let bin;
try {
  bin = require.resolve(`${pkg}/bin/${exe}`);
} catch {
  console.error(
    `x-mcp: no prebuilt binary for ${process.platform}-${process.arch} (${pkg} isn't installed).\n` +
      "Reinstall without --omit=optional, or build it: cargo install x-twitter-mcp",
  );
  process.exit(1);
}
if (process.platform !== "win32") {
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // spawn reports EACCES if the file still isn't executable
  }
}
const child = spawn(bin, process.argv.slice(2), { stdio: "inherit", windowsHide: true });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`x-mcp: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
