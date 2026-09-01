import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(frontendRoot, "../../..");
const localPython = path.join(repositoryRoot, ".venv", "bin", "python");
const python = process.env.FLUXFAST_E2E_PYTHON ?? (
  fs.existsSync(localPython) ? localPython : "python"
);
const schemaFile = path.join(
  frontendRoot,
  "src",
  ".fluxfast",
  "schema.generated.json",
);
const fluxfastCli = path.join(
  repositoryRoot,
  "packages",
  "next",
  "bin",
  "fluxfast.js",
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} exited with status ${result.status ?? "unknown"}`,
    );
  }
}

run(
  python,
  [
    "-m",
    "fluxfast.cli",
    "schema",
    "tests.browser.backend:app",
    "--output",
    schemaFile,
  ],
  repositoryRoot,
);
run(process.execPath, [fluxfastCli, "generate"], frontendRoot);
