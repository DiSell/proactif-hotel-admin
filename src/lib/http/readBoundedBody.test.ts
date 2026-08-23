import { describe, expect, it } from "vitest";
import { readBoundedBody } from "./readBoundedBody";

function requestWithBody(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://widget.test/api/widget/ps_live_test/chat", {
    method: "POST",
    body,
    headers,
  });
}

describe("readBoundedBody", () => {
  it("returns the full text when the body is under the limit", async () => {
    const result = await readBoundedBody(requestWithBody('{"message":"hello"}'), 1024);
    expect(result).toEqual({ ok: true, text: '{"message":"hello"}' });
  });

  it("[fast path] rejects immediately based on a Content-Length that exceeds the limit, without needing to read the stream", async () => {
    // Content-Length is set automatically by the Request constructor from
    // the body string — this exercises the real header-based fast path.
    const bigBody = "x".repeat(2000);
    const result = await readBoundedBody(requestWithBody(bigBody), 100);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("[stream cap, not header-trusting] rejects a body whose ACTUAL byte count exceeds the limit even when read via the stream, not just via Content-Length", async () => {
    // Exactly at the boundary: 101 bytes of ASCII against a 100-byte cap —
    // proves the cap is enforced by real byte counting, not an off-by-one.
    const body = "a".repeat(101);
    const result = await readBoundedBody(requestWithBody(body), 100);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("accepts a body exactly at the limit (boundary is inclusive)", async () => {
    const body = "a".repeat(100);
    const result = await readBoundedBody(requestWithBody(body), 100);
    expect(result).toEqual({ ok: true, text: body });
  });

  it("[no Content-Length] still enforces the cap via the stream when Content-Length is absent — a raw client can omit or lie about it", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(60)));
        controller.enqueue(new TextEncoder().encode("a".repeat(60))); // 120 bytes total across two chunks, no Content-Length header
        controller.close();
      },
    });
    const request = new Request("http://widget.test/api/widget/ps_live_test/chat", {
      method: "POST",
      // @ts-expect-error - Node's Request type requires duplex for a streaming body; this is the standard workaround for a runtime-supported option not yet reflected in the DOM lib types used here.
      duplex: "half",
      body: stream,
    });
    expect(request.headers.get("content-length")).toBeNull();

    const result = await readBoundedBody(request, 100);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("handles an empty body", async () => {
    const request = new Request("http://widget.test/api/widget/ps_live_test/chat", { method: "POST" });
    const result = await readBoundedBody(request, 100);
    expect(result).toEqual({ ok: true, text: "" });
  });

  it("correctly assembles multi-byte UTF-8 content split across chunk boundaries", async () => {
    // "café ☕" — encode once, split the encoded bytes (not the string) so a
    // multi-byte character can straddle a chunk boundary the way it would
    // over a real network stream.
    const encoded = new TextEncoder().encode("café ☕ réservation");
    const mid = Math.floor(encoded.byteLength / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, mid));
        controller.enqueue(encoded.slice(mid));
        controller.close();
      },
    });
    const request = new Request("http://widget.test/api/widget/ps_live_test/chat", {
      method: "POST",
      // @ts-expect-error - see duplex note above.
      duplex: "half",
      body: stream,
    });

    const result = await readBoundedBody(request, 1024);
    expect(result).toEqual({ ok: true, text: "café ☕ réservation" });
  });
});
