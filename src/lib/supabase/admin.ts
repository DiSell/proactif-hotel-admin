import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./env";

/**
 * Service-role client — bypasses RLS entirely. Used only after an explicit,
 * prior server-side authorization check, never as a substitute for one:
 * the public widget routes (features/widget/publicHotel.ts) and
 * /api/hotels/[id]/chat/route.ts (after requireHotelAccess()) both resolve
 * "who is allowed to see what" themselves, in application code, before
 * ever touching this client — RLS is not the gate on those paths, the
 * authorization check that runs first is. Every ordinary dashboard CRUD
 * path still uses the session-bound client in ./server.ts, where RLS
 * remains the actual gate. Never import this from a Client Component or
 * route that renders in the browser.
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
