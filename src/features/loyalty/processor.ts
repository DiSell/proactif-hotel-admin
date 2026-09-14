import { evaluateMarketingEligibility, evaluatePostStayEligibility, type CustomerCommunicationFlags, type EligibilityResult } from "./eligibility";

export interface DeliveryCandidate {
  hotelId: string;
  customerId: string;
  email: string | null;
  marketingAllowed: boolean;
  hotelExcluded: boolean;
  customerUnsubscribed: boolean;
}

export function candidateFlags(candidate: DeliveryCandidate): CustomerCommunicationFlags {
  return {
    email: candidate.email,
    marketingAllowed: candidate.marketingAllowed,
    hotelExcluded: candidate.hotelExcluded,
    customerUnsubscribed: candidate.customerUnsubscribed,
  };
}

export function evaluateAtSend(candidate: DeliveryCandidate, type: "marketing" | "post_stay"): EligibilityResult {
  return type === "marketing" ? evaluateMarketingEligibility(candidateFlags(candidate)) : evaluatePostStayEligibility(candidateFlags(candidate));
}

export function campaignDeliveryKey(campaignId: string, customerId: string): string {
  return `campaign:${campaignId}:customer:${customerId}`;
}

export function postStayDeliveryKey(stayId: string): string {
  return `post-stay:${stayId}`;
}

export function belongsToHotel(candidate: DeliveryCandidate, hotelId: string): boolean {
  return candidate.hotelId === hotelId;
}
