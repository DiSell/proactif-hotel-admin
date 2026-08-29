import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-level only — no jsdom in this repo's vitest config (environment:
 * "node"), same convention as every other Client Component in this
 * codebase (see e.g. PublicWidgetChat.hostBooking.test.ts's own doc
 * comment). The actual decision LOGIC this component wires up
 * (classifyEmbeddedSignupOutcome, parseEmbeddedSignupMessage, loadMetaSdk)
 * is separately unit-tested with real invocation in
 * embeddedSignupMessage.test.ts / metaSdk.test.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "EmbeddedSignupButton.tsx"), "utf8");

describe("EmbeddedSignupButton — config gating (task section 16)", () => {
  it("[config absent -> no actionable button] both public env vars are checked before rendering the real button", () => {
    expect(source).toMatch(/if \(!META_APP_ID \|\| !META_WHATSAPP_CONFIG_ID\)/);
  });

  it("[only NEXT_PUBLIC_ Meta vars referenced] never a server-only WHATSAPP_META_* secret", () => {
    expect(source).toMatch(/NEXT_PUBLIC_META_APP_ID/);
    expect(source).toMatch(/NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID/);
    expect(source).not.toMatch(/WHATSAPP_META_ACCESS_TOKEN|WHATSAPP_META_APP_SECRET|SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("[.env.example documents both public vars, with no real value committed]", async () => {
    const { readFileSync: read } = await import("node:fs");
    const { fileURLToPath: toPath } = await import("node:url");
    const { dirname: dir, join: j } = await import("node:path");
    const envHere = dir(toPath(import.meta.url));
    const envExample = read(j(envHere, "..", "..", "..", ".env.example"), "utf8");
    const lines = envExample.split("\n").filter((line) => line.includes("NEXT_PUBLIC_META_"));
    expect(lines.some((line) => line.includes("NEXT_PUBLIC_META_APP_ID"))).toBe(true);
    expect(lines.some((line) => line.includes("NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toMatch(/NEXT_PUBLIC_META_(APP_ID|WHATSAPP_CONFIG_ID)=.+\S/);
    }
  });
});

describe("EmbeddedSignupButton — SDK loading", () => {
  it("[loads via loadMetaSdk, exactly once per click] never a second, competing SDK-loading mechanism", () => {
    expect(source.match(/loadMetaSdk\(/g)?.length).toBe(1);
  });

  it("[load error handled] a rejected loadMetaSdk() sets status to error and shows a toast, never left unhandled", () => {
    const tryBlock = source.slice(source.indexOf("async function handleClick"), source.indexOf("setStatus(\"opening\")"));
    expect(tryBlock).toMatch(/catch/);
    expect(tryBlock).toMatch(/setStatus\("error"\)/);
  });
});

describe("EmbeddedSignupButton — FB.login parameters (confirmed against Meta's current docs)", () => {
  it("[exact confirmed parameter shape]", () => {
    expect(source).toMatch(/config_id: META_WHATSAPP_CONFIG_ID/);
    expect(source).toMatch(/response_type: "code"/);
    expect(source).toMatch(/override_default_response_type: true/);
    expect(source).toMatch(/extras: \{ setup: \{\} \}/);
  });

  it("[never response_type token] this flow only ever requests an exchangeable code, never a raw access token to the browser", () => {
    expect(source).not.toMatch(/response_type:\s*"token"/);
  });
});

describe("EmbeddedSignupButton — outcome handling", () => {
  it("[uses the shared pure classifier] never reimplements the CANCEL/ERROR/unsupported/finalization decision inline", () => {
    expect(source).toMatch(/classifyEmbeddedSignupOutcome\(/);
  });

  it("[cancelled state reachable]", () => {
    expect(source).toMatch(/outcome\.status === "cancelled"/);
    expect(source).toMatch(/setStatus\("cancelled"\)/);
  });

  it("[unsupported_flow -> stop, never continues silently] FINISH_OBO_MIGRATION's own classification never reaches the server action", () => {
    const block = source.slice(source.indexOf('outcome.status === "unsupported_flow"'), source.indexOf('outcome.status === "error"'));
    expect(block).not.toMatch(/receiveWhatsAppEmbeddedSignupCode/);
    expect(block).toMatch(/setStatus\("unsupported_flow"\)/);
  });

  it("[success path sends the code plus the untrusted signupResult hints, never a hotelId]", () => {
    const callStart = source.indexOf("receiveWhatsAppEmbeddedSignupCode({");
    const callEnd = source.indexOf(");", callStart);
    const call = source.slice(callStart, callEnd);
    expect(call).toMatch(/code: code as string/);
    expect(call).toMatch(/signupResult: \{ event: outcome\.event, wabaId: outcome\.wabaId, phoneNumberId: outcome\.phoneNumberId, businessId: outcome\.businessId \}/);
    expect(call).not.toMatch(/hotelId/i);
  });
});

describe("EmbeddedSignupButton — never claims a real connection, never shows a token", () => {
  it("[never renders the literal \"WhatsApp connecté\"] the only positive state is \"finalisation requise\" (doc comments may quote the banned string in prose to explain the rule)", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/WhatsApp connecté/);
    expect(code).toMatch(/finalisation requise/);
  });

  it("[required consent-style text present]", () => {
    expect(source).toMatch(/Connectez votre compte WhatsApp Business/);
  });

  it("[never renders a token/code/access_token value in JSX]", () => {
    expect(source).not.toMatch(/\{.*[Tt]oken.*\}/);
    expect(source).not.toMatch(/\{.*[Aa]ccessToken.*\}/);
    expect(source).not.toMatch(/\{code\}/);
  });

  it("[never reads response.authResponse.access_token or accessToken] only .code is ever read from the FB.login callback response", () => {
    expect(source).not.toMatch(/authResponse\?\.access_token|authResponse\?\.accessToken/);
    expect(source).toMatch(/authResponse\?\.code/);
  });

  it("[no console logging in this component at all] nothing here ever risks logging a token/code — errors surface only via toast", () => {
    expect(source).not.toMatch(/console\.(log|info|warn|error)\(/);
  });
});

describe("EmbeddedSignupButton — protected route, no middleware exemption needed", () => {
  it("[/client/whatsapp is NOT in the public path list] this page relies on ClientAppShell's own requireClientAccess() gate, same as /client/partners and /client/widget — never added to updateSession.ts's PUBLIC_PATH_PREFIXES", async () => {
    const { readFileSync: read } = await import("node:fs");
    const { fileURLToPath: toPath } = await import("node:url");
    const { dirname: dir, join: j } = await import("node:path");
    const sessionHere = dir(toPath(import.meta.url));
    const updateSessionSource = read(j(sessionHere, "..", "..", "lib", "supabase", "updateSession.ts"), "utf8");
    expect(updateSessionSource).not.toMatch(/\/client\/whatsapp/);
  });
});
