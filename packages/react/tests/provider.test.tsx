import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FluxRouter } from "@fluxfast/core";
import { FluxProvider, useFluxContext } from "../src/provider";

describe("FluxProvider", () => {
  it("server-renders initial deferred resources as pending without starting them", () => {
    let observedRouter: FluxRouter | undefined;

    function Probe() {
      const { router } = useFluxContext();
      observedRouter = router;
      return <span>{router.resourceStore.getStateSnapshot("analytics").status}</span>;
    }

    const html = renderToString(
      <FluxProvider
        initialEnvelope={{
          protocol: "fluxfast/1",
          page: { component: "dashboard/index", url: "/dashboard" },
          resources: {},
          deferred: ["analytics"],
        }}
      >
        <Probe />
      </FluxProvider>
    );

    expect(html).toContain("pending");
    expect(observedRouter?.resourceStore.getStateSnapshot("analytics").status)
      .toBe("pending");
  });
});
