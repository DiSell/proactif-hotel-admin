"use client";

import { FormField, inputClassName } from "@/components/ui/FormField";
import { LANGUAGE_OPTIONS } from "@/features/hotels/schema";
import type { FieldErrors, WizardState } from "./types";

const LANGUAGE_LABELS: Record<(typeof LANGUAGE_OPTIONS)[number], string> = {
  fr: "Français",
  en: "Anglais",
  es: "Espagnol",
  nl: "Néerlandais",
  de: "Allemand",
  it: "Italien",
};

interface StepLanguagesProps {
  state: WizardState;
  errors: FieldErrors;
  onChange: (patch: Partial<WizardState>) => void;
}

export function StepLanguages({ state, errors, onChange }: StepLanguagesProps) {
  function toggleLanguage(lang: string) {
    const languages = state.languages.includes(lang)
      ? state.languages.filter((l) => l !== lang)
      : [...state.languages, lang];
    onChange({ languages });
  }

  return (
    <div className="flex flex-col gap-6">
      <FormField label="Langues traitées par l’assistant" htmlFor="languages" required error={errors.languages}>
        <div id="languages" className="flex flex-wrap gap-4">
          {LANGUAGE_OPTIONS.map((lang) => (
            <label key={lang} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={state.languages.includes(lang)}
                onChange={() => toggleLanguage(lang)}
                className="h-4 w-4 accent-ink"
              />
              {LANGUAGE_LABELS[lang]}
            </label>
          ))}
        </div>
      </FormField>

      <FormField label="Langue par défaut" htmlFor="default_language" error={errors.default_language}>
        <select
          id="default_language"
          value={state.default_language}
          onChange={(event) => onChange({ default_language: event.target.value })}
          className={inputClassName(Boolean(errors.default_language))}
        >
          {state.languages.map((lang) => (
            <option key={lang} value={lang}>
              {LANGUAGE_LABELS[lang as keyof typeof LANGUAGE_LABELS] ?? lang}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="URL du moteur de réservation" htmlFor="booking_url" error={errors.booking_url}>
        <input
          id="booking_url"
          value={state.booking_url}
          onChange={(event) => onChange({ booking_url: event.target.value })}
          placeholder="https://"
          className={inputClassName(Boolean(errors.booking_url))}
        />
      </FormField>

      <FormField label="URL réservation spa (facultatif)" htmlFor="spa_booking_url" error={errors.spa_booking_url}>
        <input
          id="spa_booking_url"
          value={state.spa_booking_url}
          onChange={(event) => onChange({ spa_booking_url: event.target.value })}
          placeholder="https://"
          className={inputClassName(Boolean(errors.spa_booking_url))}
        />
      </FormField>
    </div>
  );
}
