import { requireClientAccess } from "@/lib/auth/session";
import { createClientPortalClient } from "@/lib/supabase/server";
import { getPhotosManagerData } from "@/features/photos/queries";
import { PhotosManager } from "@/features/photos/PhotosManager";
import { PHOTO_ACTIONS_CLIENT } from "@/features/photos/actionBundles";
import { PhotoManagementModeToggle } from "@/features/client/PhotoManagementModeToggle";
import { PageHeader } from "@/components/layout/PageHeader";
import { getHotelMediaData } from "@/features/hotelMedia/queries";
import { HotelMediaManager } from "@/features/hotelMedia/HotelMediaManager";
import { HOTEL_MEDIA_ACTIONS_CLIENT } from "@/features/hotelMedia/actionBundles";

export default async function ClientPhotosPage() {
  const { hotelId } = await requireClientAccess();
  // Client-portal cookie scope (lib/supabase/cookieScope.ts) — getPhotosManagerData
  // is shared with the back-office and defaults to the back-office scope
  // otherwise, which would find no session at all for a client-portal-only login.
  const supabase = await createClientPortalClient();
  const [data, hotelMediaData] = await Promise.all([getPhotosManagerData(hotelId, supabase), getHotelMediaData(hotelId, supabase)]);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Photos"
        subtitle="Choisissez les photos affichées par votre chatbot pour chaque hébergement — hébergement : nom, puis chaque photo détectée, individuellement sélectionnable."
      />
      <PhotoManagementModeToggle mode={data.photoManagement} />
      <PhotosManager hotelId={hotelId} accommodations={data.accommodations} actions={PHOTO_ACTIONS_CLIENT} />
      {/* Upload stays superadmin-only (see hotelMedia/actions.ts) — canUpload={false} here, selection-toggle only, same restriction as the Storage bucket's own RLS policy. */}
      <HotelMediaManager hotelId={hotelId} data={hotelMediaData} actions={HOTEL_MEDIA_ACTIONS_CLIENT} canUpload={false} />
    </div>
  );
}
