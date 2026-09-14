export interface CustomerCommunicationFlags {
  email: string | null;
  marketingAllowed: boolean;
  hotelExcluded: boolean;
  customerUnsubscribed: boolean;
}

export type IneligibilityReason = "missing_email" | "customer_unsubscribed" | "hotel_excluded" | "marketing_not_allowed";

export type EligibilityResult = { eligible: true } | { eligible: false; reason: IneligibilityReason };

/** Fail-closed marketing eligibility, in the mandated priority order. */
export function evaluateMarketingEligibility(customer: CustomerCommunicationFlags): EligibilityResult {
  if (customer.customerUnsubscribed) return { eligible: false, reason: "customer_unsubscribed" };
  if (customer.hotelExcluded) return { eligible: false, reason: "hotel_excluded" };
  if (!customer.marketingAllowed) return { eligible: false, reason: "marketing_not_allowed" };
  if (!customer.email?.trim()) return { eligible: false, reason: "missing_email" };
  return { eligible: true };
}

/** Post-stay service follow-up is distinct from marketing, but explicit blocks still win. */
export function evaluatePostStayEligibility(customer: CustomerCommunicationFlags): EligibilityResult {
  if (customer.customerUnsubscribed) return { eligible: false, reason: "customer_unsubscribed" };
  if (customer.hotelExcluded) return { eligible: false, reason: "hotel_excluded" };
  if (!customer.email?.trim()) return { eligible: false, reason: "missing_email" };
  return { eligible: true };
}

