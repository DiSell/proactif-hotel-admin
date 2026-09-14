import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
function read(file: string): string {
  return readFileSync(join(here, file), "utf8");
}

/**
 * Regression guard for the "every action result was dropped on the floor"
 * bug: LoyaltySettingsForm, CancelCampaignButton, CampaignForm,
 * CreateCustomerForm and AddCustomerStayForm each call a Server Action and
 * used to ignore whatever it returned — a validation error or RPC failure
 * looked exactly like nothing happening. Each must now import useToast and
 * branch on the result's `ok` field before treating the call as done.
 */
describe.each([
  ["LoyaltySettingsForm.tsx", "saveLoyaltySettings"],
  ["CancelCampaignButton.tsx", "cancelCampaign"],
  ["CampaignForm.tsx", "createCampaign"],
  ["CreateCustomerForm.tsx", "createCustomer"],
  ["AddCustomerStayForm.tsx", "addCustomerStay"],
])("%s", (file, actionName) => {
  const source = read(file);

  it(`[imports useToast and calls ${actionName}]`, () => {
    expect(source).toMatch(/import \{ useToast \} from "@\/components\/ui\/Toast";/);
    expect(source).toContain(actionName);
  });

  it("[branches on result.ok before proceeding]", () => {
    expect(source).toMatch(/if \(!result\.ok\)/);
  });

  it("[shows the action's own error message on failure, via toast]", () => {
    expect(source).toMatch(/toast\.show\(result\.error \?\? "Erreur", "danger"\)/);
  });
});
