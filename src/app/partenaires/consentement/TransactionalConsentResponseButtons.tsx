"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { acceptPartnerTransactionalConsent, declinePartnerTransactionalConsent } from "@/features/partners/consentActions";

interface TransactionalConsentResponseButtonsProps {
  token: string;
}

/**
 * DISTINCT from ConsentResponseButtons (the chatbot-recommendation flow) —
 * no opening_hours/address fields here, this consent has nothing to do with
 * the partner's public listing. Deliberately minimal: Accept/Decline only.
 */
export function TransactionalConsentResponseButtons({ token }: TransactionalConsentResponseButtonsProps) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);

  function respond(accept: boolean) {
    startTransition(async () => {
      const outcome = accept ? await acceptPartnerTransactionalConsent(token) : await declinePartnerTransactionalConsent(token);
      setResult({ ok: outcome.ok, error: outcome.ok ? undefined : outcome.error });
    });
  }

  if (result?.ok) {
    return <p className="text-xs text-body">Merci, votre réponse a bien été enregistrée.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {result?.error && (
        <p role="alert" className="text-2xs text-danger">
          {result.error}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" onClick={() => respond(true)} disabled={isPending}>
          Accepter
        </Button>
        <Button variant="secondary" className="flex-1" onClick={() => respond(false)} disabled={isPending}>
          Refuser
        </Button>
      </div>
    </div>
  );
}
