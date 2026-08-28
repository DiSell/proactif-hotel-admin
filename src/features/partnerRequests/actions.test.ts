import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ApplyPartnerRequestCommandInput } from "./schema";
import type { PartnerRequestCommand } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

const VALID_UUID = "11111111-1111-1111-8111-111111111111";
const VALID_UUID_2 = "22222222-2222-2222-8222-222222222222";
const VALID_UUID_3 = "33333333-3333-3333-8333-333333333333";

const mockRpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>>(
  async () => ({ data: null, error: null })
);

const mockRequireHotelAccess = vi.fn<
  (hotelId: string, scope: string) => Promise<{ userId: string; profile: { id: string; role: string }; supabase: unknown }>
>(async () => ({
  userId: "user-1",
  profile: { id: "user-1", role: "superadmin" },
  supabase: { rpc: mockRpc },
}));
vi.mock("@/lib/auth/session", () => ({
  requireHotelAccess: (hotelId: string, scope: string) => mockRequireHotelAccess(hotelId, scope),
}));

afterEach(() => {
  mockRequireHotelAccess.mockClear();
  mockRpc.mockClear();
  mockRpc.mockReset();
  mockRpc.mockImplementation(async () => ({ data: null, error: null }));
});

/**
 * `scope` is NEVER a parameter of any EXPORTED function here — same
 * discipline as features/partners/actions.test.ts. Every exported action is
 * a thin, hardcoded-scope wrapper around a non-exported `*Internal`
 * function.
 */
function sliceFunction(exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}`);
  expect(start).toBeGreaterThan(-1);
  const nextExport = source.indexOf("\nexport async function", start + 1);
  const nextInternal = source.indexOf("\nasync function", start + 1);
  const boundaries = [nextExport, nextInternal].filter((i) => i !== -1);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : undefined;
  return source.slice(start, end);
}

const EXPORTED_FUNCTION_NAMES = [
  "createPartnerRequestBackoffice",
  "createPartnerRequestClient",
  "applyPartnerRequestCommandBackoffice",
  "applyPartnerRequestCommandClient",
];

describe("no exported action ever accepts a scope parameter", () => {
  it("[signature audit] none of the exported functions declares a `scope` parameter", () => {
    for (const name of EXPORTED_FUNCTION_NAMES) {
      const fn = sliceFunction(name);
      const signatureEnd = fn.indexOf("Promise<");
      const signature = fn.slice(0, signatureEnd);
      expect(signature).not.toMatch(/scope/i);
    }
  });

  it("[no AuthScope import surfaces on an exported function] AuthScope only appears on the internal helpers' own parameter", () => {
    for (const name of EXPORTED_FUNCTION_NAMES) {
      expect(sliceFunction(name)).not.toMatch(/AuthScope/);
    }
  });

  it("[no exported function accepts eventType/actorType/status/scope as input] only partnerRequestId/hotelId/command/message/metadata reach the command RPC", () => {
    const internal = source.slice(
      source.indexOf("async function applyPartnerRequestCommandInternal"),
      source.indexOf("export async function applyPartnerRequestCommandBackoffice")
    );
    expect(internal).not.toMatch(/p_event_type|p_actor_type|p_status|eventType|actorType/);
  });
});

describe("createPartnerRequestBackoffice / createPartnerRequestClient", () => {
  function validInput(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      hotelId: VALID_UUID,
      partnerId: VALID_UUID_2,
      conversationId: VALID_UUID_3,
      guestName: null,
      guestPhoneE164: null,
      requestCategory: "restaurant",
      requestedDate: null,
      requestedTime: null,
      partySize: null,
      details: null,
      ...overrides,
    };
  }

  it("[hardcoded scope, no fallback] Backoffice always passes \"backoffice\", Client always passes \"client\"", async () => {
    const { createPartnerRequestBackoffice, createPartnerRequestClient } = await import("./actions");
    mockRpc.mockResolvedValue({ data: VALID_UUID, error: null });

    await createPartnerRequestBackoffice(validInput());
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(VALID_UUID, "backoffice");

    await createPartnerRequestClient(validInput());
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(VALID_UUID, "client");
  });

  it("[calls the create_partner_request RPC, never a direct table write] no .from(...).insert(...) anywhere in this function", async () => {
    const { createPartnerRequestBackoffice } = await import("./actions");
    mockRpc.mockResolvedValueOnce({ data: VALID_UUID, error: null });

    const result = await createPartnerRequestBackoffice(validInput());

    expect(mockRpc).toHaveBeenCalledWith("create_partner_request", expect.objectContaining({ p_hotel_id: VALID_UUID }));
    expect(result).toEqual({ ok: true, data: { id: VALID_UUID } });
    expect(source).not.toMatch(/\.from\("partner_requests"\)\.insert/);
  });

  it("[invalid input] rejected by schema before requireHotelAccess/the RPC are ever called", async () => {
    const { createPartnerRequestBackoffice } = await import("./actions");

    const result = await createPartnerRequestBackoffice(validInput({ hotelId: "not-a-uuid" }));

    expect(result.ok).toBe(false);
    expect(mockRequireHotelAccess).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("[phone not normalized here] a raw national number is rejected by the schema, never silently normalized before the RPC call", async () => {
    const { createPartnerRequestBackoffice } = await import("./actions");

    const result = await createPartnerRequestBackoffice(validInput({ guestPhoneE164: "0612345678" }));

    expect(result.ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("[RPC failure] a clean ActionResult is returned, never a raw throw, and guest_phone_e164 never appears in the logged error", async () => {
    const { createPartnerRequestBackoffice } = await import("./actions");
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "constraint violation" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createPartnerRequestBackoffice(validInput({ guestPhoneE164: "+33612345678" }));

    expect(result.ok).toBe(false);
    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/\+33612345678/);
    }
    errorSpy.mockRestore();
  });

  it("[session-bound client, not service_role] the RPC is called on the client requireHotelAccess resolves", () => {
    const internal = source.slice(
      source.indexOf("async function createPartnerRequestInternal"),
      source.indexOf("export async function createPartnerRequestBackoffice")
    );
    expect(internal).toMatch(/const \{ supabase \} = await requireHotelAccess\(parsed\.data\.hotelId, scope\)/);
    expect(internal).not.toMatch(/createAdminClient/);
  });
});

describe("applyPartnerRequestCommandBackoffice / applyPartnerRequestCommandClient", () => {
  function validInput(overrides: Partial<ApplyPartnerRequestCommandInput> = {}): ApplyPartnerRequestCommandInput {
    return {
      partnerRequestId: VALID_UUID,
      hotelId: VALID_UUID_2,
      command: "request_guest_confirmation",
      message: null,
      metadata: null,
      ...overrides,
    };
  }

  it("[hardcoded scope, no fallback]", async () => {
    const { applyPartnerRequestCommandBackoffice, applyPartnerRequestCommandClient } = await import("./actions");

    await applyPartnerRequestCommandBackoffice(validInput());
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(VALID_UUID_2, "backoffice");

    await applyPartnerRequestCommandClient(validInput());
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(VALID_UUID_2, "client");
  });

  it("[calls the apply_partner_request_command RPC, never a direct table write]", async () => {
    const { applyPartnerRequestCommandBackoffice } = await import("./actions");

    const result = await applyPartnerRequestCommandBackoffice(validInput());

    expect(mockRpc).toHaveBeenCalledWith(
      "apply_partner_request_command",
      expect.objectContaining({ p_partner_request_id: VALID_UUID, p_hotel_id: VALID_UUID_2, p_command: "request_guest_confirmation" })
    );
    expect(result).toEqual({ ok: true, data: null });
    expect(source).not.toMatch(/\.from\("partner_requests"\)\.update/);
    expect(source).not.toMatch(/\.from\("partner_request_events"\)\.insert/);
  });

  it("[every one of the 14 commands reaches the RPC unchanged]", async () => {
    const { applyPartnerRequestCommandBackoffice } = await import("./actions");
    const commands = [
      "request_guest_confirmation", "guest_confirm", "partner_delivery_succeeded",
      "partner_delivery_failed", "partner_accept", "partner_reject",
      "partner_propose_alternative", "guest_accept_alternative", "guest_reject_alternative",
      "guest_notification_succeeded", "guest_notification_failed",
      "cancel_by_guest", "cancel_by_hotel", "cancel_by_system",
    ] as const satisfies readonly PartnerRequestCommand[];
    expect(commands).toHaveLength(14);

    for (const command of commands) {
      mockRpc.mockClear();
      await applyPartnerRequestCommandBackoffice(validInput({ command }));
      expect(mockRpc).toHaveBeenCalledWith("apply_partner_request_command", expect.objectContaining({ p_command: command }));
    }
  });

  it("[unknown command] rejected by the schema BEFORE the RPC is ever called — Postgres never sees it", async () => {
    const { applyPartnerRequestCommandBackoffice } = await import("./actions");

    const result = await applyPartnerRequestCommandBackoffice({
      ...validInput(),
      command: "not_a_real_command",
    } as unknown as ApplyPartnerRequestCommandInput);

    expect(result.ok).toBe(false);
    expect(mockRequireHotelAccess).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("[eventType/actorType/status smuggled in the input are never forwarded to the RPC]", async () => {
    const { applyPartnerRequestCommandBackoffice } = await import("./actions");

    await applyPartnerRequestCommandBackoffice({
      ...validInput(),
      eventType: "partner_accepted",
      actorType: "partner",
      status: "accepted",
    } as never);

    const [, rpcArgs] = mockRpc.mock.calls[0];
    expect(rpcArgs).not.toHaveProperty("p_event_type");
    expect(rpcArgs).not.toHaveProperty("p_actor_type");
    expect(rpcArgs).not.toHaveProperty("p_status");
    expect(Object.keys(rpcArgs)).toEqual(["p_partner_request_id", "p_hotel_id", "p_command", "p_message", "p_metadata"]);
  });

  it("[RPC failure] a clean ActionResult is returned, never a raw throw", async () => {
    const { applyPartnerRequestCommandBackoffice } = await import("./actions");
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "command not allowed from status draft" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await applyPartnerRequestCommandBackoffice(validInput());

    expect(result.ok).toBe(false);
    errorSpy.mockRestore();
  });

  it("[session-bound client, not service_role]", () => {
    const internal = source.slice(
      source.indexOf("async function applyPartnerRequestCommandInternal"),
      source.indexOf("export async function applyPartnerRequestCommandBackoffice")
    );
    expect(internal).toMatch(/const \{ supabase \} = await requireHotelAccess\(parsed\.data\.hotelId, scope\)/);
    expect(internal).not.toMatch(/createAdminClient/);
  });
});

describe("PII discipline — guest_phone_e164 never logged", () => {
  it("[no console call in this file interpolates guestPhoneE164/parsed.data directly]", () => {
    const logCalls = source.match(/console\.error\([^)]*\)/g) ?? [];
    for (const call of logCalls) {
      expect(call).not.toMatch(/guestPhoneE164/);
      expect(call).not.toMatch(/parsed\.data[^.]/);
    }
  });
});
