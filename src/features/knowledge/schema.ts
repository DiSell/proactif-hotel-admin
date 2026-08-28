import { z } from "zod";
import { MAX_USEFUL_PAGES } from "@/features/crawler/config";

export const addUrlSourceSchema = z.object({
  title: z.string().trim().min(1, "Le titre est obligatoire."),
  source_url: z.string().trim().url("Entrez une URL valide."),
});
export type AddUrlSourceInput = z.infer<typeof addUrlSourceSchema>;

export const addTextSourceSchema = z.object({
  title: z.string().trim().min(1, "Le titre est obligatoire."),
  content: z.string().trim().min(1, "Le contenu est obligatoire."),
});
export type AddTextSourceInput = z.infer<typeof addTextSourceSchema>;

export const addFaqSourceSchema = z.object({
  title: z.string().trim().min(1, "La question est obligatoire."),
  content: z.string().trim().min(1, "La réponse est obligatoire."),
});
export type AddFaqSourceInput = z.infer<typeof addFaqSourceSchema>;

export const addDocumentSourceSchema = z.object({
  title: z.string().trim().min(1, "Le titre est obligatoire."),
  storage_path: z.string().trim().min(1),
  file_size_bytes: z.number().int().positive(),
  mime_type: z.string().trim().min(1),
});
export type AddDocumentSourceInput = z.infer<typeof addDocumentSourceSchema>;

// ---------------------------------------------------------------------------
// Site-analysis crawler (see src/features/crawler/)
// ---------------------------------------------------------------------------

export const analyzeSiteRequestSchema = z.object({
  url: z.string().trim().url("Entrez une URL valide."),
});
export type AnalyzeSiteRequest = z.infer<typeof analyzeSiteRequestSchema>;

const crawlPageStatusSchema = z.enum([
  "relevant",
  "probably_technical",
  "unreachable",
  "robots_disallowed",
  "insufficient_content",
  "duplicate",
]);

const extractedImageSchema = z.object({
  url: z.string().url(),
  alt: z.string().nullable(),
  nearbyHeading: z.string().nullable(),
});

const guessedCapacitySchema = z.object({
  value: z.number().int().positive(),
  matchedText: z.string(),
});

/**
 * Mirrors CrawlPage from src/features/crawler/crawl.ts — kept as a separate
 * Zod schema since that's a plain TS type, not runtime-validated at its
 * source. requestedUrl/finalUrl/canonicalUrl are deliberately distinct
 * fields — finalUrl is the page's identity (see importCrawledPagesSchema
 * below), canonicalUrl is informational only and never used as a key.
 * images/guessedCapacity are best-effort SUGGESTIONS only (see extract.ts) —
 * never authoritative until a human confirms them in the curation UI.
 */
export const crawlPageSchema = z.object({
  requestedUrl: z.string().url(),
  finalUrl: z.string().url(),
  canonicalUrl: z.string().url().nullable(),
  title: z.string(),
  headings: z.array(z.string()),
  language: z.string().nullable(),
  contentLength: z.number().int().nonnegative(),
  status: crawlPageStatusSchema,
  content: z.string(),
  errorMessage: z.string().nullable(),
  relevanceScore: z.number().int().nonnegative(),
  recommended: z.boolean(),
  images: z.array(extractedImageSchema),
  guessedCapacity: guessedCapacitySchema.nullable(),
});

export interface AnalyzeSiteResponse {
  pages: z.infer<typeof crawlPageSchema>[];
  sitemapUsed: boolean;
  totalCandidateUrls: number;
  processedPages: number;
  usefulPages: number;
  fetchAttempts: number;
  skippedBecausePageLimit: number;
  countsByDetectedLanguage: Record<string, number>;
  stoppedReason: "useful_page_limit" | "fetch_attempt_limit" | "time_limit" | "candidate_exhausted";
}

export interface AnalyzeSiteErrorResponse {
  error: string;
}

/** Returned by POST /api/hotels/[id]/analyze (403) when the admin hasn't yet confirmed the site-analysis consent for this exact domain. */
export interface AnalyzeSiteConsentRequiredResponse {
  consentRequired: true;
  domain: string;
}

/**
 * Body for importCrawledPages() — only the pages a human selected, each
 * re-validated server-side. `finalUrl` — never `canonicalUrl` — becomes
 * knowledge_sources.source_url; see actions.ts.
 */
export const importCrawledPagesSchema = z.object({
  pages: z
    .array(
      z.object({
        finalUrl: z.string().trim().url(),
        title: z.string().trim().min(1),
        content: z.string().trim().min(1),
        language: z.string().nullable().optional(),
      })
    )
    .min(1, "Sélectionnez au moins une page.")
    .max(MAX_USEFUL_PAGES, "Trop de pages sélectionnées."),
});
export type ImportCrawledPagesInput = z.infer<typeof importCrawledPagesSchema>;

// ---------------------------------------------------------------------------
// Accommodation types + room photos — supabase/migrations/
// 0004_accommodation_types.sql (PROPOSED, not yet applied). Step B of the
// image-curation flow: the admin has already reviewed detected images and
// capacity suggestions from the crawl preview and confirmed/corrected them —
// this is the only step that writes accommodation_types/room_photos.
// ---------------------------------------------------------------------------

const accommodationPhotoInputSchema = z.object({
  imageUrl: z.string().trim().url(),
  altText: z.string().trim().nullable(),
  /** The page this image was found on — becomes room_photos.source_page_url. */
  sourceUrl: z.string().trim().url().nullable(),
  /**
   * Every distinct detected photo is sent here, not just the ones checked
   * in the curation UI — this flag is what becomes room_photos.is_selected.
   * An unchecked photo is still persisted (isSelected: false), never
   * dropped: the client can select it later from their own portal. See
   * accommodationGrouping.ts's buildAccommodationTypesPayload.
   */
  isSelected: z.boolean(),
});

export const saveAccommodationTypesSchema = z.object({
  accommodationTypes: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Le nom est obligatoire."),
        /** Page this accommodation was detected on — becomes accommodation_types.source_url. */
        sourceUrl: z.string().trim().url().nullable(),
        // Never forced/guessed server-side: an admin who cleared the
        // suggested capacity sends null here, and null is what gets stored —
        // see AccommodationType.max_guests in src/types/database.ts.
        maxGuests: z.number().int().positive().max(100).nullable(),
        // No cap tied to a curation-UI display limit anymore (see
        // accommodationGrouping.ts — PHOTOS_PER_ACCOMMODATION_CAP was
        // removed): every distinct photo detected for the accommodation is
        // sent. 50 stays as a generous sanity bound only, not a product cap.
        photos: z.array(accommodationPhotoInputSchema).max(50, "Trop de photos pour un seul hébergement."),
      })
    )
    // An hébergement can be confirmed with zero photos at all — "Créer/
    // enregistrer un accommodation_type ne doit PAS exiger qu'une photo
    // soit sélectionnée." (see buildAccommodationTypesPayload).
    .min(1, "Sélectionnez au moins un hébergement.")
    .max(100, "Trop d'hébergements sélectionnés."),
});
export type SaveAccommodationTypesInput = z.infer<typeof saveAccommodationTypesSchema>;

// ---------------------------------------------------------------------------
// Site-analysis consent — supabase/migrations/0003_site_analysis_consent.sql
// (PROPOSED, not yet applied)
// ---------------------------------------------------------------------------

export const confirmSiteAnalysisConsentSchema = z.object({
  domain: z.string().trim().min(1),
});
export type ConfirmSiteAnalysisConsentInput = z.infer<typeof confirmSiteAnalysisConsentSchema>;
