import { describe, expect, it, vi } from "vitest";
import { buildHandoverConfirmationMessage, submitHandoverPhone } from "./humanHandoverFlow";
import type { SmsProvider, SmsSendResult } from "@/lib/notifications/sms/types";

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — Section 13: no real SMS anywhere in
 * this file. Every RPC/query call goes through a fake Supabase client; every
 * SMS send goes through a fake SmsProvider injected via smsProvider — never
 * twilioSmsProvider, never getSmsProvider(), never a real network call.
 */

interface FakeSettingsRow {
  handover_sms_phone_primary: string | null;
  handover_sms_phone_secondary: string | null;
  handover_sms_phone_backup: string | null;
  handoff_phone: string | null;
  handoff_email: string | null;
}

function fakeSupabase(options: {
  createRequestId?: string | null;
  createError?: { message: string } | null;
  settings?: FakeSettingsRow | null;
  hotelName?: string | null;
  recordedAttempts?: { hotelId: string; requestId: string; phone: string; status: string }[];
}) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "create_hotel_service_request_from_widget") {
      if (options.createError) return { data: null, error: options.createError };
      return { data: options.createRequestId ?? "req-1", error: null };
    }
    if (fn === "record_hotel_service_request_sms_attempt") {
      options.recordedAttempts?.push({
        hotelId: args.p_hotel_id as string,
        requestId: args.p_service_request_id as string,
        phone: args.p_recipient_phone_e164 as string,
        status: args.p_status as string,
      });
      return { data: "attempt-1", error: null };
    }
    throw new Error(`unexpected rpc: ${fn}`);
  });

  const from = vi.fn((table: string) => {
    if (table === "chatbot_settings") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: options.settings ?? null, error: null }),
          }),
        }),
      };
    }
    if (table === "hotels") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => (options.hotelName ? { data: { name: options.hotelName }, error: null } : { data: null, error: null }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  return { rpc, from } as unknown as Parameters<typeof submitHandoverPhone>[0]["supabase"];
}

const baseParams = {
  hotelId: "hotel-a",
  conversationId: "conv-1",
  phoneE164: "+33612345678",
  guestMessage: "Rappelez-moi svp",
  roomNumber: null as string | null,
};

describe("submitHandoverPhone — création de la demande (guest-safe RPC only)", () => {
  it("[RPC create échoue] retourne une erreur propre, jamais un throw", async () => {
    const supabase = fakeSupabase({ createError: { message: "db down" } });
    const result = await submitHandoverPhone({ ...baseParams, supabase });
    expect(result.ok).toBe(false);
  });
});

describe("submitHandoverPhone — sans chambre / avec chambre", () => {
  it("[message sans chambre] roomNumber null est transmis tel quel au RPC, jamais inventé", async () => {
    const recordedAttempts: { hotelId: string; requestId: string; phone: string; status: string }[] = [];
    const supabase = fakeSupabase({
      createRequestId: "req-1",
      hotelName: "Le 1837",
      settings: {
        handover_sms_phone_primary: "+33600000001",
        handover_sms_phone_secondary: null,
        handover_sms_phone_backup: null,
        handoff_phone: null,
        handoff_email: null,
      },
      recordedAttempts,
    });
    const sendSms = vi.fn(async (): Promise<SmsSendResult> => ({ ok: true, providerMessageId: "SM_1" }));
    const provider: SmsProvider = { sendSms };
    const result = await submitHandoverPhone({ ...baseParams, roomNumber: null, supabase, smsProvider: provider });
    expect(result.ok).toBe(true);
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ body: expect.not.stringContaining("Chambre") }));
  });

  it("[message avec chambre] roomNumber fourni explicitement par le visiteur apparaît dans le SMS", async () => {
    const supabase = fakeSupabase({
      createRequestId: "req-1",
      hotelName: "Le 1837",
      settings: {
        handover_sms_phone_primary: "+33600000001",
        handover_sms_phone_secondary: null,
        handover_sms_phone_backup: null,
        handoff_phone: null,
        handoff_email: null,
      },
    });
    const sendSms = vi.fn(async (): Promise<SmsSendResult> => ({ ok: true, providerMessageId: "SM_1" }));
    const provider: SmsProvider = { sendSms };
    await submitHandoverPhone({ ...baseParams, roomNumber: "204", supabase, smsProvider: provider });
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("Chambre : 204") }));
  });
});

describe("submitHandoverPhone — aucun numéro configuré", () => {
  it("[aucun numéro configuré] la demande est créée, mais le message ne prétend jamais 'transmise'", async () => {
    const supabase = fakeSupabase({
      createRequestId: "req-1",
      hotelName: "Le 1837",
      settings: { handover_sms_phone_primary: null, handover_sms_phone_secondary: null, handover_sms_phone_backup: null, handoff_phone: null, handoff_email: null },
    });
    const result = await submitHandoverPhone({ ...baseParams, supabase });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).not.toMatch(/transmise/i);
    }
  });

  it("[aucun numéro configuré, mais handoff_phone existe] le fallback propose ce numéro passif", async () => {
    const supabase = fakeSupabase({
      createRequestId: "req-1",
      hotelName: "Le 1837",
      settings: {
        handover_sms_phone_primary: null,
        handover_sms_phone_secondary: null,
        handover_sms_phone_backup: null,
        handoff_phone: "+33499999999",
        handoff_email: null,
      },
    });
    const result = await submitHandoverPhone({ ...baseParams, supabase });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toContain("+33499999999");
  });
});

describe("submitHandoverPhone — succès/échecs de transmission", () => {
  it("[au moins un SMS envoyé] confirme la transmission au client", async () => {
    const supabase = fakeSupabase({
      createRequestId: "req-1",
      hotelName: "Le 1837",
      settings: { handover_sms_phone_primary: "+33600000001", handover_sms_phone_secondary: "+33600000002", handover_sms_phone_backup: null, handoff_phone: null, handoff_email: null },
    });
    const sendSms = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" } satisfies SmsSendResult)
      .mockResolvedValueOnce({ ok: true, providerMessageId: "SM_2" } satisfies SmsSendResult);
    const provider: SmsProvider = { sendSms };
    const result = await submitHandoverPhone({ ...baseParams, supabase, smsProvider: provider });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toMatch(/transmise/i);
  });

  it("[tous les SMS échouent] ne dit jamais 'transmise', propose un contact alternatif si connu", async () => {
    const supabase = fakeSupabase({
      createRequestId: "req-1",
      hotelName: "Le 1837",
      settings: {
        handover_sms_phone_primary: "+33600000001",
        handover_sms_phone_secondary: null,
        handover_sms_phone_backup: null,
        handoff_phone: null,
        handoff_email: "contact@le1837.example.com",
      },
    });
    const sendSms = vi.fn(async (): Promise<SmsSendResult> => ({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" }));
    const provider: SmsProvider = { sendSms };
    const result = await submitHandoverPhone({ ...baseParams, supabase, smsProvider: provider });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).not.toMatch(/transmise/i);
      expect(result.message).toContain("contact@le1837.example.com");
    }
  });

  it("[jamais une erreur Twilio brute exposée au visiteur]", async () => {
    const supabase = fakeSupabase({
      createRequestId: "req-1",
      hotelName: "Le 1837",
      settings: { handover_sms_phone_primary: "+33600000001", handover_sms_phone_secondary: null, handover_sms_phone_backup: null, handoff_phone: null, handoff_email: null },
    });
    const sendSms = vi.fn(async (): Promise<SmsSendResult> => ({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" }));
    const provider: SmsProvider = { sendSms };
    const result = await submitHandoverPhone({ ...baseParams, supabase, smsProvider: provider });
    if (result.ok) {
      expect(result.message).not.toMatch(/twilio|rest exception|sid/i);
    }
  });
});

describe("buildHandoverConfirmationMessage — règle exacte (mission spec, section 12)", () => {
  it("[sent] uniquement dans ce cas la formule 'transmise' apparaît", () => {
    const message = buildHandoverConfirmationMessage("sent", { handoffPhone: null, handoffEmail: null });
    expect(message).toBe("Votre demande a bien été transmise à l'établissement. Vous serez contacté dans les meilleurs délais.");
  });

  it("[no_recipient_configured, aucun contact passif] fallback neutre générique", () => {
    const message = buildHandoverConfirmationMessage("no_recipient_configured", { handoffPhone: null, handoffEmail: null });
    expect(message).not.toMatch(/transmise/i);
  });

  it("[all_failed, contact passif disponible] fallback qui propose le contact direct", () => {
    const message = buildHandoverConfirmationMessage("all_failed", { handoffPhone: "+33499999999", handoffEmail: "hello@hotel.example.com" });
    expect(message).not.toMatch(/transmise/i);
    expect(message).toContain("+33499999999");
    expect(message).toContain("hello@hotel.example.com");
  });
});
