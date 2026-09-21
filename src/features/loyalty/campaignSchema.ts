import { z } from "zod";

/**
 * Same reasoning and same check as features/hotels/schema.ts's httpUrlSchema
 * (not exported from there, so duplicated here rather than reaching across
 * features — see features/partners/schema.ts for the same precedent):
 * z.string().url() alone accepts javascript:/data:/file: URLs, which would
 * end up rendered as a real <a href> in the post-stay review email
 * (features/loyalty/worker.ts). Restricting to http/https here is what
 * makes review_url safe to render, not just documented.
 */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
const httpUrlSchema = z.string().trim().max(2048).refine(isHttpUrl, { message: "Entrez une URL valide commençant par http:// ou https://." });

export const loyaltySettingsSchema = z.object({
  enabled: z.boolean(),
  delayDays: z.number().int().min(0).max(365),
  thankYouEnabled: z.boolean(),
  subject: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  reviewEnabled: z.boolean(),
  reviewContent: z.string().trim().min(1).max(20_000),
  reviewUrl: httpUrlSchema.optional().or(z.literal("")),
  reviewButtonLabel: z.string().trim().min(1).max(100),
})
  .refine((value) => value.thankYouEnabled || value.reviewEnabled, {
    message: "Activez au moins un bloc (remerciement ou avis).",
    path: ["thankYouEnabled"],
  })
  .refine((value) => !value.reviewEnabled || Boolean(value.reviewUrl), {
    message: "Indiquez un lien d'avis valide pour activer ce bloc.",
    path: ["reviewUrl"],
  });

export const campaignSchema = z.object({
  internalName: z.string().trim().min(1).max(200), subject: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(20_000), offerText: z.string().trim().max(5_000).nullable(), audienceType: z.enum(["general", "targeted"]), scheduledAt: z.string().datetime().nullable(), customerIds: z.array(z.string().uuid()).max(10_000),
}).refine((value)=>value.audienceType==="general"||value.customerIds.length>0,{message:"Sélectionnez au moins un client."});

