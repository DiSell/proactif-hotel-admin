import { describe, expect, it } from "vitest";
import { buildHandoverPhoneRequestReply, isHumanHandoverIntent, isLikelyCurrentGuestMessage } from "./humanHandover";

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — Section 1 (détection déterministe).
 * The 8 example phrases from the mission spec, plus the mandated
 * false-positive check ("À quelle heure ouvre la réception ?").
 */
describe("isHumanHandoverIntent — vrais positifs (mission spec)", () => {
  const positives = [
    "Je veux parler à quelqu'un",
    "Je veux parler à un humain",
    "Je voudrais parler à la réception",
    "Pouvez-vous me rappeler ?",
    "Rappelez-moi",
    "Je veux être contacté par l'hôtel",
    "Passez-moi quelqu'un",
    "Je souhaite joindre la réception",
  ];

  for (const message of positives) {
    it(`[vrai positif] "${message}"`, () => {
      expect(isHumanHandoverIntent(message)).toBe(true);
    });
  }
});

describe("isHumanHandoverIntent — variantes accents/casse/formulation naturelle", () => {
  it("[casse] 'RAPPELEZ-MOI' (tout en majuscules)", () => {
    expect(isHumanHandoverIntent("RAPPELEZ-MOI")).toBe(true);
  });

  it("[accent absent] 'Je veux parler a la reception' (sans accents)", () => {
    expect(isHumanHandoverIntent("Je veux parler a la reception")).toBe(true);
  });

  it("[formulation naturelle] 'Bonjour, pourriez-vous me rappeler dès que possible ?'", () => {
    expect(isHumanHandoverIntent("Bonjour, pourriez-vous me rappeler dès que possible ?")).toBe(true);
  });

  it("[formulation naturelle] 'J'aimerais contacter l'établissement svp'", () => {
    expect(isHumanHandoverIntent("J'aimerais contacter l'établissement svp")).toBe(true);
  });

  it("[apostrophe typographique] 'Je veux parler à quelqu’un'", () => {
    expect(isHumanHandoverIntent("Je veux parler à quelqu’un")).toBe(true);
  });
});

describe("isHumanHandoverIntent — faux positifs à éviter", () => {
  it("[mission spec] 'À quelle heure ouvre la réception ?' ne doit JAMAIS déclencher", () => {
    expect(isHumanHandoverIntent("À quelle heure ouvre la réception ?")).toBe(false);
  });

  it("[bare noun] 'Où se trouve la réception ?'", () => {
    expect(isHumanHandoverIntent("Où se trouve la réception ?")).toBe(false);
  });

  it("[bare noun] 'Quels sont vos horaires de réception ?'", () => {
    expect(isHumanHandoverIntent("Quels sont vos horaires de réception ?")).toBe(false);
  });

  it("[unrelated] 'Je voudrais réserver une chambre pour ce soir'", () => {
    expect(isHumanHandoverIntent("Je voudrais réserver une chambre pour ce soir")).toBe(false);
  });

  it("[unrelated] 'Avez-vous une piscine ?'", () => {
    expect(isHumanHandoverIntent("Avez-vous une piscine ?")).toBe(false);
  });
});

describe("isLikelyCurrentGuestMessage — ne déclenche que si le visiteur s'indique explicitement sur place", () => {
  it("[explicite] 'Je suis dans ma chambre et le chauffage ne marche pas'", () => {
    expect(isLikelyCurrentGuestMessage("Je suis dans ma chambre et le chauffage ne marche pas")).toBe(true);
  });

  it("[explicite] 'Je suis actuellement à l'hôtel, pouvez-vous me rappeler ?'", () => {
    expect(isLikelyCurrentGuestMessage("Je suis actuellement à l'hôtel, pouvez-vous me rappeler ?")).toBe(true);
  });

  it("[explicite] 'Je loge chez vous depuis hier'", () => {
    expect(isLikelyCurrentGuestMessage("Je loge chez vous depuis hier")).toBe(true);
  });

  it("[explicite] 'ma chambre est trop froide'", () => {
    expect(isLikelyCurrentGuestMessage("ma chambre est trop froide")).toBe(true);
  });

  it("[jamais déduit] un simple 'Rappelez-moi' sans aucune indication de présence sur place", () => {
    expect(isLikelyCurrentGuestMessage("Rappelez-moi")).toBe(false);
  });

  it("[jamais déduit] une question générale sur l'hôtel", () => {
    expect(isLikelyCurrentGuestMessage("Quels sont vos tarifs pour une chambre double ?")).toBe(false);
  });
});

describe("buildHandoverPhoneRequestReply — texte fixe, déterministe, jamais généré par le modèle", () => {
  it("[stable] retourne toujours exactement le même texte", () => {
    expect(buildHandoverPhoneRequestReply()).toBe(buildHandoverPhoneRequestReply());
    expect(buildHandoverPhoneRequestReply()).toMatch(/téléphone/i);
  });
});
