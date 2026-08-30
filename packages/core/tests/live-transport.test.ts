import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolError, TransportError, VersionMismatchError } from "../src/errors";
import {
  FetchSseLiveTransport,
  FluxSseParser,
  HEADER_CLIENT_ID,
  HEADER_LIVE,
  HEADER_LIVE_KEYS,
  LiveConnection,
  MAX_LIVE_EVENT_BYTES,
  serializeLiveKeys,
} from "../src/live/transport";
import type { LiveEvent } from "../src/live/protocol";

afterEach(() => vi.unstubAllGlobals());

const encoder = new TextEncoder();

function responseFromChunks(chunks: string[], contentType = "text/event-stream") {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": contentType } });
}

async function collect(connection: LiveConnection): Promise<LiveEvent[]> {
  const events: LiveEvent[] = [];
  for await (const event of connection) events.push(event);
  return events;
}

describe("FetchSseLiveTransport", () => {
  it("sends bounded headers and parses chunked events while ignoring heartbeats", async () => {
    const wire = [
      ': ping\n\n',
      'event: fluxfast\ndata: {"protocol":"fluxfast/1","type":"ready","keys":["rooms"]}\n\n',
      'event: fluxfast\r\ndata: {"protocol":"fluxfast/1","type":"invalidate","keys":["rooms"]}\r\n\r\n',
      'event: fluxfast\ndata: {"protocol":"fluxfast/1","type":"patch","patches":{"rooms":[{"op":"append-item","value":{"id":2}}]}}\n\n',
      'event: fluxfast\ndata: {"protocol":"fluxfast/1","type":"resync","keys":["rooms"],"reason":"server"}\n\n',
    ].join("");
    const chunks = [wire.slice(0, 17), wire.slice(17, 91), wire.slice(91)];
    const fetchMock = vi.fn().mockResolvedValue(responseFromChunks(chunks));
    vi.stubGlobal("fetch", fetchMock);

    const connection = new FetchSseLiveTransport("http://backend.test").connect({
      url: "/rooms?filter=open",
      keys: ["rooms", "rooms"],
      clientId: "ff_tab",
    });
    const events = await collect(connection);

    expect(events.map(event => event.type)).toEqual([
      "ready",
      "invalidate",
      "patch",
      "resync",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/rooms?filter=open",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          [HEADER_LIVE]: "1",
          [HEADER_LIVE_KEYS]: "rooms",
          [HEADER_CLIENT_ID]: "ff_tab",
        }),
      })
    );
  });

  it("cancels the reader and aborts fetch when closed", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Stay pending until the connection cancels the reader.
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, { headers: { "content-type": "text/event-stream" } })
      )
    );
    const connection = new FetchSseLiveTransport().connect({
      url: "/rooms",
      keys: ["rooms"],
    });
    const iterator = connection[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => expect(connection.signal.aborted).toBe(false));

    connection.close("navigation");

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(connection.signal.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("maps non-success responses to transport errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "not authorized" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const connection = new FetchSseLiveTransport().connect({
      url: "/rooms",
      keys: ["rooms"],
    });

    await expect(collect(connection)).rejects.toMatchObject<Partial<TransportError>>({
      name: "TransportError",
      message: "not authorized",
      status: 403,
    });
  });

  it("rejects non-SSE responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromChunks([], "text/html")));
    const connection = new FetchSseLiveTransport().connect({
      url: "/rooms",
      keys: ["rooms"],
    });
    await expect(collect(connection)).rejects.toThrowError(ProtocolError);
  });
});

describe("FluxSseParser", () => {
  it("rejects malformed, unknown, incompatible, and oversized events", () => {
    const malformed = new FluxSseParser();
    expect(() => malformed.push(encoder.encode("event: fluxfast\ndata: {bad}\n\n")))
      .toThrowError(ProtocolError);

    const unknown = new FluxSseParser();
    expect(() => unknown.push(encoder.encode(
      'event: fluxfast\ndata: {"protocol":"fluxfast/1","type":"future"}\n\n'
    ))).toThrowError(/Unknown live event type/);

    const incompatible = new FluxSseParser();
    expect(() => incompatible.push(encoder.encode(
      'event: fluxfast\ndata: {"protocol":"fluxfast/2","type":"ready","keys":[]}\n\n'
    ))).toThrowError(VersionMismatchError);

    const oversized = new FluxSseParser();
    expect(() => oversized.push(encoder.encode("x".repeat(MAX_LIVE_EVENT_BYTES + 1))))
      .toThrowError(/exceeds/);
  });

  it("dispatches a valid final event without a trailing blank line", () => {
    const parser = new FluxSseParser();
    parser.push(encoder.encode(
      'event: fluxfast\ndata: {"protocol":"fluxfast/1","type":"ready","keys":[]}'
    ));
    expect(parser.finish()).toMatchObject([{ type: "ready", keys: [] }]);
  });
});

describe("live request validation", () => {
  it("sorts and deduplicates safe keys", () => {
    expect(serializeLiveKeys(["summary", "activity", "summary"]))
      .toBe("activity,summary");
  });

  it.each([
    [],
    ["bad,key"],
    [""],
    ["x".repeat(129)],
    Array.from({ length: 101 }, (_, index) => `key-${index}`),
  ])("rejects unsafe or excessive key metadata", keys => {
    expect(() => serializeLiveKeys(keys)).toThrowError(ProtocolError);
  });

  it("rejects invalid client IDs before fetching", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => new FetchSseLiveTransport().connect({
      url: "/rooms",
      keys: ["rooms"],
      clientId: "contains space",
    })).toThrowError(/client ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
