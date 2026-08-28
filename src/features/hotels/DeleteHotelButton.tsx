"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { deleteHotel } from "./actions";

export function DeleteHotelButton({ hotelId, hotelName }: { hotelId: string; hotelName: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteHotel(hotelId);
      if (!result.ok) {
        setOpen(false);
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      router.push("/etablissements");
    });
  }

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)} className="w-fit">
        Supprimer l&rsquo;établissement
      </Button>
      <ConfirmDialog
        open={open}
        title={`Supprimer ${hotelName} ?`}
        description="Cette action supprime définitivement l'établissement : ses paramètres, ses connaissances, ses conversations, son widget et l'accès de son client. Cette action est irréversible."
        confirmLabel="Supprimer"
        onConfirm={handleDelete}
        onCancel={() => setOpen(false)}
        pending={isPending}
      />
    </>
  );
}
