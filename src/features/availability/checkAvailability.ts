import { decideRetry } from "./retryPolicy";
import { hasCompleteChildrenAges } from "./stayRequest";
import type {
  AvailabilityCheckState,
  AvailabilityProvider,
  AvailabilityProviderResolver,
  AvailabilityRequest,
  IntegrationError,
  RequiredField,
  StayRequestState,
} from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * checkIn/checkOut are structurally required regardless of what a provider
 * declares in `requiredFields` — AvailabilityRequest.checkIn/checkOut are
 * non-nullable strings, so a request literally cannot be constructed
 * without them. Everything else (adults, childrenCount, childrenAges,
 * rooms) is only "required" if THIS provider says so — this function never
 * assumes adults or any occupancy field is universally mandatory.
 */
function computeMissingFields(requiredFields: RequiredField[], state: StayRequestState): RequiredField[] {
  const missing: RequiredField[] = [];
  if (state.checkIn === null) missing.push("checkIn");
  if (state.checkOut === null) missing.push("checkOut");

  for (const field of requiredFields) {
    if (field === "checkIn" || field === "checkOut") continue; // already covered above, unconditionally
    if (field === "childrenAges") {
      // childrenCount = 0 needs no ages at all (see hasCompleteChildrenAges/validateStayRequestState).
      if (state.childrenCount !== null && state.childrenCount > 0 && !hasCompleteChildrenAges(state)) missing.push("childrenAges");
      continue;
    }
    if (state[field] === null) missing.push(field);
  }
  return missing;
}

function buildRequest(hotelId: string, state: StayRequestState): AvailabilityRequest {
  return {
    hotelId,
    checkIn: state.checkIn as string,
    checkOut: state.checkOut as string,
    adults: state.adults,
    childrenCount: state.childrenCount,
    childrenAges: state.childrenAges,
    rooms: state.rooms,
  };
}

/** A provider that throws instead of returning a structured AvailabilityResult.error is still handled gracefully — never crashes the chat turn, always degrades to "unknown". */
function toIntegrationError(err: unknown, hotelId: string, provider: AvailabilityProvider): IntegrationError {
  return {
    code: "PROVIDER_ERROR",
    message: "Le fournisseur a levé une erreur inattendue.",
    hotelId,
    integrationId: provider.integrationId,
    provider: provider.provider,
    retryable: true,
    cause: err,
  };
}

export interface CheckAvailabilityParams {
  hotelId: string;
  /** Already validated (see stayRequest.ts) — never a raw model extraction. */
  state: StayRequestState;
  resolver: AvailabilityProviderResolver;
}

/**
 * The only orchestration allowed to actually call an AvailabilityProvider.
 * Resolves the provider FIRST, before checking any field — NO_PROVIDER must
 * be determinable even with an incomplete state, since asking the visitor
 * for missing fields would be pointless when no provider can use them
 * anyway. UNKNOWN is never turned into UNAVAILABLE, at any step.
 */
export async function checkAvailability(params: CheckAvailabilityParams): Promise<AvailabilityCheckState> {
  const { hotelId, state, resolver } = params;

  const resolution = await resolver.resolve(hotelId);
  if (resolution.provider === null) {
    return { kind: "no_provider" };
  }
  const provider = resolution.provider;

  const missingFields = computeMissingFields(provider.requiredFields, state);
  if (missingFields.length > 0) {
    return { kind: "missing_input", missingFields };
  }

  const request = buildRequest(hotelId, state);
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await provider.checkAvailability(request);
      if (result.error) {
        const decision = decideRetry({ code: result.error.code, retryAfterSeconds: result.error.retryAfterSeconds }, attempt, Date.now() - startedAt);
        if (!decision.retry) return { kind: "unknown", error: result.error };
        await sleep(decision.delayMs);
        continue;
      }
      return { kind: "checked", result };
    } catch (err) {
      const integrationError = toIntegrationError(err, hotelId, provider);
      const decision = decideRetry({ code: integrationError.code, retryAfterSeconds: integrationError.retryAfterSeconds }, attempt, Date.now() - startedAt);
      if (!decision.retry) return { kind: "unknown", error: integrationError };
      await sleep(decision.delayMs);
    }
  }
}
