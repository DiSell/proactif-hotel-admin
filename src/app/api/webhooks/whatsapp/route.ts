// Meta WhatsApp Business Platform webhook — GET is Meta's own subscription
// verification handshake, POST is where Meta delivers inbound events
// (here: a partner's template quick-reply button tap).
//
// POINT CRITIQUE: this route can only ever mutate a partner_request on the
// basis of a signature-verified button token RESOLVED AGAINST THE DATABASE
// (features/partnerRequests/deliveryService.ts::resolvePartnerReplyToken)
// — never a bare requestId read out of message text, and never by decoding
// the token itself (reply tokens are opaque, 0023_partner_request_deliveries.sql
// — there is nothing to decode). "decode token -> trust IDs -> mutate" is
// exactly what this route must NEVER do.
import { NextResponse } from "next/server";
import { handleWebhookChallenge, handleWebhookPost } from "@/lib/notifications/whatsapp/webhook";
import {
  resolvePartnerReplyToken as resolvePartnerReplyTokenImpl,
  applyPartnerReplyCommand as applyPartnerReplyCommandImpl,
} from "@/features/partnerRequests/deliveryService";
import {
  resolveSpaBookingReplyToken as resolveSpaBookingReplyTokenImpl,
  applySpaBookingReplyCommand as applySpaBookingReplyCommandImpl,
} from "@/features/spa/deliveryService";

export interface WhatsAppWebhookDeps {
  handleWebhookChallenge: typeof handleWebhookChallenge;
  handleWebhookPost: typeof handleWebhookPost;
  resolvePartnerReplyToken: typeof resolvePartnerReplyTokenImpl;
  applyPartnerReplyCommand: typeof applyPartnerReplyCommandImpl;
  resolveSpaBookingReplyToken: typeof resolveSpaBookingReplyTokenImpl;
  applySpaBookingReplyCommand: typeof applySpaBookingReplyCommandImpl;
}

const defaultDeps: WhatsAppWebhookDeps = {
  handleWebhookChallenge,
  handleWebhookPost,
  resolvePartnerReplyToken: resolvePartnerReplyTokenImpl,
  applyPartnerReplyCommand: applyPartnerReplyCommandImpl,
  resolveSpaBookingReplyToken: resolveSpaBookingReplyTokenImpl,
  applySpaBookingReplyCommand: applySpaBookingReplyCommandImpl,
};

export function createWhatsAppWebhookHandlers(deps: WhatsAppWebhookDeps = defaultDeps) {
  async function GET(request: Request) {
    const url = new URL(request.url);
    const challenge = deps.handleWebhookChallenge({
      mode: url.searchParams.get("hub.mode"),
      token: url.searchParams.get("hub.verify_token"),
      challenge: url.searchParams.get("hub.challenge"),
    });
    if (challenge === null) return new NextResponse("Forbidden", { status: 403 });
    return new NextResponse(challenge, { status: 200 });
  }

  async function POST(request: Request) {
    // .text(), never .json() — the signature is computed over the exact
    // raw bytes Meta sent; re-serializing a parsed object would not
    // reproduce the same signature even for a perfectly legitimate request.
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("x-hub-signature-256");
    const outcome = deps.handleWebhookPost(rawBody, signatureHeader);

    if (!outcome.ok) {
      // Deliberately generic — never reveals whether the signature or the
      // payload shape was the actual problem, same "no distinguishable
      // response" discipline as every other public boundary in this
      // codebase (see e.g. the widget phone route's own conversation-lookup
      // comment).
      return NextResponse.json({ error: "invalid" }, { status: 403 });
    }

    for (const token of outcome.buttonTokens) {
      // resolvePartnerReplyToken does the ENTIRE validation chain: hashes
      // the token, looks it up against partner_request_deliveries, and
      // only returns a result for a delivery whose status is 'sent' or
      // 'unknown' (task section 9) — an unsigned/foreign/stale token, or
      // one belonging to a 'failed' delivery, resolves to null and is
      // silently dropped here, never surfaced as a best-guess reply.
      const resolvedPartner = await deps.resolvePartnerReplyToken(token);
      if (resolvedPartner) {
        try {
          // message is always null here: a partner's free-text explanation
          // (e.g. an alternative time) is not part of this task's scope —
          // only the deterministic button tap itself is acted on (task
          // section 12's own "préférer des réponses déterministes" guidance).
          // apply_partner_request_command() itself is the FINAL authorization
          // check — it re-validates the partner_request's current status
          // under its own row lock before allowing this transition at all.
          await deps.applyPartnerReplyCommand(resolvedPartner.partnerRequestId, resolvedPartner.hotelId, resolvedPartner.command, null);
        } catch (err) {
          // A single bad/already-resolved/race-lost reply must never fail
          // the whole webhook delivery — Meta retries on any non-2xx
          // response, which would re-deliver every OTHER event in this same
          // payload too. Logged, never thrown, never leaked to the response.
          console.error("POST /api/webhooks/whatsapp: applying partner reply failed", { message: (err as Error).message });
        }
        continue;
      }

      // Not a partner reply token — try the spa-booking-approval reply
      // space next (0035_spa_booking_approval.sql). The two token spaces
      // are entirely independent (never decoded, only hash-looked-up), so
      // trying one after the other is the only way to tell which domain a
      // given inbound tap belongs to — same "try each in turn" discipline
      // resolvePartnerReplyToken itself already uses across its own three
      // hash columns.
      const resolvedSpa = await deps.resolveSpaBookingReplyToken(token);
      if (!resolvedSpa) continue;

      try {
        await deps.applySpaBookingReplyCommand(resolvedSpa.bookingId, resolvedSpa.hotelId, resolvedSpa.command);
      } catch (err) {
        console.error("POST /api/webhooks/whatsapp: applying spa booking reply failed", { message: (err as Error).message });
      }
    }

    return NextResponse.json({ ok: true });
  }

  return { GET, POST };
}

const handlers = createWhatsAppWebhookHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
