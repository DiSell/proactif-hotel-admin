import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/auth/session";
import type { AnalyzeSiteResponse } from "@/features/knowledge/schema";

/**
 * Contract for the future site-analysis crawler (URL → crawl → page
 * detection → selection → knowledge ingestion). Not implemented this
 * milestone — returns a typed, explicit "not_implemented" status rather
 * than simulating fake crawl results.
 */
export async function POST(_request: Request, context: RouteContext<"/api/hotels/[id]/analyze">) {
  await requireSuperadmin();
  await context.params; // validates the route shape; hotel id unused until the crawler exists

  const body: AnalyzeSiteResponse = {
    status: "not_implemented",
    message: "L’analyse automatique du site n’est pas encore disponible. Ajoutez vos sources manuellement en attendant.",
  };

  return NextResponse.json(body, { status: 501 });
}
