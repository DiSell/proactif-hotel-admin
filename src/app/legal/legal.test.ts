import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-level only — no jsdom in this repo's vitest config (environment:
 * "node"), same convention as every other component in this codebase (see
 * e.g. EmbeddedSignupButton.test.ts's own doc comment). These two pages are
 * plain, static Server Components with no client-side logic to exercise —
 * checking their rendered text/structure at the source level is sufficient
 * and matches how every other public, unauthenticated page in this repo is
 * tested (see updateSession.test.ts for the routing side of this same
 * guarantee).
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, "..");
const privacySource = readFileSync(join(here, "privacy", "page.tsx"), "utf8");
const deletionSource = readFileSync(join(here, "data-deletion", "page.tsx"), "utf8");
const termsSource = readFileSync(join(here, "terms", "page.tsx"), "utf8");
const layoutSource = readFileSync(join(here, "LegalLayout.tsx"), "utf8");

function readSource(...segments: string[]): string {
  return readFileSync(join(repoSrc, ...segments), "utf8");
}

describe("Legal pages — public accessibility (routing)", () => {
  it("[/legal/ is public] already covered in lib/supabase/updateSession.test.ts — sanity-checked here too so this file alone documents the guarantee", async () => {
    const { isPublicPath } = await import("@/lib/supabase/updateSession");
    expect(isPublicPath("/legal/privacy")).toBe(true);
    expect(isPublicPath("/legal/terms")).toBe(true);
    expect(isPublicPath("/legal/data-deletion")).toBe(true);
    expect(isPublicPath("/politique-de-confidentialite")).toBe(true);
    expect(isPublicPath("/conditions-utilisation")).toBe(true);
    expect(isPublicPath("/suppression-donnees")).toBe(true);
  });

  it("[no auth/session import anywhere in these pages] never requireClientAccess/requireSuperadmin/requireHotelAccess — these pages must never depend on a session existing", () => {
    for (const source of [privacySource, deletionSource, termsSource, layoutSource]) {
      expect(source).not.toMatch(/requireClientAccess|requireSuperadmin|requireHotelAccess/);
    }
  });
});

describe("Canonical French URLs — re-export the same content, never a diverging copy", () => {
  it("[/politique-de-confidentialite re-exports /legal/privacy verbatim]", () => {
    const source = readSource("politique-de-confidentialite", "page.tsx");
    expect(source).toMatch(/export \{ default, metadata \} from "\.\.\/legal\/privacy\/page";/);
  });

  it("[/conditions-utilisation re-exports /legal/terms verbatim]", () => {
    const source = readSource("conditions-utilisation", "page.tsx");
    expect(source).toMatch(/export \{ default, metadata \} from "\.\.\/legal\/terms\/page";/);
  });

  it("[/suppression-donnees re-exports /legal/data-deletion verbatim]", () => {
    const source = readSource("suppression-donnees", "page.tsx");
    expect(source).toMatch(/export \{ default, metadata \} from "\.\.\/legal\/data-deletion\/page";/);
  });
});

describe("LegalLayout — cross-links use the canonical French URLs", () => {
  it("[nav links to the new canonical paths, not the legacy /legal/* ones]", () => {
    expect(layoutSource).toMatch(/href="\/politique-de-confidentialite"/);
    expect(layoutSource).toMatch(/href="\/conditions-utilisation"/);
    expect(layoutSource).toMatch(/href="\/suppression-donnees"/);
  });

  it("[in-prose cross-links updated too] privacy -> /suppression-donnees, data-deletion -> /politique-de-confidentialite", () => {
    expect(privacySource).toMatch(/href="\/suppression-donnees"/);
    expect(deletionSource).toMatch(/href="\/politique-de-confidentialite"/);
  });
});

describe("Terms of use — content requirements", () => {
  it("[real legal identity present, no placeholder marker]", () => {
    expect(termsSource).not.toMatch(/Placeholder à compléter/);
    expect(termsSource).toMatch(/510 749 682/); // SIREN
    expect(termsSource).toMatch(/Didier Sellin/);
  });

  it("[describes the actual service — assistant, WhatsApp Embedded Signup, partners]", () => {
    expect(termsSource).toMatch(/assistant conversationnel/i);
    expect(termsSource).toMatch(/Embedded Signup/);
    expect(termsSource).toMatch(/partenaire/i);
  });

  it("[never invents pricing, a contract duration, a termination notice period, or an SLA percentage]", () => {
    expect(termsSource).not.toMatch(/€|\bprix\b|abonnement|résiliation|préavis|\d+\s*%\s*(de disponibilité|SLA)/i);
  });

  it("[never invents a terms-acceptance checkbox/signup mechanism that doesn't exist in this codebase]", () => {
    expect(termsSource).not.toMatch(/case à cocher|j'accepte les conditions/i);
  });

  it("[AI-generated answers: no guarantee of absolute accuracy, hotel keeps its own information up to date]", () => {
    expect(termsSource).toMatch(/générées automatiquement/i);
    expect(termsSource).not.toMatch(/garantit l'exactitude|100\s*%\s*exact/i);
  });

  it("[links to the privacy policy and data-deletion pages via their canonical URLs]", () => {
    expect(termsSource).toMatch(/href="\/politique-de-confidentialite"/);
    expect(termsSource).toMatch(/href="\/suppression-donnees"/);
  });

  it("[real contact address present]", () => {
    expect(termsSource).toMatch(/sellindidier@gmail\.com/);
  });

  it("[never mentions the ProactifSupport product]", () => {
    expect(termsSource).not.toMatch(/ProactifSupport/i);
  });
});

describe("Privacy policy — content requirements", () => {
  it("[mentions Meta/WhatsApp]", () => {
    expect(privacySource).toMatch(/Meta/);
    expect(privacySource).toMatch(/WhatsApp/);
  });

  it("[explicitly states Proactif System never collects the Facebook/Meta password]", () => {
    expect(privacySource).toMatch(/jamais accès au mot de passe/i);
  });

  it("[describes the WhatsApp technical identifiers actually stored — WABA ID, Phone Number ID, Business ID]", () => {
    expect(privacySource).toMatch(/WABA ID/);
    expect(privacySource).toMatch(/Phone Number ID/);
    expect(privacySource).toMatch(/Business ID/);
  });

  it("[states the Meta access token is encrypted, never stored in plaintext]", () => {
    expect(privacySource).toMatch(/chiffr/i);
  });

  it("[never claims an invented retention duration] no bare '30 jours'/'3 ans'-style fabricated period — describes criteria instead", () => {
    expect(privacySource).not.toMatch(/\b\d+\s*(jours|mois|ans)\b/);
  });

  it("[lists real GDPR rights: access, rectification, erasure, limitation, opposition, portability, consent withdrawal]", () => {
    for (const term of ["accès", "rectification", "effacement", "limitation", "opposition", "portabilité", "retirer votre consentement"]) {
      expect(privacySource).toMatch(new RegExp(term, "i"));
    }
  });

  it("[mentions the right to complain to the CNIL]", () => {
    expect(privacySource).toMatch(/CNIL/);
  });

  it("[names only real, verified subprocessors] Supabase, Render, Meta, OpenAI — never an invented vendor", () => {
    for (const vendor of ["Supabase", "Render", "Meta", "OpenAI"]) {
      expect(privacySource).toMatch(new RegExp(vendor));
    }
  });

  it("[never mentions the ProactifSupport product] this is a dedicated Proactif Messaging policy, never a reuse of another product's", () => {
    expect(privacySource).not.toMatch(/ProactifSupport/i);
  });

  it("[real legal identity now filled in, no placeholder marker remains]", () => {
    expect(privacySource).not.toMatch(/Placeholder à compléter/);
    expect(privacySource).toMatch(/510 749 682/); // SIREN
    expect(privacySource).toMatch(/Didier Sellin/);
  });

  it("[real contact address present]", () => {
    expect(privacySource).toMatch(/sellindidier@gmail\.com/);
  });

  it("[links to the data-deletion page via its canonical URL]", () => {
    expect(privacySource).toMatch(/\/suppression-donnees/);
  });
});

describe("Data deletion page — content requirements", () => {
  it("[explains how to request deletion]", () => {
    expect(deletionSource).toMatch(/demande de suppression|demander la suppression/i);
  });

  it("[lists what information to provide to identify the account]", () => {
    expect(deletionSource).toMatch(/établissement/i);
    expect(deletionSource).toMatch(/email/i);
  });

  it("[mentions identity verification may be required]", () => {
    // The source is JSX/TSX text — a French apostrophe there is the literal
    // HTML entity `&rsquo;` (7 characters), never a single quote character,
    // so the regex must match that entity explicitly rather than assuming
    // one rendered apostrophe glyph.
    expect(deletionSource).toMatch(/confirmer votre identité|Vérification d(&rsquo;|')identité/i);
  });

  it("[mentions legal-obligation retention exceptions, never an absolute promise of full deletion]", () => {
    expect(deletionSource).toMatch(/obligation légale/i);
  });

  it("[describes WhatsApp credential/connection deletion via the real technical process]", () => {
    expect(deletionSource).toMatch(/WABA ID|connexion WhatsApp/i);
    expect(deletionSource).toMatch(/révocation|supprim/i);
  });

  it("[processing delay: only the real statutory GDPR window — never an invented internal SLA]", () => {
    expect(deletionSource).toMatch(/un mois/i);
    expect(deletionSource).not.toMatch(/sous\s+\d+\s*(heures|jours)\b/i);
  });

  it("[links back to the privacy policy via its canonical URL]", () => {
    expect(deletionSource).toMatch(/\/politique-de-confidentialite/);
  });

  it("[never mentions the ProactifSupport product]", () => {
    expect(deletionSource).not.toMatch(/ProactifSupport/i);
  });

  it("[usable as Meta's Data Deletion Instructions URL — no login/session gate, own doc comment records this intent]", () => {
    expect(deletionSource).toMatch(/Data Deletion Instructions URL/);
  });
});

describe("No real personal data or secrets in any page", () => {
  it("[the only email address literal in any page is the real, intentionally-published RGPD contact address] never a different/guessed address", () => {
    const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
    for (const source of [privacySource, deletionSource, termsSource]) {
      const matches = source.match(emailPattern) ?? [];
      for (const match of matches) {
        expect(match).toBe("sellindidier@gmail.com");
      }
    }
  });

  it("[no token/secret/key-shaped literal in any page]", () => {
    for (const source of [privacySource, deletionSource, termsSource]) {
      expect(source).not.toMatch(/EAA[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{10,}/);
    }
  });
});
