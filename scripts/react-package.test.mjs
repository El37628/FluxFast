import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPublicApiSnapshot } from "./public-api-snapshot.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const reactRequire = createRequire(path.join(repository, "packages/react/package.json"));

function success(binary, args, cwd) {
  const result = spawnSync(binary, args, {
    cwd, encoding: "utf8", timeout: 90_000,
    shell: process.platform === "win32" && binary === "npm",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${binary}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

test("React owns framework bindings without Next or server/tooling imports", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, "packages/react/package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies), ["@fluxfast/core"]);
  assert.deepEqual(manifest.peerDependencies, { react: ">=19.0.0", "react-dom": ">=19.0.0" });
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  for (const file of fs.readdirSync(path.join(repository, "packages/react/src"))) {
    const source = fs.readFileSync(path.join(repository, "packages/react/src", file), "utf8");
    assert.doesNotMatch(source, /(?:from\s+|require\s*\(\s*|import\s*\(\s*)["'](?:next(?:\/|["'])|@fluxfast\/(?:next|codegen|devtools)|@fluxfast\/core\/server|node:)/, file);
  }
});

test("React documents an example for every public value and type", () => {
  const entry = createPublicApiSnapshot().packages["@fluxfast/react"].entries["."];
  const guide = fs.readFileSync(path.join(repository, "docs/react-api.md"), "utf8");
  const block = guide.split("<!-- react-api-examples:start -->")[1]?.split("<!-- react-api-examples:end -->")[0];
  assert.ok(block);
  const names = [...block.matchAll(/^\| `([A-Za-z_][\w]*)` \|/gm)].map(match => match[1]);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), Object.values(entry).flat().sort());
  assert.match(guide, /unreleased/i);
});

test("packed React and DevTools support SSR, CJS, ESM, and strict types without installing Next", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-react-consumer-"));
  try {
    const consumer = path.join(temporary, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true}');
    const archives = [];
    const reactDomRequire = createRequire(reactRequire.resolve("react-dom/package.json"));
    const typeRequire = createRequire(reactRequire.resolve("@types/react/package.json"));
    const roots = ["core", "react", "devtools"].map(owner => path.join(repository, "packages", owner));
    for (const [resolver, names] of [[reactRequire, ["react", "react-dom"]], [reactDomRequire, ["scheduler"]]]) {
      roots.push(...names.map(name => path.dirname(fs.realpathSync(resolver.resolve(name + "/package.json")))));
    }
    for (const root of roots) {
      const [pack] = JSON.parse(success("npm", ["pack", root, "--ignore-scripts", "--offline", "--json", "--pack-destination", temporary], consumer));
      archives.push(path.join(temporary, pack.filename));
      if (pack.name === "@fluxfast/react") {
        for (const entry of ["README.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "dist/esm/index.js", "dist/esm/package.json"]) {
          assert.ok(pack.files.some(file => file.path === entry), "missing React packed target: " + entry);
        }
      }
    }
    success("npm", ["install", ...archives, "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--no-package-lock"], consumer);
    // External development typings are copied, never linked back to workspace
    // sources. npm 11 cannot reliably repack installed type-only packages with
    // an empty main field. All FluxFast packages still come only from tarballs.
    for (const [resolver, names] of [[reactRequire, ["@types/react", "@types/react-dom"]], [typeRequire, ["csstype"]]]) {
      for (const name of names) {
        const root = path.dirname(fs.realpathSync(resolver.resolve(name + "/package.json")));
        fs.cpSync(root, path.join(consumer, "node_modules", name), { recursive: true, dereference: true });
      }
    }
    for (const name of ["next", "@fluxfast/next", "@fluxfast/codegen"]) {
      assert.equal(fs.existsSync(path.join(consumer, "node_modules", name)), false, name + " must not be installed");
    }
    const expected = createPublicApiSnapshot().packages["@fluxfast/react"].entries["."].valueOnly;
    fs.writeFileSync(path.join(consumer, "probe.mjs"), `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import React from "react";
      import { renderToString } from "react-dom/server";
      import * as esm from "@fluxfast/react";
      const require = createRequire(import.meta.url);
      const cjs = require("@fluxfast/react");
      for (const api of [esm, cjs]) {
        assert.deepEqual(Object.keys(api).sort(), ${JSON.stringify(expected)});
        function Page() {
          const greeting = api.useResource("greeting");
          assert.equal(api.useDeferredResource("later").isPending, true);
          assert.equal(api.useLiveStatus().status, "idle");
          return React.createElement("h1", null, greeting);
        }
        const html = renderToString(React.createElement(api.FluxRoot, {
          initialEnvelope: {protocol:"fluxfast/1", page:{component:"home/index",url:"/"}, resources:{greeting:{value:"Real SSR",version:"v1"}}, deferred:["later"]},
          registry:{"home/index":Page},
        }));
        assert.ok(html.includes("<h1>Real SSR</h1>"), html);
        assert.throws(() => api.resolveComponent("untrusted/arbitrary/module", {}), /not found/);
      }
      const tools = await import("@fluxfast/devtools");
      assert.equal(typeof tools.FluxDevtools, "function");
      for (const specifier of ["@fluxfast/react/provider", "@fluxfast/react/dist/index.js", "@fluxfast/react/server"]) {
        assert.throws(() => require(specifier), {code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
        await assert.rejects(import(specifier), {code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
      }
    `);
    success(process.execPath, ["probe.mjs"], consumer);
    const source = `
      import React from "react";
      import { FluxRoot, FluxProvider, useFlux, usePage, useResource, useResourceState,
        useDeferredResource, useLiveStatus, useForm, Link, resolveComponent,
        type FluxApplicationProps, type ComponentRegistry } from "@fluxfast/react";
      import { FluxDevtools } from "@fluxfast/devtools";
      import type { PageEnvelope } from "@fluxfast/core";
      declare const initialEnvelope: PageEnvelope;
      function Page() {
        const text: string = useResource<string>("text");
        const state = useResourceState<string>("text");
        const later = useDeferredResource<number>("later");
        const form = useForm({ name: "" });
        form.setData("name", "Ada");
        // @ts-expect-error Form field values retain their declared type.
        form.setData("name", 42);
        const url: string = usePage().url;
        const connected: boolean = useLiveStatus().connected;
        const visit: Promise<void> = useFlux().router.visit(url);
        return React.createElement(Link, {href:"/rooms"}, text);
      }
      const registry: ComponentRegistry = {"home/index":Page};
      const application: FluxApplicationProps = {initialEnvelope};
      React.createElement(FluxRoot, {...application, registry});
      React.createElement(FluxProvider, {initialEnvelope, children:React.createElement(FluxDevtools)});
      resolveComponent("home/index", registry);
      // @ts-expect-error FluxRoot requires an allowlisted registry.
      React.createElement(FluxRoot, application);
    `;
    for (const extension of ["cts", "mts"]) fs.writeFileSync(path.join(consumer, "consumer." + extension), source);
    success(process.execPath, [path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "Node16", "--moduleResolution", "Node16", "--target", "ES2022", "--esModuleInterop", "consumer.cts", "consumer.mts"], consumer);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
