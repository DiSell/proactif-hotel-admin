import { beforeEach, describe, expect, it } from "vitest";
import { sessionTokenStorageKey, conversationIdStorageKey, getOrCreateSessionToken } from "./PublicWidgetChat";

/**
 * Real tests, not source-guards: PublicWidgetChat.tsx's storage helpers
 * only touch window.sessionStorage inside function bodies (never at module
 * scope), so importing the module is safe without a DOM — and calling
 * getOrCreateSessionToken for real, against a minimal in-memory
 * sessionStorage fake, proves the actual cross-widget isolation behavior
 * end to end (key construction + persistence + retrieval), not just that
 * the key-naming function looks right in isolation.
 */
class FakeSessionStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

beforeEach(() => {
  // Fresh fake storage per test — simulates one browser tab's
  // sessionStorage, shared across "two widgets" the way it would be if two
  // hotels' iframes were embedded on the same top-level page (both loading
  // from the same Proactif origin).
  (globalThis as unknown as { window: { sessionStorage: FakeSessionStorage } }).window = { sessionStorage: new FakeSessionStorage() };
});

describe("sessionTokenStorageKey / conversationIdStorageKey — namespaced by widgetKey", () => {
  it("two different widgetKeys produce two different storage keys", () => {
    expect(sessionTokenStorageKey("ps_live_hotel_a")).not.toBe(sessionTokenStorageKey("ps_live_hotel_b"));
    expect(conversationIdStorageKey("ps_live_hotel_a")).not.toBe(conversationIdStorageKey("ps_live_hotel_b"));
  });

  it("the session-token key and the conversation-id key never collide with each other, even for the same widgetKey", () => {
    expect(sessionTokenStorageKey("ps_live_hotel_a")).not.toBe(conversationIdStorageKey("ps_live_hotel_a"));
  });

  it("the same widgetKey always produces the same key (stable, not random per call)", () => {
    expect(sessionTokenStorageKey("ps_live_hotel_a")).toBe(sessionTokenStorageKey("ps_live_hotel_a"));
  });
});

describe("getOrCreateSessionToken — cross-widget isolation on a SHARED sessionStorage", () => {
  it("[independent tokens] two different widgetKeys get two independent tokens", () => {
    const tokenA = getOrCreateSessionToken("ps_live_hotel_a");
    const tokenB = getOrCreateSessionToken("ps_live_hotel_b");
    expect(tokenA).not.toBe(tokenB);
  });

  it("[no accidental reuse] widget B mounting AFTER widget A never reads widget A's token, and widget A is unaffected by widget B having run", () => {
    const tokenA = getOrCreateSessionToken("ps_live_hotel_a");
    const tokenB = getOrCreateSessionToken("ps_live_hotel_b");
    expect(tokenB).not.toBe(tokenA);
    expect(getOrCreateSessionToken("ps_live_hotel_a")).toBe(tokenA);
  });

  it("[stable per widgetKey] calling it twice for the SAME widgetKey returns the SAME token — persisted, never silently regenerated", () => {
    const first = getOrCreateSessionToken("ps_live_hotel_a");
    const second = getOrCreateSessionToken("ps_live_hotel_a");
    expect(second).toBe(first);
  });

  it("[real entropy] a freshly generated token is a 64-char lowercase hex string (256 bits)", () => {
    const token = getOrCreateSessionToken("ps_live_hotel_a");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[three widgets, same storage] extends cleanly beyond two — no pairwise-only coincidence", () => {
    const tokenA = getOrCreateSessionToken("ps_live_hotel_a");
    const tokenB = getOrCreateSessionToken("ps_live_hotel_b");
    const tokenC = getOrCreateSessionToken("ps_live_hotel_c");
    expect(new Set([tokenA, tokenB, tokenC]).size).toBe(3);
  });
});
