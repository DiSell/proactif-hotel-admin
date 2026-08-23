import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { isIpForbidden, resolveAndValidateHost, safeFetch, safeFetchBinary } from "./networkGuard";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
function webpBytes(): Buffer {
  const buf = Buffer.alloc(16);
  buf.write("RIFF", 0, "ascii");
  buf.write("WEBP", 8, "ascii");
  return buf;
}

describe("isIpForbidden", () => {
  it("rejects IPv4 loopback", () => {
    expect(isIpForbidden("127.0.0.1")).toBe(true);
    expect(isIpForbidden("127.0.0.53")).toBe(true);
  });

  it("rejects 0.0.0.0", () => {
    expect(isIpForbidden("0.0.0.0")).toBe(true);
  });

  it("rejects RFC1918 private IPv4 ranges", () => {
    expect(isIpForbidden("10.0.0.1")).toBe(true);
    expect(isIpForbidden("172.16.0.1")).toBe(true);
    expect(isIpForbidden("172.31.255.255")).toBe(true);
    expect(isIpForbidden("192.168.1.1")).toBe(true);
  });

  it("rejects IPv4 link-local, including the cloud metadata address", () => {
    expect(isIpForbidden("169.254.169.254")).toBe(true);
    expect(isIpForbidden("169.254.1.1")).toBe(true);
  });

  it("rejects IPv6 loopback and unique-local and link-local", () => {
    expect(isIpForbidden("::1")).toBe(true);
    expect(isIpForbidden("fc00::1")).toBe(true);
    expect(isIpForbidden("fd12:3456:789a::1")).toBe(true);
    expect(isIpForbidden("fe80::1")).toBe(true);
  });

  it("rejects an IPv4-mapped IPv6 address pointing at a private range", () => {
    expect(isIpForbidden("::ffff:10.0.0.1")).toBe(true);
    expect(isIpForbidden("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows ordinary public IPv4 and IPv6 addresses", () => {
    expect(isIpForbidden("8.8.8.8")).toBe(false);
    expect(isIpForbidden("1.1.1.1")).toBe(false);
    expect(isIpForbidden("2606:4700:4700::1111")).toBe(false);
  });

  it("fails closed on garbage input", () => {
    expect(isIpForbidden("not-an-ip")).toBe(true);
    expect(isIpForbidden("")).toBe(true);
  });
});

describe("resolveAndValidateHost", () => {
  it("rejects a literal private IPv4 hostname without needing DNS", async () => {
    const result = await resolveAndValidateHost("192.168.1.1");
    expect(result.safe).toBe(false);
  });

  it("rejects a literal loopback IPv6 hostname without needing DNS", async () => {
    const result = await resolveAndValidateHost("::1");
    expect(result.safe).toBe(false);
  });
});

describe("safeFetch", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects disallowed protocols before ever calling fetch", async () => {
    const result = await safeFetch("file:///etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("protocol_not_allowed");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects javascript: URLs", async () => {
    const result = await safeFetch("javascript:alert(1)");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("protocol_not_allowed");
  });

  it("rejects a direct request to a loopback address before calling fetch", async () => {
    const result = await safeFetch("http://127.0.0.1:8080/admin");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("network_unsafe");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a request whose hostname is a private IPv6 literal", async () => {
    const result = await safeFetch("http://[fc00::1]/");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("network_unsafe");
  });

  it("follows a redirect but rejects it once it points at a private address, without ever calling fetch on the unsafe hop", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } })
    );

    const result = await safeFetch("http://1.1.1.1/redirect-me");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("network_unsafe");
    // Only the first (safe) hop should have reached fetch() — the unsafe redirect target never should.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("safeFetchBinary", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects a direct request to a private address before calling fetch — same SSRF guard as safeFetch", async () => {
    const result = await safeFetchBinary("http://127.0.0.1/photo.jpg");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("network_unsafe");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("follows a redirect but rejects it once it points at a private address, without ever calling fetch on the unsafe hop", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal.jpg" } }));

    const result = await safeFetchBinary("http://1.1.1.1/redirect-me.jpg");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("network_unsafe");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid JPEG with a matching Content-Type, and returns its SHA-256 content hash", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(new Response(JPEG_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } }));

    const result = await safeFetchBinary("https://example.com/room.jpg");
    expect(result.ok).toBe(true);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.contentHash).toBe(createHash("sha256").update(JPEG_BYTES).digest("hex"));
  });

  it("accepts a valid PNG and a valid WebP", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }));
    expect((await safeFetchBinary("https://example.com/a.png")).ok).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(webpBytes() as BodyInit, { status: 200, headers: { "content-type": "image/webp" } }));
    expect((await safeFetchBinary("https://example.com/b.webp")).ok).toBe(true);
  });

  it("[content type allow-list] rejects SVG even though it's a common web image format", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(
      new Response("<svg onload='alert(1)'></svg>", { status: 200, headers: { "content-type": "image/svg+xml" } })
    );
    const result = await safeFetchBinary("https://example.com/room.svg");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("unsupported_content_type");
  });

  it("[content type allow-list] rejects an unrelated content type (e.g. HTML)", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const result = await safeFetchBinary("https://example.com/not-an-image");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("unsupported_content_type");
  });

  it("[magic bytes] never trusts the declared Content-Type alone — rejects bytes that don't match the claimed type", async () => {
    const fetchMock = vi.mocked(global.fetch);
    const notActuallyAJpeg = Buffer.from("this is definitely not a jpeg file, just plain text padded out");
    fetchMock.mockResolvedValueOnce(new Response(notActuallyAJpeg, { status: 200, headers: { "content-type": "image/jpeg" } }));

    const result = await safeFetchBinary("https://example.com/fake.jpg");
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBe("content_type_mismatch");
  });
});
