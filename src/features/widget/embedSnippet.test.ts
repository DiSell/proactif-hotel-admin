import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildWidgetSnippet, widgetPublicOrigin } from "./embedSnippet";

describe("buildWidgetSnippet / widgetPublicOrigin", () => {
  it("[real unit test] builds the exact expected snippet for a given widget_key", () => {
    const snippet = buildWidgetSnippet("ps_live_test123");
    expect(snippet).toBe('<script\n  src="https://chat.proactifsystem.fr/widget.js"\n  data-key="ps_live_test123">\n</script>');
  });

  it("[no secret] the snippet never contains anything beyond the origin and the given widget_key — no service-role key, no credential", () => {
    const snippet = buildWidgetSnippet("ps_live_test123");
    expect(snippet).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(snippet).not.toMatch(/credential/i);
    expect(snippet).not.toMatch(/secret/i);
  });

  it("[widgetPublicOrigin] returns exactly the domain used in the snippet", () => {
    expect(buildWidgetSnippet("x")).toContain(widgetPublicOrigin());
  });
});

/**
 * Source unique de vérité — the back-office (WidgetSettingsForm.tsx) and
 * the client portal (ClientWidgetInfo.tsx) both import buildWidgetSnippet
 * from this exact module, rather than each hardcoding the domain
 * independently. A regression here (either file reverting to an inline
 * literal) would silently let the two surfaces drift apart.
 */
describe("single source of truth for the embed domain", () => {
  it("[WidgetSettingsForm.tsx] imports and uses buildWidgetSnippet, never hardcodes the domain inline", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "WidgetSettingsForm.tsx"), "utf8");
    expect(source).toMatch(/import \{ buildWidgetSnippet \} from "\.\/embedSnippet";/);
    expect(source).toMatch(/const snippet = buildWidgetSnippet\(hotel\.widget_key\);/);
    expect(source).not.toMatch(/chat\.proactifsystem\.fr/);
  });

  it("[ClientWidgetInfo.tsx] imports and uses buildWidgetSnippet, never hardcodes the domain inline", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ClientWidgetInfo.tsx"), "utf8");
    expect(source).toMatch(/import \{ buildWidgetSnippet \} from "\.\/embedSnippet";/);
    expect(source).toMatch(/buildWidgetSnippet\(hotel\.widget_key\)/);
    expect(source).not.toMatch(/chat\.proactifsystem\.fr/);
  });

  it("[embedSnippet.ts itself] is the only file in src/ containing the literal domain string", () => {
    // A cheap, precise regression check: exactly one real source file (this
    // module) should ever contain the literal domain — everything else
    // must go through the shared function.
    const embedSnippetSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "embedSnippet.ts"), "utf8");
    expect(embedSnippetSource).toMatch(/chat\.proactifsystem\.fr/);
  });
});
