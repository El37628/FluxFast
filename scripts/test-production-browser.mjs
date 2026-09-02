import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const frontendRoot = path.join(repositoryRoot, "tests", "browser", "frontend");
const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const python = process.env.FLUXFAST_E2E_PYTHON ?? (
  fs.existsSync(localPython) ? localPython : "python"
);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const ignoredTopLevel = new Set([
  ".next",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const productionEnvironment = {
  ...process.env,
  FLUXFAST_E2E_BACKEND_PORT: "3111",
  FLUXFAST_E2E_PORT: "3110",
  FLUXFAST_E2E_PRODUCTION: "1",
  FLUXFAST_PRODUCTION_START: "0",
  NEXT_TELEMETRY_DISABLED: "1",
};
delete productionEnvironment.FLUXFAST_BACKEND_URL;
delete productionEnvironment.NEXT_PUBLIC_FLUXFAST_BACKEND_URL;

function execute(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: productionEnvironment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function snapshotFrontend() {
  const snapshot = new Map();

  function visit(absolute, relative) {
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        const childRelative = relative ? path.join(relative, name) : name;
        if (!relative && ignoredTopLevel.has(name)) continue;
        visit(path.join(absolute, name), childRelative);
      }
      return;
    }

    const record = {
      mode: stat.mode.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      size: stat.size.toString(),
      type: stat.isSymbolicLink() ? "symlink" : "file",
    };
    if (stat.isSymbolicLink()) {
      record.target = fs.readlinkSync(absolute);
    } else {
      record.sha256 = crypto
        .createHash("sha256")
        .update(fs.readFileSync(absolute))
        .digest("hex");
    }
    snapshot.set(relative.replaceAll(path.sep, "/"), record);
  }

  visit(frontendRoot, "");
  return snapshot;
}

function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter(
      file => JSON.stringify(before.get(file)) !== JSON.stringify(after.get(file)),
    )
    .sort();
}

const buildStatus = execute(python, [
  "-m",
  "fluxfast.cli",
  "build",
  "--app",
  "tests.browser.backend:app",
  "--frontend",
  "tests/browser/frontend",
]);
if (buildStatus !== 0) process.exit(buildStatus);

const beforeStart = snapshotFrontend();
const testStatus = execute(pnpm, [
  "--dir",
  frontendRoot,
  "run",
  "test:e2e:production",
]);
const afterStart = snapshotFrontend();
const changed = changedPaths(beforeStart, afterStart);

if (changed.length > 0) {
  console.error("✗ Production startup or browser execution modified frontend inputs:");
  for (const file of changed) console.error(`  ${file}`);
  process.exit(1);
}

console.log("✓ fluxfast start left frontend source and generated files unchanged");
process.exit(testStatus);
