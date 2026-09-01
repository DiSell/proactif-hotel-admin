import { describe, expect, it } from "vitest";
import { conversationFlaggedTemplate } from "./conversationFlagged";

function params(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    hotelName: "Le 1837",
    reason: "propos insultants",
    conversationUrl: "https://app.example.com/client/conversations/conv-1",
    ...overrides,
  } as Parameters<typeof conversationFlaggedTemplate>[0];
}

describe("conversationFlaggedTemplate", () => {
  it("[key details present]", () => {
    const template = conversationFlaggedTemplate(params());
    for (const value of ["Le 1837", "propos insultants", "https://app.example.com/client/conversations/conv-1"]) {
      expect(template.text).toContain(value);
      expect(template.html).toContain(value);
    }
  });

  it("[never repeats a raw slur/insult verbatim beyond the given neutral reason] the template itself never adds abusive content, it only ever surfaces whatever `reason` string it was given", () => {
    const template = conversationFlaggedTemplate(params({ reason: "contenu haineux" }));
    expect(template.text).toContain("contenu haineux");
    expect(template.text).not.toMatch(/\b(idiot|connard|salope)\b/i);
  });

  it("[frames blocking as the admin's own decision, never an automated action already taken]", () => {
    const template = conversationFlaggedTemplate(params());
    expect(template.text).toMatch(/aucune action n'a été prise sur votre compte/i);
  });

  it("[subject names the hotel]", () => {
    const template = conversationFlaggedTemplate(params());
    expect(template.subject).toContain("Le 1837");
  });

  it("[never marketing tone]", () => {
    const template = conversationFlaggedTemplate(params());
    for (const forbidden of [/newsletter/i, /promotion/i, /offre spéciale/i]) {
      expect(template.html).not.toMatch(forbidden);
      expect(template.text).not.toMatch(forbidden);
    }
  });
});
