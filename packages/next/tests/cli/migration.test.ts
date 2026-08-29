import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureUseClient,
  inspectPage,
  prepareMigratedPage,
} from "../../src/cli/migration";

describe("existing page migration", () => {
  it("recognizes a standard create-next-app page", () => {
    const result = inspectPage(
      'import Image from "next/image";\nimport styles from "./page.module.css";\nexport default function Home() { return <Image src="/next.svg" alt="Next" />; }\n'
    );

    expect(result.safety).toBe("default-page");
  });

  it.each([
    'import { cookies } from "next/headers";\nexport default function Page() { return cookies().get("session"); }',
    'import "server-only";\nexport default function Page() { return null; }',
    'export default async function Page() { return null; }',
    'export default function Page() { return process.env.DATABASE_URL; }',
    '"use server";\nexport default function Page() { return null; }',
  ])("conservatively rejects server-only content", content => {
    expect(inspectPage(content).safety).toBe("server-only");
  });

  it("treats unknown application content as custom", () => {
    expect(
      inspectPage("export default function Dashboard() { return <h1>Hi</h1>; }")
        .safety
    ).toBe("custom-page");
  });

  it("inserts use client once and rewrites moved relative imports", () => {
    const from = path.join("project", "src", "app", "page.tsx");
    const to = path.join(
      "project",
      "src",
      "flux-pages",
      "home",
      "index.tsx"
    );
    const migrated = prepareMigratedPage(
      'import styles from "./page.module.css";\nconst Widget = import("../components/widget");\nexport default function Home() { return null; }\n',
      from,
      to
    );

    expect(migrated).toContain('"use client";');
    expect(migrated).toContain('from "../../app/page.module.css"');
    expect(migrated).toContain('import("../../components/widget")');
    expect(ensureUseClient(migrated)).toBe(migrated);
  });
});
