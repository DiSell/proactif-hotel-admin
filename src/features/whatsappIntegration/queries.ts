import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { getActiveActivationLinkStatus, type ActivationLinkStatus } from "./activationTokenPersistence";
import type { HotelWhatsAppConnection } from "./types";

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

export const getHotelWhatsAppConnection = cache(fetchHotelWhatsAppConnection);

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
