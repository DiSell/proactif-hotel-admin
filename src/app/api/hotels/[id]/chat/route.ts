// Back-office chat route — powers the admin "Mode test" panel
// (ChatPreview inside /etablissements/[id]/assistant). The client portal's
// "Tester mon chatbot" uses the DEDICATED /api/client/hotels/[id]/chat
// route instead (same ChatPreview component, different apiPath prop) —
// see that route and src/features/rag/chatEndpoint.ts, which both routes
// call identically once authorized. Splitting the route, rather than
// having one route accept either scope, is deliberate: requireHotelAccess
// takes an explicit, non-inferred scope (lib/supabase/cookieScope.ts's
// AuthScope) — a single shared route would have to guess or accept both,
// reintroducing the exact ambiguity that was removed from requireHotelAccess
// itself.
import { requireHotelAccess } from "@/lib/auth/session";
import { handleHotelChatRequest } from "@/features/rag/chatEndpoint";

export async function POST(request: Request, context: RouteContext<"/api/hotels/[id]/chat">) {
  const { id: hotelId } = await context.params;
  await requireHotelAccess(hotelId, "backoffice");
  return handleHotelChatRequest(request, hotelId);
}
