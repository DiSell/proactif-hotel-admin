import { listHotels } from "@/features/hotels/queries";
import { HotelsExplorer } from "@/features/hotels/HotelsExplorer";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";

export default async function EtablissementsPage() {
  const hotels = await listHotels();
  const activeCount = hotels.filter((hotel) => hotel.status === "active").length;

  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Établissements"
        subtitle={`${hotels.length} établissement${hotels.length > 1 ? "s" : ""} · ${activeCount} assistant${
          activeCount > 1 ? "s" : ""
        } actif${activeCount > 1 ? "s" : ""}`}
        actions={
          <Button variant="primary" href="/etablissements/nouveau">
            + Ajouter un établissement
          </Button>
        }
      />
      <HotelsExplorer hotels={hotels} />
    </div>
  );
}
