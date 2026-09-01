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

  it("[cancel action only shown for confirmed bookings]", () => {
    expect(source).toMatch(/booking\.status === "confirmed" && \(/);
  });

  it("[calls cancelSpaBookingClient for the confirmed target only, then refreshes]", () => {
    const fn = source.slice(source.indexOf("function handleCancel"), source.indexOf("function handleCancel") + 500);
    expect(fn).toMatch(/cancelSpaBookingClient\(hotelId, target\.id\)/);
    expect(fn).toMatch(/router\.refresh\(\)/);
  });

  it("[phone number is masked, never shown in full] reuses the existing maskPhoneForDisplay helper", () => {
    expect(source).toMatch(/import \{ maskPhoneForDisplay \} from "@\/features\/partnerRequests\/phoneRedaction";/);
    expect(source).toMatch(/maskPhoneForDisplay\(booking\.guest_phone_e164\)/);
  });
});
