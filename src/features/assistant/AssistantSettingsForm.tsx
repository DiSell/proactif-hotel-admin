"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormField, inputClassName, textareaClassName } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { saveAssistantSettings, type SaveAssistantSettingsInput } from "./actions";
import type { Hotel, ChatbotSettings } from "@/types/database";

interface AssistantSettingsFormProps {
  hotel: Hotel;
  settings: ChatbotSettings | null;
}

export function AssistantSettingsForm({ hotel, settings }: AssistantSettingsFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<SaveAssistantSettingsInput>({
    assistant_name: hotel.assistant_name ?? "",
    welcome_message: settings?.welcome_message ?? "",
    fallback_message: settings?.fallback_message ?? "Je ne suis pas certain de pouvoir répondre précisément — je transmets votre question à l’équipe.",
    handoff_email: settings?.handoff_email ?? hotel.email ?? "",
    handoff_phone: settings?.handoff_phone ?? hotel.phone ?? "",
    tone: settings?.tone ?? "warm",
    formality: settings?.formality ?? "vous",
    response_length: settings?.response_length ?? "normal",
    commercial_proactivity: settings?.commercial_proactivity ?? "discreet",
    custom_instructions: settings?.custom_instructions ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(Boolean(settings?.custom_instructions));
  const [isPending, startTransition] = useTransition();

  function patch(update: Partial<SaveAssistantSettingsInput>) {
    setState((current) => ({ ...current, ...update }));
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await saveAssistantSettings(hotel.id, state);
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
    <div className="flex flex-col gap-6">
      <FormField label="Nom de l’assistant" htmlFor="assistant_name" required error={errors.assistant_name}>
        <input
          id="assistant_name"
          value={state.assistant_name}
          onChange={(event) => patch({ assistant_name: event.target.value })}
          className={inputClassName(Boolean(errors.assistant_name))}
        />
      </FormField>

      <FormField label="Message d’accueil" htmlFor="welcome_message" required error={errors.welcome_message}>
        <input
          id="welcome_message"
          value={state.welcome_message}
          onChange={(event) => patch({ welcome_message: event.target.value })}
          className={inputClassName(Boolean(errors.welcome_message))}
        />
      </FormField>

      <div className="flex flex-col gap-4 border-t border-border pt-6">
        <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Comportement — réglages guidés</span>

        <div className="grid grid-cols-2 gap-4">
          <FormField label="Ton" htmlFor="tone">
            <select id="tone" value={state.tone} onChange={(event) => patch({ tone: event.target.value })} className={inputClassName()}>
              <option value="professional">Professionnel</option>
              <option value="warm">Chaleureux</option>
              <option value="elegant">Élégant</option>
              <option value="direct">Direct</option>
            </select>
          </FormField>
          <FormField label="Formule d’adresse" htmlFor="formality">
            <select
              id="formality"
              value={state.formality}
              onChange={(event) => patch({ formality: event.target.value })}
              className={inputClassName()}
            >
              <option value="vous">Vouvoiement</option>
              <option value="tu">Tutoiement</option>
            </select>
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField label="Longueur des réponses" htmlFor="response_length">
            <select
              id="response_length"
              value={state.response_length}
              onChange={(event) => patch({ response_length: event.target.value })}
              className={inputClassName()}
            >
              <option value="short">Courte</option>
              <option value="normal">Standard</option>
              <option value="detailed">Détaillée</option>
            </select>
          </FormField>
          <FormField label="Comportement commercial" htmlFor="commercial_proactivity">
            <select
              id="commercial_proactivity"
              value={state.commercial_proactivity}
              onChange={(event) => patch({ commercial_proactivity: event.target.value })}
              className={inputClassName()}
            >
              <option value="disabled">Désactivé</option>
              <option value="discreet">Suggestions discrètes</option>
              <option value="proactive">Proactif</option>
            </select>
          </FormField>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-border pt-6">
        <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Information inconnue</span>
        <FormField label="Message de repli" htmlFor="fallback_message" required error={errors.fallback_message}>
          <textarea
            id="fallback_message"
            rows={2}
            value={state.fallback_message}
            onChange={(event) => patch({ fallback_message: event.target.value })}
            className={textareaClassName(Boolean(errors.fallback_message))}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Email de contact (passage humain)" htmlFor="handoff_email" error={errors.handoff_email}>
            <input
              id="handoff_email"
              value={state.handoff_email}
              onChange={(event) => patch({ handoff_email: event.target.value })}
              className={inputClassName(Boolean(errors.handoff_email))}
            />
          </FormField>
          <FormField label="Téléphone de contact" htmlFor="handoff_phone">
            <input
              id="handoff_phone"
              value={state.handoff_phone}
              onChange={(event) => patch({ handoff_phone: event.target.value })}
              className={inputClassName()}
            />
          </FormField>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-ink">Instructions avancées</p>
            <p className="text-2xs text-body/70">Optionnel — la plupart des établissements n’en ont pas besoin.</p>
          </div>
          <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="text-2xs font-medium text-body hover:text-ink">
            {showAdvanced ? "Réduire" : "Afficher"}
          </button>
        </div>
        {showAdvanced && (
          <textarea
            rows={3}
            value={state.custom_instructions}
            onChange={(event) => patch({ custom_instructions: event.target.value })}
            placeholder="Consignes libres pour un besoin très spécifique non couvert par les réglages ci-dessus."
            className={textareaClassName()}
          />
        )}
      </div>

      <Button variant="primary" onClick={handleSubmit} disabled={isPending} className="w-fit">
        {isPending ? "Enregistrement…" : "Enregistrer"}
      </Button>
    </div>
  );
}
