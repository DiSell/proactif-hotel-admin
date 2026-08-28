import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "client.ts"), "utf8");

/**
 * Regression guards for the createBrowserClient singleton bug — confirmed
 * by reading the installed @supabase/ssr@0.12.4 source directly
 * (node_modules/@supabase/ssr/dist/main/createBrowserClient.js): it caches
 * ONE client in a module-level variable, keyed on NOTHING (not
 * cookieOptions.name, not supabaseUrl) — the first call anywhere on a page
 * wins, and every later call to a DIFFERENT factory silently gets that same
 * cached instance back unless `isSingleton: false` is passed explicitly.
 * See client.ts's own doc comments for the full quoted source and
 * reasoning. Source-level, same DOM-less constraint (no jsdom, no real
 * browser runtime) as elsewhere in this repo.
 */
describe("createClient / createClientPortalBrowserClient — never share the @supabase/ssr module-level singleton", () => {
  it("[createClient] passes isSingleton: false — never returns a cached instance from a prior, differently-scoped call", () => {
    const start = source.indexOf("export function createClient(");
    const nextExport = source.indexOf("\nexport function", start + 1);
    const fnSource = source.slice(start, nextExport === -1 ? undefined : nextExport);
    expect(fnSource).toMatch(/isSingleton:\s*false/);
  });

  it("[createClientPortalBrowserClient] ALSO passes isSingleton: false — both factories, not just one, or the un-guarded one could still poison the other", () => {
    const start = source.indexOf("export function createClientPortalBrowserClient(");
    const fnSource = source.slice(start);
    expect(fnSource).toMatch(/isSingleton:\s*false/);
  });

  it("[distinct cookie scopes] only createClientPortalBrowserClient's BODY sets cookieOptions.name — createClient's body stays on the default (back-office) scope", () => {
    // Bounded to the function BODY only (up to its own closing brace) —
    // the doc comment sitting between the two functions talks about
    // cookieOptions.name in prose (explaining the singleton bug), which
    // would otherwise leak into a naive "next export" slice and produce a
    // false failure here.
    const createClientStart = source.indexOf("export function createClient(");
    const createClientBodyEnd = source.indexOf("\n}\n", createClientStart);
    const createClientSource = source.slice(createClientStart, createClientBodyEnd + 2);
    expect(createClientSource).not.toMatch(/cookieOptions/);

    const portalStart = source.indexOf("export function createClientPortalBrowserClient(");
    const portalBodyEnd = source.indexOf("\n}\n", portalStart);
    const portalSource = source.slice(portalStart, portalBodyEnd === -1 ? undefined : portalBodyEnd + 2);
    expect(portalSource).toMatch(/cookieOptions:\s*\{\s*name:\s*CLIENT_PORTAL_COOKIE_NAME\s*\}/);
  });
});
