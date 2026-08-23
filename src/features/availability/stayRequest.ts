import type { StayRequestState } from "./types";

/**
 * VALIDATION = deterministic, field by field. Extraction (extractStayRequest.ts)
 * is probabilistic — this file never calls OpenAI, never touches Supabase,
 * and is the ONLY thing allowed to decide a field is trustworthy enough to
 * keep. An invalid value collapses to null for THAT field alone; it never
 * blocks or discards any other field, and never invents a value.
 */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string | null): value is string {
  if (value === null || !ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  // Date silently rolls invalid days/months forward (e.g. 2026-02-30 ->
  // 2026-03-02) — reject anything that doesn't round-trip back exactly.
  return date.toISOString().slice(0, 10) === value;
}

function validateDates(checkIn: string | null, checkOut: string | null): { checkIn: string | null; checkOut: string | null } {
  const validCheckIn = isValidIsoDate(checkIn) ? checkIn : null;
  const validCheckOut = isValidIsoDate(checkOut) ? checkOut : null;

  if (validCheckIn !== null && validCheckOut !== null && validCheckOut <= validCheckIn) {
    // Both individually valid but the range is backwards/empty — checkIn is
    // kept (it's a real, plausible fact) and only checkOut is discarded, so
    // the chatbot can ask a single targeted question ("quelle est votre
    // date de départ ?") instead of re-extracting everything.
    return { checkIn: validCheckIn, checkOut: null };
  }
  return { checkIn: validCheckIn, checkOut: validCheckOut };
}

function validateNonNegative(value: number | null, minimum = 0): number | null {
  if (value === null || !Number.isFinite(value) || value < minimum) return null;
  return value;
}

function validateChildrenAges(childrenCount: number | null, childrenAges: number[] | null): number[] | null {
  if (childrenCount === 0) return [];
  if (childrenAges === null) return null;
  const isValid = childrenAges.length <= (childrenCount ?? Infinity) && childrenAges.every((age) => Number.isFinite(age) && age >= 0 && age <= 17);
  return isValid ? childrenAges : null;
}

/**
 * Applies every field-level rule independently. See stayRequest.test.ts for
 * the exact matrix — in particular: an invalid checkOut never takes a valid
 * checkIn down with it, and an invalid childrenAges never invalidates an
 * otherwise-valid childrenCount.
 */
export function validateStayRequestState(raw: StayRequestState): StayRequestState {
  const { checkIn, checkOut } = validateDates(raw.checkIn, raw.checkOut);
  const adults = validateNonNegative(raw.adults);
  const childrenCount = validateNonNegative(raw.childrenCount);
  const rooms = validateNonNegative(raw.rooms, 1);
  const childrenAges = validateChildrenAges(childrenCount, raw.childrenAges);

  return { checkIn, checkOut, adults, childrenCount, childrenAges, rooms };
}

/** True only when childrenCount is known AND childrenAges holds exactly that many ages — a partial list is never presented as complete. */
export function hasCompleteChildrenAges(state: StayRequestState): boolean {
  return state.childrenCount !== null && state.childrenAges !== null && state.childrenAges.length === state.childrenCount;
}

/** Structural coherence only (already enforced by validateStayRequestState for a validated state) — exposed separately so callers can check a not-yet-validated patch. */
export function isChildrenStateValid(state: StayRequestState): boolean {
  if (state.childrenCount === 0) return state.childrenAges === null || state.childrenAges.length === 0;
  if (state.childrenAges === null) return true;
  return state.childrenCount !== null && state.childrenAges.length <= state.childrenCount;
}
