// Twilio Programmable Messaging (SMS) inbound webhook — PHASE 1 of the
// Twilio SMS integration. Twilio has no GET verification handshake (unlike
// Meta's WhatsApp webhook, src/app/api/webhooks/whatsapp/route.ts) — POST
// is the only method Twilio ever calls here.
//
// POINT CRITIQUE (PHASE 1 scope): this route performs NO business action.
// It validates the X-Twilio-Signature header, extracts MessageSid/From/To/
// Body, and returns an empty TwiML response — nothing is resolved against
// partner_request_deliveries/spa_booking_deliveries, no RPC is called. That
// correlation logic (a short reply code -> delivery -> hotel_id, mirroring
// the existing WhatsApp reply-token discipline) is a separate, later phase
// — explicitly NOT approved yet for this phase (see this session's own
// preceding audits).
import { NextResponse } from "next/server";
import Twilio from "twilio";
import { handleInboundSms, resolvePublicRequestUrl } from "@/lib/notifications/sms/webhook";

export interface TwilioSmsWebhookDeps {
  handleInboundSms: typeof handleInboundSms;
}

const defaultDeps: TwilioSmsWebhookDeps = { handleInboundSms };

export function createTwilioSmsWebhookHandlers(deps: TwilioSmsWebhookDeps = defaultDeps) {
  async function POST(request: Request) {
    const formData = await request.formData();
    const params: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") params[key] = value;
    }

    const url = resolvePublicRequestUrl(request);
    const signatureHeader = request.headers.get("x-twilio-signature");
    const outcome = deps.handleInboundSms(url, signatureHeader, params);

    if (!outcome.ok) {
      // Deliberately generic — same "no distinguishable response" posture
      // as the WhatsApp webhook route for an invalid signature.
      return new NextResponse("Forbidden", { status: 403 });
    }

    // PHASE 1: fields are validated/extracted only, never acted on. The
    // SDK's own MessagingResponse builds the empty TwiML document — never
    // hand-written XML — so Twilio never auto-sends a reply just because
    // this webhook was reached.
    const emptyTwiml = new Twilio.twiml.MessagingResponse().toString();
    return new NextResponse(emptyTwiml, { status: 200, headers: { "Content-Type": "text/xml" } });
  }

  return { POST };
}

const handlers = createTwilioSmsWebhookHandlers();
export const POST = handlers.POST;
