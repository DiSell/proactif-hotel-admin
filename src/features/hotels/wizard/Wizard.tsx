"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import {
  hotelInfoSchema,
  hotelIdentitySchema,
  hotelLanguagesSchema,
  hotelAssistantIntroSchema,
} from "@/features/hotels/schema";
import { createHotel } from "@/features/hotels/actions";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Stepper } from "./Stepper";
import { StepInfo } from "./StepInfo";
import { StepIdentity } from "./StepIdentity";
import { StepLanguages } from "./StepLanguages";
import { StepAssistant } from "./StepAssistant";
import { initialWizardState, type FieldErrors, type WizardState } from "./types";

const STEP_SCHEMAS = [hotelInfoSchema, hotelIdentitySchema, hotelLanguagesSchema, hotelAssistantIntroSchema] as const;

function pickErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    errors[String(issue.path[0])] = issue.message;
  }
  return errors;
}

export function Wizard() {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(initialWizardState);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function patch(update: Partial<WizardState>) {
    setState((current) => ({ ...current, ...update }));
  }

  function validateStep(stepNumber: number): boolean {
    const schema = STEP_SCHEMAS[stepNumber - 1];
    const result = schema.safeParse(state);
    if (!result.success) {
      setErrors(pickErrors(result.error));
      return false;
    }
    setErrors({});
    return true;
  }

  function handleNext() {
    setFormError(null);
    if (validateStep(step)) {
      setStep((current) => Math.min(4, current + 1));
    }
  }

  function handleBack() {
    setFormError(null);
    setErrors({});
    setStep((current) => Math.max(1, current - 1));
  }

  function handleSubmit() {
    setFormError(null);
    if (!validateStep(4)) return;

    startTransition(async () => {
      const result = await createHotel({
        name: state.name,
        website: state.website,
        logo_url: state.logoUrl,
        address: state.address,
        postal_code: state.postal_code,
        city: state.city,
        country: state.country,
        phone: state.phone,
        email: state.email,
        primary_color: state.primary_color,
        secondary_color: state.secondary_color,
        languages: state.languages,
        default_language: state.default_language,
        booking_url: state.booking_url,
        spa_booking_url: state.spa_booking_url,
        assistant_enabled: state.assistant_enabled,
        assistant_name: state.assistant_name,
        welcome_message: state.welcome_message,
      });

      if (!result.ok || !result.data) {
        setFormError(result.error ?? "Une erreur est survenue.");
        if (result.fieldErrors) setErrors(result.fieldErrors);
        return;
      }

      toast.show("Établissement créé.");
      router.push(`/etablissements/${result.data.id}`);
    });
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 md:p-8">
      <Button href="/etablissements" variant="ghost" className="w-fit px-0">
        ← Établissements
      </Button>

      <h1 className="text-2xl font-semibold text-ink">Nouvel établissement</h1>

      <Stepper current={step} />

      <Card className="flex flex-col gap-6 p-8">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">
            Étape {step} — {["Informations générales", "Identité visuelle", "Langues & réservation", "Assistant"][step - 1]}
          </span>
          {step === 1 && <span className="text-2xs text-body/70">* champs obligatoires</span>}
        </div>

        {step === 1 && <StepInfo state={state} errors={errors} onChange={patch} />}
        {step === 2 && <StepIdentity state={state} errors={errors} onChange={patch} />}
        {step === 3 && <StepLanguages state={state} errors={errors} onChange={patch} />}
        {step === 4 && <StepAssistant state={state} errors={errors} onChange={patch} />}

        {formError && (
          <p role="alert" className="text-xs text-danger">
            {formError}
          </p>
        )}
      </Card>

      <div className="flex items-center justify-end gap-2 pb-4">
        {step > 1 && (
          <Button variant="ghost" onClick={handleBack} disabled={isPending}>
            ← Retour
          </Button>
        )}
        {step < 4 ? (
          <Button variant="primary" onClick={handleNext}>
            Continuer →
          </Button>
        ) : (
          <Button variant="primary" onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Création…" : "Créer l’établissement"}
          </Button>
        )}
      </div>
    </div>
  );
}
