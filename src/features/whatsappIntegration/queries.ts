import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createClientPortalClient } from "@/lib/supabase/server";
import { requireSuperadmin, requireClientAccess } from "@/lib/auth/session";
import { getActiveActivationLinkStatus, type ActivationLinkStatus } from "./activationTokenPersistence";
import type { HotelWhatsAppConnection } from "./types";

/**
 * Shared query body for both the admin and client-portal reads below —
 * RLS (0024_hotel_whatsapp_connections.sql's own "superadmin can select" /
 * "hotel_admin can select own" policies, keyed off auth.uid() regardless of
 * which cookie scope carried the session) is the real tenant gate; the
 * explicit `.eq("hotel_id", hotelId)` here is defense in depth, not a
 * substitute for it — same discipline as features/photos/queries.ts's own
 * getPhotosManagerData().
 */
async function queryHotelWhatsAppConnection(hotelId: string, supabase: SupabaseClient): Promise<HotelWhatsAppConnection | null> {
  const { data, error } = await supabase
    .from("hotel_whatsapp_connections")
    .select("*")
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<HotelWhatsAppConnection>();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Admin-only read (same precedent as features/widget/queries.ts::getWidgetSettings):
 * this query is only ever called from /etablissements/[id]/whatsapp, never
 * from the client portal (which has no WhatsApp screen at all any more) —
 * requireSuperadmin() alone is the right guard here, matching that exact
 * page's own pattern, rather than the dual-scope requireHotelAccess() used
 * by the WRITE path in actions.ts (which must also serve a hypothetical
 * future hotel_admin caller — this read does not).
 *
 * Returns the most recently created connection for this hotel, if any —
 * deliberately NOT filtered to `status = 'active'` alone, so the admin page
 * can also surface a `pending`/`error`/`revoked` row rather than silently
 * showing "not connected" for a connection that exists but failed.
 */
async function fetchHotelWhatsAppConnection(hotelId: string): Promise<HotelWhatsAppConnection | null> {
  await requireSuperadmin();
  const supabase = await createClient();
  return queryHotelWhatsAppConnection(hotelId, supabase);
}

export const getHotelWhatsAppConnection = cache(fetchHotelWhatsAppConnection);

/**
 * Client-portal read for /client/whatsapp — hotelId comes EXCLUSIVELY from
 * requireClientAccess()'s own session (never a parameter, never anything
 * the browser could influence), and the query runs against
 * createClientPortalClient() so RLS evaluates under that same session's
 * identity — a client authenticated as hotel A's admin can never read hotel
 * B's connection, enforced at the database level (0024's own RLS policies),
 * not merely by this function's own `.eq("hotel_id", ...)`.
 */
async function fetchHotelWhatsAppConnectionForClient(): Promise<HotelWhatsAppConnection | null> {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();
  return queryHotelWhatsAppConnection(hotelId, supabase);
}

export const getHotelWhatsAppConnectionForClient = cache(fetchHotelWhatsAppConnectionForClient);

/**
 * Admin-only read, same requireSuperadmin() guard as
 * getHotelWhatsAppConnection above — never exposes the raw activation
 * token or its hash, only whether a still-usable link currently exists and
 * when it expires (getActiveActivationLinkStatus, activationTokenPersistence.ts).
 */
async function fetchHotelWhatsAppActivationLinkStatus(hotelId: string): Promise<ActivationLinkStatus> {
  await requireSuperadmin();
  return getActiveActivationLinkStatus(hotelId);
}

export const getHotelWhatsAppActivationLinkStatus = cache(fetchHotelWhatsAppActivationLinkStatus);
