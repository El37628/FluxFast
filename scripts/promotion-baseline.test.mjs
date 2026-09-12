import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../packages/next/dist/cli/index.js";

const repositoryRoot = new URL("../", import.meta.url);
const baseline = JSON.parse(
  fs.readFileSync(
    new URL("tests/fixtures/public-api-v0.9.0.json", repositoryRoot),
    "utf8"
  )
);

function read(name) {
  return fs.readFileSync(new URL(name, repositoryRoot), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namedString(source, name) {
  const match = new RegExp(
    `${escapeRegExp(name)}[^=\\n]*=\\s*["']([^"']+)["']`
  ).exec(source);
  assert.ok(match, `missing string assignment for ${name}`);
  return match[1];
}

function stabilityFacts() {
  const source = read("docs/stability.md");
  const section = source
    .split("<!-- stability-facts:start -->", 2)[1]
    ?.split("<!-- stability-facts:end -->", 1)[0];
  assert.notEqual(section, undefined, "missing stability fact markers");
  const block = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, "missing JSON stability fact block");
  return JSON.parse(block[1]);
}

function javascriptCliSurface() {
  const stdout = [];
  const stderr = [];
  const exitCode = runCli(["--help"], {
    cwd: fileURLToPath(repositoryRoot),
    stdout: message => stdout.push(message),
    stderr: message => stderr.push(message),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(stderr, []);

  const commands = new Map();
  for (const line of stdout.join("\n").split("\n")) {
    const match = /^\s*fluxfast\s+([a-z][a-z-]*)(.*)$/.exec(line);
    if (!match) continue;
    const options = commands.get(match[1]) ?? new Set();
    for (const option of match[2].matchAll(/--[a-z-]+/g)) {
      options.add(option[0]);
    }
    commands.set(match[1], options);
  }

  return {
    commands: Object.fromEntries(
      [...commands.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, options]) => [name, { options: [...options].sort() }])
    ),
  };
}

function documentedEnvironmentVariables() {
  const source = read("docs/production.md");
  const section = source
    .split("### Canonical environment-variable inventory", 2)[1]
    ?.split("`NODE_ENV`", 1)[0];
  assert.notEqual(section, undefined, "missing environment-variable inventory");
  return Object.fromEntries(
    [...section.matchAll(/^\| `([^`]+)` \| ([^|]+?) \|/gm)]
      .map(match => [match[1], match[2].trim()])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function documentedRequestHeaders() {
  const source = read("docs/protocol.md");
  const section = source
    .split("### Request header contract", 2)[1]
    ?.split("## Page envelope", 1)[0];
  assert.notEqual(section, undefined, "missing request header contract");
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)]
    .map(match => match[1])
    .sort();
}

function generatedFilesFromRuntime() {
  const source = read("packages/next/src/generate.ts");
  return [
    ...new Set(
      [
        ...source.matchAll(
          /["'](?:[^"']*\/)?([a-z]+\.generated\.(?:json|ts))["']/g
        ),
      ].map(match => match[1])
    ),
  ].sort();
}

test("identifies the exact v0.9.0 promotion baseline", () => {
  assert.equal(baseline.version, "0.9.0");
});

test("freezes the JavaScript CLI surface adopted from v0.9.0", () => {
  assert.deepEqual(javascriptCliSurface(), baseline.contracts.javascriptCli);
});

test("freezes the documented environment-variable inventory", () => {
  assert.deepEqual(
    documentedEnvironmentVariables(),
    baseline.contracts.environmentVariables
  );
});

test("freezes protocol constants and request headers across code and docs", () => {
  const protocol = baseline.contracts.protocol;
  const coreProtocol = read("packages/core/src/protocol.ts");
  const coreCapabilities = read("packages/core/src/capabilities.ts");
  const liveProtocol = read("packages/core/src/live/protocol.ts");

  assert.equal(namedString(coreProtocol, "PROTOCOL_VERSION"), protocol.version);
  assert.equal(
    namedString(coreProtocol, "PROTOCOL_MEDIA_TYPE"),
    protocol.mediaType
  );
  assert.deepEqual(
    ["CAPABILITY_DEFERRED_RESOURCES", "CAPABILITY_LIVE_RESOURCES"].map(name =>
      namedString(coreCapabilities, name)
    ),
    protocol.capabilities
  );
  assert.equal(
    namedString(liveProtocol, "LIVE_EVENT_NAME"),
    protocol.liveEventName
  );
  assert.deepEqual(documentedRequestHeaders(), protocol.requestHeaders);

  const facts = stabilityFacts();
  assert.equal(facts.protocolVersion, protocol.version);
  assert.deepEqual(facts.capabilities, protocol.capabilities);
});

test("freezes schema constants and generated filenames across code and docs", () => {
  const schema = baseline.contracts.schema;
  const nextSchema = read("packages/next/src/schema-manifest.ts");
  const v1 = namedString(nextSchema, "FLUXFAST_SCHEMA_MANIFEST_V1");
  const v2 = namedString(nextSchema, "FLUXFAST_SCHEMA_MANIFEST_V2");
  assert.deepEqual(
    {
      FLUXFAST_SCHEMA_MANIFEST_V1: v1,
      FLUXFAST_SCHEMA_MANIFEST_V2: v2,
      FLUXFAST_SCHEMA_MANIFEST_VERSION: v1,
    },
    schema.javascriptConstants
  );
  assert.deepEqual(
    generatedFilesFromRuntime(),
    baseline.contracts.generatedFiles
  );

  const facts = stabilityFacts();
  assert.deepEqual(facts.schema, {
    readable: schema.readable,
    produced: schema.produced,
  });
  assert.deepEqual(facts.generatedFiles, baseline.contracts.generatedFiles);
});
