import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "page.tsx"), "utf8");

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — client-portal exposure. Pins that
 * ClientChatbotPage renders HandoverSmsNumbersForm, fed from the SAME
 * chatbotData.chatbotSettings this page already loads via
 * getClientChatbotInfo() (no new query added) — never a client-supplied
 * hotelId, never a separate fetch.
 */
describe("ClientChatbotPage — HandoverSmsNumbersForm wiring", () => {
  it("[rendered, fed from chatbotData.chatbotSettings — the same object every other section on this page already reads]", () => {
    expect(source).toMatch(/import \{ HandoverSmsNumbersForm \} from "@\/features\/client\/HandoverSmsNumbersForm";/);
    expect(source).toMatch(/initialPrimary=\{chatbotData\.chatbotSettings\?\.handover_sms_phone_primary \?\? ""\}/);
    expect(source).toMatch(/initialSecondary=\{chatbotData\.chatbotSettings\?\.handover_sms_phone_secondary \?\? ""\}/);
    expect(source).toMatch(/initialBackup=\{chatbotData\.chatbotSettings\?\.handover_sms_phone_backup \?\? ""\}/);
  });

  it("[no new query introduced] the same Promise.all([getClientChatbotInfo(), getClientWidgetInfo()]) call still feeds the whole page — no second hotelId source added for this form", () => {
    expect(source).toMatch(/const \[chatbotData, widgetData\] = await Promise\.all\(\[getClientChatbotInfo\(\), getClientWidgetInfo\(\)\]\);/);
  });
});
