import fs from "node:fs";
import path from "node:path";

export interface TestProjectOptions {
  language?: "typescript" | "javascript";
  layout?: "src" | "root" | "pages";
  dependencies?: Record<string, string>;
}

export function writeTestFile(
  root: string,
  relativePath: string,
  content = ""
): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

export function createTestProject(
  root: string,
  options: TestProjectOptions = {}
): void {
  const language = options.language ?? "typescript";
  const layout = options.layout ?? "src";
  writeTestFile(
    root,
    "package.json",
    `${JSON.stringify(
      {
        private: true,
        dependencies: options.dependencies ?? {
          "@fluxfast/next": "^0.1.0",
          next: "^16.3.0",
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
      },
      null,
      2
    )}\n`
  );
  if (language === "typescript") {
    writeTestFile(root, "tsconfig.json", "{}\n");
  } else {
    writeTestFile(root, "jsconfig.json", "{}\n");
  }
  const appDirectory = layout === "src" ? "src/app" : layout === "root" ? "app" : "pages";
  fs.mkdirSync(path.join(root, appDirectory), { recursive: true });
}
