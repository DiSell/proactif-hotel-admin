// Site-analysis crawler entry point — Étape A (preview) only. Read-only:
// never writes to the database. Importing selected pages happens through
// importCrawledPages() in features/knowledge/actions.ts, a separate step a
// human explicitly triggers after reviewing this response.
import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  analyzeSiteRequestSchema,
  type AnalyzeSiteConsentRequiredResponse,
  type AnalyzeSiteErrorResponse,
  type AnalyzeSiteResponse,
} from "@/features/knowledge/schema";
import { hasSiteAnalysisConsent } from "@/features/knowledge/actions";
import { crawlWebsite } from "@/features/crawler/crawl";
import { getDomain, isSameDomain } from "@/features/crawler/urlPolicy";
import { resolveAndValidateHost } from "@/features/crawler/networkGuard";
import type { Hotel } from "@/types/database";

export async function POST(request: Request, context: RouteContext<"/api/hotels/[id]/analyze">) {
  await requireSuperadmin();
  const { id: hotelId } = await context.params;

  const parsed = analyzeSiteRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json<AnalyzeSiteErrorResponse>({ error: "URL invalide." }, { status: 400 });
  }
  const { url } = parsed.data;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return NextResponse.json<AnalyzeSiteErrorResponse>({ error: "URL invalide." }, { status: 400 });
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return NextResponse.json<AnalyzeSiteErrorResponse>({ error: "Seuls les sites http/https peuvent être analysés." }, { status: 400 });
  }

  // 1. Load the hotel — needed before anything else below can be checked.
  const supabase = await createClient();
  const { data: hotel, error: hotelError } = await supabase.from("hotels").select("*").eq("id", hotelId).maybeSingle<Hotel>();
  if (hotelError || !hotel) {
    return NextResponse.json<AnalyzeSiteErrorResponse>({ error: "Établissement introuvable." }, { status: 404 });
  }

  // 2-5. hotel.website is the ONLY domain this route will ever analyze for
  // this hotel — the admin cannot type in an unrelated third-party domain
  // and analyze/consent their way into crawling it. isSameDomain is the
  // exact same www/non-www-insensitive, no-subdomain-equivalence policy
  // the crawler itself uses (features/crawler/urlPolicy.ts) — reused
  // directly, not re-implemented, so the two can never silently disagree.
  // This is checked before consent is even looked up: a mismatched domain
  // is rejected outright, never offered a consent prompt.
  if (!hotel.website) {
    return NextResponse.json<AnalyzeSiteErrorResponse>({ error: "Aucun site web configuré pour cet établissement." }, { status: 400 });
  }
  if (!isSameDomain(url, hotel.website)) {
    return NextResponse.json<AnalyzeSiteErrorResponse>(
      { error: "Cette URL n’appartient pas au domaine du site de cet établissement." },
      { status: 403 }
    );
  }

  const hostCheck = await resolveAndValidateHost(parsedUrl.hostname);
  if (!hostCheck.safe) {
    return NextResponse.json<AnalyzeSiteErrorResponse>(
      { error: "Cette adresse ne peut pas être analysée (réseau interne ou non résolu)." },
      { status: 400 }
    );
  }

  // Server-enforced, not just a UI nicety — a client that skipped the
  // consent step (buggy or otherwise) still cannot start a crawl. Scoped
  // strictly to this domain (already verified above to be the hotel's own)
  // and to CURRENT_CONSENT_VERSION: consenting for one domain, or under an
  // older wording, never authorizes this. This check does not exist yet in
  // the live database until supabase/migrations/0003_site_analysis_consent
  // .sql is applied — until then it always reports "not consented" (fails
  // closed), never silently skips the gate.
  const domain = getDomain(url);
  if (!domain) {
    return NextResponse.json<AnalyzeSiteErrorResponse>({ error: "URL invalide." }, { status: 400 });
  }
  const consented = await hasSiteAnalysisConsent(hotelId, domain);
  if (!consented) {
    return NextResponse.json<AnalyzeSiteConsentRequiredResponse>({ consentRequired: true, domain }, { status: 403 });
  }

  try {
    const result = await crawlWebsite({
      websiteUrl: url,
      hotelLanguages: hotel.languages,
      defaultLanguage: hotel.default_language,
    });
    const body: AnalyzeSiteResponse = {
      pages: result.pages,
      sitemapUsed: result.sitemapUsed,
      totalCandidateUrls: result.totalCandidateUrls,
      processedPages: result.processedPages,
      usefulPages: result.usefulPages,
      fetchAttempts: result.fetchAttempts,
      skippedBecausePageLimit: result.skippedBecausePageLimit,
      countsByDetectedLanguage: result.countsByDetectedLanguage,
      stoppedReason: result.stoppedReason,
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error("POST /api/hotels/[id]/analyze: crawl failed", { hotelId, message: (err as Error).message });
    return NextResponse.json<AnalyzeSiteErrorResponse>({ error: "Une erreur est survenue pendant l'analyse du site." }, { status: 500 });
  }
}
