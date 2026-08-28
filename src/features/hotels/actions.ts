"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { generateWidgetKey, slugify } from "@/lib/widgetKey";
import { createHotelSchema, updateHotelInfoSchema } from "./schema";
import { hostBookingTriggerSchema } from "./hostBookingTrigger";
import type { BookingActionMode, HotelStatus } from "@/types/database";
import type { ActionResult } from "@/lib/actionResult";

async function uniqueSlug(baseName: string): Promise<string> {
  const supabase = await createClient();
  const base = slugify(baseName) || "hotel";
  let candidate = base;
  let suffix = 1;

  // Small tables, small loop — fine without a dedicated SQL uniqueness trick.
  for (;;) {
    const { data } = await supabase.from("hotels").select("id").eq("slug", candidate).maybeSingle();
    if (!data) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

export interface CreateHotelInput {
  name: string;
  website: string;
  logo_url: string | null;
  address: string;
  postal_code: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  primary_color: string;
  secondary_color: string;
  languages: string[];
  default_language: string;
  booking_url: string;
  spa_booking_url: string;
  assistant_enabled: boolean;
  assistant_name: string;
  welcome_message: string;
}

export async function createHotel(input: CreateHotelInput): Promise<ActionResult<{ id: string }>> {
  await requireSuperadmin();

  const parsed = createHotelSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return { ok: false, error: "Certains champs sont invalides.", fieldErrors };
  }

  const supabase = await createClient();
  const slug = await uniqueSlug(parsed.data.name);
  const widget_key = generateWidgetKey();

  const { data, error } = await supabase
    .from("hotels")
    .insert({
      name: parsed.data.name,
      slug,
      widget_key,
      website: parsed.data.website,
      logo_url: input.logo_url,
      address: parsed.data.address || null,
      postal_code: parsed.data.postal_code || null,
      city: parsed.data.city || null,
      country: parsed.data.country || null,
      phone: parsed.data.phone || null,
      email: parsed.data.email || null,
      primary_color: parsed.data.primary_color,
      secondary_color: parsed.data.secondary_color,
      languages: parsed.data.languages,
      default_language: parsed.data.default_language,
      booking_url: parsed.data.booking_url || null,
      spa_booking_url: parsed.data.spa_booking_url || null,
      assistant_enabled: parsed.data.assistant_enabled,
      assistant_name: parsed.data.assistant_name,
      status: "draft",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("createHotel: supabase insert failed", { message: error?.message });
    return { ok: false, error: "Impossible de créer l’établissement pour le moment." };
  }

  // Seed chatbot_settings with the welcome message collected in step 4 —
  // the rest of the guided settings keep their column defaults.
  const { error: settingsError } = await supabase
    .from("chatbot_settings")
    .insert({ hotel_id: data.id, welcome_message: parsed.data.welcome_message });

  if (settingsError) {
    console.error("createHotel: chatbot_settings insert failed", { message: settingsError.message });
  }

  revalidatePath("/etablissements");
  return { ok: true, data: { id: data.id } };
}

export interface UpdateHotelInfoInput {
  name: string;
  website: string;
  address: string;
  postal_code: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  primary_color: string;
  secondary_color: string;
  booking_url: string;
  spa_booking_url: string;
  booking_action_mode: BookingActionMode;
  /** Flat form field — only meaningful when booking_action_mode === "host_widget". Assembled into {strategy:"click", selector} below, never stored as-is. */
  host_booking_selector: string;
}

export async function updateHotelInfo(id: string, input: UpdateHotelInfoInput): Promise<ActionResult<null>> {
  await requireSuperadmin();

  const parsed = updateHotelInfoSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return { ok: false, error: "Certains champs sont invalides.", fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("hotels")
    .update({
      name: parsed.data.name,
      website: parsed.data.website,
      address: parsed.data.address || null,
      postal_code: parsed.data.postal_code || null,
      city: parsed.data.city || null,
      country: parsed.data.country || null,
      phone: parsed.data.phone || null,
      email: parsed.data.email || null,
      primary_color: parsed.data.primary_color,
      secondary_color: parsed.data.secondary_color,
      booking_url: parsed.data.booking_url || null,
      spa_booking_url: parsed.data.spa_booking_url || null,
      booking_action_mode: parsed.data.booking_action_mode,
      // Re-validated here (not just trusted because the Zod form schema
      // already checked host_booking_selector's length) — this is the
      // actual write to hosts.host_booking_trigger, and the ONLY place
      // that ever assembles the {strategy, selector} shape from a raw
      // string. null whenever mode isn't "host_widget", so switching back
      // to "url" cleanly clears any stale selector instead of leaving it
      // dormant in the row.
      host_booking_trigger:
        parsed.data.booking_action_mode === "host_widget"
          ? hostBookingTriggerSchema.parse({ strategy: "click", selector: parsed.data.host_booking_selector })
          : null,
    })
    .eq("id", id);

  if (error) {
    console.error("updateHotelInfo: supabase update failed", { message: error.message });
    return { ok: false, error: "Impossible d’enregistrer les modifications." };
  }

  revalidatePath(`/etablissements/${id}`);
  revalidatePath("/etablissements");
  return { ok: true, data: null };
}

export async function setHotelStatus(id: string, status: HotelStatus): Promise<ActionResult<null>> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { error } = await supabase.from("hotels").update({ status }).eq("id", id);

  if (error) {
    console.error("setHotelStatus: supabase update failed", { message: error.message });
    return { ok: false, error: "Impossible de changer le statut." };
  }

  revalidatePath(`/etablissements/${id}`);
  revalidatePath("/etablissements");
  return { ok: true, data: null };
}

// Postgres FK violation ("foreign_key_violation") — PostgREST/supabase-js
// surface the real Postgres SQLSTATE on error.code, not a synthesized one.
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Permanently deletes a hotel and everything that CASCADEs from it
 * (chatbot_settings, widget_settings, accommodation_types, conversations,
 * messages, knowledge_sources/knowledge_chunks, hotel_users, hotel_integrations
 * and their reservation tables, etc. — every hotel_id FK in the schema is
 * ON DELETE CASCADE except the two below). A linked hotel_admin account is
 * NOT deleted — only its hotel_users row cascades away, leaving the same
 * "authenticated but unlinked" state as revokeHotelClientAccess
 * (features/hotelUsers/actions.ts) — the account itself is untouched.
 *
 * Uses the session-bound client, not the admin client — `authenticated`
 * already holds full CRUD on public.hotels (0001_init.sql) and the
 * "superadmin full access" RLS policy already covers DELETE via `for all`;
 * no new grant or policy was needed for this to work.
 *
 * site_analysis_consents.hotel_id and reservation_audit_log.hotel_id are
 * deliberately ON DELETE RESTRICT (see those tables' own migration
 * comments, 0003_site_analysis_consent.sql / 0005_integrations_reservations.sql)
 * — both are permanent audit trails the schema was explicitly designed to
 * never let a hotel deletion silently erase. A hotel with any such history
 * therefore CANNOT be deleted; Postgres reports SQLSTATE 23503
 * (foreign_key_violation), translated below into a clear, specific message
 * instead of a generic failure — deactivating the hotel (setHotelStatus)
 * is the correct alternative in that case, not a workaround here.
 */
export async function deleteHotel(id: string): Promise<ActionResult<null>> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { error } = await supabase.from("hotels").delete().eq("id", id);

  if (error) {
    if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
      return {
        ok: false,
        error:
          "Impossible de supprimer cet établissement : il possède un historique (consentements d'analyse de site et/ou réservations) qui doit être conservé. Désactivez-le plutôt.",
      };
    }
    console.error("deleteHotel: supabase delete failed", { message: error.message });
    return { ok: false, error: "Impossible de supprimer cet établissement pour le moment." };
  }

  revalidatePath("/etablissements");
  return { ok: true, data: null };
}
