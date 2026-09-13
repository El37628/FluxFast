import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repositoryRoot, "tests", "soak", "board");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-v1-soak-"));
const consumer = path.join(temporaryRoot, "board");
const environmentRoot = path.join(temporaryRoot, "venv");
const relative = path.relative(repositoryRoot, temporaryRoot);
assert.ok(path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`),
  "the soak consumer must live outside the source checkout");

const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";
const npx = windows ? "npx.cmd" : "npx";
const localPython = path.join(repositoryRoot, ".venv", windows ? "Scripts/python.exe" : "bin/python");
const python = process.env.FLUXFAST_E2E_PYTHON ?? (fs.existsSync(localPython) ? localPython : "python");
const isolatedPython = path.join(environmentRoot, windows ? "Scripts/python.exe" : "bin/python");
const fluxfast = path.join(environmentRoot, windows ? "Scripts/fluxfast.exe" : "bin/fluxfast");
const prepareOnly = process.argv.includes("--prepare-only");

function run(command, args) {
  const environment = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PYTHONPATH: "" };
  for (const key of Object.keys(environment)) {
    if (/verify_deps_before_run|link_workspace_packages|@jsr:registry/i.test(key)) delete environment[key];
  }
  const result = spawnSync(command, args, { cwd: consumer, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}

try {
  fs.cpSync(fixture, consumer, { recursive: true });
  run(python, ["-m", "venv", environmentRoot]);
  run(isolatedPython, ["-m", "pip", "install", "--no-input", "fluxfast==0.9.0"]);
  run(isolatedPython, ["-c", "import sys, fluxfast; from importlib.metadata import version; "
    + "from pathlib import Path; assert version('fluxfast') == '0.9.0'; "
    + "assert Path(fluxfast.__file__).is_relative_to(Path(sys.argv[1])); print(fluxfast.__file__)",
    environmentRoot]);
  run(npm, ["install", "--package-lock=false"]);
  for (const name of ["@fluxfast/core", "@fluxfast/next"]) {
    const packageRoot = fs.realpathSync(path.join(consumer, "node_modules", ...name.split("/")));
    assert.ok(packageRoot.startsWith(`${consumer}${path.sep}`), `${name} resolved outside the consumer`);
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(metadata.version, "0.9.0");
  }
  run(npx, ["--no-install", "fluxfast", "init", "--yes"]);
  run(fluxfast, ["types", "backend:app", "--frontend", consumer]);
  run(fluxfast, ["types", "backend:app", "--frontend", consumer, "--check"]);
  run(npm, ["run", "typecheck"]);
  run(fluxfast, ["build", "--app", "backend:app", "--frontend", consumer]);
  run(fluxfast, ["doctor", "--production", "--strict", "--app", "backend:app", "--frontend", consumer]);

  if (prepareOnly) {
    console.log(`Prepared published v0.9.0 operations-board consumer at ${consumer}`);
    console.log("Preparation is not a completed soak or release gate.");
  } else {
    run(npx, ["--no-install", "playwright", "install", "chromium"]);
    const { exerciseConsumer } = await import("./exercise-v1-soak.mjs");
    await exerciseConsumer({ consumer, python: isolatedPython, fluxfast, temporaryRoot });
  }
} catch (error) {
  console.error(`Preserved failed soak consumer at ${consumer}`);
  throw error;
}
