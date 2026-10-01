#!/usr/bin/env node

const { runCodegenCli } = require("../dist/cli/index.js");

process.exitCode = runCodegenCli(process.argv.slice(2));
