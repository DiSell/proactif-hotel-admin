import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import type { Hotel } from "@/types/database";

// Plain server-only reads (no "use server" — only Server Actions invoked
// from Client Components need that directive, and it would block wrapping
// these in React's cache()).

export async function listHotels(): Promise<Hotel[]> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { data, error } = await supabase.from("hotels").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function fetchHotel(id: string): Promise<Hotel | null> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { data, error } = await supabase.from("hotels").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Deduped per request: layout.tsx and page.tsx both call this for the same
// hotel id without triggering two round-trips.
export const getHotel = cache(fetchHotel);
