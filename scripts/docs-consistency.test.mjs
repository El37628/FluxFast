import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

function read(name) {
  return fs.readFileSync(new URL(name, repositoryRoot), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function factsFromStabilityDocument() {
  const source = read("docs/stability.md");
  const start = "<!-- stability-facts:start -->";
  const end = "<!-- stability-facts:end -->";
  const section = source.split(start, 2)[1]?.split(end, 1)[0];
  assert.notEqual(section, undefined, "missing stability fact markers");
  const block = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, "missing JSON stability fact block");
  return JSON.parse(block[1]);
}

function inlineMatrix(source, key) {
  const match = new RegExp(`${escapeRegExp(key)}: \\[([^\\]]+)\\]`).exec(source);
  assert.ok(match, `missing ${key} inline matrix`);
  return [...match[1].matchAll(/"?([0-9]+(?:\.[0-9]+)?)"?/g)].map(
    value => value[1]
  );
}

function namedString(source, name) {
  const match = new RegExp(
    `${escapeRegExp(name)}[^=\\n]*=\\s*["']([^"']+)["']`
  ).exec(source);
  assert.ok(match, `missing string assignment for ${name}`);
  return match[1];
}

function quotedStrings(source) {
  return [...source.matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
}

function englishList(values) {
  assert.ok(values.length >= 2, "expected at least two documented values");
  if (values.length === 2) return values.join(" and ");
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function validationFormatsFromRuntime() {
  const source = read("packages/core/src/validation/formats.ts");
  const match = /export const VALIDATION_FORMATS = \[([\s\S]*?)\] as const;/.exec(
    source
  );
  assert.ok(match, "missing VALIDATION_FORMATS declaration");
  return quotedStrings(match[1]).toSorted();
}

function validationFormatsFromDocumentation() {
  const source = read("docs/validation.md");
  const match = /- Formats:\n([\s\S]*?)\n\n### Numbers/.exec(source);
  assert.ok(match, "missing documented validation format list");
  return [...match[1].matchAll(/`([^`]+)`/g)]
    .map(value => value[1])
    .toSorted();
}

function generatedFilesFromRuntime() {
  const source = read("packages/next/src/generate.ts");
  return [
    ...new Set(
      [...source.matchAll(/["'](?:[^"']*\/)?([a-z]+\.generated\.(?:json|ts))["']/g)]
        .map(match => match[1])
    ),
  ].toSorted();
}

function generatedFilesFromDocumentation() {
  const source = read("docs/generated-artifacts.md");
  const match = /## Stable filenames[\s\S]*?```text\n([\s\S]*?)\n```/.exec(source);
  assert.ok(match, "missing stable generated filename block");
  return match[1].split("\n").filter(Boolean).toSorted();
}

function nextEntryPointsFromDocumentation() {
  const source = read("docs/next-api.md");
  const paths = [...source.matchAll(/^\| `(@fluxfast\/next[^`]*)` \|/gm)].map(
    match => {
      const suffix = match[1].slice("@fluxfast/next".length);
      return suffix ? `.${suffix}` : ".";
    }
  );
  return [...new Set(paths)].toSorted();
}

const facts = factsFromStabilityDocument();

test("keeps documented runtime support aligned with metadata and CI", () => {
  const rootPackage = JSON.parse(read("package.json"));
  const corePackage = JSON.parse(read("packages/core/package.json"));
  const nextPackage = JSON.parse(read("packages/next/package.json"));
  const pythonVersions = inlineMatrix(
    read(".github/workflows/python.yml"),
    "python-version"
  );
  const nodeVersions = inlineMatrix(
    read(".github/workflows/javascript.yml"),
    "node-version"
  );

  assert.deepEqual(facts.runtime.python, pythonVersions);
  assert.deepEqual(facts.runtime.node, nodeVersions);
  assert.match(
    read("python/fluxfast/pyproject.toml"),
    new RegExp(
      `^requires-python = ">=${escapeRegExp(facts.runtime.python[0])}"$`,
      "m"
    )
  );

  const nodeEngine = facts.runtime.node
    .map(version => `^${version}.0.0`)
    .join(" || ");
  for (const manifest of [rootPackage, corePackage, nextPackage]) {
    assert.equal(manifest.engines.node, nodeEngine);
  }
  assert.equal(nextPackage.peerDependencies.next, facts.runtime.nextPeer);
  assert.equal(nextPackage.peerDependencies.react, facts.runtime.reactPeer);
  assert.equal(nextPackage.peerDependencies["react-dom"], facts.runtime.reactPeer);

  const versioning = read("docs/versioning.md");
  assert.ok(
    versioning.includes(`| Python | ${englishList(facts.runtime.python)} |`)
  );
  assert.ok(
    versioning.includes(`| Node.js | ${englishList(facts.runtime.node)} |`)
  );
  assert.ok(versioning.includes(`| Next.js | \`${facts.runtime.nextPeer}\` |`));
  assert.ok(
    versioning.includes(`| React and React DOM | \`${facts.runtime.reactPeer}\` |`)
  );

  const readme = read("README.md");
  assert.match(readme, /Next\.js 16 App Router/);
  assert.match(readme, /pip install fluxfast/);
  assert.match(readme, /npm install @fluxfast\/next/);
});

test("keeps protocol, schema, and capability names aligned across runtimes and docs", () => {
  const pythonProtocol = read("python/fluxfast/src/fluxfast/protocol.py");
  const coreProtocol = read("packages/core/src/protocol.ts");
  assert.equal(
    namedString(pythonProtocol, "PROTOCOL_VERSION"),
    facts.protocolVersion
  );
  assert.equal(namedString(coreProtocol, "PROTOCOL_VERSION"), facts.protocolVersion);

  const pythonSchema = read("python/fluxfast/src/fluxfast/schema_manifest.py");
  const nextSchema = read("packages/next/src/schema-manifest.ts");
  const pythonSchemaVersions = [
    namedString(pythonSchema, "SCHEMA_MANIFEST_V1"),
    namedString(pythonSchema, "SCHEMA_MANIFEST_V2"),
  ];
  const nextSchemaVersions = [
    namedString(nextSchema, "FLUXFAST_SCHEMA_MANIFEST_V1"),
    namedString(nextSchema, "FLUXFAST_SCHEMA_MANIFEST_V2"),
  ];
  assert.deepEqual(facts.schema.readable, pythonSchemaVersions);
  assert.deepEqual(facts.schema.readable, nextSchemaVersions);
  assert.equal(facts.schema.produced, pythonSchemaVersions[1]);

  const capabilityNames = [
    "CAPABILITY_DEFERRED_RESOURCES",
    "CAPABILITY_LIVE_RESOURCES",
  ];
  const pythonCapabilities = read("python/fluxfast/src/fluxfast/capabilities.py");
  const coreCapabilities = read("packages/core/src/capabilities.ts");
  assert.deepEqual(
    facts.capabilities,
    capabilityNames.map(name => namedString(pythonCapabilities, name))
  );
  assert.deepEqual(
    facts.capabilities,
    capabilityNames.map(name => namedString(coreCapabilities, name))
  );

  const protocol = read("docs/protocol.md");
  assert.ok(
    protocol.includes(`The wire protocol version is \`${facts.protocolVersion}\``)
  );
  assert.ok(
    protocol.includes(`X-FluxFast-Capabilities: ${facts.capabilities.join(",")}`)
  );

  const schema = read("docs/developer-schema.md");
  for (const version of facts.schema.readable) assert.ok(schema.includes(`\`${version}\``));
  assert.ok(schema.includes(`Python produces schema/2`));
});

test("keeps supported validation formats aligned with the runtime", () => {
  assert.deepEqual(
    facts.validationFormats.toSorted(),
    validationFormatsFromRuntime()
  );
  assert.deepEqual(
    facts.validationFormats.toSorted(),
    validationFormatsFromDocumentation()
  );
});

test("keeps generated filenames aligned with the generator and artifact contract", () => {
  assert.deepEqual(facts.generatedFiles.toSorted(), generatedFilesFromRuntime());
  assert.deepEqual(
    facts.generatedFiles.toSorted(),
    generatedFilesFromDocumentation()
  );
});

test("keeps public package entry points aligned with manifests and API docs", () => {
  const pythonProject = read("python/fluxfast/pyproject.toml");
  const pythonName = /^name = "([^"]+)"$/m.exec(pythonProject)?.[1];
  assert.equal(pythonName, "fluxfast");
  assert.deepEqual(facts.packageEntryPoints.fluxfast, [pythonName]);
  assert.ok(fs.existsSync(new URL("python/fluxfast/src/fluxfast/__init__.py", repositoryRoot)));
  assert.match(read("docs/python-api.md"), /top-level\n`fluxfast` package/);

  const corePackage = JSON.parse(read("packages/core/package.json"));
  const nextPackage = JSON.parse(read("packages/next/package.json"));
  assert.deepEqual(
    facts.packageEntryPoints["@fluxfast/core"].toSorted(),
    Object.keys(corePackage.exports).toSorted()
  );
  assert.deepEqual(
    facts.packageEntryPoints["@fluxfast/next"].toSorted(),
    Object.keys(nextPackage.exports).toSorted()
  );

  const coreApi = read("docs/core-api.md");
  assert.match(coreApi, /one public import\s+path/);
  assert.match(coreApi, /from "@fluxfast\/core"/);
  assert.deepEqual(
    facts.packageEntryPoints["@fluxfast/next"].toSorted(),
    nextEntryPointsFromDocumentation()
  );
});
