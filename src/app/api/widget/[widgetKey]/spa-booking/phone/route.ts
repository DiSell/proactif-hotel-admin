// Dedicated endpoint for the widget's structured spa-booking phone-collection
// form (see features/widget/PublicWidgetChat.tsx and
// features/rag/spaBookingFlow.ts) — mirrors
// .../partner-request/phone/route.ts's structure exactly (same session/
// conversation-ownership verification, same "never send a phone number as a
// normal chat message" discipline), but its own schema and its own handler
// (features/rag/spaBookingFlow.ts:submitStructuredSpaBookingPhone) — no
// model call, no message persistence, same underlying create_spa_booking RPC
// the free-text path already uses.
import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { readBoundedBody } from "@/lib/http/readBoundedBody";
import { resolvePublicWidgetContext as resolvePublicWidgetContextImpl } from "@/features/widget/publicHotel";
import { hashSessionToken, sessionTokensMatch, SESSION_TOKEN_PATTERN } from "@/features/widget/sessionToken";
import { normalizeStructuredPhoneInput } from "@/features/partnerRequests/phoneRedaction";
import { getSpaAvailability as getSpaAvailabilityImpl } from "@/features/spa/booking";
import { submitStructuredSpaBookingPhone as submitStructuredSpaBookingPhoneImpl } from "@/features/rag/spaBookingFlow";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PHONE_INPUT_LENGTH = 40;

const GENERIC_ERROR = { error: "Une erreur est survenue. Veuillez réessayer." } as const;
const SERVICE_UNAVAILABLE = { error: "Service temporairement indisponible. Veuillez réessayer dans un instant." } as const;
const INVALID_PHONE_ERROR = { error: "Numéro de téléphone invalide. Merci de vérifier le format (ex. 06 12 34 56 78 ou +33 6 12 34 56 78)." } as const;

// .strict(): public route, same discipline as the chat route and the
// partner-request phone route — an unexpected extra field fails the whole
// request rather than being silently dropped.
const phoneRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    sessionToken: z.string().regex(SESSION_TOKEN_PATTERN, "Session invalide."),
    phone: z.string().trim().min(1, "Le numéro est vide.").max(MAX_PHONE_INPUT_LENGTH, "Numéro trop long."),
    // Echoed back verbatim from the phonePrompt the widget was shown (see
    // features/rag/types.ts:SpaBookingPhonePrompt) — bookingDate/slotStart/
    // partySize were already independently validated against a real
    // calendar/capacity check before being shown (see
    // features/rag/spaBookingFlow.ts's own doc comment); still re-validated
    // here (submitStructuredSpaBookingPhone re-checks the slot against fresh
    // availability) rather than trusted as-is.
    pendingBooking: z
      .object({
        bookingDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide."),
        slotStart: z.string().trim().regex(/^\d{2}:\d{2}$/, "Créneau invalide."),
        partySize: z.number().int().min(1),
        guestName: z.string().trim().max(200, "Nom trop long.").nullable(),
        isNonResident: z.boolean(),
        notes: z.string().trim().max(2000, "Note trop longue.").nullable(),
      })
      .strict(),
  })
  .strict();

export interface SpaBookingPhoneRouteDeps {
  createSupabaseClient: () => SupabaseClient;
  resolveWidgetContext: typeof resolvePublicWidgetContextImpl;
  getSpaAvailability: typeof getSpaAvailabilityImpl;
  submitStructuredSpaBookingPhone: typeof submitStructuredSpaBookingPhoneImpl;
}

const defaultDeps: SpaBookingPhoneRouteDeps = {
  createSupabaseClient: createAdminClient,
  resolveWidgetContext: resolvePublicWidgetContextImpl,
  getSpaAvailability: getSpaAvailabilityImpl,
  submitStructuredSpaBookingPhone: submitStructuredSpaBookingPhoneImpl,
};

export function createSpaBookingPhoneHandler(deps: SpaBookingPhoneRouteDeps = defaultDeps) {
  return async function POST(request: Request, context: RouteContext<"/api/widget/[widgetKey]/spa-booking/phone">) {
    const { widgetKey } = await context.params;

    let supabase: SupabaseClient;
    try {
      supabase = deps.createSupabaseClient();
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/spa-booking/phone: failed to create Supabase client", { message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }

    let widgetContext;
    try {
      widgetContext = await deps.resolveWidgetContext(widgetKey, supabase);
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/spa-booking/phone: failed to resolve widget", { message: (err as Error).message });
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
    const { conversationId, sessionToken, phone, pendingBooking } = parsed.data;
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
      console.error("POST /api/widget/[widgetKey]/spa-booking/phone: conversation lookup failed", { hotelId, message: (err as Error).message });
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
      const availability = await deps.getSpaAvailability(hotelId, pendingBooking.bookingDate, supabase);
      const result = await deps.submitStructuredSpaBookingPhone({
        hotelId,
        conversationId,
        phoneE164: normalizedPhone,
        pendingBooking,
        availability,
        supabase,
      });

      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      return NextResponse.json({ ok: true, message: result.message });
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/spa-booking/phone: submitStructuredSpaBookingPhone failed", {
        hotelId,
        message: (err as Error).message,
      });
      return NextResponse.json(GENERIC_ERROR, { status: 500 });
    }
  };
}

export const POST = createSpaBookingPhoneHandler();
