"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormField, inputClassName, textareaClassName } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { HOTEL_PARTNER_CATEGORIES, HOTEL_PARTNER_CATEGORY_LABEL } from "./schema";
import type { HotelPartner, HotelPartnerCategory, HotelPartnerConsentStatus } from "@/types/database";
import type { PartnerActions } from "./actionBundles";

/**
 * Two INDEPENDENT consent statuses — never conflated. consent_status governs
 * chatbot recommendation only; whatsapp_consent_status
 * (0022_partner_transactional_consent.sql) governs whether this partner may
 * later receive a transactional WhatsApp request. Accepting one never
 * implies the other — see canReceivePartnerRequests.ts.
 */
const CONSENT_STATUS_LABEL: Record<HotelPartnerConsentStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  not_requested: { label: "Non demandé", tone: "neutral" },
  pending: { label: "En attente", tone: "warning" },
  accepted: { label: "Accepté", tone: "success" },
  declined: { label: "Refusé", tone: "danger" },
};

interface PartnerFormModalProps {
  hotelId: string;
  /** null = creating a new partner; a row = editing it in place. */
  partner: HotelPartner | null;
  /** The scope-bound Server Action bundle — see PartnersManager's own doc comment on why this is a function-reference bundle, never a `scope` string. */
  actions: PartnerActions;
  onClose: () => void;
  onSaved: () => void;
}

/** Shared by "+ Ajouter un partenaire" and "Modifier" — same fields either way, only the submit action and initial values differ. */
export function PartnerFormModal({ hotelId, partner, actions, onClose, onSaved }: PartnerFormModalProps) {
  const toast = useToast();
  const [name, setName] = useState(partner?.name ?? "");
  const [category, setCategory] = useState<HotelPartnerCategory>(partner?.category ?? "restaurant");
  const [description, setDescription] = useState(partner?.description ?? "");
  const [address, setAddress] = useState(partner?.address ?? "");
  const [phone, setPhone] = useState(partner?.phone ?? "");
  const [requestPhoneE164, setRequestPhoneE164] = useState(partner?.request_phone_e164 ?? "");
  const [openingHours, setOpeningHours] = useState(partner?.opening_hours ?? "");
  const [email, setEmail] = useState(partner?.email ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(partner?.website_url ?? "");
  const [bookingUrl, setBookingUrl] = useState(partner?.booking_url ?? "");
  const [isActive, setIsActive] = useState(partner?.is_active ?? true);
  const [priority, setPriority] = useState(String(partner?.priority ?? 0));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();
  const [isGeneratingDescription, startGeneratingDescription] = useTransition();
  const [isSendingConsent, startSendingConsent] = useTransition();

  // One-time fetch of the partner's OWN site at authoring time, never a
  // live/repeated crawl and never fed to the chatbot's knowledge base — see
  // fetchPartnerWebsiteSummary's own doc comment. The hotel still reviews
  // and can edit the result before saving; nothing is persisted by this
  // click alone.
  function handleGenerateDescription() {
    if (!websiteUrl.trim()) {
      toast.show("Entrez d’abord un site web.", "danger");
      return;
    }
    startGeneratingDescription(async () => {
      const result = await actions.fetchPartnerWebsiteSummary(hotelId, websiteUrl.trim());
      if (!result.ok || !result.data) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setDescription(result.data.description);
      if (result.data.address) setAddress(result.data.address);
      if (result.data.openingHours) setOpeningHours(result.data.openingHours);

      const extras = [result.data.address && "l’adresse", result.data.openingHours && "les horaires"].filter(Boolean).join(" et ");
      toast.show(extras ? `Description, ${extras} générés — relisez-les avant d’enregistrer.` : "Description générée — relisez-la avant d’enregistrer.");
    });
  }

  // Sends the SINGLE consent email covering both independent authorizations
  // (recommendation + WhatsApp) — see actions.ts's own doc comment on
  // requestPartnerConsentsInternal. One button, one email, one link; the
  // server independently decides which of the two consents are actually
  // eligible for a (re)request (never re-requesting an already-"accepted"
  // one). Only meaningful once the partner already has an id (existing
  // row), since the request is stored against it; a not-yet-saved "new
  // partner" form has nothing to send a request against yet.
  function handleSendConsents() {
    if (!partner || !email.trim()) return;
    startSendingConsent(async () => {
      const result = await actions.requestPartnerConsents(hotelId, partner.id);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show("Demande d'autorisations envoyée.");
      onSaved();
    });
  }

  // Client-side affordance only — the server (requestPartnerConsentsInternal)
  // independently re-checks eligibility and is the real gate. Mirrors that
  // same rule: a consent already "accepted" is never re-requested, so the
  // button has nothing left to do once BOTH are accepted (or the one
  // available consent, when request_phone_e164 is still empty, is already
  // accepted).
  const canRequestRecommendation = partner ? partner.consent_status !== "accepted" : false;
  const canRequestWhatsapp = partner ? Boolean(requestPhoneE164.trim()) && partner.whatsapp_consent_status !== "accepted" : false;
  const hasSomethingToRequest = canRequestRecommendation || canRequestWhatsapp;

  function handleSubmit() {
    const input = {
      name,
      category,
      description,
      address,
      phone,
      request_phone_e164: requestPhoneE164,
      opening_hours: openingHours,
      email,
      website_url: websiteUrl,
      booking_url: bookingUrl,
      is_active: isActive,
      priority: Number(priority),
    };

    startTransition(async () => {
      const result = partner
        ? await actions.updateHotelPartner(hotelId, partner.id, input)
        : await actions.createHotelPartner(hotelId, input);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show(partner ? "Partenaire modifié." : "Partenaire ajouté.");
      onSaved();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <Card className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto p-6">
        <h2 className="text-sm font-semibold text-ink">{partner ? "Modifier le partenaire" : "Ajouter un partenaire"}</h2>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Nom" htmlFor="partner_name" required error={errors.name}>
            <input id="partner_name" value={name} onChange={(event) => setName(event.target.value)} className={inputClassName(Boolean(errors.name))} />
          </FormField>
          <FormField label="Catégorie" htmlFor="partner_category" required error={errors.category}>
            <select
              id="partner_category"
              value={category}
              onChange={(event) => setCategory(event.target.value as HotelPartnerCategory)}
              className={inputClassName(Boolean(errors.category))}
            >
              {HOTEL_PARTNER_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {HOTEL_PARTNER_CATEGORY_LABEL[value]}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <FormField label="Description" htmlFor="partner_description" error={errors.description}>
          <textarea
            id="partner_description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            className={textareaClassName(Boolean(errors.description))}
          />
          <p className="mt-1.5 text-2xs text-body/60">Relisez toujours avant d’enregistrer — jamais transmis tel quel au chatbot.</p>
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Adresse" htmlFor="partner_address" error={errors.address}>
            <input
              id="partner_address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className={inputClassName(Boolean(errors.address))}
            />
          </FormField>
          <FormField label="Téléphone" htmlFor="partner_phone" error={errors.phone}>
            <input id="partner_phone" value={phone} onChange={(event) => setPhone(event.target.value)} className={inputClassName(Boolean(errors.phone))} />
          </FormField>
        </div>

        <FormField
          label="Numéro WhatsApp pour recevoir les demandes"
          htmlFor="partner_request_phone_e164"
          hint="Ce numéro sera utilisé uniquement pour transmettre les demandes envoyées par vos clients."
          error={errors.request_phone_e164}
        >
          <input
            id="partner_request_phone_e164"
            value={requestPhoneE164 ?? ""}
            onChange={(event) => setRequestPhoneE164(event.target.value)}
            placeholder="+33612345678"
            className={inputClassName(Boolean(errors.request_phone_e164))}
          />
        </FormField>

        {partner && (
          <div className="rounded-lg border border-border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1.5 text-2xs font-medium text-ink">Recommandation dans le chatbot</p>
                <StatusBadge label={CONSENT_STATUS_LABEL[partner.consent_status].label} tone={CONSENT_STATUS_LABEL[partner.consent_status].tone} />
              </div>
              <div>
                <p className="mb-1.5 text-2xs font-medium text-ink">Réception des demandes clients</p>
                <StatusBadge
                  label={CONSENT_STATUS_LABEL[partner.whatsapp_consent_status].label}
                  tone={CONSENT_STATUS_LABEL[partner.whatsapp_consent_status].tone}
                />
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 h-7 w-full px-2 text-2xs"
              onClick={handleSendConsents}
              disabled={isSendingConsent || !email.trim() || !hasSomethingToRequest}
            >
              {isSendingConsent ? "Envoi…" : "Demander les autorisations au partenaire"}
            </Button>
          </div>
        )}

        <FormField label="Horaires" htmlFor="partner_opening_hours" hint="ex : Lun-Sam 12h-14h, 19h-22h" error={errors.opening_hours}>
          <input
            id="partner_opening_hours"
            value={openingHours}
            onChange={(event) => setOpeningHours(event.target.value)}
            className={inputClassName(Boolean(errors.opening_hours))}
          />
        </FormField>

        <FormField
          label="Site web"
          htmlFor="partner_website_url"
          hint="https://… — permet de générer description, adresse et horaires automatiquement."
          error={errors.website_url}
        >
          <div className="flex items-center gap-2">
            <input
              id="partner_website_url"
              value={websiteUrl}
              onChange={(event) => setWebsiteUrl(event.target.value)}
              className={inputClassName(Boolean(errors.website_url))}
            />
            <Button
              variant="secondary"
              size="sm"
              className="h-9 shrink-0 px-3 text-2xs"
              onClick={handleGenerateDescription}
              disabled={isGeneratingDescription || !websiteUrl.trim()}
            >
              {isGeneratingDescription ? "Génération…" : "Générer depuis le site web"}
            </Button>
          </div>
        </FormField>

        <FormField label="Lien réservation" htmlFor="partner_booking_url" hint="https://…" error={errors.booking_url}>
          <input
            id="partner_booking_url"
            value={bookingUrl}
            onChange={(event) => setBookingUrl(event.target.value)}
            className={inputClassName(Boolean(errors.booking_url))}
          />
        </FormField>

        <FormField
          label="Email du partenaire"
          htmlFor="partner_email"
          hint="Requis pour lui envoyer une demande d'autorisations."
          error={errors.email}
        >
          <input
            id="partner_email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClassName(Boolean(errors.email))}
          />
        </FormField>

        <div className="flex items-center justify-between gap-4">
          <FormField label="Priorité" htmlFor="partner_priority" hint="Plus élevé = recommandé en premier." error={errors.priority}>
            <input
              id="partner_priority"
              type="number"
              min={0}
              max={1000}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              className={`${inputClassName(Boolean(errors.priority))} w-28`}
            />
          </FormField>
          <div className="flex items-center gap-2 pt-5">
            <Toggle checked={isActive} onChange={setIsActive} label="Partenaire actif" />
            <span className="text-xs text-ink">{isActive ? "Actif" : "Inactif"}</span>
          </div>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Annuler
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Enregistrement…" : partner ? "Enregistrer" : "Ajouter"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
