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
 * src/app/api/client/hotels/[id]/chat/route.ts). PARITÉ PHOTOS chantier:
 * this mission explicitly says "Ne modifie pas apiPath" — the chat endpoints
 * stay untouched, only accommodationSummary's OWN photo-loading path changes.
 */
describe("ChatPreview — apiPath", () => {
  it("[default] falls back to the back-office route /api/hotels/${hotelId}/chat — every existing admin call site (which never passes apiPath) keeps hitting it unchanged", () => {
    expect(source).toMatch(/apiPath \?\? `\/api\/hotels\/\$\{hotelId\}\/chat`/);
  });

  it("[client portal call site] ChatbotPersonalizationForm passes the dedicated client-scoped route explicitly, unchanged by this chantier", () => {
    const formSource = readFileSync(join(here, "../client/ChatbotPersonalizationForm.tsx"), "utf8");
    expect(formSource).toMatch(/apiPath=\{`\/api\/client\/hotels\/\$\{hotelId\}\/chat`\}/);
  });
});

/**
 * PARITÉ PHOTOS ChatPreview chantier — accommodationSummary gains the same
 * interactivity as PublicWidgetChat.tsx's own accommodationSummary rows
 * (real button, chevron, hover/focus preview, click -> RoomPhotoModal), but
 * routed through a caller-supplied, correctly-scoped Server Action
 * (getRoomPhotosAction) instead of a fetch — this component has no
 * widgetKey and must never invent one. Same DOM-less, source-level
 * discipline as PublicWidgetChat.accommodationSummary.test.ts (no jsdom in
 * this repo).
 */
describe("ChatPreview — accommodationSummary (type + data wiring)", () => {
  it("[type present] ChatMessage and ChatApiResponse both declare accommodationSummary via a locally-named AccommodationSummaryEntry (never named after roomCatalogue, which this component doesn't support)", () => {
    expect(source).toMatch(/interface ChatMessage \{[\s\S]*?accommodationSummary\?: AccommodationSummaryEntry\[\];[\s\S]*?\}/);
    expect(source).toMatch(/interface ChatApiResponse \{[\s\S]*?accommodationSummary: AccommodationSummaryEntry\[\];[\s\S]*?\}/);
  });

  it("[same four fields as the server type, no price] accommodationTypeId/name/pageUrl/maxGuests only — this contract is untouched by this chantier", () => {
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

  it("[rendered as a guaranteed list] maps over message.accommodationSummary via a block body (needed for the per-entry isPreviewing/isLoading locals), gated on length > 0, keyed by accommodationTypeId", () => {
    expect(source).toMatch(/message\.role === "assistant" && message\.accommodationSummary && message\.accommodationSummary\.length > 0/);
    expect(source).toMatch(/message\.accommodationSummary\.map\(\(entry\) => \{/);
    expect(source).toMatch(/<div key=\{entry\.accommodationTypeId\} className="relative">/);
  });

  it("[roomCatalogue stays entirely unsupported] no actual roomCatalogue field/type/rendering was added — the pre-existing gap remains, unchanged, out of scope (doc comments may still mention the name to explain the deliberate choice not to reuse it)", () => {
    expect(source).not.toMatch(/message\.roomCatalogue|data\.roomCatalogue|interface RoomCatalogueEntry|roomCatalogue\??:\s*(RoomCatalogueEntry)?\[\]/);
  });

  it("[getRoomPhotosAction prop, agnostic to scope] ChatPreview only ever calls the opaque function reference its parent handed it (same shape regardless of scope) — never imports requireHotelAccess or a Server Action itself, exactly like apiPath's own existing discipline", () => {
    expect(source).toMatch(/getRoomPhotosAction: \(hotelId: string, accommodationTypeId: string\) => Promise<ActionResult<RoomRecommendation>>;/);
    expect(source).not.toMatch(/from "@\/features\/photos\/actions"|from "@\/lib\/auth\/session"/);
  });
});

function accommodationSummaryBlock(): string {
  const start = source.indexOf('message.role === "assistant" && message.accommodationSummary && message.accommodationSummary.length > 0');
  const end = source.indexOf("message.partnerRecommendations && message.partnerRecommendations.length > 0", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function fnBlock(name: string, nextMarker: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(nextMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ChatPreview — affordance (real button, chevron, no bullet, aria-label)", () => {
  it("[old static bullet rendering removed] no more a plain <div> with a '•' span — never both the old and new rendering at once", () => {
    const block = accommodationSummaryBlock();
    expect(block).not.toMatch(/<span aria-hidden="true" className="text-accent">•<\/span>/);
  });

  it("[real <button type=\"button\">] each row is a native button, not a <div> — free Tab/Enter/Space support", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/<button\s*\n\s*type="button"/);
  });

  it("[aria-label] each button carries an explicit, dynamic aria-label naming the category — never a hardcoded name", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/aria-label=\{`Voir les photos de \$\{entry\.name\}`\}/);
  });

  it("[chevron clearly visible] a bold, larger chevron glyph, replaced by a loading indicator while this exact row is loading", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/<span aria-hidden="true" className="shrink-0 text-base font-bold text-accent">/);
    expect(block).toMatch(/\{isLoading \? "…" : "›"\}/);
  });

  it("[full row clickable, comfortable tap target] w-full on the button, real padding — never just the name text as the hit target", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2/);
  });

  it("[no heavy card] no border/background/shadow class on the button itself — discreet hover/focus only, never a permanent card look", () => {
    const block = accommodationSummaryBlock();
    const buttonStart = block.indexOf("<button");
    const buttonEnd = block.indexOf("</button>");
    const buttonBlock = block.slice(buttonStart, buttonEnd);
    expect(buttonBlock).not.toMatch(/border(?!-none)|shadow/);
    expect(buttonBlock).toMatch(/hover:bg-canvas/);
    expect(buttonBlock).toMatch(/focus-visible:outline/);
  });

  it("[values come exclusively from the structured field] name and maxGuests read straight off entry, never a hardcoded category name", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/\{entry\.name\}/);
    expect(block).toMatch(/entry\.maxGuests !== null &&/);
    expect(block).not.toMatch(/Mini-suite|Standard|Superior|Deluxe|Junior Suite|Junior PMR|Le 1837/);
  });
});

describe("ChatPreview — loadAccommodationPhotos (shared, cache-first, Server Action not fetch)", () => {
  function loadFnBlock(): string {
    return fnBlock("loadAccommodationPhotos", "async function handleAccommodationSummaryClick");
  }

  it("[cache-first] checks the cache before ever calling the Server Action", () => {
    const fn = loadFnBlock();
    const cacheCheckIndex = fn.indexOf("accommodationPhotosCacheRef.current.get(accommodationTypeId)");
    const actionCallIndex = fn.indexOf("await getRoomPhotosAction(");
    expect(cacheCheckIndex).toBeGreaterThan(-1);
    expect(actionCallIndex).toBeGreaterThan(cacheCheckIndex);
    expect(fn).toMatch(/if \(cached\) return cached;/);
  });

  it("[never a fetch, never a widgetKey] calls the injected Server Action directly with (hotelId, accommodationTypeId) — no network call invented here", () => {
    const fn = loadFnBlock();
    expect(fn).toMatch(/await getRoomPhotosAction\(hotelId, accommodationTypeId\);/);
    expect(fn).not.toMatch(/fetch\(|widgetKey/);
  });

  it("[throws on a failed ActionResult, never returns a partial value] both ok:false and a missing data are treated as failure", () => {
    const fn = loadFnBlock();
    expect(fn).toMatch(/if \(!result\.ok \|\| !result\.data\) \{\s*\n\s*throw new Error/);
  });

  it("[writes the cache exactly once, on a real successful result] never caches an error", () => {
    const fn = loadFnBlock();
    const guardIndex = fn.indexOf("if (!result.ok || !result.data)");
    const setCacheIndex = fn.indexOf("accommodationPhotosCacheRef.current.set(");
    expect(setCacheIndex).toBeGreaterThan(guardIndex);
  });

  it("[single call site for the Server Action] both the click flow and the preview flow go through this one function — never a duplicated call elsewhere", () => {
    expect((source.match(/getRoomPhotosAction\(hotelId, accommodationTypeId\)/g) ?? []).length).toBe(1);
  });
});

describe("ChatPreview — handleAccommodationSummaryClick (click/loading/error/0-photo)", () => {
  function handlerBlock(): string {
    return fnBlock("handleAccommodationSummaryClick", "handleAccommodationPreviewStart");
  }

  it("[delegates to loadAccommodationPhotos] never a second, inline Server Action call in the click handler itself", () => {
    const fn = handlerBlock();
    expect(fn).toMatch(/const data = await loadAccommodationPhotos\(entry\.accommodationTypeId\);/);
    expect(fn).not.toMatch(/getRoomPhotosAction\(/);
  });

  it("[loading set before the call, cleared after regardless of outcome]", () => {
    const fn = handlerBlock();
    const setLoadingIndex = fn.indexOf("setLoadingAccommodationTypeId(entry.accommodationTypeId);");
    const callIndex = fn.indexOf("await loadAccommodationPhotos(");
    expect(setLoadingIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(setLoadingIndex);
    expect(fn).toMatch(/finally \{\s*\n\s*if \(accommodationSummaryRequestRef\.current === requestId\) setLoadingAccommodationTypeId\(null\);/);
  });

  it("[reuses openRoomRecommendation, never a second modal state] the loaded result is passed straight to setOpenRoomRecommendation, the exact state roomRecommendation's own \"Voir la chambre\" button already uses", () => {
    const fn = handlerBlock();
    expect(fn).toMatch(/setOpenRoomRecommendation\(data\);/);
    expect((source.match(/const \[openRoomRecommendation, setOpenRoomRecommendation\] = useState<RoomRecommendation \| null>/g) ?? []).length).toBe(1);
    expect((source.match(/const \[previewData, setPreviewData\] = useState<RoomRecommendation \| null>/g) ?? []).length).toBe(1);
    // 2, not 1: accommodationSummary itself still adds none (reuses this same modal) — the second
    // instance is hotelMediaGallery's own, independent RoomPhotoModal (HOTEL_MEDIA CHATBOT chantier).
    expect((source.match(/<RoomPhotoModal/g) ?? []).length).toBe(2);
  });

  it("[error -> no fake empty modal] a thrown error (loadAccommodationPhotos rejects) sets the existing generic `error` state and never calls setOpenRoomRecommendation", () => {
    const fn = handlerBlock();
    const catchIndex = fn.indexOf("} catch {");
    const catchBlock = fn.slice(catchIndex, fn.indexOf("} finally", catchIndex));
    expect(catchBlock).toMatch(/setError\(/);
    expect(catchBlock).not.toMatch(/setOpenRoomRecommendation/);
  });

  it("[reuses the existing generic error mechanism] setError is the SAME state already rendered elsewhere in this component — no new error UI invented", () => {
    expect((source.match(/const \[error, setError\] = useState<string \| null>\(null\);/g) ?? []).length).toBe(1);
    expect(source).toMatch(/\{error && \(/);
  });

  it("[0 photos is a success, not an error] the handler never special-cases an empty photos array — RoomPhotoModal's own existing fallback handles it once the modal opens normally", () => {
    const fn = handlerBlock();
    expect(fn).not.toMatch(/photos\.length === 0|photos\.length > 0/);
  });
});

describe("ChatPreview — race condition guard, click", () => {
  function handlerBlock(): string {
    return fnBlock("handleAccommodationSummaryClick", "handleAccommodationPreviewStart");
  }

  it("[monotonic request token] a ref incremented at the very start of every call, captured locally as requestId, before the loading state or the call to loadAccommodationPhotos", () => {
    expect(source).toMatch(/const accommodationSummaryRequestRef = useRef\(0\);/);
    const fn = handlerBlock();
    const requestIdIndex = fn.indexOf("const requestId = accommodationSummaryRequestRef.current + 1;");
    const assignIndex = fn.indexOf("accommodationSummaryRequestRef.current = requestId;");
    const loadingIndex = fn.indexOf("setLoadingAccommodationTypeId(entry.accommodationTypeId);");
    const callIndex = fn.indexOf("await loadAccommodationPhotos(");
    expect(requestIdIndex).toBeGreaterThan(-1);
    expect(assignIndex).toBeGreaterThan(requestIdIndex);
    expect(loadingIndex).toBeGreaterThan(assignIndex);
    expect(callIndex).toBeGreaterThan(loadingIndex);
  });

  it("[stale response discarded before opening the modal] A started, B started, A resolves after B -> A can never open the modal", () => {
    const fn = handlerBlock();
    const callIndex = fn.indexOf("await loadAccommodationPhotos(");
    const guardIndex = fn.indexOf("if (accommodationSummaryRequestRef.current !== requestId) return;", callIndex);
    const openIndex = fn.indexOf("setOpenRoomRecommendation(data);");
    expect(guardIndex).toBeGreaterThan(callIndex);
    expect(guardIndex).toBeLessThan(openIndex);
  });

  it("[stale loading indicator never cleared by a superseded request]", () => {
    const fn = handlerBlock();
    expect(fn).toMatch(/finally \{\s*\n\s*if \(accommodationSummaryRequestRef\.current === requestId\) setLoadingAccommodationTypeId\(null\);\s*\n\s*\}/);
  });
});

describe("ChatPreview — hover detection (real hover capability, never a naive onMouseEnter)", () => {
  it("[matchMedia hover+fine-pointer check] supportsHoverDevice is computed once via matchMedia, never inferred from an event having fired", () => {
    expect(source).toMatch(/const \[supportsHoverDevice\] = useState<boolean>\(/);
    expect(source).toMatch(/window\.matchMedia\("\(hover: hover\) and \(pointer: fine\)"\)\.matches/);
  });

  it("[SSR/no-matchMedia safe] guarded by typeof window and typeof window.matchMedia checks — never throws server-side or on an old browser", () => {
    const start = source.indexOf("const [supportsHoverDevice]");
    const end = source.indexOf(");", start);
    const block = source.slice(start, end);
    expect(block).toMatch(/typeof window !== "undefined"/);
    expect(block).toMatch(/typeof window\.matchMedia === "function"/);
  });

  it("[gates onMouseEnter/onMouseLeave, never onFocus/onBlur] mouse-hover preview only fires on a real hover-capable device; keyboard focus always works regardless", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/onMouseEnter=\{\(\) => \{\s*\n\s*if \(supportsHoverDevice\) handleAccommodationPreviewStart\(entry\);/);
    expect(block).toMatch(/onMouseLeave=\{\(\) => \{\s*\n\s*if \(supportsHoverDevice\) handleAccommodationPreviewEnd\(entry\.accommodationTypeId\);/);
    expect(block).toMatch(/onFocus=\{\(\) => handleAccommodationPreviewStart\(entry\)\}/);
    expect(block).toMatch(/onBlur=\{\(\) => handleAccommodationPreviewEnd\(entry\.accommodationTypeId\)\}/);
  });
});

describe("ChatPreview — handleAccommodationPreviewStart/End (desktop hover + keyboard focus preview)", () => {
  function startBlock(): string {
    return fnBlock("handleAccommodationPreviewStart", "handleAccommodationPreviewEnd");
  }
  function endBlock(): string {
    return fnBlock("handleAccommodationPreviewEnd", "return (");
  }

  it("[cache-first, zero call on repeat hover] checks the cache before calling loadAccommodationPhotos — a second hover of the same category never reloads", () => {
    const fn = startBlock();
    const cacheCheckIndex = fn.indexOf("accommodationPhotosCacheRef.current.get(entry.accommodationTypeId)");
    const loadCallIndex = fn.indexOf("loadAccommodationPhotos(entry.accommodationTypeId)");
    expect(cacheCheckIndex).toBeGreaterThan(-1);
    expect(loadCallIndex).toBeGreaterThan(cacheCheckIndex);
    expect(fn).toMatch(/if \(cached\) \{\s*\n\s*setPreviewData\(cached\);\s*\n\s*return;\s*\n\s*\}/);
  });

  it("[never shows the 0-photo fallback while still loading] setPreviewData(null) before the call, distinct from an empty array", () => {
    const fn = startBlock();
    expect(fn).toMatch(/setPreviewData\(null\); \/\/ still loading/);
  });

  it("[race-condition token, independent from the click's own ref]", () => {
    expect(source).toMatch(/const accommodationPreviewRequestRef = useRef\(0\);/);
    const fn = startBlock();
    const fnBodyStart = fn.indexOf("function handleAccommodationPreviewStart");
    const requestIdIndex = fn.indexOf("const requestId = accommodationPreviewRequestRef.current + 1;");
    expect(requestIdIndex).toBeGreaterThan(fnBodyStart);
    const between = fn.slice(fn.indexOf("{", fnBodyStart) + 1, requestIdIndex).trim();
    expect(between).toBe("");
    expect(fn).toMatch(/accommodationPreviewRequestRef\.current = requestId;/);
  });

  it("[stale preview response discarded — a slow category A fetch can't overwrite an already-showing category B preview]", () => {
    const fn = startBlock();
    const thenIndex = fn.indexOf(".then((data) => {");
    const guardIndex = fn.indexOf("if (accommodationPreviewRequestRef.current !== requestId) return;", thenIndex);
    const setDataIndex = fn.indexOf("setPreviewData(data);", thenIndex);
    expect(guardIndex).toBeGreaterThan(thenIndex);
    expect(guardIndex).toBeLessThan(setDataIndex);
  });

  it("[preview error never breaks the widget, never opens a modal] a rejected loadAccommodationPhotos sets previewError only, gated by the same stale-request guard", () => {
    const fn = startBlock();
    const catchIndex = fn.indexOf(".catch(() => {");
    const catchBlock = fn.slice(catchIndex, fn.indexOf("});", catchIndex));
    expect(catchBlock).toMatch(/if \(accommodationPreviewRequestRef\.current !== requestId\) return;/);
    expect(catchBlock).toMatch(/setPreviewError\(true\);/);
    expect(catchBlock).not.toMatch(/setOpenRoomRecommendation|setError\(/);
  });

  it("[mouseleave/blur clears the preview and invalidates its in-flight fetch] but only if it's still the row currently showing", () => {
    const fn = endBlock();
    expect(fn).toMatch(/accommodationPreviewRequestRef\.current \+= 1;/);
    expect(fn).toMatch(/setPreviewAccommodationTypeId\(\(current\) => \(current === accommodationTypeId \? null : current\)\);/);
    expect(fn).toMatch(/setPreviewData\(null\);/);
    expect(fn).toMatch(/setPreviewError\(false\);/);
  });
});

describe("ChatPreview — preview rendering (format, max 4 thumbnails, count, 0-photo, loading, error)", () => {
  it("[only mounted for the hovered/focused row] isPreviewing gate — never rendered for every row at once", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/const isPreviewing = previewAccommodationTypeId === entry\.accommodationTypeId;/);
    expect(block).toMatch(/\{isPreviewing && \(/);
  });

  it("[max 4 thumbnails, in the order photos were returned (position order, guaranteed server-side)]", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/previewData\.photos\.slice\(0, 4\)\.map/);
  });

  it("[total photo count shown]", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/\{previewData\.photos\.length\} photo\{previewData\.photos\.length > 1 \? "s" : ""\}/);
  });

  it("[0 photos -> a light textual note, never 4 empty slots]", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/previewData\.photos\.length === 0 \? \(\s*\n\s*<p[^>]*>Aucune photo disponible\.<\/p>/);
  });

  it("[loading state -> discreet text, never the 0-photo fallback]", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/previewData === null \? \(\s*\n\s*<p[^>]*>Chargement des photos…<\/p>/);
  });

  it("[error state -> a quiet note, never a crash/blank]", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/previewError \? \(\s*\n\s*<p[^>]*>Aperçu indisponible\.<\/p>/);
  });

  it("[never a second modal, never a full carousel] no RoomPhotoModal reference inside the preview block, and no thumbnail click handler (thumbnails are decorative only, alt=\"\")", () => {
    const block = accommodationSummaryBlock();
    const previewStart = block.indexOf("isPreviewing && (");
    const previewBlock = block.slice(previewStart);
    expect(previewBlock).not.toMatch(/RoomPhotoModal/);
    expect(previewBlock).not.toMatch(/onClick/);
    expect(previewBlock).toMatch(/alt=""/);
  });

  it("[accessible: role=status + aria-describedby links the row to its own preview]", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/role="status"/);
    expect(block).toMatch(/aria-describedby=\{isPreviewing \? `chatpreview-accsummary-preview-\$\{entry\.accommodationTypeId\}` : undefined\}/);
    expect(block).toMatch(/id=\{`chatpreview-accsummary-preview-\$\{entry\.accommodationTypeId\}`\}/);
  });
});

describe("ChatPreview — cache (session-local, no localStorage, no global)", () => {
  it("[a plain ref-held Map, keyed by accommodationTypeId, values compatible with openRoomRecommendation]", () => {
    expect(source).toMatch(/const accommodationPhotosCacheRef = useRef<Map<string, RoomRecommendation>>\(new Map\(\)\);/);
  });

  it("[never localStorage/sessionStorage for this cache]", () => {
    expect(source).not.toMatch(/localStorage\.|sessionStorage\./);
  });

  it("[single Map instance for the whole cache] never a second, competing cache structure introduced elsewhere", () => {
    expect((source.match(/useRef<Map<string, RoomRecommendation>>/g) ?? []).length).toBe(1);
  });
});

describe("ChatPreview — RoomRecommendation path unchanged (non-régression)", () => {
  it("[\"Voir la chambre\" button untouched] still sets openRoomRecommendation directly from message.roomRecommendation, no Server Action involved", () => {
    expect(source).toMatch(/onClick=\{\(\) => setOpenRoomRecommendation\(message\.roomRecommendation \?\? null\)\}/);
    expect(source).toMatch(/Voir la chambre — \{message\.roomRecommendation\.name\}/);
  });

  it("[single RoomPhotoModal render site for RoomRecommendation] accommodationSummary's click reuses it, never a second instance for itself — 2 total in the file, the other one is hotelMediaGallery's own (HOTEL_MEDIA CHATBOT chantier)", () => {
    expect((source.match(/<RoomPhotoModal/g) ?? []).length).toBe(2);
  });

  it("[chat text flow untouched] handleSend still uses fetch(apiPath ...) exactly as before — only accommodationSummary's own photo loading changed", () => {
    expect(source).toMatch(/const response = await fetch\(apiPath \?\? `\/api\/hotels\/\$\{hotelId\}\/chat`, \{/);
  });
});
