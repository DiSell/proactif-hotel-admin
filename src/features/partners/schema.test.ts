import { describe, expect, it } from "vitest";
import { HOTEL_PARTNER_CATEGORIES, hotelPartnerSchema } from "./schema";

function validInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "Restaurant du Centre",
    category: "restaurant",
    description: "",
    address: "",
    phone: "",
    website_url: "",
    booking_url: "",
    is_active: true,
    priority: 10,
    ...overrides,
  };
}

describe("hotelPartnerSchema — name/category", () => {
  it("[valid] accepts a well-formed partner", () => {
    expect(hotelPartnerSchema.safeParse(validInput()).success).toBe(true);
  });

  it("[blank name rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ name: "   " })).success).toBe(false);
  });

  it("[category must be from the closed list]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ category: "not_a_real_category" })).success).toBe(false);
  });

  it("[every MVP category is individually valid]", () => {
    for (const category of HOTEL_PARTNER_CATEGORIES) {
      expect(hotelPartnerSchema.safeParse(validInput({ category })).success, `category=${category}`).toBe(true);
    }
  });
});

describe("hotelPartnerSchema — URL validation (website_url/booking_url)", () => {
  it("[empty allowed] both URL fields accept an empty string (optional)", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ website_url: "", booking_url: "" })).success).toBe(true);
  });

  it("[https accepted]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ website_url: "https://example.com" })).success).toBe(true);
  });

  it("[http accepted]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ booking_url: "http://example.com/book" })).success).toBe(true);
  });

  it("[javascript: rejected] booking_url is never allowed to become an XSS vector rendered as <a href>", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ booking_url: "javascript:alert(1)" })).success).toBe(false);
  });

  it("[data: rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ website_url: "data:text/html,<script>alert(1)</script>" })).success).toBe(false);
  });

  it("[malformed URL rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ website_url: "not a url" })).success).toBe(false);
  });
});

describe("hotelPartnerSchema — priority", () => {
  it("[coerced from string] a numeric string is accepted and coerced (form inputs arrive as strings)", () => {
    const result = hotelPartnerSchema.safeParse(validInput({ priority: "42" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.priority).toBe(42);
  });

  it("[negative rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ priority: -1 })).success).toBe(false);
  });

  it("[non-numeric rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ priority: "abc" })).success).toBe(false);
  });

  it("[default-ish zero accepted]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ priority: 0 })).success).toBe(true);
  });
});

describe("hotelPartnerSchema — opening_hours", () => {
  it("[empty allowed]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ opening_hours: "" })).success).toBe(true);
  });

  it("[omitted allowed]", () => {
    expect(hotelPartnerSchema.safeParse(validInput()).success).toBe(true);
  });

  it("[free text accepted]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ opening_hours: "Lun-Sam 12h-14h, 19h-22h" })).success).toBe(true);
  });

  it("[too long rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ opening_hours: "x".repeat(301) })).success).toBe(false);
  });
});

describe("hotelPartnerSchema — email", () => {
  it("[empty allowed] a partner can exist before an email is known", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ email: "" })).success).toBe(true);
  });

  it("[omitted allowed]", () => {
    expect(hotelPartnerSchema.safeParse(validInput()).success).toBe(true);
  });

  it("[valid email accepted]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ email: "contact@partner.example.com" })).success).toBe(true);
  });

  it("[malformed email rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ email: "not-an-email" })).success).toBe(false);
  });

  it("[too long rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ email: `${"x".repeat(315)}@example.com` })).success).toBe(false);
  });
});

describe("hotelPartnerSchema — request_phone_e164 (operational WhatsApp-routing number, distinct from `phone`)", () => {
  it("[omitted] resolves to null, no error", () => {
    const result = hotelPartnerSchema.safeParse(validInput());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.request_phone_e164).toBeNull();
  });

  it("[empty string] resolves to null", () => {
    const result = hotelPartnerSchema.safeParse(validInput({ request_phone_e164: "" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.request_phone_e164).toBeNull();
  });

  it("[already E.164] accepted as-is", () => {
    const result = hotelPartnerSchema.safeParse(validInput({ request_phone_e164: "+33612345678" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.request_phone_e164).toBe("+33612345678");
  });

  it("[plausible FR national] normalized deterministically to +33, reusing phoneRedaction.ts's own function", () => {
    const result = hotelPartnerSchema.safeParse(validInput({ request_phone_e164: "06 12 34 56 78" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.request_phone_e164).toBe("+33612345678");
  });

  it("[invalid/ambiguous format] rejected with a readable message, never guessed", () => {
    const result = hotelPartnerSchema.safeParse(validInput({ request_phone_e164: "12345" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["request_phone_e164"]);
      expect(result.error.issues[0]?.message).toMatch(/invalide/i);
    }
  });

  it("[independent from the public `phone` field] setting one never affects the other", () => {
    const result = hotelPartnerSchema.safeParse(validInput({ phone: "01 23 45 67 89", request_phone_e164: "+33698765432" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe("01 23 45 67 89");
      expect(result.data.request_phone_e164).toBe("+33698765432");
    }
  });
});

describe("hotelPartnerSchema — length limits", () => {
  it("[name too long rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ name: "x".repeat(201) })).success).toBe(false);
  });

  it("[description too long rejected]", () => {
    expect(hotelPartnerSchema.safeParse(validInput({ description: "x".repeat(2001) })).success).toBe(false);
  });
});
