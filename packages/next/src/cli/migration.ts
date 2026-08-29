import path from "node:path";

export type PageSafety = "default-page" | "custom-page" | "server-only";

const SERVER_ONLY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfrom\s+["']next\/headers["']/, "imports next/headers"],
  [/\b(?:import\s+)?["']server-only["']/, "imports server-only"],
  [/\bfrom\s+["'](?:node:)?fs(?:\/promises)?["']/, "imports Node fs"],
  [/\bfrom\s+["']node:path["']/, "imports Node path"],
  [/\b(?:cookies|headers|draftMode)\s*\(/, "uses a server request API"],
  [/["']use server["'];?/, "contains a Server Action directive"],
  [/\bexport\s+(?:const\s+metadata|async\s+function\s+generateMetadata|function\s+generateMetadata|async\s+function\s+generateViewport|function\s+generateViewport)\b/, "exports server-only route metadata"],
  [/\bexport\s+default\s+async\b|\basync\s+function\s+[A-Za-z_$][\w$]*\s*\(/, "contains an async component or loader"],
  [/\bprocess\.env\.(?!NEXT_PUBLIC_)[A-Za-z_$][\w$]*/, "reads a server environment variable"],
];

export interface PageInspection {
  safety: PageSafety;
  reasons: string[];
}

export function inspectPage(content: string): PageInspection {
  const serverReasons = SERVER_ONLY_PATTERNS.filter(([pattern]) =>
    pattern.test(content)
  ).map(([, reason]) => reason);
  if (serverReasons.length > 0) {
    return { safety: "server-only", reasons: serverReasons };
  }

  const defaultSignals = [
    /\bfrom\s+["']next\/image["']/,
    /page\.module\.css/,
    /(?:next|vercel)\.svg/,
    /Get started by editing|Create Next App|Deploy Now/,
  ].filter(pattern => pattern.test(content)).length;

  if (defaultSignals >= 2) {
    return {
      safety: "default-page",
      reasons: ["matches the standard create-next-app starter"],
    };
  }
  return {
    safety: "custom-page",
    reasons: ["does not match a known generated starter"],
  };
}

export function ensureUseClient(content: string): string {
  if (/^\uFEFF?\s*["']use client["'];/.test(content)) {
    return content;
  }
  return `"use client";\n\n${content.replace(/^\uFEFF/, "")}`;
}

function portableRelativeImport(fromFile: string, targetPath: string): string {
  const relative = path
    .relative(path.dirname(fromFile), targetPath)
    .replace(/\\/g, "/");
  return relative.startsWith("./") || relative.startsWith("../")
    ? relative
    : `./${relative}`;
}

/** Preserve relative static imports when a page moves to flux-pages. */
export function rewriteRelativeImports(
  content: string,
  fromFile: string,
  toFile: string
): string {
  const rewrite = (specifier: string): string => {
    if (!specifier.startsWith(".")) {
      return specifier;
    }
    return portableRelativeImport(
      toFile,
      path.resolve(path.dirname(fromFile), specifier)
    );
  };

  return content
    .replace(
      /(\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'])(\.{1,2}\/[^"']+)(["'])/g,
      (_match, prefix: string, specifier: string, suffix: string) =>
        `${prefix}${rewrite(specifier)}${suffix}`
    )
    .replace(
      /(\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
      (_match, prefix: string, specifier: string, suffix: string) =>
        `${prefix}${rewrite(specifier)}${suffix}`
    );
}

export function prepareMigratedPage(
  content: string,
  fromFile: string,
  toFile: string
): string {
  return ensureUseClient(rewriteRelativeImports(content, fromFile, toFile));
}
