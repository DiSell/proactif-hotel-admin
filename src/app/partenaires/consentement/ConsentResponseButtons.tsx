"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { acceptPartnerConsent, declinePartnerConsent } from "@/features/partners/consentActions";

interface ConsentResponseButtonsProps {
  token: string;
  /** Pre-fills the field when the hotel already entered/generated one — the partner confirms or corrects it rather than starting from scratch. */
  initialOpeningHours: string | null;
  /** Same pre-fill/second-chance logic as initialOpeningHours — see 0019_hotel_partner_consent_address_grant.sql's own comment. */
  initialAddress: string | null;
}

/**
 * `openingHours`/`address` are only ever sent to acceptPartnerConsent, never
 * to declinePartnerConsent — see 0018_hotel_partner_opening_hours.sql's own
 * comment: a declined partner is never recommended by the chatbot anyway, so
 * there's no reason to ask a refusing partner to fill in these fields.
 */
export function ConsentResponseButtons({ token, initialOpeningHours, initialAddress }: ConsentResponseButtonsProps) {
  const [isPending, startTransition] = useTransition();
  const [openingHours, setOpeningHours] = useState(initialOpeningHours ?? "");
  const [address, setAddress] = useState(initialAddress ?? "");
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);

  function respond(accept: boolean) {
    startTransition(async () => {
      const outcome = accept ? await acceptPartnerConsent(token, openingHours, address) : await declinePartnerConsent(token);
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
      <FormField label="Votre adresse (optionnel)" htmlFor="consent_address" hint="Affichée aux visiteurs si vous acceptez.">
        <input id="consent_address" value={address} onChange={(event) => setAddress(event.target.value)} maxLength={300} className={inputClassName()} />
      </FormField>
      <FormField
        label="Vos horaires d’ouverture (optionnel)"
        htmlFor="consent_opening_hours"
        hint="ex : Lun-Sam 12h-14h, 19h-22h — affiché aux visiteurs si vous acceptez."
      >
        <input
          id="consent_opening_hours"
          value={openingHours}
          onChange={(event) => setOpeningHours(event.target.value)}
          maxLength={300}
          className={inputClassName()}
        />
      </FormField>
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
