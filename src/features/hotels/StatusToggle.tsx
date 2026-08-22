"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { setHotelStatus } from "@/features/hotels/actions";
import type { HotelStatus } from "@/types/database";

export function StatusToggle({ hotelId, status }: { hotelId: string; status: HotelStatus }) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  function handleChange(checked: boolean) {
    startTransition(async () => {
      const result = await setHotelStatus(hotelId, checked ? "active" : "inactive");
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      router.refresh();
    });
  }

  return <Toggle checked={status === "active"} onChange={handleChange} label="Assistant actif" disabled={isPending} />;
}
