// CATÉGORIES INFORMATION CLIQUABLES chantier — public, read-only widget
// route: loads the photos for ONE accommodation category, on demand,
// triggered by a click on an accommodationSummary entry in PublicWidgetChat
// (see features/rag/types.ts:AnswerQuestionResult.accommodationSummary's own
// doc comment). Mirrors /api/widget/[widgetKey]/chat's own security model
// exactly — no new mechanism invented: hotelId is resolved EXCLUSIVELY from
// widgetKey (never accepted from the client), the same
// resolvePublicWidgetContext used by every other public widget route, and
// the same widget-wide rate limiter (shares its bucket with /chat
// deliberately — this is a cheap, low-cost read with no OpenAI call behind
// it, not a reason to invent a second rate-limit bucket/mechanism for a
// single-purpose endpoint). Same-origin call from inside the widget iframe
// (unlike /config, which widget.js fetches directly from the HOST page) —
// no CORS headers needed here, exactly like /chat.
//
// Exported as a factory (createRoomPhotosHandler) for the same reason as
// every other widget route in this repo — see chat/route.ts's own doc
// comment.
import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePublicWidgetContext as resolvePublicWidgetContextImpl } from "@/features/widget/publicHotel";
import { checkWidgetGlobalRateLimit } from "@/features/widget/rateLimit";
import { loadSelectedRoomPhotos } from "@/features/rag/roomPhotos";
import type { AccommodationType } from "@/types/database";

const SERVICE_UNAVAILABLE = { error: "Service temporairement indisponible. Veuillez réessayer dans un instant." } as const;

const accommodationTypeIdSchema = z.string().uuid();

export interface RoomPhotosRouteDeps {
  createSupabaseClient: () => SupabaseClient;
  resolveWidgetContext: typeof resolvePublicWidgetContextImpl;
  checkGlobalRateLimit: typeof checkWidgetGlobalRateLimit;
}

const defaultDeps: RoomPhotosRouteDeps = {
  createSupabaseClient: createAdminClient,
  resolveWidgetContext: resolvePublicWidgetContextImpl,
  checkGlobalRateLimit: checkWidgetGlobalRateLimit,
};

export function createRoomPhotosHandler(deps: RoomPhotosRouteDeps = defaultDeps) {
  return async function GET(request: Request, context: RouteContext<"/api/widget/[widgetKey]/room-photos">) {
    const { widgetKey } = await context.params;

    let supabase: SupabaseClient;
    try {
      supabase = deps.createSupabaseClient();
    } catch (err) {
      console.error("GET /api/widget/[widgetKey]/room-photos: failed to create Supabase client", { message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }

    let widgetContext;
    try {
      widgetContext = await deps.resolveWidgetContext(widgetKey, supabase);
    } catch (err) {
      console.error("GET /api/widget/[widgetKey]/room-photos: failed to resolve widget", { message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }
    if (!widgetContext) {
      return NextResponse.json({ error: "Widget introuvable." }, { status: 404 });
    }
    const hotelId = widgetContext.hotelId;

    // Same widget-wide bucket as /chat (widgetKey-only, no sessionToken
    // required here — this endpoint has no per-visitor state and no OpenAI
    // cost to bound, only a per-widget ceiling against scripted abuse).
    try {
      const globalResult = await deps.checkGlobalRateLimit(supabase, widgetKey);
      if (!globalResult.allowed) {
        return NextResponse.json(
          { error: "Trop de requêtes pour ce widget. Réessayez plus tard." },
          { status: 429, headers: { "Retry-After": String(globalResult.retryAfterSeconds) } }
        );
      }
    } catch (err) {
      console.error("GET /api/widget/[widgetKey]/room-photos: rate limiter failed", { hotelId, message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }

    const rawAccommodationTypeId = new URL(request.url).searchParams.get("accommodationTypeId");
    const parsedId = accommodationTypeIdSchema.safeParse(rawAccommodationTypeId);
    if (!parsedId.success) {
      return NextResponse.json({ error: "Identifiant d'hébergement invalide." }, { status: 400 });
    }
    const accommodationTypeId = parsedId.data;

    // SECURITY: the cross-hotel guard. accommodationTypeId comes straight
    // from the client (it's a public accommodationSummary entry the widget
    // already displayed) — never trusted for a photo lookup without first
    // confirming it actually belongs to THIS resolved hotelId. `active`
    // mirrors every other read of this table in this codebase (see
    // answer.ts's own accommodation_types query) — never surface a
    // deactivated category.
    const { data: accommodationType, error: accommodationTypeError } = await supabase
      .from("accommodation_types")
      .select("id, name, source_url")
      .eq("id", accommodationTypeId)
      .eq("hotel_id", hotelId)
      .eq("active", true)
      .maybeSingle<Pick<AccommodationType, "id" | "name" | "source_url">>();
    if (accommodationTypeError) {
      console.error("GET /api/widget/[widgetKey]/room-photos: accommodation_types lookup failed", { hotelId, message: accommodationTypeError.message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }
    if (!accommodationType) {
      // Collapses "unknown id" and "belongs to a different hotel" into the
      // same 404 — deliberately, same discipline as resolvePublicWidgetContext's
      // own doc comment: a distinguishable response would let a caller probe
      // which ids are real for another hotel.
      return NextResponse.json({ error: "Hébergement introuvable." }, { status: 404 });
    }

    const photos = await loadSelectedRoomPhotos(supabase, hotelId, accommodationType.id);

    return NextResponse.json({
      accommodationTypeId: accommodationType.id,
      name: accommodationType.name,
      photos,
      pageUrl: accommodationType.source_url,
      // Same principle as buildRoomRecommendation (answer.ts): the
      // establishment's own configured booking link, resolved server-side,
      // never sourced from the client.
      bookingUrl: widgetContext.hotel.booking_url,
    });
  };
}

export const GET = createRoomPhotosHandler();
