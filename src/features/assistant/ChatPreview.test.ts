import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "ChatPreview.tsx"), "utf8");

/**
 * ChatPreview is now shared by two different real usages — the admin
 * "Mode test" panel (features/hotels/wizard and
 * /etablissements/[id]/assistant, always showSources unset -> defaults to
 * true, unchanged behavior) and the client portal's chatbot personalization
 * page (/client/chatbot, rendered via ChatbotPersonalizationForm, explicitly
 * showSources={false}). Same DOM-less constraint as elsewhere in this repo
 * (no jsdom) — source-level guard, not a render test.
 */
describe("ChatPreview — showSources", () => {
  it("[default true] the prop defaults to true — every existing admin call site (which never passes showSources) keeps rendering SourcesDebugPanel exactly as before", () => {
    expect(source).toMatch(/showSources\s*=\s*true/);
  });

  it("[gates the debug panel] SourcesDebugPanel only renders when showSources is true", () => {
    expect(source).toMatch(/\{showSources && message\.role === "assistant" && message\.answerStatus && \(/);
  });

  it("[client portal call site] ChatbotPersonalizationForm (rendered by /client/chatbot) passes showSources={false} explicitly", () => {
    const formSource = readFileSync(join(here, "../client/ChatbotPersonalizationForm.tsx"), "utf8");
    expect(formSource).toMatch(/showSources=\{false\}/);
  });
});

/**
 * apiPath — the two spaces hit DIFFERENT chat routes, each with its own
 * explicit requireHotelAccess(hotelId, scope) (no shared route, no inferred
 * scope — see lib/supabase/cookieScope.ts's AuthScope and
 * src/app/api/hotels/[id]/chat/route.ts vs
 * src/app/api/client/hotels/[id]/chat/route.ts).
 */
describe("ChatPreview — apiPath", () => {
  it("[default] falls back to the back-office route /api/hotels/${hotelId}/chat — every existing admin call site (which never passes apiPath) keeps hitting it unchanged", () => {
    expect(source).toMatch(/apiPath \?\? `\/api\/hotels\/\$\{hotelId\}\/chat`/);
  });

  it("[client portal call site] ChatbotPersonalizationForm passes the dedicated client-scoped route explicitly", () => {
    const formSource = readFileSync(join(here, "../client/ChatbotPersonalizationForm.tsx"), "utf8");
    expect(formSource).toMatch(/apiPath=\{`\/api\/client\/hotels\/\$\{hotelId\}\/chat`\}/);
  });
});
