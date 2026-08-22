"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button";

export default function EtablissementsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("etablissements page error", error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-[1440px] flex-col items-center gap-4 p-6 py-24 text-center md:p-8">
      <p className="text-sm font-medium text-ink">Impossible de charger les établissements.</p>
      <p className="text-xs text-body">Réessayez dans un instant. Si le problème persiste, contactez le support.</p>
      <Button variant="secondary" onClick={reset}>
        Réessayer
      </Button>
    </div>
  );
}
