import { describe, expect, it } from "vitest";
import { isPublicPath } from "./updateSession";

describe("isPublicPath", () => {
  it("[login] /login and its sub-paths are public — unchanged existing behavior", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/login/reset")).toBe(true);
  });

  it("[widget page] /widget/[widgetKey] is public", () => {
    expect(isPublicPath("/widget/ps_live_abc123")).toBe(true);
    expect(isPublicPath("/widget/ps_live_abc123/")).toBe(true);
  });

  it("[widget API] /api/widget/[widgetKey]/config and /chat are public", () => {
    expect(isPublicPath("/api/widget/ps_live_abc123/config")).toBe(true);
    expect(isPublicPath("/api/widget/ps_live_abc123/chat")).toBe(true);
  });

  it("[embed script] /widget.js is public", () => {
    expect(isPublicPath("/widget.js")).toBe(true);
  });

  it("[admin surfaces stay gated] the dashboard, hotel admin pages, and the ADMIN chat API are NOT public", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/etablissements")).toBe(false);
    expect(isPublicPath("/etablissements/abc/widget")).toBe(false);
    expect(isPublicPath("/api/hotels/abc/chat")).toBe(false);
  });

  it("[no accidental prefix collision] a path that merely starts with 'widget' but isn't under /widget/ is NOT public", () => {
    expect(isPublicPath("/widgetsomething")).toBe(false);
    expect(isPublicPath("/api/widgetsomething/chat")).toBe(false);
  });
});
