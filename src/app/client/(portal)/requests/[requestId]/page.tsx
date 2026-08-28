import { notFound } from "next/navigation";
import { requireClientAccess } from "@/lib/auth/session";
import { createClientPortalClient } from "@/lib/supabase/server";
import { getPartnerRequestById, listPartnerRequestEvents } from "@/features/partnerRequests/queries";
import { listHotelPartners } from "@/features/partners/queries";
import { PartnerRequestDetailCard } from "@/features/partnerRequests/PartnerRequestDetailCard";
import { PartnerRequestEventsTimeline } from "@/features/partnerRequests/PartnerRequestEventsTimeline";
import { PageHeader } from "@/components/layout/PageHeader";

/**
 * Read-only (see PartnerRequestDetailCard.tsx/PartnerRequestEventsTimeline.tsx's
 * own doc comments) — no accept/reject/cancel/resend action here. A
 * requestId belonging to another hotel resolves to the same notFound() as
 * an unknown one, same discipline as
 * client/conversations/[conversationId]/page.tsx — getPartnerRequestById is
 * already scoped by BOTH id and hotel_id.
 */
export default async function ClientPartnerRequestDetailPage({ params }: PageProps<"/client/requests/[requestId]">) {
  const { requestId } = await params;
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  const request = await getPartnerRequestById(hotelId, requestId, supabase);
  if (!request) notFound();

  const [events, partners] = await Promise.all([
    listPartnerRequestEvents(hotelId, requestId, supabase),
    listHotelPartners(hotelId, supabase),
  ]);
  const partnerName = partners.find((partner) => partner.id === request.partner_id)?.name ?? "Partenaire";

  return (
    <div className="mx-auto flex max-w-[800px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Demande partenaire" backHref="/client/requests" backLabel="Demandes partenaires" />
      <PartnerRequestDetailCard request={request} partnerName={partnerName} />
      <div>
        <h2 className="mb-2 text-sm font-medium text-ink">Historique</h2>
        <PartnerRequestEventsTimeline events={events} />
      </div>
    </div>
  );
}
