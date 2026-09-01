"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { Toggle } from "@/components/ui/Toggle";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { upsertHotelSpaSettingsClient } from "./actions";
import { DEFAULT_SPA_SETTINGS_INPUT, HOTEL_SPA_APPROVAL_MODES, type HotelSpaSettingsInput } from "./schema";
import type { HotelSpaSettings } from "@/types/database";

interface SpaSettingsFormProps {
  hotelId: string;
  settings: HotelSpaSettings | null;
}

const APPROVAL_MODE_LABEL: Record<(typeof HOTEL_SPA_APPROVAL_MODES)[number], string> = {
  auto: "Confirmation automatique",
  manual: "Validation manuelle par l'hôtel",
};

function toInput(settings: HotelSpaSettings | null): HotelSpaSettingsInput {
  if (!settings) return DEFAULT_SPA_SETTINGS_INPUT;
  return {
    enabled: settings.enabled,
    opens_at: settings.opens_at.slice(0, 5),
    closes_at: settings.closes_at.slice(0, 5),
    slot_duration_minutes: settings.slot_duration_minutes,
    capacity_per_slot: settings.capacity_per_slot,
    price_per_person: settings.price_per_person,
    allow_non_residents: settings.allow_non_residents,
    advance_booking_days: settings.advance_booking_days,
    min_notice_hours: settings.min_notice_hours,
    approval_mode: settings.approval_mode,
    whatsapp_admin_phone_e164: settings.whatsapp_admin_phone_e164,
  };
}

/**
 * /client/chatbot's own "Réservation spa" settings panel — same
 * always-visible-form shape as ChatbotPersonalizationForm.tsx, not a modal
 * (a single per-hotel settings row, unlike EventFormModal's multi-row CRUD).
 * slot_duration_minutes is entered here in MINUTES and stored as-is — never
 * assumed to be any particular value (e.g. 120) anywhere downstream; the
 * hotel is free to configure any duration that evenly divides its opening
 * window (enforced by hotelSpaSettingsSchema).
 */
export function SpaSettingsForm({ hotelId, settings }: SpaSettingsFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<HotelSpaSettingsInput>(() => toInput(settings));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  function update<K extends keyof HotelSpaSettingsInput>(key: K, value: HotelSpaSettingsInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await upsertHotelSpaSettingsClient(hotelId, form);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setErrors({});
      toast.show("Configuration enregistrée.");
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Toggle checked={form.enabled} onChange={(value) => update("enabled", value)} label="Activer la réservation spa" />
        <span className="text-xs text-ink">{form.enabled ? "Activée" : "Désactivée"}</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Ouverture" htmlFor="spa_opens_at" required error={errors.opens_at}>
          <input
            id="spa_opens_at"
            type="time"
            value={form.opens_at}
            onChange={(event) => update("opens_at", event.target.value)}
            className={inputClassName(Boolean(errors.opens_at))}
          />
        </FormField>
        <FormField label="Fermeture" htmlFor="spa_closes_at" required error={errors.closes_at}>
          <input
            id="spa_closes_at"
            type="time"
            value={form.closes_at}
            onChange={(event) => update("closes_at", event.target.value)}
            className={inputClassName(Boolean(errors.closes_at))}
          />
        </FormField>
      </div>

      <FormField
        label="Durée d'un créneau (minutes)"
        htmlFor="spa_slot_duration"
        required
        error={errors.slot_duration_minutes}
        hint="Doit diviser exactement la plage horaire d'ouverture (ex. 120 minutes pour des créneaux de 10h à 20h)."
      >
        <input
          id="spa_slot_duration"
          type="number"
          min={15}
          step={15}
          value={form.slot_duration_minutes}
          onChange={(event) => update("slot_duration_minutes", Number(event.target.value))}
          className={inputClassName(Boolean(errors.slot_duration_minutes))}
        />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Capacité par créneau (personnes)" htmlFor="spa_capacity" required error={errors.capacity_per_slot}>
          <input
            id="spa_capacity"
            type="number"
            min={1}
            value={form.capacity_per_slot}
            onChange={(event) => update("capacity_per_slot", Number(event.target.value))}
            className={inputClassName(Boolean(errors.capacity_per_slot))}
          />
        </FormField>
        <FormField label="Prix par personne (€)" htmlFor="spa_price" error={errors.price_per_person} hint="Laissez vide si non communiqué.">
          <input
            id="spa_price"
            type="number"
            min={0}
            step={0.01}
            value={form.price_per_person ?? ""}
            onChange={(event) => update("price_per_person", event.target.value === "" ? null : Number(event.target.value))}
            className={inputClassName(Boolean(errors.price_per_person))}
          />
        </FormField>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Réservation possible jusqu'à (jours à l'avance)" htmlFor="spa_advance_days" required error={errors.advance_booking_days}>
          <input
            id="spa_advance_days"
            type="number"
            min={0}
            value={form.advance_booking_days}
            onChange={(event) => update("advance_booking_days", Number(event.target.value))}
            className={inputClassName(Boolean(errors.advance_booking_days))}
          />
        </FormField>
        <FormField label="Préavis minimum (heures)" htmlFor="spa_min_notice" required error={errors.min_notice_hours}>
          <input
            id="spa_min_notice"
            type="number"
            min={0}
            value={form.min_notice_hours}
            onChange={(event) => update("min_notice_hours", Number(event.target.value))}
            className={inputClassName(Boolean(errors.min_notice_hours))}
          />
        </FormField>
      </div>

      <div className="flex items-center gap-2">
        <Toggle checked={form.allow_non_residents} onChange={(value) => update("allow_non_residents", value)} label="Autoriser les clients extérieurs" />
        <span className="text-xs text-ink">Clients extérieurs {form.allow_non_residents ? "autorisés" : "non autorisés"}</span>
      </div>

      <FormField
        label="Validation des réservations"
        htmlFor="spa_approval_mode"
        required
        error={errors.approval_mode}
        hint="En validation manuelle, chaque réservation reste « en attente » jusqu'à ce que vous la confirmiez ou la refusiez — utile si vous gérez votre planning par ailleurs."
      >
        <select
          id="spa_approval_mode"
          value={form.approval_mode}
          onChange={(event) => update("approval_mode", event.target.value as HotelSpaSettingsInput["approval_mode"])}
          className={inputClassName(Boolean(errors.approval_mode))}
        >
          {HOTEL_SPA_APPROVAL_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {APPROVAL_MODE_LABEL[mode]}
            </option>
          ))}
        </select>
      </FormField>

      {form.approval_mode === "manual" && (
        <FormField
          label="Numéro WhatsApp pour la validation"
          htmlFor="spa_whatsapp_admin_phone"
          error={errors.whatsapp_admin_phone_e164}
          hint="Format international, ex. +33612345678. Vous recevrez chaque demande avec des boutons Confirmer/Refuser. Facultatif : sans ce numéro (ou si WhatsApp n'est pas encore actif), vous pourrez toujours valider depuis la liste des réservations ci-dessous et par email."
        >
          <input
            id="spa_whatsapp_admin_phone"
            type="tel"
            value={form.whatsapp_admin_phone_e164 ?? ""}
            onChange={(event) => update("whatsapp_admin_phone_e164", event.target.value === "" ? null : event.target.value)}
            placeholder="+33612345678"
            className={inputClassName(Boolean(errors.whatsapp_admin_phone_e164))}
          />
        </FormField>
      )}

      <div>
        <Button variant="primary" onClick={handleSubmit} disabled={isPending}>
          {isPending ? "Enregistrement…" : "Enregistrer"}
        </Button>
      </div>
    </Card>
  );
}
