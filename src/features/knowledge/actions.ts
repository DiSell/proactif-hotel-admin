"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { ingestSource } from "@/features/rag/ingest";
import { normalizeUrl } from "@/features/crawler/urlPolicy";
import { safeFetchBinary } from "@/features/crawler/networkGuard";
import { CURRENT_CONSENT_VERSION, SITE_ANALYSIS_CONSENT_TEXT } from "./siteAnalysisConsent";
import {
  addUrlSourceSchema,
  addTextSourceSchema,
  addFaqSourceSchema,
  addDocumentSourceSchema,
  importCrawledPagesSchema,
  confirmSiteAnalysisConsentSchema,
  saveAccommodationTypesSchema,
  type AddUrlSourceInput,
  type AddTextSourceInput,
  type AddFaqSourceInput,
  type AddDocumentSourceInput,
  type ImportCrawledPagesInput,
  type ConfirmSiteAnalysisConsentInput,
  type SaveAccommodationTypesInput,
} from "./schema";
import type { ActionResult } from "@/lib/actionResult";
import type { KnowledgeSource } from "@/types/database";

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[String(issue.path[0])] = issue.message;
  return errors;
}

export interface InsertSourceResult {
  status: KnowledgeSource["status"];
}

async function insertSource(
  hotelId: string,
  row: {
    type: "url" | "text" | "document" | "faq";
    title: string;
    content?: string | null;
    source_url?: string | null;
    storage_path?: string | null;
    file_size_bytes?: number | null;
    mime_type?: string | null;
  }
): Promise<ActionResult<InsertSourceResult>> {
  await requireSuperadmin();
  const supabase = await createClient();

  // Created as "pending" — ingestSource() is the only thing allowed to mark
  // it "indexed", and only once chunks + embeddings have actually been
  // written. Never fake a success here.
  const { data: inserted, error } = await supabase
    .from("knowledge_sources")
    .insert({ hotel_id: hotelId, status: "pending", is_active: true, ...row })
    .select("id")
    .single();

  if (error || !inserted) {
    console.error("insertSource: supabase insert failed", { message: error?.message });
    return { ok: false, error: "Impossible d’ajouter cette source." };
  }

  const ingestResult = await ingestSource(hotelId, inserted.id);

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: { status: ingestResult.ok ? "indexed" : "error" } };
}

export async function addUrlSource(hotelId: string, input: AddUrlSourceInput): Promise<ActionResult<InsertSourceResult>> {
  const parsed = addUrlSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, { type: "url", title: parsed.data.title, source_url: parsed.data.source_url });
}

export async function addTextSource(hotelId: string, input: AddTextSourceInput): Promise<ActionResult<InsertSourceResult>> {
  const parsed = addTextSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, { type: "text", title: parsed.data.title, content: parsed.data.content });
}

export async function addFaqSource(hotelId: string, input: AddFaqSourceInput): Promise<ActionResult<InsertSourceResult>> {
  const parsed = addFaqSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, { type: "faq", title: parsed.data.title, content: parsed.data.content });
}

export async function addDocumentSource(hotelId: string, input: AddDocumentSourceInput): Promise<ActionResult<InsertSourceResult>> {
  const parsed = addDocumentSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, {
    type: "document",
    title: parsed.data.title,
    storage_path: parsed.data.storage_path,
    file_size_bytes: parsed.data.file_size_bytes,
    mime_type: parsed.data.mime_type,
  });
}

export async function reindexSource(hotelId: string, sourceId: string): Promise<ActionResult<InsertSourceResult>> {
  await requireSuperadmin();
  const supabase = await createClient();

  const { data: source, error } = await supabase
    .from("knowledge_sources")
    .select("id")
    .eq("id", sourceId)
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (error || !source) {
    return { ok: false, error: "Source introuvable." };
  }

  await supabase.from("knowledge_sources").update({ status: "pending" }).eq("id", sourceId);
  const ingestResult = await ingestSource(hotelId, sourceId);

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: { status: ingestResult.ok ? "indexed" : "error" } };
}

export interface ImportCrawledPagesResult {
  imported: number;
  updated: number;
  unchanged: number;
  errors: number;
}

/**
 * Step B of the site-analysis crawler (features/crawler/): the human has
 * already reviewed and selected pages from a read-only crawl preview — this
 * is the only step that writes to the database. Upserts by (hotel_id,
 * source_url) since there's no DB uniqueness constraint on that pair (see
 * the crawler plan — deliberately no migration for this): re-analyzing a
 * site updates existing rows instead of duplicating them, skips
 * re-embedding when content is byte-for-byte unchanged, and never touches a
 * row belonging to another hotel_id.
 */
export async function importCrawledPages(hotelId: string, input: ImportCrawledPagesInput): Promise<ActionResult<ImportCrawledPagesResult>> {
  await requireSuperadmin();

  const parsed = importCrawledPagesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Pages sélectionnées invalides." };
  }

  const supabase = await createClient();
  const { data: hotel } = await supabase.from("hotels").select("default_language").eq("id", hotelId).maybeSingle();
  const defaultLanguage = hotel?.default_language ?? null;

  // Two selected rows can share the same normalized finalUrl (e.g. the
  // preview showed a "duplicate"-status row the admin selected alongside
  // its original by mistake, or two requestedUrls that both redirected to
  // it) — dedupe BEFORE any upsert, so that never causes a second insert/
  // update/re-embed for what is really the same page.
  const seenSourceUrls = new Set<string>();
  const uniquePages = parsed.data.pages.filter((page) => {
    const sourceUrl = normalizeUrl(page.finalUrl) ?? page.finalUrl;
    if (seenSourceUrls.has(sourceUrl)) return false;
    seenSourceUrls.add(sourceUrl);
    return true;
  });

  const result: ImportCrawledPagesResult = { imported: 0, updated: 0, unchanged: 0, errors: 0 };

  for (const page of uniquePages) {
    // finalUrl, never canonicalUrl, is the page's identity — a site can
    // (and real ones do) declare the same canonical for several distinct-
    // language pages, which would silently collide here if used instead.
    const sourceUrl = normalizeUrl(page.finalUrl) ?? page.finalUrl;
    const title = page.language && defaultLanguage && page.language !== defaultLanguage ? `${page.title} — ${page.language.toUpperCase()}` : page.title;

    const { data: existing } = await supabase
      .from("knowledge_sources")
      .select("id, content")
      .eq("hotel_id", hotelId)
      .eq("source_url", sourceUrl)
      .maybeSingle();

    let sourceId: string;
    if (existing) {
      if (existing.content === page.content) {
        result.unchanged++;
        continue;
      }
      const { error: updateError } = await supabase
        .from("knowledge_sources")
        .update({ title, content: page.content, status: "pending" })
        .eq("id", existing.id)
        .eq("hotel_id", hotelId);
      if (updateError) {
        console.error("importCrawledPages: update failed", { message: updateError.message });
        result.errors++;
        continue;
      }
      sourceId = existing.id;
      result.updated++;
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from("knowledge_sources")
        .insert({ hotel_id: hotelId, type: "url", title, source_url: sourceUrl, content: page.content, status: "pending", is_active: true })
        .select("id")
        .single();
      if (insertError || !inserted) {
        console.error("importCrawledPages: insert failed", { message: insertError?.message });
        result.errors++;
        continue;
      }
      sourceId = inserted.id;
      result.imported++;
    }

    const ingestResult = await ingestSource(hotelId, sourceId);
    if (!ingestResult.ok) result.errors++;
  }

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: result };
}

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export interface SaveAccommodationTypesResult {
  accommodationTypesCreated: number;
  accommodationTypesUpdated: number;
  photosImported: number;
  photosSkippedDuplicate: number;
  photosFailed: number;
}

/**
 * Step B of the crawler's accommodation curation flow (see AnalyzeSiteModal
 * / features/crawler/extract.ts's images + guessedCapacity): a human has
 * already reviewed detected images and capacity suggestions and confirmed
 * or corrected them — this is the only step that writes to
 * accommodation_types / room_photos.
 *
 * No DB uniqueness constraint on (hotel_id, name) — same reasoning already
 * applied to knowledge_sources.source_url (see importCrawledPages above):
 * this is an occasional, low-concurrency admin action, so an app-level
 * SELECT-then-write is enough; a race condition here has no real impact.
 * Re-running this action for the same accommodation name updates the
 * existing row instead of duplicating it.
 *
 * Photos are downloaded and re-hosted, never linked to directly — the
 * incoming imageUrl came from a crawled page and is never trusted as a
 * stable, safe-to-embed URL on its own. safeFetchBinary re-validates SSRF
 * (the URL is untrusted input from the browser, same discipline as
 * importCrawledPages) and enforces the Content-Type allow-list + magic-byte
 * check; the resulting content_hash is what actually prevents importing the
 * same photo twice (see the unique index in the migration) — an image
 * already on file for this hotel is skipped, never duplicated or re-thrown
 * as an error.
 */
export async function saveAccommodationTypes(hotelId: string, input: SaveAccommodationTypesInput): Promise<ActionResult<SaveAccommodationTypesResult>> {
  await requireSuperadmin();

  const parsed = saveAccommodationTypesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Hébergements sélectionnés invalides." };
  }

  const supabase = await createClient();
  const result: SaveAccommodationTypesResult = {
    accommodationTypesCreated: 0,
    accommodationTypesUpdated: 0,
    photosImported: 0,
    photosSkippedDuplicate: 0,
    photosFailed: 0,
  };

  for (const accommodation of parsed.data.accommodationTypes) {
    const { data: existing } = await supabase
      .from("accommodation_types")
      .select("id")
      .eq("hotel_id", hotelId)
      .eq("name", accommodation.name)
      .maybeSingle();

    let accommodationTypeId: string;
    if (existing) {
      await supabase
        .from("accommodation_types")
        .update({ source_url: accommodation.sourceUrl, max_guests: accommodation.maxGuests, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .eq("hotel_id", hotelId);
      accommodationTypeId = existing.id;
      result.accommodationTypesUpdated++;
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from("accommodation_types")
        .insert({ hotel_id: hotelId, name: accommodation.name, source_url: accommodation.sourceUrl, max_guests: accommodation.maxGuests })
        .select("id")
        .single();
      if (insertError || !inserted) {
        console.error("saveAccommodationTypes: accommodation_types insert failed", { message: insertError?.message });
        continue;
      }
      accommodationTypeId = inserted.id;
      result.accommodationTypesCreated++;
    }

    for (let position = 0; position < accommodation.photos.length; position++) {
      const photo = accommodation.photos[position];
      const fetched = await safeFetchBinary(photo.imageUrl);
      if (!fetched.ok || !fetched.body || !fetched.contentHash || !fetched.contentType) {
        console.error("saveAccommodationTypes: photo download rejected", { url: photo.imageUrl, reason: fetched.errorReason });
        result.photosFailed++;
        continue;
      }

      const { data: existingPhoto } = await supabase
        .from("room_photos")
        .select("id")
        .eq("hotel_id", hotelId)
        .eq("content_hash", fetched.contentHash)
        .maybeSingle();
      if (existingPhoto) {
        result.photosSkippedDuplicate++;
        continue;
      }

      const extension = CONTENT_TYPE_EXTENSION[fetched.contentType] ?? "jpg";
      const storagePath = `${hotelId}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from("hotel-room-photos")
        .upload(storagePath, fetched.body, { upsert: false, contentType: fetched.contentType });
      if (uploadError) {
        console.error("saveAccommodationTypes: storage upload failed", { message: uploadError.message });
        result.photosFailed++;
        continue;
      }
      const { data: publicUrlData } = supabase.storage.from("hotel-room-photos").getPublicUrl(storagePath);

      const { error: photoInsertError } = await supabase.from("room_photos").insert({
        hotel_id: hotelId,
        accommodation_type_id: accommodationTypeId,
        source_page_url: photo.sourceUrl,
        source_image_url: photo.imageUrl,
        storage_path: storagePath,
        photo_url: publicUrlData.publicUrl,
        content_hash: fetched.contentHash,
        alt_text: photo.altText,
        position,
        is_selected: photo.isSelected,
      });
      if (photoInsertError) {
        console.error("saveAccommodationTypes: room_photos insert failed", { message: photoInsertError.message });
        result.photosFailed++;
        continue;
      }
      result.photosImported++;
    }
  }

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: result };
}

/**
 * Whether an admin has an ACTIVE site-analysis consent for this exact
 * (hotel, domain) pair, under the app's CURRENT_CONSENT_VERSION. `domain`
 * must be the bare domain (see features/crawler/urlPolicy.ts:getDomain) —
 * a strict per-domain check, never a wildcard; consenting for one domain
 * never satisfies this check for another. A row that exists but was
 * confirmed under an OLDER consent_version, or that has been revoked
 * (revoked_at set), does not count — both are still on record (history is
 * never deleted), they just no longer authorize anything on their own.
 *
 * Requires supabase/migrations/0003_site_analysis_consent.sql to have been
 * applied — PROPOSED, not yet applied as of this commit.
 */
export async function hasSiteAnalysisConsent(hotelId: string, domain: string): Promise<boolean> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { data } = await supabase
    .from("site_analysis_consents")
    .select("id")
    .eq("hotel_id", hotelId)
    .eq("domain", domain)
    .eq("consent_version", CURRENT_CONSENT_VERSION)
    .is("revoked_at", null)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Records the admin's explicit confirmation for one (hotel, domain) pair —
 * called only after the consent checkbox is actually checked and submitted
 * (see AnalyzeSiteModal.tsx), never pre-checked, never implied. Always an
 * INSERT, never an upsert/update: every confirmation is its own permanent
 * row (see the migration's rationale) — a re-confirmation after a
 * revocation, or under a new consent_version, simply adds another row
 * rather than overwriting the previous one. This is a permission gate
 * only: it does not relax robots.txt or the SSRF guard, both of which the
 * crawler keeps enforcing on every run regardless.
 */
export async function confirmSiteAnalysisConsent(hotelId: string, input: ConfirmSiteAnalysisConsentInput): Promise<ActionResult<null>> {
  const { userId } = await requireSuperadmin();

  const parsed = confirmSiteAnalysisConsentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Domaine invalide." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("site_analysis_consents").insert({
    hotel_id: hotelId,
    domain: parsed.data.domain,
    consent_version: CURRENT_CONSENT_VERSION,
    consent_text: SITE_ANALYSIS_CONSENT_TEXT,
    confirmed_by: userId,
    confirmed_at: new Date().toISOString(),
  });

  if (error) {
    console.error("confirmSiteAnalysisConsent: insert failed", { message: error.message });
    return { ok: false, error: "Impossible d’enregistrer le consentement." };
  }

  return { ok: true, data: null };
}

/**
 * Withdraws authorization for one (hotel, domain) pair — sets revoked_at,
 * NEVER deletes the row: the fact that this domain was authorized from
 * confirmed_at until revoked_at must remain provable afterwards. Only
 * touches currently-active rows (revoked_at is null) so it can't
 * "re-revoke" an already-revoked historical row or disturb older,
 * already-superseded consent_version rows.
 */
export async function revokeSiteAnalysisConsent(hotelId: string, domain: string): Promise<ActionResult<null>> {
  await requireSuperadmin();
  const supabase = await createClient();

  const { error } = await supabase
    .from("site_analysis_consents")
    .update({ revoked_at: new Date().toISOString() })
    .eq("hotel_id", hotelId)
    .eq("domain", domain)
    .is("revoked_at", null);

  if (error) {
    console.error("revokeSiteAnalysisConsent: update failed", { message: error.message });
    return { ok: false, error: "Impossible de révoquer le consentement." };
  }

  return { ok: true, data: null };
}

export async function toggleSourceActive(hotelId: string, sourceId: string, isActive: boolean): Promise<ActionResult<null>> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { error } = await supabase.from("knowledge_sources").update({ is_active: isActive }).eq("id", sourceId);

  if (error) {
    console.error("toggleSourceActive: supabase update failed", { message: error.message });
    return { ok: false, error: "Impossible de changer le statut." };
  }

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: null };
}

export async function deleteSource(hotelId: string, sourceId: string): Promise<ActionResult<null>> {
  await requireSuperadmin();
  const supabase = await createClient();

  const { data: source } = await supabase
    .from("knowledge_sources")
    .select("storage_path")
    .eq("id", sourceId)
    .maybeSingle();

  if (source?.storage_path) {
    await supabase.storage.from("hotel-knowledge").remove([source.storage_path]);
  }

  const { error } = await supabase.from("knowledge_sources").delete().eq("id", sourceId);

  if (error) {
    console.error("deleteSource: supabase delete failed", { message: error.message });
    return { ok: false, error: "Impossible de supprimer cette source." };
  }

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: null };
}
