import type { ChatbotSettings } from "@/types/database";

/**
 * Single source of truth for "does this hotel's OWN toggle allow Camille to
 * ever communicate a price" — every caller reads the setting through this
 * function instead of repeating `settings?.allow_price_communication ?? false`
 * independently in several files, which would risk silently diverging.
 * `=== true` rather than `?? false`: any non-boolean-true value (null
 * settings row, undefined, a stray non-boolean) closes the gate — secure by
 * default, never open by accident.
 *
 * IMPORTANT — this is a NECESSARY condition, never a SUFFICIENT one:
 *
 *   canCommunicatePrice = hotelAllowsPriceCommunication && priceIsCertified
 *
 * `isPriceCommunicationAllowed` only answers the FIRST half. The second half
 * — "is THIS specific amount actually certified" — is answered by
 * `containsUnauthorizedMonetaryAmount` below, against the exact list of
 * amounts the server itself computed as certified for this turn (see
 * answer.ts's own `authorizedPriceAmounts`). Turning the hotel toggle ON
 * does NOT retroactively certify anything found in free text (RAG chunks,
 * knowledge sources, partner/event descriptions) — today the ONLY
 * certifiable source is the spa's own structured
 * hotel_spa_settings.price_per_person. A future second certified source
 * must compute its own real, server-known amount and add it to that same
 * list — it must never be certified merely because the hotel toggle is ON.
 */
export function isPriceCommunicationAllowed(settings: ChatbotSettings | null | undefined): boolean {
  return settings?.allow_price_communication === true;
}

/**
 * Currency symbol/word immediately adjacent (only whitespace in between) to
 * a numeric amount — deliberately narrow so it NEVER matches a bare number
 * on its own: "45 m²", "4 personnes", "22 septembre", "10h30" all lack any
 * currency marker and are never touched. Requires the marker, not just a
 * digit, precisely so surfaces/capacities/dates/times stay untouched
 * exactly as required.
 *
 * Covers (case-insensitively): €, $, £, and the words eur/euro(s)/usd/
 * dollar(s)/gbp/livre(s) — on either side of the amount ("288 €" and
 * "€288"), with an optional decimal separator (comma or dot, 1-2 digits):
 * "288,00 €", "288.00 EUR", "288 euros". The amount itself is captured (two
 * alternative groups, depending which side the currency marker is on) so
 * callers can recover the actual numeric value, not just "a match exists"
 * — see extractMonetaryAmounts below. A fresh RegExp is constructed on
 * every call (never a shared, stateful `g`-flagged instance reused across
 * calls) — avoids the classic lastIndex bug where a stateful regex's
 * .test()/.exec() silently starts skipping matches after repeated calls.
 */
const CURRENCY_SYMBOL = "[€$£]";
const CURRENCY_WORD = "(?:eur|euros?|usd|dollars?|gbp|livres?(?:\\s+sterling)?)";
const AMOUNT = "\\d+(?:[.,]\\d{1,2})?";

function monetaryPattern(): RegExp {
  return new RegExp(
    `(?:(${AMOUNT})\\s*(?:${CURRENCY_SYMBOL}|\\b${CURRENCY_WORD}\\b)|(?:${CURRENCY_SYMBOL}|\\b${CURRENCY_WORD}\\b)\\s*(${AMOUNT}))`,
    "gi"
  );
}

/** True the moment ANY monetary expression is found — used for the always-on RAG context redaction (see redactMonetaryAmounts/answer.ts). Never used for the output-side lock decision — see containsUnauthorizedMonetaryAmount for that. */
export function containsMonetaryAmount(text: string): boolean {
  return monetaryPattern().test(text);
}

/**
 * Every monetary amount found in the text, as normalized numbers (comma
 * decimal separator converted to a dot, currency marker stripped) — "288 €",
 * "288,00 €" and "288.00 EUR" all normalize to 288. Order matches the order
 * amounts appear in the text; duplicates are kept (a text mentioning the
 * same amount twice yields it twice) since callers only ever check
 * membership, never count.
 */
export function extractMonetaryAmounts(text: string): number[] {
  const pattern = monetaryPattern();
  const amounts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1] ?? match[2];
    if (raw) amounts.push(parseFloat(raw.replace(",", ".")));
  }
  return amounts;
}

/**
 * Replaces every detected monetary expression with a neutral placeholder,
 * leaving everything else in the text untouched — including non-monetary
 * numbers in the SAME sentence ("Deluxe, 45 m², climatisation, 288 € la
 * nuit" keeps "45 m²" and "climatisation" intact, only "288 €" is redacted).
 *
 * UNCONDITIONAL — applied to every RAG-sourced chunk (general retrieval AND
 * the accommodation-specific scoped retrieval alike) regardless of
 * allow_price_communication: free text from knowledge_chunks is NEVER a
 * certified price source (see isPriceCommunicationAllowed's own doc
 * comment), so the hotel's own toggle must never control this — see
 * answer.ts's own call site, which no longer gates this behind the toggle.
 *
 * Never used on the final reply text, where a full-reply replacement is
 * used instead (see PRICE_LOCKED_FALLBACK_REPLY's own doc comment on why
 * partial redaction is deliberately NOT used there).
 */
export function redactMonetaryAmounts(text: string): string {
  return text.replace(monetaryPattern(), "[tarif non communiqué]");
}

/**
 * The output-side lock's actual decision — the authoritative half of
 * `canCommunicatePrice = hotelAllowsPriceCommunication && priceIsCertified`.
 * Extracts every monetary amount the model's own reply actually contains
 * and checks each one against `authorizedAmounts` — the exact, SERVER-
 * COMPUTED list of amounts certified for THIS turn (see answer.ts's own
 * `authorizedPriceAmounts`, built from hotel_spa_settings.price_per_person
 * today, the only certified source). The model can never self-certify: it
 * has no way to mark an amount as "this one is fine" — only membership in
 * a list the server built independently of anything the model produced
 * matters.
 *
 * A single unauthorized amount blocks the WHOLE reply (see
 * PRICE_LOCKED_FALLBACK_REPLY) even if it also contains a genuinely
 * authorized one — "50 € (spa, certified) et 288 € (Deluxe, not)" is
 * rejected in full, never partially trimmed down to just the 50 €. A reply
 * containing zero amounts, or containing ONLY amounts that match
 * `authorizedAmounts` (within a small floating-point tolerance — "50",
 * "50.00", "50,00" all compare equal), passes through unchanged.
 */
export function containsUnauthorizedMonetaryAmount(text: string, authorizedAmounts: number[]): boolean {
  const found = extractMonetaryAmounts(text);
  return found.some((amount) => !authorizedAmounts.some((allowed) => Math.abs(amount - allowed) < 0.01));
}

/**
 * The ONLY reply ever sent when the current turn's reply contains a
 * monetary amount that isn't in the server's own certified list for this
 * turn (see containsUnauthorizedMonetaryAmount) — the authoritative,
 * deterministic backstop (see answer.ts's own call sites).
 *
 * A FULL replacement, deliberately never a partial in-place redaction of
 * the offending amount within the model's own sentence: surgically cutting
 * "288 €" out of a sentence the model built AROUND that number risks a
 * broken/nonsensical result ("La Deluxe coûte  la nuit.") — a full,
 * pre-written, always-grammatical fallback is safer than trying to repair
 * arbitrary model prose after the fact. A rarer, minor cost (a mixed
 * question that also asked about surface/capacity loses that part of the
 * answer on this turn) is accepted deliberately in exchange for that
 * guarantee — see this chantier's own report for the reasoning.
 */
export const PRICE_LOCKED_FALLBACK_REPLY =
  "Je ne suis pas autorisé à communiquer de tarif pour cet établissement pour le moment. Je vous invite à contacter directement l'établissement ou à consulter son site pour connaître les prix.";
