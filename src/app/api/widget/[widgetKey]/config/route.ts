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

export interface ConfigRouteDeps {
  createSupabaseClient: () => SupabaseClient;
  resolveWidgetContext: typeof resolvePublicWidgetContextImpl;
}

const defaultDeps: ConfigRouteDeps = {
  createSupabaseClient: createAdminClient,
  resolveWidgetContext: resolvePublicWidgetContextImpl,
};

export function createConfigHandler(deps: ConfigRouteDeps = defaultDeps) {
  return async function GET(_request: Request, context: RouteContext<"/api/widget/[widgetKey]/config">) {
    const { widgetKey } = await context.params;

    let supabase: SupabaseClient;
    try {
      supabase = deps.createSupabaseClient();
    } catch (err) {
      console.error("GET /api/widget/[widgetKey]/config: failed to create Supabase client", { message: (err as Error).message });
      return NextResponse.json({ error: "Service temporairement indisponible." }, { status: 503 });
    }

    let widgetContext;
    try {
      widgetContext = await deps.resolveWidgetContext(widgetKey, supabase);
    } catch (err) {
      console.error("GET /api/widget/[widgetKey]/config: failed to resolve widget", { message: (err as Error).message });
      return NextResponse.json({ error: "Service temporairement indisponible." }, { status: 503 });
    }
    if (!widgetContext) {
      // Unknown key, unpublished hotel, disabled assistant, and disabled
      // widget all collapse to the same 404 — see resolvePublicWidgetContext's
      // doc comment for why a distinguishable response is never returned.
      return NextResponse.json({ error: "Widget introuvable." }, { status: 404 });
    }

    return NextResponse.json(buildPublicWidgetConfig(widgetContext));
  };
}

export const GET = createConfigHandler();
