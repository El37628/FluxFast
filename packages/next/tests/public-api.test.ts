import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type ExportGroups = Record<string, string[]>;
type NextBaseline = {
  packages: {
    "@fluxfast/next": {
      entries: Record<string, ExportGroups>;
    };
  };
};

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const apiDocumentPath = path.join(repositoryRoot, "docs/next-api.md");
const baselinePath = path.join(
  repositoryRoot,
  "tests/fixtures/public-api-v0.8.1.json"
);
const manifestPath = path.join(repositoryRoot, "packages/next/package.json");

const v09ClientAdditions = {
  typeOnly: ["LiveConnectionStatus", "LiveStatusSnapshot"],
  valueOnly: ["useLiveStatus"],
} as const;

function namesBetween(start: string, end: string): string[] {
  const document = fs.readFileSync(apiDocumentPath, "utf8");
  const section = document.split(start, 2)[1]?.split(end, 1)[0];
  if (section === undefined) {
    throw new Error(`Missing public API inventory markers: ${start}, ${end}`);
  }
  const codeBlock = section.match(/```text\n([\s\S]*?)\n```/);
  if (!codeBlock) throw new Error(`Missing inventory code block after ${start}`);
  return codeBlock[1]
    .split("\n")
    .map(name => name.trim())
    .filter(Boolean);
}

function expectedEntries(): Record<string, ExportGroups> {
  const baseline = JSON.parse(
    fs.readFileSync(baselinePath, "utf8")
  ) as NextBaseline;
  const entries = structuredClone(
    baseline.packages["@fluxfast/next"].entries
  );
  entries["./client"].typeOnly.push(...v09ClientAdditions.typeOnly);
  entries["./client"].valueOnly.push(...v09ClientAdditions.valueOnly);
  return entries;
}

function entryNames(groups: ExportGroups): string[] {
  return Object.values(groups).flat().toSorted();
}

describe("v0.9 Next adapter public API", () => {
  it("classifies every distinct exported name exactly once", () => {
    const stable = namesBetween(
      "<!-- next-api-stable:start -->",
      "<!-- next-api-stable:end -->"
    );
    const advanced = namesBetween(
      "<!-- next-api-advanced:start -->",
      "<!-- next-api-advanced:end -->"
    );
    const classified = [...stable, ...advanced];
    const expected = new Set(
      Object.values(expectedEntries()).flatMap(entry => entryNames(entry))
    );

    expect(stable).toHaveLength(48);
    expect(advanced).toHaveLength(11);
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified.toSorted()).toEqual([...expected].toSorted());
  });

  it("documents the exact exports available through every official path", () => {
    const entries = expectedEntries();
    const inventories = {
      ".": namesBetween(
        "<!-- next-api-entry-root:start -->",
        "<!-- next-api-entry-root:end -->"
      ),
      "./client": namesBetween(
        "<!-- next-api-entry-client:start -->",
        "<!-- next-api-entry-client:end -->"
      ),
      "./server": namesBetween(
        "<!-- next-api-entry-server:start -->",
        "<!-- next-api-entry-server:end -->"
      ),
      "./generate": namesBetween(
        "<!-- next-api-entry-generate:start -->",
        "<!-- next-api-entry-generate:end -->"
      ),
      "./next-config": namesBetween(
        "<!-- next-api-entry-next-config:start -->",
        "<!-- next-api-entry-next-config:end -->"
      ),
    };

    expect(Object.keys(inventories).toSorted()).toEqual(
      Object.keys(entries).toSorted()
    );
    for (const [publicPath, names] of Object.entries(inventories)) {
      expect(new Set(names).size, publicPath).toBe(names.length);
      expect(names.toSorted(), publicPath).toEqual(entryNames(entries[publicPath]));
    }
  });

  it("limits public package paths to the frozen npm exports map", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      exports: Record<string, Record<string, string>>;
    };

    expect(Object.keys(manifest.exports).toSorted()).toEqual(
      Object.keys(expectedEntries()).toSorted()
    );
    for (const [publicPath, conditions] of Object.entries(manifest.exports)) {
      expect(Object.keys(conditions).toSorted(), publicPath).toEqual([
        "default",
        "import",
        "require",
        "types",
      ]);
      for (const target of Object.values(conditions)) {
        expect(target, `${publicPath} export target`).toMatch(/^\.\/dist\//);
      }
    }
  });

  it("keeps existing resource hooks as the live-resource data API", () => {
    const publicNames = Object.values(expectedEntries()).flatMap(entry =>
      entryNames(entry)
    );

    expect(publicNames).toContain("useResource");
    expect(publicNames).toContain("useDeferredResource");
    expect(publicNames).toContain("useLiveStatus");
    expect(publicNames).not.toContain("useLiveResource");
  });
});
