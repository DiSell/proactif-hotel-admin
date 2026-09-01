import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PublicWidgetChat.tsx"), "utf8");

/**
 * Source-level audit for the structured phone-collection form — same
 * constraint as PublicWidgetChat.hostBooking.test.ts: this is a "use
 * client" component and vitest's environment is "node" (no jsdom anywhere
 * in this repo), so interactive/render behavior can't be exercised via a
 * real render. Pure, DOM-independent logic is tested directly where it
 * exists (see phoneRedaction.test.ts, partnerRequestFlow.test.ts); this
 * file checks the STRUCTURAL properties a render test would otherwise
 * check: which endpoint is called, what guards exist, what state changes
 * on success/failure.
 */
function sliceFn(name: string, nextMarker: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(nextMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("phone form — dedicated endpoint, never the chat message path", () => {
  it("[handleSubmitPhone posts to the dedicated partner-request/phone endpoint for a partner_request prompt] never /chat — the endpoint is now chosen dynamically by activePhonePrompt.kind (partner_request vs spa_booking, see features/rag/spaBookingFlow.ts), but the literal partner-request/phone path is still one of the two branches", () => {
    const fn = sliceFn("handleSubmitPhone", "return (");
    expect(fn).toMatch(/"partner-request\/phone"/);
    expect(fn).toMatch(/\/api\/widget\/\$\{encodeURIComponent\(widgetKey\)\}\/\$\{path\}/);
  });

  it("[phone sent only in the dedicated request body] conversationId/sessionToken/phone/pendingRequest — never appended to a chat message", () => {
    const fn = sliceFn("handleSubmitPhone", "return (");
    expect(fn).toMatch(/conversationId, sessionToken, phone: trimmed, pendingRequest: activePhonePrompt\.prompt\.pendingRequest/);
  });

  it("[pendingRequest echoed verbatim from the prompt the widget was shown] never hand-assembled from other component state", () => {
    const fn = sliceFn("handleSubmitPhone", "return (");
    expect(fn).toMatch(/activePhonePrompt\.prompt\.pendingRequest/);
  });
});

describe("phone form — double-submit guard", () => {
  it("[handleSubmitPhone guards on phoneSubmitting at the top, same pattern as handleSend's own loading guard]", () => {
    expect(source).toMatch(/if \(!trimmed \|\| phoneSubmitting \|\| !activePhonePrompt \|\| !conversationId \|\| !sessionToken\) return;/);
  });

  it("[button disabled while submitting] disabled={phoneSubmitting || phoneInput.trim().length === 0}", () => {
    expect(source).toMatch(/disabled=\{phoneSubmitting \|\| phoneInput\.trim\(\)\.length === 0\}/);
  });

  it("[input disabled while submitting] the phone field itself is also disabled during submit, not just the button", () => {
    const start = source.indexOf('type="tel"');
    const end = source.indexOf("/>", start);
    expect(source.slice(start, end)).toMatch(/disabled=\{phoneSubmitting\}/);
  });
});

describe("phone form — visibility gate", () => {
  it("[never unconditionally rendered] gated on activePhonePrompt, a deterministic backend signal, never a parsed reply string", () => {
    expect(source).toMatch(/\{activePhonePrompt && \(/);
  });

  it("[cleared on a fresh chat turn] handleSend resets activePhonePrompt before its own request, and sets it from the response's own field afterward (partner_request or spa_booking, never both) — never left stale from an earlier, no-longer-relevant turn", () => {
    const fn = sliceFn("handleSend", "async function handleSubmitPhone");
    expect(fn).toMatch(/setActivePhonePrompt\(null\);/);
    expect(fn).toMatch(/setActivePhonePrompt\(\{ kind: "partner_request", prompt: data\.partnerRequestPhonePrompt \}\);/);
    expect(fn).toMatch(/setActivePhonePrompt\(\{ kind: "spa_booking", prompt: data\.spaBookingPhonePrompt \}\);/);
  });

  it("[cleared on successful phone submission] the form disappears after success", () => {
    const fn = sliceFn("handleSubmitPhone", "async function handleSend".length > 0 ? "return (" : "return (");
    expect(fn).toMatch(/setActivePhonePrompt\(null\);/);
  });
});

describe("phone form — PII/UX requirements", () => {
  it("[mandatory consent sentence present verbatim]", () => {
    expect(source).toContain("Votre numéro sera utilisé uniquement pour transmettre cette demande et vous communiquer la réponse du partenaire.");
  });

  it("[never renders/logs a full phone number] the widget only ever sends the visitor's own freshly-typed input, never redisplays a stored number", () => {
    expect(source).not.toMatch(/console\.(log|error)\([^)]*phone/i);
  });

  it("[success appends the server's own message, never the raw phone] the recap comes from body.message (server-authored), the component never constructs its own recap text", () => {
    const fn = sliceFn("handleSubmitPhone", "return (");
    expect(fn).toMatch(/content: body\.message/);
  });

  it("[not a modal] the phone form is a plain inline block in the message flow, not a portal/overlay component", () => {
    expect(source).not.toMatch(/activePhonePrompt[\s\S]{0,80}position:\s*["']fixed["']/);
  });
});

describe("phone form — never mixed into the normal chat send path", () => {
  it("[free-text safety net untouched] handleSend still posts the visitor's own typed message to /chat as before — phoneRedaction.ts's server-side redaction remains the fallback for a spontaneously-typed number", () => {
    const fn = sliceFn("handleSend", "async function handleSubmitPhone");
    expect(fn).toMatch(/\/api\/widget\/\$\{encodeURIComponent\(widgetKey\)\}\/chat/);
    expect(fn).toMatch(/message: trimmed/);
    // handleSend's own fetch call body — narrower than the full slice
    // (which, up to the next function marker, also incidentally includes
    // handleSubmitPhone's own doc comment, itself legitimately mentioning
    // the phone endpoint in prose) — never sends `phone` as a fetch body key.
    const fetchCallStart = fn.indexOf("fetch(");
    const fetchCallEnd = fn.indexOf("});", fetchCallStart);
    expect(fn.slice(fetchCallStart, fetchCallEnd)).not.toMatch(/partner-request\/phone/);
  });
});
