import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { runLoyaltyJobs } from "@/features/loyalty/worker";
export const dynamic="force-dynamic";
export function isAuthorizedCronRequest(request:Request,secret=process.env.LOYALTY_CRON_SECRET){const supplied=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";if(!secret||!supplied)return false;const a=Buffer.from(secret),b=Buffer.from(supplied);return a.length===b.length&&timingSafeEqual(a,b);}
export async function POST(request:Request){if(!isAuthorizedCronRequest(request))return Response.json({error:"Unauthorized"},{status:401});try{return Response.json(await runLoyaltyJobs(createAdminClient()));}catch(error){console.error("loyalty cron failed",{message:(error as Error).message});return Response.json({error:"Job failed"},{status:500});}}
