import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const workflowDirectory = path.join(root, ".github/workflows");
const read = name => fs.readFileSync(path.join(root, name), "utf8");

function tomlArray(table, key) {
  const source = read("python/fluxfast/pyproject.toml");
  const tableStart = source.indexOf(`[${table}]`);
  assert.notEqual(tableStart, -1, `missing TOML table: ${table}`);
  const remainder = source.slice(tableStart + table.length + 2);
  const nextTable = remainder.search(/\n\[/);
  const body = nextTable === -1 ? remainder : remainder.slice(0, nextTable);
  const match = body.match(new RegExp(`(?:^|\\n)${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `missing TOML array: ${table}.${key}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1]);
}

function actionReferences(source) {
  return source.split("\n").flatMap(line => {
    const match = line.match(/^\s*(?:-\s+)?uses:\s*(.*?)\s*(?:\s+#.*)?$/);
    if (!match) return [];
    const value = match[1].replace(/^(["'])(.*)\1$/, "$2");
    return [value];
  });
}

function assertPinned(source, name) {
  const references = actionReferences(source);
  assert.ok(references.length > 0, `${name}: no action references inspected`);
  for (const reference of references) {
    if (reference.startsWith("./")) continue;
    assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/, `${name}: unpinned action ${reference}`);
  }
}

test("inspects every workflow action, including inline comments and job-level uses", () => {
  const files = fs.readdirSync(workflowDirectory).filter(name => /\.ya?ml$/.test(name));
  assert.ok(files.length >= 8);
  for (const file of files) assertPinned(fs.readFileSync(path.join(workflowDirectory, file), "utf8"), file);
});

test("action pin detection accepts exact commits but rejects mutable or short references", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(actionReferences(`      - uses: actions/checkout@${sha} # reviewed\n    uses: './.github/workflows/reusable.yml'\n`), [
    `actions/checkout@${sha}`, "./.github/workflows/reusable.yml",
  ]);
  assertPinned(`      - uses: actions/checkout@${sha} # reviewed\n`, "fixture");
  for (const ref of ["v7", "main", sha.slice(0, 7), `${sha}/suffix`, "${{ inputs.ref }}"]) {
    assert.throws(() => assertPinned(`      - uses: actions/checkout@${ref} # mutation\n`, "fixture"), /unpinned action/);
  }
});

test("PR and release audits retain mandatory full-dependency scans without suppression", () => {
  for (const name of ["security.yml", "release.yml"]) {
    const source = read(`.github/workflows/${name}`);
    assert.match(source, /pnpm audit --audit-level high/);
    assert.match(source, /python -m pip_audit --strict --progress-spinner off -r scripts\/security-requirements\.txt/);
    assert.doesNotMatch(source, /--ignore(?:-registry-errors|-unfixable|-vuln)?\b|--no-deps|--no-optional|--dry-run|continue-on-error:\s*true|\|\|\s*true/);
  }
  const auditedRequirements = read("scripts/security-requirements.txt")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
  assert.deepEqual(auditedRequirements, [
    ...tomlArray("project", "dependencies"),
    ...tomlArray("project.optional-dependencies", "redis"),
    ...tomlArray("project.optional-dependencies", "dev"),
  ]);
  assert.ok(auditedRequirements.every(requirement => !requirement.startsWith(".")));
  const security = read(".github/workflows/security.yml");
  assert.match(security, /fail-on-severity: moderate/);
  const codeql = read(".github/workflows/codeql.yml");
  assert.match(codeql, /language: \[javascript-typescript, python\]/);
  assert.match(codeql, /github\/codeql-action\/init@[0-9a-f]{40}/);
  assert.match(codeql, /github\/codeql-action\/analyze@[0-9a-f]{40}/);
});

function auditReport(severity) {
  const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  if (severity) vulnerabilities[severity] = 1;
  return {
    actions: [],
    advisories: severity ? {
      "999999": {
        id: 999999, severity, module_name: "vitest", title: "Synthetic audit regression",
        findings: [{ version: "4.1.11", paths: ["vitest"] }],
        vulnerable_versions: "<999", patched_versions: ">=999", recommendation: "Synthetic fixture only",
        overview: "Synthetic fixture only", url: "https://example.invalid/advisory", cves: [],
      },
    } : {},
    muted: [],
    metadata: { vulnerabilities, dependencies: 1, devDependencies: 1, optionalDependencies: 0, totalDependencies: 1 },
  };
}

function auditCommand(source) {
  const matches = [...source.matchAll(/^[ \t]*(?:run:[ \t]*)?(pnpm audit[^\r\n]*)$/gm)];
  assert.equal(matches.length, 1, "expected exactly one actual pnpm audit command");
  return matches[0][1];
}

test("behavioral probes select executable audit commands, not job names", () => {
  const command = "pnpm audit --audit-level high";
  assert.equal(auditCommand(`    name: pnpm audit\n        run: ${command}\n`), command);
  assert.equal(auditCommand(`    name: pnpm audit\n        run: |\n          ${command}\n`), command);
});

async function invokeAudit(command, registry) {
  const args = command.trim().split(/\s+/);
  assert.equal(args.shift(), "pnpm");
  const execPath = process.env.npm_execpath;
  const pnpmPath = execPath && /^pnpm(?:\.[cm]?js|\.exe)?$/i.test(path.basename(execPath)) ? execPath : "pnpm";
  const nodeLauncher = /\.[cm]?js$/i.test(pnpmPath);
  return await new Promise((resolve, reject) => {
    const child = spawn(nodeLauncher ? process.execPath : pnpmPath, [
      ...(nodeLauncher ? [pnpmPath] : []), ...args, "--json",
      `--registry=${registry}`,
    ], {
      cwd: root, shell: false, windowsHide: true,
      env: { ...process.env, npm_config_fetch_retries: "0", npm_config_fetch_timeout: "1000" },
    });
    let output = "";
    let stdout = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.stdout.on("data", chunk => {
      stdout = (stdout + chunk).slice(-65_536);
      output = (output + chunk).slice(-65_536);
    });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-65_536); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, output, stdout }); });
  });
}

for (const fixture of ["clean", "outage", "high", "critical"]) {
  test(`real pnpm audit ${fixture === "clean" ? "accepts a clean scan" : `rejects ${fixture} results`} in both workflows`, { timeout: 40_000 }, async () => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.method);
      request.resume();
      response.writeHead(fixture === "outage" ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(fixture === "outage" ? { error: "Synthetic registry outage" } : auditReport(fixture === "clean" ? undefined : fixture)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const registry = `http://127.0.0.1:${server.address().port}`;
    try {
      if (fixture === "outage") {
        const legacy = await invokeAudit("pnpm audit --audit-level high --ignore-registry-errors", registry);
        assert.equal(legacy.signal, null);
        assert.equal(legacy.code, 0, "outage fixture did not reproduce the original bypass");
        assert.ok(requests.length > 0, "legacy probe did not contact the audit fixture");
      }
      for (const name of ["security.yml", "release.yml"]) {
        const command = auditCommand(read(`.github/workflows/${name}`));
        const before = requests.length;
        const result = await invokeAudit(command, registry);
        assert.equal(result.signal, null, `${name}: audit timed out rather than completing`);
        assert.notEqual(result.code, null);
        assert.ok(requests.length > before, `${name}: no actual audit HTTP request: ${result.output}`);
        assert.ok(requests.slice(before).every(method => method === "POST"));
        if (fixture !== "outage") {
          const report = JSON.parse(result.stdout);
          assert.deepEqual(report.metadata.vulnerabilities, auditReport(fixture === "clean" ? undefined : fixture).metadata.vulnerabilities);
        }
        if (fixture === "clean") assert.equal(result.code, 0, result.output);
        else assert.notEqual(result.code, 0, `${name}: failed audit was incorrectly accepted: ${result.output}`);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
