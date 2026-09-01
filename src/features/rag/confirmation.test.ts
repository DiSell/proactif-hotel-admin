import { describe, expect, it } from "vitest";
import { isExplicitConfirmation } from "./confirmation";

describe("isExplicitConfirmation — no implicit confirmation (extracted from partnerRequestFlow.ts, reused by spaBookingFlow.ts)", () => {
  it("[explicit affirmatives]", () => {
    for (const message of ["oui", "Oui !", "d'accord", "je confirme", "allez-y", "envoyez", "ok", "c'est bon"]) {
      expect(isExplicitConfirmation(message), message).toBe(true);
    }
  });

  it("[ambiguous or unrelated messages are never treated as confirmation]", () => {
    for (const message of ["peut-être", "je ne sais pas encore", "quel est le prix ?", "bonjour"]) {
      expect(isExplicitConfirmation(message), message).toBe(false);
    }
  });
});
