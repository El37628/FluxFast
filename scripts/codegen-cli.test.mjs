import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repository, "tests/fixtures/adapter-baseline-v1.1.0");
const baseline = JSON.parse(fs.readFileSync(path.join(fixture, "baseline.json"), "utf8"));

function processResult(binary, args, cwd) {
  const result = spawnSync(binary, args, {
    cwd, encoding: "utf8", timeout: 60_000,
    shell: process.platform === "win32" && binary === "npm",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function success(binary, args, cwd) {
  const result = processResult(binary, args, cwd);
  assert.equal(result.status, 0, JSON.stringify(result));
  return result.stdout;
}

function artifacts(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(filename => [
    filename, { content: fs.readFileSync(path.join(directory, filename), "utf8"), mtime: fs.statSync(path.join(directory, filename)).mtimeMs },
  ]));
}

test("installed generic and Next binaries coexist and preserve identical generation, diagnostics, and read-only checks", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-cli-consumer-"));
  try {
    const installed = path.join(temporary, "installed");
    fs.mkdirSync(installed);
    fs.writeFileSync(path.join(installed, "package.json"), '{"private":true}');
    const archives = [];
    for (const owner of ["core", "codegen", "react", "next"]) {
      const [pack] = JSON.parse(success("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", temporary], path.join(repository, "packages", owner)));
      archives.push(path.join(temporary, pack.filename));
    }
    success("npm", ["install", ...archives, "--ignore-scripts", "--offline", "--legacy-peer-deps", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"], installed);
    const binaries = {};
    for (const [owner, name] of [["codegen", "fluxfast-codegen"], ["next", "fluxfast"]]) {
      const packageRoot = path.join(installed, "node_modules/@fluxfast", owner);
      const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
      assert.deepEqual(Object.keys(manifest.bin), [name]);
      const entry = path.join(packageRoot, manifest.bin[name]);
      const shim = path.join(installed, "node_modules/.bin", name + (process.platform === "win32" ? ".cmd" : ""));
      assert.ok(fs.existsSync(shim), "missing installed command " + name);
      if (process.platform === "win32") {
        assert.ok(fs.readFileSync(shim, "utf8").includes(owner));
        binaries[owner] = [process.execPath, entry];
      } else {
        assert.equal(fs.realpathSync(shim), fs.realpathSync(entry));
        binaries[owner] = [shim];
      }
    }
    for (const framework of ["next", "react", "react-dom"]) {
      assert.equal(fs.existsSync(path.join(installed, "node_modules", framework)), false);
    }
    for (const entry of ["dist/index.js", "dist/esm/index.js"]) {
      fs.writeFileSync(path.join(installed, "node_modules/@fluxfast/core", entry), 'throw new Error("CLI executed Core runtime");\n');
    }
    for (const layout of ["root", "src"]) {
      const project = path.join(temporary, layout + " with spaces");
      const sourceRoot = layout === "src" ? path.join(project, "src") : project;
      fs.mkdirSync(path.join(sourceRoot, "app"), { recursive: true });
      const installedCore = JSON.parse(fs.readFileSync(path.join(installed, "node_modules/@fluxfast/core/package.json"), "utf8"));
      fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ private: true, dependencies: {
        "@fluxfast/core": installedCore.version, "@fluxfast/next": installedCore.version,
      } }));
      fs.symlinkSync(path.join(installed, "node_modules"), path.join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      for (const [file, content] of Object.entries(baseline.pages)) {
        const source = path.join(sourceRoot, "flux-pages", file);
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, content);
      }
      const output = path.join(sourceRoot, ".fluxfast");
      const sourceSchema = path.join(project, "backend schema.json");
      fs.writeFileSync(sourceSchema, fs.readFileSync(path.join(fixture, "schema.generated.json")));
      const args = ["generate", "--schema-file", "backend schema.json"];
      const cli = (owner, options) => {
        const [binary, ...prefix] = binaries[owner];
        return processResult(binary, [...prefix, ...options], project);
      };
      const missingNext = cli("next", [...args, "--check"]);
      assert.equal(missingNext.status, 1);
      assert.deepEqual(cli("codegen", [...args, "--adapter", "next", "--check"]), missingNext);
      assert.equal(fs.existsSync(output), false);

      const nextGenerated = cli("next", args);
      assert.equal(nextGenerated.status, 0, JSON.stringify(nextGenerated));
      for (const [filename, digest] of Object.entries(baseline.artifactDigests)) {
        assert.equal(createHash("sha256").update(fs.readFileSync(path.join(output, filename))).digest("hex"), digest);
      }
      const before = artifacts(output);
      const nextCurrent = cli("next", [...args, "--check"]);
      assert.equal(nextCurrent.status, 0);
      assert.deepEqual(cli("codegen", [...args, "--check"]), nextCurrent);
      assert.deepEqual(artifacts(output), before);

      fs.appendFileSync(path.join(output, "types.generated.ts"), "// stale generated output\n");
      const stale = artifacts(output);
      const nextStale = cli("next", [...args, "--check"]);
      assert.equal(nextStale.status, 1);
      assert.deepEqual(cli("codegen", [...args, "--check"]), nextStale);
      assert.deepEqual(artifacts(output), stale);
      assert.deepEqual(cli("codegen", args), nextGenerated);
      for (const [filename, record] of Object.entries(before)) {
        assert.equal(artifacts(output)[filename].content, record.content);
      }

      const implicit = ["generate", "--check"];
      assert.deepEqual(cli("codegen", implicit), cli("next", implicit));
      assert.equal(cli("codegen", implicit).status, 0);
      const current = artifacts(output);
      assert.equal(cli("codegen", ["generate", "--adapter", "constructor"]).status, 2);
      assert.deepEqual(artifacts(output), current);
      fs.writeFileSync(sourceSchema, "{}");
      const invalidNext = cli("next", args);
      assert.equal(invalidNext.status, 1);
      assert.deepEqual(cli("codegen", args), invalidNext);
      assert.deepEqual(artifacts(output), current);

      // Both readers retain schema/1 support without changing generated meaning.
      fs.writeFileSync(sourceSchema, fs.readFileSync(path.join(repository, "tests/fixtures/schema/fluxfast-schema-v1.json")));
      assert.equal(cli("next", args).status, 0);
      const legacy = artifacts(output);
      assert.equal(cli("codegen", args).status, 0);
      for (const [filename, record] of Object.entries(legacy)) assert.equal(artifacts(output)[filename].content, record.content);
      assert.equal(cli("next", [...args, "--check"]).status, 0);
      assert.deepEqual(cli("codegen", [...args, "--check"]), cli("next", [...args, "--check"]));
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
