"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { inviteHotelClient, revokeHotelClientAccess, deleteHotelClient } from "./actions";
import type { HotelUserWithProfile } from "./queries";

interface InviteClientFormProps {
  hotelId: string;
  existingUsers: HotelUserWithProfile[];
}

function clientLabel(user: HotelUserWithProfile): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
}

export function InviteClientForm({ hotelId, existingUsers }: InviteClientFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  const [revokeTarget, setRevokeTarget] = useState<HotelUserWithProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HotelUserWithProfile | null>(null);
  const [isMutating, startMutation] = useTransition();

  function handleRevoke() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    startMutation(async () => {
      const result = await revokeHotelClientAccess(target.id, hotelId);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setRevokeTarget(null);
      toast.show("Accès révoqué.");
      router.refresh();
    });
  }

  function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    startMutation(async () => {
      const result = await deleteHotelClient(target.userId, hotelId);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setDeleteTarget(null);
      toast.show("Client supprimé.");
      router.refresh();
    });
  }

  function handleSubmit() {
    startTransition(async () => {
      // Every path below must end in a toast — no exception, however it
      // arises (a rejected Promise from a network failure, a Server Action
      // that throws instead of returning an ActionResult, ...), is allowed
      // to leave the button silently returning to its normal state with no
      // feedback at all. "Invitation envoyée" is only ever shown from the
      // result.ok === true branch below — a caught exception always shows
      // an error, never a false success.
      try {
        const result = await inviteHotelClient(hotelId, { firstName, lastName, email });
        if (!result.ok || !result.data) {
          setErrors(result.fieldErrors ?? {});
          toast.show(result.error ?? "Erreur", "danger");
          return;
        }

        setErrors({});
        setFirstName("");
        setLastName("");
        setEmail("");

        if (result.data.outcome === "already_linked") {
          toast.show("Ce client possède déjà un accès à cet hôtel.");
        } else if (result.data.outcome === "linked_existing_user") {
          toast.show("Compte existant rattaché à cet hôtel.");
        } else {
          toast.show("Invitation envoyée.");
        }
        router.refresh();
      } catch (err) {
        console.error("InviteClientForm: inviteHotelClient threw", err);
        toast.show("Impossible d'envoyer l'invitation. Vérifiez la configuration email et réessayez.", "danger");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {existingUsers.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Accès existants</span>
          {existingUsers.map((user) => (
            <div key={user.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-xs font-medium text-ink">{clientLabel(user)}</p>
                  {/* Persistent, survives a page reload — never just a toast that disappears (see listHotelUsers's own doc comment). */}
                  <StatusBadge
                    label={user.status === "pending" ? "Invitation envoyée" : "Actif"}
                    tone={user.status === "pending" ? "warning" : "success"}
                  />
                </div>
                <p className="truncate text-2xs text-body">{user.email}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-2xs" onClick={() => setRevokeTarget(user)}>
                  Révoquer
                </Button>
                <Button variant="danger" size="sm" className="h-7 px-2 text-2xs" onClick={() => setDeleteTarget(user)}>
                  Supprimer
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Prénom" htmlFor="invite_first_name" error={errors.firstName}>
          <input
            id="invite_first_name"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            className={inputClassName(Boolean(errors.firstName))}
          />
        </FormField>
        <FormField label="Nom" htmlFor="invite_last_name" error={errors.lastName}>
          <input
            id="invite_last_name"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            className={inputClassName(Boolean(errors.lastName))}
          />
        </FormField>
      </div>
      <FormField label="Email" htmlFor="invite_email" error={errors.email}>
        <input
          id="invite_email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={inputClassName(Boolean(errors.email))}
        />
      </FormField>
      <Button variant="primary" onClick={handleSubmit} disabled={isPending} className="w-fit">
        {isPending ? "Envoi…" : "Inviter le client"}
      </Button>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title="Révoquer cet accès ?"
        description={`${revokeTarget ? clientLabel(revokeTarget) : ""} ne pourra plus se connecter au portail de cet hôtel. Son compte est conservé et peut être rattaché à nouveau plus tard.`}
        confirmLabel="Révoquer"
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
        pending={isMutating}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Supprimer ce client ?"
        description={`Le compte de ${deleteTarget ? clientLabel(deleteTarget) : ""} sera définitivement supprimé. Cette action est irréversible.`}
        confirmLabel="Supprimer"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        pending={isMutating}
      />
    </div>
  );
}
