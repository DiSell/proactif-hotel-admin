import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * requireClientAccess-guarded — same testing constraint as every other
 * Server Action in this repo (see src/features/client/actions.test.ts's
 * own doc comment): checked at the source level. requireClientAccess()
 * itself is already exhaustively covered at runtime in
 * src/lib/auth/session.test.ts — not re-tested here. The real Meta
 * verification chain (finalizeEmbeddedSignup) is separately covered, with
 * mocked fetch only, in lib/notifications/whatsapp/metaEmbeddedSignup.test.ts.
 */
function sliceFunction(exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}`);
  expect(start).toBeGreaterThan(-1);
  const nextExport = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, nextExport === -1 ? undefined : nextExport);
}

describe("receiveWhatsAppEmbeddedSignupCode", () => {
  it("[hotelId never accepted as input] the exported function destructures only { code, signupResult } — never a hotelId parameter (task section 4's own forbidden signature)", () => {
    const signatureStart = source.indexOf("export async function receiveWhatsAppEmbeddedSignupCode(");
    const signatureEnd = source.indexOf(")", signatureStart);
    const signature = source.slice(signatureStart, signatureEnd);
    expect(signature).not.toMatch(/hotelId/i);
    expect(signature).toMatch(/\{ code, signupResult \}: EmbeddedSignupCodeInput/);
  });

  it("[tenant derived from the session] calls requireClientAccess() with no arguments — a browser can never target a different hotel", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
  });

  it("[never requireHotelAccess/requireSuperadmin] this is a client-portal-only action", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    expect(fn).not.toMatch(/requireHotelAccess|requireSuperadmin/);
  });

  it("[missing/empty code rejected before the Meta chain is ever attempted]", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    const requireIndex = fn.indexOf("requireClientAccess()");
    const codeCheckIndex = fn.indexOf("!code.trim()");
    const chainIndex = fn.indexOf("finalizeEmbeddedSignup(");
    expect(codeCheckIndex).toBeGreaterThan(-1);
    expect(codeCheckIndex).toBeGreaterThan(requireIndex); // session still resolved first, matching every other action's own ordering
    expect(chainIndex).toBeGreaterThan(codeCheckIndex);
  });

  it("[delegates the real Meta chain to finalizeEmbeddedSignup — no fetch/graph.facebook.com call directly in this file]", () => {
    expect(source).toMatch(/import \{ finalizeEmbeddedSignup \} from "@\/lib\/notifications\/whatsapp\/metaEmbeddedSignup";/);
    expect(source).not.toMatch(/fetch\(|graph\.facebook\.com/);
  });

  it("[the browser's signupResult hints are passed through as CLAIMED values, never as pre-validated ones]", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    expect(fn).toMatch(/claimedWabaId: signupResult\.wabaId/);
    expect(fn).toMatch(/claimedPhoneNumberId: signupResult\.phoneNumberId/);
    expect(fn).toMatch(/claimedBusinessId: signupResult\.businessId/);
  });

  it("[never persists anything] no Supabase client, no .from(), no RPC call anywhere in this file — 0024 has no write path yet (task sections 15/16)", () => {
    expect(source).not.toMatch(/createAdminClient|createClient|\.from\(|\.rpc\(/);
  });

  it("[code never logged] no console call's argument OBJECT ever references the `code` variable — a human-readable message may say the word \"code\" in prose", () => {
    const logCalls = source.match(/console\.(info|error|warn|log)\([^;]*?\);/g) ?? [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      // The structured metadata argument is always the last `{ ... }` in
      // the call — check IT specifically for a `code` reference, rather
      // than the whole call (which legitimately includes prose like "code
      // received" inside its quoted message string).
      const metadataMatch = call.match(/\{[^{}]*\}(?![\s\S]*\{)/);
      expect(metadataMatch?.[0] ?? "").not.toMatch(/\bcode\b/);
    }
  });

  it("[never logs an access token or errorCode's own Meta-facing detail beyond the closed error code]", () => {
    expect(source).not.toMatch(/accessToken|access_token/);
  });

  it("[a failed finalization never claims success, and never leaks which Meta step failed]", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    expect(fn).toMatch(/if \(!result\.ok\)/);
    expect(fn).toMatch(/error: "La connexion WhatsApp n'a pas pu être finalisée\."/);
  });

  it("[only a real, server-verified success returns finalized:true — never a bare pass-through of the browser's own claim]", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    expect(fn).toMatch(/return \{ ok: true, data: \{ received: true, finalized: true \} \};/);
    expect(fn).not.toMatch(/status:\s*"active"/);
    expect(fn).not.toMatch(/connected:\s*true/);
  });
});
