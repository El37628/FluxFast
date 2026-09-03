/** Measure validator tree-shaking in real minimal Next.js production builds. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const browserFixture = path.join(repositoryRoot, "tests", "browser", "frontend");
const fixtureNodeModules = path.join(browserFixture, "node_modules");
const nextBinary = path.join(fixtureNodeModules, ".bin", "next");
const { generateFluxFastProject } = require(
  "../../packages/next/dist/generate.js"
);

const contractCount = 100;
const multipleCount = 10;

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function marker(index) {
  return `field${String(index).padStart(4, "0")}`;
}

function contractName(index) {
  return `Contract${String(index).padStart(4, "0")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function createManifest() {
  const types = {};
  for (let index = 0; index < contractCount; index += 1) {
    const field = marker(index);
    types[contractName(index)] = {
      mode: "validation",
      schema: {
        additionalProperties: false,
        properties: {
          [field]: { minLength: 1, type: "string" },
        },
        required: [field],
        type: "object",
      },
    };
  }
  const fingerprintPayload = {
    schema: "fluxfast-schema/2",
    types,
    resources: {},
    pages: [],
    mutations: [],
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonicalize(fingerprintPayload)))
    .digest("hex");
  return {
    ...fingerprintPayload,
    producer: "0.8.0",
    fingerprint,
  };
}

function renderPage(importedIndexes) {
  if (importedIndexes.length === 0) {
    return `"use client";\n\nexport default function Page() {\n  return <main data-validator-count="0">No validators imported</main>;\n}\n`;
  }
  const names = importedIndexes.map(index => `${contractName(index)}Validator`);
  const imports = `import { ${names.join(", ")} } from "../.fluxfast/validators.generated";`;
  const entries = importedIndexes.map((index, position) =>
    `${names[position]}.is({ ${marker(index)}: "ok" })`
  );
  return `"use client";\n\n${imports}\n\nconst checks = [\n  ${entries.join(",\n  ")}\n];\n\nexport default function Page() {\n  return <main data-validator-count={checks.filter(Boolean).length}>Validators imported</main>;\n}\n`;
}

function prepareProject(root, importedIndexes) {
  writeFile(
    root,
    "package.json",
    `${JSON.stringify({
      private: true,
      dependencies: {
        "@fluxfast/core": "workspace:*",
        "@fluxfast/next": "workspace:*",
        next: "16.3.3",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
    }, null, 2)}\n`,
  );
  writeFile(
    root,
    "tsconfig.json",
    `${JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        lib: ["DOM", "DOM.Iterable", "ESNext"],
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
      },
      include: ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts"],
    }, null, 2)}\n`,
  );
  writeFile(
    root,
    "next-env.d.ts",
    '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
  );
  writeFile(root, "next.config.ts", "export default {};\n");
  writeFile(
    root,
    "src/app/layout.tsx",
    "export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html><body>{children}</body></html>; }\n",
  );
  writeFile(root, "src/app/page.tsx", renderPage(importedIndexes));
  writeFile(
    root,
    "src/flux-pages/home/index.tsx",
    "export default function Home() { return <main>Generated registry fixture</main>; }\n",
  );
  const schemaFile = path.join(root, "src", ".fluxfast", "schema.generated.json");
  writeFile(root, "src/.fluxfast/schema.generated.json", `${JSON.stringify(createManifest())}\n`);
  generateFluxFastProject({
    generatedDir: path.dirname(schemaFile),
    log: false,
    outputFile: path.join(root, "src", ".fluxfast", "pages.generated.ts"),
    pagesDir: path.join(root, "src", "flux-pages"),
    schemaFile,
  });
  fs.symlinkSync(fixtureNodeModules, path.join(root, "node_modules"), "dir");
}

function listJavaScriptFiles(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(target);
    }
  };
  visit(root);
  return files.sort();
}

function buildVariant(temporaryRoot, name, importedIndexes) {
  const projectRoot = path.join(temporaryRoot, name);
  fs.mkdirSync(projectRoot, { recursive: true });
  prepareProject(projectRoot, importedIndexes);
  const started = performance.now();
  const result = spawnSync(nextBinary, ["build"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  const buildMs = performance.now() - started;
  assert.equal(
    result.status,
    0,
    `Next.js ${name} build failed:\n${result.stdout}${result.stderr}`,
  );

  const chunkRoot = path.join(projectRoot, ".next", "static", "chunks");
  const files = listJavaScriptFiles(chunkRoot);
  const chunks = files.map(file => ({
    bytes: fs.statSync(file).size,
    content: fs.readFileSync(file, "utf8"),
    file,
  }));
  const content = chunks.map(chunk => chunk.content).join("\n");
  const retained = Array.from(
    { length: contractCount },
    (_, index) => index,
  ).filter(index => content.includes(marker(index)));
  assert.deepEqual(retained, importedIndexes);

  const routeStats = JSON.parse(fs.readFileSync(
    path.join(projectRoot, ".next", "diagnostics", "route-bundle-stats.json"),
    "utf8",
  ));
  const pageStats = routeStats.find(entry => entry.route === "/");
  assert.ok(pageStats, `Next.js ${name} build did not report the / route`);
  return {
    buildMs,
    firstLoadBytes: pageStats.firstLoadUncompressedJsBytes,
    name,
    retained,
    totalChunkBytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
    validatorChunkBytes: chunks
      .filter(chunk => importedIndexes.some(index => chunk.content.includes(marker(index))))
      .reduce((total, chunk) => total + chunk.bytes, 0),
  };
}

function formatBytes(value) {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return absolute < 1024
    ? `${value} B`
    : `${sign}${(absolute / 1024).toFixed(1)} KiB`;
}

function runBenchmark() {
  assert.ok(fs.existsSync(nextBinary), "Install workspace dependencies before running the bundle benchmark");
  const temporaryRoot = fs.mkdtempSync(
    path.join(repositoryRoot, ".fluxfast-bundle-benchmark-"),
  );
  try {
    const variants = [
      ["no-validators", []],
      ["one-validator", [0]],
      ["multiple-validators", Array.from({ length: multipleCount }, (_, index) => index)],
    ];
    const results = variants.map(([name, importedIndexes]) =>
      buildVariant(temporaryRoot, name, importedIndexes)
    );
    const baseline = results[0];

    console.log("FluxFast controlled production-bundle benchmark");
    console.log(`environment: Node ${process.versions.node}; Next.js 16.3.3`);
    console.log(
      `workload: three clean production builds generated from ${contractCount} contracts; no timing or byte thresholds`,
    );
    for (const result of results) {
      console.log(
        `${result.name}: / first-load ${formatBytes(result.firstLoadBytes)}; all client chunks ${formatBytes(result.totalChunkBytes)} (${formatBytes(result.totalChunkBytes - baseline.totalChunkBytes)} vs no-import); validator chunks ${formatBytes(result.validatorChunkBytes)}; build ${result.buildMs.toFixed(3)} ms; retained markers ${result.retained.length}`,
      );
    }
    console.log(
      "tradeoff: importing validators adds the framework-neutral runtime and selected static plans; aggregate .next chunk totals include framework chunks and are comparison data, not a package-size guarantee",
    );
    console.log(
      "correctness: PASS — the no-import build retained zero validator plans, the single-import build retained exactly one, and the realistic build retained exactly ten",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

runBenchmark();
