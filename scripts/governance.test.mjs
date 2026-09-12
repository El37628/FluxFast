import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

function read(name) {
  return fs.readFileSync(new URL(name, repositoryRoot), "utf8");
}

function governanceFacts() {
  const source = read("docs/releasing.md");
  const section = source
    .split("<!-- governance-facts:start -->", 2)[1]
    ?.split("<!-- governance-facts:end -->", 1)[0];
  assert.notEqual(section, undefined, "missing governance fact markers");
  const block = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, "missing JSON governance fact block");
  return JSON.parse(block[1]);
}

function ruleset(name) {
  return JSON.parse(read(`.github/rulesets/${name}.json`));
}

function staticJobNames(source) {
  return [...source.matchAll(/^    name: ([^\n]+)$/gm)]
    .map(match => match[1].trim())
    .filter(name => !name.includes("${{"));
}

function matrixValues(source, key) {
  const match = new RegExp(`${key}: \\[([^\\]]+)\\]`).exec(source);
  assert.ok(match, `missing ${key} matrix`);
  return match[1]
    .split(",")
    .map(value => value.trim().replaceAll('"', ""));
}

function availableRequiredContexts() {
  const python = read(".github/workflows/python.yml");
  const javascript = read(".github/workflows/javascript.yml");
  const integration = read(".github/workflows/integration.yml");
  const release = read(".github/workflows/release-smoke.yml");
  const security = read(".github/workflows/security.yml");
  const codeql = read(".github/workflows/codeql.yml");
  const contexts = new Set(
    [python, javascript, integration, release, security, codeql].flatMap(
      staticJobNames
    )
  );

  for (const version of matrixValues(python, "python-version")) {
    contexts.add(`Python ${version}`);
  }
  for (const version of matrixValues(javascript, "node-version")) {
    contexts.add(`Node ${version}`);
  }
  for (const language of matrixValues(codeql, "language")) {
    contexts.add(`Analyze ${language}`);
  }
  if (/\n  protocol:\n/.test(integration)) contexts.add("protocol");
  return contexts;
}

test("documents only check contexts produced by pull-request workflows", () => {
  const facts = governanceFacts();
  const required = facts.mainRuleset.requiredChecks;
  const available = availableRequiredContexts();
  const main = ruleset("protect-main");
  const statusRule = main.rules.find(rule => rule.type === "required_status_checks");
  const pullRequestRule = main.rules.find(rule => rule.type === "pull_request");

  assert.equal(new Set(required).size, required.length);
  for (const context of required) {
    assert.ok(available.has(context), `required check is not produced: ${context}`);
  }
  assert.equal(main.name, facts.mainRuleset.name);
  assert.equal(main.target, "branch");
  assert.equal(main.enforcement, "active");
  assert.deepEqual(main.conditions.ref_name, {
    exclude: [],
    include: ["~DEFAULT_BRANCH"],
  });
  assert.equal(
    statusRule.parameters.strict_required_status_checks_policy,
    facts.mainRuleset.strict
  );
  assert.deepEqual(
    statusRule.parameters.required_status_checks.map(check => check.context),
    required
  );
  assert.ok(
    statusRule.parameters.required_status_checks.every(
      check => check.integration_id === 15368
    )
  );
  assert.equal(
    pullRequestRule.parameters.required_review_thread_resolution,
    facts.mainRuleset.reviewThreadsResolved
  );
  assert.equal(Boolean(pullRequestRule), facts.mainRuleset.pullRequestRequired);
});

test("keeps exhaustive diagnostics outside the required merge set", () => {
  const facts = governanceFacts();
  const required = new Set(facts.mainRuleset.requiredChecks);
  const exhaustive = facts.nonRequiredExhaustiveChecks;

  assert.equal(new Set(exhaustive).size, exhaustive.length);
  assert.deepEqual(exhaustive.filter(context => required.has(context)), []);
  assert.match(read(".github/workflows/benchmark.yml"), /on:\n  workflow_dispatch:/);
  assert.ok(!required.has("controlled-benchmark"));
});

test("keeps the documented release tag pattern aligned with automation", () => {
  const facts = governanceFacts();
  const tags = ruleset("protect-release-tags");
  assert.equal(facts.releaseTagRuleset.pattern, "refs/tags/v*.*.*");
  assert.match(read(".github/workflows/release.yml"), /- "v\*\.\*\.\*"/);
  assert.deepEqual(facts.releaseTagRuleset.rules, [
    "creation",
    "update",
    "deletion",
    "non_fast_forward",
  ]);
  assert.equal(tags.name, facts.releaseTagRuleset.name);
  assert.equal(tags.target, "tag");
  assert.equal(tags.enforcement, "active");
  assert.deepEqual(tags.conditions.ref_name.include, [
    facts.releaseTagRuleset.pattern,
  ]);
  assert.deepEqual(
    tags.rules.map(rule => rule.type),
    facts.releaseTagRuleset.rules
  );
});
