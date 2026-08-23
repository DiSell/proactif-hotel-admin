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
    expect(source).toMatch(/widgetUrl = origin \+ "\/widget\/" \+ encodeURIComponent\(widgetKey\);/);
  });

  it("[minimal DOM footprint] mounts exactly one launcher button and, lazily, one iframe — nothing else appended to the host page", () => {
    const appendCalls = (code.match(/\.appendChild\(/g) ?? []).length;
    expect(appendCalls).toBe(2); // the bubble button, and the iframe (created lazily on first open)
  });
});
