import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProjectDetectionError,
  classifyPackageCompatibility,
  detectFluxProject,
} from "../../src/cli/project";

interface ProjectPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe("FluxFast project analyzer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-project-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(relativePath: string, content = ""): string {
    const target = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return target;
  }

  function writePackageJson(manifest: ProjectPackageJson): void {
    write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  }

  function writeInstalledPackage(name: string, version: string): void {
    write(
      path.join("node_modules", ...name.split("/"), "package.json"),
      `${JSON.stringify({ name, version }, null, 2)}\n`
    );
  }

  it("detects a TypeScript src App Router project from a nested directory", () => {
    writePackageJson({
      dependencies: {
        "@fluxfast/next": "^0.1.0",
        next: "^16.3.0",
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
    });
    write("tsconfig.json", "{}\n");
    write("next.config.ts", "export default {};\n");
    write("src/app/page.tsx", "export default function Home() { return null; }\n");
    write("src/app/(flux)/[[...flux]]/page.tsx", "export default null;\n");
    write("src/fluxfast.config.ts", "export const fluxConfig = {};\n");
    write("src/.fluxfast/pages.generated.ts", "export {};\n");
    writeInstalledPackage("next", "16.3.3");
    writeInstalledPackage("react", "19.2.0");
    writeInstalledPackage("react-dom", "19.2.0");
    writeInstalledPackage("@fluxfast/next", "0.1.0");

    const project = detectFluxProject(path.join(tmpDir, "src/app"));

    expect(project.root).toBe(tmpDir);
    expect(project.usesSrcDirectory).toBe(true);
    expect(project.hasAppRouter).toBe(true);
    expect(project.language).toBe("typescript");
    expect(project.appDir).toBe(path.join(tmpDir, "src/app"));
    expect(project.fluxPagesDir).toBe(path.join(tmpDir, "src/flux-pages"));
    expect(project.generatedDir).toBe(path.join(tmpDir, "src/.fluxfast"));
    expect(project.configPath).toBe(path.join(tmpDir, "src/fluxfast.config.ts"));
    expect(project.nextConfigPath).toBe(path.join(tmpDir, "next.config.ts"));
    expect(project.nextConfigFormat).toBe("ts");
    expect(project.rootPagePath).toBe(path.join(tmpDir, "src/app/page.tsx"));
    expect(project.catchAllPath).toBe(
      path.join(tmpDir, "src/app/(flux)/[[...flux]]/page.tsx")
    );
    expect(project.registryPath).toBe(
      path.join(tmpDir, "src/.fluxfast/pages.generated.ts")
    );
    expect(project.packages.next).toMatchObject({
      declaredVersion: "^16.3.0",
      installedVersion: "16.3.3",
      effectiveVersion: "16.3.3",
      compatibility: "supported",
    });
    expect(project.packages.react.compatibility).toBe("supported");
    expect(project.packages.fluxfastNext.installedVersion).toBe("0.1.0");
  });

  it("detects a root JavaScript Pages Router project without inventing App Router", () => {
    writePackageJson({
      dependencies: {
        "@fluxfast/next": "^0.1.0",
        next: "15.4.2",
        react: "19.1.0",
      },
    });
    write("jsconfig.json", "{}\n");
    write("next.config.mjs", "export default {};\n");
    write("pages/index.jsx", "export default function Home() { return null; }\n");

    const project = detectFluxProject(tmpDir);

    expect(project.usesSrcDirectory).toBe(false);
    expect(project.hasAppRouter).toBe(false);
    expect(project.pagesRouterDir).toBe(path.join(tmpDir, "pages"));
    expect(project.language).toBe("javascript");
    expect(project.appDir).toBe(path.join(tmpDir, "app"));
    expect(project.configPath).toBe(path.join(tmpDir, "fluxfast.config.js"));
    expect(project.nextConfigFormat).toBe("mjs");
    expect(project.rootPagePath).toBeUndefined();
    expect(project.packages.next).toMatchObject({
      effectiveVersion: "15.4.2",
      compatibility: "unsupported",
    });
    expect(project.packages.reactDom.compatibility).toBe("unknown");
  });

  it("uses an existing TSX source file as a TypeScript signal", () => {
    writePackageJson({ dependencies: { next: "16.3.3" } });
    write("app/dashboard/page.tsx", "export default null;\n");

    const project = detectFluxProject(tmpDir);

    expect(project.hasAppRouter).toBe(true);
    expect(project.language).toBe("typescript");
    expect(project.configPath).toBe(path.join(tmpDir, "fluxfast.config.ts"));
  });

  it("preserves detection of an existing config with a different extension", () => {
    writePackageJson({ dependencies: { next: "16.3.3" } });
    write("tsconfig.json", "{}\n");
    write("app/layout.tsx", "export default function Layout() { return null; }\n");
    write("fluxfast.config.js", "export const fluxConfig = {};\n");

    const project = detectFluxProject(tmpDir);

    expect(project.language).toBe("typescript");
    expect(project.configPath).toBe(path.join(tmpDir, "fluxfast.config.js"));
    expect(project.configPaths).toEqual([path.join(tmpDir, "fluxfast.config.js")]);
  });

  it("prefers installed package versions while retaining declared ranges", () => {
    writePackageJson({
      devDependencies: {
        "@fluxfast/next": "workspace:*",
        next: "latest",
        react: ">=19",
      },
    });
    write("app/layout.jsx", "export default function Layout({ children }) { return children; }\n");
    writeInstalledPackage("next", "16.4.1");
    writeInstalledPackage("react", "19.3.0");

    const project = detectFluxProject(tmpDir);

    expect(project.packages.next).toMatchObject({
      declaredVersion: "latest",
      installedVersion: "16.4.1",
      effectiveVersion: "16.4.1",
      compatibility: "supported",
    });
    expect(project.packages.fluxfastNext).toMatchObject({
      declaredVersion: "workspace:*",
      installedVersion: undefined,
      compatibility: "probably-supported",
    });
  });

  it("finds @fluxfast/core installed transitively beneath @fluxfast/next", () => {
    writePackageJson({
      dependencies: {
        "@fluxfast/next": "^0.1.0",
        next: "16.3.3",
      },
    });
    write("app/layout.tsx", "export default function Layout() { return null; }\n");
    write(
      "node_modules/@fluxfast/next/node_modules/@fluxfast/core/package.json",
      '{"name":"@fluxfast/core","version":"0.1.2"}\n'
    );

    const project = detectFluxProject(tmpDir);

    expect(project.packages.fluxfastCore).toMatchObject({
      installedVersion: "0.1.2",
      compatibility: "supported",
    });
  });

  it("classifies exact, range, unsupported, and unknown versions conservatively", () => {
    expect(classifyPackageCompatibility("next", "16.3.0")).toBe("supported");
    expect(classifyPackageCompatibility("next", "16.2.9")).toBe("unsupported");
    expect(classifyPackageCompatibility("next", "^16.3.0")).toBe(
      "probably-supported"
    );
    expect(classifyPackageCompatibility("next", "^15.0.0")).toBe("unsupported");
    expect(classifyPackageCompatibility("next", "latest")).toBe("unknown");
    expect(classifyPackageCompatibility("react", ">=19")).toBe(
      "probably-supported"
    );
    expect(classifyPackageCompatibility("react", "18.3.1")).toBe("unsupported");
    expect(classifyPackageCompatibility("@fluxfast/next", "workspace:*")).toBe(
      "probably-supported"
    );
  });

  it("fails clearly when no package.json can be found", () => {
    const nested = path.join(tmpDir, "not-a-project");
    fs.mkdirSync(nested);

    expect(() => detectFluxProject(nested)).toThrow(ProjectDetectionError);
    expect(() => detectFluxProject(nested)).toThrow(/package\.json/);
  });
});
