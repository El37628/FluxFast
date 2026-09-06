import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_UI_PACKAGES =
  /^(?:(?:react(?:-dom)?|next|vue|svelte|solid-js)(?:\/|$)|@(?:vue|sveltejs|solidjs)\/)/;

function sourceFiles(): Array<{ path: string; source: string }> {
  const sourceDirectory = path.resolve(import.meta.dirname, "../src");
  const files: Array<{ path: string; source: string }> = [];
  const pending = [sourceDirectory];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push({ path: entryPath, source: fs.readFileSync(entryPath, "utf8") });
      }
    }
  }
  return files;
}

function importedPackages(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

describe("framework-neutral architecture", () => {
  it.each([
    "react",
    "react/jsx-runtime",
    "react-dom/client",
    "next/server",
    "vue",
    "@vue/runtime-dom",
    "svelte/store",
    "@sveltejs/kit",
    "solid-js",
    "@solidjs/router",
  ])("recognizes the UI-framework package %s", specifier => {
    expect(FORBIDDEN_UI_PACKAGES.test(specifier)).toBe(true);
  });

  it("recognizes static, re-exported, dynamic, and CommonJS module specifiers", () => {
    const source = [
      'import type { ReactNode } from "react";',
      'export { render } from "react-dom/server";',
      'const next = import("next/server");',
      'const vue = require("@vue/runtime-core");',
    ].join("\n");

    expect(importedPackages(source).toSorted()).toEqual([
      "@vue/runtime-core",
      "next/server",
      "react",
      "react-dom/server",
    ]);
  });

  it("has no static, dynamic, or CommonJS UI-framework imports", () => {
    for (const file of sourceFiles()) {
      for (const specifier of importedPackages(file.source)) {
        expect(
          FORBIDDEN_UI_PACKAGES.test(specifier),
          `${path.relative(process.cwd(), file.path)} imports ${specifier}`
        ).toBe(false);
      }
    }
  });

  it("publishes with zero runtime or peer dependencies", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")
    ) as Record<string, unknown>;

    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.optionalDependencies).toBeUndefined();
    expect(packageJson.peerDependencies).toBeUndefined();
  });

  it("does not rely on the Node Buffer global", () => {
    const source = sourceFiles()
      .map(file => file.source)
      .join("\n");

    expect(source).not.toMatch(/\bBuffer\b/);
  });
});
