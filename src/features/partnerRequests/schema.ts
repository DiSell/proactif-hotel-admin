import { z } from "zod";
import type { PartnerRequestCommand } from "./types";

/**
 * Same E.164 shape as the DB CHECK constraints
 * (partner_requests_guest_phone_e164_format /
 * hotel_partners_request_phone_e164_format, 0020_partner_requests.sql) —
 * kept in sync deliberately, not derived from the DB at runtime. This
 * schema NEVER normalizes a raw phone number itself (e.g. "0667594298" ->
 * "+33667594298") — that responsibility belongs entirely to
 * features/partnerRequests/phoneRedaction.ts, called BEFORE this schema
 * ever sees a value. A caller must already hand in E.164 or null; anything
 * else is rejected here, not silently fixed up.
 */
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

const e164Schema = z
  .string()
  .trim()
  .regex(E164_PATTERN, "Numéro de téléphone invalide (format E.164 attendu).")
  .nullable()
  .optional();

export const createPartnerRequestSchema = z.object({
  hotelId: z.string().uuid(),
  partnerId: z.string().uuid(),
  conversationId: z.string().uuid(),
  guestName: z.string().trim().max(200, "Nom trop long.").nullable().optional(),
  /** Already-normalized E.164 or null — see this file's own doc comment on why no normalization happens here. */
  guestPhoneE164: e164Schema,
  requestCategory: z.string().trim().min(1, "La catégorie est requise.").max(100, "Catégorie trop longue."),
  requestedDate: z.string().trim().nullable().optional(),
  requestedTime: z.string().trim().max(50, "Horaire trop long.").nullable().optional(),
  partySize: z.number().int().min(1, "Le nombre de personnes doit être positif.").max(100, "Nombre de personnes trop élevé.").nullable().optional(),
  details: z.string().trim().max(2000, "Détails trop longs.").nullable().optional(),
});

export type CreatePartnerRequestInput = z.infer<typeof createPartnerRequestSchema>;

/**
 * Exactly the 14 commands apply_partner_request_command() accepts
 * (0020_partner_requests.sql section G / features/partnerRequests/types.ts)
 * — z.enum enforces this closed vocabulary before the RPC is ever called,
 * so an unrecognized command is rejected in application code with a clear
 * error, not left to surface as a raw Postgres exception.
 */
const PARTNER_REQUEST_COMMANDS = [
  "request_guest_confirmation",
  "guest_confirm",
  "partner_delivery_succeeded",
  "partner_delivery_failed",
  "partner_accept",
  "partner_reject",
  "partner_propose_alternative",
  "guest_accept_alternative",
  "guest_reject_alternative",
  "guest_notification_succeeded",
  "guest_notification_failed",
  "cancel_by_guest",
  "cancel_by_hotel",
  "cancel_by_system",
] as const satisfies readonly PartnerRequestCommand[];

export const applyPartnerRequestCommandSchema = z.object({
  partnerRequestId: z.string().uuid(),
  hotelId: z.string().uuid(),
  command: z.enum(PARTNER_REQUEST_COMMANDS, { message: "Commande inconnue." }),
  message: z.string().trim().max(2000, "Message trop long.").nullable().optional(),
  // Structured, provider-agnostic extra data (e.g. a partner-proposed
  // alternative date/time) — never a phone number, see this file's own PII
  // discipline note. Validated as "any JSON-serializable object", not a
  // specific shape: the RPC stores it as an opaque jsonb column, the
  // shape is defined by whatever future caller populates it.
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type ApplyPartnerRequestCommandInput = z.infer<typeof applyPartnerRequestCommandSchema>;
