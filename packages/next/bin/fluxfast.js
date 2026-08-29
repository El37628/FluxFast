#!/usr/bin/env node

const { generatePagesRegistry } = require("../dist/generate.js");

const command = process.argv[2];

if (command === "generate" || !command) {
  generatePagesRegistry();
} else {
  console.log(`Unknown command: ${command}`);
  console.log("Usage: fluxfast generate");
  process.exit(1);
}

