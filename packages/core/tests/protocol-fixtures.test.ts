import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_DEFERRED_RESOURCES,
  CAPABILITY_LIVE_RESOURCES,
  HEADER_CAPABILITIES,
} from "../src/capabilities";
import { TransportError, ValidationError } from "../src/errors";
import {
  HEADER_CLIENT_ID,
  HEADER_LIVE,
  HEADER_LIVE_KEYS,
} from "../src/live/transport";
import {
  PROTOCOL_MEDIA_TYPE,
  PROTOCOL_VERSION,
  type PageEnvelope,
} from "../src/protocol";
import {
  assertMutationEnvelope,
  assertPageEnvelope,
  FetchTransport,
} from "../src/transport";

const fixtureDirectory = path.resolve(
  import.meta.dirname,
  "../../../tests/fixtures/protocol-v1"
);
const pageFixtures = [
  "deferred-error.json",
  "deferred-page.json",
  "known-version-delta.json",
  "live-page.json",
  "normal-page.json",
  "partial-resource-load.json",
] as const;
const mutationFixtures = [
  "external-redirect.json",
  "mutation-invalidation.json",
  "mutation-patch.json",
  "redirect.json",
] as const;
const errorFixtures = ["resource-error.json", "validation-error.json"] as const;

function loadFixture(name: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(fixtureDirectory, name), "utf8")
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("fluxfast/1 golden fixtures", () => {
  it("keeps the fixture inventory complete", () => {
    const actual = fs.readdirSync(fixtureDirectory)
      .filter(name => name.endsWith(".json"))
      .toSorted();
    expect(actual).toEqual(
      [...pageFixtures, ...mutationFixtures, ...errorFixtures].toSorted()
    );
  });

  it.each(pageFixtures)("accepts the %s page envelope", fixtureName => {
    const payload = loadFixture(fixtureName);
    expect(() => assertPageEnvelope(payload)).not.toThrow();
  });

  it.each(mutationFixtures)("accepts the %s mutation envelope", fixtureName => {
    const payload = loadFixture(fixtureName);
    expect(() => assertMutationEnvelope(payload)).not.toThrow();
  });

  it("preserves the frozen page delta and partial-load meanings", () => {
    const knownDelta = loadFixture("known-version-delta.json");
    assertPageEnvelope(knownDelta);
    expect(knownDelta.resourceKeys).toEqual(["rooms", "summary"]);
    expect(Object.keys(knownDelta.resources)).toEqual(["summary"]);

    const partial = loadFixture("partial-resource-load.json");
    assertPageEnvelope(partial);
    expect(partial.resourceKeys).toEqual(["rooms", "analytics"]);
    expect(Object.keys(partial.resources)).toEqual(["analytics"]);
  });

  it("freezes every mutation patch operation", () => {
    const payload = loadFixture("mutation-patch.json");
    assertMutationEnvelope(payload);
    const operations = Object.values(payload.mutation.patches ?? {})
      .flat()
      .map(patch => patch.op);

    expect(operations).toEqual([
      "replace-resource",
      "merge-object",
      "replace-item",
      "remove-item",
      "append-item",
    ]);
  });

  it("consumes the shared validation and resource error envelopes", async () => {
    const validation = loadFixture("validation-error.json");
    const resource = loadFixture("resource-error.json");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(validation), {
        status: 422,
        headers: { "content-type": PROTOCOL_MEDIA_TYPE },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(resource), {
        status: 500,
        headers: { "content-type": PROTOCOL_MEDIA_TYPE },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();

    await expect(transport.visit({ url: "/invalid", visitId: "fixture_1" }))
      .rejects.toMatchObject<Partial<ValidationError>>({
        name: "ValidationError",
        details: { email: ["Invalid email"] },
      });
    await expect(transport.visit({ url: "/failure", visitId: "fixture_2" }))
      .rejects.toMatchObject<Partial<TransportError>>({
        name: "TransportError",
        status: 500,
        message: "A resource could not be resolved",
      });
  });

  it("rejects a malformed optional appVersion", () => {
    const payload = loadFixture("normal-page.json") as PageEnvelope;
    expect(() => assertPageEnvelope({ ...payload, appVersion: 1 }))
      .toThrowError(/appVersion must be a string/);
  });

  it("freezes protocol, capability, and live-header identities", () => {
    expect(PROTOCOL_VERSION).toBe("fluxfast/1");
    expect(PROTOCOL_MEDIA_TYPE).toBe("application/vnd.fluxfast+json");
    expect(HEADER_CAPABILITIES).toBe("X-FluxFast-Capabilities");
    expect(HEADER_CLIENT_ID).toBe("X-FluxFast-Client-ID");
    expect(HEADER_LIVE).toBe("X-FluxFast-Live");
    expect(HEADER_LIVE_KEYS).toBe("X-FluxFast-Live-Keys");
    expect([
      CAPABILITY_DEFERRED_RESOURCES,
      CAPABILITY_LIVE_RESOURCES,
    ]).toEqual(["deferred-resources", "live-resources"]);
  });

  it("sends the frozen visit and mutation request headers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol: PROTOCOL_VERSION,
        page: { component: "rooms/index", url: "/rooms" },
        resources: {},
      }), { headers: { "content-type": PROTOCOL_MEDIA_TYPE } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol: PROTOCOL_VERSION,
        mutation: {},
      }), { headers: { "content-type": PROTOCOL_MEDIA_TYPE } }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();

    await transport.visit({
      url: "/rooms",
      visitId: "visit_fixture",
      knownVersions: { rooms: "rooms-v1" },
      only: ["rooms"],
    });
    await transport.mutate({
      url: "/rooms",
      data: { status: "occupied" },
      clientId: "ff_fixture",
    });

    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Accept: PROTOCOL_MEDIA_TYPE,
      "X-FluxFast": "1",
      "X-FluxFast-Protocol": "1",
      "X-FluxFast-Visit": "visit_fixture",
      "X-FluxFast-Only": "rooms",
      [HEADER_CAPABILITIES]: "deferred-resources,live-resources",
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty(
      "X-FluxFast-Known"
    );
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      Accept: PROTOCOL_MEDIA_TYPE,
      "Content-Type": "application/json",
      "X-FluxFast": "1",
      "X-FluxFast-Protocol": "1",
      [HEADER_CAPABILITIES]: "deferred-resources,live-resources",
      [HEADER_CLIENT_ID]: "ff_fixture",
    });
  });
});
