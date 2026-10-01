import fs from "node:fs";
import path from "node:path";

export function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/** Find project metadata without loading a framework or evaluating config. */
export function findCodegenProjectRoot(startPath: string): string {
  let current = path.resolve(startPath);
  try {
    if (fs.statSync(current).isFile()) current = path.dirname(current);
  } catch {
    // Like the existing tooling, search parent directories for metadata.
  }
  while (true) {
    const packageJson = path.join(current, "package.json");
    let exists = false;
    try {
      exists = fs.statSync(packageJson).isFile();
    } catch {
      // Missing metadata at this level is not itself a malformed project.
    }
    if (exists) {
      let metadata: unknown;
      try {
        metadata = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read package.json at ${packageJson}. ${detail}`);
      }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error(`Expected package.json at ${packageJson} to contain a JSON object.`);
      }
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find package.json from ${path.resolve(startPath)} or any parent directory.`);
    }
    current = parent;
  }
}
