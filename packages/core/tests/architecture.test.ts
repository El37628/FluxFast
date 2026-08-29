import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("framework-neutral architecture", () => {
  it("does not import UI frameworks from core", () => {
    const sourceDirectory = path.resolve(import.meta.dirname, "../src");
    const source = fs.readdirSync(sourceDirectory)
      .filter(file => file.endsWith(".ts"))
      .map(file => fs.readFileSync(path.join(sourceDirectory, file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /from\s+["'](?:react|next(?:\/|["'])|vue|svelte|solid)/
    );
    expect(source).not.toMatch(/\bBuffer\b/);
  });
});
