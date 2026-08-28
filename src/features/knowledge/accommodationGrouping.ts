/**
 * Pure logic behind AnalyzeSiteModal.tsx's "Hébergements détectés"
 * section — extracted from the component so it's directly unit-testable
 * without importing a "use client" component (which pulls in next/navigation
 * and a "use server" actions module, both fragile to import outside Next's
 * runtime — see AnalyzeSiteModal.selection.test.ts's own comment on this
 * same constraint).
 */

export type AccommodationPageClassification = "detail" | "listing" | "not_accommodation";

/** Small, generic subset of CrawlPage — only what this module needs. */
export interface AccommodationSourcePage {
  finalUrl: string;
  canonicalUrl: string | null;
  title: string;
  headings: string[];
  status: string;
  images: { url: string; alt: string | null; nearbyHeading: string | null }[];
  guessedCapacity: { value: number } | null;
}

export interface AccommodationPhotoCandidate {
  /** Normalized image URL — also the dedup key AND the React list key (globally unique after dedup, no pageIndex-imageIndex composite needed anymore). */
  key: string;
  url: string;
  alt: string | null;
  sourceUrl: string;
}

export interface AccommodationGroup {
  /** Stable canonical identity for this group — see canonicalGroupKey. Used for React keys and for keying per-group UI state (name/capacity edits, replacing the old per-sourceUrl keying now that one group can span several pages). */
  key: string;
  /** The FIRST page that produced this group — what saveAccommodationTypes receives as accommodation_types.source_url (that field is a single URL, never an array). */
  sourceUrl: string;
  /** Every page that was merged into this group, in the order encountered — length 1 unless a duplicate accommodation was found on another URL. Always includes sourceUrl as its first element. */
  mergedSourceUrls: string[];
  suggestedName: string;
  suggestedCapacity: number | null;
  /** EVERY distinct (by normalized image URL) photo detected for this accommodation — never capped/truncated. The client, or the superadmin curating on their behalf, decides which of these are actually selected — see buildAccommodationTypesPayload/AccommodationConfirmationState. */
  photos: AccommodationPhotoCandidate[];
}

/** Trim only — image URLs here are already absolute (resolved by extract.ts's safeResolve), this exists as a named, adjustable single point rather than inlining `.trim()` at every call site. */
export function normalizeImageUrl(url: string): string {
  return url.trim();
}

/**
 * Many CMS title templates append " - {siteName}" and leave a dangling
 * separator when the site-name portion is empty (observed on real crawled
 * titles, e.g. `"'Le Crib' – Chambre Appart-hôtel de luxe -"`) — purely
 * cosmetic cleanup for the SUGGESTED accommodation name; the underlying
 * page.title used for RAG import (importCrawledPages) is never touched.
 */
function cleanPageTitle(title: string): string {
  return title.replace(/\s*[-–—]\s*$/, "").trim();
}

function firstNonEmpty(...values: (string | null | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Folds a suggested name down to a comparison key: strip accents, lowercase,
 * collapse anything that isn't a letter/digit to single spaces, trim. Used
 * ONLY to decide whether two DETAIL pages are the same accommodation —
 * never written anywhere, never shown to anyone. Deliberately exact-match
 * (no fuzzy/partial matching): merging on a PARTIAL name match risks
 * silently combining two genuinely different rooms that happen to share a
 * word ("Suite Deluxe" and "Suite Familiale" must never merge just because
 * both contain "suite").
 */
function normalizeAccommodationName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks left behind by NFD normalization
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The canonical identity two DETAIL pages are merged under — generic,
 * never a hotel-specific rule. Priority order, per page:
 *
 *   1. canonicalUrl, but ONLY when the page declares one that points
 *      somewhere OTHER than itself (a self-referential canonical, which
 *      real sites commonly declare on every page, carries no merge
 *      information at all — verified on chabanettes.com, where every page
 *      canonicalizes to itself, including both "Le Crib" URLs, so this
 *      path never fires there but is kept for sites that DO declare real
 *      cross-URL canonicals).
 *   2. the normalized suggested name (title, cleaned) — what actually
 *      merges the two real "Le Crib" URLs on chabanettes.com, since both
 *      happen to carry the exact same <title>.
 *   3. the page's own finalUrl, as an absolute last resort when neither of
 *      the above yields anything usable — never the ONLY strategy tried
 *      (sourceUrl alone would silently treat every duplicate page as a
 *      distinct accommodation, exactly the bug being fixed here).
 */
function canonicalGroupKey(page: AccommodationSourcePage, suggestedName: string): string {
  if (page.canonicalUrl && page.canonicalUrl !== page.finalUrl) return `canonical:${page.canonicalUrl}`;
  const normalizedName = normalizeAccommodationName(suggestedName);
  if (normalizedName) return `name:${normalizedName}`;
  return `url:${page.finalUrl}`;
}

export interface BuildAccommodationGroupsOptions {
  isImportable: (status: string) => boolean;
  classifyAccommodationPage: (page: { url: string; title: string }) => AccommodationPageClassification;
}

/**
 * Builds one group per DISTINCT accommodation — never one per page.
 *
 * Only pages classifyAccommodationPage judges "detail" contribute a group;
 * "listing" (a pricing/category/overview page) and "not_accommodation"
 * (including editorial pages that merely mention accommodation vocabulary)
 * are skipped entirely for this purpose. This is unrelated to
 * hasImportableContent/RAG import — a "listing" page stays fully
 * importable as a knowledge_source, it simply never becomes an
 * accommodation_type candidate.
 *
 * Two "detail" pages that resolve to the same canonicalGroupKey (typically
 * the same accommodation reachable via two URLs) are merged into ONE
 * group: their photo pools are combined, THEN deduplicated globally by
 * image URL — never capped/truncated, every distinct photo is kept — so
 * the same fix that stops one page's photos from producing duplicate rows
 * also stops two pages for the same room from ever producing two
 * accommodation_type candidates for it. Which of those photos actually
 * gets shown in the chatbot is a separate, later decision (see
 * AccommodationConfirmationState/buildAccommodationTypesPayload below, and
 * room_photos.is_selected) — never decided here by capping the list.
 *
 * Deduplication is GLOBAL across the whole page set (a single
 * seenImageUrls set threaded through the loop, not reset per page/group)
 * — the same image.url appearing on two different pages, merged or not, is
 * kept only once. Never deduplicates by sourceUrl: a page (or a merged
 * group) can legitimately contribute several genuinely different photos.
 */
export function buildAccommodationGroups(
  pages: AccommodationSourcePage[],
  options: BuildAccommodationGroupsOptions
): AccommodationGroup[] {
  const seenImageUrls = new Set<string>();

  interface Accumulator {
    key: string;
    sourceUrl: string;
    mergedSourceUrls: string[];
    suggestedName: string;
    suggestedCapacity: number | null;
    photos: AccommodationPhotoCandidate[];
  }
  const groupsByKey = new Map<string, Accumulator>();
  const orderedKeys: string[] = [];

  for (const page of pages) {
    if (!options.isImportable(page.status)) continue;
    if (options.classifyAccommodationPage({ url: page.finalUrl, title: page.title }) !== "detail") continue;

    const newPhotos: AccommodationPhotoCandidate[] = [];
    for (const image of page.images) {
      const imageKey = normalizeImageUrl(image.url);
      if (seenImageUrls.has(imageKey)) continue;
      seenImageUrls.add(imageKey);
      newPhotos.push({ key: imageKey, url: image.url, alt: image.alt, sourceUrl: page.finalUrl });
    }

    const firstNearbyHeading = page.images.find((image) => image.nearbyHeading)?.nearbyHeading ?? null;
    const suggestedName = firstNonEmpty(cleanPageTitle(page.title), page.headings.find((h) => h.trim()), firstNearbyHeading);
    const key = canonicalGroupKey(page, suggestedName);

    const existing = groupsByKey.get(key);
    if (existing) {
      existing.mergedSourceUrls.push(page.finalUrl);
      existing.photos.push(...newPhotos);
      if (existing.suggestedCapacity === null && page.guessedCapacity) existing.suggestedCapacity = page.guessedCapacity.value;
      // suggestedName deliberately NOT overwritten — the first page's name wins, predictable rather than "whichever page happened to be crawled last".
    } else {
      groupsByKey.set(key, {
        key,
        sourceUrl: page.finalUrl,
        mergedSourceUrls: [page.finalUrl],
        suggestedName,
        suggestedCapacity: page.guessedCapacity?.value ?? null,
        photos: newPhotos,
      });
      orderedKeys.push(key);
    }
  }

  return orderedKeys
    .map((key) => groupsByKey.get(key)!)
    .filter((group) => group.photos.length > 0)
    .map((group) => ({
      key: group.key,
      sourceUrl: group.sourceUrl,
      mergedSourceUrls: group.mergedSourceUrls,
      suggestedName: group.suggestedName,
      suggestedCapacity: group.suggestedCapacity,
      photos: group.photos,
    }));
}

export interface ConfirmedAccommodation {
  sourceUrl: string;
  name: string;
  maxGuests: number | null;
  /**
   * EVERY distinct detected photo for this accommodation, each carrying its
   * own isSelected flag — never just the checked subset. Nothing detected
   * is ever silently dropped at save time: an unchecked photo is still
   * persisted (as room_photos.is_selected = false), so the client can
   * revisit and select it later from their own portal. See
   * saveAccommodationTypes in features/knowledge/actions.ts.
   */
  photos: { imageUrl: string; altText: string | null; sourceUrl: string; isSelected: boolean }[];
}

export interface AccommodationConfirmationState {
  /**
   * Which groups the admin has chosen to actually save as an
   * accommodation_type — independent of photo selection. A group can be
   * included with zero checked photos: "Créer/enregistrer un
   * accommodation_type ne doit PAS exiger qu'une photo soit sélectionnée."
   * (an hébergement can exist with 0 selected photos and be configured
   * later by the client).
   */
  includedGroupKeys: ReadonlySet<string>;
  checkedPhotoKeys: ReadonlySet<string>;
  /** Keyed by group.key — falls back to the group's own suggestedName when absent. */
  names: Record<string, string>;
  /** Keyed by group.key — a raw, possibly-empty/invalid string; parsed and validated here, never trusted as-is. */
  capacities: Record<string, string>;
}

/**
 * Turns explicitly INCLUDED groups into the exact payload shape
 * saveAccommodationTypes expects — ONE entry per GROUP (i.e. per DISTINCT
 * accommodation, already merged across duplicate pages by
 * buildAccommodationGroups) that's included and has a non-empty name,
 * NEVER one entry per photo, per page, or per category page. This is what
 * structurally guarantees "un accommodation_type par hébergement DETAIL
 * confirmé, jamais par photo/URL/page catégorie": the outer loop iterates
 * already-merged groups, not photos or raw pages, by construction.
 *
 * Inclusion is deliberately decoupled from photo selection (see
 * AccommodationConfirmationState.includedGroupKeys) — a group with zero
 * checked photos still produces a payload entry as long as it's included,
 * just with every one of its photos carrying isSelected: false.
 *
 * A capacity that's empty or fails to parse becomes null, exactly like an
 * admin who cleared the field — never forced, never guessed (see
 * saveAccommodationTypes' own doc comment in features/knowledge/actions.ts).
 */
export function buildAccommodationTypesPayload(
  groups: AccommodationGroup[],
  state: AccommodationConfirmationState
): ConfirmedAccommodation[] {
  const result: ConfirmedAccommodation[] = [];

  for (const group of groups) {
    if (!state.includedGroupKeys.has(group.key)) continue;

    const name = (state.names[group.key] ?? group.suggestedName).trim();
    if (!name) continue;

    const capacityRaw = (state.capacities[group.key] ?? "").trim();
    const parsedCapacity = capacityRaw ? Number.parseInt(capacityRaw, 10) : null;
    const maxGuests = parsedCapacity !== null && Number.isFinite(parsedCapacity) && parsedCapacity > 0 ? parsedCapacity : null;

    result.push({
      sourceUrl: group.sourceUrl,
      name,
      maxGuests,
      photos: group.photos.map((photo) => ({
        imageUrl: photo.url,
        altText: photo.alt,
        sourceUrl: photo.sourceUrl,
        isSelected: state.checkedPhotoKeys.has(photo.key),
      })),
    });
  }

  return result;
}
