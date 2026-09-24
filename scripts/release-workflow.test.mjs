import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
const repositoryDirectory = new URL("../", import.meta.url);

function readWorkflow(name) {
  return readFileSync(new URL(name, workflowDirectory), "utf8");
}

function readRepositoryFile(name) {
  return readFileSync(new URL(name, repositoryDirectory), "utf8");
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

test("freezes release artifact metadata, contents, digests, and provenance", () => {
  const smoke = readWorkflow("release-smoke.yml");
  assert.match(smoke, /permissions:\n  contents: read/);
  const artifactContract = jobBlock(smoke, "artifact-contract");
  assert.match(artifactContract, /name: Four-distribution contract/);
  assert.match(artifactContract, /python -m build/);
  assert.equal(artifactContract.match(/npm pack \.\/packages\//g)?.length, 2);
  assert.match(artifactContract, /scripts\/verify_release_artifacts\.py/);
  assert.match(artifactContract, /--write-checksums/);
  assert.match(artifactContract, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(artifactContract, /name: fluxfast-v1-candidate/);
  assert.match(artifactContract, /compression-level: 0/);

  const release = readWorkflow("release.yml");
  const build = jobBlock(release, "build");
  assert.match(build, /scripts\/verify_release_artifacts\.py/);
  assert.match(build, /--version "\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(build, /name: release-checksums/);
  assert.match(build, /path: release\/SHA256SUMS/);

  const pypi = jobBlock(release, "publish-pypi");
  assert.match(pypi, /id-token: write/);
  assert.match(pypi, /attestations: true/);

  const npm = jobBlock(release, "publish-npm");
  assert.match(npm, /id-token: write/);
  assert.match(npm, /npm publish "\$tarball"[\s\S]*--provenance/);

  const githubRelease = jobBlock(release, "github-release");
  assert.match(githubRelease, /name: release-checksums/);
  assert.match(githubRelease, /release\/SHA256SUMS/);

  for (const workflow of [smoke, release]) {
    for (const match of workflow.matchAll(/^\s+- uses: (?!\.\/)(\S+)$/gm)) {
      assert.match(
        match[1],
        /^[^@]+@[0-9a-f]{40}\/?.*$/,
        `release action is not pinned by commit: ${match[1]}`
      );
    }
  }
});

test("runs full production and distributed consumers from one packed v1 candidate", () => {
  const workflow = readWorkflow("release-smoke.yml");
  const production = jobBlock(workflow, "clean-production-consumer");
  assert.match(production, /name: Clean production consumer/);
  assert.match(production, /needs: artifact-contract/);
  assert.match(production, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(production, /name: fluxfast-v1-candidate/);
  assert.match(production, /sha256sum --check SHA256SUMS/);
  assert.match(production, /scripts\/test_sdist_consumer\.py/);
  assert.doesNotMatch(production, /python -m build/);
  assert.doesNotMatch(production, /npm pack \.\/packages\//);
  assert.match(production, /Verify the full packed v1\.0 release-candidate lifecycle/);
  assert.match(production, /FLUXFAST_ARTIFACT_DIR:/);
  assert.match(production, /FLUXFAST_RUN_PRODUCTION: "1"/);
  assert.match(production, /pnpm test:consumer:init/);

  const distributed = jobBlock(workflow, "clean-distributed-consumer");
  assert.match(distributed, /name: Clean distributed consumer/);
  assert.match(distributed, /needs: artifact-contract/);
  assert.match(distributed, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(distributed, /name: fluxfast-v1-candidate/);
  assert.match(distributed, /sha256sum --check SHA256SUMS/);
  assert.doesNotMatch(distributed, /python -m build/);
  assert.doesNotMatch(distributed, /npm pack \.\/packages\//);
  assert.match(distributed, /FLUXFAST_RUN_DISTRIBUTED: "1"/);
  assert.match(distributed, /pnpm test:consumer:init/);

  const initializer = readRepositoryFile("scripts/test-next-init-consumer.mjs");
  assert.match(initializer, /"fluxfast", "init", "--yes"/);
  assert.match(initializer, /typedGenerationArgs\(\{ check: true \}\)/);
  assert.match(initializer, /"build",\n\s+"--app"/);
  assert.match(initializer, /installedCoreVersion,\n\s+installedNextVersion/);
  assert.match(initializer, /assert version\('fluxfast'\) == sys\.argv\[1\]/);
  assert.match(initializer, /FLUXFAST_CONSUMER_PRODUCTION: "1"/);

  const runtime = readRepositoryFile("scripts/test-next-init-live.mjs");
  assert.match(runtime, /assert\.match\(html, \/Clean live consumer\//);
  assert.match(runtime, /second\.goBack\(\)/);
  assert.match(runtime, /protocolVisitsBeforeHistory/);
  assert.match(runtime, /omitted from the navigation delta/);
  assert.match(runtime, /Postcode is not serviceable/);
  assert.match(runtime, /pathname === "\/increment"/);
  assert.match(runtime, /"\/reports\/quarterly"/);
  assert.match(runtime, /FLUXFAST_CONSUMER_PRODUCTION/);

  const distributedRuntime = readRepositoryFile(
    "scripts/test-next-init-distributed.mjs"
  );
  assert.match(distributedRuntime, /production \? "start" : "dev"/);
  assert.match(distributedRuntime, /scenarioCompleted = true/);
  assert.match(distributedRuntime, /packed distributed processes did not stop after SIGTERM/);
  assert.match(distributedRuntime, /packed distributed process remained on port/);
});

test("v1.0 compatibility gates exercise both v0.9.0 upgrade orders and rollback", () => {
  const branchSmoke = jobBlock(readWorkflow("release-smoke.yml"), "mixed-version-consumers");
  assert.match(branchSmoke, /name: v0\.9\.0 adjacent upgrade and rollback compatibility/);
  assert.equal(
    branchSmoke.match(/FLUXFAST_PREVIOUS_VERSION: 0\.9\.0/g)?.length,
    2
  );
  assert.match(branchSmoke, /Verify historical Python candidate with JavaScript 0\.8\.1/);
  assert.equal(
    branchSmoke.match(/FLUXFAST_PREVIOUS_VERSION: 0\.8\.1/g)?.length,
    1
  );
  assert.equal(branchSmoke.match(/FLUXFAST_UPGRADE_SEQUENCE: "1"/g)?.length, 2);
  assert.equal(branchSmoke.match(/FLUXFAST_CURRENT_PYTHON_SPEC=/g)?.length, 2);
  assert.equal(branchSmoke.match(/FLUXFAST_CURRENT_CORE_SPEC=/g)?.length, 2);
  assert.equal(branchSmoke.match(/FLUXFAST_CURRENT_NEXT_SPEC=/g)?.length, 2);
  assert.doesNotMatch(branchSmoke, /0\.8\.0/);

  const publishedSmoke = jobBlock(
    readWorkflow("release.yml"),
    "verify-published-mixed-version"
  );
  assert.match(
    publishedSmoke,
    /Verify published v1\.0\/v0\.9\.0 upgrade and rollback/
  );
  assert.equal(
    publishedSmoke.match(/FLUXFAST_PREVIOUS_VERSION: 0\.9\.0/g)?.length,
    2
  );
  assert.match(publishedSmoke, /playwright@1\.63\.0/);
  assert.equal(publishedSmoke.match(/FLUXFAST_UPGRADE_SEQUENCE: "1"/g)?.length, 2);
  assert.doesNotMatch(publishedSmoke, /0\.8\.1/);
});

test("freezes the v0.9 runtime support matrix in metadata and CI", () => {
  const rootPackage = JSON.parse(readRepositoryFile("package.json"));
  const corePackage = JSON.parse(readRepositoryFile("packages/core/package.json"));
  const nextPackage = JSON.parse(readRepositoryFile("packages/next/package.json"));

  for (const manifest of [rootPackage, corePackage, nextPackage]) {
    assert.equal(manifest.engines.node, "^22.0.0 || ^24.0.0");
  }
  assert.deepEqual(nextPackage.peerDependencies, {
    next: ">=16.3.0 <17.0.0",
    react: ">=19.0.0",
    "react-dom": ">=19.0.0",
  });
  assert.match(
    readRepositoryFile("python/fluxfast/pyproject.toml"),
    /^requires-python = ">=3\.11"$/m
  );

  assert.match(
    readWorkflow("python.yml"),
    /python-version: \["3\.11", "3\.12", "3\.13", "3\.14"\]/
  );
  assert.match(readWorkflow("javascript.yml"), /node-version: \[22, 24\]/);

  const releaseSmoke = jobBlock(
    readWorkflow("release-smoke.yml"),
    "javascript-consumer"
  );
  assert.match(
    releaseSmoke,
    /- label: Next\.js 16\.3\.0 \/ React 19\.0\.0\n\s+node-version: 22\n\s+next-version: "16\.3\.0"\n\s+react-version: "19\.0\.0"/
  );
  assert.match(
    releaseSmoke,
    /- label: Latest compatible Next\.js 16 \/ React 19\n\s+node-version: 24\n\s+next-version: "\^16\.3\.0"\n\s+react-version: "\^19\.0\.0"/
  );
  assert.match(
    releaseSmoke,
    /"dependencies\.next=\$\{\{ matrix\.next-version \}\}"/
  );
  assert.match(
    releaseSmoke,
    /"dependencies\.react=\$\{\{ matrix\.react-version \}\}"/
  );
  assert.match(
    releaseSmoke,
    /"dependencies\.react-dom=\$\{\{ matrix\.react-version \}\}"/
  );
});

test("audit steps fail closed on upstream registry outages in CI", () => {
  const security = readWorkflow("security.yml");
  const release = readWorkflow("release.yml");
  for (const source of [security, release]) {
    assert.match(source, /pnpm audit --audit-level high/);
    assert.doesNotMatch(source, /--ignore-registry-errors/);
  }
});
