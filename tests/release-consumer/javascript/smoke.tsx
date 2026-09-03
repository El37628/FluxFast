import React from "react";
import {
  PROTOCOL_VERSION,
  ResourceStore,
  createFluxRuntime,
  encodeKnownVersions,
  type PageEnvelope,
} from "@fluxfast/core";
import {
  defineFluxConfig,
  useResource,
  type FluxApplicationProps,
} from "@fluxfast/next";
import { createFluxNextPage } from "@fluxfast/next/server";
import { generatePagesRegistry } from "@fluxfast/next/generate";
import { withFluxFast } from "@fluxfast/next/next-config";
import {
  resourceKeys,
  type GeneratedFluxResourceMap,
  type LegacyRoom,
  type RoomsResource,
} from "./src/.fluxfast/types.generated";

const envelope: PageEnvelope = {
  protocol: PROTOCOL_VERSION,
  page: {
    component: "health/index",
    url: "/health",
  },
  resources: {
    health: {
      version: "v1",
      value: { ok: true },
    },
  },
};

const Application: React.ComponentType<FluxApplicationProps> = ({
  initialEnvelope,
}) => React.createElement("main", null, initialEnvelope.page.component);

const config = defineFluxConfig({ application: Application });
const page = createFluxNextPage(config);
const nextConfig = withFluxFast({}, {
  backendUrl: "http://127.0.0.1:8000",
  generate: false,
});
const store = new ResourceStore();
store.set({ key: "health", version: "v1", value: { ok: true } });
const versions = encodeKnownVersions(store.exportKnownVersions());
const runtime = createFluxRuntime({
  deferHistory: true,
  initialPage: envelope.page,
  initialResources: envelope.resources,
});
const legacyRoom: LegacyRoom = { id: 1, name: "Schema one" };
const legacyRooms: RoomsResource = [legacyRoom];
const legacyResources: GeneratedFluxResourceMap = { rooms: legacyRooms };
const legacyResourceKey: typeof resourceKeys.rooms = "rooms";

export function HealthPage() {
  const health = useResource<{ ok: boolean }>("health");
  return <main>{health.ok ? "ready" : "unavailable"}</main>;
}

void [
  page,
  nextConfig,
  runtime,
  versions,
  generatePagesRegistry,
  legacyResources,
  legacyResourceKey,
];
