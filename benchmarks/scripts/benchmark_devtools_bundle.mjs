/** Prove a development-only DevTools mount is absent from production chunks. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = process.env.FLUXFAST_BENCHMARK_REPOSITORY_ROOT
  ? path.resolve(process.env.FLUXFAST_BENCHMARK_REPOSITORY_ROOT)
  : path.resolve(scriptDirectory, "../..");
const requireFromRepository = createRequire(path.join(repositoryRoot, "package.json"));
const browserFixture = path.join(repositoryRoot, "tests", "browser", "frontend");
const fixtureNodeModules = path.join(browserFixture, "node_modules");
const nextBinary = path.join(fixtureNodeModules, ".bin", "next");
const nextPackage = requireFromRepository(
  "./tests/browser/frontend/node_modules/next/package.json",
);
const MAX_ROUTE_DELTA_BYTES = 512;
const FORBIDDEN_MARKERS = [
  "data-fluxfast-devtools-host",
  "FluxFast DevTools",
  "Development diagnostics",
  "ff-inspector-shell",
];

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function applicationSource(withDevtools) {
  return [
    '"use client";',
    "",
    'import type { PageEnvelope } from "@fluxfast/core";',
    'import { PROTOCOL_VERSION } from "@fluxfast/core";',
    'import { FluxProvider, useResource } from "@fluxfast/next";',
    ...(withDevtools
      ? ['import { DevelopmentDevtools } from "./DevelopmentDevtools";']
      : []),
    "",
    "const initialEnvelope: PageEnvelope = {",
    "  protocol: PROTOCOL_VERSION,",
    '  page: { component: "home/index", url: "/" },',
    '  resourceKeys: ["summary"],',
    '  resources: { summary: { version: "v1", value: { rooms: 42 } } },',
    "};",
    "",
    "function Consumer() {",
    '  const summary = useResource<{ rooms: number }>("summary");',
    '  return <main data-devtools-bundle={summary.rooms}>Rooms: {summary.rooms}</main>;',
    "}",
    "",
    "export default function Page() {",
    "  return (",
    "    <FluxProvider initialEnvelope={initialEnvelope}>",
    "      <Consumer />",
    ...(withDevtools ? ["      <DevelopmentDevtools />"] : []),
    "    </FluxProvider>",
    "  );",
    "}",
  ].join("\n") + "\n";
}

function developmentMountSource() {
  return [
    '"use client";',
    "",
    'import { FluxDevtools } from "@fluxfast/devtools";',
    "",
    "export function DevelopmentDevtools() {",
    '  if (process.env.NODE_ENV !== "development") return null;',
    "  return <FluxDevtools />;",
    "}",
  ].join("\n") + "\n";
}

function prepareProject(root, withDevtools) {
  writeFile(root, "package.json", `${JSON.stringify({
    private: true,
    dependencies: {
      "@fluxfast/core": "workspace:*",
      "@fluxfast/devtools": "workspace:*",
      "@fluxfast/next": "workspace:*",
      next: nextPackage.version,
      react: "19.3.0",
      "react-dom": "19.3.0",
    },
  }, null, 2)}\n`);
  writeFile(root, "tsconfig.json", `${JSON.stringify({
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
  }, null, 2)}\n`);
  writeFile(
    root,
    "next-env.d.ts",
    '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
  );
  writeFile(
    root,
    "next.config.ts",
    'import { withFluxFast } from "@fluxfast/next/next-config";\n\nexport default withFluxFast({}, { generate: false });\n',
  );
  writeFile(
    root,
    "src/app/layout.tsx",
    "export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html><body>{children}</body></html>; }\n",
  );
  writeFile(root, "src/app/page.tsx", applicationSource(withDevtools));
  if (withDevtools) {
    writeFile(
      root,
      "src/app/DevelopmentDevtools.tsx",
      developmentMountSource(),
    );
  }
  fs.symlinkSync(fixtureNodeModules, path.join(root, "node_modules"), "dir");
}

function listJavaScript(root) {
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

function build(temporaryRoot, name, withDevtools) {
  const root = path.join(temporaryRoot, name);
  fs.mkdirSync(root, { recursive: true });
  prepareProject(root, withDevtools);
  const result = spawnSync(nextBinary, ["build"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `Next.js ${name} build failed:\n${result.stdout}${result.stderr}`,
  );
  const routeStats = JSON.parse(fs.readFileSync(
    path.join(root, ".next", "diagnostics", "route-bundle-stats.json"),
    "utf8",
  ));
  const pageStats = routeStats.find(entry => entry.route === "/");
  assert.ok(pageStats, `${name} did not report the / route`);
  const chunks = listJavaScript(path.join(root, ".next", "static", "chunks"))
    .map(file => ({ file, content: fs.readFileSync(file, "utf8") }));
  const content = chunks.map(chunk => chunk.content).join("\n");
  const rendered = fs.readdirSync(path.join(root, ".next", "server", "app"), {
    recursive: true,
  }).filter(file => typeof file === "string" && file.endsWith(".html"))
    .map(file => fs.readFileSync(path.join(root, ".next", "server", "app", file), "utf8"))
    .join("\n");
  assert.ok(rendered.includes('data-devtools-bundle="42"'));
  return {
    content,
    firstLoadBytes: pageStats.firstLoadUncompressedJsBytes,
    totalChunkBytes: chunks.reduce(
      (total, chunk) => total + Buffer.byteLength(chunk.content),
      0,
    ),
  };
}

function formatBytes(value) {
  return `${value} B (${(value / 1024).toFixed(2)} KiB)`;
}

function run() {
  assert.ok(fs.existsSync(nextBinary), "Install workspace dependencies first");
  const temporaryRoot = fs.mkdtempSync(
    path.join(repositoryRoot, ".fluxfast-devtools-bundle-"),
  );
  try {
    const baseline = build(temporaryRoot, "without-devtools", false);
    const candidate = build(temporaryRoot, "development-only-devtools", true);
    const routeDelta = candidate.firstLoadBytes - baseline.firstLoadBytes;
    const retainedMarkers = FORBIDDEN_MARKERS.filter(marker =>
      candidate.content.includes(marker)
    );
    assert.deepEqual(
      retainedMarkers,
      [],
      "production client chunks retained FluxFast DevTools implementation markers",
    );
    assert.ok(
      routeDelta <= MAX_ROUTE_DELTA_BYTES,
      `development-only mount added ${routeDelta} production route bytes`,
    );
    console.log("FluxFast DevTools controlled production-bundle comparison");
    console.log(
      `environment: Node ${process.versions.node}; Next.js ${nextPackage.version}`,
    );
    console.log(
      `without DevTools: / first-load ${formatBytes(baseline.firstLoadBytes)}; all chunks ${formatBytes(baseline.totalChunkBytes)}`,
    );
    console.log(
      `development-only mount: / first-load ${formatBytes(candidate.firstLoadBytes)}; delta ${formatBytes(routeDelta)}; all chunks ${formatBytes(candidate.totalChunkBytes)}`,
    );
    console.log(
      `policy: production route delta must be at most ${MAX_ROUTE_DELTA_BYTES} bytes and no DevTools host, title, development UI, or inspector marker may exist in client chunks`,
    );
    console.log(
      "correctness: PASS — both applications rendered identically and the development-only DevTools implementation was excluded from production client chunks",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

run();
