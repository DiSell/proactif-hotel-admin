import { requireClientAccess } from "@/lib/auth/session";
import { createClientPortalClient } from "@/lib/supabase/server";
import { getPhotosManagerData } from "@/features/photos/queries";
import { PhotosManager } from "@/features/photos/PhotosManager";
import { PHOTO_ACTIONS_CLIENT } from "@/features/photos/actionBundles";
import { PhotoManagementModeToggle } from "@/features/client/PhotoManagementModeToggle";
import { PageHeader } from "@/components/layout/PageHeader";

export default async function ClientPhotosPage() {
  const { hotelId } = await requireClientAccess();
  // Client-portal cookie scope (lib/supabase/cookieScope.ts) — getPhotosManagerData
  // is shared with the back-office and defaults to the back-office scope
  // otherwise, which would find no session at all for a client-portal-only login.
  const data = await getPhotosManagerData(hotelId, await createClientPortalClient());

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Photos"
        subtitle="Choisissez les photos affichées par votre chatbot pour chaque hébergement — hébergement : nom, puis chaque photo détectée, individuellement sélectionnable."
      />
      <PhotoManagementModeToggle mode={data.photoManagement} />
      <PhotosManager hotelId={hotelId} accommodations={data.accommodations} actions={PHOTO_ACTIONS_CLIENT} />
    </div>
  );
}
