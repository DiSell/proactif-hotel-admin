import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "page.tsx"), "utf8");

/**
 * Source-level only — no jsdom in this repo's vitest config, and this is an
 * async Server Component anyway. These tests lock the merged design: ONE
 * page, ONE token, ONE lookup call, rendering TWO independent consent
 * blocks — never a `?type=` dispatch/two separate views any more.
 */
describe("PartnerConsentPage — one page, one token, two independent consent blocks", () => {
  it("[single merged lookup] calls getPartnerConsentRequests exactly once, never the old split lookups", () => {
    expect(source.match(/getPartnerConsentRequests\(/g)?.length).toBe(1);
    expect(source).not.toMatch(/getPartnerTransactionalConsentRequest/);
    expect(source).not.toMatch(/\bgetPartnerConsentRequest\(/); // the old singular-name function, not the plural one imported above
  });

  it("[no more ?type= dispatch] the page no longer branches on a type search param", () => {
    expect(source).not.toMatch(/searchParams\?\.type/);
    expect(source).not.toMatch(/"whatsapp" \? "whatsapp" : "recommendation"/);
  });

  it("[both blocks always rendered from the same request] ConsentResponseButtons and TransactionalConsentResponseButtons both referenced unconditionally on type, only gated by each block's own pending status", () => {
    expect(source).toMatch(/<ConsentResponseButtons/);
    expect(source).toMatch(/<TransactionalConsentResponseButtons/);
    expect(source).toMatch(/request\.recommendation\.status === "pending"/);
    expect(source).toMatch(/request\.whatsapp\.status === "pending"/);
  });

  it("[recommendation block reads recommendation status only, whatsapp block reads whatsapp status only] no cross-wiring between the two", () => {
    const recommendationBlockStart = source.indexOf("Recommandation dans le chatbot");
    const whatsappBlockStart = source.indexOf("Réception des demandes clients via WhatsApp");
    const recommendationBlock = source.slice(recommendationBlockStart, whatsappBlockStart);
    const whatsappBlock = source.slice(whatsappBlockStart);

    expect(recommendationBlock).toMatch(/request\.recommendation\./);
    expect(recommendationBlock).not.toMatch(/request\.whatsapp\./);
    expect(whatsappBlock).toMatch(/request\.whatsapp\./);
    expect(whatsappBlock).not.toMatch(/request\.recommendation\./);
  });

  it("[mandatory WhatsApp consent sentence present verbatim] never framed as marketing/newsletter/démarchage/réservation automatique", () => {
    const normalize = (s: string) => s.replace(/&rsquo;/g, "'").replace(/\s+/g, " ").trim();
    const sentence =
      "J'accepte que Proactif System utilise le numéro indiqué par l'établissement afin de me transmettre les demandes de ses clients via WhatsApp. Je pourrai refuser une demande individuellement.";
    expect(normalize(source)).toContain(normalize(sentence));
    for (const forbidden of [/newsletter/i, /marketing/i, /démarchage/i, /réservation automatique/i]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it("[whatsapp block shows request_phone_e164, never the public `phone` column]", () => {
    const whatsappBlock = source.slice(source.indexOf("Réception des demandes clients via WhatsApp"));
    expect(whatsappBlock).toMatch(/requestPhoneE164/);
    expect(whatsappBlock).not.toMatch(/\brequest\.phone\b/);
  });

  it("[invalid/unknown token] renders InvalidLink, no partial rendering of either block", () => {
    expect(source).toMatch(/if \(!request\) return <InvalidLink \/>;/);
  });
});
