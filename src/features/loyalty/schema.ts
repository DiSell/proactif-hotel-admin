import { z } from "zod";

const optionalText = z.string().trim().max(320).optional().transform((value) => value || null);
export const customerInputSchema = z.object({
  firstName: optionalText,
  lastName: optionalText,
  email: z.string().trim().email().max(320).optional().or(z.literal("")).transform((value) => value || null),
  phone: optionalText,
  externalReference: optionalText,
}).refine((value) => Boolean(value.email || value.phone), { message: "Un email ou un téléphone est obligatoire." });

export const stayInputSchema = z.object({
  customerId: z.string().uuid(),
  checkIn: z.string().date().optional().or(z.literal("")).transform((value) => value || null),
  checkOut: z.string().date(),
  status: z.enum(["planned", "checked_in", "completed", "cancelled"]),
  externalReference: optionalText,
}).refine((value) => !value.checkIn || value.checkOut >= value.checkIn, { message: "La date de départ doit suivre l’arrivée." });

export const communicationInputSchema = z.object({
  customerId: z.string().uuid(),
  marketingAllowed: z.boolean(),
  hotelExcluded: z.boolean(),
  exclusionReason: optionalText,
});

/** Pre-transform shapes — what the client actually submits (plain strings, possibly empty/undefined), not the post-.transform() output the schema itself resolves to. */
export type CustomerInput = z.input<typeof customerInputSchema>;
export type StayInput = z.input<typeof stayInputSchema>;

