import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "SpaBookingsList.tsx"), "utf8");

describe("SpaBookingsList — read-mostly: no create/edit action, only cancel", () => {
  it("[no EventFormModal-style create/edit UI — bookings only ever come from the chatbot]", () => {
    expect(source).not.toMatch(/setFormTarget|FormModal/);
  });

  it("[cancel is gated by ConfirmDialog, never a direct call from the row button]", () => {
    expect(source).toMatch(/onClick=\{\(\) => setCancelTarget\(booking\)\}/);
    expect(source).toMatch(/<ConfirmDialog/);
    expect(source).toMatch(/onConfirm=\{handleCancel\}/);
  });

  it("[Annuler only shown for confirmed bookings]", () => {
    expect(source).toMatch(/booking\.status === "confirmed" && \(/);
  });

  it("[calls cancelSpaBookingClient for the target only, then refreshes]", () => {
    const fn = source.slice(source.indexOf("function handleCancel"), source.indexOf("function handleApprove"));
    expect(fn).toMatch(/cancelSpaBookingClient\(hotelId, target\.id\)/);
    expect(fn).toMatch(/router\.refresh\(\)/);
  });

  it("[phone number is masked, never shown in full] reuses the existing maskPhoneForDisplay helper", () => {
    expect(source).toMatch(/import \{ maskPhoneForDisplay \} from "@\/features\/partnerRequests\/phoneRedaction";/);
    expect(source).toMatch(/maskPhoneForDisplay\(booking\.guest_phone_e164\)/);
  });
});

describe("SpaBookingsList — pending_approval actions (0035_spa_booking_approval.sql)", () => {
  it("[Confirmer/Refuser only shown for pending_approval bookings]", () => {
    expect(source).toMatch(/booking\.status === "pending_approval" && \(/);
  });

  it("[Confirmer calls approveSpaBookingClient, never a direct RPC call]", () => {
    const fn = source.slice(source.indexOf("function handleApprove"), source.indexOf("if (bookings.length === 0)"));
    expect(fn).toMatch(/approveSpaBookingClient\(hotelId, booking\.id\)/);
    expect(fn).toMatch(/router\.refresh\(\)/);
  });

  it("[Refuser reuses the SAME cancel flow as Annuler] rejecting a pending request is cancelling it — no separate reject action wired to a different function", () => {
    expect(source).toMatch(/onClick=\{\(\) => setCancelTarget\(booking\)\}/g);
    const matches = source.match(/onClick=\{\(\) => setCancelTarget\(booking\)\}/g) ?? [];
    expect(matches.length).toBe(2); // once for "Refuser" (pending_approval), once for "Annuler" (confirmed)
  });

  it("[ConfirmDialog wording adapts to the target's status] never says \"annuler\" when refusing a pending request", () => {
    expect(source).toMatch(/cancelTarget\?\.status === "pending_approval" \? "Refuser cette réservation \?" : "Annuler cette réservation \?"/);
  });

  it("[status badges cover all three states] pending_approval/confirmed/cancelled each have their own label", () => {
    expect(source).toMatch(/pending_approval: \{ label: "En attente de validation", tone: "warning" \}/);
    expect(source).toMatch(/confirmed: \{ label: "Confirmée", tone: "success" \}/);
    expect(source).toMatch(/cancelled: \{ label: "Annulée", tone: "neutral" \}/);
  });
});
