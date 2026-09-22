// Dedicated endpoint for the widget's structured handover phone-collection
// form (see features/rag/humanHandover.ts and
// features/rag/humanHandoverFlow.ts) — mirrors
// /api/widget/[widgetKey]/partner-request/phone's own shape exactly: a phone
// number must never be sent as a normal chat message, and this endpoint
// never calls the LLM at all. hotel_id is NEVER accepted from the client —
// only widgetKey, resolved server-side, same as every other public widget
// route — and the only write path this endpoint can reach is the guest-safe
// RPC from 0048 (create_hotel_service_request_from_widget), never the
// staff-only 0043 RPCs.
import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { readBoundedBody } from "@/lib/http/readBoundedBody";
import { resolvePublicWidgetContext as resolvePublicWidgetContextImpl } from "@/features/widget/publicHotel";
import { hashSessionToken, sessionTokensMatch, SESSION_TOKEN_PATTERN } from "@/features/widget/sessionToken";
import { normalizeStructuredPhoneInput } from "@/features/partnerRequests/phoneRedaction";
import { submitHandoverPhone as submitHandoverPhoneImpl } from "@/features/rag/humanHandoverFlow";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PHONE_INPUT_LENGTH = 40;
const MAX_ROOM_NUMBER_LENGTH = 50;

const GENERIC_ERROR = { error: "Une erreur est survenue. Veuillez réessayer." } as const;
const SERVICE_UNAVAILABLE = { error: "Service temporairement indisponible. Veuillez réessayer dans un instant." } as const;
const INVALID_PHONE_ERROR = { error: "Numéro de téléphone invalide. Merci de vérifier le format (ex. 06 12 34 56 78 ou +33 6 12 34 56 78)." } as const;

// .strict(): public route, same discipline as every other widget route.
const handoverPhoneRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    sessionToken: z.string().regex(SESSION_TOKEN_PATTERN, "Session invalide."),
    phone: z.string().trim().min(1, "Le numéro est vide.").max(MAX_PHONE_INPUT_LENGTH, "Numéro trop long."),
    // Echoed back verbatim from the handoverPhonePrompt the widget was shown
    // (see features/rag/types.ts:HandoverPhonePrompt) — guestMessage is the
    // visitor's own already-typed chat content, not a new trust boundary.
    // roomNumber is free text the visitor typed into the optional widget
    // field — never re-validated against anything server-side beyond length,
    // since it carries no referential meaning (unlike partnerId).
    pendingHandover: z
      .object({
        guestMessage: z.string().trim().min(1).max(2000, "Message trop long."),
        roomNumber: z.string().trim().max(MAX_ROOM_NUMBER_LENGTH, "Numéro de chambre trop long.").nullable(),
      })
      .strict(),
  })
  .strict();

export interface HandoverPhoneRouteDeps {
  createSupabaseClient: () => SupabaseClient;
  resolveWidgetContext: typeof resolvePublicWidgetContextImpl;
  submitHandoverPhone: typeof submitHandoverPhoneImpl;
}

const defaultDeps: HandoverPhoneRouteDeps = {
  createSupabaseClient: createAdminClient,
  resolveWidgetContext: resolvePublicWidgetContextImpl,
  submitHandoverPhone: submitHandoverPhoneImpl,
};

export function createHandoverPhoneHandler(deps: HandoverPhoneRouteDeps = defaultDeps) {
  return async function POST(request: Request, context: RouteContext<"/api/widget/[widgetKey]/service-request/phone">) {
    const { widgetKey } = await context.params;

    let supabase: SupabaseClient;
    try {
      supabase = deps.createSupabaseClient();
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/service-request/phone: failed to create Supabase client", { message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }

    let widgetContext;
    try {
      widgetContext = await deps.resolveWidgetContext(widgetKey, supabase);
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/service-request/phone: failed to resolve widget", { message: (err as Error).message });
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

    const parsed = handoverPhoneRequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }
    const { conversationId, sessionToken, phone, pendingHandover } = parsed.data;
    const sessionTokenHash = hashSessionToken(sessionToken);

    // conversationId is NEVER proof of possession on its own — same rule,
    // same timing-safe comparison, as the chat route and the partner-request
    // phone route.
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
      console.error("POST /api/widget/[widgetKey]/service-request/phone: conversation lookup failed", { hotelId, message: (err as Error).message });
      return NextResponse.json(GENERIC_ERROR, { status: 500 });
    }
    if (!conversation || !sessionTokensMatch(conversation.session_id, sessionTokenHash)) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }

    // Never logged, never echoed back — the one place the raw phone value
    // from the request body is ever touched, and only to derive a
    // normalized E.164 value or reject it outright.
    const normalizedPhone = normalizeStructuredPhoneInput(phone);
    if (!normalizedPhone) {
      return NextResponse.json(INVALID_PHONE_ERROR, { status: 400 });
    }

    try {
      const result = await deps.submitHandoverPhone({
        hotelId,
        conversationId,
        phoneE164: normalizedPhone,
        guestMessage: pendingHandover.guestMessage,
        roomNumber: pendingHandover.roomNumber || null,
        supabase,
      });

      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      return NextResponse.json({ ok: true, message: result.message });
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/service-request/phone: submitHandoverPhone failed", { hotelId, message: (err as Error).message });
      return NextResponse.json(GENERIC_ERROR, { status: 500 });
    }
  };
}

export const POST = createHandoverPhoneHandler();
