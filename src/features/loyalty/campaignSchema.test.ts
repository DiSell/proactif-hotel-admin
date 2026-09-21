import { describe, expect, it } from "vitest";
import { loyaltySettingsSchema } from "./campaignSchema";

const valid = {
  enabled: true,
  delayDays: 3,
  thankYouEnabled: true,
  subject: "Merci pour votre séjour",
  content: "Merci d'avoir séjourné chez nous.",
  reviewEnabled: false,
  reviewContent: "Votre avis nous serait précieux.",
  reviewUrl: "",
  reviewButtonLabel: "Laisser un avis",
};

describe("loyaltySettingsSchema — independent thank-you / review blocks", () => {
  it("[1] thank_you=true, review=false — valid", () => {
    expect(loyaltySettingsSchema.safeParse(valid).success).toBe(true);
  });

  it("[2] thank_you=true, review=true + valid URL — valid", () => {
    const result = loyaltySettingsSchema.safeParse({ ...valid, reviewEnabled: true, reviewUrl: "https://g.page/r/example/review" });
    expect(result.success).toBe(true);
  });

  it("[thank_you=false, review=true + valid URL] review-only is valid on its own", () => {
    const result = loyaltySettingsSchema.safeParse({ ...valid, thankYouEnabled: false, reviewEnabled: true, reviewUrl: "https://example.com/review" });
    expect(result.success).toBe(true);
  });

  it("[3] review=true + URL absent — refused", () => {
    const result = loyaltySettingsSchema.safeParse({ ...valid, reviewEnabled: true, reviewUrl: "" });
    expect(result.success).toBe(false);
  });

  it("[4] review=true + URL invalid (javascript:) — refused", () => {
    const result = loyaltySettingsSchema.safeParse({ ...valid, reviewEnabled: true, reviewUrl: "javascript:alert(1)" });
    expect(result.success).toBe(false);
  });

  it("[4b] review=true + URL invalid (data:) — refused", () => {
    const result = loyaltySettingsSchema.safeParse({ ...valid, reviewEnabled: true, reviewUrl: "data:text/html,<script>alert(1)</script>" });
    expect(result.success).toBe(false);
  });

  it("[4c] review=true + URL missing scheme — refused", () => {
    const result = loyaltySettingsSchema.safeParse({ ...valid, reviewEnabled: true, reviewUrl: "g.page/r/example" });
    expect(result.success).toBe(false);
  });

  it("[5] both blocks disabled — refused (no useful message would be produced)", () => {
    const result = loyaltySettingsSchema.safeParse({ ...valid, thankYouEnabled: false, reviewEnabled: false });
    expect(result.success).toBe(false);
  });

  it("accepts an http (non-https) review URL, same rule as booking_url elsewhere", () => {
    const result = loyaltySettingsSchema.safeParse({ ...valid, reviewEnabled: true, reviewUrl: "http://example.com/review" });
    expect(result.success).toBe(true);
  });
});
