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

/**
 * INFORMATION DÉTERMINISTE chantier — item F/9 of the mission: ChatPreview
 * gains accommodationSummary support so INFORMATION can be previewed
 * correctly (chatEndpoint.ts, shared by both /api/hotels/[id]/chat and
 * /api/client/hotels/[id]/chat, already serializes it). Deliberately does
 * NOT add roomCatalogue support — that gap is pre-existing and explicitly
 * out of scope for this chantier.
 */
describe("ChatPreview — accommodationSummary", () => {
  it("[type present] ChatMessage and ChatApiResponse both declare accommodationSummary via a locally-named AccommodationSummaryEntry (never named after roomCatalogue, which this component doesn't support)", () => {
    expect(source).toMatch(/interface ChatMessage \{[\s\S]*?accommodationSummary\?: AccommodationSummaryEntry\[\];[\s\S]*?\}/);
    expect(source).toMatch(/interface ChatApiResponse \{[\s\S]*?accommodationSummary: AccommodationSummaryEntry\[\];[\s\S]*?\}/);
  });

  it("[same four fields as the server type, no price] accommodationTypeId/name/pageUrl/maxGuests only", () => {
    const ifaceStart = source.indexOf("interface AccommodationSummaryEntry");
    const ifaceEnd = source.indexOf("}", ifaceStart);
    const iface = source.slice(ifaceStart, ifaceEnd);
    expect(iface).toMatch(/accommodationTypeId: string;/);
    expect(iface).toMatch(/name: string;/);
    expect(iface).toMatch(/pageUrl: string \| null;/);
    expect(iface).toMatch(/maxGuests: number \| null;/);
    expect(iface).not.toMatch(/price/i);
  });

  it("[actually read from the API response] data.accommodationSummary is stored on the new assistant message", () => {
    const sendStart = source.indexOf("const data: ChatApiResponse = await response.json();");
    const sendEnd = source.indexOf("} catch (err)", sendStart);
    const sendBlock = source.slice(sendStart, sendEnd);
    expect(sendBlock).toMatch(/accommodationSummary: data\.accommodationSummary,/);
  });

  it("[rendered as a guaranteed list] maps over message.accommodationSummary, gated on length > 0, keyed by accommodationTypeId", () => {
    expect(source).toMatch(/message\.role === "assistant" && message\.accommodationSummary && message\.accommodationSummary\.length > 0/);
    expect(source).toMatch(/message\.accommodationSummary\.map\(\(entry\) => \(/);
  });

  it("[roomCatalogue stays entirely unsupported] no actual roomCatalogue field/type/rendering was added by this chantier — the pre-existing gap remains, unchanged, out of scope (doc comments may still mention the name to explain the deliberate choice not to reuse it)", () => {
    expect(source).not.toMatch(/message\.roomCatalogue|data\.roomCatalogue|interface RoomCatalogueEntry|roomCatalogue\??:\s*(RoomCatalogueEntry)?\[\]/);
  });
});
