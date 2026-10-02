import assert from "node:assert/strict";

const typedFiles = new Set([
  "types.generated.ts", "validators.generated.ts", "routes.generated.ts",
  "mutations.generated.ts",
]);

/** Validate the installed producer and normalize only its recorded metadata. */
export function comparableTypedArtifact(name, bytes, producer) {
  const source = bytes.toString("utf8");
  assert.match(producer, /^\d+\.\d+\.\d+$/);
  if (name === "schema.generated.json") {
    assert.equal(JSON.parse(source).producer, producer, "schema must identify the installed Python producer");
    // Published Python uses compact JSON. Locate the top-level value without
    // reserializing (which would hide formatting drift) or changing a nested
    // application field also named producer. JSON.parse above validates syntax.
    const tokens = [...source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)];
    const values = [];
    let depth = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i][0];
      if (token === "{" || token === "[") depth += 1;
      else if (token === "}" || token === "]") depth -= 1;
      else if (depth === 1 && token.startsWith('"') && JSON.parse(token) === "producer" && tokens[i + 1]?.[0] === ":") {
        assert.equal(JSON.parse(tokens[i + 2][0]), producer);
        values.push(tokens[i + 2]);
      }
    }
    assert.equal(values.length, 1, "expected one top-level producer field");
    const value = values[0];
    return Buffer.from(source.slice(0, value.index) + '"<installed-producer>"' + source.slice(value.index + value[0].length));
  }
  if (typedFiles.has(name)) {
    const lines = source.match(/^\/\/ Producer: [^\r\n]+$/gm) ?? [];
    assert.deepEqual(lines, [`// Producer: ${producer}`], "typed output must identify the installed Python producer");
    return Buffer.from(source.replace(lines[0], "// Producer: <installed-producer>"));
  }
  assert.equal(name, "pages.generated.ts", "unexpected generated artifact");
  return bytes;
}
