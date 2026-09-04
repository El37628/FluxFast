import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);

function readWorkflow(name) {
  return readFileSync(new URL(name, workflowDirectory), "utf8");
}

function jobBlock(source, name) {
  const marker = `\n  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} job`);
  const contentStart = start + marker.length;
  const nextJob = source.slice(contentStart).search(/^  [a-z][a-z0-9-]*:\n/m);
  return nextJob === -1
    ? source.slice(contentStart)
    : source.slice(contentStart, contentStart + nextJob);
}

test("release gates reuse the branch workflows without duplicate tag runs", () => {
  const reusableWorkflows = [
    "javascript.yml",
    "python.yml",
    "integration.yml",
    "container.yml",
    "release-smoke.yml",
  ];

  for (const name of reusableWorkflows) {
    const source = readWorkflow(name);
    assert.match(source, /\n  push:\n    branches: \["\*\*"\]\n/);
    assert.match(source, /\n  workflow_call:\n/);
  }
});

test("release publication waits for full production and container CI", () => {
  const source = readWorkflow("release.yml");

  assert.match(
    jobBlock(source, "javascript-ci"),
    /uses: \.\/\.github\/workflows\/javascript\.yml/
  );
  assert.match(
    jobBlock(source, "python-ci"),
    /uses: \.\/\.github\/workflows\/python\.yml/
  );
  assert.match(
    jobBlock(source, "release-artifacts-ci"),
    /uses: \.\/\.github\/workflows\/release-smoke\.yml/
  );

  const integration = jobBlock(source, "integration-ci");
  assert.match(integration, /needs: \[javascript-ci, python-ci\]/);
  assert.match(integration, /uses: \.\/\.github\/workflows\/integration\.yml/);

  const containers = jobBlock(source, "container-ci");
  assert.match(containers, /needs: integration-ci/);
  assert.match(containers, /uses: \.\/\.github\/workflows\/container\.yml/);

  assert.match(
    jobBlock(source, "build"),
    /needs: \[container-ci, release-artifacts-ci\]/
  );
  assert.match(jobBlock(source, "publish-pypi"), /needs: build/);
  assert.match(jobBlock(source, "publish-npm"), /needs: build/);

  const githubRelease = jobBlock(source, "github-release");
  assert.match(githubRelease, /- verify-published-production/);
  assert.match(githubRelease, /- verify-published-mixed-version/);
});

test("v0.8 compatibility gates use the adjacent v0.7 release", () => {
  const branchSmoke = jobBlock(readWorkflow("release-smoke.yml"), "mixed-version-consumers");
  assert.match(branchSmoke, /published v0\.7/);
  assert.equal(
    branchSmoke.match(/FLUXFAST_PREVIOUS_VERSION: 0\.7\.0/g)?.length,
    2
  );
  assert.doesNotMatch(branchSmoke, /0\.6\.0/);

  const publishedSmoke = jobBlock(
    readWorkflow("release.yml"),
    "verify-published-mixed-version"
  );
  assert.match(publishedSmoke, /Verify published 0\.8\/0\.7 package pairings/);
  assert.equal(
    publishedSmoke.match(/FLUXFAST_PREVIOUS_VERSION: 0\.7\.0/g)?.length,
    2
  );
  assert.doesNotMatch(publishedSmoke, /0\.6\.0/);
});

test("audit steps ignore upstream registry outages in CI", () => {
  const security = readWorkflow("security.yml");
  assert.match(
    security,
    /pnpm audit --audit-level high --ignore-registry-errors/
  );

  const release = readWorkflow("release.yml");
  assert.match(
    release,
    /pnpm audit --audit-level high --ignore-registry-errors/
  );
});
