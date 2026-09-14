"use server";

// Deliberately SEPARATE from actions.ts — every export there is guarded by
// requireClientAccess() (an authenticated hotel_admin). This one is called
// from the PUBLIC unsubscribe page (src/app/desinscription/page.tsx) by an
// anonymous recipient who has no session at all — the token itself IS the
// authorization (see unsubscribeToken.ts), so this never calls
// requireClientAccess, and it writes through the service-role client, never
// a session-bound one — same separation as features/partners/consentActions.ts.
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyUnsubscribeToken } from "./unsubscribeToken";

export type UnsubscribeResult = { ok: true; hotelName: string } | { ok: false };

/**
 * The ONLY way customer_unsubscribed is ever set from outside the client
 * portal — see eligibility.ts, where it takes absolute priority over every
 * other flag for both marketing and post-stay sends. Idempotent: clicking
 * an already-used (or forwarded/reused) link simply re-confirms the same
 * state, never errors.
 */
export async function unsubscribeCustomerByToken(token: string): Promise<UnsubscribeResult> {
  const customerId = verifyUnsubscribeToken(token);
  if (!customerId) return { ok: false };

  const supabase = createAdminClient();
  const { data: customer, error } = await supabase
    .from("hotel_customers")
    .update({ customer_unsubscribed: true })
    .eq("id", customerId)
    .select("hotel_id")
    .maybeSingle();
  if (error || !customer) return { ok: false };

  const { data: hotel } = await supabase.from("hotels").select("name").eq("id", customer.hotel_id).maybeSingle<{ name: string }>();
  return { ok: true, hotelName: hotel?.name ?? "l'établissement" };
}
