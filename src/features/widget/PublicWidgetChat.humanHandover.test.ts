import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PublicWidgetChat.tsx"), "utf8");

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — same DOM-less, source-level
 * discipline as every other PublicWidgetChat test file in this repo (no
 * jsdom): pins the wiring text, not runtime DOM behavior.
 */
describe("PublicWidgetChat — handoverPhonePrompt type carried through ChatApiResponse", () => {
  it("[handoverPhonePrompt field declared on ChatApiResponse]", () => {
    expect(source).toMatch(/handoverPhonePrompt: HandoverPhonePrompt \| null;/);
  });

  it("[ActivePhonePrompt union gains a third, distinct 'handover' kind — never merged into partner_request/spa_booking]", () => {
    expect(source).toMatch(/\{ kind: "handover"; prompt: HandoverPhonePrompt \}/);
  });
});

describe("PublicWidgetChat — handover prompt activation, mutually exclusive with the other two kinds", () => {
  it("[checked last, after partnerRequestPhonePrompt/spaBookingPhonePrompt] never overrides a higher-priority prompt the same turn", () => {
    const elseIfIndex = source.indexOf('} else if (data.handoverPhonePrompt) {');
    const partnerIndex = source.indexOf("if (data.partnerRequestPhonePrompt) {");
    const spaIndex = source.indexOf("} else if (data.spaBookingPhonePrompt) {");
    expect(elseIfIndex).toBeGreaterThan(-1);
    expect(partnerIndex).toBeGreaterThan(-1);
    expect(spaIndex).toBeGreaterThan(-1);
    expect(elseIfIndex).toBeGreaterThan(spaIndex);
    expect(spaIndex).toBeGreaterThan(partnerIndex);
  });

  it("[sets activePhonePrompt with kind 'handover']", () => {
    expect(source).toMatch(/setActivePhonePrompt\(\{ kind: "handover", prompt: data\.handoverPhonePrompt \}\);/);
  });
});

describe("PublicWidgetChat — handover submit posts to service-request/phone, never partner-request/phone or spa-booking/phone", () => {
  it("[path resolution includes the new route]", () => {
    expect(source).toMatch(/"service-request\/phone"/);
  });

  it("[request body echoes guestMessage verbatim, sends roomNumber as typed or null — never invented]", () => {
    expect(source).toMatch(/guestMessage: activePhonePrompt\.prompt\.pendingHandover\.guestMessage,/);
    expect(source).toMatch(/roomNumber: roomNumberInput\.trim\(\) \|\| null,/);
  });
});

describe("PublicWidgetChat — room-number field only rendered when mayAskRoomNumber is true", () => {
  it("[gated on both kind === handover AND mayAskRoomNumber]", () => {
    expect(source).toMatch(/activePhonePrompt\.kind === "handover" && activePhonePrompt\.prompt\.pendingHandover\.mayAskRoomNumber && \(/);
  });

  it("[room number input is never marked required — the flow must never block on it]", () => {
    const start = source.indexOf('activePhonePrompt.kind === "handover" && activePhonePrompt.prompt.pendingHandover.mayAskRoomNumber && (');
    const block = source.slice(start, start + 700);
    expect(block).not.toMatch(/required/);
    expect(block).toMatch(/facultatif/i);
  });
});
