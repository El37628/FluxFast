import fs from "node:fs";
import path from "node:path";
import type { InitOperation } from "./init.js";
import type { FluxProjectInfo, NextConfigFormat } from "./types.js";

export interface NextConfigTransform {
  status: "modified" | "unchanged" | "manual";
  content: string;
  reason?: string;
}

export interface NextConfigPlanResult {
  operation?: InitOperation;
  manualAction?: string;
}

function maskStringsAndComments(content: string): string {
  let result = "";
  let state: "code" | "single" | "double" | "template" | "line" | "block" =
    "code";
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];
    if (state === "line") {
      if (current === "\n") {
        state = "code";
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state !== "code") {
      result += current === "\n" ? "\n" : " ";
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block";
    } else if (current === "'") {
      result += " ";
      state = "single";
    } else if (current === '"') {
      result += " ";
      state = "double";
    } else if (current === "`") {
      result += " ";
      state = "template";
    } else {
      result += current;
    }
  }
  return result;
}

function findExpressionEnd(content: string, start: number): number {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let state: "code" | "single" | "double" | "template" | "line" | "block" =
    "code";
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];
    if (state === "line") {
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state !== "code") {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      index += 1;
      state = "block";
    } else if (current === "'") {
      state = "single";
    } else if (current === '"') {
      state = "double";
    } else if (current === "`") {
      state = "template";
    } else if (current === "{") {
      braces += 1;
    } else if (current === "}") {
      braces -= 1;
    } else if (current === "[") {
      brackets += 1;
    } else if (current === "]") {
      brackets -= 1;
    } else if (current === "(") {
      parentheses += 1;
    } else if (current === ")") {
      parentheses -= 1;
    } else if (
      current === ";" &&
      braces === 0 &&
      brackets === 0 &&
      parentheses === 0
    ) {
      return index;
    }
  }
  return content.length;
}

function isSafeConfigExpression(expression: string): boolean {
  const trimmed = expression.trim();
  return (
    /^[A-Za-z_$][\w$]*$/.test(trimmed) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  );
}

function insertIntegrationImport(content: string, commonJs: boolean): string {
  const statement = commonJs
    ? 'const { withFluxFast } = require("@fluxfast/next/next-config");'
    : 'import { withFluxFast } from "@fluxfast/next/next-config";';
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  return `${bom}${statement}\n${content.slice(bom.length)}`;
}

export function transformNextConfig(
  content: string,
  format: NextConfigFormat
): NextConfigTransform {
  const masked = maskStringsAndComments(content);
  if (/\bwithFluxFast\s*\(/.test(masked)) {
    return { status: "unchanged", content };
  }

  const commonJs = format === "cjs" || /\bmodule\s*\.\s*exports\s*=/.test(masked);
  const assignment = commonJs
    ? /\bmodule\s*\.\s*exports\s*=/.exec(masked)
    : /\bexport\s+default\b/.exec(masked);
  if (!assignment) {
    return {
      status: "manual",
      content,
      reason: "FluxFast could not find a supported default Next configuration export.",
    };
  }

  const expressionStart = assignment.index + assignment[0].length;
  const expressionEnd = findExpressionEnd(content, expressionStart);
  const expression = content.slice(expressionStart, expressionEnd).trim();
  if (!isSafeConfigExpression(expression)) {
    return {
      status: "manual",
      content,
      reason:
        "FluxFast detected an existing configuration wrapper or unsupported export expression and cannot safely determine wrapper ordering.",
    };
  }

  const beforeExpression = content.slice(0, expressionStart);
  const afterExpression = content.slice(expressionEnd);
  const transformed = `${beforeExpression} withFluxFast(${expression})${afterExpression}`;
  return {
    status: "modified",
    content: insertIntegrationImport(transformed, commonJs),
  };
}

export function desiredNextConfigPath(project: FluxProjectInfo): string {
  return path.join(
    project.root,
    project.language === "typescript" ? "next.config.ts" : "next.config.mjs"
  );
}

export function renderNextConfig(project: FluxProjectInfo): string {
  const typeDeclaration =
    project.language === "typescript"
      ? 'import type { NextConfig } from "next";\n'
      : "";
  const annotation = project.language === "typescript" ? ": NextConfig" : "";
  return `${typeDeclaration}import { withFluxFast } from "@fluxfast/next/next-config";\n\nconst nextConfig${annotation} = {};\n\nexport default withFluxFast(nextConfig);\n`;
}

export function planNextConfigIntegration(
  project: FluxProjectInfo
): NextConfigPlanResult {
  if (!project.nextConfigPath || !project.nextConfigFormat) {
    return {
      operation: {
        type: "create",
        path: desiredNextConfigPath(project),
        content: renderNextConfig(project),
      },
    };
  }

  const before = fs.readFileSync(project.nextConfigPath, "utf8");
  const transformed = transformNextConfig(before, project.nextConfigFormat);
  if (transformed.status === "modified") {
    return {
      operation: {
        type: "modify",
        path: project.nextConfigPath,
        before,
        after: transformed.content,
      },
    };
  }
  if (transformed.status === "unchanged") {
    return {
      operation: {
        type: "skip",
        path: project.nextConfigPath,
        reason: "Next config already uses withFluxFast",
      },
    };
  }
  return {
    operation: {
      type: "skip",
      path: project.nextConfigPath,
      reason: transformed.reason ?? "Next config requires manual integration",
    },
    manualAction: `${transformed.reason}\n\nAdd:\n  import { withFluxFast } from "@fluxfast/next/next-config";\n\nThen wrap the exported Next configuration with withFluxFast().`,
  };
}
