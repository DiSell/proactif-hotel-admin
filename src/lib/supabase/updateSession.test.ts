import { describe, expect, it } from "vitest";
import { isPublicPath } from "./updateSession";

describe("isPublicPath", () => {
  it("[login] /login and its sub-paths are public — unchanged existing behavior", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/login/reset")).toBe(true);
  });

  it("[client-portal login] /client/login and its sub-paths (forgot-password, reset-password) are public, so an unauthenticated visitor can actually sign in", () => {
    expect(isPublicPath("/client/login")).toBe(true);
    expect(isPublicPath("/client/login/forgot-password")).toBe(true);
    expect(isPublicPath("/client/login/reset-password")).toBe(true);
  });

  it("[client-portal surfaces stay gated] every other /client/* path is NOT public", () => {
    expect(isPublicPath("/client/dashboard")).toBe(false);
    expect(isPublicPath("/client/partners")).toBe(false);
    expect(isPublicPath("/api/client/hotels/abc/chat")).toBe(false);
  });

  it("[partner consent page] /partenaires/consentement is public — the partner has no account, the token in the URL is the sole authorization", () => {
    expect(isPublicPath("/partenaires/consentement")).toBe(true);
  });

  it("[widget page] /widget/[widgetKey] is public", () => {
    expect(isPublicPath("/widget/ps_live_abc123")).toBe(true);
    expect(isPublicPath("/widget/ps_live_abc123/")).toBe(true);
  });

  it("[widget API] /api/widget/[widgetKey]/config and /chat are public", () => {
    expect(isPublicPath("/api/widget/ps_live_abc123/config")).toBe(true);
    expect(isPublicPath("/api/widget/ps_live_abc123/chat")).toBe(true);
  });

  it("[WhatsApp webhook] /api/webhooks/whatsapp is public — Meta calls it with no Supabase session at all", () => {
    expect(isPublicPath("/api/webhooks/whatsapp")).toBe(true);
  });

  it("[not a real prefix match] /api/webhookssomething is NOT public", () => {
    expect(isPublicPath("/api/webhookssomething")).toBe(false);
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

  it("[legal pages] /legal/privacy, /legal/terms, and /legal/data-deletion are public — no session/cookie required, reachable by Meta's own app-review process and its Data Deletion Instructions URL requirement", () => {
    expect(isPublicPath("/legal/privacy")).toBe(true);
    expect(isPublicPath("/legal/terms")).toBe(true);
    expect(isPublicPath("/legal/data-deletion")).toBe(true);
  });

  it("[canonical French legal URLs for Meta Developers] /politique-de-confidentialite, /conditions-utilisation, /suppression-donnees are public", () => {
    expect(isPublicPath("/politique-de-confidentialite")).toBe(true);
    expect(isPublicPath("/conditions-utilisation")).toBe(true);
    expect(isPublicPath("/suppression-donnees")).toBe(true);
  });

  it("[no accidental prefix collision on /legal/] a path that merely starts with 'legal' but isn't under /legal/ is NOT public", () => {
    expect(isPublicPath("/legalsomething")).toBe(false);
  });

  it("[WhatsApp activation link] /whatsapp/connect/[token] is public — the hotel's own WhatsApp Business owner has no Proactif account, the token in the URL is the sole authorization", () => {
    expect(isPublicPath("/whatsapp/connect/abc123")).toBe(true);
    expect(isPublicPath("/whatsapp/connect")).toBe(true);
  });

  it("[admin WhatsApp tab stays gated] /etablissements/[id]/whatsapp (the admin dashboard's link-generation screen) is NOT public — only the /whatsapp/connect/[token] visitor page is", () => {
    expect(isPublicPath("/etablissements/abc/whatsapp")).toBe(false);
  });

  it("[no accidental prefix collision on /whatsapp/connect] a path that merely starts with 'whatsapp' but isn't under /whatsapp/connect is NOT public", () => {
    expect(isPublicPath("/whatsappsomething")).toBe(false);
  });
});
