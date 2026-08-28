import { describe, expect, it } from "vitest";
import { isClientScopedPath } from "./cookieScope";

describe("isClientScopedPath", () => {
  it("[exact /client] true", () => {
    expect(isClientScopedPath("/client")).toBe(true);
  });

  it("[/client/* page sub-paths] true", () => {
    expect(isClientScopedPath("/client/dashboard")).toBe(true);
    expect(isClientScopedPath("/client/partners")).toBe(true);
    expect(isClientScopedPath("/client/login")).toBe(true);
    expect(isClientScopedPath("/client/login/reset-password")).toBe(true);
    expect(isClientScopedPath("/client/conversations/abc-123")).toBe(true);
  });

  it("[/api/client/* API sub-paths] true — the dedicated client-scoped chat route lives here", () => {
    expect(isClientScopedPath("/api/client/hotels/abc-123/chat")).toBe(true);
  });

  it("[back-office paths] false", () => {
    expect(isClientScopedPath("/dashboard")).toBe(false);
    expect(isClientScopedPath("/etablissements/abc")).toBe(false);
    expect(isClientScopedPath("/login")).toBe(false);
    expect(isClientScopedPath("/api/hotels/abc-123/chat")).toBe(false);
  });

  it("[no accidental prefix collision] a path that merely starts with 'client' but isn't under /client/ or /api/client/ is false", () => {
    expect(isClientScopedPath("/clientsomething")).toBe(false);
    expect(isClientScopedPath("/api/clientsomething/chat")).toBe(false);
  });
});
