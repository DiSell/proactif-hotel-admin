// Public chat route for the embeddable widget — deliberately separate from
// /api/hotels/[id]/chat (admin-only, requireSuperadmin, trusts a
// client-supplied hotelId path param). This route never calls
// requireSuperadmin(), and hotelId is never accepted from the client
// anywhere below — only widgetKey, resolved server-side. Reachable without
// a session (see PUBLIC_PATH_PREFIXES in lib/supabase/updateSession.ts).
//
// Exported as a factory (createChatHandler) rather than a bare POST so
// tests can invoke the real handler with a real Request and controllable
// fake dependencies (Supabase client, rate limiter, answerQuestion) instead
// of only asserting on the source text — see route.test.ts. The default
// export below wires the real, production dependencies; nothing about
// runtime behavior changes from having a factory.
import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { readBoundedBody } from "@/lib/http/readBoundedBody";
import { answerQuestion as answerQuestionImpl } from "@/features/rag/answer";
import { resolvePublicWidgetContext as resolvePublicWidgetContextImpl } from "@/features/widget/publicHotel";
import { checkWidgetGlobalRateLimit, checkWidgetSessionRateLimit } from "@/features/widget/rateLimit";
import { hashSessionToken, sessionTokensMatch, SESSION_TOKEN_PATTERN } from "@/features/widget/sessionToken";

const MAX_MESSAGE_LENGTH = 2000;
// Caps how long a single public conversation can grow before this route
// refuses to continue it — a visitor genuinely chatting stays far under
// this; a scripted loop reusing one conversationId to run up model/API
// cost does not. A fresh conversationId (i.e. a new conversation) is
// unaffected by this cap.
const MAX_CONVERSATION_MESSAGES = 200;
// Hard cap on the raw request body, enforced DURING the read (see
// readBoundedBody) — well above any real chat message (MAX_MESSAGE_LENGTH
// is 2000 UTF-8 chars, a few KB at most even with a long conversationId/
// sessionToken alongside it), tight enough to bound memory/CPU spent on an
// oversized payload before Zod ever sees it.
const MAX_BODY_BYTES = 32 * 1024;

const GENERIC_ERROR = { error: "Une erreur est survenue. Veuillez réessayer." } as const;
const SERVICE_UNAVAILABLE = { error: "Service temporairement indisponible. Veuillez réessayer dans un instant." } as const;

// .strict(): this route is public — an unexpected extra field (e.g. an
// attempted hotelId override) must fail the whole request, not be silently
// dropped. sessionToken is required on every call, including the first
// message of a brand new conversation (see PublicWidgetChat.tsx) — there is
// no "anonymous, no session" request shape.
const widgetChatRequestSchema = z
  .object({
    conversationId: z.string().uuid().nullish(),
    message: z.string().trim().min(1, "Le message est vide.").max(MAX_MESSAGE_LENGTH, "Message trop long."),
    sessionToken: z.string().regex(SESSION_TOKEN_PATTERN, "Session invalide."),
  })
  .strict();

export interface ChatRouteDeps {
  createSupabaseClient: () => SupabaseClient;
  resolveWidgetContext: typeof resolvePublicWidgetContextImpl;
  checkGlobalRateLimit: typeof checkWidgetGlobalRateLimit;
  checkSessionRateLimit: typeof checkWidgetSessionRateLimit;
  answerQuestion: typeof answerQuestionImpl;
}

const defaultDeps: ChatRouteDeps = {
  createSupabaseClient: createAdminClient,
  resolveWidgetContext: resolvePublicWidgetContextImpl,
  checkGlobalRateLimit: checkWidgetGlobalRateLimit,
  checkSessionRateLimit: checkWidgetSessionRateLimit,
  answerQuestion: answerQuestionImpl,
};

export function createChatHandler(deps: ChatRouteDeps = defaultDeps) {
  return async function POST(request: Request, context: RouteContext<"/api/widget/[widgetKey]/chat">) {
    const { widgetKey } = await context.params;

    let supabase: SupabaseClient;
    try {
      supabase = deps.createSupabaseClient();
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/chat: failed to create Supabase client", { message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }

    let widgetContext;
    try {
      widgetContext = await deps.resolveWidgetContext(widgetKey, supabase);
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/chat: failed to resolve widget", { message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }
    if (!widgetContext) {
      return NextResponse.json({ error: "Widget introuvable." }, { status: 404 });
    }
    const hotelId = widgetContext.hotelId;

    // ORDER IS DELIBERATE, kept exactly as-is (confirmed correct in
    // security review — do not "fix" this to check the session token
    // first): resolve widget -> GLOBAL rate limit -> read/validate body
    // (which is where sessionToken becomes known at all) -> SESSION rate
    // limit -> conversation resolution -> answerQuestion. The global,
    // per-widget_key check runs BEFORE the body is even read, at the
    // lowest possible cost, specifically because widget_key alone (from
    // the URL) is enough to make this decision — there is no reason to
    // spend the work of reading/parsing/validating a body, or hashing a
    // session token, for a widget that's already over its global quota.
    // The session-level check necessarily comes later, once the body has
    // been parsed and sessionToken is known — but both checks still always
    // run, unconditionally, before any possibility of reaching
    // answerQuestion (the one thing that actually calls OpenAI). A
    // rate-limiter failure at either stage fails CLOSED: the request is
    // rejected, OpenAI is never called, regardless of what caused the
    // failure.
    try {
      const globalResult = await deps.checkGlobalRateLimit(supabase, widgetKey);
      if (!globalResult.allowed) {
        return NextResponse.json(
          { error: "Trop de messages envoyés pour ce widget. Réessayez plus tard." },
          { status: 429, headers: { "Retry-After": String(globalResult.retryAfterSeconds) } }
        );
      }
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/chat: rate limiter failed (global)", { hotelId, message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }

    const bodyResult = await readBoundedBody(request, MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      return NextResponse.json({ error: "Message trop volumineux." }, { status: 413 });
    }

    let json: unknown;
    try {
      json = bodyResult.text.length > 0 ? JSON.parse(bodyResult.text) : null;
    } catch {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }

    const parsed = widgetChatRequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }
    const { message, sessionToken } = parsed.data;
    const requestedConversationId = parsed.data.conversationId ?? null;
    const sessionTokenHash = hashSessionToken(sessionToken);

    // Per-visitor-session quota — independent of the global one above, so
    // one session can never be blamed for exhausting the whole widget's
    // budget, but also can never bypass it either (both are checked).
    // Necessarily runs here, not earlier: sessionToken only becomes known
    // once the body has been read and validated (see the ordering note on
    // the global check above).
    try {
      const sessionResult = await deps.checkSessionRateLimit(supabase, widgetKey, sessionTokenHash);
      if (!sessionResult.allowed) {
        return NextResponse.json(
          { error: "Trop de messages envoyés. Réessayez dans un instant." },
          { status: 429, headers: { "Retry-After": String(sessionResult.retryAfterSeconds) } }
        );
      }
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/chat: rate limiter failed (session)", { hotelId, message: (err as Error).message });
      return NextResponse.json(SERVICE_UNAVAILABLE, { status: 503 });
    }

    let conversationId: string;
    try {
      if (requestedConversationId) {
        // hotel_id filtered in the query itself, not just checked
        // afterward — auto-defensive even though the service-role client
        // bypasses RLS entirely for this query.
        const { data: conversation, error: convError } = await supabase
          .from("conversations")
          .select("id, session_id")
          .eq("id", requestedConversationId)
          .eq("hotel_id", hotelId)
          .maybeSingle();
        if (convError) throw new Error(`conversation lookup failed: ${convError.message}`);

        // conversationId is NEVER proof of possession on its own — the
        // visitor's session token must also match (timing-safe comparison)
        // the hash recorded when this conversation was created. A
        // conversationId for a different hotel, or the right hotel but the
        // wrong/missing/absent session token, is rejected identically:
        // never a distinguishable response.
        if (!conversation || !sessionTokensMatch(conversation.session_id, sessionTokenHash)) {
          return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
        }

        const { count: messageCount, error: countError } = await supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", conversation.id)
          .eq("hotel_id", hotelId);
        if (countError) throw new Error(`message count failed: ${countError.message}`);
        if ((messageCount ?? 0) >= MAX_CONVERSATION_MESSAGES) {
          return NextResponse.json({ error: "Cette conversation a atteint sa limite. Démarrez une nouvelle conversation." }, { status: 400 });
        }

        conversationId = conversation.id;
      } else {
        // session_id stores ONLY the hash — the raw sessionToken never
        // reaches this route's own logging, and is never written to the
        // database in raw form (see sessionToken.ts).
        const { data: created, error: createError } = await supabase
          .from("conversations")
          .insert({ hotel_id: hotelId, session_id: sessionTokenHash })
          .select("id")
          .single();
        if (createError || !created) throw new Error(`conversation creation failed: ${createError?.message ?? "no row returned"}`);
        conversationId = created.id;
      }
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/chat: conversation resolution failed", { hotelId, message: (err as Error).message });
      return NextResponse.json(GENERIC_ERROR, { status: 500 });
    }

    try {
      const result = await deps.answerQuestion({ hotelId, conversationId, message, supabase });
      return NextResponse.json({
        conversationId,
        reply: result.reply,
        // sources deliberately omitted — ChatPreview's own SourcesDebugPanel
        // is explicitly documented "never rendered in a public widget";
        // similarity scores and source titles stay an admin-only debug
        // affordance, not part of the public contract.
        answerStatus: result.answerStatus,
        roomRecommendation: result.roomRecommendation,
        action: result.action,
        partnerRecommendations: result.partnerRecommendations,
      });
    } catch (err) {
      console.error("POST /api/widget/[widgetKey]/chat: answerQuestion failed", { hotelId, message: (err as Error).message });
      return NextResponse.json(GENERIC_ERROR, { status: 500 });
    }
  };
}

export const POST = createChatHandler();
