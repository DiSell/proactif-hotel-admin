import { createClientPortalClient } from "@/lib/supabase/server";
import { requireClientAccess } from "@/lib/auth/session";
import type { CustomerStay, HotelCustomer, LoyaltyCampaign, LoyaltyDelivery, LoyaltySettings } from "@/types/database";
import { evaluateMarketingEligibility } from "./eligibility";

const CUSTOMERS_LIST_LIMIT = 200;
// Matches campaignSchema's own customerIds cap (campaignSchema.ts) — the
// campaign builder must be able to see and select from every customer a
// campaign could actually target, unlike the browsing-oriented list page
// above, which paginates at CUSTOMERS_LIST_LIMIT for display purposes only.
const CAMPAIGN_BUILDER_CUSTOMERS_LIMIT = 10_000;

/**
 * Escapes the characters that are syntactically significant to PostgREST's
 * `.or()` filter grammar (comma separates conditions, parentheses group
 * them) before the search term is interpolated into a filter string below.
 * Without this, a search term containing "," or "("/")" could break the
 * filter syntax or silently add unintended OR-clauses — never a cross-tenant
 * leak (hotel_id stays a separate, always-applied `.eq()`), but a real
 * correctness/robustness bug on arbitrary user input.
 */
export function sanitizeForOrFilter(value: string): string {
  return value.replace(/[,()]/g, " ");
}

async function attachLastStay(supabase: Awaited<ReturnType<typeof createClientPortalClient>>, hotelId: string, customers: HotelCustomer[]) {
  const ids = customers.map((customer) => customer.id);
  const { data: stays } = ids.length
    ? await supabase.from("customer_stays").select("customer_id,check_out").eq("hotel_id", hotelId).in("customer_id", ids).order("check_out", { ascending: false })
    : { data: [] };
  const lastStay = new Map<string, string>();
  for (const stay of stays ?? []) {
    if (!lastStay.has(stay.customer_id)) lastStay.set(stay.customer_id, stay.check_out);
  }
  return Object.fromEntries(lastStay);
}

export async function getCustomers(search = "") {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  let query = supabase.from("hotel_customers").select("*").eq("hotel_id", hotelId).order("last_name").limit(CUSTOMERS_LIST_LIMIT);
  const trimmedSearch = search.trim();
  if (trimmedSearch) {
    const safeSearch = sanitizeForOrFilter(trimmedSearch);
    query = query.or(`first_name.ilike.%${safeSearch}%,last_name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const customers = (data ?? []) as HotelCustomer[];
  const lastStay = await attachLastStay(supabase, hotelId, customers);
  return { customers, lastStay };
}

export async function getLoyaltyOverview() {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();
  const [{ data: settings }, { data: campaigns }, { count: deliveries }] = await Promise.all([
    supabase.from("loyalty_settings").select("*").eq("hotel_id", hotelId).maybeSingle<LoyaltySettings>(),
    supabase.from("loyalty_campaigns").select("*").eq("hotel_id", hotelId).order("created_at", { ascending: false }).limit(10),
    supabase.from("loyalty_deliveries").select("id", { count: "exact", head: true }).eq("hotel_id", hotelId),
  ]);
  return { settings: settings ?? null, campaigns: (campaigns ?? []) as LoyaltyCampaign[], deliveries: deliveries ?? 0 };
}

export async function getCampaigns() {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();
  const { data, error } = await supabase.from("loyalty_campaigns").select("*").eq("hotel_id", hotelId).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as LoyaltyCampaign[];
}

/**
 * Feeds the campaign builder's customer picker and its "éligibles/exclus"
 * counts — deliberately NOT getCustomers() above, which paginates at
 * CUSTOMERS_LIST_LIMIT (200) for the browsing list page. The actual send
 * (features/loyalty/worker.ts, "general" audience) queries every one of the
 * hotel's customers with no cap at all; capping the builder at 200 would
 * silently under-count eligibility and make targeting impossible beyond the
 * first 200 customers (by last_name) for any hotel past that size.
 */
export async function getCampaignBuilderData() {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();
  const { data, error } = await supabase.from("hotel_customers").select("*").eq("hotel_id", hotelId).order("last_name").limit(CAMPAIGN_BUILDER_CUSTOMERS_LIMIT);
  if (error) throw new Error(error.message);

  return ((data ?? []) as HotelCustomer[]).map((customer) => ({
    ...customer,
    eligibility: evaluateMarketingEligibility({
      email: customer.email,
      marketingAllowed: customer.marketing_allowed,
      hotelExcluded: customer.hotel_excluded,
      customerUnsubscribed: customer.customer_unsubscribed,
    }),
  }));
}

export async function getCampaignDetail(id: string) {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();
  const [{ data: campaign }, { data: selected }, { data: deliveries }] = await Promise.all([
    supabase.from("loyalty_campaigns").select("*").eq("hotel_id", hotelId).eq("id", id).maybeSingle<LoyaltyCampaign>(),
    supabase.from("loyalty_campaign_customers").select("customer_id").eq("hotel_id", hotelId).eq("campaign_id", id),
    supabase.from("loyalty_deliveries").select("*").eq("hotel_id", hotelId).eq("campaign_id", id),
  ]);
  return campaign ? { campaign, selected: selected ?? [], deliveries: (deliveries ?? []) as LoyaltyDelivery[] } : null;
}

export async function getCustomerDetail(customerId: string) {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();
  const [{ data: customer }, { data: stays }, { data: deliveries }] = await Promise.all([
    supabase.from("hotel_customers").select("*").eq("hotel_id", hotelId).eq("id", customerId).maybeSingle<HotelCustomer>(),
    supabase.from("customer_stays").select("*").eq("hotel_id", hotelId).eq("customer_id", customerId).order("check_out", { ascending: false }),
    supabase.from("loyalty_deliveries").select("*").eq("hotel_id", hotelId).eq("customer_id", customerId).order("created_at", { ascending: false }),
  ]);
  return customer ? { customer, stays: (stays ?? []) as CustomerStay[], deliveries: (deliveries ?? []) as LoyaltyDelivery[] } : null;
}
