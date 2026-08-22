"use client";

import { FormField, inputClassName, textareaClassName } from "@/components/ui/FormField";
import { Toggle } from "@/components/ui/Toggle";
import type { FieldErrors, WizardState } from "./types";

interface StepAssistantProps {
  state: WizardState;
  errors: FieldErrors;
  onChange: (patch: Partial<WizardState>) => void;
}

export function StepAssistant({ state, errors, onChange }: StepAssistantProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-ink">Assistant actif dès la création</p>
          <p className="text-2xs text-body/70">Vous pourrez l’activer/désactiver à tout moment depuis sa fiche.</p>
        </div>
        <Toggle
          checked={state.assistant_enabled}
          onChange={(checked) => onChange({ assistant_enabled: checked })}
          label="Assistant actif"
        />
      </div>

      <FormField label="Nom de l’assistant" htmlFor="assistant_name" required error={errors.assistant_name}>
        <input
          id="assistant_name"
          value={state.assistant_name}
          onChange={(event) => onChange({ assistant_name: event.target.value })}
          placeholder="Camille"
          className={inputClassName(Boolean(errors.assistant_name))}
        />
      </FormField>

      <FormField label="Message d’accueil" htmlFor="welcome_message" required error={errors.welcome_message}>
        <textarea
          id="welcome_message"
          rows={3}
          value={state.welcome_message}
          onChange={(event) => onChange({ welcome_message: event.target.value })}
          placeholder="Bonjour, je suis Camille, comment puis-je vous aider aujourd’hui ?"
          className={textareaClassName(Boolean(errors.welcome_message))}
        />
      </FormField>

      <p className="text-2xs text-body/70">
        Les réglages de comportement détaillés (ton, formalité, longueur des réponses…) se configurent ensuite depuis
        l’onglet Assistant de la fiche.
      </p>
    </div>
  );
}
