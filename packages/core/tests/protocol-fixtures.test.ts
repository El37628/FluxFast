import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_DEFERRED_RESOURCES,
  CAPABILITY_LIVE_RESOURCES,
  FLUX_CAPABILITIES,
  HEADER_CAPABILITIES,
} from "../src/capabilities";
import { TransportError, ValidationError } from "../src/errors";
import {
  LIVE_EVENT_NAME,
  LIVE_RESYNC_REASONS,
  MAX_LIVE_CLIENT_ID_LENGTH,
  MAX_LIVE_EVENT_KEYS,
  MAX_LIVE_RESOURCE_KEY_LENGTH,
} from "../src/live/protocol";
import {
  HEADER_CLIENT_ID,
  HEADER_LIVE,
  HEADER_LIVE_KEYS,
  MAX_LIVE_EVENT_BYTES,
  MAX_LIVE_KEYS_HEADER_BYTES,
} from "../src/live/transport";
import {
  PROTOCOL_MEDIA_TYPE,
  PROTOCOL_VERSION,
  type MutationEnvelope,
  type PageEnvelope,
} from "../src/protocol";
import {
  assertMutationEnvelope,
  assertPageEnvelope,
  encodeKnownVersions,
  FetchTransport,
} from "../src/transport";

const fixtureDirectory = path.resolve(
  import.meta.dirname,
  "../../../tests/fixtures/protocol-v1"
);
const baseline = JSON.parse(
  fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../tests/fixtures/protocol-v1-v0.9.0.json"
    ),
    "utf8"
  )
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

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, normalize(record[key])])
    );
  }
  return value;
}

function semanticDigest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function exactByteLengthOnlyKeys(targetBytes: number): string[] {
  const keys = Array.from({ length: 100 }, (_, index) =>
    String(index).padStart(3, "0") + "a".repeat(125)
  );
  let remaining = targetBytes - byteLength(keys.join(","));

  for (let index = 0; remaining > 0; index += 1) {
    const doubleByteCharacters = Math.min(125, remaining);
    if (doubleByteCharacters > 0) {
      keys[index] =
        keys[index].slice(0, -doubleByteCharacters) +
        "é".repeat(doubleByteCharacters);
      remaining -= doubleByteCharacters;
    }
  }

  expect(byteLength(keys.join(","))).toBe(targetBytes);
  return keys;
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

  it("matches the frozen v0.9.0 semantic baseline", () => {
    const fixtureDigests = Object.fromEntries(
      fs.readdirSync(fixtureDirectory)
        .filter(name => name.endsWith(".json"))
        .toSorted()
        .map(name => [name, semanticDigest(loadFixture(name))])
    );
    const patchFixture = loadFixture("mutation-patch.json") as MutationEnvelope;
    const patchOperations = Object.values(patchFixture.mutation.patches ?? {})
      .flat()
      .map(patch => patch.op);

    expect(baseline.packageBaseline).toBe("0.9.0");
    expect(fixtureDigests).toEqual(baseline.fixtureDigests);
    expect({ version: PROTOCOL_VERSION, mediaType: PROTOCOL_MEDIA_TYPE })
      .toEqual(baseline.protocol);
    expect([...FLUX_CAPABILITIES]).toEqual(baseline.capabilities);
    expect({
      capabilities: HEADER_CAPABILITIES,
      clientId: HEADER_CLIENT_ID,
      live: HEADER_LIVE,
      liveKeys: HEADER_LIVE_KEYS,
    }).toEqual({
      capabilities: baseline.headers.capabilities,
      clientId: baseline.headers.clientId,
      live: baseline.headers.live,
      liveKeys: baseline.headers.liveKeys,
    });
    expect({
      liveKeysHeaderBytes: MAX_LIVE_KEYS_HEADER_BYTES,
      liveKeys: MAX_LIVE_EVENT_KEYS,
      resourceKeyCharacters: MAX_LIVE_RESOURCE_KEY_LENGTH,
      clientIdCharacters: MAX_LIVE_CLIENT_ID_LENGTH,
      liveEventBytes: MAX_LIVE_EVENT_BYTES,
    }).toEqual({
      liveKeysHeaderBytes: baseline.limits.liveKeysHeaderBytes,
      liveKeys: baseline.limits.liveKeys,
      resourceKeyCharacters: baseline.limits.resourceKeyCharacters,
      clientIdCharacters: baseline.limits.clientIdCharacters,
      liveEventBytes: baseline.limits.liveEventBytes,
    });
    expect(patchOperations).toEqual(baseline.patchOperations);
    expect({
      eventName: LIVE_EVENT_NAME,
      eventTypes: ["ready", "invalidate", "patch", "resync"],
      resyncReasons: [...LIVE_RESYNC_REASONS],
    }).toEqual(baseline.live);
  });

  it("keeps the v0.9 browser header bounds exact", async () => {
    const exactKnown = Object.fromEntries(
      Array.from({ length: baseline.limits.knownResources }, (_, index) => [
        String(index).padStart(3, "0") + "k".repeat(125),
        "v".repeat(index === 0 ? 112 : 29),
      ])
    );
    const oversizedKnown = {
      ...exactKnown,
      [Object.keys(exactKnown)[0]]: "v".repeat(113),
    };
    expect(byteLength(JSON.stringify(exactKnown)))
      .toBe(baseline.limits.knownDecodedBytes);
    expect(byteLength(JSON.stringify(oversizedKnown)))
      .toBe(baseline.limits.knownDecodedBytes + 1);
    expect(encodeKnownVersions(exactKnown)).toBeDefined();
    expect(encodeKnownVersions(oversizedKnown)).toBeUndefined();

    const countedKnown = Object.fromEntries(
      Array.from({ length: baseline.limits.knownResources + 1 }, (_, index) => [
        `resource-${index}`,
        `v${index}`,
      ])
    );
    const encodedCountedKnown = encodeKnownVersions(countedKnown);
    expect(encodedCountedKnown).toBeDefined();
    expect(
      Object.keys(
        JSON.parse(Buffer.from(encodedCountedKnown!, "base64url").toString("utf8"))
      )
    ).toHaveLength(baseline.limits.knownResources);
    expect(
      encodeKnownVersions({
        ["k".repeat(baseline.limits.resourceKeyCharacters + 1)]: "v1",
      })
    ).toBeUndefined();
    expect(
      encodeKnownVersions({
        rooms: "v".repeat(baseline.limits.resourceVersionCharacters + 1),
      })
    ).toBeUndefined();

    const exactOnly = exactByteLengthOnlyKeys(baseline.limits.onlyHeaderBytes);
    const oversizedOnly = [...exactOnly];
    oversizedOnly[oversizedOnly.length - 1] =
      oversizedOnly.at(-1)!.slice(0, -1) + "é";
    expect(byteLength(oversizedOnly.join(",")))
      .toBe(baseline.limits.onlyHeaderBytes + 1);

    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          protocol: PROTOCOL_VERSION,
          page: { component: "rooms/index", url: "/rooms" },
          resources: {},
        }),
        { headers: { "content-type": PROTOCOL_MEDIA_TYPE } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const transport = new FetchTransport();
    await transport.visit({ url: "/rooms", visitId: "exact", only: exactOnly });
    await transport.visit({ url: "/rooms", visitId: "oversized", only: oversizedOnly });
    await transport.visit({
      url: "/rooms",
      visitId: "over-count",
      only: Array.from(
        { length: baseline.limits.knownResources + 1 },
        (_, index) => `resource-${index}`
      ),
    });

    const exactHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    const oversizedHeaders = fetchMock.mock.calls[1][1]?.headers as Record<
      string,
      string
    >;
    const countedHeaders = fetchMock.mock.calls[2][1]?.headers as Record<
      string,
      string
    >;
    expect(exactHeaders[baseline.headers.only]).toBe(exactOnly.join(","));
    expect(oversizedHeaders[baseline.headers.only]).toBeUndefined();
    expect(countedHeaders[baseline.headers.only]?.split(","))
      .toHaveLength(baseline.limits.knownResources);
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

    expect(operations).toEqual(baseline.patchOperations);
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
    expect(PROTOCOL_VERSION).toBe(baseline.protocol.version);
    expect(PROTOCOL_MEDIA_TYPE).toBe(baseline.protocol.mediaType);
    expect(HEADER_CAPABILITIES).toBe(baseline.headers.capabilities);
    expect(HEADER_CLIENT_ID).toBe(baseline.headers.clientId);
    expect(HEADER_LIVE).toBe(baseline.headers.live);
    expect(HEADER_LIVE_KEYS).toBe(baseline.headers.liveKeys);
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
      [baseline.headers.accept]: PROTOCOL_MEDIA_TYPE,
      [baseline.headers.fluxfast]: "1",
      [baseline.headers.protocol]: "1",
      [baseline.headers.visit]: "visit_fixture",
      [baseline.headers.only]: "rooms",
      [HEADER_CAPABILITIES]: "deferred-resources,live-resources",
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toHaveProperty(
      baseline.headers.known
    );
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      [baseline.headers.accept]: PROTOCOL_MEDIA_TYPE,
      "Content-Type": "application/json",
      [baseline.headers.fluxfast]: "1",
      [baseline.headers.protocol]: "1",
      [HEADER_CAPABILITIES]: "deferred-resources,live-resources",
      [HEADER_CLIENT_ID]: "ff_fixture",
    });
  });
});
