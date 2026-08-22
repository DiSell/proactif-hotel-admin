import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabasePublishableKey, supabaseUrl } from "./env";

/**
 * Server-side client bound to the current request's session (cookies).
 * All dashboard reads/writes go through this — RLS decides what the
 * signed-in user can see or change, never a service-role bypass.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabasePublishableKey(), {
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
