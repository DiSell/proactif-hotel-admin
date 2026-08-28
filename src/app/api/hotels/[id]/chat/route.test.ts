import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "route.ts"), "utf8");

/**
 * Regression guards for the back-office chat route — Supabase/OpenAI-
 * touching, same testing constraint as elsewhere in this codebase
 * (source-level checks instead of a live invocation). The actual chat
 * logic (parsing, conversation resolution, answerQuestion call) now lives
 * in src/features/rag/chatEndpoint.ts, shared with the client-portal route
 * — see chatEndpoint.test.ts for those guards, not repeated here.
 */
describe("POST /api/hotels/[id]/chat — back-office scope, no fallback", () => {
  it("[explicit scope] authorizes with requireHotelAccess(hotelId, \"backoffice\") — never requireSuperadmin(), never an inferred/fallback scope", () => {
    expect(source).toMatch(/requireHotelAccess\(hotelId, "backoffice"\)/);
    expect(source).not.toMatch(/requireSuperadmin\(/);
  });

  it("[hotelId resolved before the body is ever read] requireHotelAccess runs before handleHotelChatRequest, which is the only thing that reads the body", () => {
    const authIndex = source.indexOf('requireHotelAccess(hotelId, "backoffice")');
    const handlerIndex = source.indexOf("handleHotelChatRequest(request, hotelId)");
    expect(authIndex).toBeGreaterThan(-1);
    expect(handlerIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeLessThan(handlerIndex);
  });

  it("[delegates to the shared handler] imports handleHotelChatRequest from features/rag/chatEndpoint, never re-implements the chat logic inline", () => {
    expect(source).toMatch(/import \{ handleHotelChatRequest \} from "@\/features\/rag\/chatEndpoint";/);
    expect(source).not.toMatch(/createAdminClient/);
    expect(source).not.toMatch(/answerQuestion/);
  });
});
