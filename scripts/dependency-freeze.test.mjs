import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), "utf8");

function freezeFacts() {
  const section = read("docs/releases/v1.0-dependency-freeze.md")
    .split("<!-- dependency-freeze-facts:start -->", 2)[1]
    ?.split("<!-- dependency-freeze-facts:end -->", 1)[0];
  assert.notEqual(section, undefined, "missing dependency freeze facts");
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, "missing dependency freeze JSON block");
  return JSON.parse(match[1]);
}

// Inspect the existing block-style configuration/lock mappings without adding
// a YAML runtime dependency. Fail closed when the expected structure changes.
function mappingBlock(source, key, indent) {
  source = `\n${source}`;
  const marker = `\n${" ".repeat(indent)}${key}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing mapping: ${key}`);
  const remaining = source.slice(start + marker.length);
  const boundary = remaining.search(new RegExp(`^ {0,${indent}}\\S`, "m"));
  return boundary === -1 ? remaining : remaining.slice(0, boundary);
}

test("defers routine majors without suppressing security updates", () => {
  const config = read(".github/dependabot.yml");
  assert.match(config, /^version: 2\n/);
  const entries = config.split("  - package-ecosystem: ").slice(1);
  assert.deepEqual(entries.map(entry => entry.split("\n", 1)[0]), [
    "npm", "pip", "github-actions",
  ]);
  const groupNames = [
    "javascript-dependencies", "python-dependencies", "workflow-actions",
  ];
  const allowRule = [
    '      - dependency-name: "*"',
    '        update-types: ["version-update:semver-patch", "version-update:semver-minor"]',
  ].join("\n");

  for (const [index, entry] of entries.entries()) {
    assert.match(entry, /\n    schedule:\n      interval: weekly\n/);
    assert.equal(mappingBlock(entry, "allow", 4).trimEnd(), allowRule);
    assert.equal(
      mappingBlock(entry, "groups", 4).trimEnd(),
      [
        `      ${groupNames[index]}:`,
        "        applies-to: version-updates",
        '        patterns: ["*"]',
        "        update-types: [patch, minor]",
      ].join("\n")
    );
    assert.doesNotMatch(entry, /\n    (?:target-branch|open-pull-requests-limit):/);
  }
  assert.match(entries[0], /dependency-name: "@types\/node"\n        update-types: \["version-update:semver-major"\]/);
  assert.ok(!entries.slice(1).some(entry => /\n    ignore:/.test(entry)));
});

test("keeps all workspace tooling and runtime resolutions on the reviewed set", () => {
  const facts = freezeFacts();
  assert.equal(facts.baseline, "v0.9.0");
  assert.deepEqual(Object.keys(facts.javascriptTooling).sort(), [
    "@playwright/test", "@types/node", "@types/react", "@types/react-dom",
    "happy-dom", "typescript", "vitest",
  ]);
  assert.deepEqual(Object.keys(facts.javascriptRuntime).sort(), [
    "next", "react", "react-dom",
  ]);
  assert.deepEqual(facts.javascriptTransitive, { rollup: "4.63.2" });
  const frozen = { ...facts.javascriptTooling, ...facts.javascriptRuntime };
  const seen = new Set();
  const lock = read("pnpm-lock.yaml");

  for (const importer of [".", "packages/core", "packages/next", "tests/browser/frontend"]) {
    const manifest = JSON.parse(read(`${importer}/package.json`));
    const importerSource = mappingBlock(lock, importer, 2);
    for (const group of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(manifest[group] ?? {})) {
        if (!Object.hasOwn(frozen, name)) continue;
        const groupSource = mappingBlock(importerSource, group, 4);
        const key = name.startsWith("@") ? `'${name}'` : name;
        const dependencySource = mappingBlock(groupSource, key, 6);
        const version = dependencySource.match(/^        version: ([\d.]+)(?:\(|$)/m)?.[1];
        assert.equal(version, frozen[name], `${importer} ${name}: reviewed resolution changed`);
        seen.add(name);
      }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(frozen).sort());
  assert.equal(JSON.parse(read("package.json")).pnpm.overrides["@types/node"], frozen["@types/node"]);
  assert.match(lock, new RegExp(`^  rollup@${facts.javascriptTransitive.rollup}:$`, "m"));
});

test("records the actual Python lock reference", () => {
  const facts = freezeFacts();
  assert.deepEqual(Object.keys(facts.pythonReference).sort(), [
    "anyio", "fastapi", "httpx2", "pydantic", "pytest", "ruff", "starlette", "uvicorn",
  ]);
  const packages = Object.fromEntries(
    [...read("python/fluxfast/uv.lock").matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)]
      .map(match => [match[1], match[2]])
  );
  for (const [name, version] of Object.entries(facts.pythonReference)) {
    assert.equal(packages[name], version, `${name}: Python reference changed`);
  }
});

test("retains security audit thresholds and the documented freeze policy", () => {
  const security = read(".github/workflows/security.yml");
  assert.match(security, /pnpm audit --audit-level high/);
  assert.match(security, /pip_audit python\/fluxfast --strict/);
  assert.match(security, /fail-on-severity: moderate/);
  assert.match(security, /schedule:\n    - cron:/);
  assert.match(read("docs/releasing.md"), /releases\/v1\.0-dependency-freeze\.md/);
  assert.match(read("docs/releases/v1.0-dependency-freeze.md"), /not security updates/);
});
