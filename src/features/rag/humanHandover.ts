/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — deterministic detection only, same
 * discipline as hotelMediaGallery.ts's own isHotelMediaPhotoRequest: the
 * model NEVER classifies this intent, so there is no way for it to
 * hallucinate a handover request the visitor never actually made (see this
 * chantier's own audit, section 1 — "ATTENTION AUX FAUX POSITIFS").
 *
 * A bare mention of "réception" alone (e.g. "à quelle heure ouvre la
 * réception ?") must never match — every pattern below requires an explicit
 * contact/callback VERB (parler à, joindre, contacter, rappeler, passez-moi,
 * être contacté/rappelé par), never the noun on its own.
 */

const HUMAN_HANDOVER_PATTERNS: RegExp[] = [
  /\bparler\s+[àa]\s+(quelqu['’]un|un\s+humain|une\s+personne|la\s+r[ée]ception|le\s+personnel|un\s+conseiller|un\s+responsable)\b/i,
  /\b(joindre|contacter)\s+la\s+r[ée]ception\b/i,
  /\bcontacter\s+l['’]?(h[ôo]tel|[ée]tablissement)\b/i,
  /\brappelez[\s-]moi\b/i,
  /\b(pouvez[\s-]vous\s+)?me\s+rappeler\b/i,
  // No leading \b: `\b` never matches immediately before an accented
  // character in non-unicode JS regex (ê is not a \w character), same
  // lesson already learned the hard way in hotelMediaGallery.ts's own
  // isHotelMediaPhotoRequest — see that file's own patterns for the fix.
  /[êe]tre\s+(rappel[ée]e?|contact[ée]e?)\s+par\s+(l['’]?(h[ôo]tel|[ée]tablissement)|quelqu['’]un|un\s+membre)\b/i,
  /\bpassez[\s-]moi\s+quelqu['’]un\b/i,
  /\bcontactez[\s-]moi\b/i,
];

/** See this file's own header comment — every pattern requires a contact/callback verb, never a bare "réception"/"hôtel". */
export function isHumanHandoverIntent(message: string): boolean {
  return HUMAN_HANDOVER_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Deterministic "is the visitor currently on-site" signal — the ONLY thing
 * that gates whether the widget's phone form also shows a room-number field
 * (see this chantier's own spec, section 3: room number is FACULTATIF, never
 * asked of every visitor, never deduced/invented). A visitor who says
 * nothing of the sort is never asked for a room number — no CustomerStay
 * lookup, no chatbotIdentity/0045 involvement.
 */
const CURRENT_GUEST_PATTERNS: RegExp[] = [
  /\bje\s+suis\s+(actuellement\s+)?(dans\s+ma\s+chambre|[àa]\s+l['’]h[ôo]tel|sur\s+place|r[ée]sident[e]?|client[e]?\s+chez\s+vous|log[ée]e?\s+chez\s+vous|log[ée]e?\s+ici)\b/i,
  /\bje\s+loge\s+(chez\s+vous|ici|[àa]\s+l['’]h[ôo]tel)\b/i,
  /\bma\s+chambre\b/i,
];

export function isLikelyCurrentGuestMessage(message: string): boolean {
  return CURRENT_GUEST_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Fixed, deterministic invitation shown the moment a handover is detected —
 * never model-generated: this turn's outcome (show the phone form) is
 * already fully decided server-side, so there is zero contradiction risk to
 * guard against, unlike hotelMediaGallery's own text-vs-truth fix. The
 * widget's dedicated structured form (see features/rag/types.ts:
 * HandoverPhonePrompt) is what actually collects the number.
 */
export function buildHandoverPhoneRequestReply(): string {
  return "Bien sûr, je transmets votre demande à l'équipe de l'établissement. Merci d'indiquer votre numéro de téléphone ci-dessous pour être rappelé(e) dans les meilleurs délais.";
}
