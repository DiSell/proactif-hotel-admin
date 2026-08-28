/**
 * Validates the `hostOrigin` query param public/widget.js appends to the
 * iframe URL (`?hostOrigin=<encodeURIComponent(window.location.origin)>`)
 * when it creates the iframe. This is the ONLY use this value ever has
 * anywhere: the exact `targetOrigin` PublicWidgetChat.tsx passes to
 * `window.parent.postMessage(...)` for the host-booking bridge — never
 * rendered, never used to build a navigable URL, never treated as HTML or
 * a DOM selector.
 *
 * Deliberately narrow: only http/https accepted (rejects javascript:,
 * data:, file:, and anything else `new URL()` would otherwise happily
 * parse), and the return value is `.origin` reconstructed FROM the parsed
 * URL — never the raw string verbatim — so a value carrying a path/query/
 * hash/credentials alongside a valid origin is normalized down to just the
 * origin, not rejected or passed through with the extra parts intact.
 */
export function parseHostOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  return url.origin;
}
