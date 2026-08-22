"use client";

import { createClient } from "@/lib/supabase/client";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { FileDrop } from "@/components/ui/FileDrop";
import type { FieldErrors, WizardState } from "./types";

interface StepInfoProps {
  state: WizardState;
  errors: FieldErrors;
  onChange: (patch: Partial<WizardState>) => void;
}

export function StepInfo({ state, errors, onChange }: StepInfoProps) {
  async function handleLogoSelected(file: File) {
    const previewUrl = URL.createObjectURL(file);
    onChange({ logoFile: file, logoPreviewUrl: previewUrl, logoUrl: null });

    const supabase = createClient();
    const path = `${crypto.randomUUID()}-${file.name}`;
    const { error } = await supabase.storage.from("hotel-logos").upload(path, file, { upsert: false });

    if (error) {
      console.error("logo upload failed", error.message);
      return;
    }

    const { data } = supabase.storage.from("hotel-logos").getPublicUrl(path);
    onChange({ logoUrl: data.publicUrl });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Nom de l’établissement" htmlFor="name" required error={errors.name}>
          <input
            id="name"
            value={state.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="Le 1837"
            className={inputClassName(Boolean(errors.name))}
          />
        </FormField>
        <FormField label="Site Internet" htmlFor="website" required error={errors.website}>
          <input
            id="website"
            value={state.website}
            onChange={(event) => onChange({ website: event.target.value })}
            placeholder="https://"
            className={inputClassName(Boolean(errors.website))}
          />
        </FormField>
      </div>

      <FormField label="Logo" htmlFor="logo">
        <FileDrop onFileSelected={handleLogoSelected} previewUrl={state.logoPreviewUrl} hint="PNG / SVG · 512 px min." />
      </FormField>

      <FormField label="Adresse" htmlFor="address">
        <input
          id="address"
          value={state.address}
          onChange={(event) => onChange({ address: event.target.value })}
          className={inputClassName()}
        />
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <FormField label="Code postal" htmlFor="postal_code">
          <input
            id="postal_code"
            value={state.postal_code}
            onChange={(event) => onChange({ postal_code: event.target.value })}
            className={inputClassName()}
          />
        </FormField>
        <FormField label="Ville" htmlFor="city">
          <input
            id="city"
            value={state.city}
            onChange={(event) => onChange({ city: event.target.value })}
            className={inputClassName()}
          />
        </FormField>
        <FormField label="Pays" htmlFor="country">
          <input
            id="country"
            value={state.country}
            onChange={(event) => onChange({ country: event.target.value })}
            className={inputClassName()}
          />
        </FormField>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Téléphone" htmlFor="phone">
          <input
            id="phone"
            value={state.phone}
            onChange={(event) => onChange({ phone: event.target.value })}
            className={inputClassName()}
          />
        </FormField>
        <FormField label="Email" htmlFor="email" error={errors.email}>
          <input
            id="email"
            value={state.email}
            onChange={(event) => onChange({ email: event.target.value })}
            className={inputClassName(Boolean(errors.email))}
          />
        </FormField>
      </div>

      <p className="text-xs italic text-body/75">
        Astuce : une fois l’établissement créé, l’onglet Connaissances permet d’analyser son site pour préremplir ses
        informations.
      </p>
    </div>
  );
}
