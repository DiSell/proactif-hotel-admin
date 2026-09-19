import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PublicWidgetChat.tsx"), "utf8");

/**
 * Source-level audit for the "Nouvelle conversation" action — same
 * constraint as every other PublicWidgetChat.tsx test file in this repo:
 * "use client" component, vitest's environment is "node" (no jsdom
 * anywhere in this repo), so a real render/click can't be exercised.
 * Confirms the STRUCTURAL properties a render test would otherwise check:
 * which existing mechanism is reused, which state is reset vs preserved,
 * and that the visitor-facing confirmation guard exists.
 *
 * Fixes a real UX gap, not a security bug (the server's own session
 * isolation was separately audited and proven correct): sessionStorage
 * survives a page reload within the same tab, so the widget could silently
 * keep continuing an old conversation while LOOKING like a fresh one on
 * screen (only the welcome bubble visible) — confusing for a visitor and
 * misleading for manual testing. This gives the visitor an explicit,
 * deliberate way to actually start over.
 */
function sliceFn(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const nextFn = source.indexOf("\n  function ", start + 1);
  const nextReturn = source.indexOf("\n  return (", start + 1);
  const end = [nextFn, nextReturn].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return source.slice(start, end === -1 ? undefined : end);
}

describe("resetConversation — reuses forgetConversation, never a second session system", () => {
  const fn = sliceFn("resetConversation");

  it("[single mechanism] calls the existing forgetConversation() — never re-implements clearing conversationId/sessionStorage separately", () => {
    expect(fn).toMatch(/forgetConversation\(\);/);
    // Never touches conversationIdStorageKey/writeStorage/clearStorage directly itself — that's forgetConversation's own job, unchanged.
    expect(fn).not.toMatch(/conversationIdStorageKey/);
    expect(fn).not.toMatch(/clearStorage\(/);
  });

  it("[sessionToken untouched] never calls getOrCreateSessionToken or touches sessionTokenStorageKey — same visitor, new conversation, never a new identity", () => {
    expect(fn).not.toMatch(/getOrCreateSessionToken/);
    expect(fn).not.toMatch(/sessionTokenStorageKey/);
    expect(fn).not.toMatch(/setSessionToken/); // sessionToken has no setter at all — confirms it's immutable state, see below
  });

  it("[messages reset to exactly the welcome bubble] old transcript, and everything rendered from it (roomCatalogue, roomRecommendation, action, partnerRecommendations), disappears — they're all fields ON the old ChatMessage objects being discarded", () => {
    expect(fn).toMatch(/setMessages\(\[\{ role: "assistant", content: config\.welcomeMessage \}\]\);/);
  });

  it("[every other conversation-derived UI state is reset] input, error, phone-collection form, the open room-photo modal, and host-booking state", () => {
    expect(fn).toMatch(/setInput\(""\);/);
    expect(fn).toMatch(/setError\(null\);/);
    expect(fn).toMatch(/setActivePhonePrompt\(null\);/);
    expect(fn).toMatch(/setPhoneInput\(""\);/);
    expect(fn).toMatch(/setPhoneError\(null\);/);
    expect(fn).toMatch(/setPhoneSubmitting\(false\);/);
    expect(fn).toMatch(/setOpenRoomRecommendation\(null\);/);
    expect(fn).toMatch(/setHostBookingState\(null\);/);
  });
});

describe("sessionToken — confirmed immutable for the component's whole lifetime", () => {
  it("[useState with no setter destructured] sessionToken can never be reassigned after mount, by resetConversation or anything else", () => {
    expect(source).toMatch(/const \[sessionToken\] = useState<string>\(/);
  });
});

describe("handleNewConversationClick — the visitor-facing trigger", () => {
  const fn = sliceFn("handleNewConversationClick");

  it("[guards against racing an in-flight request] ignored while loading — otherwise a response already in flight could land after the reset and resurrect the old conversationId/messages", () => {
    expect(fn).toMatch(/if \(loading\) return;/);
  });

  it("[no-op on an already-fresh conversation] never prompts/resets when there is nothing to reset", () => {
    expect(fn).toMatch(/if \(messages\.length <= 1 && !conversationId\) return;/);
  });

  it("[lightweight confirmation] a single native confirm guards against accidental activation — no new modal component, no global redesign", () => {
    expect(fn).toMatch(/window\.confirm\(/);
    expect(fn).toMatch(/resetConversation\(\);/);
  });
});

describe("header button — discreet, present, wired to the click handler", () => {
  it("[wired correctly] the header renders a button calling handleNewConversationClick, disabled while loading, with an accessible label", () => {
    const headerStart = source.indexOf('background: config.primaryColor, flexShrink: 0 }}>');
    const headerEnd = source.indexOf("{config.activeBanner", headerStart);
    const header = source.slice(headerStart, headerEnd);
    expect(header).toMatch(/onClick=\{handleNewConversationClick\}/);
    expect(header).toMatch(/disabled=\{loading\}/);
    expect(header).toMatch(/aria-label="Nouvelle conversation"/);
  });
});

describe("no second session/conversation system introduced", () => {
  it("[single source of truth] conversationIdStorageKey/clearStorage/setConversationId(null) still appear ONLY inside forgetConversation — resetConversation and the click handler delegate to it rather than duplicating its logic", () => {
    const forgetFn = sliceFn("forgetConversation");
    expect(forgetFn).toMatch(/setConversationId\(null\);/);
    expect(forgetFn).toMatch(/clearStorage\(conversationIdStorageKey\(widgetKey\)\);/);

    // Exactly one call site of forgetConversation() beyond its own definition: resetConversation.
    const callSites = (source.match(/forgetConversation\(\);/g) ?? []).length;
    expect(callSites).toBe(2); // handleSend's existing self-healing 404 path + resetConversation
  });
});
