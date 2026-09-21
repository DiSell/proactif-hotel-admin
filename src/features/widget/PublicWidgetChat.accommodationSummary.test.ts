import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PublicWidgetChat.tsx"), "utf8");

/**
 * INFORMATION DÉTERMINISTE + CATÉGORIES INFORMATION CLIQUABLES chantiers —
 * source-level (no jsdom in this repo, same constraint as
 * PublicWidgetChat.roomCatalogue.test.ts). Proves the summary is rendered,
 * visually distinct from roomCatalogue's cards, AND (this chantier) that
 * each row is a real clickable/focusable button wired to an on-demand photo
 * fetch reusing RoomRecommendation's own modal/state — never a second
 * modal, never a preloaded photos field on accommodationSummary itself.
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
    expect(source).toMatch(/interface RoomCatalogueEntry \{[\s\S]*?accommodationTypeId: string;[\s\S]*?name: string;[\s\S]*?pageUrl: string \| null;[\s\S]*?maxGuests: number \| null;[\s\S]*?\}/);
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

  it("[visually distinct from roomCatalogue — mobile-light, no cards] no border/background-per-entry card style, unlike roomCatalogue", () => {
    const block = accommodationSummaryBlock();
    expect(block).not.toMatch(/border: "1px solid/);
    expect(block).not.toMatch(/background: "#fff"/);

    // roomCatalogue's own card block, for contrast — confirms the two really do differ.
    const catalogueBlockStart = source.indexOf("message.roomCatalogue && message.roomCatalogue.length > 0");
    const catalogueBlockEnd = source.indexOf("))}", catalogueBlockStart);
    const catalogueBlock = source.slice(catalogueBlockStart, catalogueBlockEnd);
    expect(catalogueBlock).toMatch(/border: "1px solid/);
    expect(catalogueBlock).toMatch(/background: "#fff"/);
  });

  it("[never duplicates roomCatalogue's own no-price/no-description guarantee] no description, no price anywhere in this block", () => {
    const block = accommodationSummaryBlock();
    expect(block).not.toMatch(/description/i);
    expect(block).not.toMatch(/€|\bEUR\b|\bprice\b/i);
  });

  it("[independent field, never both non-empty rendering blocks confused] roomCatalogue and accommodationSummary are two separate conditional blocks in the JSX, each keyed on its own field", () => {
    const roomCatalogueCount = (source.match(/message\.roomCatalogue && message\.roomCatalogue\.length > 0/g) ?? []).length;
    const summaryCount = (source.match(/message\.accommodationSummary && message\.accommodationSummary\.length > 0/g) ?? []).length;
    expect(roomCatalogueCount).toBe(1);
    expect(summaryCount).toBe(1);
  });
});

describe("PublicWidgetChat — accommodationSummary rows are real, accessible buttons (TEST B / item 6)", () => {
  it("[real <button>] each row is a native <button type=\"button\">, not a <div> — free Tab/Enter/Space support, no custom key handling needed", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/<button\s*\n\s*key=\{entry\.accommodationTypeId\}\s*\n\s*type="button"/);
  });

  it("[aria-label] each button carries an explicit, dynamic aria-label naming the category — never a hardcoded name", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/aria-label=\{`Voir les photos de \$\{entry\.name\}`\}/);
  });

  it("[full row clickable] width: 100% on the button itself — the whole row is the tappable target, never just the name text", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/width: "100%"/);
  });

  it("[chevron, discreet interactivity hint] a '›' marker, hidden from assistive tech (aria-hidden), swapped for a loading indicator while fetching", () => {
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/aria-hidden="true"[\s\S]*?\{isLoading \? "…" : "›"\}/);
  });

  it("[hover/focus styling exists, scoped to this row only] a dedicated CSS class with :hover/:focus-visible rules — inline styles alone can't express these", () => {
    expect(source).toMatch(/\.pwc-accsummary-row:hover:not\(:disabled\)/);
    expect(source).toMatch(/\.pwc-accsummary-row:focus-visible/);
    const block = accommodationSummaryBlock();
    expect(block).toMatch(/className="pwc-accsummary-row"/);
  });
});

describe("PublicWidgetChat — handleAccommodationSummaryClick (TEST B: fetch/loading/error/0-photo)", () => {
  function handlerBlock(): string {
    const start = source.indexOf("async function handleAccommodationSummaryClick");
    const end = source.indexOf("async function handleSubmitPhone");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("[calls the new route with the exact accommodationTypeId] never a different id, never a guessed URL", () => {
    const fn = handlerBlock();
    expect(fn).toMatch(
      /`\/api\/widget\/\$\{encodeURIComponent\(widgetKey\)\}\/room-photos\?accommodationTypeId=\$\{encodeURIComponent\(entry\.accommodationTypeId\)\}`/
    );
  });

  it("[loading set before fetch, cleared after] setLoadingAccommodationTypeId(entry.accommodationTypeId) runs before the fetch; cleared in a finally-equivalent path regardless of outcome", () => {
    const fn = handlerBlock();
    const setLoadingIndex = fn.indexOf("setLoadingAccommodationTypeId(entry.accommodationTypeId)");
    const fetchIndex = fn.indexOf("await fetch(");
    expect(setLoadingIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeGreaterThan(setLoadingIndex);
    expect(fn).toMatch(/finally \{\s*\n\s*if \(accommodationSummaryRequestRef\.current === requestId\) setLoadingAccommodationTypeId\(null\);/);
  });

  it("[reuses openRoomRecommendation, never a second modal state] the fetched result is passed straight to setOpenRoomRecommendation, the exact state RoomRecommendation's own \"Voir la chambre\" button already uses", () => {
    const fn = handlerBlock();
    expect(fn).toMatch(/setOpenRoomRecommendation\(data\);/);
    // No second modal-open state introduced anywhere in the file.
    expect((source.match(/useState<RoomRecommendation \| null>/g) ?? []).length).toBe(1);
  });

  it("[network/HTTP error -> no fake empty modal] a non-ok response or a thrown error sets the existing generic `error` state and returns WITHOUT calling setOpenRoomRecommendation", () => {
    const fn = handlerBlock();
    const notOkIndex = fn.indexOf("if (!response.ok)");
    const notOkBlockEnd = fn.indexOf("}", fn.indexOf("return;", notOkIndex));
    const notOkBlock = fn.slice(notOkIndex, notOkBlockEnd);
    expect(notOkBlock).toMatch(/setError\(/);
    expect(notOkBlock).not.toMatch(/setOpenRoomRecommendation/);

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

describe("PublicWidgetChat — race condition guard (TEST C)", () => {
  function handlerBlock(): string {
    const start = source.indexOf("async function handleAccommodationSummaryClick");
    const end = source.indexOf("async function handleSubmitPhone");
    return source.slice(start, end);
  }

  it("[monotonic request token] a ref incremented at the very start of every call, captured locally as requestId, before the loading state or the fetch itself", () => {
    expect(source).toMatch(/const accommodationSummaryRequestRef = useRef\(0\);/);
    const fn = handlerBlock();
    const requestIdIndex = fn.indexOf("const requestId = accommodationSummaryRequestRef.current + 1;");
    const assignIndex = fn.indexOf("accommodationSummaryRequestRef.current = requestId;");
    const loadingIndex = fn.indexOf("setLoadingAccommodationTypeId(entry.accommodationTypeId);");
    const fetchIndex = fn.indexOf("await fetch(");
    expect(requestIdIndex).toBeGreaterThan(-1);
    expect(assignIndex).toBeGreaterThan(requestIdIndex);
    expect(loadingIndex).toBeGreaterThan(assignIndex);
    expect(fetchIndex).toBeGreaterThan(loadingIndex);
  });

  it("[stale response after fetch discarded] checked immediately after the fetch resolves, before response.ok is even inspected", () => {
    const fn = handlerBlock();
    const fetchIndex = fn.indexOf("await fetch(");
    const firstGuardIndex = fn.indexOf("if (accommodationSummaryRequestRef.current !== requestId) return;", fetchIndex);
    const okCheckIndex = fn.indexOf("if (!response.ok)");
    expect(firstGuardIndex).toBeGreaterThan(fetchIndex);
    expect(firstGuardIndex).toBeLessThan(okCheckIndex);
  });

  it("[stale response after response.json() also discarded] a second guard after parsing the body, before setOpenRoomRecommendation", () => {
    const fn = handlerBlock();
    const jsonIndex = fn.indexOf("await response.json()");
    const openIndex = fn.indexOf("setOpenRoomRecommendation(data);");
    const secondGuardIndex = fn.indexOf("if (accommodationSummaryRequestRef.current !== requestId) return;", jsonIndex);
    expect(secondGuardIndex).toBeGreaterThan(jsonIndex);
    expect(secondGuardIndex).toBeLessThan(openIndex);
  });

  it("[stale loading indicator never cleared by a superseded request] the finally block only clears loading if this request is STILL the current one", () => {
    const fn = handlerBlock();
    expect(fn).toMatch(/finally \{\s*\n\s*if \(accommodationSummaryRequestRef\.current === requestId\) setLoadingAccommodationTypeId\(null\);\s*\n\s*\}/);
  });
});

describe("PublicWidgetChat — RoomRecommendation path unchanged (non-régression, TEST D)", () => {
  it("[\"Voir la chambre\" button untouched] still sets openRoomRecommendation directly from message.roomRecommendation, no fetch involved", () => {
    expect(source).toMatch(/onClick=\{\(\) => setOpenRoomRecommendation\(message\.roomRecommendation \?\? null\)\}/);
    expect(source).toMatch(/Voir la chambre — \{message\.roomRecommendation\.name\}/);
  });

  it("[single RoomPhotoModal render site] only one <RoomPhotoModal ...> in the whole file — accommodationSummary's click reuses it, never a second instance", () => {
    expect((source.match(/<RoomPhotoModal/g) ?? []).length).toBe(1);
  });
});
