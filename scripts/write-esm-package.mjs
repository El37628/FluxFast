import fs from "node:fs";
import path from "node:path";

const relativeTarget = process.argv[2];
if (relativeTarget === undefined) {
  throw new TypeError("Usage: node write-esm-package.mjs <output-directory>");
}

const packageRoot = process.cwd();
const outputDirectory = path.resolve(packageRoot, relativeTarget);
const relativeOutput = path.relative(packageRoot, outputDirectory);
if (
  relativeOutput === "" ||
  relativeOutput.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativeOutput)
) {
  throw new TypeError("ESM output directory must be inside the package root");
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  "utf8"
);
