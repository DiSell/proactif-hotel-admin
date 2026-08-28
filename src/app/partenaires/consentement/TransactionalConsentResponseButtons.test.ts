import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "TransactionalConsentResponseButtons.tsx"), "utf8");

/**
 * Source-level only — no jsdom in this repo's vitest config (see
 * PublicWidgetChat.hostBooking.test.ts's own doc comment for the same
 * constraint). This component never sends anything on mount: it only wires
 * two buttons to the two transactional consent actions, both of which
 * require an explicit click.
 */
describe("TransactionalConsentResponseButtons — never auto-sends, distinct from the recommendation flow's own buttons", () => {
  it("[calls the transactional actions, never the recommendation ones]", () => {
    expect(source).toMatch(/acceptPartnerTransactionalConsent/);
    expect(source).toMatch(/declinePartnerTransactionalConsent/);
    expect(source).not.toMatch(/[^l]acceptPartnerConsent\(/);
    expect(source).not.toMatch(/[^l]declinePartnerConsent\(/);
  });

  it("[no effect runs on mount] the only calls to the accept/decline actions happen inside the respond() handler, never in a useEffect", () => {
    expect(source).not.toMatch(/useEffect/);
  });

  it("[button clicks are the only trigger] respond() is only ever invoked from onClick handlers", () => {
    const onClickCalls = source.match(/onClick=\{[^}]*respond\([^)]*\)[^}]*\}/g) ?? [];
    expect(onClickCalls.length).toBe(2);
  });

  it("[no opening_hours/address props] this consent has nothing to do with the partner's public listing", () => {
    const start = source.indexOf("interface TransactionalConsentResponseButtonsProps");
    const propsInterface = source.slice(start, source.indexOf("}", start) + 1);
    expect(propsInterface).not.toMatch(/openingHours/);
    expect(propsInterface).not.toMatch(/address/);
  });

  it("[token passed through verbatim, never logged]", () => {
    expect(source).not.toMatch(/console\.(log|error|warn)/);
  });
});
