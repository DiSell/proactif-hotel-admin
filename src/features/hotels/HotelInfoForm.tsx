"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { ColorField } from "@/components/ui/ColorField";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { updateHotelInfo, type UpdateHotelInfoInput } from "@/features/hotels/actions";
import type { Hotel } from "@/types/database";

export function HotelInfoForm({ hotel }: { hotel: Hotel }) {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<UpdateHotelInfoInput>({
    name: hotel.name,
    website: hotel.website ?? "",
    address: hotel.address ?? "",
    postal_code: hotel.postal_code ?? "",
    city: hotel.city ?? "",
    country: hotel.country ?? "",
    phone: hotel.phone ?? "",
    email: hotel.email ?? "",
    primary_color: hotel.primary_color ?? "#1A1D1A",
    secondary_color: hotel.secondary_color ?? "#8A6A3E",
    booking_url: hotel.booking_url ?? "",
    spa_booking_url: hotel.spa_booking_url ?? "",
    booking_action_mode: hotel.booking_action_mode,
    host_booking_selector:
      hotel.booking_action_mode === "host_widget" && typeof hotel.host_booking_trigger === "object" && hotel.host_booking_trigger !== null
        ? String((hotel.host_booking_trigger as { selector?: unknown }).selector ?? "")
        : "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  function patch(update: Partial<UpdateHotelInfoInput>) {
    setState((current) => ({ ...current, ...update }));
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await updateHotelInfo(hotel.id, state);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setErrors({});
      toast.show("Modifications enregistrées.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <FormField label="Nom" htmlFor="name" required error={errors.name}>
        <input
          id="name"
          value={state.name}
          onChange={(event) => patch({ name: event.target.value })}
          className={inputClassName(Boolean(errors.name))}
        />
      </FormField>
      <FormField label="Site Internet" htmlFor="website" required error={errors.website}>
        <input
          id="website"
          value={state.website}
          onChange={(event) => patch({ website: event.target.value })}
          className={inputClassName(Boolean(errors.website))}
        />
      </FormField>
      <FormField label="Adresse" htmlFor="address">
        <input
          id="address"
          value={state.address}
          onChange={(event) => patch({ address: event.target.value })}
          className={inputClassName()}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Code postal" htmlFor="postal_code">
          <input
            id="postal_code"
            value={state.postal_code}
            onChange={(event) => patch({ postal_code: event.target.value })}
            className={inputClassName()}
          />
        </FormField>
        <FormField label="Ville" htmlFor="city">
          <input
            id="city"
            value={state.city}
            onChange={(event) => patch({ city: event.target.value })}
            className={inputClassName()}
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Téléphone" htmlFor="phone">
          <input
            id="phone"
            value={state.phone}
            onChange={(event) => patch({ phone: event.target.value })}
            className={inputClassName()}
          />
        </FormField>
        <FormField label="Email" htmlFor="email" error={errors.email}>
          <input
            id="email"
            value={state.email}
            onChange={(event) => patch({ email: event.target.value })}
            className={inputClassName(Boolean(errors.email))}
          />
        </FormField>
      </div>
      <FormField label="Mode de réservation" htmlFor="booking_action_mode">
        <select
          id="booking_action_mode"
          value={state.booking_action_mode}
          onChange={(event) => patch({ booking_action_mode: event.target.value as UpdateHotelInfoInput["booking_action_mode"] })}
          className={inputClassName()}
        >
          <option value="url">Lien externe</option>
          <option value="host_widget">Module de réservation du site</option>
        </select>
      </FormField>

      {state.booking_action_mode === "url" ? (
        <div className="grid grid-cols-2 gap-4">
          <FormField label="URL de réservation" htmlFor="booking_url" error={errors.booking_url}>
            <input
              id="booking_url"
              value={state.booking_url}
              onChange={(event) => patch({ booking_url: event.target.value })}
              placeholder="https://"
              className={inputClassName(Boolean(errors.booking_url))}
            />
          </FormField>
          <FormField label="URL de réservation spa" htmlFor="spa_booking_url" error={errors.spa_booking_url}>
            <input
              id="spa_booking_url"
              value={state.spa_booking_url}
              onChange={(event) => patch({ spa_booking_url: event.target.value })}
              placeholder="https://"
              className={inputClassName(Boolean(errors.spa_booking_url))}
            />
          </FormField>
        </div>
      ) : (
        <FormField
          label="Sélecteur du bouton de réservation"
          htmlFor="host_booking_selector"
          error={errors.host_booking_selector}
          hint="L'identifiant CSS (ex. #resa-toggle-menu) du bouton « Réserver » déjà présent sur le site de l'établissement. Le widget clique dessus pour ouvrir le module existant — aucune réservation n'est créée par Proactif. Ce sélecteur ne peut pas être testé automatiquement depuis ce tableau de bord (le site de l'établissement est sur un autre domaine) : vérifiez-le manuellement sur le site."
        >
          <input
            id="host_booking_selector"
            value={state.host_booking_selector}
            onChange={(event) => patch({ host_booking_selector: event.target.value })}
            placeholder="#resa-toggle-menu"
            className={inputClassName(Boolean(errors.host_booking_selector))}
          />
        </FormField>
      )}
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Couleur principale" htmlFor="primary_color" error={errors.primary_color}>
          <ColorField
            id="primary_color"
            name="primary_color"
            value={state.primary_color}
            onChange={(value) => patch({ primary_color: value })}
            error={errors.primary_color}
          />
        </FormField>
        <FormField label="Couleur secondaire" htmlFor="secondary_color" error={errors.secondary_color}>
          <ColorField
            id="secondary_color"
            name="secondary_color"
            value={state.secondary_color}
            onChange={(value) => patch({ secondary_color: value })}
            error={errors.secondary_color}
          />
        </FormField>
      </div>
      <Button variant="primary" onClick={handleSubmit} disabled={isPending} className="w-fit">
        {isPending ? "Enregistrement…" : "Enregistrer"}
      </Button>
    </div>
  );
}
