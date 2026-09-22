import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isValidBookingResultMessage } from "./PublicWidgetChat";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PublicWidgetChat.tsx"), "utf8");

/**
 * Real unit test for the one piece of the host-booking bridge that's pure
 * and DOM-independent — the payload shape check. The surrounding
 * event.source/event.origin checks need a real MessageEvent/window and are
 * covered by the widgetScript.test.ts source-guards for the other side of
 * the bridge (public/widget.js) instead — same constraint documented
 * throughout this codebase (vitest's environment is "node", no DOM/jsdom).
 */
describe("isValidBookingResultMessage", () => {
  it("[valid, triggered] accepted", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "triggered" })).toBe(true);
  });

  it("[valid, unavailable] accepted", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "unavailable" })).toBe(true);
  });

  it("[wrong type] rejected", () => {
    expect(isValidBookingResultMessage({ type: "something-else", status: "triggered" })).toBe(false);
  });

  it("[wrong/foreign status] rejected — only 'triggered' and 'unavailable' exist", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "confirmed" })).toBe(false);
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "success" })).toBe(false);
  });

  it("[missing status] rejected", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result" })).toBe(false);
  });

  it("[not an object] rejected — string, number, array, null, undefined", () => {
    expect(isValidBookingResultMessage("proactif:booking-result")).toBe(false);
    expect(isValidBookingResultMessage(42)).toBe(false);
    expect(isValidBookingResultMessage(["proactif:booking-result"])).toBe(false);
    expect(isValidBookingResultMessage(null)).toBe(false);
    expect(isValidBookingResultMessage(undefined)).toBe(false);
  });

  it("[extra fields tolerated on the discriminant check itself, but never used] presence of extra keys doesn't itself cause rejection — this function only checks type/status, callers never read anything else", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "triggered", selector: "#hack" })).toBe(true);
  });
});

/**
 * RACCORDER host_widget chantier — RoomPhotoModal's own Réserver button now
 * reuses this exact same postMessage bridge, via a generalized "modal"
 * sentinel instead of a fabricated numeric message index. Source-level
 * only (no jsdom in this repo — same constraint as every other
 * PublicWidgetChat.*.test.ts file), since requestHostBooking/hostBookingState
 * are closures, not pure exports.
 */
describe("PublicWidgetChat — requestHostBooking generalized for the modal (never a fake numeric index)", () => {
  it("[type widened, never a fabricated index] hostBookingState/requestHostBooking accept number | \"modal\" — a real sentinel, not an invented array position", () => {
    expect(source).toMatch(/const \[hostBookingState, setHostBookingState\] = useState<\{ messageIndex: number \| "modal"; status: "pending" \| "unavailable" \} \| null>\(null\);/);
    expect(source).toMatch(/function requestHostBooking\(messageIndex: number \| "modal"\) \{/);
  });

  it("[single implementation, never duplicated] exactly one requestHostBooking function and one postMessage call for the whole booking bridge — the modal reuses it verbatim", () => {
    expect((source.match(/function requestHostBooking\(/g) ?? []).length).toBe(1);
    expect((source.match(/window\.parent\.postMessage\(\{ type: "proactif:booking" \}, hostOrigin\)/g) ?? []).length).toBe(1);
  });

  it("[generic per-message CTA unchanged] still calls requestHostBooking(index) with the real chat-message array index", () => {
    expect(source).toMatch(/onClick=\{\(\) => requestHostBooking\(index\)\}/);
  });

  it("[modal calls with the \"modal\" sentinel, gated on config.bookingActionMode, never a client-side bookingCtaKind recomputation] no new decision logic invented — only the existing server-provided signal is read", () => {
    expect(source).toMatch(/onBooking=\{config\.bookingActionMode === "host_widget" \? \(\) => requestHostBooking\("modal"\) : undefined\}/);
    // A doc comment may still NAME bookingCtaKind to explain what was deliberately NOT done — never an actual call/import of it.
    expect(source).not.toMatch(/bookingCtaKind\(|import.*bookingCtaKind/);
  });

  it("[concurrency guard reused as-is] the existing \"one in flight at a time\" early-return covers the modal for free — no separate guard invented", () => {
    const fnStart = source.indexOf("function requestHostBooking(");
    const fnBody = source.slice(fnStart, source.indexOf("\n  }", fnStart));
    expect(fnBody).toMatch(/if \(hostBookingState\?\.status === "pending"\) return;/);
  });
});

describe("PublicWidgetChat — modal booking pending/unavailable wiring", () => {
  it("[bookingPending derived from the existing hostBookingState, never a new parallel state]", () => {
    expect(source).toMatch(/bookingPending=\{hostBookingState\?\.messageIndex === "modal" && hostBookingState\.status === "pending"\}/);
  });

  it("[bookingErrorMessage reuses the exact same HOST_BOOKING_UNAVAILABLE_MESSAGE constant as the generic CTA — never a duplicated string]", () => {
    expect(source).toMatch(
      /bookingErrorMessage=\{\s*\n\s*hostBookingState\?\.messageIndex === "modal" && hostBookingState\.status === "unavailable" \? HOST_BOOKING_UNAVAILABLE_MESSAGE : null\s*\n\s*\}/
    );
    expect((source.match(/const HOST_BOOKING_UNAVAILABLE_MESSAGE = /g) ?? []).length).toBe(1);
  });

  it("[generic CTA's own unavailable note untouched] still keyed by messageIndex === index (a real number), independent of the modal's own \"modal\" sentinel", () => {
    expect(source).toMatch(/\{hostBookingState\?\.messageIndex === index && hostBookingState\.status === "unavailable" && \(/);
  });
});

describe("PublicWidgetChat — \"triggered\" closes the modal, never regresses the generic CTA", () => {
  function messageHandlerBlock(): string {
    const start = source.indexOf("function handleMessage(event: MessageEvent) {");
    const end = source.indexOf("window.addEventListener", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("[requestSource captured before the async listener, narrowed once, not reread from state later] avoids relying on a possibly-stale/narrowed hostBookingState inside the closure", () => {
    const effectStart = source.indexOf("if (!hostBookingState || hostBookingState.status !== \"pending\" || !hostOrigin) return;");
    const captureLine = source.indexOf("const requestSource = hostBookingState.messageIndex;", effectStart);
    const handlerStart = source.indexOf("function handleMessage(event: MessageEvent) {", effectStart);
    expect(captureLine).toBeGreaterThan(effectStart);
    expect(handlerStart).toBeGreaterThan(captureLine);
  });

  it("[triggered + modal source] closes RoomPhotoModal via setOpenRoomRecommendation(null), in addition to the existing hostBookingState reset", () => {
    const handler = messageHandlerBlock();
    const elseBranch = handler.slice(handler.indexOf("} else {"));
    expect(elseBranch).toMatch(/if \(requestSource === "modal"\) setOpenRoomRecommendation\(null\);/);
    expect(elseBranch).toMatch(/setHostBookingState\(null\);/);
  });

  it("[triggered + message source] the generic CTA's own trigger never touches openRoomRecommendation — only requestSource === \"modal\" does", () => {
    const handler = messageHandlerBlock();
    const elseBranch = handler.slice(handler.indexOf("} else {"));
    // Exactly one conditional call to setOpenRoomRecommendation, gated on the modal sentinel — never an unconditional close.
    expect((elseBranch.match(/setOpenRoomRecommendation\(null\)/g) ?? []).length).toBe(1);
  });

  it("[unavailable never closes the modal] the \"unavailable\" branch only ever updates hostBookingState's own status — no setOpenRoomRecommendation call anywhere near it", () => {
    const handler = messageHandlerBlock();
    const unavailableBranch = handler.slice(handler.indexOf('if (event.data.status === "unavailable")'), handler.indexOf("} else {"));
    expect(unavailableBranch).not.toMatch(/setOpenRoomRecommendation/);
  });
});

describe("PublicWidgetChat — RoomPhotoModal render site, non-régression", () => {
  it("[bookingUrl/pageUrl/onClose unchanged] the pre-existing props are still passed exactly as before", () => {
    const start = source.indexOf("<RoomPhotoModal");
    const end = source.indexOf("/>", start);
    const block = source.slice(start, end);
    expect(block).toMatch(/name=\{openRoomRecommendation\.name\}/);
    expect(block).toMatch(/photos=\{openRoomRecommendation\.photos\}/);
    expect(block).toMatch(/pageUrl=\{openRoomRecommendation\.pageUrl\}/);
    expect(block).toMatch(/bookingUrl=\{openRoomRecommendation\.bookingUrl\}/);
    expect(block).toMatch(/onClose=\{\(\) => setOpenRoomRecommendation\(null\)\}/);
  });

  it("[single RoomPhotoModal render site for the host_widget case] never a second instance FOR host_widget booking specifically — 2 total in the file, the other one is hotelMediaGallery's own, unrelated RoomPhotoModal (HOTEL_MEDIA CHATBOT chantier)", () => {
    expect((source.match(/<RoomPhotoModal/g) ?? []).length).toBe(2);
  });
});
