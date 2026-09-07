import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateFluxFastProject } from "../packages/next/dist/generate.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const fixture = fs.readFileSync(
  path.join(
    repositoryRoot,
    "tests/fixtures/schema/fluxfast-schema-v1.json"
  ),
  "utf8"
);
const temporaryRoot = fs.mkdtempSync(
  path.join(repositoryRoot, ".fluxfast-schema-v1-consumer-")
);
const generatedDir = path.join(temporaryRoot, "src/.fluxfast");
const pagesDir = path.join(temporaryRoot, "src/flux-pages");
const scopedModules = path.join(temporaryRoot, "node_modules/@fluxfast");
const tsc = path.join(
  repositoryRoot,
  "node_modules/.bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc"
);

try {
  fs.mkdirSync(scopedModules, { recursive: true });
  fs.symlinkSync(
    path.join(repositoryRoot, "packages/core"),
    path.join(scopedModules, "core"),
    process.platform === "win32" ? "junction" : "dir"
  );
  fs.mkdirSync(path.join(pagesDir, "health"), { recursive: true });
  fs.writeFileSync(
    path.join(pagesDir, "health/index.tsx"),
    "export default function HealthPage() { return null; }\n",
    "utf8"
  );

  generateFluxFastProject({
    generatedDir,
    log: false,
    outputFile: path.join(generatedDir, "pages.generated.ts"),
    pagesDir,
    schemaContent: fixture,
    schemaFile: path.join(generatedDir, "schema.generated.json")
  });

  fs.writeFileSync(
    path.join(temporaryRoot, "src/consumer.ts"),
    `import { mutations } from "./.fluxfast/mutations.generated";
import { routes } from "./.fluxfast/routes.generated";
import { RoomsResourceValidator } from "./.fluxfast/validators.generated";
import {
  resourceKeys,
  type RoomsResource,
  type UpdateRoomBody
} from "./.fluxfast/types.generated";

const rooms: RoomsResource = [{ id: 1, name: "Legacy" }];
const update: UpdateRoomBody = { name: "Updated" };
const roomUrl = routes.hotelRooms({ hotel_id: 1 });

void [
  mutations.updateRoom,
  resourceKeys.rooms,
  RoomsResourceValidator,
  rooms,
  roomUrl,
  update
];
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          jsx: "react-jsx",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "Node16",
          moduleResolution: "Node16",
          outDir: "dist",
          rootDir: "src",
          skipLibCheck: true,
          strict: true,
          target: "ES2022"
        },
        include: ["src/**/*.ts", "src/**/*.tsx"]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  execFileSync(
    tsc,
    ["--project", path.join(temporaryRoot, "tsconfig.json"), "--noEmit"],
    {
      cwd: repositoryRoot,
      stdio: "inherit"
    }
  );
  execFileSync(tsc, ["--project", path.join(temporaryRoot, "tsconfig.json")], {
    cwd: repositoryRoot,
    stdio: "inherit"
  });

  for (const artifact of [
    "consumer.js",
    ".fluxfast/mutations.generated.js",
    ".fluxfast/routes.generated.js",
    ".fluxfast/types.generated.js",
    ".fluxfast/validators.generated.js"
  ]) {
    if (!fs.existsSync(path.join(temporaryRoot, "dist", artifact))) {
      throw new Error(`schema/1 consumer build did not emit ${artifact}`);
    }
  }
  console.log("schema/1 generate, typecheck, and build compatibility passed.");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
