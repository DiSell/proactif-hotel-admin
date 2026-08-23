import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isAvailabilityRequest, shouldResolveStayContext } from "./gates";

describe("isAvailabilityRequest — narrow gate", () => {
  it.each([
    "avez-vous une chambre disponible ?",
    "qu'avez-vous du 12 au 15 septembre ?",
    "est-ce disponible ce week-end ?",
    "je voudrais réserver pour demain",
    "quelles chambres sont libres ?",
  ])("[explicit availability intent] %s -> true", (message) => {
    expect(isAvailabilityRequest(message)).toBe(true);
  });

  it("[business recommendation, not an availability check] does not trigger on a plain capacity question", () => {
    expect(isAvailabilityRequest("Nous sommes 2 adultes et 1 enfant, quelle chambre nous conseillez-vous ?")).toBe(false);
  });

  it("does not trigger on an unrelated question", () => {
    expect(isAvailabilityRequest("Où est le parking ?")).toBe(false);
  });
});

describe("shouldResolveStayContext — broad gate", () => {
  it.each(["nous sommes trois", "avec un enfant de 8 ans", "nous venons ce week-end"])("[stay context signal] %s -> true", (message) => {
    expect(shouldResolveStayContext(message)).toBe(true);
  });

  it("[capacity-only question] triggers the broad gate (useful for accommodationRanking) without necessarily requesting availability", () => {
    const message = "Nous sommes 2 adultes et 1 enfant, quelle chambre nous conseillez-vous ?";
    expect(shouldResolveStayContext(message)).toBe(true);
    expect(isAvailabilityRequest(message)).toBe(false);
  });

  it("every availability request also triggers the broad gate", () => {
    expect(shouldResolveStayContext("avez-vous une chambre disponible ?")).toBe(true);
  });

  it("does not trigger on an unrelated question", () => {
    expect(shouldResolveStayContext("Où est le parking ?")).toBe(false);
  });
});

describe("gates.ts — Phase C limitation documented in code", () => {
  it("carries an explicit TODO(Phase C) note near isAvailabilityRequest", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "gates.ts"), "utf8");
    expect(source).toMatch(/TODO\(Phase C\)/);
  });
});
