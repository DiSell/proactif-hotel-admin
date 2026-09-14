import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "CustomerCommunicationForm.tsx"), "utf8");

describe("CustomerCommunicationForm — surfaces the action's result, never swallows it", () => {
  it("[uses useToast, shows an error toast on failure]", () => {
    expect(source).toMatch(/import \{ useToast \} from "@\/components\/ui\/Toast";/);
    expect(source).toMatch(/if \(!result\.ok\) \{\s*toast\.show\(result\.error \?\? "Erreur", "danger"\);/);
  });

  it("[refreshes the page after a successful save]", () => {
    expect(source).toMatch(/router\.refresh\(\)/);
  });
});
