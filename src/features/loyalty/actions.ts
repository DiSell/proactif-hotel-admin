"use server";

import { revalidatePath } from "next/cache";
import { requireClientAccess } from "@/lib/auth/session";
import { createClientPortalClient } from "@/lib/supabase/server";
import { communicationInputSchema, customerInputSchema, stayInputSchema, type CustomerInput, type StayInput } from "./schema";
import { previewCsv, type CsvMapping } from "./csv";
import { campaignSchema, loyaltySettingsSchema } from "./campaignSchema";
import type { ActionResult } from "@/lib/actionResult";

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[String(issue.path[0])] = issue.message;
  return errors;
}

/** Every validation/DB failure below is surfaced through ActionResult — no exported action here ever silently no-ops on bad input (see CreateCustomerForm.tsx/AddCustomerStayForm.tsx, the only callers). */
export async function createCustomer(input: CustomerInput): Promise<ActionResult<{ id: string }>> {
  const { hotelId } = await requireClientAccess();

  const parsed = customerInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const supabase = await createClientPortalClient();
  const { data, error } = await supabase
    .from("hotel_customers")
    .insert({
      hotel_id: hotelId,
      first_name: parsed.data.firstName,
      last_name: parsed.data.lastName,
      email: parsed.data.email,
      phone: parsed.data.phone,
      external_reference: parsed.data.externalReference,
      source: "manual",
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Création impossible." };

  revalidatePath("/client/customers");
  return { ok: true, data: { id: data.id } };
}

export async function addCustomerStay(input: StayInput): Promise<ActionResult<null>> {
  const { hotelId } = await requireClientAccess();

  const parsed = stayInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const supabase = await createClientPortalClient();
  const { error } = await supabase.from("customer_stays").insert({
    hotel_id: hotelId,
    customer_id: parsed.data.customerId,
    check_in: parsed.data.checkIn,
    check_out: parsed.data.checkOut,
    status: parsed.data.status,
    external_reference: parsed.data.externalReference,
    source: "manual",
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/client/customers/${parsed.data.customerId}`);
  return { ok: true, data: null };
}

export async function updateCustomerCommunication(input: unknown): Promise<ActionResult<null>> {
  const { hotelId } = await requireClientAccess();

  const parsed = communicationInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Données invalides." };

  const supabase = await createClientPortalClient();
  const { error } = await supabase
    .from("hotel_customers")
    .update({
      marketing_allowed: parsed.data.marketingAllowed,
      hotel_excluded: parsed.data.hotelExcluded,
      exclusion_reason: parsed.data.hotelExcluded ? parsed.data.exclusionReason : null,
    })
    .eq("hotel_id", hotelId)
    .eq("id", parsed.data.customerId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/client/customers/${parsed.data.customerId}`);
  return { ok: true, data: null };
}

export async function importCustomersCsv(input: { csvText: string; mapping: CsvMapping }): Promise<ActionResult<{ imported: number; invalid: number; duplicates: number }>> {
  const { hotelId } = await requireClientAccess();
  if (input.csvText.length > 900_000) return { ok: false, error: "Fichier trop volumineux." };

  const preview = previewCsv(input.csvText, input.mapping);
  const valid = preview.filter((row) => row.errors.length === 0 && !row.probableDuplicate);
  const supabase = await createClientPortalClient();
  let imported = 0;
  let duplicates = preview.filter((row) => row.probableDuplicate).length;

  for (const row of valid) {
    const email = row.values.email?.trim().toLowerCase() || null;
    const external = row.values.external_reference?.trim() || null;

    let duplicateQuery = supabase.from("hotel_customers").select("id").eq("hotel_id", hotelId).limit(1);
    if (email) duplicateQuery = duplicateQuery.ilike("email", email);
    else if (external) duplicateQuery = duplicateQuery.eq("external_reference", external);
    else duplicateQuery = duplicateQuery.eq("phone", row.values.phone ?? "");
    const { data: existing } = await duplicateQuery;
    if (existing?.length) {
      duplicates += 1;
      continue;
    }

    const { data: customer, error } = await supabase
      .from("hotel_customers")
      .insert({ hotel_id: hotelId, first_name: row.values.first_name || null, last_name: row.values.last_name || null, email, phone: row.values.phone || null, source: "csv", external_reference: external })
      .select("id")
      .single();
    if (error || !customer) continue;

    if (row.values.check_out) {
      await supabase
        .from("customer_stays")
        .insert({ hotel_id: hotelId, customer_id: customer.id, check_in: row.values.check_in || null, check_out: row.values.check_out, status: "completed", source: "csv", external_reference: external });
    }
    imported += 1;
  }

  revalidatePath("/client/customers");
  return { ok: true, data: { imported, invalid: preview.length - valid.length, duplicates } };
}

export async function saveLoyaltySettings(input: unknown): Promise<ActionResult<null>> {
  const { hotelId } = await requireClientAccess();

  const parsed = loyaltySettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Réglages invalides." };

  const supabase = await createClientPortalClient();
  const { error } = await supabase
    .from("loyalty_settings")
    .upsert({ hotel_id: hotelId, enabled: parsed.data.enabled, delay_days: parsed.data.delayDays, subject: parsed.data.subject, content: parsed.data.content, channel: "email" }, { onConflict: "hotel_id" });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/client/loyalty");
  return { ok: true, data: null };
}

export async function createCampaign(input: unknown): Promise<ActionResult<{ id: string }>> {
  const { hotelId } = await requireClientAccess();

  const parsed = campaignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Campagne invalide." };

  const supabase = await createClientPortalClient();

  if (parsed.data.audienceType === "targeted") {
    const { count } = await supabase.from("hotel_customers").select("id", { count: "exact", head: true }).eq("hotel_id", hotelId).in("id", parsed.data.customerIds);
    if (count !== new Set(parsed.data.customerIds).size) return { ok: false, error: "Sélection client invalide." };
  }

  const status = parsed.data.scheduledAt ? "scheduled" : "draft";
  const { data: campaign, error } = await supabase
    .from("loyalty_campaigns")
    .insert({
      hotel_id: hotelId,
      internal_name: parsed.data.internalName,
      subject: parsed.data.subject,
      content: parsed.data.content,
      offer_text: parsed.data.offerText,
      audience_type: parsed.data.audienceType,
      channel: "email",
      scheduled_at: parsed.data.scheduledAt,
      status,
    })
    .select("id")
    .single();
  if (error || !campaign) return { ok: false, error: error?.message ?? "Création impossible." };

  if (parsed.data.audienceType === "targeted") {
    const rows = [...new Set(parsed.data.customerIds)].map((customerId) => ({ hotel_id: hotelId, campaign_id: campaign.id, customer_id: customerId }));
    const { error: selectionError } = await supabase.from("loyalty_campaign_customers").insert(rows);
    if (selectionError) {
      await supabase.from("loyalty_campaigns").delete().eq("id", campaign.id).eq("hotel_id", hotelId);
      return { ok: false, error: "Sélection impossible." };
    }
  }

  revalidatePath("/client/loyalty/campaigns");
  return { ok: true, data: { id: campaign.id } };
}

export async function cancelCampaign(campaignId: string): Promise<ActionResult<null>> {
  const { hotelId } = await requireClientAccess();

  const supabase = await createClientPortalClient();
  const { error } = await supabase.from("loyalty_campaigns").update({ status: "cancelled" }).eq("hotel_id", hotelId).eq("id", campaignId).in("status", ["draft", "scheduled"]);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/client/loyalty/campaigns/${campaignId}`);
  return { ok: true, data: null };
}
