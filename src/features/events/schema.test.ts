import { describe, expect, it } from "vitest";
import { hotelEventSchema } from "./schema";

const baseTemporary = {
  type: "temporary" as const,
  title: "Fermeture spa",
  content: "Le spa est fermé pour travaux.",
  starts_at: "2026-09-12",
  ends_at: "2026-09-18",
  is_active: true,
  show_as_banner: false,
};

const basePermanent = {
  type: "permanent" as const,
  title: "Accès spa",
  content: "Le spa est accessible aux personnes extérieures à l'hôtel.",
  starts_at: "",
  ends_at: "",
  is_active: true,
  show_as_banner: false,
};

describe("hotelEventSchema — permanent", () => {
  it("[valid] accepted, dates normalized to null", () => {
    const result = hotelEventSchema.safeParse(basePermanent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.starts_at).toBeNull();
      expect(result.data.ends_at).toBeNull();
    }
  });

  it("[dates provided on a permanent event] rejected", () => {
    const result = hotelEventSchema.safeParse({ ...basePermanent, starts_at: "2026-09-01" });
    expect(result.success).toBe(false);
  });

  it("[show_as_banner on a permanent event] rejected — a permanent fact has no period to stop displaying a banner after", () => {
    const result = hotelEventSchema.safeParse({ ...basePermanent, show_as_banner: true });
    expect(result.success).toBe(false);
  });

  it("[title required]", () => {
    expect(hotelEventSchema.safeParse({ ...basePermanent, title: "  " }).success).toBe(false);
  });

  it("[content required]", () => {
    expect(hotelEventSchema.safeParse({ ...basePermanent, content: "" }).success).toBe(false);
  });
});

describe("hotelEventSchema — temporary", () => {
  it("[valid] accepted", () => {
    expect(hotelEventSchema.safeParse(baseTemporary).success).toBe(true);
  });

  it("[missing starts_at] rejected", () => {
    const result = hotelEventSchema.safeParse({ ...baseTemporary, starts_at: "" });
    expect(result.success).toBe(false);
  });

  it("[missing ends_at] rejected", () => {
    const result = hotelEventSchema.safeParse({ ...baseTemporary, ends_at: "" });
    expect(result.success).toBe(false);
  });

  it("[ends_at before starts_at] rejected — date coherence enforced", () => {
    const result = hotelEventSchema.safeParse({ ...baseTemporary, starts_at: "2026-09-18", ends_at: "2026-09-12" });
    expect(result.success).toBe(false);
  });

  it("[ends_at equal to starts_at] accepted — a single-day event is valid", () => {
    const result = hotelEventSchema.safeParse({ ...baseTemporary, starts_at: "2026-09-12", ends_at: "2026-09-12" });
    expect(result.success).toBe(true);
  });

  it("[show_as_banner true] accepted", () => {
    expect(hotelEventSchema.safeParse({ ...baseTemporary, show_as_banner: true }).success).toBe(true);
  });

  it("[malformed date string] rejected", () => {
    expect(hotelEventSchema.safeParse({ ...baseTemporary, starts_at: "12/09/2026" }).success).toBe(false);
  });
});

describe("hotelEventSchema — shared field limits", () => {
  it("[title too long] rejected", () => {
    expect(hotelEventSchema.safeParse({ ...basePermanent, title: "a".repeat(201) }).success).toBe(false);
  });

  it("[content too long] rejected", () => {
    expect(hotelEventSchema.safeParse({ ...basePermanent, content: "a".repeat(2001) }).success).toBe(false);
  });

  it("[invalid type] rejected", () => {
    expect(hotelEventSchema.safeParse({ ...basePermanent, type: "bogus" }).success).toBe(false);
  });
});
