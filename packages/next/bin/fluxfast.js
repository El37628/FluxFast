#!/usr/bin/env node

const { runCli } = require("../dist/cli/index.js");

process.exitCode = runCli(process.argv.slice(2));
