import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "extractStayRequest.ts"), "utf8");

/**
 * OpenAI-touching, same testing constraint as the rest of this codebase
 * (see similarityThreshold.test.ts) — checked at the source level. The
 * deterministic side of this pipeline (validateStayRequestState) has real
 * unit tests in stayRequest.test.ts.
 */
describe("resolveStayRequestFromHistory", () => {
  it("uses structured output (responses.parse), not a plain text completion", () => {
    expect(source).toMatch(/responses\.parse\(/);
    expect(source).toMatch(/zodTextFormat\(stayRequestStateSchema/);
  });

  it("injects referenceDate and timeZone into the extraction instructions, for resolving relative dates", () => {
    expect(source).toMatch(/context\.referenceDate/);
    expect(source).toMatch(/context\.timeZone/);
  });

  it("explicitly forbids inventing an ambiguous date", () => {
    expect(source).toMatch(/n'invente JAMAIS une date/);
  });

  it("explicitly treats assistant messages as context, never an acquired fact without visitor confirmation", () => {
    expect(source).toMatch(/ASSISTANT sont du CONTEXTE/);
    expect(source).toMatch(/QUE si le visiteur l'a ensuite confirmée ou corrigée/);
  });

  it("distinguishes childrenCount = 0 (explicit) from null (unknown)", () => {
    expect(source).toMatch(/childrenCount = 0 signifie explicitement/);
  });
});
