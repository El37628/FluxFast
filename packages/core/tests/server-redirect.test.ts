import { describe, expect, it } from "vitest";
import { TransportError } from "../src/errors.js";
import {
  DEFAULT_MAX_INITIAL_REDIRECTS,
  isFluxRedirectStatus,
  resolveFluxRedirect,
} from "../src/server/redirect.js";

const origin = "http://127.0.0.1:8000";
const requestUrl = `${origin}/rooms`;

describe("initial-page redirect boundary", () => {
  it.each([301, 302, 303, 307, 308])("recognizes HTTP %i", status => {
    expect(isFluxRedirectStatus(status)).toBe(true);
  });

  it.each([200, 300, 304, 305, 306, 404, 500])("does not follow HTTP %i", status => {
    expect(isFluxRedirectStatus(status)).toBe(false);
  });

  it("keeps the existing twenty-redirect default", () => {
    expect(DEFAULT_MAX_INITIAL_REDIRECTS).toBe(20);
  });

  it.each([
    ["/rooms/?tag=a&tag=b", `${origin}/rooms/?tag=a&tag=b`],
    ["rooms/", `${origin}/rooms/`],
    ["?page=2", `${origin}/rooms?page=2`],
    ["../hotel/%2Froom", `${origin}/hotel/%2Froom`],
    [`${origin}/canonical`, `${origin}/canonical`],
    ["//127.0.0.1:8000/canonical", `${origin}/canonical`],
  ])("resolves an ordinary canonical redirect %s", (location, expected) => {
    expect(resolveFluxRedirect(location, requestUrl, origin, 307).href).toBe(expected);
  });

  it.each([
    "https://evil.example/steal?token=secret",
    "//evil.example/steal", "http://127.0.0.1:9000/rooms",
    "https://127.0.0.1:8000/rooms", "http://localhost:8000/rooms",
    "http://user:password@127.0.0.1:8000/rooms",
    "//user@127.0.0.1:8000/rooms", "\\\\evil.example/rooms",
    "/\\evil.example/rooms", "javascript:alert(1)", "data:text/plain,secret",
  ])("confines redirect %s without reflecting its contents", location => {
    try {
      resolveFluxRedirect(location, requestUrl, origin, 307);
      throw new Error("Expected redirect rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).status).toBe(307);
      expect((error as Error).message).toBe(
        "Initial FluxFast response redirects outside the configured backend origin"
      );
      expect((error as TransportError).details).toBeUndefined();
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("maps malformed targets to the existing safe transport error", () => {
    expect(() => resolveFluxRedirect("http://[secret", requestUrl, origin, 302)).toThrow(
      "Initial FluxFast response has an invalid redirect"
    );
  });
});
