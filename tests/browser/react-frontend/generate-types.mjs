import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { prepareReactFixture } from "../../adapter-conformance/react-fixture.mjs";

const frontend = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(frontend, "../../..");
const localPython = path.join(repository, ".venv/bin/python");
const python = process.env.FLUXFAST_E2E_PYTHON ?? (fs.existsSync(localPython) ? localPython : "python");
const check = process.argv.includes("--check");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with status ${result.status ?? "unknown"}`);
}

// One authoritative UI/backend, not a React-specific copy of contract assertions.
prepareReactFixture({ source: path.join(repository, "tests/browser/frontend"), frontend, check });
if (process.argv.includes("--check-schema")) {
  run(python, ["-m", "fluxfast.cli", "schema", "tests.browser.backend:app", "--output", "tests/browser/frontend/schema.fixture.json", "--check"], repository);
}
const cli = path.join(repository, "packages/vite/bin/fluxfast-vite.js");
if (!check) run(process.execPath, [cli, "init"], frontend);
run(process.execPath, [cli, "generate", "--schema-file", path.join(repository, "tests/browser/frontend/schema.fixture.json"), ...(check ? ["--check"] : [])], frontend);
run(process.execPath, [cli, "init", "--check"], frontend);
