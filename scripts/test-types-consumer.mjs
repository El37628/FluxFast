import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-types-consumer-"));
const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";
const pnpm = windows ? "pnpm.cmd" : "pnpm";
const localPython = path.join(repository, ".venv", windows ? "Scripts/python.exe" : "bin/python");
const bootstrapPython = process.env.FLUXFAST_E2E_PYTHON ?? (fs.existsSync(localPython) ? localPython : "python");
const configuredArtifacts = process.env.FLUXFAST_TYPES_ARTIFACT_DIR;
const artifacts = configuredArtifacts ? path.resolve(configuredArtifacts) : path.join(temporary, "candidate-artifacts");
const published = path.join(temporary, "published-artifacts");
const baseline = JSON.parse(fs.readFileSync(path.join(repository, "tests/fixtures/adapter-baseline-v1.1.0/baseline.json"), "utf8"));
const tooling = createRequire(path.join(repository, "packages/vite/package.json"));

function run(command, args, cwd = repository) {
  const environment = { ...process.env, PYTHONPATH: "", npm_config_update_notifier: "false" };
  for (const key of Object.keys(environment)) {
    if (/verify_deps_before_run|link_workspace_packages|@jsr:registry/i.test(key)) delete environment[key];
  }
  const result = spawnSync(command, args, {
    cwd, env: environment, encoding: "utf8", timeout: 180_000,
    shell: windows && (command === npm || command === pnpm),
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function success(command, args, cwd) {
  const result = run(command, args, cwd);
  assert.equal(result.status, 0, JSON.stringify(result));
  return result.stdout;
}
function one(directory, prefix, suffix) {
  const names = fs.readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith(suffix));
  assert.equal(names.length, 1, `${directory}: expected one ${prefix}*${suffix}`);
  return path.join(directory, names[0]);
}
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, {
    content: fs.readFileSync(path.join(directory, name)),
    mtime: fs.statSync(path.join(directory, name)).mtimeMs,
  }]));
}

try {
  const relative = path.relative(repository, temporary);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "consumers must be outside the source checkout");
  fs.mkdirSync(published);
  const installer = path.join(temporary, "installer-python");
  success(bootstrapPython, ["-m", "venv", installer]);
  const installerPython = path.join(installer, windows ? "Scripts/python.exe" : "bin/python");
  if (!configuredArtifacts) {
    fs.mkdirSync(path.join(artifacts, "python"), { recursive: true });
    fs.mkdirSync(path.join(artifacts, "npm"));
    for (const owner of ["core", "codegen", "react", "vite", "next"]) {
      success(pnpm, ["--filter", "@fluxfast/" + owner, "run", "build"]);
      success(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", path.join(artifacts, "npm")], path.join(repository, "packages", owner));
    }
    success(installerPython, ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", path.join(artifacts, "python"), path.join(repository, "python/fluxfast")]);
  }
  for (const record of baseline.publishedPackages) {
    const [packed] = JSON.parse(success(npm, ["pack", record.name + "@1.1.0", "--ignore-scripts", "--json", "--pack-destination", published]));
    const actual = "sha512-" + createHash("sha512").update(fs.readFileSync(path.join(published, packed.filename))).digest("base64");
    assert.equal(actual, record.integrity, "published archive differs from immutable 1.1 baseline: " + record.name);
  }
  success(installerPython, ["-m", "pip", "download", "--no-deps", "--only-binary=:all:", "--dest", published, "fluxfast==1.1.0"]);
  const metadataResponse = await fetch("https://pypi.org/pypi/fluxfast/1.1.0/json", { signal: AbortSignal.timeout(30_000) });
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  const publishedWheel = one(published, "fluxfast-1.1.0", ".whl");
  const wheelMetadata = metadata.urls.find(item => item.filename === path.basename(publishedWheel));
  assert.ok(wheelMetadata);
  assert.equal(createHash("sha256").update(fs.readFileSync(publishedWheel)).digest("hex"), wheelMetadata.digests.sha256);
  const pythonEnvironments = {};
  for (const mode of ["published", "candidate"]) {
    const root = path.join(temporary, mode + "-python");
    success(bootstrapPython, ["-m", "venv", root]);
    const python = path.join(root, windows ? "Scripts/python.exe" : "bin/python");
    const fluxfast = path.join(root, windows ? "Scripts/fluxfast.exe" : "bin/fluxfast");
    success(python, ["-m", "pip", "install", "--quiet", mode === "published" ? publishedWheel : one(path.join(artifacts, "python"), "fluxfast-", ".whl")]);
    success(python, ["-c", "import fluxfast,sys; from pathlib import Path; assert Path(fluxfast.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())"]);
    pythonEnvironments[mode] = { python, fluxfast };
  }
  const installed = {};
  for (const mode of ["published", "candidate", "react"]) {
    const directory = path.join(temporary, mode + "-javascript");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "package.json"), '{"private":true}');
    const source = mode === "published" ? published : path.join(artifacts, "npm");
    const owners = mode === "published" ? ["core", "next"] : mode === "react" ? ["core", "codegen", "react", "vite"] : ["core", "codegen", "react", "next"];
    const peers = mode === "react" ? ["react", "react-dom", "vite", "@types/react", "@types/react-dom"].map(name => {
      const manifest = JSON.parse(fs.readFileSync(tooling.resolve(name + "/package.json"), "utf8"));
      return name + "@" + manifest.version;
    }) : [];
    success(npm, ["install", ...owners.map(owner => one(source, "fluxfast-" + owner + "-", ".tgz")), ...peers, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--no-package-lock"], directory);
    installed[mode] = path.join(directory, "node_modules");
  }
  const backend = `from fastapi import FastAPI
from pydantic import BaseModel
from fluxfast import FluxFast, Page
app = FastAPI()
flux = FluxFast(app)
class Item(BaseModel):
    id: int
flux.define_resource("items", list[Item])
@flux.page("/")
async def home() -> Page:
    raise RuntimeError("Schema generation executed a page handler")
`;
  const expectedBytes = {};
  for (const layout of ["root", "src"]) {
    for (const [pythonMode, javascriptMode] of [["published", "published"], ["candidate", "published"], ["published", "candidate"], ["candidate", "candidate"]]) {
      const consumer = path.join(temporary, `${layout}-${pythonMode}-${javascriptMode}`);
      const frontend = path.join(consumer, "frontend with spaces");
      const sourceRoot = layout === "src" ? path.join(frontend, "src") : frontend;
      fs.mkdirSync(path.join(sourceRoot, "app"), { recursive: true });
      fs.mkdirSync(path.join(sourceRoot, "flux-pages/home"), { recursive: true });
      const next = JSON.parse(fs.readFileSync(path.join(installed[javascriptMode], "@fluxfast/next/package.json"), "utf8"));
      fs.writeFileSync(path.join(frontend, "package.json"), JSON.stringify({private:true, dependencies:{"@fluxfast/next":next.version, "@fluxfast/core":next.version}}));
      fs.symlinkSync(installed[javascriptMode], path.join(frontend, "node_modules"), windows ? "junction" : "dir");
      fs.writeFileSync(path.join(sourceRoot, "flux-pages/home/index.tsx"), "export default function Home() { return null; }\n");
      fs.writeFileSync(path.join(consumer, "backend.py"), backend);
      const { python, fluxfast } = pythonEnvironments[pythonMode];
      const probe = `import json; from pathlib import Path; from fluxfast.cli import _type_generation_command; print(json.dumps(_type_generation_command(Path(${JSON.stringify(frontend)}), Path("schema.json"), check=True)))`;
      const selected = JSON.parse(success(python, ["-c", probe], consumer));
      const generic = pythonMode === "candidate" && javascriptMode === "candidate";
      assert.ok(selected.includes(generic ? "fluxfast-codegen" : "fluxfast"));
      assert.equal(selected.includes("--adapter"), generic);
      const args = ["types", "backend:app", "--frontend", "frontend with spaces"];
      const output = path.join(sourceRoot, ".fluxfast");
      assert.equal(run(fluxfast, [...args, "--check"], consumer).status, 1);
      assert.equal(fs.existsSync(output), false);
      success(fluxfast, args, consumer);
      const generated = snapshot(output);
      assert.equal(Object.keys(generated).length, 6);
      const content = Object.fromEntries(Object.entries(generated).map(([name, record]) => [name, record.content]));
      if (!expectedBytes[layout]) expectedBytes[layout] = content;
      else assert.deepEqual(content, expectedBytes[layout], "mixed tooling changed generated bytes");
      success(fluxfast, [...args, "--check"], consumer);
      assert.deepEqual(snapshot(output), generated);
      if (pythonMode === "candidate") {
        success(fluxfast, [...args, "--adapter", "next", "--check"], consumer);
        assert.deepEqual(snapshot(output), generated);
      }
      fs.appendFileSync(path.join(output, "types.generated.ts"), "// deliberate drift in owned consumer\n");
      const stale = snapshot(output);
      assert.equal(run(fluxfast, [...args, "--check"], consumer).status, 1);
      assert.deepEqual(snapshot(output), stale);
      success(fluxfast, args, consumer);
      for (const [name, record] of Object.entries(snapshot(output))) assert.deepEqual(record.content, generated[name].content);
      console.log(`${layout}: Python ${pythonMode} / JavaScript ${javascriptMode}: ${generic ? "fluxfast-codegen" : "legacy fluxfast"}, six identical artifacts, missing/current/stale checks`);
    }
  }
  // The second adapter uses the same isolated Python wheel and artifact engine,
  // but no Next package or binary. Hide only the owned CLI shims to exercise the
  // host fallback without removing its declared Codegen library dependency.
  for (const name of ["next", "@fluxfast/next"]) assert.equal(fs.existsSync(path.join(installed.react, name)), false);
  const reactVersion = JSON.parse(fs.readFileSync(path.join(installed.react, "@fluxfast/vite/package.json"), "utf8")).version;
  for (const generator of ["generic", "host"]) {
    const hidden = [];
    try {
      if (generator === "host") {
        for (const suffix of ["", ".cmd", ".ps1", ".exe"]) {
          const original = path.join(installed.react, ".bin", "fluxfast-codegen" + suffix);
          if (fs.existsSync(original)) { const moved = original + ".temporarily-unavailable"; fs.renameSync(original, moved); hidden.push([original, moved]); }
        }
      }
      for (const layout of ["root", "src"]) {
        const consumer = path.join(temporary, "react-" + generator + "-" + layout);
        const frontend = path.join(consumer, "frontend with spaces");
        const sourceRoot = layout === "src" ? path.join(frontend, "src") : frontend;
        fs.mkdirSync(path.join(sourceRoot, "flux-pages/home"), { recursive: true });
        fs.writeFileSync(path.join(frontend, "package.json"), JSON.stringify({private:true, dependencies:{"@fluxfast/vite":reactVersion,react:">=19","react-dom":">=19",vite:"7.3.6"}}));
        fs.symlinkSync(installed.react, path.join(frontend, "node_modules"), windows ? "junction" : "dir");
        fs.writeFileSync(path.join(sourceRoot, "flux-pages/home/index.tsx"), "export default function Home() { return null; }\n");
        fs.writeFileSync(path.join(consumer, "backend.py"), backend);
        const { python, fluxfast } = pythonEnvironments.candidate;
        const probe = `import json; from pathlib import Path; from fluxfast.cli import _type_generation_command; print(json.dumps(_type_generation_command(Path(${JSON.stringify(frontend)}),Path("schema.json"),check=True)))`;
        const selected = JSON.parse(success(python, ["-c", probe], consumer));
        assert.ok(selected.includes(generator === "generic" ? "fluxfast-codegen" : "fluxfast-vite"));
        assert.equal(selected.includes("--adapter"), generator === "generic");
        assert.equal(selected.includes("fluxfast"), false);
        const args = ["types", "backend:app", "--frontend", "frontend with spaces"];
        const output = path.join(sourceRoot, ".fluxfast");
        assert.equal(run(fluxfast, [...args, "--check"], consumer).status, 1);
        assert.equal(fs.existsSync(output), false);
        success(fluxfast, args, consumer);
        const generated = snapshot(output);
        assert.equal(Object.keys(generated).length, 6);
        for (const [name, record] of Object.entries(generated)) {
          if (name === "pages.generated.ts") {
            const next = expectedBytes[layout][name].toString("utf8");
            assert.equal(record.content.toString("utf8"), next.replace('"use client";\n', "").replaceAll("@fluxfast/next", "@fluxfast/react"));
          } else assert.deepEqual(record.content, expectedBytes[layout][name], "React changed a shared typed artifact: " + name);
        }
        for (const flags of [["--check"], ["--adapter", "react", "--check"]]) {
          success(fluxfast, [...args, ...flags], consumer); assert.deepEqual(snapshot(output), generated);
        }
        success(process.execPath, [path.join(path.dirname(tooling.resolve("typescript/package.json")), "bin/tsc"),
          "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "ESNext", "--moduleResolution", "Bundler",
          "--target", "ES2022", "--lib", "ES2022,DOM,DOM.Iterable", "--jsx", "react-jsx", ...Object.keys(generated).filter(name => name.endsWith(".ts")).map(name => path.join(output, name))], frontend);
        fs.appendFileSync(path.join(output, "types.generated.ts"), "// deliberate React drift\n");
        const stale = snapshot(output);
        assert.equal(run(fluxfast, [...args, "--check"], consumer).status, 1);
        assert.deepEqual(snapshot(output), stale);
        success(fluxfast, args, consumer);
        for (const [name, record] of Object.entries(snapshot(output))) assert.deepEqual(record.content, generated[name].content);
        console.log(`React ${layout}: installed ${generator} handoff, six artifacts, strict types and read-only missing/current/stale checks`);
      }
    } finally { for (const [original, moved] of hidden) fs.renameSync(moved, original); }
  }
  console.log("Packed type generation passes both upgrade orders against integrity-verified published v1.1.0 packages.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
