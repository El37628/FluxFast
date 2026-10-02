import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Adapter-import-only projection of the canonical UI; generated files stay local. */
export function prepareReactFixture({ source, frontend, check = false }) {
  const files = [];
  function visit(directory, relative) {
    for (const name of fs.readdirSync(directory).sort()) {
      const input = path.join(directory, name), local = path.join(relative, name);
      const stat = fs.lstatSync(input);
      assert.equal(stat.isSymbolicLink(), false, "Shared fixture must not follow symlinks");
      if (stat.isDirectory()) { visit(input, local); continue; }
      assert.ok(stat.isFile() && /\.(tsx?|jsx?)$/.test(name), "Unexpected shared UI input: " + local);
      const content = fs.readFileSync(input, "utf8").replaceAll('"@fluxfast/next"', '"@fluxfast/react"');
      assert.doesNotMatch(content, /["'](?:next(?:\/[^"']*)?|@fluxfast\/next(?:\/[^"']*)?)["']/, "React UI must not import Next");
      files.push({ local, content });
    }
  }
  const directories = ["components", "flux-pages", "lib"];
  for (const directory of directories) {
    visit(path.join(source, "src", directory), path.join("src", directory));
  }
  const expected = new Set(files.map(({ local }) => local));
  const obsolete = [];
  function inspectOutput(directory, relative) {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory).sort()) {
      const output = path.join(directory, name), local = path.join(relative, name);
      const stat = fs.lstatSync(output);
      assert.equal(stat.isSymbolicLink(), false, "Generated test UI must not follow symlinks");
      if (stat.isDirectory()) inspectOutput(output, local);
      else if (!expected.has(local)) obsolete.push(output);
    }
  }
  for (const directory of directories) {
    inspectOutput(path.join(frontend, "src", directory), path.join("src", directory));
  }
  assert.ok(!check || obsolete.length === 0, "React fixture contains removed shared UI files");
  // These fixed directories contain only this test projection's ignored outputs.
  // Removed canonical pages must not linger as extra React registry entries.
  for (const output of obsolete) fs.unlinkSync(output);
  for (const { local, content } of files) {
    const output = path.join(frontend, local);
    const current = fs.existsSync(output) ? fs.readFileSync(output, "utf8") : undefined;
    if (current === content) continue;
    assert.equal(check, false, "React fixture UI is missing or stale: " + local);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, content);
  }
  return files.map(({ local }) => local);
}
