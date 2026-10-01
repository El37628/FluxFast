import { describe, expect, it } from "vitest";
import {
  removeFluxHopByHopHeaders,
  selectFluxForwardHeaders,
} from "../src/server/index.js";

const perHop = [
  "connection", "content-length", "host", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
];

describe("server header boundaries", () => {
  it.each(perHop)("never forwards %s, even when explicitly allowlisted", name => {
    const input = new Headers({ [name]: "must-not-cross", "x-safe": "ok" });
    expect(removeFluxHopByHopHeaders(input).get(name)).toBeNull();
    expect(selectFluxForwardHeaders(input, [name.toUpperCase(), "x-safe"]).get(name)).toBeNull();
    expect(input.get(name)).toBe("must-not-cross");
  });

  it("selects the four SSR defaults without forwarding arbitrary credentials", () => {
    const input = {
      Cookie: "session=example",
      Authorization: "Bearer example",
      "Accept-Language": "en",
      "User-Agent": "Example Browser",
      "X-CSRF-Token": "csrf-example",
      "X-Tenant": "tenant-example",
      Accept: "text/html",
    };
    expect(Object.fromEntries(selectFluxForwardHeaders(input))).toEqual({
      "accept-language": "en",
      authorization: "Bearer example",
      cookie: "session=example",
      "user-agent": "Example Browser",
    });
    expect(selectFluxForwardHeaders(input, ["X-Tenant"]).get("x-tenant")).toBe("tenant-example");
    expect(selectFluxForwardHeaders(input, ["X-Tenant"]).get("x-csrf-token")).toBeNull();
  });

  it("removes Connection-nominated fields case-insensitively before selecting", () => {
    const input = new Headers({
      connection: " X-Tenant, Cookie, AUTHORIZATION, bad field, , x-safe ",
      "x-tenant": "tenant-secret", cookie: "session-secret",
      authorization: "authorization-secret", "x-safe": "remove-too",
      "accept-language": "en", "x-end-to-end": "keep",
    });
    const clean = removeFluxHopByHopHeaders(input);
    expect(Object.fromEntries(clean)).toEqual({
      "accept-language": "en", "x-end-to-end": "keep",
    });
    const selected = selectFluxForwardHeaders(input, ["X-Tenant", "X-Safe", "X-End-To-End"]);
    expect(Object.fromEntries(selected)).toEqual(Object.fromEntries(clean));
    expect(input.get("cookie")).toBe("session-secret");
    expect(input.has("connection")).toBe(true);
  });

  it("supports HeadersInit tuples and ignores invalid configured names", () => {
    const input: [string, string][] = [["X-Safe", "one"], ["x-safe", "two"]];
    const clean = selectFluxForwardHeaders(input, [
      "X-Safe", "", " bad ", "x\r\n-cookie", "bad:field", "☃",
    ]);
    expect(Object.fromEntries(clean)).toEqual({ "x-safe": "one, two" });
  });

  it("retains separate Set-Cookie values and safe protocol/SSE response headers", () => {
    const input = new Headers([
      ["set-cookie", "first=1; Path=/; HttpOnly"],
      ["set-cookie", "second=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT"],
      ["content-type", "text/event-stream"], ["cache-control", "no-cache, no-transform"],
      ["x-accel-buffering", "no"], ["x-fluxfast-devtools-trace", "safe-trace"],
      ["connection", "keep-alive, x-private-hop"], ["x-private-hop", "secret"],
    ]);
    const clean = removeFluxHopByHopHeaders(input);
    expect(clean.getSetCookie()).toEqual(input.getSetCookie());
    expect(clean.get("content-type")).toBe("text/event-stream");
    expect(clean.get("cache-control")).toBe("no-cache, no-transform");
    expect(clean.get("x-accel-buffering")).toBe("no");
    expect(clean.get("x-fluxfast-devtools-trace")).toBe("safe-trace");
    expect(clean.has("connection")).toBe(false);
    expect(clean.has("x-private-hop")).toBe(false);
  });

  it.each([removeFluxHopByHopHeaders, selectFluxForwardHeaders])(
    "does not reflect a rejected credential value in native header errors",
    helper => {
      const secret = "credential-secret\r\ninjected: value";
      try {
        helper({ authorization: secret });
        throw new Error("Expected header rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("Invalid FluxFast headers");
        expect(String(error)).not.toContain("credential-secret");
        expect((error as Error).cause).toBeUndefined();
      }
    }
  );
});
