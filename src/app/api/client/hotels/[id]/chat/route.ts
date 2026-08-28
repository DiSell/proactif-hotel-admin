// Client-portal chat route — powers "Tester mon chatbot" (ChatPreview
// inside /client/chatbot, via ChatbotPersonalizationForm.tsx's apiPath
// prop). The back-office's "Mode test" panel uses the separate
// /api/hotels/[id]/chat route instead — see its own doc comment and
// src/features/rag/chatEndpoint.ts, which both routes call identically
// once authorized. Two routes, not one accepting either scope: this way
// requireHotelAccess's explicit AuthScope (lib/supabase/cookieScope.ts)
// never has to be inferred or tried as a fallback here either.
import { requireHotelAccess } from "@/lib/auth/session";
import { handleHotelChatRequest } from "@/features/rag/chatEndpoint";

export async function POST(request: Request, context: RouteContext<"/api/client/hotels/[id]/chat">) {
  const { id: hotelId } = await context.params;
  await requireHotelAccess(hotelId, "client");
  return handleHotelChatRequest(request, hotelId);
}
