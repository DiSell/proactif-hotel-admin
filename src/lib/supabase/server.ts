import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabasePublishableKey, supabaseUrl } from "./env";
import { CLIENT_PORTAL_COOKIE_NAME } from "./cookieScope";

/**
 * Shared implementation — `cookieName` undefined means "@supabase/ssr's own
 * default, project-derived cookie name", i.e. the back-office scope, used
 * by every existing caller of createClient() below with zero behavior
 * change. Passing CLIENT_PORTAL_COOKIE_NAME gives the client portal its own,
 * independent session cookie — see cookieScope.ts's own doc comment for why.
 */
async function createScopedClient(cookieName?: string) {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabasePublishableKey(), {
    ...(cookieName ? { cookieOptions: { name: cookieName } } : null),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component render — safe to ignore because
          // proxy.ts refreshes the session on every request anyway.
        }
      },
    },
  });
}

/**
 * Server-side client bound to the current request's session (cookies), back-
 * office scope (the default cookie name). All back-office dashboard reads/
 * writes go through this — RLS decides what the signed-in user can see or
 * change, never a service-role bypass.
 */
export async function createClient() {
  return createScopedClient();
}

/**
 * Same as createClient(), but bound to the client portal's OWN session
 * cookie (CLIENT_PORTAL_COOKIE_NAME) — use this from anything under
 * src/app/client/** or features/client/**, so a hotel_admin's client-portal
 * session and a superadmin's back-office session can coexist in the same
 * browser without one overwriting the other's cookie.
 */
export async function createClientPortalClient() {
  return createScopedClient(CLIENT_PORTAL_COOKIE_NAME);
}
