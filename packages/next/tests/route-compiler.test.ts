import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileFluxFastPageRoutes } from "../src/route-compiler";

const fingerprint = "c".repeat(64);

function manifest(pages: unknown[]) {
  return {
    schema: "fluxfast-schema/1",
    producer: "0.6.0",
    fingerprint,
    resources: {},
    pages,
    mutations: []
  };
}

function compileAndRun(
  source: string,
  consumer: string,
  evaluation: string
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fluxfast-routes-"));
  const sourceFile = path.join(directory, "routes.generated.ts");
  const consumerFile = path.join(directory, "consumer.ts");
  const configFile = path.join(directory, "tsconfig.json");
  const outputDirectory = path.join(directory, "dist");
  fs.writeFileSync(sourceFile, source, "utf8");
  fs.writeFileSync(consumerFile, consumer, "utf8");
  fs.writeFileSync(
    configFile,
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "Node16",
        moduleResolution: "Node16",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: [],
        strict: true,
        skipLibCheck: true,
        outDir: outputDirectory
      },
      files: [sourceFile, consumerFile]
    }, null, 2)}\n`,
    "utf8"
  );

  try {
    const compilation = spawnSync(
      path.resolve(__dirname, "../node_modules/typescript/bin/tsc"),
      ["--project", configFile],
      { encoding: "utf8" }
    );
    expect(`${compilation.stdout}${compilation.stderr}`).toBe("");
    expect(compilation.status).toBe(0);

    const generatedJavaScript = path.join(
      outputDirectory,
      "routes.generated.js"
    );
    const execution = spawnSync(
      process.execPath,
      [
        "-e",
        `const { routes } = require(${JSON.stringify(generatedJavaScript)}); ${evaluation}`
      ],
      { encoding: "utf8" }
    );
    expect(execution.stderr).toBe("");
    expect(execution.status).toBe(0);
    return execution.stdout;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("FluxFast page route compiler", () => {
  it("generates typed path and query builders with safe URL encoding", () => {
    const output = compileFluxFastPageRoutes(
      manifest([
        {
          name: "hotel_rooms",
          path: "/hotels/{hotel_id}/rooms/{room_slug}",
          parameters: [
            {
              name: "status",
              location: "query",
              required: false,
              schema: {
                $defs: {
                  RoomStatus: {
                    enum: ["available", "occupied"],
                    type: "string"
                  }
                },
                anyOf: [
                  { $ref: "#/$defs/RoomStatus" },
                  { type: "null" }
                ]
              }
            },
            {
              name: "hotel_id",
              location: "path",
              required: true,
              schema: { type: "integer" }
            },
            {
              name: "tags",
              location: "query",
              required: false,
              schema: { type: "array", items: { type: "string" } }
            },
            {
              name: "room_slug",
              location: "path",
              required: true,
              schema: { type: "string" }
            },
            {
              name: "page",
              location: "query",
              required: false,
              schema: { default: 1, type: "integer" }
            }
          ]
        },
        {
          name: "search",
          path: "/search",
          parameters: [
            {
              name: "term",
              location: "query",
              required: true,
              schema: { type: "string" }
            }
          ]
        },
        { name: "home", path: "/", parameters: [] }
      ])
    );

    expect(output).toContain("hotelRooms: (input:");
    expect(output).toContain("hotel_id: number;");
    expect(output).toContain("room_slug: string;");
    expect(output).toContain('status?: "available" | "occupied" | null;');
    expect(output).toContain("tags?: string[];");
    expect(output).toContain("search: (input:");
    expect(output).toContain("home: (): string =>");

    const consumer = `import { routes } from "./routes.generated";

routes.home();
routes.hotelRooms({
  hotel_id: 12,
  room_slug: "suite/a",
  query: {
    page: 2,
    status: "available",
    tags: ["one two", "x&y"]
  }
});
routes.search({ query: { term: "ocean view" } });

// @ts-expect-error integer path parameters require numbers
routes.hotelRooms({ hotel_id: "12", room_slug: "suite" });
// @ts-expect-error required query objects cannot be omitted
routes.search();
// @ts-expect-error enum query values retain their server contract
routes.hotelRooms({ hotel_id: 12, room_slug: "suite", query: { status: "closed" } });
`;
    const stdout = compileAndRun(
      output,
      consumer,
      `process.stdout.write(JSON.stringify([
        routes.hotelRooms({
          hotel_id: 12,
          room_slug: "suite/a",
          query: { page: 2, status: "available", tags: ["one two", "x&y"] }
        }),
        routes.search({ query: { term: "ocean view" } }),
        routes.home()
      ]));`
    );
    expect(JSON.parse(stdout)).toEqual([
      "/hotels/12/rooms/suite%2Fa?page=2&status=available&tags=one+two&tags=x%26y",
      "/search?term=ocean+view",
      "/"
    ]);
  });

  it("is deterministic and rejects route-name or placeholder collisions", () => {
    const input = manifest([
      { name: "zeta", path: "/zeta", parameters: [] },
      { name: "alpha", path: "/alpha", parameters: [] }
    ]);
    const output = compileFluxFastPageRoutes(input);
    expect(output).toBe(compileFluxFastPageRoutes(input));
    expect(output.indexOf("alpha:")).toBeLessThan(output.indexOf("zeta:"));

    expect(() =>
      compileFluxFastPageRoutes(
        manifest([
          { name: "hotel-detail", path: "/one", parameters: [] },
          { name: "hotel_detail", path: "/two", parameters: [] }
        ])
      )
    ).toThrow(/Give the FluxFast page route an explicit unique name/);

    expect(() =>
      compileFluxFastPageRoutes(
        manifest([
          {
            name: "broken",
            path: "/hotels/{hotel_id}",
            parameters: []
          }
        ])
      )
    ).toThrow(/placeholder "hotel_id" must have exactly one path parameter/);
  });

  it("treats hostile route names, paths, and query keys as data", () => {
    const queryName = 'q");globalThis.compromised=true;//';
    const staticPath = '/rooms/";globalThis.compromised=true;/{slug}';
    const output = compileFluxFastPageRoutes(
      manifest([
        {
          name: 'room"); globalThis.compromised = true; //',
          path: staticPath,
          parameters: [
            {
              name: "slug",
              location: "path",
              required: true,
              schema: { type: "string" }
            },
            {
              name: queryName,
              location: "query",
              required: true,
              schema: { type: "string" }
            }
          ]
        }
      ])
    );
    expect(output).toContain("roomGlobalThisCompromisedTrue:");

    const consumer = `import { routes } from "./routes.generated";

routes.roomGlobalThisCompromisedTrue({
  slug: "../secret",
  query: { ${JSON.stringify(queryName)}: "a&b" }
});
`;
    const stdout = compileAndRun(
      output,
      consumer,
      `globalThis.compromised = false;
const value = routes.roomGlobalThisCompromisedTrue({
  slug: "../secret",
  query: { [${JSON.stringify(queryName)}]: "a&b" }
});
process.stdout.write(JSON.stringify([value, globalThis.compromised]));`
    );
    const query = new URLSearchParams([[queryName, "a&b"]]).toString();
    expect(JSON.parse(stdout)).toEqual([
      `${staticPath.replace("{slug}", encodeURIComponent("../secret"))}?${query}`,
      false
    ]);
  });

  it("generates a valid empty route module", () => {
    const output = compileFluxFastPageRoutes(manifest([]));
    expect(output).toContain("export const routes = {} as const;");
    expect(output).not.toContain("appendFluxRouteQuery");
  });
});
