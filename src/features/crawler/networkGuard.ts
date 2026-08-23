import { promises as dns } from "node:dns";
import { createHash } from "node:crypto";
import ipaddr from "ipaddr.js";
import { MAX_HTML_SIZE_BYTES, MAX_IMAGE_SIZE_BYTES, MAX_REDIRECTS, REQUEST_TIMEOUT_MS, USER_AGENT } from "./config";

/**
 * The one function in the app that decides whether an IP address is safe to
 * connect to. Allowlist, not a blocklist: ipaddr.js classifies every address
 * into a named range (private, loopback, linkLocal, uniqueLocal, reserved,
 * carrierGradeNat, broadcast, unspecified, multicast, ipv4Mapped, teredo,
 * 6to4, as112, benchmarking, amt, orchid2, …) and only "unicast" — ordinary
 * public internet addresses — is allowed. Anything unrecognized fails
 * closed as forbidden, rather than requiring this list to enumerate every
 * dangerous range by name (which is exactly how allowlists avoid the bugs
 * blocklists have when a new private/reserved range shows up).
 */
export function isIpForbidden(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return true;
  // process() also collapses an IPv4-mapped IPv6 address (::ffff:10.0.0.1)
  // to its real IPv4 form before classifying it, so that bypass is covered too.
  const addr = ipaddr.process(ip);
  return addr.range() !== "unicast";
}

export interface HostValidationResult {
  safe: boolean;
  reason?: string;
  addresses?: string[];
}

/**
 * Resolves every address a hostname points to and rejects the host unless
 * ALL of them are safe — fetch() could connect to any one of them, so a
 * hostname with one public and one private A/AAAA record is still unsafe.
 * A hostname that's already a literal IP skips DNS entirely.
 */
export async function resolveAndValidateHost(hostname: string): Promise<HostValidationResult> {
  if (ipaddr.isValid(hostname)) {
    return isIpForbidden(hostname)
      ? { safe: false, reason: "Adresse IP interdite.", addresses: [hostname] }
      : { safe: true, addresses: [hostname] };
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return { safe: false, reason: "Résolution DNS impossible." };
  }

  const addresses = records.map((r) => r.address);
  if (addresses.length === 0) {
    return { safe: false, reason: "Aucune adresse résolue pour ce domaine." };
  }

  const forbidden = addresses.find((ip) => isIpForbidden(ip));
  if (forbidden) {
    return { safe: false, reason: "Ce domaine pointe vers une adresse réseau interne ou réservée.", addresses };
  }

  return { safe: true, addresses };
}

export type SafeFetchErrorReason =
  | "invalid_url"
  | "protocol_not_allowed"
  | "network_unsafe"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "http_error"
  | "network_error";

export interface SafeFetchResult {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  contentType?: string | null;
  body?: string;
  errorReason?: SafeFetchErrorReason;
  errorMessage?: string;
}

/**
 * Shape of an early failure (bad protocol, SSRF rejection, timeout,
 * network error, too many redirects) — deliberately has no `body` field at
 * all (not even an optional one typed `string` or `Buffer`), so the exact
 * same error value is structurally assignable to either SafeFetchResult
 * (text) or SafeFetchBinaryResult (Buffer) without a cast — see
 * fetchValidated, which is shared by safeFetch and safeFetchBinary.
 */
interface CoreFetchError {
  ok: false;
  status?: number;
  errorReason: SafeFetchErrorReason;
  errorMessage: string;
}

type UrlValidationOutcome = { url: URL } | { error: CoreFetchError };

async function validateUrlForFetch(urlString: string): Promise<UrlValidationOutcome> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { error: { ok: false, errorReason: "invalid_url", errorMessage: "URL invalide." } };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      error: { ok: false, errorReason: "protocol_not_allowed", errorMessage: `Protocole non autorisé : ${url.protocol}` },
    };
  }

  const validation = await resolveAndValidateHost(url.hostname);
  if (!validation.safe) {
    return { error: { ok: false, errorReason: "network_unsafe", errorMessage: validation.reason ?? "Adresse réseau non autorisée." } };
  }

  return { url };
}

type FetchCoreOutcome = { response: Response; finalUrl: URL } | { error: CoreFetchError };

/**
 * Shared core of every outbound HTTP request this feature makes: validates
 * protocol + resolves/checks DNS before every attempt, follows redirects
 * manually and re-validates each hop from scratch (a redirect to an
 * internal address is rejected exactly like a direct request to one would
 * be), and times out. Returns the still-unread Response so callers decide
 * how to read the body (text for safeFetch, bounded binary for
 * safeFetchBinary) — reading strategy is the only thing that differs
 * between them, the SSRF/redirect/timeout logic here is identical either
 * way and must never diverge between the two.
 *
 * Known residual risk, accepted for this admin-only, occasional-use MVP:
 * validation resolves DNS once per hop, then fetch() resolves again
 * internally when it actually connects — a DNS answer that changes between
 * those two lookups (classic "DNS rebinding") isn't fully closed here. See
 * the crawler audit for the trade-off; pinning the connection to the
 * validated IP would close it but needs a lower-level HTTP client.
 */
async function fetchValidated(initialUrl: string, accept: string): Promise<FetchCoreOutcome> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await validateUrlForFetch(currentUrl);
    if ("error" in validated) return { error: validated.error };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(validated.url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: accept },
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      return {
        error: {
          ok: false,
          errorReason: timedOut ? "timeout" : "network_error",
          errorMessage: timedOut ? "Délai réseau dépassé." : "Erreur réseau.",
        },
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { error: { ok: false, errorReason: "http_error", errorMessage: `Redirection ${response.status} sans destination.` } };
      }
      currentUrl = new URL(location, validated.url).toString();
      continue;
    }

    if (!response.ok) {
      return { error: { ok: false, status: response.status, errorReason: "http_error", errorMessage: `Réponse HTTP ${response.status}.` } };
    }

    return { response, finalUrl: validated.url };
  }

  return { error: { ok: false, errorReason: "too_many_redirects", errorMessage: "Trop de redirections." } };
}

/**
 * The only way this feature is allowed to fetch an HTML/text page. See
 * fetchValidated for the shared SSRF/redirect/timeout logic; this adds the
 * text-specific streamed size cap and UTF-8 decoding.
 */
export async function safeFetch(initialUrl: string): Promise<SafeFetchResult> {
  const outcome = await fetchValidated(initialUrl, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5");
  if ("error" in outcome) return outcome.error;

  const body = await readTextBodyWithLimit(outcome.response);
  if (body === null) {
    return { ok: false, errorReason: "too_large", errorMessage: "Réponse trop volumineuse." };
  }

  return { ok: true, status: outcome.response.status, finalUrl: outcome.finalUrl.toString(), contentType: outcome.response.headers.get("content-type"), body };
}

async function readTextBodyWithLimit(response: Response): Promise<string | null> {
  const bytes = await readBytesWithLimit(response, MAX_HTML_SIZE_BYTES);
  return bytes === null ? null : bytes.toString("utf-8");
}

async function readBytesWithLimit(response: Response, maxBytes: number): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : buffer;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export type SafeFetchBinaryErrorReason = SafeFetchErrorReason | "unsupported_content_type" | "content_type_mismatch";

export interface SafeFetchBinaryResult {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  contentType?: string | null;
  body?: Buffer;
  /** SHA-256 hex digest of `body` — only set when ok. */
  contentHash?: string;
  errorReason?: SafeFetchBinaryErrorReason;
  errorMessage?: string;
}

/**
 * Allow-list, not a block-list, same philosophy as isIpForbidden above.
 * SVG is deliberately excluded even though it's a common web image format —
 * it can embed <script>, which is not a risk worth taking for content that
 * ends up re-hosted and served back to real site visitors.
 */
const ALLOWED_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

/**
 * Checks the file's actual byte signature against the Content-Type header
 * it arrived with — a remote server's declared Content-Type is never
 * trusted alone (see safeFetchBinary below). Returns false on any mismatch
 * or unrecognized signature, including for content types not in
 * ALLOWED_IMAGE_CONTENT_TYPES (callers reject those before ever reaching
 * this check, but it fails closed either way).
 */
function matchesImageMagicBytes(contentType: string, bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  switch (contentType) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    case "image/webp":
      return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    case "image/avif":
      // ISOBMFF: a 4-byte box size, then "ftyp", then a major brand — avif
      // still images and avis avif-sequences both use this container.
      return bytes.toString("ascii", 4, 8) === "ftyp" && (bytes.toString("ascii", 8, 12) === "avif" || bytes.toString("ascii", 8, 12) === "avis");
    default:
      return false;
  }
}

/**
 * The only way this feature is allowed to download an image — reuses
 * fetchValidated's exact SSRF/redirect/timeout logic (see above), then adds
 * image-specific hardening on top: a strict Content-Type allow-list, a
 * magic-byte check that the downloaded bytes actually match that declared
 * type (a remote site's Content-Type header is never trusted blindly), its
 * own size cap (MAX_IMAGE_SIZE_BYTES, distinct from the HTML-oriented
 * MAX_HTML_SIZE_BYTES), and a SHA-256 content hash used for dedup by
 * callers (see room_photos.content_hash).
 */
export async function safeFetchBinary(initialUrl: string): Promise<SafeFetchBinaryResult> {
  const outcome = await fetchValidated(initialUrl, "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5");
  if ("error" in outcome) return outcome.error;

  const contentType = (outcome.response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
    return { ok: false, errorReason: "unsupported_content_type", errorMessage: `Type de contenu non pris en charge : ${contentType || "inconnu"}.` };
  }

  const body = await readBytesWithLimit(outcome.response, MAX_IMAGE_SIZE_BYTES);
  if (body === null) {
    return { ok: false, errorReason: "too_large", errorMessage: "Image trop volumineuse." };
  }

  if (!matchesImageMagicBytes(contentType, body)) {
    return { ok: false, errorReason: "content_type_mismatch", errorMessage: "Le contenu téléchargé ne correspond pas au type d'image déclaré." };
  }

  const contentHash = createHash("sha256").update(body).digest("hex");

  return {
    ok: true,
    status: outcome.response.status,
    finalUrl: outcome.finalUrl.toString(),
    contentType,
    body,
    contentHash,
  };
}
