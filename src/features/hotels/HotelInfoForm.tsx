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
