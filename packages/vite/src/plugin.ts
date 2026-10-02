import type { Plugin } from "vite" with { "resolution-mode": "import" };
import { CLIENT_ENTRY, CLIENT_ID, SERVER_ENTRY, SERVER_ID, resolveOptions, type FluxViteOptions, type ResolvedFluxOptions } from "./options.js";

/** Vite module/build integration; application URLs continue to belong to FastAPI. */
export function fluxfast(options: FluxViteOptions = {}): Plugin {
  let configured: ResolvedFluxOptions;
  const plugin: Plugin = {
    name: "fluxfast",
    config(config) {
      if (config.base !== undefined && config.base !== "/") throw new Error("FluxFast Vite currently requires base '/' for same-origin application routing");
      return {
        appType: "custom", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
        // The document uses a virtual client entry rather than a SPA script.
        // Scan the real application (including lazy registry pages) up front so
        // a first navigation cannot trigger dependency discovery and a reload.
        optimizeDeps: {
          entries: [options.application ?? "src/.fluxfast/pages.generated.ts"],
          include: ["@fluxfast/react/client", "react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
        },
      };
    },
    configResolved(config) {
      if (config.base !== "/") throw new Error("FluxFast Vite currently requires base '/' for same-origin application routing");
      configured = resolveOptions(config.root, options);
      plugin.api = { fluxfast: configured };
    },
    resolveId(id) {
      if (id === CLIENT_ENTRY || id === CLIENT_ID) return CLIENT_ID;
      if (id === SERVER_ENTRY || id === SERVER_ID) return SERVER_ID;
    },
    load(id) {
      if (id !== CLIENT_ID && id !== SERVER_ID) return;
      const application = JSON.stringify(configured.application);
      const component = configured.applicationExport;
      if (id === CLIENT_ID) {
        return `import { ${component} as Application } from ${application};\nimport { hydrateFluxApplication } from "@fluxfast/react/client";\nhydrateFluxApplication(Application);\n`;
      }
      return `import { ${component} as Application } from ${application};\nimport { renderFluxApplication } from "@fluxfast/react/server";\nexport const settings = ${JSON.stringify(configured.settings)};\nexport function render(props, options) { return renderFluxApplication(Application, props, options); }\n`;
    },
  };
  return plugin;
}
