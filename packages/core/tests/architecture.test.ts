import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("framework-neutral architecture", () => {
  it("does not import UI frameworks from core", () => {
    const sourceDirectory = path.resolve(import.meta.dirname, "../src");
    const sourceFiles: string[] = [];
    const pending = [sourceDirectory];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          sourceFiles.push(fs.readFileSync(entryPath, "utf8"));
        }
      }
    }
    const source = sourceFiles.join("\n");

    expect(source).not.toMatch(
      /from\s+["'](?:react|next(?:\/|["'])|vue|svelte|solid)/
    );
    expect(source).not.toMatch(/\bBuffer\b/);
  });
});
