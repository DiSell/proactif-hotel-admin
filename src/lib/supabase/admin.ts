import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./env";

/**
 * Service-role client — bypasses RLS entirely. NOT used by any Server
 * Action in this milestone: every dashboard CRUD path uses the
 * session-bound client in ./server.ts so RLS stays the actual gate.
 *
 * Reserved for later, genuinely session-less server work (background jobs,
 * data migrations). Never import this from a Client Component or route
 * that renders in the browser.
 */
export function createAdminClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. This client is not needed for the current milestone — only set it if a specific server-only job requires bypassing RLS."
    );
  }
  return createSupabaseClient(supabaseUrl(), serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
