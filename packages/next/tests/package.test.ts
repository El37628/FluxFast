import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("published package", () => {
  it("ships an executable CLI entry point", () => {
    const cli = path.resolve(__dirname, "../bin/fluxfast.js");
    const license = path.resolve(__dirname, "../LICENSE");
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")
    );

    expect(manifest.bin.fluxfast).toBe("bin/fluxfast.js");
    expect(fs.statSync(cli).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(license, "utf8")).toContain("MIT License");
  });
});
