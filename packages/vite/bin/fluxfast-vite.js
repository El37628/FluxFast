#!/usr/bin/env node
"use strict";
if (process.argv[2] === "start" || process.argv[2] === "build") {
  if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== "production") {
    console.error("fluxfast-vite build/start require NODE_ENV=production (or unset).");
    process.exit(1);
  }
  process.env.NODE_ENV = "production";
}
const { runViteCli } = require("../dist/cli.js");
runViteCli(process.argv.slice(2)).then(code => { if (code) process.exitCode = code; }, () => { process.exitCode = 1; });
