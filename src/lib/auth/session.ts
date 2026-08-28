import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createClientPortalClient } from "@/lib/supabase/server";
import type { AuthScope } from "@/lib/supabase/cookieScope";
import type { Profile } from "@/types/database";

/**
 * Verifies the caller is an authenticated superadmin. Called at the top of
 * every Server Action and every page's data fetch — proxy.ts already gates
 * navigations, but Server Functions can be reached directly, so each one
 * checks for itself too (see Next.js proxy docs: "Always verify
 * authentication and authorization inside each Server Function").
 *
 * An authenticated user who simply isn't a superadmin (a hotel_admin) is
 * redirected to /client/dashboard, not /login — they ARE logged in, just
 * not into this space. This is the one behavioral change that lets both
 * `login()` and `updatePassword()` redirect to the same neutral
 * `/dashboard` unconditionally and rely on this guard to route each role
 * to its own home, without either of them needing role-aware logic.
 */
export async function requireSuperadmin(): Promise<{ userId: string; profile: Profile }> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;

  if (!userId) {
    redirect("/login");
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single<Profile>();

  if (error || !profile) {
    redirect("/login");
  }

  if (profile.role !== "superadmin") {
    redirect("/client/dashboard");
  }

  return { userId, profile };
}

/**
 * Verifies the caller is an authenticated hotel_admin linked to EXACTLY one
 * hotel (hotel_users_user_key — see 0011_hotel_client_portal.sql — makes
 * "more than one row" impossible at the database level, so `.maybeSingle()`
 * here can only ever see zero or one row, never "the first of several").
 * A superadmin landing here (only possible if their role changed after an
 * existing client-portal session was already established — clientLogin()
 * itself already refuses to establish one for a superadmin credential) is
 * sent back to their own space (/dashboard), not treated as an error —
 * mirrors requireSuperadmin()'s symmetric behavior, and together the two
 * guards can never form a redirect loop (each only redirects AWAY from its
 * own space, never back into it). Every other failure redirects to
 * /client/login (this space's OWN login page — see cookieScope.ts —, never
 * the back-office /login), so this space is fully self-contained.
 */
export async function requireClientAccess(): Promise<{ userId: string; profile: Profile; hotelId: string }> {
  // Client-portal cookie scope — see lib/supabase/cookieScope.ts: this is
  // what lets a hotel_admin stay signed into /client/* independently of any
  // back-office session in the same browser.
  const supabase = await createClientPortalClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;

  if (!userId) {
    redirect("/client/login");
  }

  const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", userId).single<Profile>();
  if (error || !profile) {
    redirect("/client/login");
  }

  if (profile.role === "superadmin") {
    redirect("/dashboard");
  }
  if (profile.role !== "hotel_admin") {
    redirect("/client/login");
  }

  const { data: hotelUser } = await supabase.from("hotel_users").select("hotel_id").eq("user_id", userId).maybeSingle();
  if (!hotelUser) {
    // Authenticated, correct role, but not linked to any hotel yet — an
    // incomplete/misconfigured account, not something to guess at (never
    // "pick a hotel for them").
    redirect("/client/login");
  }

  return { userId, profile, hotelId: hotelUser.hotel_id };
}

/**
 * Authorizes EITHER a superadmin (always) OR a hotel_admin linked to this
 * EXACT hotelId — used by every feature module genuinely shared between the
 * back-office and the client portal (partners, photos, and the two chat
 * routes — src/features/rag/chatEndpoint.ts's shared handler, called by
 * both /api/hotels/[id]/chat and /api/client/hotels/[id]/chat — so the same
 * ChatPreview component serves both the admin "Mode test" panel and the
 * client portal's "Tester mon chatbot" without duplicating the RAG call
 * chain). `hotelId` here is always the caller's own resolved id — never a
 * value read from the request body — so a hotel_admin can never probe a
 * different hotel's id through this check.
 *
 * `scope` is REQUIRED and used EXACTLY as given — never inferred, never
 * tried as a fallback against the other scope. A previous version of this
 * function tried the back-office cookie first and fell back to the
 * client-portal one; that meant a shared action's identity depended on
 * which cookie happened to exist first in the caller's browser rather than
 * which space the caller actually came from (e.g. a superadmin with a
 * back-office tab open elsewhere could end up acting under their own
 * identity even when the real caller was a hotel_admin on /client/partners).
 * Every call site now must state its own scope explicitly — see
 * lib/supabase/cookieScope.ts's AuthScope and its own doc comment.
 *
 * Returns the resolved client as `supabase` so callers (e.g.
 * features/partners/actions.ts) reuse it instead of separately calling
 * createClient()/createClientPortalClient(), which would silently diverge
 * from the scope this function was actually given.
 */
export async function requireHotelAccess(
  hotelId: string,
  scope: AuthScope
): Promise<{ userId: string; profile: Profile; supabase: SupabaseClient }> {
  const supabase = scope === "client" ? await createClientPortalClient() : await createClient();
  const loginPath = scope === "client" ? "/client/login" : "/login";

  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;

  if (!userId) {
    redirect(loginPath);
  }

  const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", userId).single<Profile>();
  if (error || !profile) {
    redirect(loginPath);
  }

  if (profile.role === "superadmin") {
    return { userId, profile, supabase };
  }

  if (profile.role === "hotel_admin") {
    const { data: hotelUser } = await supabase
      .from("hotel_users")
      .select("hotel_id")
      .eq("user_id", userId)
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (hotelUser) {
      return { userId, profile, supabase };
    }
  }

  redirect(loginPath);
}
