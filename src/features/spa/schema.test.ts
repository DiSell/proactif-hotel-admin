import { describe, expect, it } from "vitest";
import { hotelSpaSettingsSchema, DEFAULT_SPA_SETTINGS_INPUT } from "./schema";

const VALID_INPUT = { ...DEFAULT_SPA_SETTINGS_INPUT, enabled: true };

describe("hotelSpaSettingsSchema", () => {
  it("[valid input] accepts the default configuration", () => {
    const result = hotelSpaSettingsSchema.safeParse(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it("[closes_at must be after opens_at]", () => {
    const result = hotelSpaSettingsSchema.safeParse({ ...VALID_INPUT, opens_at: "20:00", closes_at: "10:00" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.path[0] === "closes_at")).toBe(true);
  });

  it("[closes_at equal to opens_at is also rejected]", () => {
    const result = hotelSpaSettingsSchema.safeParse({ ...VALID_INPUT, opens_at: "10:00", closes_at: "10:00" });
    expect(result.success).toBe(false);
  });

  it("[slot duration must evenly divide the opening window] 10h-20h (600 min) is divisible by 120 but not by 90", () => {
    const divisible = hotelSpaSettingsSchema.safeParse({ ...VALID_INPUT, opens_at: "10:00", closes_at: "20:00", slot_duration_minutes: 120 });
    expect(divisible.success).toBe(true);

    const notDivisible = hotelSpaSettingsSchema.safeParse({ ...VALID_INPUT, opens_at: "10:00", closes_at: "20:00", slot_duration_minutes: 90 });
    expect(notDivisible.success).toBe(false);
    if (!notDivisible.success) expect(notDivisible.error.issues.some((i) => i.path[0] === "slot_duration_minutes")).toBe(true);
  });

  it("[no fixed duration is assumed] a hotel configuring 30-minute slots on a 9h-9h30 window is valid — the schema never hardcodes 120", () => {
    const result = hotelSpaSettingsSchema.safeParse({ ...VALID_INPUT, opens_at: "09:00", closes_at: "09:30", slot_duration_minutes: 30 });
    expect(result.success).toBe(true);
  });

  it("[capacity must be at least 1]", () => {
    const result = hotelSpaSettingsSchema.safeParse({ ...VALID_INPUT, capacity_per_slot: 0 });
    expect(result.success).toBe(false);
  });

  it("[price_per_person accepts null (not communicated)]", () => {
    const result = hotelSpaSettingsSchema.safeParse({ ...VALID_INPUT, price_per_person: null });
    expect(result.success).toBe(true);
  });

  it("[price_per_person rejects a negative value]", () => {
    const result = hotelSpaSettingsSchema.safeParse({ ...VALID_INPUT, price_per_person: -5 });
    expect(result.success).toBe(false);
  });

  it("[malformed time format is rejected]", () => {
    const result = hotelSpaSettingsSchema.safeParse({ ...VALID_INPUT, opens_at: "10h00" });
    expect(result.success).toBe(false);
  });
});
