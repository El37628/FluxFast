import React from "react";
import {
  PROTOCOL_VERSION,
  ResourceStore,
  createFluxRuntime,
  encodeKnownVersions,
  type PageEnvelope,
} from "@fluxfast/core";
import {
  fetchFluxInitialPage,
  createFluxTransportProxy,
  type FetchFluxInitialPageOptions,
  type FluxInitialPageResult,
} from "@fluxfast/core/server";
import {
  createPagesRegistrySnapshot,
  checkFluxFastProject,
  type FluxPageRegistryTarget,
} from "@fluxfast/codegen";
import {
  defineFluxConfig,
  useResource,
  type FluxApplicationProps,
} from "@fluxfast/next";
import {
  defineFluxConfig as defineClientFluxConfig,
  useLiveStatus,
  type UseFormReturn,
} from "@fluxfast/next/client";
import { createFluxNextPage } from "@fluxfast/next/server";
import { generatePagesRegistry } from "@fluxfast/next/generate";
import { withFluxFast } from "@fluxfast/next/next-config";
import {
  FluxDevtools,
  type FluxDevtoolsProps,
} from "@fluxfast/devtools";
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

const initialOptions: FetchFluxInitialPageOptions = {
  backendUrl: "http://127.0.0.1:8000", path: "/health",
};
const fetchInitial: (options: FetchFluxInitialPageOptions) => Promise<FluxInitialPageResult> = fetchFluxInitialPage;
const registryTarget: FluxPageRegistryTarget = {
  runtimeImport: "@fluxfast/next", rootExport: "FluxRoot",
  applicationPropsExport: "FluxApplicationProps", clientDirective: true,
};

const Application: React.ComponentType<FluxApplicationProps> = ({
  initialEnvelope,
}) => React.createElement("main", null, initialEnvelope.page.component);

const config = defineFluxConfig({ application: Application });
const clientConfig = defineClientFluxConfig({ application: Application });
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
type RegistrationForm = UseFormReturn<{ email: string }>;
const devtoolsProps: FluxDevtoolsProps = {
  position: "bottom",
  maxEvents: 500,
};

// @ts-expect-error package internals are not public npm entry points
type InternalNextProvider = typeof import("@fluxfast/next/dist/index.js").FluxProvider;

export function HealthPage() {
  const health = useResource<{ ok: boolean }>("health");
  return <main>{health.ok ? "ready" : "unavailable"}</main>;
}

void [
  page,
  initialOptions,
  fetchInitial,
  createFluxTransportProxy,
  createPagesRegistrySnapshot,
  checkFluxFastProject,
  registryTarget,
  clientConfig,
  nextConfig,
  runtime,
  versions,
  generatePagesRegistry,
  legacyResources,
  legacyResourceKey,
  useLiveStatus,
  null as InternalNextProvider | null,
  null as RegistrationForm | null,
  FluxDevtools,
  devtoolsProps,
];
