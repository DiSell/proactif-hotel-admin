import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Regression guards for making answerQuestion()/retrieveKnowledgeHybrid()
 * reusable across multiple callers (the public widget, and now
 * /api/hotels/[id]/chat for both the admin panel and the client portal)
 * without copying the RAG pipeline. Neither function can be unit-tested
 * directly here (Supabase + OpenAI, no mocking infra in this repo — same
 * constraint as similarityThreshold.test.ts), so this checks the
 * source-level shape the reuse requires instead: an injected client is
 * accepted and used, the parameter stays optional (defaulting to the
 * session-bound client) for any caller that still wants that, and the
 * admin/client-shared chat route deliberately injects the service-role
 * client instead. retrieveKnowledge()/match_knowledge_chunks() (the
 * pre-hybrid path) still exist and still work the same way — this file
 * only follows answer.ts's own call site, which now uses the hybrid one.
 */
describe("answerQuestion / retrieveKnowledgeHybrid — injectable Supabase client", () => {
  const answerSource = readFileSync(join(here, "answer.ts"), "utf8");
  const retrieveSource = readFileSync(join(here, "retrieve.ts"), "utf8");

  it("[answer.ts] accepts an optional supabase param, defaulting to createClient() — the admin route's existing call site needs no change", () => {
    expect(answerSource).toMatch(/supabase\?:\s*SupabaseClient;/);
    expect(answerSource).toMatch(/const supabase = injectedSupabase \?\? \(await createClient\(\)\);/);
  });

  it("[answer.ts] the resolved client (injected or default) is the one passed to retrieveKnowledgeHybrid — never a second, independently-constructed client", () => {
    expect(answerSource).toMatch(/retrieveKnowledgeHybrid\(\{\s*hotelId,\s*query:\s*message,\s*limit:\s*RETRIEVAL_LIMIT,\s*supabase\s*\}\)/);
  });

  it("[retrieve.ts] accepts an optional supabase param, defaulting to createClient() — every existing caller keeps working unchanged", () => {
    expect(retrieveSource).toMatch(/supabase\?:\s*SupabaseClient;/);
    expect(retrieveSource).toMatch(/const supabase = injectedSupabase \?\? \(await createClient\(\)\);/);
  });

  it("[shared chat handler] handleHotelChatRequest (chatEndpoint.ts) DELIBERATELY passes an injected service-role client, never the session-bound default — shared verbatim by both the admin 'Mode test' panel's route and the client portal's 'Tester mon chatbot' route, each of which authorizes its own explicit scope FIRST (requireHotelAccess(hotelId, scope)) so a hotel_admin's own browser session never needs direct RLS access to knowledge_sources/knowledge_chunks — see chatEndpoint.ts's own doc comment", () => {
    const chatEndpointSource = readFileSync(join(here, "chatEndpoint.ts"), "utf8");
    expect(chatEndpointSource).toMatch(/answerQuestion\(\{ hotelId, conversationId, message, supabase \}\)/);
    expect(chatEndpointSource).toMatch(/const supabase = createAdminClient\(\);/);

    const backofficeRouteSource = readFileSync(join(here, "../../app/api/hotels/[id]/chat/route.ts"), "utf8");
    expect(backofficeRouteSource).toMatch(/requireHotelAccess\(hotelId, "backoffice"\)/);

    const clientRouteSource = readFileSync(join(here, "../../app/api/client/hotels/[id]/chat/route.ts"), "utf8");
    expect(clientRouteSource).toMatch(/requireHotelAccess\(hotelId, "client"\)/);
  });
});
