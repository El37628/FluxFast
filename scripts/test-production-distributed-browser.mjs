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
const environment = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
};
delete environment.FLUXFAST_BACKEND_URL;
delete environment.NEXT_PUBLIC_FLUXFAST_BACKEND_URL;

function execute(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
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

process.exit(execute(pnpm, [
  "--dir",
  frontendRoot,
  "run",
  "test:e2e:distributed:production",
]));
