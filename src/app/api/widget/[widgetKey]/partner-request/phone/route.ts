// Dedicated endpoint for the widget's structured phone-collection form
// (see features/widget/PublicWidgetChat.tsx and
// features/rag/partnerRequestFlow.ts) — deliberately SEPARATE from
// /api/widget/[widgetKey]/chat: a phone number must never be sent as a
// normal chat message (see that route/answer.ts's own message-persistence
// path), and this endpoint never calls the LLM at all — it only resolves
// the widget, verifies conversation ownership, normalizes the phone, and
// runs the same deterministic RPC sequence answer.ts's free-text path
// already uses (features/rag/partnerRequestFlow.ts:submitStructuredGuestPhone).
// No second chat engine: no model call, no message persistence, same
// underlying create_partner_request/apply_partner_request_command RPCs.
import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { readBoundedBody } from "@/lib/http/readBoundedBody";
import { resolvePublicWidgetContext as resolvePublicWidgetContextImpl } from "@/features/widget/publicHotel";
import { hashSessionToken, sessionTokensMatch, SESSION_TOKEN_PATTERN } from "@/features/widget/sessionToken";
import { normalizeStructuredPhoneInput } from "@/features/partnerRequests/phoneRedaction";
import { submitStructuredGuestPhone as submitStructuredGuestPhoneImpl } from "@/features/rag/partnerRequestFlow";

const MAX_BODY_BYTES = 8 * 1024; // generous for a phone + short pending-request fields, tight enough to bound an oversized payload before Zod ever sees it — see MAX_BODY_BYTES's own reasoning in the chat route.
const MAX_PHONE_INPUT_LENGTH = 40; // well above any real phone field value, short enough to reject an obviously abusive payload before regex work

const GENERIC_ERROR = { error: "Une erreur est survenue. Veuillez réessayer." } as const;
const SERVICE_UNAVAILABLE = { error: "Service temporairement indisponible. Veuillez réessayer dans un instant." } as const;
const INVALID_PHONE_ERROR = { error: "Numéro de téléphone invalide. Merci de vérifier le format (ex. 06 12 34 56 78 ou +33 6 12 34 56 78)." } as const;

// .strict(): this route is public, same discipline as the chat route — an
// unexpected extra field (e.g. an attempted hotelId/guestPhoneE164
// override) fails the whole request rather than being silently dropped.
const phoneRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    sessionToken: z.string().regex(SESSION_TOKEN_PATTERN, "Session invalide."),
    phone: z.string().trim().min(1, "Le numéro est vide.").max(MAX_PHONE_INPUT_LENGTH, "Numéro trop long."),
    // Echoed back verbatim from the phonePrompt the widget was shown (see
    // features/rag/types.ts:PartnerRequestPhonePrompt) — partnerId is
    // revalidated server-side regardless (submitStructuredGuestPhone never
    // trusts it as-is); the other fields are the visitor's own already-typed
    // chat content, not a new trust boundary (see that type's own doc
    // comment).
    pendingRequest: z
      .object({
        partnerId: z.string().uuid(),
        requestedDate: z.string().trim().nullable(),
        requestedTime: z.string().trim().max(50, "Horaire trop long.").nullable(),
        partySize: z.number().int().min(1).nullable(),
        details: z.string().trim().max(2000, "Détails trop longs.").nullable(),
        guestName: z.string().trim().max(200, "Nom trop long.").nullable(),
      })
      .strict(),
  })
  .strict();

export interface PhoneRouteDeps {
  createSupabaseClient: () => SupabaseClient;
  resolveWidgetContext: typeof resolvePublicWidgetContextImpl;
  submitStructuredGuestPhone: typeof submitStructuredGuestPhoneImpl;
}

const defaultDeps: PhoneRouteDeps = {
  createSupabaseClient: createAdminClient,
  resolveWidgetContext: resolvePublicWidgetContextImpl,
  submitStructuredGuestPhone: submitStructuredGuestPhoneImpl,
};

export function createPhoneHandler(deps: PhoneRouteDeps = defaultDeps) {
  return async function POST(request: Request, context: RouteContext<"/api/widget/[widgetKey]/partner-request/phone">) {
    const { widgetKey } = await context.params;

    let supabase: SupabaseClient;
    try {
      supabase = deps.createSupabaseClient();
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/partner-request/phone: failed to create Supabase client", { message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }

    let widgetContext;
    try {
      widgetContext = await deps.resolveWidgetContext(widgetKey, supabase);
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/partner-request/phone: failed to resolve widget", { message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }
    if (!widgetContext) {
      return NextResponse.json({ error: "Widget introuvable." }, { status: 404 });
    }
    const hotelId = widgetContext.hotelId;

    const bodyResult = await readBoundedBody(request, MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      return NextResponse.json({ error: "Requête trop volumineuse." }, { status: 413 });
    }

    let json: unknown;
    try {
      json = bodyResult.text.length > 0 ? JSON.parse(bodyResult.text) : null;
    } catch {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }

    const parsed = phoneRequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }
    const { conversationId, sessionToken, phone, pendingRequest } = parsed.data;
    const sessionTokenHash = hashSessionToken(sessionToken);

    // conversationId is NEVER proof of possession on its own — same rule,
    // same timing-safe comparison, as the chat route. A conversationId for
    // a different hotel, or the right hotel but the wrong/missing session
    // token, is rejected identically: never a distinguishable response.
    let conversation: { id: string; session_id: string | null } | null;
    try {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, session_id")
        .eq("id", conversationId)
        .eq("hotel_id", hotelId)
        .maybeSingle();
      if (error) throw new Error(`conversation lookup failed: ${error.message}`);
      conversation = data;
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/partner-request/phone: conversation lookup failed", { hotelId, message: (err as Error).message });
      return NextResponse.json(GENERIC_ERROR, { status: 500 });
    }
    if (!conversation || !sessionTokensMatch(conversation.session_id, sessionTokenHash)) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }

    // Never logged, never echoed back — this is the one place the raw
    // phone value from the request body is ever touched, and only to
    // derive a normalized E.164 value or reject it outright.
    const normalizedPhone = normalizeStructuredPhoneInput(phone);
    if (!normalizedPhone) {
      return NextResponse.json(INVALID_PHONE_ERROR, { status: 400 });
    }

    try {
      const result = await deps.submitStructuredGuestPhone({
        hotelId,
        conversationId,
        phoneE164: normalizedPhone,
        pendingRequest,
        supabase,
      });

      if (!result.ok) {
        const status = result.code === "phone_mismatch" ? 409 : 400;
        return NextResponse.json({ error: result.error }, { status });
      }

      return NextResponse.json({ ok: true, message: result.message });
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/partner-request/phone: submitStructuredGuestPhone failed", {
        hotelId,
        message: (err as Error).message,
      });
      return NextResponse.json(GENERIC_ERROR, { status: 500 });
    }
  };
}

export const POST = createPhoneHandler();
