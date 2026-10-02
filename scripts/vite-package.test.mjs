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
  assert.deepEqual(manifest.dependencies, { "@fluxfast/core": `^${manifest.version}`, "@fluxfast/react": `^${manifest.version}` });
  assert.deepEqual(manifest.bin, { "fluxfast-vite": "bin/fluxfast-vite.js" });
  assert.equal(manifest.peerDependencies.next, undefined);
  const guide = fs.readFileSync(path.join(repository, "docs/vite-host.md"), "utf8");
  const block = guide.split("<!-- vite-api-examples:start -->")[1]?.split("<!-- vite-api-examples:end -->")[0];
  assert.ok(block);
  const rows = [...block.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| ([^\n]+) \|$/gm)];
  assert.deepEqual(rows.map(row => row[1]).sort(), Object.values(snapshot.entries).flatMap(entry => Object.values(entry).flat()).sort());
  assert.ok(rows.every(row => row[2].trim() && row[3].trim()));
});

test("actual packed Vite host builds and boots offline without Next, source config, or Vite in production", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-vite-packed-"));
  try {
    const consumer = path.join(temporary, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}');
    const archives = [];
    for (const owner of ["core", "react", "vite"]) {
      const [pack] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", temporary], path.join(repository, "packages", owner)));
      archives.push(path.join(temporary, pack.filename));
      assert.ok(pack.files.some(file => file.path === "LICENSE"));
      if (owner === "vite") assert.ok(pack.files.some(file => file.path === "bin/fluxfast-vite.js" && (file.mode & 0o111)));
    }
    run("npm", ["install", ...archives, "--legacy-peer-deps", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--no-package-lock"], consumer);
    copyExternalGraph(consumer);
    for (const name of ["next", "@fluxfast/next", "@fluxfast/codegen", "@fluxfast/devtools"]) assert.equal(fs.existsSync(path.join(consumer, "node_modules", name)), false, name);
    fs.writeFileSync(path.join(consumer, "vite.config.mjs"), 'import {fluxfast} from "@fluxfast/vite"; export default {plugins:[fluxfast({application:"src/application.tsx"})],logLevel:"silent"};');
    fs.writeFileSync(path.join(consumer, "fluxfast.html"), '<!doctype html><html><body><div id="fluxfast-root"><!--fluxfast:ssr--></div><!--fluxfast:payload--><script type="module" src="/@fluxfast/client"></script></body></html>');
    fs.mkdirSync(path.join(consumer, "src"));
    fs.writeFileSync(path.join(consumer, "src/application.tsx"), 'import {FluxRoot,useResource} from "@fluxfast/react"; const registry={"home/index":{load:async()=>({default:()=> <h1>{useResource("greeting")}</h1>})}}; export function FluxApplication(props) {return <FluxRoot {...props} registry={registry}/>;}');
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
    run(process.execPath, [path.join(path.dirname(resolver.resolve("typescript/package.json")), "bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--lib", "ES2022,DOM,DOM.Iterable", "consumer.cts", "consumer.mts"], consumer);
    fs.writeFileSync(path.join(consumer, "probe.mjs"), `
      import assert from "node:assert/strict"; import fs from "node:fs"; import {createServer} from "node:http"; import {createRequire} from "node:module";
      import * as esm from "@fluxfast/vite"; import {createFluxViteServer} from "@fluxfast/vite/server";
      const require=createRequire(import.meta.url); const cjs=require("@fluxfast/vite");
      assert.deepEqual(Object.keys(esm).sort(),["buildFluxViteApp","fluxfast"]);
      assert.deepEqual(Object.keys(cjs).sort(),["buildFluxViteApp","fluxfast"]);
      assert.equal(typeof require("@fluxfast/vite/server").createFluxViteServer,"function");
      for(const specifier of ["@fluxfast/vite/plugin","@fluxfast/vite/cli","@fluxfast/vite/dist/server.js"])assert.throws(()=>require(specifier),{code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
      await esm.buildFluxViteApp();
      fs.rmSync("src",{recursive:true});fs.rmSync("fluxfast.html");
      fs.writeFileSync("vite.config.mjs",'throw new Error("Production evaluated source config");');
      fs.renameSync("node_modules/vite","node_modules/vite-not-available");
      const backend=createServer((request,response)=>{response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({protocol:"fluxfast/1",page:{component:"home/index",url:request.url},resourceKeys:["greeting"],resources:{greeting:{value:"Actual packed SSR",version:"opaque-v1"}}}));});
      await new Promise(resolve=>backend.listen(0,"127.0.0.1",resolve));
      const host=await createFluxViteServer({mode:"production",backendUrl:"http://127.0.0.1:"+backend.address().port,port:0});
      try{const response=await fetch(host.url);assert.equal(response.status,200);assert.ok((await response.text()).includes("<h1>Actual packed SSR</h1>"));}
      finally{await host.close();await new Promise(resolve=>{backend.close(resolve);backend.closeAllConnections();});}
    `);
    run(process.execPath, ["probe.mjs"], consumer);
    assert.match(run(process.execPath, ["node_modules/@fluxfast/vite/bin/fluxfast-vite.js", "--help"], consumer), /dev\|build\|start/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
