import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  FluxRouter,
  type FluxTransport,
  type MutationEnvelope,
  type MutationTransportRequest,
  type PageEnvelope,
  type VisitTransportRequest,
} from "@fluxfast/core";
import {
  type DeferredResourceResult,
  useDeferredResource,
  useResource,
} from "../src/hooks";
import { FluxProvider } from "../src/provider";

class MockTransport implements FluxTransport {
  readonly visitMock = vi.fn<[VisitTransportRequest], Promise<PageEnvelope>>();
  readonly mutateMock = vi.fn<
    [MutationTransportRequest],
    Promise<MutationEnvelope>
  >();

  visit(request: VisitTransportRequest): Promise<PageEnvelope> {
    return this.visitMock(request);
  }

  mutate(request: MutationTransportRequest): Promise<MutationEnvelope> {
    return this.mutateMock(request);
  }
}

function renderDeferred<T>(
  router: FluxRouter,
  key: string
): { html: string; result: DeferredResourceResult<T> } {
  let result: DeferredResourceResult<T> | undefined;

  function Probe() {
    result = useDeferredResource<T>(key);
    return <span>{result.status}</span>;
  }

  const html = renderToString(
    <FluxProvider router={router}>
      <Probe />
    </FluxProvider>
  );
  return { html, result: result! };
}

describe("resource hooks", () => {
  it("exposes pending SSR state and retries through loading to ready", async () => {
    const transport = new MockTransport();
    let resolveRetry!: (envelope: PageEnvelope) => void;
    transport.visitMock.mockImplementationOnce(
      () => new Promise(resolve => { resolveRetry = resolve; })
    );
    const router = new FluxRouter({
      transport,
      initialEnvelope: {
        protocol: "fluxfast/1",
        page: { component: "dashboard/index", url: "/dashboard" },
        resources: {},
        deferred: ["analytics"],
      },
    });

    const pending = renderDeferred<{ revenue: number }>(router, "analytics");
    expect(pending.html).toContain("pending");
    expect(pending.result).toMatchObject({
      data: undefined,
      status: "pending",
      error: null,
      stale: false,
    });

    const retry = pending.result.retry();
    expect(transport.visitMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "/dashboard",
      only: ["analytics"],
    }));
    expect(renderDeferred(router, "analytics").result.status).toBe("loading");

    resolveRetry({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: {
        analytics: { version: "a1", value: { revenue: 95_000 } },
      },
    });
    await retry;

    expect(renderDeferred<{ revenue: number }>(router, "analytics").result)
      .toMatchObject({
        data: { revenue: 95_000 },
        status: "ready",
        error: null,
        stale: false,
      });
  });

  it("exposes resource errors and retries only the failed key", async () => {
    const transport = new MockTransport();
    transport.visitMock.mockResolvedValueOnce({
      protocol: "fluxfast/1",
      page: { component: "dashboard/index", url: "/dashboard" },
      resources: { activity: { version: "ac1", value: [] } },
    });
    const router = new FluxRouter({
      transport,
      initialPage: { component: "dashboard/index", url: "/dashboard" },
    });
    router.resourceStore.setResourceError("activity", {
      type: "ResourceError",
      message: "A deferred resource could not be resolved",
    });

    const failed = renderDeferred<unknown[]>(router, "activity").result;
    expect(failed).toMatchObject({
      status: "error",
      error: {
        type: "ResourceError",
        message: "A deferred resource could not be resolved",
      },
    });

    await failed.retry();
    expect(transport.visitMock.mock.calls[0][0].only).toEqual(["activity"]);
    expect(renderDeferred<unknown[]>(router, "activity").result.status).toBe("ready");
  });

  it("preserves the existing useResource value API", () => {
    const router = new FluxRouter({
      initialPage: { component: "dashboard/index", url: "/dashboard" },
      initialResources: {
        summary: { version: "s1", value: { count: 42 } },
      },
    });

    function LegacyProbe() {
      const summary = useResource<{ count: number }>("summary");
      return <span>{summary.count}</span>;
    }

    const html = renderToString(
      <FluxProvider router={router}>
        <LegacyProbe />
      </FluxProvider>
    );
    expect(html).toContain("42");
  });
});
