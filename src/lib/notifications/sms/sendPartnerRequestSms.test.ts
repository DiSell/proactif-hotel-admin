import { describe, expect, it } from "vitest";
import { buildPartnerRequestReconfirmationSmsBody, buildPartnerRequestSmsBody, type PreparedPartnerRequestSms } from "./sendPartnerRequestSms";

const BASE: PreparedPartnerRequestSms = {
  purpose: "initial_request",
  requestPhoneE164: "+33612345678",
  hotelName: "Le 1837",
  requestCategory: "Restaurant",
  requestedDate: null,
  requestedTime: "20h30",
  partySize: 4,
  guestFirstName: "Marie",
  partnerResponse: null,
};

describe("buildPartnerRequestSmsBody — uses real business data, never hardcoded", () => {
  it("[hotel name from data] a different hotel name appears verbatim, proving it is never hardcoded to a specific establishment", () => {
    const body = buildPartnerRequestSmsBody({ ...BASE, hotelName: "Villa Test" }, "K7M4PZ");
    expect(body).toContain("Villa Test");
    expect(body).not.toContain("Le 1837");
  });

  it("[category, party size, time] all present in the message", () => {
    const body = buildPartnerRequestSmsBody(BASE, "K7M4PZ");
    expect(body).toContain("Restaurant");
    expect(body).toContain("4 personnes");
    expect(body).toContain("20h30");
  });

  it("[the same code appears on all three reply lines]", () => {
    const body = buildPartnerRequestSmsBody(BASE, "K7M4PZ");
    expect(body).toContain("1 K7M4PZ");
    expect(body).toContain("2 K7M4PZ");
    expect(body).toContain("3 K7M4PZ");
  });

  it("[digit 3's line never shows a bare code alone] always followed by a free-text placeholder — a reply with no text after the code is refused downstream, never accepted as a silent no-op", () => {
    const body = buildPartnerRequestSmsBody(BASE, "K7M4PZ");
    const altLine = body.split("\n").find((line) => line.startsWith("3 "));
    expect(altLine).not.toBe("3 K7M4PZ");
    expect(altLine).toMatch(/3 K7M4PZ .+/);
  });

  it("[no party size] omits the line entirely rather than printing '0 personnes' or similar", () => {
    const body = buildPartnerRequestSmsBody({ ...BASE, partySize: null }, "K7M4PZ");
    expect(body).not.toMatch(/personnes/);
  });

  it("[no guest name] omits the 'Client :' line", () => {
    const body = buildPartnerRequestSmsBody({ ...BASE, guestFirstName: null }, "K7M4PZ");
    expect(body).not.toContain("Client :");
  });
});

const RECONFIRMATION_BASE: PreparedPartnerRequestSms = { ...BASE, purpose: "alternative_acceptance", partnerResponse: "21h00" };

describe("buildPartnerRequestReconfirmationSmsBody — PHASE 2, strictly 2 options, never a digit 3", () => {
  it("[hotel name from data, never hardcoded]", () => {
    const body = buildPartnerRequestReconfirmationSmsBody({ ...RECONFIRMATION_BASE, hotelName: "Villa Test" }, "ABC123");
    expect(body).toContain("Villa Test");
    expect(body).not.toContain("Le 1837");
  });

  it("[shows partner_response verbatim, never re-derived]", () => {
    const body = buildPartnerRequestReconfirmationSmsBody(RECONFIRMATION_BASE, "ABC123");
    expect(body).toContain("21h00");
  });

  it("[exactly 2 reply lines, never a third — the client has already accepted, nothing left to counter-propose]", () => {
    const body = buildPartnerRequestReconfirmationSmsBody(RECONFIRMATION_BASE, "ABC123");
    expect(body).toContain("1 ABC123 = confirmer");
    expect(body).toContain("2 ABC123 = refuser");
    expect(body).not.toMatch(/3 ABC123/);
  });

  it("[no business value hardcoded — a different proposal text appears verbatim]", () => {
    const body = buildPartnerRequestReconfirmationSmsBody({ ...RECONFIRMATION_BASE, partnerResponse: "Terrasse indisponible, intérieur possible" }, "ABC123");
    expect(body).toContain("Terrasse indisponible, intérieur possible");
    expect(body).not.toContain("21h00");
  });

  it("[the code differs from any previously used code] a fresh code always appears, proving no reuse assumption is baked into the template itself", () => {
    const body = buildPartnerRequestReconfirmationSmsBody(RECONFIRMATION_BASE, "ZZZ999");
    expect(body).toContain("1 ZZZ999");
    expect(body).not.toContain("K7M4PZ");
  });
});

describe("sendPreparedPartnerRequestSms — branches body content by purpose", () => {
  it("[purpose=alternative_acceptance] uses the reconfirmation template, not the initial 3-option one", async () => {
    const { sendPreparedPartnerRequestSms } = await import("./sendPartnerRequestSms");
    const sendSms = async (message: { toE164: string; body: string }) => {
      expect(message.body).toContain("Confirmation demandée");
      expect(message.body).not.toMatch(/3 ABC123/);
      return { ok: true as const, providerMessageId: "SM1" };
    };
    await sendPreparedPartnerRequestSms(RECONFIRMATION_BASE, "ABC123", { provider: { sendSms } });
  });

  it("[purpose=initial_request] uses the original 3-option template", async () => {
    const { sendPreparedPartnerRequestSms } = await import("./sendPartnerRequestSms");
    const sendSms = async (message: { toE164: string; body: string }) => {
      expect(message.body).toContain("Nouvelle demande");
      expect(message.body).toContain("3 K7M4PZ");
      return { ok: true as const, providerMessageId: "SM1" };
    };
    await sendPreparedPartnerRequestSms(BASE, "K7M4PZ", { provider: { sendSms } });
  });
});
