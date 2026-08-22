import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/types/database";

/**
 * Verifies the caller is an authenticated superadmin. Called at the top of
 * every Server Action and every page's data fetch — proxy.ts already gates
 * navigations, but Server Functions can be reached directly, so each one
 * checks for itself too (see Next.js proxy docs: "Always verify
 * authentication and authorization inside each Server Function").
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

  if (error || !profile || profile.role !== "superadmin") {
    redirect("/login");
  }

  return { userId, profile };
}
