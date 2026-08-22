import { notFound } from "next/navigation";
import { getHotel } from "@/features/hotels/queries";
import { listKnowledgeSources } from "@/features/knowledge/queries";
import { AddSourceMenu } from "@/features/knowledge/AddSourceMenu";
import { SourcesTable } from "@/features/knowledge/SourcesTable";

export default async function ConnaissancesPage({ params }: PageProps<"/etablissements/[id]/connaissances">) {
  const { id } = await params;
  const [hotel, sources] = await Promise.all([getHotel(id), listKnowledgeSources(id)]);
  if (!hotel) notFound();

  return (
    <div className="flex flex-col gap-6 pb-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Connaissances</h2>
          <p className="mt-1 text-xs text-body">
            {sources.length} source{sources.length > 1 ? "s" : ""}
          </p>
        </div>
        <AddSourceMenu hotelId={hotel.id} websiteUrl={hotel.website ?? ""} />
      </div>

      <SourcesTable hotelId={hotel.id} sources={sources} />
    </div>
  );
}
