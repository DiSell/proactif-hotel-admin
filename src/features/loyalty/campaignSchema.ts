import { z } from "zod";
export const loyaltySettingsSchema = z.object({ enabled: z.boolean(), delayDays: z.number().int().min(0).max(365), subject: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(20_000) });
export const campaignSchema = z.object({
  internalName: z.string().trim().min(1).max(200), subject: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(20_000), offerText: z.string().trim().max(5_000).nullable(), audienceType: z.enum(["general", "targeted"]), scheduledAt: z.string().datetime().nullable(), customerIds: z.array(z.string().uuid()).max(10_000),
}).refine((value)=>value.audienceType==="general"||value.customerIds.length>0,{message:"Sélectionnez au moins un client."});

