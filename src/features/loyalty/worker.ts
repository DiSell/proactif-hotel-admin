import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/sendEmail";
import { currentOrigin } from "@/lib/http/currentOrigin";
import { campaignDeliveryKey, evaluateAtSend, postStayDeliveryKey } from "./processor";
import { generateUnsubscribeToken } from "./unsubscribeToken";

type RowCustomer = { id: string; hotel_id: string; email: string | null; marketing_allowed: boolean; hotel_excluded: boolean; customer_unsubscribed: boolean };
type RowStay = { status: string };
type RowPostStaySettings = {
  enabled: boolean;
  subject: string;
  content: string;
  thank_you_enabled: boolean;
  review_enabled: boolean;
  review_content: string;
  review_url: string | null;
  review_button_label: string;
};

/** Full HTML escaping — every hotelier-controlled string (content, offer text, review text, review button label, and the review URL when placed in an href attribute) goes through this before reaching the email HTML body. */
function escapeForHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Composes the single post-stay email from whichever blocks are currently
 * active — thank-you (subject/content) and/or review request — never both
 * required, but at least one is guaranteed by the DB constraint
 * loyalty_settings_at_least_one_block (0044_loyalty_post_stay_review.sql).
 * The review block is only rendered when review_url is actually present
 * (defense in depth: the DB also requires this whenever review_enabled).
 */
function buildPostStayMessage(settings: RowPostStaySettings): { subject: string; text: string; html: string } {
  const textParts: string[] = [];
  const htmlParts: string[] = [];

  if (settings.thank_you_enabled) {
    textParts.push(settings.content);
    htmlParts.push(`<p>${escapeForHtml(settings.content).replace(/\n/g, "<br>")}</p>`);
  }
  if (settings.review_enabled && settings.review_url) {
    textParts.push(`${settings.review_content}\n${settings.review_button_label} : ${settings.review_url}`);
    htmlParts.push(
      `<p>${escapeForHtml(settings.review_content).replace(/\n/g, "<br>")}</p>` +
        `<p><a href="${escapeForHtml(settings.review_url)}">${escapeForHtml(settings.review_button_label)}</a></p>`
    );
  }

  return { subject: settings.subject, text: textParts.join("\n\n"), html: htmlParts.join("") };
}

/**
 * Every marketing email MUST carry a working unsubscribe link — see
 * unsubscribeToken.ts. Returns null when the secret isn't configured, which
 * reserveAndSend below treats as "cannot legally send this email" rather
 * than sending without one.
 */
async function buildUnsubscribeFooter(customerId: string): Promise<{ text: string; html: string } | null> {
  const token = generateUnsubscribeToken(customerId);
  if (!token) return null;
  const origin = await currentOrigin();
  const url = `${origin}/desinscription?token=${token}`;
  return {
    text: `\n\n---\nPour ne plus recevoir ces emails : ${url}`,
    html: `<p style="margin-top:24px;font-size:11px;color:#888;">Pour ne plus recevoir ces emails, <a href="${url}">cliquez ici</a>.</p>`,
  };
}

export async function reserveAndSend(params: {
  supabase: SupabaseClient;
  hotelId: string;
  customerId: string;
  campaignId?: string;
  stayId?: string;
  type: "marketing" | "post_stay";
  /**
   * Required for "marketing" (campaign subject/content/offer, captured by
   * the caller at selection time — campaigns are untouched by this phase).
   * Ignored for "post_stay": that message is composed from a FRESH
   * loyalty_settings read below, immediately before transport, so it always
   * reflects the current enabled/thank_you_enabled/review_enabled state and
   * current text — never a stale snapshot taken at batch-selection time.
   */
  subject?: string;
  content?: string;
  offerText?: string | null;
}): Promise<{ status: "sent" | "failed" | "skipped" | "duplicate" }> {
  const key = params.type === "marketing" ? campaignDeliveryKey(params.campaignId!, params.customerId) : postStayDeliveryKey(params.stayId!);

  const { data: delivery, error: reserveError } = await params.supabase
    .from("loyalty_deliveries")
    .insert({
      hotel_id: params.hotelId,
      customer_id: params.customerId,
      campaign_id: params.campaignId ?? null,
      stay_id: params.stayId ?? null,
      delivery_type: params.type,
      channel: "email",
      status: "queued",
      idempotency_key: key,
    })
    .select("id")
    .single();
  if (reserveError || !delivery) return { status: "duplicate" };

  // Marks the stay as attempted BEFORE anything else can fail — this is
  // what lets the due-stays query (below) permanently exclude it instead of
  // re-fetching it forever (see 0038_customer_loyalty_stay_tracking.sql).
  // Best-effort: a failure here never blocks the actual send, it would just
  // mean this stay gets needlessly re-scanned (harmless — the idempotency
  // key above already prevents a real re-send).
  if (params.type === "post_stay" && params.stayId) {
    await params.supabase.from("customer_stays").update({ loyalty_delivery_queued_at: new Date().toISOString() }).eq("id", params.stayId).eq("hotel_id", params.hotelId);
  }

  // Mandatory final re-read after reservation, immediately before transport.
  const { data: customer } = await params.supabase
    .from("hotel_customers")
    .select("id,hotel_id,email,marketing_allowed,hotel_excluded,customer_unsubscribed")
    .eq("hotel_id", params.hotelId)
    .eq("id", params.customerId)
    .maybeSingle<RowCustomer>();
  if (!customer) {
    await params.supabase.from("loyalty_deliveries").update({ status: "skipped", safe_error: "customer_not_found" }).eq("id", delivery.id).eq("hotel_id", params.hotelId);
    return { status: "skipped" };
  }

  const eligibility = evaluateAtSend(
    {
      hotelId: customer.hotel_id,
      customerId: customer.id,
      email: customer.email,
      marketingAllowed: customer.marketing_allowed,
      hotelExcluded: customer.hotel_excluded,
      customerUnsubscribed: customer.customer_unsubscribed,
    },
    params.type
  );
  if (!eligibility.eligible) {
    await params.supabase.from("loyalty_deliveries").update({ status: "skipped", safe_error: eligibility.reason }).eq("id", delivery.id).eq("hotel_id", params.hotelId);
    return { status: "skipped" };
  }

  // A marketing email can never go out without a working unsubscribe link —
  // see buildUnsubscribeFooter's own doc comment. post_stay is a service
  // message, not marketing (see eligibility.ts), so it carries no footer.
  let footer: { text: string; html: string } | null = null;
  if (params.type === "marketing") {
    footer = await buildUnsubscribeFooter(params.customerId);
    if (!footer) {
      await params.supabase.from("loyalty_deliveries").update({ status: "failed", safe_error: "unsubscribe_link_unavailable" }).eq("id", delivery.id).eq("hotel_id", params.hotelId);
      return { status: "failed" };
    }
  }

  let subject: string;
  let text: string;
  let html: string;

  if (params.type === "post_stay") {
    // Revalidate immediately before transport: a stay that got cancelled,
    // or settings that got disabled (either the whole feature or every
    // remaining block), between batch-selection and this exact moment must
    // never produce a stale send.
    //
    // Unlike the two permanent skips above (customer_not_found / a real
    // customer-level ineligibility — customer_unsubscribed, hotel_excluded:
    // stable facts about the CUSTOMER, correctly excluded forever by
    // 0038_customer_loyalty_stay_tracking.sql's queued_at mechanism), "not
    // due right now" is a fact about the STAY/SETTINGS at this instant, not
    // about the customer — it can very plausibly become true again later
    // (the stay gets corrected back to completed, the setting gets
    // re-enabled). Finalizing it as a terminal "skipped" row would consume
    // the one-per-stay idempotency key AND leave loyalty_delivery_queued_at
    // set forever, permanently excluding a stay that never actually had a
    // message composed or sent for it. So this branch instead UNDOES the
    // reservation it just made — deletes the delivery row, clears
    // loyalty_delivery_queued_at — freeing the stay for a future cron run
    // to pick back up and genuinely retry exactly once, never twice (the
    // idempotency key still fully protects against a real double-send: only
    // one reservation can ever be "live" for a given stay at a time, and
    // this cleanup only ever runs for the one instance that actually held
    // it). Best-effort, same as the original queued_at marking above: a
    // failure here just means one extra harmless re-scan next run, not a
    // duplicate send.
    const [{ data: stay }, { data: settings }] = await Promise.all([
      params.supabase.from("customer_stays").select("status").eq("id", params.stayId!).eq("hotel_id", params.hotelId).maybeSingle<RowStay>(),
      params.supabase.from("loyalty_settings").select("*").eq("hotel_id", params.hotelId).maybeSingle<RowPostStaySettings>(),
    ]);
    if (!stay || stay.status !== "completed" || !settings || !settings.enabled || !(settings.thank_you_enabled || settings.review_enabled)) {
      await Promise.all([
        params.supabase.from("loyalty_deliveries").delete().eq("id", delivery.id).eq("hotel_id", params.hotelId),
        params.supabase.from("customer_stays").update({ loyalty_delivery_queued_at: null }).eq("id", params.stayId!).eq("hotel_id", params.hotelId),
      ]);
      return { status: "skipped" };
    }
    const message = buildPostStayMessage(settings);
    subject = message.subject;
    text = message.text;
    html = message.html;
  } else {
    subject = params.subject!;
    text = [params.offerText ? `${params.content}\n\n${params.offerText}` : params.content, footer?.text ?? ""].join("");
    html = [
      `<p>${escapeForHtml(params.content!).replace(/\n/g, "<br>")}</p>`,
      params.offerText ? `<p><strong>${escapeForHtml(params.offerText)}</strong></p>` : "",
      footer?.html ?? "",
    ].join("");
  }

  await params.supabase.from("loyalty_deliveries").update({ status: "sending", attempted_at: new Date().toISOString() }).eq("id", delivery.id).eq("hotel_id", params.hotelId);

  const result = await sendEmail({ to: customer.email!, subject, text, html });

  await params.supabase
    .from("loyalty_deliveries")
    .update(result.ok ? { status: "sent", sent_at: new Date().toISOString(), safe_error: null } : { status: "failed", safe_error: result.error ?? "email_failed" })
    .eq("id", delivery.id)
    .eq("hotel_id", params.hotelId);

  return { status: result.ok ? "sent" : "failed" };
}

export async function runLoyaltyJobs(supabase: SupabaseClient, now = new Date()) {
  let processed = 0;
  let sent = 0;
  let skipped = 0;

  const { data: campaigns } = await supabase.from("loyalty_campaigns").select("*").eq("status", "scheduled").lte("scheduled_at", now.toISOString()).limit(50);
  for (const campaign of campaigns ?? []) {
    await supabase.from("loyalty_campaigns").update({ status: "sending" }).eq("id", campaign.id).eq("hotel_id", campaign.hotel_id).eq("status", "scheduled");

    let query = supabase.from("hotel_customers").select("id").eq("hotel_id", campaign.hotel_id);
    if (campaign.audience_type === "targeted") {
      const { data: selected } = await supabase.from("loyalty_campaign_customers").select("customer_id").eq("hotel_id", campaign.hotel_id).eq("campaign_id", campaign.id);
      query = query.in("id", (selected ?? []).map((row) => row.customer_id));
    }
    const { data: customers } = await query;

    for (const customer of customers ?? []) {
      const result = await reserveAndSend({
        supabase,
        hotelId: campaign.hotel_id,
        customerId: customer.id,
        campaignId: campaign.id,
        type: "marketing",
        subject: campaign.subject,
        content: campaign.content,
        offerText: campaign.offer_text,
      });
      processed += 1;
      if (result.status === "sent") sent += 1;
      if (result.status === "skipped") skipped += 1;
    }

    await supabase.from("loyalty_campaigns").update({ status: "sent" }).eq("id", campaign.id).eq("hotel_id", campaign.hotel_id);
  }

  const { data: settings } = await supabase.from("loyalty_settings").select("*").eq("enabled", true);
  for (const setting of settings ?? []) {
    const cutoff = new Date(now.getTime() - setting.delay_days * 86_400_000).toISOString().slice(0, 10);
    // Oldest-due-first (ascending check_out) and excludes any stay already
    // attempted (loyalty_delivery_queued_at is null) — see
    // 0038_customer_loyalty_stay_tracking.sql's own doc comment: without
    // both of these, a backlog of already-handled stays past the cutoff
    // could keep consuming this query's row cap forever, starving stays
    // that just became due.
    const { data: stays } = await supabase
      .from("customer_stays")
      .select("id,customer_id")
      .eq("hotel_id", setting.hotel_id)
      .eq("status", "completed")
      .is("loyalty_delivery_queued_at", null)
      .lte("check_out", cutoff)
      .order("check_out", { ascending: true })
      .limit(200);

    for (const stay of stays ?? []) {
      // subject/content (and the review block) are deliberately NOT passed
      // here — reserveAndSend re-reads loyalty_settings itself, right
      // before transport, so the message always reflects the current
      // config rather than this snapshot taken at batch-selection time.
      const result = await reserveAndSend({
        supabase,
        hotelId: setting.hotel_id,
        customerId: stay.customer_id,
        stayId: stay.id,
        type: "post_stay",
      });
      processed += 1;
      if (result.status === "sent") sent += 1;
      if (result.status === "skipped") skipped += 1;
    }
  }

  return { processed, sent, skipped };
}
