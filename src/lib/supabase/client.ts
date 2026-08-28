import { createBrowserClient } from "@supabase/ssr";
import { supabasePublishableKey, supabaseUrl } from "./env";
import { CLIENT_PORTAL_COOKIE_NAME } from "./cookieScope";

type NarrowBrowserClientOptions = { auth?: { detectSessionInUrl?: boolean } };

/**
 * `options` is a narrow passthrough, not used by most callers (the
 * default, argument-less call preserves exactly the previous behavior). It
 * exists so a page that needs to disable automatic URL-based session
 * detection — see ResetPasswordForm.tsx, which handles that manually
 * because @supabase/ssr's createBrowserClient hardcodes flowType: "pkce"
 * and cannot consume the implicit-grant callback URL an admin-initiated
 * invite/recovery link always produces — can opt into that without a
 * second, divergent client factory.
 *
 * Deliberately typed narrowly (not `Parameters<typeof createBrowserClient>[2]`)
 * — createBrowserClient is overloaded (a modern signature and a @deprecated
 * one requiring a mandatory `cookies` object), and `Parameters<>` on an
 * overloaded function resolves to its LAST signature, which would wrongly
 * demand `cookies` here. The cast below is safe: `auth` is a plain
 * SupabaseClientOptions field valid under either overload, and every
 * caller of this narrower type only ever sets `auth.detectSessionInUrl`.
 *
 * `isSingleton: false` on BOTH factories below is load-bearing, not
 * defensive boilerplate — see their shared comment further down for the
 * confirmed root cause this prevents (installed @supabase/ssr@0.12.4's
 * createBrowserClient caches ONE client in a module-level variable, keyed
 * on nothing — not on cookieOptions.name, not on any argument — the moment
 * any call anywhere on the page runs without an explicit `isSingleton`).
 *
 * Back-office scope (default, unnamed cookie) — see createClientPortalBrowserClient()
 * below for the client-portal equivalent. Never use this one from anything
 * under src/app/client/** or features/client/**.
 */
export function createClient(options?: NarrowBrowserClientOptions) {
  return createBrowserClient(supabaseUrl(), supabasePublishableKey(), {
    ...options,
    isSingleton: false,
  } as Parameters<typeof createBrowserClient>[2]);
}

/**
 * Same as createClient() above, but bound to the client portal's OWN
 * session cookie (CLIENT_PORTAL_COOKIE_NAME, lib/supabase/cookieScope.ts).
 * Required for anything that establishes or touches a session client-side
 * for the client portal — e.g. ClientResetPasswordForm.tsx's setSession()/
 * verifyOtp() calls after an invite/recovery link — so the resulting
 * session lands under the client cookie, never the back-office one.
 *
 * `isSingleton: false` here (and on createClient() above) is REQUIRED, not
 * optional hardening — confirmed by reading the installed
 * @supabase/ssr@0.12.4 source directly (node_modules/@supabase/ssr/dist/main/createBrowserClient.js):
 *
 *   let cachedBrowserClient;
 *   function createBrowserClient(supabaseUrl, supabaseKey, options) {
 *     const shouldUseSingleton = options?.isSingleton === true ||
 *       ((!options || !("isSingleton" in options)) && isBrowser());
 *     if (shouldUseSingleton && cachedBrowserClient) {
 *       return cachedBrowserClient;
 *     }
 *     ...
 *     if (shouldUseSingleton) { cachedBrowserClient = client; }
 *     return client;
 *   }
 *
 * `cachedBrowserClient` is a SINGLE module-level variable shared by every
 * call to createBrowserClient() in the whole bundle — it is NOT keyed by
 * cookieOptions.name, supabaseUrl, or any other argument. In a browser
 * runtime, `isSingleton` defaults to `true` whenever the caller's options
 * object doesn't explicitly set it. So without the explicit `false` below,
 * whichever of createClient()/createClientPortalBrowserClient() happened to
 * run FIRST anywhere on a page would populate `cachedBrowserClient`, and
 * every subsequent call to the OTHER factory — even with a completely
 * different cookieOptions.name — would silently return that SAME cached
 * instance, bound to the WRONG cookie. Passing `isSingleton: false`
 * unconditionally on both factories makes every call construct a fresh,
 * independent SupabaseClient bound to its own correct storage/cookieOptions,
 * so the two can never collide regardless of call order.
 */
export function createClientPortalBrowserClient(options?: NarrowBrowserClientOptions) {
  return createBrowserClient(supabaseUrl(), supabasePublishableKey(), {
    ...options,
    cookieOptions: { name: CLIENT_PORTAL_COOKIE_NAME },
    isSingleton: false,
  } as Parameters<typeof createBrowserClient>[2]);
}
