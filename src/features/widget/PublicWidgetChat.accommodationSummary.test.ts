import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PublicWidgetChat.tsx"), "utf8");

/**
 * INFORMATION DÉTERMINISTE + CATÉGORIES INFORMATION CLIQUABLES + PREVIEW AU
 * SURVOL chantiers — source-level (no jsdom in this repo, same constraint as
 * PublicWidgetChat.roomCatalogue.test.ts). Proves the summary is rendered,
 * visually distinct from roomCatalogue's cards, each row is a real
 * clickable/focusable button wired to an on-demand, cached photo fetch
 * reusing RoomRecommendation's own modal/state, AND (this chantier) that
 * hovering/focusing a row shows a light floating preview without ever
 * duplicating the fetch or the modal.
 */
describe("PublicWidgetChat — accommodationSummary (type + data wiring)", () => {
  it("[type present] ChatMessage and ChatApiResponse both declare accommodationSummary, reusing RoomCatalogueEntry (never a second parallel type)", () => {
    expect(source).toMatch(/interface ChatMessage \{[\s\S]*?accommodationSummary\?: RoomCatalogueEntry\[\];[\s\S]*?\}/);
    expect(source).toMatch(/interface ChatApiResponse \{[\s\S]*?accommodationSummary: RoomCatalogueEntry\[\];[\s\S]*?\}/);
  });

  it("[actually read from the API response] data.accommodationSummary is stored on the new assistant message", () => {
    const sendStart = source.indexOf("const data: ChatApiResponse = await response.json();");
    const sendEnd = source.indexOf("if (data.partnerRequestPhonePrompt)", sendStart);
    const sendBlock = source.slice(sendStart, sendEnd);
    expect(sendBlock).toMatch(/accommodationSummary: data\.accommodationSummary,/);
  });

  it("[accommodationSummary's own contract is never extended with photos] no photos field on the type — the whole point of fetching on demand", () => {
    const ifaceStart = source.indexOf("interface RoomCatalogueEntry");
    const ifaceEnd = source.indexOf("}", ifaceStart);
    expect(source.slice(ifaceStart, ifaceEnd)).not.toMatch(/photos/);
  });
});

function accommodationSummaryBlock(): string {
  const start = source.indexOf("message.role === \"assistant\" && message.accommodationSummary && message.accommodationSummary.length > 0");
  const end = source.indexOf("Server guarantees roomRecommendation", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function fnBlock(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(nextName, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("PublicWidgetChat — accommodationSummary (rendering)", () => {
  it("[rendered as a guaranteed list] maps over message.accommodationSummary, gated on length > 0, keyed by accommodationTypeId — never derived from parsing message.content", () => {
    expect(source).toMatch(/message\.role === "assistant" && message\.accommodationSummary && message\.accommodationSummary\.length > 0/);
    expect(source).toMatch(/message\.accommodationSummary\.map\(\(entry\) => \{/);
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/key=\{entry\.accommodationTypeId\}/);
  });

  it("[values come exclusively from the structured field] name and maxGuests read straight off entry, never a hardcoded category name anywhere near this block", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/\{entry\.name\}/);
    expect(block).toMatch(/entry\.maxGuests !== null &&/);
    expect(block).not.toMatch(/Mini-suite|Standard|Superior|Deluxe|Junior Suite|Junior PMR|Le 1837/);
  });

  it("[visually distinct from roomCatalogue — mobile-light, no cards] the row button itself has no border/background-per-entry card style, unlike roomCatalogue", () => {
    const block = accommodationSummaryBlock();
    const buttonStart = block.indexOf("<button");
    const buttonEnd = block.indexOf("</button>");
    const buttonBlock = block.slice(buttonStart, buttonEnd);
    expect(buttonBlock).not.toMatch(/border: "1px solid/);
    expect(buttonBlock).not.toMatch(/background: "#fff"/);

    // roomCatalogue's own card block, for contrast — confirms the two really do differ.
    const catalogueBlockStart = source.indexOf("message.roomCatalogue && message.roomCatalogue.length > 0");
    const catalogueBlockEnd = source.indexOf("))}", catalogueBlockStart);
    const catalogueBlock = source.slice(catalogueBlockStart, catalogueBlockEnd);
    expect(catalogueBlock).toMatch(/border: "1px solid/);
    expect(catalogueBlock).toMatch(/background: "#fff"/);
  });

  it("[independent field, never both non-empty rendering blocks confused] roomCatalogue and accommodationSummary are two separate conditional blocks in the JSX, each keyed on its own field", () => {
    const roomCatalogueCount = (source.match(/message\.roomCatalogue && message\.roomCatalogue\.length > 0/g) ?? []).length;
    const summaryCount = (source.match(/message\.accommodationSummary && message\.accommodationSummary\.length > 0/g) ?? []).length;
    expect(roomCatalogueCount).toBe(1);
    expect(summaryCount).toBe(1);
  });
});

describe("PublicWidgetChat — affordance (item 2: chevron clearly visible, real button, no heavy card)", () => {
  it("[real <button>] each row is a native <button type=\"button\">, not a <div> — free Tab/Enter/Space support, no custom key handling needed", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/<button\s*\n\s*type="button"/);
  });

  it("[aria-label] each button carries an explicit, dynamic aria-label naming the category — never a hardcoded name", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/aria-label=\{`Voir les photos de \$\{entry\.name\}`\}/);
  });

  it("[full row clickable] width: 100% on the button itself — the whole row is the tappable target, never just the name text", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/width: "100%"/);
  });

  it("[chevron made clearly visible] larger, bold chevron — not the same subtle inherited text size as before this chantier", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/aria-hidden="true"[\s\S]*?fontSize: 18, fontWeight: 700/);
    expect(block).toMatch(/\{isLoading \? "…" : "›"\}/);
  });

  it("[comfortable tap target] vertical padding increased for touch comfort (10px, up from 8px)", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/padding: "10px 6px"/);
  });

  it("[hover/focus styling exists, scoped to this row only, discreet background] a dedicated CSS class with :hover/:focus-visible rules — inline styles alone can't express these; never a heavy card border", () => {
    expect(source).toMatch(/\.pwc-accsummary-row:hover:not\(:disabled\)\s*\{\s*background:\s*#F1EDE3;\s*\}/);
    expect(source).toMatch(/\.pwc-accsummary-row:focus-visible\s*\{\s*outline:\s*2px solid #8A6A3E;/);
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/className="pwc-accsummary-row"/);
  });
});

describe("PublicWidgetChat — loadAccommodationPhotos (shared fetch, item 4)", () => {
  function loadFnBlock(): string {
    return fnBlock("loadAccommodationPhotos", "async function handleAccommodationSummaryClick");
  }

  it("[cache-first] checks the cache before ever fetching", () => {
    const fn = loadFnBlock();
    const cacheCheckIndex = fn.indexOf("accommodationPhotosCacheRef.current.get(accommodationTypeId)");
    const fetchIndex = fn.indexOf("await fetch(");
    expect(cacheCheckIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeGreaterThan(cacheCheckIndex);
    expect(fn).toMatch(/if \(cached\) return cached;/);
  });

  it("[calls the room-photos route with the exact accommodationTypeId]", () => {
    const fn = loadFnBlock();
    expect(fn).toMatch(
      /`\/api\/widget\/\$\{encodeURIComponent\(widgetKey\)\}\/room-photos\?accommodationTypeId=\$\{encodeURIComponent\(accommodationTypeId\)\}`/
    );
  });

  it("[throws on non-ok, never returns a partial value]", () => {
    const fn = loadFnBlock();
    expect(fn).toMatch(/if \(!response\.ok\) \{\s*\n\s*throw new Error/);
  });

  it("[writes the cache exactly once, on a real successful fetch] never caches an error, never caches before the response is parsed", () => {
    const fn = loadFnBlock();
    const jsonIndex = fn.indexOf("await response.json()");
    const setCacheIndex = fn.indexOf("accommodationPhotosCacheRef.current.set(");
    expect(setCacheIndex).toBeGreaterThan(jsonIndex);
  });

  it("[single fetch call site for room-photos] both the click flow and the preview flow go through this one function — never a duplicated fetch elsewhere", () => {
    expect((source.match(/\/room-photos\?accommodationTypeId=/g) ?? []).length).toBe(1);
  });
});

describe("PublicWidgetChat — handleAccommodationSummaryClick (TEST B: click/loading/error/0-photo)", () => {
  function handlerBlock(): string {
    return fnBlock("handleAccommodationSummaryClick", "handleAccommodationPreviewStart");
  }

  it("[delegates to loadAccommodationPhotos] never a second, inline fetch in the click handler itself", () => {
    const fn = handlerBlock();
    expect(fn).toMatch(/const data = await loadAccommodationPhotos\(entry\.accommodationTypeId\);/);
    expect(fn).not.toMatch(/await fetch\(/);
  });

  it("[loading set before the call, cleared after regardless of outcome]", () => {
    const fn = handlerBlock();
    const setLoadingIndex = fn.indexOf("setLoadingAccommodationTypeId(entry.accommodationTypeId);");
    const callIndex = fn.indexOf("await loadAccommodationPhotos(");
    expect(setLoadingIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(setLoadingIndex);
    expect(fn).toMatch(/finally \{\s*\n\s*if \(accommodationSummaryRequestRef\.current === requestId\) setLoadingAccommodationTypeId\(null\);/);
  });

  it("[reuses openRoomRecommendation, never a second modal state] the fetched result is passed straight to setOpenRoomRecommendation, the exact state RoomRecommendation's own \"Voir la chambre\" button already uses", () => {
    const fn = handlerBlock();
    expect(fn).toMatch(/setOpenRoomRecommendation\(data\);/);
    // openRoomRecommendation's OWN declaration stays singular — previewData legitimately
    // reuses the same type annotation for a different, non-modal purpose (TEST DESKTOP HOVER),
    // so a blanket count of every `useState<RoomRecommendation | null>` occurrence would be wrong.
    expect((source.match(/const \[openRoomRecommendation, setOpenRoomRecommendation\] = useState<RoomRecommendation \| null>/g) ?? []).length).toBe(1);
    expect((source.match(/const \[previewData, setPreviewData\] = useState<RoomRecommendation \| null>/g) ?? []).length).toBe(1);
    // Exactly 2 in the whole file, not a duplicate for THIS feature: accommodationSummary itself
    // still adds none (reuses this same modal) — the second instance is hotelMediaGallery's own,
    // independent RoomPhotoModal (HOTEL_MEDIA CHATBOT chantier).
    expect((source.match(/<RoomPhotoModal/g) ?? []).length).toBe(2);
  });

  it("[network/HTTP error -> no fake empty modal] a thrown error (loadAccommodationPhotos rejects on non-ok/network failure) sets the existing generic `error` state and never calls setOpenRoomRecommendation", () => {
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

describe("PublicWidgetChat — race condition guard, click (TEST C)", () => {
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

  it("[stale response discarded before opening the modal]", () => {
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

describe("PublicWidgetChat — hover detection (item 6: real hover capability, never a naive onMouseEnter)", () => {
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

  it("[gates onMouseEnter/onMouseLeave, never onFocus/onBlur] mouse-hover preview only fires on a real hover-capable device; keyboard focus always works regardless (item 7)", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/onMouseEnter=\{\(\) => \{\s*\n\s*if \(supportsHoverDevice\) handleAccommodationPreviewStart\(entry\);/);
    expect(block).toMatch(/onMouseLeave=\{\(\) => \{\s*\n\s*if \(supportsHoverDevice\) handleAccommodationPreviewEnd\(entry\.accommodationTypeId\);/);
    expect(block).toMatch(/onFocus=\{\(\) => handleAccommodationPreviewStart\(entry\)\}/);
    expect(block).toMatch(/onBlur=\{\(\) => handleAccommodationPreviewEnd\(entry\.accommodationTypeId\)\}/);
  });
});

describe("PublicWidgetChat — handleAccommodationPreviewStart/End (desktop hover preview, TEST DESKTOP HOVER)", () => {
  function startBlock(): string {
    return fnBlock("handleAccommodationPreviewStart", "handleAccommodationPreviewEnd");
  }
  function endBlock(): string {
    return fnBlock("handleAccommodationPreviewEnd", "handleSubmitPhone");
  }

  it("[cache-first, zero fetch on repeat hover] checks the cache before calling loadAccommodationPhotos — a second hover of the same category never refetches", () => {
    const fn = startBlock();
    const cacheCheckIndex = fn.indexOf("accommodationPhotosCacheRef.current.get(entry.accommodationTypeId)");
    const loadCallIndex = fn.indexOf("loadAccommodationPhotos(entry.accommodationTypeId)");
    expect(cacheCheckIndex).toBeGreaterThan(-1);
    expect(loadCallIndex).toBeGreaterThan(cacheCheckIndex);
    expect(fn).toMatch(/if \(cached\) \{\s*\n\s*setPreviewData\(cached\);\s*\n\s*return;\s*\n\s*\}/);
  });

  it("[never shows the 0-photo fallback while still loading] setPreviewData(null) before the fetch, distinct from an empty array", () => {
    const fn = startBlock();
    expect(fn).toMatch(/setPreviewData\(null\); \/\/ still loading/);
  });

  it("[race-condition token, independent from the click's own ref]", () => {
    expect(source).toMatch(/const accommodationPreviewRequestRef = useRef\(0\);/);
    const fn = startBlock();
    const fnBodyStart = fn.indexOf("function handleAccommodationPreviewStart");
    const requestIdIndex = fn.indexOf("const requestId = accommodationPreviewRequestRef.current + 1;");
    expect(requestIdIndex).toBeGreaterThan(fnBodyStart);
    // No other statement sits between the function's opening brace and the requestId line —
    // the token is captured before anything else runs (loading state, cache check, fetch).
    const between = fn.slice(fn.indexOf("{", fnBodyStart) + 1, requestIdIndex).trim();
    expect(between).toBe("");
    expect(fn).toMatch(/accommodationPreviewRequestRef\.current = requestId;/);
  });

  it("[stale preview response discarded — a slow Mini-suite fetch can't overwrite an already-showing Junior Suite preview]", () => {
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

describe("PublicWidgetChat — preview rendering (format, max 4 thumbnails, count, 0-photo, item 7)", () => {
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
    expect(block).toMatch(/aria-describedby=\{isPreviewing \? `pwc-accsummary-preview-\$\{entry\.accommodationTypeId\}` : undefined\}/);
    expect(block).toMatch(/id=\{`pwc-accsummary-preview-\$\{entry\.accommodationTypeId\}`\}/);
  });
});

describe("PublicWidgetChat — cache (item 3/8: session-local, no localStorage, no global)", () => {
  it("[a plain ref-held Map, keyed by accommodationTypeId, values compatible with openRoomRecommendation]", () => {
    expect(source).toMatch(/const accommodationPhotosCacheRef = useRef<Map<string, RoomRecommendation>>\(new Map\(\)\);/);
  });

  it("[never localStorage/sessionStorage for this cache]", () => {
    const start = source.indexOf("const accommodationPhotosCacheRef");
    const end = source.indexOf(";", start) + 1;
    expect(source.slice(Math.max(0, start - 400), end)).not.toMatch(/localStorage|sessionStorage/);
  });

  it("[single Map instance for the whole cache] never a second, competing cache structure introduced elsewhere", () => {
    expect((source.match(/useRef<Map<string, RoomRecommendation>>/g) ?? []).length).toBe(1);
  });
});

describe("PublicWidgetChat — RoomRecommendation path unchanged (non-régression, TEST D)", () => {
  it("[\"Voir la chambre\" button untouched] still sets openRoomRecommendation directly from message.roomRecommendation, no fetch involved", () => {
    expect(source).toMatch(/onClick=\{\(\) => setOpenRoomRecommendation\(message\.roomRecommendation \?\? null\)\}/);
    expect(source).toMatch(/Voir la chambre — \{message\.roomRecommendation\.name\}/);
  });

  it("[single RoomPhotoModal render site for RoomRecommendation] accommodationSummary's click reuses it, never a second instance for itself — 2 total in the file, the other one is hotelMediaGallery's own (HOTEL_MEDIA CHATBOT chantier)", () => {
    expect((source.match(/<RoomPhotoModal/g) ?? []).length).toBe(2);
  });
});
