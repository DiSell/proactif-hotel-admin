import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * End-to-end verification that WhatsApp configuration has moved from the
 * client portal to the admin dashboard (task: "TRANSFÉRER TOUTE
 * L'INTERFACE DE CONFIGURATION WHATSAPP DU PORTAIL CLIENT VERS LE
 * DASHBOARD ADMIN"). Source-level only, matching this repo's own
 * convention for Next.js page/layout files (none of
 * src/app/(app)/etablissements/[id]/**'s existing pages have a dedicated
 * test file either — see e.g. widget/page.tsx, partenaires/page.tsx).
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, "..", "..");
const repoRoot = join(repoSrc, "..");

function readSource(...segments: string[]): string {
  return readFileSync(join(repoSrc, ...segments), "utf8");
}

describe("Client portal — WhatsApp screen fully removed", () => {
  it("[1] no WhatsApp entry left in ClientSidebarNav", () => {
    const source = readSource("components", "layout", "ClientSidebarNav.tsx");
    expect(source).not.toMatch(/\/client\/whatsapp/);
    expect(source).not.toMatch(/label:\s*"WhatsApp"/);
  });

  it("[2] the /client/(portal)/whatsapp page directory no longer exists", () => {
    const clientWhatsappDir = join(repoSrc, "app", "client", "(portal)", "whatsapp");
    expect(existsSync(clientWhatsappDir)).toBe(false);
  });

  it("[17] no remaining LIVE reference to /client/whatsapp anywhere in the app (doc comments and test files legitimately name the removed path in prose, so both are excluded)", () => {
    const offenders: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "node_modules" || entry === ".next") continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          const content = readFileSync(full, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "");
          if (content.includes("/client/whatsapp")) offenders.push(full);
        }
      }
    }
    walk(repoSrc);
    expect(offenders).toEqual([]);
  });
});

describe("Admin dashboard — WhatsApp tab present in the establishment layout", () => {
  it("[3] the [id] layout's Tabs list includes a WhatsApp entry pointing at /etablissements/[id]/whatsapp", () => {
    const source = readSource("app", "(app)", "etablissements", "[id]", "layout.tsx");
    expect(source).toMatch(/href: `\/etablissements\/\$\{hotel\.id\}\/whatsapp`, label: "WhatsApp"/);
  });

  it("[the admin page exists, resolves hotelId from its own route param, and reads connection + activation-link status]", () => {
    const source = readSource("app", "(app)", "etablissements", "[id]", "whatsapp", "page.tsx");
    expect(source).toMatch(/getHotel\(id\)/);
    expect(source).toMatch(/getHotelWhatsAppConnection\(id\)/);
    expect(source).toMatch(/getHotelWhatsAppActivationLinkStatus\(id\)/);
    expect(source).toMatch(/<GenerateActivationLinkButton hotelId=\{hotel\.id\} hasPendingLink=\{hasPendingLink\} \/>/);
  });

  it("[1/3 — admin never launches Meta directly] the admin page NEVER imports/renders EmbeddedSignupButton — it only generates/copies a link", () => {
    const source = readSource("app", "(app)", "etablissements", "[id]", "whatsapp", "page.tsx");
    // Its own doc comment legitimately says so in prose — only the
    // executable code must never reference the component.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/EmbeddedSignupButton/);
  });

  it("[no jargon in the normal UI text] never WABA/Cloud API/Business Integration System User/token/Graph API in the page's own rendered strings", () => {
    const pageSource = readSource("app", "(app)", "etablissements", "[id]", "whatsapp", "page.tsx");
    // Strip comments — this file's own doc comments legitimately reference
    // these terms in prose to explain the architecture; only the rendered
    // JSX text must stay jargon-free for the end user.
    const code = pageSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bWABA\b|Cloud API|Business Integration System User|Graph API/);
  });

  it("[never renders WABA id / phone_number_id / business_id / any crypto material, nor the raw activation token/its hash] only connection_type/connected_at and the link's expiry are surfaced", () => {
    const source = readSource("app", "(app)", "etablissements", "[id]", "whatsapp", "page.tsx");
    expect(source).not.toMatch(/connection\.waba_id|connection\.phone_number_id|connection\.business_id|ciphertext|nonce|authTag|auth_tag|token_hash|activationLink\.url|activationLink\.token/);
  });
});

describe("Admin dashboard — GenerateActivationLinkButton (generate/copy/regenerate only, never Meta)", () => {
  const source = readSource("features", "whatsappIntegration", "GenerateActivationLinkButton.tsx");

  it("[13 — Meta launched only from the public activation page] this component never imports EmbeddedSignupButton, loadMetaSdk, or any Meta-facing module", () => {
    expect(source).not.toMatch(/EmbeddedSignupButton|loadMetaSdk|metaEmbeddedSignup/);
  });

  it("[calls the admin link-generation action only] never the activation-token action", () => {
    expect(source).toMatch(/import \{ generateWhatsAppActivationLinkBackoffice \} from "\.\/actions";/);
    expect(source).not.toMatch(/receiveWhatsAppEmbeddedSignupCodeFromActivation/);
  });

  it("[17 — raw link shown only immediately after generation] the link lives only in this component's own local state, never refetched from a server query", () => {
    expect(source).toMatch(/useState<string \| null>\(null\)/);
    // The doc comment legitimately explains WHY (contrasting with the
    // server-side read) — only the executable code must never call it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/getHotelWhatsAppActivationLinkStatus/);
  });
});

describe("Public activation page — /whatsapp/connect/[token]", () => {
  const source = readSource("app", "whatsapp", "connect", "[token]", "page.tsx");

  it("[9 — receives the token from the URL, no session, no hotelId] resolves via peekActivationTokenStatus, never requireHotelAccess/requireClientAccess/requireSuperadmin", () => {
    expect(source).toMatch(/peekActivationTokenStatus\(token\)/);
    expect(source).not.toMatch(/requireHotelAccess|requireClientAccess|requireSuperadmin/);
    expect(source).not.toMatch(/hotelId/);
  });

  it("[13 — the ONLY place EmbeddedSignupButton is rendered] with the activationToken prop, never hotelId", () => {
    expect(source).toMatch(/<EmbeddedSignupButton activationToken=\{token\} \/>/);
  });

  it("[required public-page copy present] title, intro text, no jargon", () => {
    expect(source).toMatch(/Connecter WhatsApp Business/);
    expect(source).toMatch(/Cette connexion permet à votre établissement d.{0,10}utiliser WhatsApp avec Proactif System\./);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bWABA\b|Cloud API|Business Integration System User|Graph API/);
  });

  it("[wraps EmbeddedSignupButton in its own ToastProvider] this route has neither AppShell nor ClientAppShell — useToast() would otherwise throw", () => {
    expect(source).toMatch(/<ToastProvider>\s*<EmbeddedSignupButton/);
  });

  it("[route registered as public] /whatsapp/connect is in updateSession.ts's PUBLIC_PATHS", () => {
    const updateSessionSource = readSource("lib", "supabase", "updateSession.ts");
    expect(updateSessionSource).toMatch(/PUBLIC_PATHS = \[[^\]]*"\/whatsapp\/connect"/);
  });
});

describe("Sanity: legal pages untouched by this task", () => {
  it("[/legal/privacy and /legal/data-deletion still exist, unmodified in scope]", () => {
    expect(existsSync(join(repoRoot, "src", "app", "legal", "privacy", "page.tsx"))).toBe(true);
    expect(existsSync(join(repoRoot, "src", "app", "legal", "data-deletion", "page.tsx"))).toBe(true);
  });
});
