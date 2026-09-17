// Public config route for the embeddable widget — no session, no
// requireSuperadmin(), reachable by any visitor on a hotel's own site (see
// PUBLIC_PATH_PREFIXES in lib/supabase/updateSession.ts). hotelId is never
// accepted from the client anywhere in this file: the only input is
// widgetKey, resolved server-side.
//
// Exported as a factory (createConfigHandler), same reasoning as the chat
// route: real invocation tests with a controllable fake Supabase client,
// not just source-text assertions.
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPublicWidgetConfig, resolvePublicWidgetContext as resolvePublicWidgetContextImpl } from "@/features/widget/publicHotel";
import { loadActiveBanner as loadActiveBannerImpl } from "@/features/rag/events";

/**
 * public/widget.js calls this endpoint directly from the HOST page's own
 * JavaScript context (e.g. le1837.com) — unlike /chat, which is only ever
 * fetched from inside the Proactif-origin iframe (same-origin there, no
 * CORS involved at all). This one is genuinely cross-origin from the
 * browser's point of view, and needs an explicit Access-Control-Allow-Origin
 * or the fetch is rejected before widget.js's own .then()/.catch() ever
 * sees a status code — confirmed empirically against the live deployment
 * (a real cross-origin request came back with no ACAO header at all).
 *
 * `*` (never a specific/echoed origin) is deliberate, not a shortcut:
 * - The response carries nothing sensitive — publicWidgetConfigSchema
 *   (features/widget/publicHotel.ts) already excludes hotelId,
 *   credential_reference, and anything integration/reservation-related by
 *   construction; hostBookingTrigger's selector is not a secret either — it
 *   is already sitting in the hotel's own public page HTML.
 * - No cookie/credential is ever read or required for this GET (no
 *   `credentials: "include"` anywhere, no session, no auth) — a wildcard
 *   never widens what a credentialed request could do, because none exists.
 * - The legitimate caller set is unbounded and unknown in advance: ANY
 *   hotel's own external website may embed this widget on any domain it
 *   controls. There is no "known allowed origins" list to check against —
 *   inventing one (e.g. a new hotels.embed_domain column, matched against
 *   the request's Origin header) would be real, unjustified complexity for
 *   data that carries no confidentiality requirement in the first place.
 *
 * Applied to EVERY response this handler returns (200, 404, 503) — a
 * browser rejects a cross-origin fetch outright, before the caller can even
 * read response.status, if this header is missing on ANY of them; it is not
 * only needed on the success path.
 *
 * No OPTIONS handler is added: widget.js's request is a plain, unauthenticated
 * GET with no custom headers and no body — a "simple request" under the CORS
 * spec, which browsers never preflight. Adding an OPTIONS export here would
 * be complexity this actual caller never triggers.
 */
const PUBLIC_CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

function corsJson(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, { ...init, headers: PUBLIC_CORS_HEADERS });
}

export interface ConfigRouteDeps {
  createSupabaseClient: () => SupabaseClient;
  resolveWidgetContext: typeof resolvePublicWidgetContextImpl;
  loadActiveBanner: typeof loadActiveBannerImpl;
}

const defaultDeps: ConfigRouteDeps = {
  createSupabaseClient: createAdminClient,
  resolveWidgetContext: resolvePublicWidgetContextImpl,
  loadActiveBanner: loadActiveBannerImpl,
};

export function createConfigHandler(deps: ConfigRouteDeps = defaultDeps) {
  return async function GET(_request: Request, context: RouteContext<"/api/widget/[widgetKey]/config">) {
    const { widgetKey } = await context.params;

    let supabase: SupabaseClient;
    try {
      supabase = deps.createSupabaseClient();
    } catch (err) {
      console.error("GET /api/widget/[widgetKey]/config: failed to create Supabase client", { message: (err as Error).message });
      return corsJson({ error: "Service temporairement indisponible." }, { status: 503 });
    }

    let widgetContext;
    try {
      widgetContext = await deps.resolveWidgetContext(widgetKey, supabase);
    } catch (err) {
      console.error("GET /api/widget/[widgetKey]/config: failed to resolve widget", { message: (err as Error).message });
      return corsJson({ error: "Service temporairement indisponible." }, { status: 503 });
    }
    if (!widgetContext) {
      // Unknown key, unpublished hotel, disabled assistant, and disabled
      // widget all collapse to the same 404 — see resolvePublicWidgetContext's
      // doc comment for why a distinguishable response is never returned.
      return corsJson({ error: "Widget introuvable." }, { status: 404 });
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const activeBanner = await deps.loadActiveBanner(supabase, widgetContext.hotelId, todayIso);

    return corsJson(buildPublicWidgetConfig(widgetContext, activeBanner));
  };
}

export const GET = createConfigHandler();
