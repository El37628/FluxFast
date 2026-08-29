import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  planNextConfigIntegration,
  transformNextConfig,
} from "../../src/cli/next-config";
import { detectFluxProject } from "../../src/cli/project";
import { createTestProject, writeTestFile } from "./helpers";

describe("Next config integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wraps a TypeScript config variable and preserves existing source", () => {
    const before =
      'import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = { reactStrictMode: true };\n\nexport default nextConfig;\n';
    const result = transformNextConfig(before, "ts");

    expect(result.status).toBe("modified");
    expect(result.content).toContain(
      'import { withFluxFast } from "@fluxfast/next/next-config";'
    );
    expect(result.content).toContain(
      "const nextConfig: NextConfig = { reactStrictMode: true };"
    );
    expect(result.content).toContain("export default withFluxFast(nextConfig);");
  });

  it("wraps a multiline inline object", () => {
    const result = transformNextConfig(
      "export default {\n  reactStrictMode: true,\n  images: { formats: [\"image/avif\"] },\n};\n",
      "mjs"
    );

    expect(result.status).toBe("modified");
    expect(result.content).toContain("export default withFluxFast({");
    expect(result.content).toContain('formats: ["image/avif"]');
    expect(result.content).toContain("});");
  });

  it("wraps a CommonJS config", () => {
    const result = transformNextConfig(
      "const nextConfig = { reactStrictMode: true };\nmodule.exports = nextConfig;\n",
      "cjs"
    );

    expect(result.status).toBe("modified");
    expect(result.content).toContain(
      'const { withFluxFast } = require("@fluxfast/next/next-config");'
    );
    expect(result.content).toContain(
      "module.exports = withFluxFast(nextConfig);"
    );
  });

  it("is idempotent when withFluxFast is already present", () => {
    const before =
      'import { withFluxFast } from "@fluxfast/next/next-config";\nexport default withFluxFast({});\n';
    const result = transformNextConfig(before, "ts");

    expect(result).toMatchObject({ status: "unchanged", content: before });
  });

  it("refuses to guess ordering for an existing plugin wrapper", () => {
    const before =
      "const nextConfig = {};\nexport default withSentryConfig(nextConfig);\n";
    const result = transformNextConfig(before, "ts");

    expect(result.status).toBe("manual");
    expect(result.reason).toContain("configuration wrapper");
    expect(result.content).toBe(before);
  });

  it("refuses unsupported export syntax without changing content", () => {
    const before = "export default createConfig(() => ({ reactStrictMode: true }));\n";
    const result = transformNextConfig(before, "mjs");

    expect(result.status).toBe("manual");
    expect(result.content).toBe(before);
  });

  it("plans a new config when none exists", () => {
    createTestProject(tmpDir);
    const project = detectFluxProject(tmpDir);
    const result = planNextConfigIntegration(project);

    expect(result.operation).toMatchObject({
      type: "create",
      path: path.join(tmpDir, "next.config.ts"),
    });
    expect(
      result.operation && "content" in result.operation
        ? result.operation.content
        : ""
    ).toContain("export default withFluxFast(nextConfig);");
    expect(result.manualAction).toBeUndefined();
  });

  it("plans a modification while retaining the exact before content", () => {
    createTestProject(tmpDir);
    const configPath = writeTestFile(
      tmpDir,
      "next.config.ts",
      "const nextConfig = {};\nexport default nextConfig;\n"
    );
    const result = planNextConfigIntegration(detectFluxProject(tmpDir));

    expect(result.operation).toMatchObject({
      type: "modify",
      path: configPath,
      before: "const nextConfig = {};\nexport default nextConfig;\n",
    });
  });
});
