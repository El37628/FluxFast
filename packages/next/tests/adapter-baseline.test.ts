import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/index";
import { checkFluxFastProject, generateFluxFastProject } from "../src/generate";
import { createTestProject, writeTestFile } from "./cli/helpers";

const fixtureRoot = path.resolve(
  __dirname,
  "../../../tests/fixtures/adapter-baseline-v1.1.0"
);
const baseline = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "baseline.json"), "utf8")
) as {
  capturedFrom: string;
  schemaSource: string;
  schemaProducer: string;
  pages: Record<string, string>;
  artifactDigests: Record<string, string>;
  cli: Record<"src" | "root", Record<"generate" | "check", {
    status: number;
    stdout: string;
    stderr: string;
  }>>;
};
const artifactNames = [
  "mutations.generated.ts",
  "pages.generated.ts",
  "routes.generated.ts",
  "schema.generated.json",
  "types.generated.ts",
  "validators.generated.ts",
] as const;
const packageVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")
).version as string;
const repositoryRoot = path.resolve(__dirname, "../../..");
const schema = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, baseline.schemaSource), "utf8")
);
schema.producer = baseline.schemaProducer;
const schemaContent = `${JSON.stringify(schema, null, 2)}\n`;

describe("published v1.1 adapter generation baseline", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function prepareProject(layout: "src" | "root") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-adapter-baseline-"));
    temporaryDirectories.push(root);
    createTestProject(root, {
      layout,
      dependencies: {
        "@fluxfast/core": packageVersion,
        "@fluxfast/next": packageVersion,
        next: "16.3.0",
        react: "19.0.0",
        "react-dom": "19.0.0",
      },
    });
    for (const name of ["core", "next"]) {
      writeTestFile(
        root,
        `node_modules/@fluxfast/${name}/package.json`,
        `${JSON.stringify({ name: `@fluxfast/${name}`, version: packageVersion })}\n`
      );
    }
    const prefix = layout === "src" ? "src/" : "";
    const pagesDir = path.join(root, prefix, "flux-pages");
    const generatedDir = path.join(root, prefix, ".fluxfast");
    for (const [name, source] of Object.entries(baseline.pages)) {
      writeTestFile(root, `${prefix}flux-pages/${name}`, source);
    }
    writeTestFile(root, "backend-schema.json", schemaContent);
    return {
      root,
      generatedDir,
      options: {
        pagesDir,
        generatedDir,
        outputFile: path.join(generatedDir, "pages.generated.ts"),
        schemaContent,
        log: false,
      },
    };
  }

  function generatedState(generatedDir: string) {
    return Object.fromEntries(artifactNames.map(name => {
      const file = path.join(generatedDir, name);
      return [name, {
        bytes: fs.readFileSync(file),
        modified: fs.statSync(file, { bigint: true }).mtimeNs,
      }];
    }));
  }

  function invoke(root: string, args: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const status = runCli(args, {
      cwd: root,
      stdout: message => stdout.push(message),
      stderr: message => stderr.push(message),
    });
    return {
      status,
      stdout: stdout.length ? `${stdout.join("\n")}\n` : "",
      stderr: stderr.length ? `${stderr.join("\n")}\n` : "",
    };
  }

  function expectPublishedArtifacts(generatedDir: string) {
    expect(fs.readdirSync(generatedDir).sort()).toEqual(artifactNames);
    for (const name of artifactNames) {
      expect(fs.readFileSync(path.join(generatedDir, name))).toEqual(
        fs.readFileSync(path.join(fixtureRoot, name))
      );
    }
  }

  it("retains all six integrity-recorded published artifacts", () => {
    expect(baseline.capturedFrom).toBe("@fluxfast/next@1.1.0");
    expect(baseline.schemaProducer).toBe("1.1.0");
    expect(Object.keys(baseline.artifactDigests).sort()).toEqual(artifactNames);
    for (const name of artifactNames) {
      expect(createHash("sha256")
        .update(fs.readFileSync(path.join(fixtureRoot, name)))
        .digest("hex")).toBe(baseline.artifactDigests[name]);
    }
  });

  it.each(["src", "root"] as const)(
    "matches every published byte in the %s layout through the public generator",
    layout => {
      const { generatedDir, options } = prepareProject(layout);
      generateFluxFastProject(options);
      expectPublishedArtifacts(generatedDir);
      const before = generatedState(generatedDir);
      expect(checkFluxFastProject(options).current).toBe(true);
      expect(generatedState(generatedDir)).toEqual(before);
    }
  );

  it.each(["src", "root"] as const)(
    "preserves published CLI generation and read-only check output for the %s layout",
    layout => {
      const { root, generatedDir } = prepareProject(layout);
      expect(invoke(root, ["generate", "--schema-file", "backend-schema.json"]))
        .toEqual(baseline.cli[layout].generate);
      expectPublishedArtifacts(generatedDir);
      const before = generatedState(generatedDir);
      expect(invoke(root, ["generate", "--schema-file", "backend-schema.json", "--check"]))
        .toEqual(baseline.cli[layout].check);
      expect(generatedState(generatedDir)).toEqual(before);
    }
  );

  it.each(artifactNames)(
    "detects byte-only drift in %s without writing or repairing any artifact",
    name => {
      const { root, generatedDir, options } = prepareProject("src");
      generateFluxFastProject(options);
      fs.appendFileSync(path.join(generatedDir, name), "\n");
      const before = generatedState(generatedDir);
      const result = invoke(root, ["generate", "--check", "--schema-file", "backend-schema.json"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "Rerun the full-stack type generation command without --check."
      );
      expect(generatedState(generatedDir)).toEqual(before);
    }
  );
});
