"use client";

import { FormField } from "@/components/ui/FormField";
import { ColorField } from "@/components/ui/ColorField";
import type { FieldErrors, WizardState } from "./types";

interface StepIdentityProps {
  state: WizardState;
  errors: FieldErrors;
  onChange: (patch: Partial<WizardState>) => void;
}

export function StepIdentity({ state, errors, onChange }: StepIdentityProps) {
  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="flex flex-1 flex-col gap-4">
        <FormField label="Couleur principale" htmlFor="primary_color" error={errors.primary_color}>
          <ColorField
            id="primary_color"
            name="primary_color"
            value={state.primary_color}
            onChange={(value) => onChange({ primary_color: value })}
            error={errors.primary_color}
          />
        </FormField>
        <FormField label="Couleur secondaire" htmlFor="secondary_color" error={errors.secondary_color}>
          <ColorField
            id="secondary_color"
            name="secondary_color"
            value={state.secondary_color}
            onChange={(value) => onChange({ secondary_color: value })}
            error={errors.secondary_color}
          />
        </FormField>
        <p className="text-2xs text-body/70">
          Ces couleurs n’affectent jamais l’interface Proactif System — elles ne sont utilisées que dans l’aperçu et le
          widget de cet établissement.
        </p>
      </div>

      <div className="flex-1">
        <p className="mb-2 text-xs font-medium text-ink">Aperçu du widget</p>
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="flex items-center gap-2 bg-canvas px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-border" />
            <span className="h-2 w-2 rounded-full bg-border" />
            <span className="h-2 w-2 rounded-full bg-border" />
          </div>
          <div className="relative h-56 bg-[#FBFAF7]">
            <div className="absolute bottom-3 right-3 w-56 overflow-hidden rounded-xl shadow-lg">
              <div className="flex items-center gap-2 px-3 py-2.5" style={{ backgroundColor: state.primary_color }}>
                <div
                  className="flex h-6 w-6 items-center justify-center rounded-full text-2xs font-semibold"
                  style={{ backgroundColor: state.secondary_color, color: state.primary_color }}
                >
                  {(state.assistant_name || "A").slice(0, 1).toUpperCase()}
                </div>
                <span className="text-2xs font-medium" style={{ color: state.secondary_color }}>
                  {state.assistant_name || "Assistant"}
                </span>
              </div>
              <div className="bg-surface p-3">
                <div className="rounded-lg bg-canvas px-3 py-2 text-2xs">
                  {state.welcome_message || "Bonjour, comment puis-je vous aider ?"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
