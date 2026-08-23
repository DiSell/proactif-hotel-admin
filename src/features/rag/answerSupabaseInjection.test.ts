import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Regression guards for making answerQuestion()/retrieveKnowledge() reusable
 * by the public widget (P1) without copying the RAG pipeline. Neither
 * function can be unit-tested directly here (Supabase + OpenAI, no mocking
 * infra in this repo — same constraint as similarityThreshold.test.ts), so
 * this checks the source-level shape the reuse requires instead: an
 * injected client is accepted and used, and — critically — every existing
 * caller (the admin chat route) keeps working unchanged because the
 * parameter is optional and defaults to exactly what ran before.
 */
describe("answerQuestion / retrieveKnowledge — injectable Supabase client", () => {
  const answerSource = readFileSync(join(here, "answer.ts"), "utf8");
  const retrieveSource = readFileSync(join(here, "retrieve.ts"), "utf8");

  it("[answer.ts] accepts an optional supabase param, defaulting to createClient() — the admin route's existing call site needs no change", () => {
    expect(answerSource).toMatch(/supabase\?:\s*SupabaseClient;/);
    expect(answerSource).toMatch(/const supabase = injectedSupabase \?\? \(await createClient\(\)\);/);
  });

  it("[answer.ts] the resolved client (injected or default) is the one passed to retrieveKnowledge — never a second, independently-constructed client", () => {
    expect(answerSource).toMatch(/retrieveKnowledge\(\{\s*hotelId,\s*query:\s*message,\s*limit:\s*RETRIEVAL_LIMIT,\s*supabase\s*\}\)/);
  });

  it("[retrieve.ts] accepts an optional supabase param, defaulting to createClient() — every existing caller keeps working unchanged", () => {
    expect(retrieveSource).toMatch(/supabase\?:\s*SupabaseClient;/);
    expect(retrieveSource).toMatch(/const supabase = injectedSupabase \?\? \(await createClient\(\)\);/);
  });

  it("[no regression] answerQuestion's own admin call site (the /api/hotels/[id]/chat route) never passes a supabase override — the default (session-bound, RLS-as-superadmin) path is untouched", () => {
    const adminRouteSource = readFileSync(join(here, "../../app/api/hotels/[id]/chat/route.ts"), "utf8");
    expect(adminRouteSource).toMatch(/answerQuestion\(\{\s*hotelId,\s*conversationId,\s*message\s*\}\)/);
    expect(adminRouteSource).not.toMatch(/supabase:/);
  });
});
