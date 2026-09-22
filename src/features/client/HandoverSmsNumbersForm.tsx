"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { updateHandoverSmsNumbers } from "./actions";
import type { ClientHandoverSmsNumbersInput } from "./schema";

interface HandoverSmsNumbersFormProps {
  initialPrimary: string;
  initialSecondary: string;
  initialBackup: string;
}

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — client-editable subset of
 * chatbot_settings for the "Demandes de rappel par SMS" numbers. Mirrors
 * ChatbotPersonalizationForm's shape (FormField/Button/useToast/
 * useTransition), but structurally cannot touch anything beyond these 3
 * fields — see features/client/schema.ts's clientHandoverSmsNumbersSchema,
 * the only shape this form can submit, and
 * features/client/actions.ts:updateHandoverSmsNumbers, which writes
 * exactly these 3 columns, scoped to the caller's own hotel_id.
 *
 * Deliberately does NOT reuse the back-office assistant settings screen
 * (superadmin-only) — this is a separate, narrow, client-only surface, same
 * discipline as PriceCommunicationToggle/ChatbotPersonalizationForm.
 */
export function HandoverSmsNumbersForm({ initialPrimary, initialSecondary, initialBackup }: HandoverSmsNumbersFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<ClientHandoverSmsNumbersInput>({
    handover_sms_phone_primary: initialPrimary,
    handover_sms_phone_secondary: initialSecondary,
    handover_sms_phone_backup: initialBackup,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  function patch(update: Partial<ClientHandoverSmsNumbersInput>) {
    setState((current) => ({ ...current, ...update }));
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await updateHandoverSmsNumbers(state);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setErrors({});
      toast.show("Numéros enregistrés.");
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Demandes de rappel par SMS</span>
        <p className="mt-1 text-xs text-body/70">
          Ces numéros reçoivent les demandes de rappel transmises par le chatbot. Vous pouvez renseigner jusqu’à 3 numéros.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <FormField label="Numéro principal" htmlFor="handover_sms_phone_primary" error={errors.handover_sms_phone_primary}>
          <input
            id="handover_sms_phone_primary"
            value={state.handover_sms_phone_primary}
            onChange={(event) => patch({ handover_sms_phone_primary: event.target.value })}
            placeholder="+33612345678"
            className={inputClassName(Boolean(errors.handover_sms_phone_primary))}
          />
        </FormField>
        <FormField label="Numéro secondaire (facultatif)" htmlFor="handover_sms_phone_secondary" error={errors.handover_sms_phone_secondary}>
          <input
            id="handover_sms_phone_secondary"
            value={state.handover_sms_phone_secondary}
            onChange={(event) => patch({ handover_sms_phone_secondary: event.target.value })}
            placeholder="+33612345678"
            className={inputClassName(Boolean(errors.handover_sms_phone_secondary))}
          />
        </FormField>
        <FormField label="Numéro de secours (facultatif)" htmlFor="handover_sms_phone_backup" error={errors.handover_sms_phone_backup}>
          <input
            id="handover_sms_phone_backup"
            value={state.handover_sms_phone_backup}
            onChange={(event) => patch({ handover_sms_phone_backup: event.target.value })}
            placeholder="+33612345678"
            className={inputClassName(Boolean(errors.handover_sms_phone_backup))}
          />
        </FormField>
      </div>
      <Button variant="primary" onClick={handleSubmit} disabled={isPending} className="w-fit">
        {isPending ? "Enregistrement…" : "Enregistrer"}
      </Button>
    </Card>
  );
}
