import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createValidator } from "@fluxfast/core";
import { describe, expect, it } from "vitest";
import { generateFluxFastProject } from "../src/generate";
import { compileFluxFastMutations } from "../src/mutation-compiler";
import { compileFluxFastPageRoutes } from "../src/route-compiler";
import { compileFluxFastResourceTypes } from "../src/schema-compiler";
import {
  parseFluxFastSchemaManifest,
  type FluxFastSchemaManifest
} from "../src/schema-manifest";
import {
  compileFluxFastValidators,
  compileJsonSchemaToValidationPlan
} from "../src/validator-compiler";

const fingerprint = "9".repeat(64);

function adversarialManifest(): FluxFastSchemaManifest {
  return parseFluxFastSchemaManifest(JSON.stringify({
    schema: "fluxfast-schema/2",
    producer: "0.8.0",
    fingerprint,
    types: {
      ["__proto__"]: {
        mode: "validation",
        schema: {
          title: "`); globalThis.fluxfastCompromised = true; (`",
          type: "object",
          properties: {
            ["__proto__"]: { type: "string" },
            constructor: { type: "integer" },
            prototype: { type: "boolean" }
          },
          required: ["__proto__", "constructor", "prototype"],
          additionalProperties: false
        }
      },
      constructor: { mode: "serialization", schema: { type: "string" } },
      prototype: { mode: "serialization", schema: { type: "boolean" } },
      "Line\u2028Paragraph\u2029Contract": {
        mode: "serialization",
        schema: { type: "string" }
      }
    },
    resources: {
      "../../rooms`-${globalThis.fluxfastCompromised = true}": {
        schema: { type: "string" }
      }
    },
    pages: [{
      name: "__proto__",
      path: "/safe/{constructor}",
      parameters: [{
        name: "constructor",
        location: "path",
        required: true,
        schema: { type: "string" }
      }]
    }],
    mutations: [{
      name: "prototype",
      path: "/safe/{prototype}",
      method: "POST",
      parameters: [{
        name: "prototype",
        location: "path",
        required: true,
        schema: { type: "string" }
      }],
      body: {
        type: "object",
        properties: { constructor: { type: "string" } },
        required: ["constructor"]
      }
    }]
  }));
}

describe("FluxFast adversarial manifest pipeline", () => {
  it("treats prototype, traversal, separator, and injection-shaped names as data", () => {
    const marker = globalThis as typeof globalThis & {
      fluxfastCompromised?: boolean;
    };
    delete marker.fluxfastCompromised;
    delete (Object.prototype as { fluxfastPolluted?: boolean }).fluxfastPolluted;
    const manifest = adversarialManifest();

    const types = compileFluxFastResourceTypes(manifest);
    const validators = compileFluxFastValidators(manifest);
    const routes = compileFluxFastPageRoutes(manifest);
    const mutations = compileFluxFastMutations(manifest);

    expect(types).toContain("export interface Proto");
    expect(types).toContain('roomsGlobalThisFluxfastCompromisedTrue: "../../rooms`-${globalThis.fluxfastCompromised = true}"');
    expect(validators).toContain("ProtoValidator");
    expect(routes).toContain("proto");
    expect(mutations).toContain("prototype");
    expect(marker.fluxfastCompromised).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("fluxfastPolluted");

    const protoSchema = manifest.types!.__proto__.schema;
    const validator = createValidator(
      compileJsonSchemaToValidationPlan(protoSchema)
    );
    const value = JSON.parse(
      '{"__proto__":"safe","constructor":1,"prototype":true}'
    );
    expect(validator.is(value)).toBe(true);
    expect(validator.is({ ...value, constructor: "unsafe" })).toBe(false);
    expect(marker.fluxfastCompromised).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("fluxfastPolluted");
  });

  it("typechecks every generated artifact and executes the generated validator safely", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "fluxfast-security-generated-")
    );
    const pagesDir = path.join(directory, "src/flux-pages");
    const generatedDir = path.join(directory, "src/.fluxfast");
    const configFile = path.join(directory, "tsconfig.json");
    const outputDirectory = path.join(directory, "dist");
    fs.symlinkSync(
      path.resolve(__dirname, "../node_modules"),
      path.join(directory, "node_modules"),
      "dir"
    );
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(pagesDir, "safe.tsx"),
      "export default function SafePage() { return null; }\n",
      "utf8"
    );

    try {
      const result = generateFluxFastProject({
        pagesDir,
        generatedDir,
        outputFile: path.join(generatedDir, "pages.generated.ts"),
        schemaFile: path.join(generatedDir, "schema.generated.json"),
        schemaContent: `${JSON.stringify(adversarialManifest())}\n`,
        log: false
      });
      fs.writeFileSync(
        configFile,
        `${JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "react-jsx",
            strict: true,
            skipLibCheck: true,
            esModuleInterop: true,
            types: ["node"],
            noEmit: true,
            paths: {
              "@fluxfast/core": [
                path.resolve(__dirname, "../../core/src/index.ts")
              ],
              "@fluxfast/next": [path.resolve(__dirname, "../src/index.ts")]
            }
          },
          files: [
            ...result.generatedFiles,
            path.join(pagesDir, "safe.tsx")
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      const typecheck = spawnSync(
        path.resolve(__dirname, "../node_modules/typescript/bin/tsc"),
        ["--project", configFile],
        { encoding: "utf8" }
      );
      expect(`${typecheck.stdout}${typecheck.stderr}`).toBe("");
      expect(typecheck.status).toBe(0);

      const validatorsFile = path.join(
        generatedDir,
        "validators.generated.ts"
      );
      const emission = spawnSync(
        path.resolve(__dirname, "../node_modules/typescript/bin/tsc"),
        [
          "--ignoreConfig",
          "--noCheck",
          "--target",
          "ES2022",
          "--module",
          "Node16",
          "--moduleResolution",
          "Node16",
          "--outDir",
          outputDirectory,
          validatorsFile
        ],
        { encoding: "utf8" }
      );
      expect(`${emission.stdout}${emission.stderr}`).toBe("");
      expect(emission.status).toBe(0);

      const generatedJavaScript = path.join(
        outputDirectory,
        "validators.generated.js"
      );
      const execution = spawnSync(
        process.execPath,
        [
          "-e",
          `delete globalThis.fluxfastCompromised;
delete Object.prototype.fluxfastPolluted;
const { ProtoValidator } = require(${JSON.stringify(generatedJavaScript)});
const value = JSON.parse('{"__proto__":"safe","constructor":1,"prototype":true}');
if (!ProtoValidator.is(value)) throw new Error("generated validator rejected safe input");
if (ProtoValidator.is({ ...value, constructor: "unsafe" })) throw new Error("generated validator accepted unsafe input");
if (globalThis.fluxfastCompromised !== undefined) throw new Error("global injection executed");
if (Object.prototype.fluxfastPolluted !== undefined) throw new Error("prototype pollution occurred");`
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_PATH: path.resolve(__dirname, "../node_modules")
          }
        }
      );
      expect(execution.stderr).toBe("");
      expect(execution.status).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
