import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPublicApiSnapshot } from "./public-api-snapshot.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolver = createRequire(path.join(repository, "packages/vite/package.json"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000,
    shell: process.platform === "win32" && command === "npm", env: { ...process.env, npm_config_update_notifier: "false" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

// FluxFast code must come from tarballs. Reviewed external peers/tooling can
// be copied from the locked install, keeping this consumer offline in CI.
function copyExternalGraph(consumer) {
  const pending = [[resolver, "vite"], [resolver, "react"], [resolver, "react-dom"],
    [resolver, "@types/react"], [resolver, "@types/react-dom"], [resolver, "@types/node"]];
  const visited = new Map();
  while (pending.length) {
    const [resolveFrom, name] = pending.pop();
    let manifestPath;
    try { manifestPath = resolveFrom.resolve(name + "/package.json"); }
    catch {
      let directory = path.dirname(resolveFrom.resolve(name));
      while (true) {
        const candidate = path.join(directory, "package.json");
        if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, "utf8")).name === name) { manifestPath = candidate; break; }
        const parent = path.dirname(directory);
        assert.notEqual(parent, directory, `Missing external manifest ${name}`);
        directory = parent;
      }
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (visited.has(name)) { assert.equal(visited.get(name), manifest.version, `Conflicting offline external versions for ${name}`); continue; }
    visited.set(name, manifest.version);
    const source = path.dirname(manifestPath);
    fs.cpSync(source, path.join(consumer, "node_modules", name), {
      recursive: true, dereference: true,
      filter: current => !path.relative(source, current).split(path.sep).includes("node_modules"),
    });
    const nested = createRequire(manifestPath);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) pending.push([nested, dependency]);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try { nested.resolve(dependency + "/package.json"); pending.push([nested, dependency]); }
      catch { /* The locked install contains only optional binaries for this platform. */ }
    }
  }
}

test("Vite exposes only documented Node tooling/server exports and never depends on Next", () => {
  const snapshot = createPublicApiSnapshot().packages["@fluxfast/vite"];
  assert.deepEqual(snapshot.entries, {
    ".": { typeOnly: ["FluxViteBuildOptions", "FluxViteOptions"], valueOnly: ["buildFluxViteApp", "fluxfast"] },
    "./server": { typeOnly: ["FluxViteServer", "FluxViteServerOptions"], valueOnly: ["createFluxViteServer"] },
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, "packages/vite/package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies, { "@fluxfast/codegen": `^${manifest.version}`, "@fluxfast/core": `^${manifest.version}`, "@fluxfast/react": `^${manifest.version}` });
  assert.deepEqual(manifest.bin, { "fluxfast-vite": "bin/fluxfast-vite.js" });
  assert.equal(manifest.peerDependencies.next, undefined);
  const guide = fs.readFileSync(path.join(repository, "docs/vite-host.md"), "utf8");
  const block = guide.split("<!-- vite-api-examples:start -->")[1]?.split("<!-- vite-api-examples:end -->")[0];
  assert.ok(block);
  const rows = [...block.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| ([^\n]+) \|$/gm)];
  assert.deepEqual(rows.map(row => row[1]).sort(), Object.values(snapshot.entries).flatMap(entry => Object.values(entry).flat()).sort());
  assert.ok(rows.every(row => row[2].trim() && row[3].trim()));
});

test("actual packed Vite initializes and builds offline, then boots without Next, source, Vite or Codegen", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-vite-packed-"));
  try {
    const consumer = path.join(temporary, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}');
    const archives = [];
    for (const owner of ["core", "codegen", "react", "vite"]) {
      const [pack] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", temporary], path.join(repository, "packages", owner)));
      archives.push(path.join(temporary, pack.filename));
      assert.ok(pack.files.some(file => file.path === "LICENSE"));
      if (owner === "vite") assert.ok(pack.files.some(file => file.path === "bin/fluxfast-vite.js" && (file.mode & 0o111)));
    }
    run("npm", ["install", ...archives, "--legacy-peer-deps", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--no-package-lock"], consumer);
    copyExternalGraph(consumer);
    for (const name of ["next", "@fluxfast/next", "@fluxfast/devtools"]) assert.equal(fs.existsSync(path.join(consumer, "node_modules", name)), false, name);
    const manifestFile = path.join(consumer, "package.json");
    const installed = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    installed.dependencies = { ...installed.dependencies, react: ">=19", "react-dom": ">=19", vite: ">=7.3.6 <8" };
    installed.scripts = { dev: "vite", build: "original-spa-build", start: "original-spa-start" };
    fs.writeFileSync(manifestFile, JSON.stringify(installed));
    const originalConfig = 'export default async context => ({logLevel:"silent",define:{__ORIGINAL_CONFIG__:JSON.stringify(context.command)},plugins:[{name:"original",config(){return {define:{__ORIGINAL_PLUGIN__:JSON.stringify("retained")}}}}]});';
    fs.writeFileSync(path.join(consumer, "vite.config.mjs"), originalConfig);
    fs.writeFileSync(path.join(consumer, "index.html"), "Original SPA document");
    fs.mkdirSync(path.join(consumer, "src"));
    fs.writeFileSync(path.join(consumer, "src/main.tsx"), "// Original SPA entry\n");
    fs.writeFileSync(path.join(consumer, "tsconfig.json"), '{"compilerOptions":{"jsx":"react-jsx"}}');
    const binary = "node_modules/@fluxfast/vite/bin/fluxfast-vite.js";
    assert.match(run(process.execPath, [binary, "init", "--dry-run"], consumer), /No files were changed/);
    assert.equal(fs.existsSync(path.join(consumer, "fluxfast.html")), false);
    run(process.execPath, [binary, "init", "--yes"], consumer);
    assert.equal(fs.readFileSync(path.join(consumer, "vite.config.mjs"), "utf8"), originalConfig);
    assert.equal(fs.readFileSync(path.join(consumer, "index.html"), "utf8"), "Original SPA document");
    assert.equal(fs.readFileSync(path.join(consumer, "src/main.tsx"), "utf8"), "// Original SPA entry\n");
    const scripts = JSON.parse(fs.readFileSync(manifestFile, "utf8")).scripts;
    assert.equal(scripts.dev, "vite"); assert.equal(scripts.build, "original-spa-build"); assert.equal(scripts.start, "original-spa-start");
    assert.equal(scripts["fluxfast:build"], "fluxfast-vite build --config fluxfast.vite.config.mjs");
    run(process.execPath, [binary, "init", "--check"], consumer);
    fs.writeFileSync(path.join(consumer, "src/flux-pages/home/index.tsx"), 'import {useResource} from "@fluxfast/react"; export default function Home(){return <main><h1>{useResource<string>("greeting")}</h1><p>{__ORIGINAL_CONFIG__}:{__ORIGINAL_PLUGIN__}</p></main>;}');
    fs.copyFileSync(path.join(repository, "tests/fixtures/adapter-baseline-v1.1.0/schema.generated.json"), path.join(consumer, "backend-schema.json"));
    run(process.execPath, [binary, "generate", "--schema-file", "backend-schema.json"], consumer);
    for (const name of ["pages", "types", "validators", "routes", "mutations"]) assert.ok(fs.existsSync(path.join(consumer, "src/.fluxfast", name + ".generated.ts")));
    run(process.execPath, [binary, "generate", "--check"], consumer);
    run(process.execPath, [binary, "doctor"], consumer);
    const types = `
      import {fluxfast,buildFluxViteApp,type FluxViteOptions,type FluxViteBuildOptions} from "@fluxfast/vite";
      import {createFluxViteServer,type FluxViteServer,type FluxViteServerOptions} from "@fluxfast/vite/server";
      const plugin:FluxViteOptions={application:"src/application.tsx",cache:{maxPages:20}};
      const build:FluxViteBuildOptions={root:"."};
      const host:FluxViteServerOptions={mode:"production",port:3000};
      fluxfast(plugin); const built:Promise<void>=buildFluxViteApp(build);
      const server:Promise<FluxViteServer>=createFluxViteServer(host);
      // @ts-expect-error Preview/SPA mode does not satisfy the SSR host contract.
      createFluxViteServer({mode:"preview"});
      // @ts-expect-error Private backend config is not a build-time option.
      buildFluxViteApp({backendUrl:"http://backend.invalid"});
      // @ts-expect-error Application export must be a named identifier.
      fluxfast({applicationExport:42});
    `;
    for (const extension of ["cts", "mts"]) fs.writeFileSync(path.join(consumer, "consumer." + extension), types);
    run(process.execPath, [path.join(path.dirname(resolver.resolve("typescript/package.json")), "bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--lib", "ES2022,DOM,DOM.Iterable", "consumer.cts", "consumer.mts"], consumer);
    fs.writeFileSync(path.join(consumer, "probe.mjs"), `
      import assert from "node:assert/strict"; import fs from "node:fs"; import {createServer} from "node:http"; import {createRequire} from "node:module";
      import * as esm from "@fluxfast/vite"; import {createFluxViteServer} from "@fluxfast/vite/server";
      const require=createRequire(import.meta.url); const cjs=require("@fluxfast/vite");
      assert.deepEqual(Object.keys(esm).sort(),["buildFluxViteApp","fluxfast"]);
      assert.deepEqual(Object.keys(cjs).sort(),["buildFluxViteApp","fluxfast"]);
      assert.equal(typeof require("@fluxfast/vite/server").createFluxViteServer,"function");
      for(const specifier of ["@fluxfast/vite/plugin","@fluxfast/vite/cli","@fluxfast/vite/dist/server.js"])assert.throws(()=>require(specifier),{code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
      await esm.buildFluxViteApp({configFile:"fluxfast.vite.config.mjs"});
      fs.rmSync("src",{recursive:true});fs.rmSync("fluxfast.html");
      fs.writeFileSync("fluxfast.vite.config.mjs",'throw new Error("Production evaluated host config");');
      fs.writeFileSync("vite.config.mjs",'throw new Error("Production evaluated source config");');
      fs.renameSync("node_modules/vite","node_modules/vite-not-available");
      fs.renameSync("node_modules/@fluxfast/codegen","node_modules/@fluxfast/codegen-not-available");
    `);
    run(process.execPath, [binary, "build", "--config", "fluxfast.vite.config.mjs"], consumer);
    run(process.execPath, ["probe.mjs"], consumer);
    fs.writeFileSync(path.join(consumer, "production-probe.mjs"), `
      import assert from "node:assert/strict"; import {createServer} from "node:http";
      import {createFluxViteServer} from "@fluxfast/vite/server";
      const backend=createServer((request,response)=>{response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({protocol:"fluxfast/1",page:{component:"home/index",url:request.url},resourceKeys:["greeting"],resources:{greeting:{value:"Actual packed SSR",version:"opaque-v1"}}}));});
      await new Promise(resolve=>backend.listen(0,"127.0.0.1",resolve));
      const host=await createFluxViteServer({mode:"production",backendUrl:"http://127.0.0.1:"+backend.address().port,port:0});
      try{const response=await fetch(host.url);assert.equal(response.status,200);const html=await response.text();assert.ok(html.includes("<h1>Actual packed SSR</h1>"));assert.ok(html.includes("build<!-- -->:<!-- -->retained"),html);}
      finally{await host.close();await new Promise(resolve=>{backend.close(resolve);backend.closeAllConnections();});}
    `);
    // A fresh process prevents development imports from hiding a production
    // dependency on Vite, Codegen, source files or executable source config.
    run(process.execPath, ["production-probe.mjs"], consumer);
    assert.match(run(process.execPath, [binary, "--help"], consumer), /fluxfast-vite init/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
