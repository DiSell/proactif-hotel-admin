import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUnsubscribeToken } from "./unsubscribeToken";

const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

afterEach(() => {
  mockCreateAdminClient.mockReset();
  delete process.env.LOYALTY_UNSUBSCRIBE_SECRET;
});

/** hotel_customers.update(...).eq("id", customerId).select("hotel_id").maybeSingle(), then hotels.select("name").eq("id", hotelId).maybeSingle(). */
function fakeAdminClient(options: { customer: { hotel_id: string } | null; hotel: { name: string } | null }) {
  const customerMaybeSingle = vi.fn(async () => ({ data: options.customer, error: null }));
  const customerSelect = vi.fn(() => ({ maybeSingle: customerMaybeSingle }));
  const customerEq = vi.fn(() => ({ select: customerSelect }));
  const update = vi.fn<(values: Record<string, unknown>) => { eq: typeof customerEq }>(() => ({ eq: customerEq }));

  const hotelMaybeSingle = vi.fn(async () => ({ data: options.hotel, error: null }));
  const hotelSelect = vi.fn(() => ({ eq: () => ({ maybeSingle: hotelMaybeSingle }) }));

  const from = vi.fn((table: string) => {
    if (table === "hotel_customers") return { update };
    if (table === "hotels") return { select: hotelSelect };
    throw new Error(`unexpected table: ${table}`);
  });
  return { from, update, customerEq, customerSelect, customerMaybeSingle };
}

describe("unsubscribeCustomerByToken", () => {
  it("[invalid token] never touches the database", async () => {
    const client = fakeAdminClient({ customer: null, hotel: null });
    mockCreateAdminClient.mockReturnValue(client);
    const { unsubscribeCustomerByToken } = await import("./unsubscribeActions");

    const result = await unsubscribeCustomerByToken("not-a-real-token");

    expect(result).toEqual({ ok: false });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("[valid token] sets customer_unsubscribed=true, scoped by the customer id embedded in the token", async () => {
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "secret-a";
    const client = fakeAdminClient({ customer: { hotel_id: "hotel-1" }, hotel: { name: "Le 1837" } });
    mockCreateAdminClient.mockReturnValue(client);
    const { unsubscribeCustomerByToken } = await import("./unsubscribeActions");
    const token = generateUnsubscribeToken("customer-1")!;

    const result = await unsubscribeCustomerByToken(token);

    expect(result).toEqual({ ok: true, hotelName: "Le 1837" });
    expect(client.update).toHaveBeenCalledWith({ customer_unsubscribed: true });
    expect(client.customerEq).toHaveBeenCalledWith("id", "customer-1");
  });

  it("[customer row not found] fails gracefully, never throws", async () => {
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "secret-a";
    const client = fakeAdminClient({ customer: null, hotel: null });
    mockCreateAdminClient.mockReturnValue(client);
    const { unsubscribeCustomerByToken } = await import("./unsubscribeActions");
    const token = generateUnsubscribeToken("customer-1")!;

    await expect(unsubscribeCustomerByToken(token)).resolves.toEqual({ ok: false });
  });

  it("[no session dependency] the token itself is the sole authorization — the doc comment mentions requireClientAccess only in prose, the executable code never calls it", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "unsubscribeActions.ts"), "utf8");
    const code = source.slice(source.indexOf("export async function unsubscribeCustomerByToken"));
    expect(code).not.toMatch(/requireClientAccess|requireHotelAccess|requireSuperadmin/);
  });
});
