/**
 * Reads a Request body as text, enforcing a hard byte cap DURING the read —
 * not just validating the parsed value's length afterward. A naive
 * `await request.json()` then `z.string().max(...)` still fully buffers and
 * JSON.parse()s an arbitrarily large body before the length check ever
 * runs, which is itself the resource-exhaustion vector this guards
 * against.
 *
 * Content-Length, when present, is used only as a fast-path rejection —
 * never the sole defense: it's a header the client controls and can omit
 * (or lie about, though a mismatch would just surface as a stream that
 * keeps yielding bytes past what was declared, still caught by the byte
 * counter below) or the request may use chunked transfer-encoding with no
 * Content-Length at all. The actual stream read below enforces the cap
 * regardless of what headers claim.
 */
export type BoundedBodyResult = { ok: true; text: string } | { ok: false; reason: "too_large" };

export async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBodyResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder("utf-8").decode(combined) };
}
