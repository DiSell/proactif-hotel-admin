"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormField, inputClassName, textareaClassName } from "@/components/ui/FormField";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { createHotelEventClient, updateHotelEventClient } from "./actions";
import { HOTEL_EVENT_TYPES, HOTEL_EVENT_TYPE_LABEL } from "./schema";
import type { HotelEvent, HotelEventType } from "@/types/database";

interface EventFormModalProps {
  hotelId: string;
  /** null = creating a new event; a row = editing it in place. */
  event: HotelEvent | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Shared by "+ Ajouter un événement" and "Modifier" — same fields either way, only the submit action and initial values differ. */
export function EventFormModal({ hotelId, event, onClose, onSaved }: EventFormModalProps) {
  const toast = useToast();
  const [type, setType] = useState<HotelEventType>(event?.type ?? "temporary");
  const [title, setTitle] = useState(event?.title ?? "");
  const [content, setContent] = useState(event?.content ?? "");
  const [startsAt, setStartsAt] = useState(event?.starts_at ?? "");
  const [endsAt, setEndsAt] = useState(event?.ends_at ?? "");
  const [isActive, setIsActive] = useState(event?.is_active ?? true);
  const [showAsBanner, setShowAsBanner] = useState(event?.show_as_banner ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  const isTemporary = type === "temporary";

  function handleTypeChange(nextType: HotelEventType) {
    setType(nextType);
    // A permanent information never carries dates or a banner — cleared
    // immediately on switch so a leftover value from a prior "temporary"
    // edit can never be silently submitted with the wrong type.
    if (nextType === "permanent") {
      setStartsAt("");
      setEndsAt("");
      setShowAsBanner(false);
    }
  }

  function handleSubmit() {
    const input = {
      type,
      title,
      content,
      starts_at: isTemporary ? startsAt : "",
      ends_at: isTemporary ? endsAt : "",
      is_active: isActive,
      show_as_banner: isTemporary ? showAsBanner : false,
    };

    startTransition(async () => {
      const result = event
        ? await updateHotelEventClient(hotelId, event.id, input)
        : await createHotelEventClient(hotelId, input);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show(event ? "Événement modifié." : "Événement ajouté.");
      onSaved();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <Card className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto p-6">
        <h2 className="text-sm font-semibold text-ink">{event ? "Modifier l'événement" : "Ajouter un événement"}</h2>

        <FormField label="Type" htmlFor="event_type" required error={errors.type}>
          <select
            id="event_type"
            value={type}
            onChange={(e) => handleTypeChange(e.target.value as HotelEventType)}
            className={inputClassName(Boolean(errors.type))}
          >
            {HOTEL_EVENT_TYPES.map((value) => (
              <option key={value} value={value}>
                {HOTEL_EVENT_TYPE_LABEL[value]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="Titre"
          htmlFor="event_title"
          required
          error={errors.title}
          hint={isTemporary ? "ex : Fermeture du spa pour travaux" : "ex : Accès spa pour les personnes extérieures"}
        >
          <input id="event_title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClassName(Boolean(errors.title))} />
        </FormField>

        <FormField
          label="Description"
          htmlFor="event_content"
          required
          error={errors.content}
          hint="Ce texte est utilisé par le chatbot pour répondre à vos visiteurs — rédigez-le comme une information à leur transmettre directement."
        >
          <textarea
            id="event_content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            className={textareaClassName(Boolean(errors.content))}
          />
        </FormField>

        {isTemporary && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Date de début" htmlFor="event_starts_at" required error={errors.starts_at}>
              <input
                id="event_starts_at"
                type="date"
                value={startsAt ?? ""}
                onChange={(e) => setStartsAt(e.target.value)}
                className={inputClassName(Boolean(errors.starts_at))}
              />
            </FormField>
            <FormField label="Date de fin" htmlFor="event_ends_at" required error={errors.ends_at}>
              <input
                id="event_ends_at"
                type="date"
                value={endsAt ?? ""}
                onChange={(e) => setEndsAt(e.target.value)}
                className={inputClassName(Boolean(errors.ends_at))}
              />
            </FormField>
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Toggle checked={isActive} onChange={setIsActive} label="Événement actif" />
            <span className="text-xs text-ink">{isActive ? "Actif" : "Inactif"}</span>
          </div>
          {isTemporary && (
            <div className="flex items-center gap-2">
              <Toggle checked={showAsBanner} onChange={setShowAsBanner} label="Afficher comme information importante dans le chatbot" />
              <span className="text-xs text-ink">Bandeau chatbot</span>
            </div>
          )}
        </div>
        {isTemporary && (
          <p className="-mt-2 text-2xs text-body/60">
            Afficher comme information importante dans le chatbot : un bandeau visible dans le chatbot pendant la période ci-dessus uniquement.
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Annuler
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Enregistrement…" : event ? "Enregistrer" : "Ajouter"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
