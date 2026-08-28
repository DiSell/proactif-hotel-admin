"use server";

import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { revalidatePath } from "next/cache";
import { requireHotelAccess } from "@/lib/auth/session";
import { safeFetch } from "@/features/crawler/networkGuard";
import { extractPage } from "@/features/crawler/extract";
import { getOpenAIClient } from "@/lib/openai/client";
import { openaiChatModel } from "@/lib/openai/env";
import { hotelPartnerSchema, httpUrlSchema, type HotelPartnerInput } from "./schema";
import { generateConsentToken } from "./consentToken";
import { currentOrigin } from "@/lib/http/currentOrigin";
import { sendEmail } from "@/lib/email/sendEmail";
import { partnerConsentTemplate } from "@/lib/email/templates/partnerConsent";
import type { AuthScope } from "@/lib/supabase/cookieScope";
import type { ActionResult } from "@/lib/actionResult";

/**
 * Every action here is guarded by requireHotelAccess(hotelId, scope) — the
 * SAME check the chat routes and the photo-selection actions already use —
 * which authorizes EITHER a superadmin (any hotel, scope "backoffice") OR
 * the hotel_admin linked to this exact hotel (scope "client").
 *
 * `scope` is NEVER a parameter on any exported Server Action below — a
 * client component (PartnersManager.tsx/PartnerFormModal.tsx) must never be
 * able to supply or influence which cookie scope a shared action reads,
 * even indirectly via a prop or a tampered request payload. Each `*Internal`
 * function takes `scope` as a plain argument, but is never exported/never
 * `"use server"`-callable on its own; every actually-exported action is a
 * thin wrapper that calls it with a HARDCODED literal — "backoffice" or
 * "client" — baked in at the export itself, not received from any caller.
 * PartnersManager.tsx/PartnerFormModal.tsx receive the whole bundle of
 * either the *Backoffice or the *Client actions as a prop (never a `scope`
 * string) from whichever page rendered them, and simply invoke whichever
 * function reference they were given — they never decide or transmit scope
 * themselves.
 *
 * Writes through the SESSION-BOUND client returned by requireHotelAccess()
 * itself, not service_role — deliberately different from
 * features/photos/actions.ts: RLS (0015_hotel_partners.sql) is the real
 * gate for this table, a hotel_admin's own session-bound client already has
 * exactly the right INSERT/UPDATE/DELETE policies scoped to
 * is_hotel_admin_for(hotel_id), and a partner is a small CRUD resource with
 * no external side effect (no storage upload, no third-party fetch) — no
 * reason to route it through service_role instead. Reusing requireHotelAccess's
 * own client (rather than calling lib/supabase/server's createClient()
 * separately here) matters because back-office and the client portal use
 * different session cookies (lib/supabase/cookieScope.ts) — a second,
 * independently-created client would always be back-office-scoped, even
 * when the caller authenticated as a client-portal session.
 */

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[String(issue.path[0])] = issue.message;
  return errors;
}

function revalidatePartnerPaths(hotelId: string) {
  revalidatePath("/client/partners");
  revalidatePath(`/etablissements/${hotelId}/partenaires`);
}

function toRow(input: HotelPartnerInput) {
  return {
    name: input.name,
    category: input.category,
    description: input.description || null,
    address: input.address || null,
    phone: input.phone || null,
    // Already normalized/validated E.164 or null by hotelPartnerSchema's own
    // transform — never re-normalized or trusted-as-is beyond what the
    // schema already guaranteed.
    request_phone_e164: input.request_phone_e164,
    opening_hours: input.opening_hours || null,
    email: input.email || null,
    website_url: input.website_url || null,
    booking_url: input.booking_url || null,
    is_active: input.is_active,
    priority: input.priority,
  };
}

async function createHotelPartnerInternal(
  hotelId: string,
  input: HotelPartnerInput,
  scope: AuthScope
): Promise<ActionResult<{ id: string }>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const parsed = hotelPartnerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  const { data, error } = await supabase
    .from("hotel_partners")
    .insert({ hotel_id: hotelId, ...toRow(parsed.data) })
    .select("id")
    .single();

  if (error || !data) {
    console.error("createHotelPartner: insert failed", { message: error?.message });
    return { ok: false, error: "Impossible de créer ce partenaire." };
  }

  revalidatePartnerPaths(hotelId);
  return { ok: true, data: { id: data.id } };
}

export async function createHotelPartnerBackoffice(hotelId: string, input: HotelPartnerInput): Promise<ActionResult<{ id: string }>> {
  return createHotelPartnerInternal(hotelId, input, "backoffice");
}

export async function createHotelPartnerClient(hotelId: string, input: HotelPartnerInput): Promise<ActionResult<{ id: string }>> {
  return createHotelPartnerInternal(hotelId, input, "client");
}

async function updateHotelPartnerInternal(
  hotelId: string,
  partnerId: string,
  input: HotelPartnerInput,
  scope: AuthScope
): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const parsed = hotelPartnerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  const { error } = await supabase.from("hotel_partners").update(toRow(parsed.data)).eq("id", partnerId).eq("hotel_id", hotelId);
  if (error) {
    console.error("updateHotelPartner: update failed", { message: error.message });
    return { ok: false, error: "Impossible de modifier ce partenaire." };
  }

  revalidatePartnerPaths(hotelId);
  return { ok: true, data: null };
}

export async function updateHotelPartnerBackoffice(hotelId: string, partnerId: string, input: HotelPartnerInput): Promise<ActionResult<null>> {
  return updateHotelPartnerInternal(hotelId, partnerId, input, "backoffice");
}

export async function updateHotelPartnerClient(hotelId: string, partnerId: string, input: HotelPartnerInput): Promise<ActionResult<null>> {
  return updateHotelPartnerInternal(hotelId, partnerId, input, "client");
}

/** The "[Activer]/[Désactiver]" row action — a narrower write than updateHotelPartner, never touches any other field. */
async function setHotelPartnerActiveInternal(
  hotelId: string,
  partnerId: string,
  isActive: boolean,
  scope: AuthScope
): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const { error } = await supabase.from("hotel_partners").update({ is_active: isActive }).eq("id", partnerId).eq("hotel_id", hotelId);
  if (error) {
    console.error("setHotelPartnerActive: update failed", { message: error.message });
    return { ok: false, error: "Impossible de mettre à jour ce partenaire." };
  }

  revalidatePartnerPaths(hotelId);
  return { ok: true, data: null };
}

export async function setHotelPartnerActiveBackoffice(hotelId: string, partnerId: string, isActive: boolean): Promise<ActionResult<null>> {
  return setHotelPartnerActiveInternal(hotelId, partnerId, isActive, "backoffice");
}

export async function setHotelPartnerActiveClient(hotelId: string, partnerId: string, isActive: boolean): Promise<ActionResult<null>> {
  return setHotelPartnerActiveInternal(hotelId, partnerId, isActive, "client");
}

async function deleteHotelPartnerInternal(hotelId: string, partnerId: string, scope: AuthScope): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const { error } = await supabase.from("hotel_partners").delete().eq("id", partnerId).eq("hotel_id", hotelId);
  if (error) {
    // 23503 = foreign key violation: partner_requests_partner_fk
    // (0020_partner_requests.sql) has no ON DELETE clause on purpose — a
    // partner with existing requests must never be physically deletable,
    // preserving partner_requests' history/name resolution. No pre-check
    // SELECT COUNT here: the FK is already the single source of truth, and
    // a pre-check would only add a race condition, never remove one.
    console.error("deleteHotelPartner: delete failed", { code: error.code, message: error.message });
    if (error.code === "23503") {
      return { ok: false, error: "Ce partenaire possède des demandes enregistrées et ne peut pas être supprimé. Désactivez-le à la place." };
    }
    return { ok: false, error: "Impossible de supprimer ce partenaire." };
  }

  revalidatePartnerPaths(hotelId);
  return { ok: true, data: null };
}

export async function deleteHotelPartnerBackoffice(hotelId: string, partnerId: string): Promise<ActionResult<null>> {
  return deleteHotelPartnerInternal(hotelId, partnerId, "backoffice");
}

export async function deleteHotelPartnerClient(hotelId: string, partnerId: string): Promise<ActionResult<null>> {
  return deleteHotelPartnerInternal(hotelId, partnerId, "client");
}

// Bounds how much extracted page text is sent to the model — a short
// description doesn't need the whole page, and this keeps token cost/
// latency predictable regardless of how large the fetched site is.
const MAX_SUMMARY_SOURCE_CHARS = 6000;
const MAX_GENERATED_DESCRIPTION_CHARS = 500; // matches hotelPartnerSchema's own description limit headroom
const MAX_GENERATED_OPENING_HOURS_CHARS = 300; // matches hotelPartnerSchema's own opening_hours limit
const MAX_GENERATED_ADDRESS_CHARS = 300; // matches hotelPartnerSchema's own address limit

const SUMMARY_INSTRUCTIONS = [
  "Tu extrais trois informations factuelles d'un partenaire local (restaurant, activité, commerce...) à partir du texte extrait de son site web, pour aider un hôtel à le présenter à ses visiteurs : une description, son adresse, et ses horaires d'ouverture, s'ils sont indiqués.",
  "Règles strictes pour la description :",
  "- 1 à 2 phrases maximum, en français, ton neutre et informatif.",
  "- N'invente RIEN qui ne soit pas présent dans le texte fourni : pas d'horaires, de prix, de note/avis, ou d'affirmation qui ne s'y trouve pas explicitement.",
  "- Pas de superlatif marketing non justifié par le texte (\"le meilleur\", \"incontournable\", \"unique\"...).",
  "Règles strictes pour l'adresse :",
  "- Renvoie l'adresse postale SEULEMENT si elle est explicitement écrite dans le texte fourni, telle quelle.",
  "- Si aucune adresse n'apparaît explicitement, renvoie null pour ce champ — ne devine JAMAIS une ville ou une adresse à partir du nom, du domaine, ou de toute autre indication indirecte.",
  "Règles strictes pour les horaires d'ouverture :",
  "- Renvoie les horaires SEULEMENT s'ils sont explicitement écrits dans le texte fourni, sous une forme brève et lisible (ex: \"Lun-Sam 12h-14h, 19h-22h\").",
  "- Si aucun horaire n'apparaît explicitement dans le texte, renvoie null pour ce champ — ne devine JAMAIS, ne déduis jamais d'horaires probables à partir du type d'établissement.",
].join("\n");

const websiteSummarySchema = z.object({
  description: z.string(),
  address: z.string().nullable(),
  openingHours: z.string().nullable(),
});

/**
 * Fetches a partner's OWN website ONCE, at authoring time, to pre-fill the
 * "Description", "Adresse" and "Horaires" fields of the partner form with a
 * short, factual summary — address/openingHours are null (never guessed)
 * whenever the site's text doesn't explicitly state them. The hotel still
 * reviews/edits all three before saving (createHotelPartner and
 * updateHotelPartner variants are the only things that actually persist
 * them). This is deliberately NOT a live/repeated crawl and NEVER
 * feeds knowledge_sources/knowledge_chunks or any RAG retrieval path — see
 * hotel_partners' own "never pollute the RAG with partners" discipline
 * (0015_hotel_partners.sql, features/rag/partners.ts). The chatbot itself
 * still only ever sees whatever description ends up saved on the row,
 * exactly as before this function existed.
 *
 * Reuses the exact same SSRF-safe fetch (safeFetch — protocol check, DNS/IP
 * allowlist, redirect re-validation, size + timeout caps) and HTML
 * extraction (extractPage) the site-analysis crawler already uses — no new
 * fetch/parsing logic invented for this. Unlike the crawler, this is a
 * SINGLE arbitrary URL (a partner's site, not the hotel's own domain), so
 * there's no same-domain/consent flow to apply here — those are specific
 * to importing content into the hotel's own knowledge base.
 */
async function fetchPartnerWebsiteSummaryInternal(
  hotelId: string,
  url: string,
  scope: AuthScope
): Promise<ActionResult<{ description: string; address: string | null; openingHours: string | null }>> {
  await requireHotelAccess(hotelId, scope);

  const parsedUrl = httpUrlSchema.safeParse(url);
  if (!parsedUrl.success) {
    return { ok: false, error: "Entrez une URL valide (http:// ou https://) avant de générer une description." };
  }

  const fetchResult = await safeFetch(parsedUrl.data);
  if (!fetchResult.ok || !fetchResult.body || !fetchResult.finalUrl) {
    console.error("fetchPartnerWebsiteSummary: safeFetch failed", { errorReason: fetchResult.errorReason });
    return { ok: false, error: "Impossible d'accéder à ce site pour le moment." };
  }

  const extracted = extractPage(fetchResult.body, fetchResult.finalUrl, ["fr"]);
  const sourceText = [extracted.title, extracted.metaDescription, extracted.text]
    .filter(Boolean)
    .join("\n\n")
    .trim()
    .slice(0, MAX_SUMMARY_SOURCE_CHARS);

  if (sourceText.length < 40) {
    return {
      ok: false,
      error: extracted.likelyJsRendered
        ? "Ce site nécessite JavaScript pour afficher son contenu — impossible d'en extraire une description automatiquement. Rédigez-la manuellement."
        : "Ce site ne contient pas assez de texte pour générer une description automatiquement.",
    };
  }

  try {
    const client = getOpenAIClient();
    const response = await client.responses.parse({
      model: openaiChatModel(),
      instructions: SUMMARY_INSTRUCTIONS,
      input: sourceText,
      text: { format: zodTextFormat(websiteSummarySchema, "partner_summary") },
    });

    if (!response.output_parsed) {
      return { ok: false, error: "Impossible de générer une description pour le moment." };
    }

    const description = response.output_parsed.description?.trim();
    if (!description) {
      return { ok: false, error: "Impossible de générer une description pour le moment." };
    }
    const address = response.output_parsed.address?.trim() || null;
    const openingHours = response.output_parsed.openingHours?.trim() || null;

    return {
      ok: true,
      data: {
        description: description.slice(0, MAX_GENERATED_DESCRIPTION_CHARS),
        address: address ? address.slice(0, MAX_GENERATED_ADDRESS_CHARS) : null,
        openingHours: openingHours ? openingHours.slice(0, MAX_GENERATED_OPENING_HOURS_CHARS) : null,
      },
    };
  } catch (err) {
    console.error("fetchPartnerWebsiteSummary: OpenAI call failed", { message: (err as Error).message });
    return { ok: false, error: "Impossible de générer une description pour le moment." };
  }
}

export async function fetchPartnerWebsiteSummaryBackoffice(
  hotelId: string,
  url: string
): Promise<ActionResult<{ description: string; address: string | null; openingHours: string | null }>> {
  return fetchPartnerWebsiteSummaryInternal(hotelId, url, "backoffice");
}

export async function fetchPartnerWebsiteSummaryClient(
  hotelId: string,
  url: string
): Promise<ActionResult<{ description: string; address: string | null; openingHours: string | null }>> {
  return fetchPartnerWebsiteSummaryInternal(hotelId, url, "client");
}

/**
 * Sends (or re-sends) the SINGLE partner consent email, covering BOTH
 * independent authorizations at once:
 *   - hotel_partners.consent_status (chatbot recommendation, 0017)
 *   - hotel_partners.whatsapp_consent_status (transactional WhatsApp, 0022)
 *
 * ONE token, ONE email, ONE link — never two separate emails from two
 * separate send actions. This is achieved WITHOUT merging the two statuses
 * and WITHOUT any new column/migration: a single cryptographically random
 * token is generated, and its hash is written into WHICHEVER of the two
 * existing, independent hash columns (consent_token_hash /
 * whatsapp_consent_token_hash) belongs to a consent that is actually
 * ELIGIBLE for a (re)request right now (see isRecommendationEligible/
 * isWhatsappEligible below). The public page
 * (src/app/partenaires/consentement/page.tsx) then resolves either column
 * against the SAME token — see consentLookup.ts::getPartnerConsentRequests
 * — and renders two fully independent Accept/Decline blocks, each scoped
 * server-side by its OWN column, so accepting/declining one can never
 * touch the other's status even though they share the same emailed link.
 *
 * ELIGIBILITY RULE (documented here since this task defines it explicitly):
 *   - a consent already "accepted" is NEVER re-requested/overwritten by
 *     this action — accepting is a one-way door from the partner's own
 *     click, never silently reset by the hotel asking again.
 *   - "not_requested", "pending", and "declined" are ALL eligible for a
 *     (re)request — in particular a "declined" partner CAN be asked again
 *     later (e.g. after a phone conversation), but this action itself
 *     never flips a status to "accepted" — only the partner's own click on
 *     the public page ever does that (see consentActions.ts).
 *   - the WhatsApp consent additionally requires request_phone_e164 to be
 *     set (nothing to route a future request to otherwise) — a missing
 *     number simply makes that ONE consent ineligible, it never blocks the
 *     recommendation consent from being (re)requested in the same email.
 *   - if NEITHER consent is eligible, nothing is sent at all (no email, no
 *     token, no DB write) and a clear error is returned.
 *
 * Manually triggered only (a single button in PartnerFormModal) — never
 * automatic on create/update, per explicit product decision, unchanged
 * from the previous two-button design.
 *
 * The token itself (plaintext) exists ONLY inside the built consentUrl, for
 * the duration of this one function call — never logged, never returned to
 * the caller, never stored (only its SHA-256 hash is written, via
 * generateConsentToken() — see consentToken.ts). The DB write only happens
 * AFTER the email send succeeds, same ordering as before the merge — a
 * failed send never leaves a dangling pending status/token hash behind.
 */
async function requestPartnerConsentsInternal(hotelId: string, partnerId: string, scope: AuthScope): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const { data: partner, error: partnerError } = await supabase
    .from("hotel_partners")
    .select("name, email, request_phone_e164, consent_status, whatsapp_consent_status")
    .eq("id", partnerId)
    .eq("hotel_id", hotelId)
    .maybeSingle<{
      name: string;
      email: string | null;
      request_phone_e164: string | null;
      consent_status: string;
      whatsapp_consent_status: string;
    }>();
  if (partnerError || !partner) {
    console.error("requestPartnerConsents: partner lookup failed", { message: partnerError?.message });
    return { ok: false, error: "Partenaire introuvable." };
  }
  if (!partner.email) {
    return { ok: false, error: "Renseignez d'abord l'email du partenaire avant d'envoyer une demande de consentement." };
  }

  const isRecommendationEligible = partner.consent_status !== "accepted";
  const isWhatsappEligible = Boolean(partner.request_phone_e164) && partner.whatsapp_consent_status !== "accepted";
  if (!isRecommendationEligible && !isWhatsappEligible) {
    return { ok: false, error: "Les deux autorisations de ce partenaire sont déjà accordées." };
  }

  const { data: hotel, error: hotelError } = await supabase.from("hotels").select("name").eq("id", hotelId).maybeSingle<{ name: string }>();
  if (hotelError || !hotel) {
    console.error("requestPartnerConsents: hotel lookup failed", { message: hotelError?.message });
    return { ok: false, error: "Impossible de récupérer les informations de l'établissement." };
  }

  const { token, tokenHash } = generateConsentToken();
  const origin = await currentOrigin();
  const consentUrl = `${origin}/partenaires/consentement?token=${encodeURIComponent(token)}`;
  const template = partnerConsentTemplate({ hotelName: hotel.name, partnerName: partner.name, consentUrl });

  const emailResult = await sendEmail({ to: partner.email, subject: template.subject, html: template.html, text: template.text });
  if (!emailResult.ok) {
    console.error("requestPartnerConsents: sendEmail failed", { message: emailResult.error });
    return { ok: false, error: "Impossible d'envoyer l'email pour le moment." };
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("hotel_partners")
    .update({
      ...(isRecommendationEligible ? { consent_status: "pending", consent_token_hash: tokenHash, consent_requested_at: now } : null),
      ...(isWhatsappEligible
        ? { whatsapp_consent_status: "pending", whatsapp_consent_token_hash: tokenHash, whatsapp_consent_requested_at: now }
        : null),
    })
    .eq("id", partnerId)
    .eq("hotel_id", hotelId);
  if (updateError) {
    console.error("requestPartnerConsents: update failed", { message: updateError.message });
    return { ok: false, error: "L'email a été envoyé mais le statut n'a pas pu être mis à jour. Réessayez." };
  }

  revalidatePartnerPaths(hotelId);
  return { ok: true, data: null };
}

export async function requestPartnerConsentsBackoffice(hotelId: string, partnerId: string): Promise<ActionResult<null>> {
  return requestPartnerConsentsInternal(hotelId, partnerId, "backoffice");
}

export async function requestPartnerConsentsClient(hotelId: string, partnerId: string): Promise<ActionResult<null>> {
  return requestPartnerConsentsInternal(hotelId, partnerId, "client");
}
