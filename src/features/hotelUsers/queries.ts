import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSuperadmin } from "@/lib/auth/session";

export type HotelUserStatus = "pending" | "active";

export interface HotelUserWithProfile {
  id: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  createdAt: string;
  /**
   * "pending" = invited but never confirmed their email/set a password yet
   * (auth.users.email_confirmed_at is still null) — surfaced in
   * InviteClientForm.tsx as a persistent "Invitation envoyée" badge, so a
   * superadmin can tell at a glance (even after a page reload) that an
   * invite already went out for this person, instead of relying on a toast
   * that disappears. "active" = has confirmed at least once (accepted the
   * invite, or signed in normally).
   */
  status: HotelUserStatus;
}

/**
 * hotel_users.user_id references auth.users(id), NOT public.profiles(id) —
 * there is no FK PostgREST could use to embed profiles automatically in a
 * single `.select("*, profiles(*)")`. Two plain queries, joined in JS, is
 * the correct shape here, not a workaround.
 *
 * status is resolved from auth.users via the Admin API (createAdminClient) —
 * that table (and its confirmation timestamps) isn't reachable through the
 * session-bound client at all, PostgREST never exposes the `auth` schema to
 * `authenticated`. One admin.getUserById call per linked user: hotel_users
 * rows are a handful per hotel in practice, never worth the added
 * complexity of a paginated listUsers() scan for this list size.
 */
export async function listHotelUsers(hotelId: string): Promise<HotelUserWithProfile[]> {
  await requireSuperadmin();
  const supabase = await createClient();

  const { data: links, error: linksError } = await supabase
    .from("hotel_users")
    .select("id, user_id, created_at")
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: true });
  if (linksError) throw new Error(linksError.message);
  if (!links || links.length === 0) return [];

  const userIds = links.map((link) => link.user_id);
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, email, first_name, last_name")
    .in("id", userIds);
  if (profilesError) throw new Error(profilesError.message);

  const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));

  const admin = createAdminClient();
  const statusResults = await Promise.all(
    userIds.map(async (userId) => {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error || !data.user) {
        // Never fails the whole list over one lookup — defaults to "pending"
        // (the safer of the two: never claims "active" without confirmation).
        console.error("listHotelUsers: getUserById failed", { userId, message: error?.message });
        return [userId, "pending" as HotelUserStatus] as const;
      }
      const confirmed = Boolean(data.user.email_confirmed_at ?? data.user.confirmed_at);
      return [userId, (confirmed ? "active" : "pending") as HotelUserStatus] as const;
    })
  );
  const statusByUserId = new Map(statusResults);

  return links.map((link) => {
    const profile = profileById.get(link.user_id);
    return {
      id: link.id,
      userId: link.user_id,
      email: profile?.email ?? "—",
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      createdAt: link.created_at,
      status: statusByUserId.get(link.user_id) ?? "pending",
    };
  });
}
