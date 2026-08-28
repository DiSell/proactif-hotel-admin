import { requireClientAccess } from "@/lib/auth/session";
import { createClientPortalClient } from "@/lib/supabase/server";
import { listPartnerRequestsForHotel } from "@/features/partnerRequests/queries";
import { listHotelPartners } from "@/features/partners/queries";
import { PartnerRequestsList } from "@/features/partnerRequests/PartnerRequestsList";
import { PageHeader } from "@/components/layout/PageHeader";

/**
 * Read-only first version (see features/partnerRequests/PartnerRequestsList.tsx's
 * own doc comment) — no create/accept/reject/cancel action is wired here.
 * Partner names are resolved via features/partners/queries.ts's own
 * already-validated, tenant-scoped listHotelPartners() — not a new ad hoc
 * read — since listPartnerRequestsForHotel only returns partner_id.
 */
export default async function ClientPartnerRequestsPage() {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  const [requests, partners] = await Promise.all([
    listPartnerRequestsForHotel(hotelId, supabase),
    listHotelPartners(hotelId, supabase),
  ]);
  const partnerNames = Object.fromEntries(partners.map((partner) => [partner.id, partner.name]));

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Demandes partenaires"
        subtitle="Les demandes envoyées à vos partenaires (restaurant, taxi, activité…) à la demande de vos visiteurs."
      />
      <PartnerRequestsList requests={requests} partnerNames={partnerNames} />
    </div>
  );
}
