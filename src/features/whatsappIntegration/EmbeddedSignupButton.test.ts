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

  it("[success path calls the activation-token action with this component's own activationToken prop, the code, and the untrusted signupResult hints]", () => {
    // The doc comment above also mentions the function name in prose (with
    // no "await" prefix) — anchor on "await ..." to land on the real call.
    const callStart = source.indexOf("await receiveWhatsAppEmbeddedSignupCodeFromActivation(");
    const callEnd = source.indexOf(");", callStart);
    const call = source.slice(callStart, callEnd);
    expect(call).toMatch(/receiveWhatsAppEmbeddedSignupCodeFromActivation\(activationToken, code as string, \{/);
    expect(call).toMatch(/event: outcome\.event/);
    expect(call).toMatch(/wabaId: outcome\.wabaId/);
    expect(call).toMatch(/phoneNumberId: outcome\.phoneNumberId/);
    expect(call).toMatch(/businessId: outcome\.businessId/);
  });
});

describe("EmbeddedSignupButton — activationToken prop (public activation page context)", () => {
  it("[accepts activationToken as its only prop] never hotelId, never derives a tenant itself — the server derives hotelId from the token", () => {
    expect(source).toMatch(/export function EmbeddedSignupButton\(\{ activationToken \}: \{ activationToken: string \}\)/);
    // Doc comments legitimately mention hotelId in prose (explaining how the
    // server derives it) — only the executable code must never reference it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/hotelId/);
  });

  it("[imports the activation-scoped action] never the removed admin-direct receiveWhatsAppEmbeddedSignupCodeBackoffice", () => {
    expect(source).toMatch(/import \{ receiveWhatsAppEmbeddedSignupCodeFromActivation \} from "\.\/actions";/);
    expect(source).not.toMatch(/receiveWhatsAppEmbeddedSignupCodeBackoffice/);
  });
});

describe("EmbeddedSignupButton — never claims a real connection, never shows a token", () => {
  it("[the success message is rendered ONLY behind an early return on status === \"connected\"] never unconditionally, never derived from the postMessage/FB.login response alone", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toMatch(/if \(status === "connected"\) \{\s*return <p[^>]*>WhatsApp Business est maintenant connecté à votre établissement\.<\/p>;/);
  });

  it("[status is only ever set to \"connected\" after a real, awaited server response] never optimistically, never before receiveWhatsAppEmbeddedSignupCodeFromActivation() resolves", () => {
    const fnStart = source.indexOf("async function handleLoginResponse");
    const fn = source.slice(fnStart);
    const awaitIndex = fn.indexOf("await receiveWhatsAppEmbeddedSignupCodeFromActivation(");
    const connectedIndex = fn.indexOf('setStatus("connected")');
    expect(awaitIndex).toBeGreaterThan(-1);
    expect(connectedIndex).toBeGreaterThan(awaitIndex);
  });

  it("[required button label present, no jargon] \"Connecter mon WhatsApp Business\" — the intro/consent copy itself now lives on the public page, not this component", () => {
    expect(source).toMatch(/Connecter mon WhatsApp Business/);
  });

  it("[never renders a token/code/access_token value in JSX] scoped to the rendered output only — the activationToken PROP NAME itself legitimately contains the word \"token\" in its destructuring/type position, which is not a rendered value", () => {
    const renderSection = source.slice(source.indexOf('if (status === "connected")'));
    expect(renderSection).not.toMatch(/\{.*[Tt]oken.*\}/);
    expect(renderSection).not.toMatch(/\{.*[Aa]ccessToken.*\}/);
    expect(renderSection).not.toMatch(/\{code\}/);
  });

  it("[never reads response.authResponse.access_token or accessToken] only .code is ever read from the FB.login callback response", () => {
    expect(source).not.toMatch(/authResponse\?\.access_token|authResponse\?\.accessToken/);
    expect(source).toMatch(/authResponse\?\.code/);
  });

  it("[no console logging in this component at all] nothing here ever risks logging a token/code — errors surface only via toast", () => {
    expect(source).not.toMatch(/console\.(log|info|warn|error)\(/);
  });
});

describe("EmbeddedSignupButton — public route, deliberately public (the token itself is the authorization)", () => {
  it("[no /client/whatsapp reference remains anywhere; /whatsapp/connect IS deliberately public, /etablissements/.../whatsapp is NOT] this component now renders only under the public activation route", async () => {
    const { readFileSync: read } = await import("node:fs");
    const { fileURLToPath: toPath } = await import("node:url");
    const { dirname: dir, join: j } = await import("node:path");
    const sessionHere = dir(toPath(import.meta.url));
    const updateSessionSource = read(j(sessionHere, "..", "..", "lib", "supabase", "updateSession.ts"), "utf8");
    expect(updateSessionSource).not.toMatch(/\/client\/whatsapp/);
    expect(updateSessionSource).not.toMatch(/\/etablissements\/.*whatsapp/);
    expect(updateSessionSource).toMatch(/"\/whatsapp\/connect"/);
  });
});
