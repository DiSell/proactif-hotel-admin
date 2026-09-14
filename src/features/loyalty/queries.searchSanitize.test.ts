import { describe, expect, it } from "vitest";
import { sanitizeForOrFilter } from "./queries";

describe("sanitizeForOrFilter", () => {
  it("[comma neutralized] can no longer inject an extra OR-clause into the filter string", () => {
    const injected = 'x%,marketing_allowed.eq.true,last_name.ilike.%"';
    const safe = sanitizeForOrFilter(injected);
    expect(safe).not.toContain(",");
  });

  it("[parentheses neutralized] can no longer break out of the filter grouping", () => {
    expect(sanitizeForOrFilter("a(b)c")).not.toMatch(/[()]/);
  });

  it("[ordinary search terms pass through unchanged]", () => {
    expect(sanitizeForOrFilter("Marie Dupont")).toBe("Marie Dupont");
    expect(sanitizeForOrFilter("marie@example.com")).toBe("marie@example.com");
  });
});
