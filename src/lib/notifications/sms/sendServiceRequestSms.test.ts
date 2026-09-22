import { describe, expect, it, vi } from "vitest";
import {
  buildServiceRequestSmsBody,
  prepareServiceRequestSms,
  sendPreparedServiceRequestSms,
  type PreparedServiceRequestSms,
} from "./sendServiceRequestSms";
import type { SmsProvider, SmsSendResult } from "./types";

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — Section 13: no real SMS in any test.
 * Every send here goes through a fake SmsProvider (never twilioSmsProvider,
 * never a real network call, never a real phone number).
 */

function fakeSupabase(hotelName: string | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (hotelName ? { data: { name: hotelName }, error: null } : { data: null, error: null }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof prepareServiceRequestSms>[0]["supabase"];
}

function preparedFixture(overrides: Partial<PreparedServiceRequestSms> = {}): PreparedServiceRequestSms {
  return {
    hotelName: "Le 1837",
    recipients: ["+33600000001"],
    guestPhoneE164: "+33612345678",
    guestName: null,
    roomNumber: null,
    guestMessage: "Merci de me rappeler dès que possible.",
    ...overrides,
  };
}

describe("prepareServiceRequestSms — validation/dedup, zero network", () => {
  it("[1 numéro configuré] -> 1 seul destinataire préparé", async () => {
    const result = await prepareServiceRequestSms({
      hotelId: "hotel-a",
      guestPhoneE164: "+33612345678",
      guestName: null,
      roomNumber: null,
      guestMessage: "Rappelez-moi",
      configuredPhones: ["+33600000001", null, null],
      supabase: fakeSupabase("Le 1837"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prepared.recipients).toEqual(["+33600000001"]);
  });

  it("[3 numéros configurés] -> 3 destinataires préparés", async () => {
    const result = await prepareServiceRequestSms({
      hotelId: "hotel-a",
      guestPhoneE164: "+33612345678",
      guestName: null,
      roomNumber: null,
      guestMessage: "Rappelez-moi",
      configuredPhones: ["+33600000001", "+33600000002", "+33600000003"],
      supabase: fakeSupabase("Le 1837"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prepared.recipients).toEqual(["+33600000001", "+33600000002", "+33600000003"]);
  });

  it("[doublon] même numéro dupliqué -> un seul destinataire, jamais deux SMS pour le même numéro", async () => {
    const result = await prepareServiceRequestSms({
      hotelId: "hotel-a",
      guestPhoneE164: "+33612345678",
      guestName: null,
      roomNumber: null,
      guestMessage: "Rappelez-moi",
      configuredPhones: ["+33600000001", "+33600000001", "+33600000002"],
      supabase: fakeSupabase("Le 1837"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prepared.recipients).toEqual(["+33600000001", "+33600000002"]);
  });

  it("[numéro secondaire vide] chaîne vide ignorée, jamais envoyée telle quelle", async () => {
    const result = await prepareServiceRequestSms({
      hotelId: "hotel-a",
      guestPhoneE164: "+33612345678",
      guestName: null,
      roomNumber: null,
      guestMessage: "Rappelez-moi",
      configuredPhones: ["+33600000001", "", "   "],
      supabase: fakeSupabase("Le 1837"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prepared.recipients).toEqual(["+33600000001"]);
  });

  it("[aucun numéro configuré] -> échoue proprement avec no_recipient_configured, jamais un throw", async () => {
    const result = await prepareServiceRequestSms({
      hotelId: "hotel-a",
      guestPhoneE164: "+33612345678",
      guestName: null,
      roomNumber: null,
      guestMessage: "Rappelez-moi",
      configuredPhones: [null, null, null],
      supabase: fakeSupabase("Le 1837"),
    });
    expect(result).toEqual({ ok: false, error: "no_recipient_configured" });
  });

  it("[plus de 3 numéros valides fournis] plafonné à 3, jamais plus", async () => {
    const result = await prepareServiceRequestSms({
      hotelId: "hotel-a",
      guestPhoneE164: "+33612345678",
      guestName: null,
      roomNumber: null,
      guestMessage: "Rappelez-moi",
      configuredPhones: ["+33600000001", "+33600000002", "+33600000003", "+33600000004"],
      supabase: fakeSupabase("Le 1837"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prepared.recipients).toHaveLength(3);
  });
});

describe("buildServiceRequestSmsBody — templates exacts (mission spec, section 10)", () => {
  it("[résident] inclut la ligne Chambre quand roomNumber est connu", () => {
    const body = buildServiceRequestSmsBody(preparedFixture({ roomNumber: "204", guestName: "Marie" }));
    expect(body).toContain("Demande de contact — Le 1837");
    expect(body).toContain("Client : Marie");
    expect(body).toContain("Téléphone : +33612345678");
    expect(body).toContain("Chambre : 204");
    expect(body).toContain("Message : Merci de me rappeler dès que possible.");
  });

  it("[non-résident] omet la ligne Chambre quand roomNumber est null — jamais 'Chambre : null'", () => {
    const body = buildServiceRequestSmsBody(preparedFixture({ roomNumber: null }));
    expect(body).not.toMatch(/Chambre/);
    expect(body).not.toMatch(/null|undefined/i);
  });

  it("[nom inconnu] omet la ligne Client — jamais 'Client : undefined'", () => {
    const body = buildServiceRequestSmsBody(preparedFixture({ guestName: null }));
    expect(body).not.toMatch(/Client/);
    expect(body).not.toMatch(/undefined/i);
  });

  it("[message long] tronqué raisonnablement, jamais un SMS de plusieurs milliers de caractères", () => {
    const body = buildServiceRequestSmsBody(preparedFixture({ guestMessage: "a".repeat(1000) }));
    const messageLine = body.split("\n").find((l) => l.startsWith("Message :"))!;
    expect(messageLine.length).toBeLessThan(400);
  });
});

describe("sendPreparedServiceRequestSms — multi-destinataires, aucun SMS réel (fake provider only)", () => {
  it("[1 numéro, succès] 1 seule tentative, résultat ok", async () => {
    const sendSms = vi.fn(async (): Promise<SmsSendResult> => ({ ok: true, providerMessageId: "SM_fake_1" }));
    const provider: SmsProvider = { sendSms };
    const results = await sendPreparedServiceRequestSms(preparedFixture({ recipients: ["+33600000001"] }), { provider });
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ toE164: "+33600000001", result: { ok: true, providerMessageId: "SM_fake_1" } }]);
  });

  it("[3 numéros] 3 tentatives indépendantes, une par destinataire", async () => {
    const sendSms = vi.fn(async (): Promise<SmsSendResult> => ({ ok: true, providerMessageId: "SM_fake" }));
    const provider: SmsProvider = { sendSms };
    const results = await sendPreparedServiceRequestSms(
      preparedFixture({ recipients: ["+33600000001", "+33600000002", "+33600000003"] }),
      { provider }
    );
    expect(sendSms).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r.toE164)).toEqual(["+33600000001", "+33600000002", "+33600000003"]);
  });

  it("[le 1er échoue, le 2e réussit] une panne sur un destinataire n'empêche jamais les suivants", async () => {
    const sendSms = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" } satisfies SmsSendResult)
      .mockResolvedValueOnce({ ok: true, providerMessageId: "SM_fake_2" } satisfies SmsSendResult);
    const provider: SmsProvider = { sendSms };
    const results = await sendPreparedServiceRequestSms(preparedFixture({ recipients: ["+33600000001", "+33600000002"] }), { provider });
    expect(results[0].result.ok).toBe(false);
    expect(results[1].result.ok).toBe(true);
  });

  it("[tous échouent] chaque tentative reste dans le résultat, aucune n'est masquée", async () => {
    const sendSms = vi.fn(async (): Promise<SmsSendResult> => ({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" }));
    const provider: SmsProvider = { sendSms };
    const results = await sendPreparedServiceRequestSms(preparedFixture({ recipients: ["+33600000001", "+33600000002", "+33600000003"] }), { provider });
    expect(results.every((r) => !r.result.ok)).toBe(true);
    expect(results).toHaveLength(3);
  });
});
