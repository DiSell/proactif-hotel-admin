// Twilio Programmable Messaging (SMS) inbound webhook. Twilio has no GET
// verification handshake (unlike Meta's WhatsApp webhook,
// src/app/api/webhooks/whatsapp/route.ts) — POST is the only method Twilio
// ever calls here.
//
// POINT CRITIQUE (PHASE 2): this route can only ever mutate a
// partner_request/spa_booking on the basis of a signature-verified,
// code-resolved reply RESOLVED AGAINST THE DATABASE
// (resolvePartnerReplySms/resolveSpaBookingReplySms) — never a bare
// hotel_id/request_id/booking_id read out of the SMS Body or From number.
// "parse digit+code -> trust IDs -> mutate" is exactly what this route must
// NEVER do — hotel_id/request_id/booking_id always come from the resolved
// delivery row.
import { NextResponse } from "next/server";
import Twilio from "twilio";
import { handleInboundSms, resolvePublicRequestUrl } from "@/lib/notifications/sms/webhook";
import {
  resolvePartnerReplySms as resolvePartnerReplySmsImpl,
  applyPartnerReplyCommand as applyPartnerReplyCommandImpl,
} from "@/features/partnerRequests/deliveryService";
import {
  resolveSpaBookingReplySms as resolveSpaBookingReplySmsImpl,
  applySpaBookingReplyCommand as applySpaBookingReplyCommandImpl,
} from "@/features/spa/deliveryService";

export interface TwilioSmsWebhookDeps {
  handleInboundSms: typeof handleInboundSms;
  resolvePartnerReplySms: typeof resolvePartnerReplySmsImpl;
  applyPartnerReplyCommand: typeof applyPartnerReplyCommandImpl;
  resolveSpaBookingReplySms: typeof resolveSpaBookingReplySmsImpl;
  applySpaBookingReplyCommand: typeof applySpaBookingReplyCommandImpl;
}

const defaultDeps: TwilioSmsWebhookDeps = {
  handleInboundSms,
  resolvePartnerReplySms: resolvePartnerReplySmsImpl,
  applyPartnerReplyCommand: applyPartnerReplyCommandImpl,
  resolveSpaBookingReplySms: resolveSpaBookingReplySmsImpl,
  applySpaBookingReplyCommand: applySpaBookingReplyCommandImpl,
};

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

    // Try the partner-request reply space first, then the spa-booking-
    // approval one — same "try each domain in turn" discipline as the
    // WhatsApp webhook route. Never logs the SMS Body/code/hash (only the
    // domain-agnostic outcome shape) — see this session's own audited
    // logging discipline.
    const { from, body } = outcome.fields;

    try {
      const partnerOutcome = await deps.resolvePartnerReplySms(body, from);
      if (partnerOutcome.ok) {
        try {
          await deps.applyPartnerReplyCommand(
            partnerOutcome.resolved.partnerRequestId,
            partnerOutcome.resolved.hotelId,
            partnerOutcome.resolved.command,
            partnerOutcome.resolved.message
          );
        } catch (err) {
          // A single bad/already-resolved/race-lost reply must never fail
          // the whole webhook delivery — Twilio retries on any non-2xx
          // response. Logged, never thrown, never leaked to the response.
          console.error("POST /api/webhooks/twilio/sms: applying partner reply failed", { message: (err as Error).message });
        }
      } else if (partnerOutcome.reason !== "unparseable") {
        // A body that parsed but didn't resolve as a PARTNER reply might
        // still be a spa reply — only a genuinely unparseable body skips
        // straight past both domains below. code_not_found/wrong_sender/
        // missing_alternative_text for the partner space still deserve a
        // try against the spa space, exactly like the WhatsApp route tries
        // both token spaces in turn.
        const spaOutcome = await deps.resolveSpaBookingReplySms(body, from);
        if (spaOutcome.ok) {
          try {
            await deps.applySpaBookingReplyCommand(spaOutcome.resolved.bookingId, spaOutcome.resolved.hotelId, spaOutcome.resolved.command);
          } catch (err) {
            console.error("POST /api/webhooks/twilio/sms: applying spa booking reply failed", { message: (err as Error).message });
          }
        }
      }
    } catch (err) {
      console.error("POST /api/webhooks/twilio/sms: resolving inbound reply failed", { message: (err as Error).message });
    }

    // The SDK's own MessagingResponse builds the empty TwiML document —
    // never hand-written XML — so Twilio never auto-sends a reply just
    // because this webhook was reached.
    const emptyTwiml = new Twilio.twiml.MessagingResponse().toString();
    return new NextResponse(emptyTwiml, { status: 200, headers: { "Content-Type": "text/xml" } });
  }

  return { POST };
}

const handlers = createTwilioSmsWebhookHandlers();
export const POST = handlers.POST;
