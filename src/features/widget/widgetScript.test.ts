import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Not under src/ — vitest's include pattern only covers src/**/*.test.ts,
// so this file lives in src/ but reads the real embed script from public/,
// same pattern as the migration source-guard tests reading .sql files
// outside src/ (e.g. integrationsMigration.test.ts).
const source = readFileSync(join(here, "../../../public/widget.js"), "utf8");
// The header doc comment deliberately discusses what this script does NOT
// do (e.g. "never inserts anything ... via innerHTML") — stripped before
// matching, same lesson as the migration source-guard tests elsewhere in
// this repo.
const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * public/widget.js runs in an arbitrary third-party host page, outside any
 * test runner this repo has (vitest's environment is "node", no DOM/jsdom —
 * see vitest.config.mts). These are source-level guards, not a DOM
 * execution test.
 */
describe("public/widget.js — embed script", () => {
  it("[widgetKey source] reads the key from this script tag's own data-key attribute — matches the snippet already shown in WidgetSettingsForm.tsx (data-key, not data-widget-key)", () => {
    expect(source).toMatch(/document\.currentScript/);
    expect(source).toMatch(/getAttribute\("data-key"\)/);
  });

  it("[same-origin] derives the API/page origin from this script's own src, never a hardcoded or user-suppliable domain", () => {
    expect(source).toMatch(/new URL\(currentScript\.src\)\.origin/);
  });

  it("[widgetKey never inserted as HTML] the only use of widgetKey is as a URL path segment, encodeURIComponent'd — never innerHTML/outerHTML/document.write", () => {
    expect(source).toMatch(/encodeURIComponent\(widgetKey\)/);
    expect(code).not.toMatch(/innerHTML/);
    expect(code).not.toMatch(/outerHTML/);
    expect(code).not.toMatch(/document\.write/);
  });

  it("[no dynamic code execution] never eval()s or Function()-constructs anything", () => {
    expect(code).not.toMatch(/\beval\(/);
    expect(code).not.toMatch(/new Function\(/);
  });

  it("[iframe, not injected markup] the chat itself is an <iframe> pointed at /widget/<key>, not HTML built from a string", () => {
    expect(source).toMatch(/createElement\("iframe"\)/);
    expect(source).toMatch(/iframe\.src = widgetUrl;/);
    expect(source).toMatch(
      /widgetUrl = origin \+ "\/widget\/" \+ encodeURIComponent\(widgetKey\) \+ "\?hostOrigin=" \+ encodeURIComponent\(hostOrigin\);/
    );
  });

  it("[minimal DOM footprint] mounts exactly one launcher button and, lazily, one iframe — nothing else appended to the host page", () => {
    const appendCalls = (code.match(/\.appendChild\(/g) ?? []).length;
    expect(appendCalls).toBe(2); // the bubble button, and the iframe (created lazily on first open)
  });
});

/**
 * Host-booking bridge — closed postMessage contract between the chat
 * iframe (Proactif's own origin) and this script (runs on the HOTEL's
 * page). Same source-guard constraint as the rest of this file: no DOM/
 * jsdom in this vitest environment, so these check the actual shipped
 * validation logic textually rather than executing it.
 */
describe("public/widget.js — host-booking bridge", () => {
  it("[hostOrigin] derived from window.location.origin (the HOST page's own origin, not Proactif's) and appended to the iframe URL, encoded", () => {
    expect(source).toMatch(/var hostOrigin = window\.location\.origin;/);
    expect(source).toMatch(/encodeURIComponent\(hostOrigin\)/);
  });

  it("[config fetched independently] widget.js fetches its own config from the public endpoint — the selector never travels through postMessage", () => {
    expect(source).toMatch(/fetch\(origin \+ "\/api\/widget\/" \+ encodeURIComponent\(widgetKey\) \+ "\/config"\)/);
  });

  it("[incoming message validation] requires event.source to be exactly this script's own iframe.contentWindow", () => {
    expect(source).toMatch(/event\.source !== iframe\.contentWindow/);
  });

  it("[incoming message validation] requires event.origin to be exactly Proactif's own derived origin — never accepts an arbitrary/unchecked origin", () => {
    expect(source).toMatch(/event\.origin !== origin/);
  });

  it("[incoming message validation] requires event.data to be a plain object with the exact closed type — no other shape is handled", () => {
    expect(source).toMatch(/!event\.data \|\| typeof event\.data !== "object"/);
    expect(source).toMatch(/event\.data\.type !== "proactif:booking"/);
  });

  it("[no selector ever accepted from postMessage] the only place `trigger.selector` is read comes from configPromise (the fetched config), never from event.data", () => {
    const messageListenerStart = source.indexOf('window.addEventListener("message"');
    const messageListenerEnd = source.indexOf("});", messageListenerStart);
    const messageListenerBody = source.slice(messageListenerStart, messageListenerEnd);
    expect(messageListenerBody).not.toMatch(/selector/);
    expect(messageListenerBody).not.toMatch(/event\.data\.trigger/);
  });

  it("[reply targetOrigin is precise] postResult always targets Proactif's own derived `origin`, never \"*\"", () => {
    const postResultStart = source.indexOf("function postResult");
    const postResultEnd = source.indexOf("\n  }", postResultStart);
    const postResultBody = source.slice(postResultStart, postResultEnd);
    expect(postResultBody).toMatch(/postMessage\(\{ type: "proactif:booking-result", status: status \}, origin\)/);
    expect(postResultBody).not.toMatch(/"\*"/);
  });

  it("[outgoing reply status is closed] only ever \"triggered\" or \"unavailable\" — grep for every postResult(...) call site", () => {
    const calls = source.match(/postResult\("([^"]*)"\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call === 'postResult("triggered")' || call === 'postResult("unavailable")').toBe(true);
    }
  });

  it("[selector strategy is closed to \"click\"] rejects (unavailable) any strategy other than the literal \"click\" — no generic DOM-action list", () => {
    expect(source).toMatch(/trigger\.strategy !== "click"/);
    // Never a lookup table / dispatch map keyed by strategy — a single
    // literal comparison is the entire "strategy" surface.
    expect(code).not.toMatch(/strategies\s*=\s*\{/);
    expect(code).not.toMatch(/\[trigger\.strategy\]/);
  });

  it("[selector used only as a CSS selector, never as code] the sole DOM operation triggerHostBooking performs on the resolved element is el.click() — never eval/Function/innerHTML/setAttribute from the fetched config", () => {
    expect(source).toMatch(/document\.querySelector\(trigger\.selector\)/);
    expect(source).toMatch(/el\.click\(\)/);
    expect(code).not.toMatch(/\beval\(/);
    expect(code).not.toMatch(/new Function\(/);
    expect(code).not.toMatch(/innerHTML/);

    const triggerFnStart = code.indexOf("function triggerHostBooking");
    const triggerFnEnd = code.indexOf("window.addEventListener", triggerFnStart);
    const triggerFnBody = code.slice(triggerFnStart, triggerFnEnd);
    expect(triggerFnBody).not.toMatch(/setAttribute\(/);
  });

  it("[selector lookup never throws past the caller] document.querySelector is wrapped in try/catch — a malformed selector degrades to unavailable, not an uncaught error", () => {
    const triggerFnStart = source.indexOf("function triggerHostBooking");
    const triggerFnEnd = source.indexOf("\n  window.addEventListener", triggerFnStart);
    const triggerFnBody = source.slice(triggerFnStart, triggerFnEnd);
    expect(triggerFnBody).toMatch(/try\s*\{[\s\S]*?document\.querySelector\(trigger\.selector\)[\s\S]*?\}\s*catch/);
  });

  it("[element not found] neither closeWidget() nor el.click() is reachable before the null-check — element absence never touches the DOM or closes the chat", () => {
    const triggerFnStart = source.indexOf("function triggerHostBooking");
    const triggerFnEnd = source.indexOf("\n  window.addEventListener", triggerFnStart);
    const triggerFnBody = source.slice(triggerFnStart, triggerFnEnd);
    const notFoundCheckIndex = triggerFnBody.indexOf("if (!el)");
    const closeWidgetCallIndex = triggerFnBody.indexOf("closeWidget();");
    const clickCallIndex = triggerFnBody.indexOf("el.click();");
    expect(notFoundCheckIndex).toBeGreaterThan(-1);
    expect(closeWidgetCallIndex).toBeGreaterThan(notFoundCheckIndex);
    expect(clickCallIndex).toBeGreaterThan(notFoundCheckIndex);
  });
});
