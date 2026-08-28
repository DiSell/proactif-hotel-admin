import { describe, expect, it } from "vitest";
import { parseHostOrigin } from "./hostOrigin";

describe("parseHostOrigin", () => {
  it("[valid https origin] accepted, returned exactly", () => {
    expect(parseHostOrigin("https://hotel-le1837.com")).toBe("https://hotel-le1837.com");
  });

  it("[valid http origin] accepted — some host pages may not use https", () => {
    expect(parseHostOrigin("http://staging.example.com")).toBe("http://staging.example.com");
  });

  it("[port preserved] an explicit port is part of the origin and is kept", () => {
    expect(parseHostOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("[path/query/hash stripped] a full URL is normalized down to just its origin, not rejected", () => {
    expect(parseHostOrigin("https://hotel.example.com/some/page?x=1#section")).toBe("https://hotel.example.com");
  });

  it("[javascript: rejected] never a navigable/executable scheme", () => {
    expect(parseHostOrigin("javascript:alert(1)")).toBeNull();
  });

  it("[data: rejected]", () => {
    expect(parseHostOrigin("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("[file: rejected]", () => {
    expect(parseHostOrigin("file:///etc/passwd")).toBeNull();
  });

  it("[malformed string] not a URL at all -> null, never throws", () => {
    expect(parseHostOrigin("not a url")).toBeNull();
  });

  it("[empty string] -> null", () => {
    expect(parseHostOrigin("")).toBeNull();
  });

  it("[null/undefined] -> null", () => {
    expect(parseHostOrigin(null)).toBeNull();
    expect(parseHostOrigin(undefined)).toBeNull();
  });
});
