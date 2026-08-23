import { describe, expect, it } from "vitest";
import { validateStayRequestState, hasCompleteChildrenAges, isChildrenStateValid } from "./stayRequest";
import type { StayRequestState } from "./types";

function state(overrides: Partial<StayRequestState> = {}): StayRequestState {
  return { checkIn: null, checkOut: null, adults: null, childrenCount: null, childrenAges: null, rooms: null, ...overrides };
}

describe("validateStayRequestState — dates", () => {
  it("[checkIn only invalid] keeps checkOut, discards only checkIn", () => {
    const result = validateStayRequestState(state({ checkIn: "not-a-date", checkOut: "2026-09-15" }));
    expect(result.checkIn).toBeNull();
    expect(result.checkOut).toBe("2026-09-15");
  });

  it("[checkOut only invalid] keeps checkIn, discards only checkOut", () => {
    const result = validateStayRequestState(state({ checkIn: "2026-09-12", checkOut: "31/12/2026" }));
    expect(result.checkIn).toBe("2026-09-12");
    expect(result.checkOut).toBeNull();
  });

  it("[both valid but reversed] keeps checkIn, discards only checkOut — never both", () => {
    const result = validateStayRequestState(state({ checkIn: "2026-09-15", checkOut: "2026-09-12" }));
    expect(result.checkIn).toBe("2026-09-15");
    expect(result.checkOut).toBeNull();
  });

  it("[equal dates] treated as an invalid range — checkIn kept, checkOut discarded", () => {
    const result = validateStayRequestState(state({ checkIn: "2026-09-12", checkOut: "2026-09-12" }));
    expect(result.checkIn).toBe("2026-09-12");
    expect(result.checkOut).toBeNull();
  });

  it("[both valid, correct order] both kept", () => {
    const result = validateStayRequestState(state({ checkIn: "2026-09-12", checkOut: "2026-09-15" }));
    expect(result.checkIn).toBe("2026-09-12");
    expect(result.checkOut).toBe("2026-09-15");
  });

  it("[calendar-invalid date] a date that doesn't round-trip (e.g. Feb 30) is rejected, not silently rolled forward", () => {
    const result = validateStayRequestState(state({ checkIn: "2026-02-30" }));
    expect(result.checkIn).toBeNull();
  });
});

describe("validateStayRequestState — numeric fields", () => {
  it("negative adults/childrenCount/rooms become null, independently", () => {
    const result = validateStayRequestState(state({ adults: -1, childrenCount: -2, rooms: -3 }));
    expect(result.adults).toBeNull();
    expect(result.childrenCount).toBeNull();
    expect(result.rooms).toBeNull();
  });

  it("rooms = 0 is invalid (must be >= 1)", () => {
    expect(validateStayRequestState(state({ rooms: 0 })).rooms).toBeNull();
  });

  it("adults/childrenCount = 0 is valid (explicit zero, not an absent value)", () => {
    const result = validateStayRequestState(state({ adults: 2, childrenCount: 0 }));
    expect(result.adults).toBe(2);
    expect(result.childrenCount).toBe(0);
  });

  it("an invalid numeric field never affects the others", () => {
    const result = validateStayRequestState(state({ adults: 2, childrenCount: -5, rooms: 1 }));
    expect(result.adults).toBe(2);
    expect(result.childrenCount).toBeNull();
    expect(result.rooms).toBe(1);
  });
});

describe("validateStayRequestState — children ages", () => {
  it("childrenCount = 0 forces childrenAges to [] — never asks for an age", () => {
    const result = validateStayRequestState(state({ childrenCount: 0, childrenAges: null }));
    expect(result.childrenAges).toEqual([]);
  });

  it("childrenAges.length > childrenCount is invalid — childrenAges alone becomes null, childrenCount stays valid", () => {
    const result = validateStayRequestState(state({ childrenCount: 1, childrenAges: [8, 12] }));
    expect(result.childrenCount).toBe(1);
    expect(result.childrenAges).toBeNull();
  });

  it("a negative or absurd age invalidates childrenAges alone", () => {
    const result = validateStayRequestState(state({ childrenCount: 1, childrenAges: [-3] }));
    expect(result.childrenAges).toBeNull();
    expect(result.childrenCount).toBe(1);

    const result2 = validateStayRequestState(state({ childrenCount: 1, childrenAges: [45] }));
    expect(result2.childrenAges).toBeNull();
  });

  it("a partial, valid list (fewer ages than childrenCount) is kept as-is — not discarded, not padded", () => {
    const result = validateStayRequestState(state({ childrenCount: 2, childrenAges: [8] }));
    expect(result.childrenAges).toEqual([8]);
    expect(result.childrenCount).toBe(2);
  });
});

describe("hasCompleteChildrenAges", () => {
  it("false when childrenAges is null (count known, ages unknown)", () => {
    expect(hasCompleteChildrenAges(state({ childrenCount: 2, childrenAges: null }))).toBe(false);
  });

  it("false when childrenAges is partial", () => {
    expect(hasCompleteChildrenAges(state({ childrenCount: 2, childrenAges: [8] }))).toBe(false);
  });

  it("true when childrenAges exactly matches childrenCount", () => {
    expect(hasCompleteChildrenAges(state({ childrenCount: 2, childrenAges: [8, 12] }))).toBe(true);
  });

  it("true for childrenCount = 0 with an empty list", () => {
    expect(hasCompleteChildrenAges(state({ childrenCount: 0, childrenAges: [] }))).toBe(true);
  });
});

describe("isChildrenStateValid", () => {
  it("valid when childrenCount = 0 and childrenAges is null or empty", () => {
    expect(isChildrenStateValid(state({ childrenCount: 0, childrenAges: null }))).toBe(true);
    expect(isChildrenStateValid(state({ childrenCount: 0, childrenAges: [] }))).toBe(true);
  });

  it("invalid when childrenAges.length exceeds childrenCount", () => {
    expect(isChildrenStateValid(state({ childrenCount: 1, childrenAges: [8, 12] }))).toBe(false);
  });

  it("invalid when childrenAges is present but childrenCount is unknown", () => {
    expect(isChildrenStateValid(state({ childrenCount: null, childrenAges: [8] }))).toBe(false);
  });
});
