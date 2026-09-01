import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "EventFormModal.tsx"), "utf8");

describe("EventFormModal — impossible d'activer le bandeau sur un événement permanent", () => {
  it("[banner toggle only rendered when isTemporary] a permanent event's form never even shows the control", () => {
    const rendersBannerToggle = /\{isTemporary && \(\s*<div className="flex items-center gap-2">\s*<Toggle checked=\{showAsBanner\}/;
    expect(source).toMatch(rendersBannerToggle);
  });

  it("[banner toggle has a VISIBLE caption next to it] Toggle's own `label` prop is aria-label only (see components/ui/Toggle.tsx) — never rendered as text, so an adjacent <span> is required, same pattern already used for the 'Actif'/'Inactif' toggle", () => {
    const bannerToggleBlock = source.slice(source.indexOf("<Toggle checked={showAsBanner}"), source.indexOf("</div>", source.indexOf("<Toggle checked={showAsBanner}")));
    expect(bannerToggleBlock).toMatch(/<span className="text-xs text-ink">.+<\/span>/);
  });

  it("[switching to 'permanent' clears showAsBanner immediately] a value set while 'temporary' can never survive a type switch", () => {
    const fn = source.slice(source.indexOf("function handleTypeChange"), source.indexOf("function handleSubmit"));
    expect(fn).toMatch(/if \(nextType === "permanent"\) \{/);
    expect(fn).toMatch(/setShowAsBanner\(false\);/);
  });

  it("[submission is defensive too] show_as_banner is force-false in the submitted input whenever isTemporary is false, even if state were somehow stale", () => {
    const fn = source.slice(source.indexOf("function handleSubmit"), source.indexOf("return ("));
    expect(fn).toMatch(/show_as_banner: isTemporary \? showAsBanner : false,/);
  });
});

describe("EventFormModal — dates (obligatoires pour un temporaire, cohérence ends_at >= starts_at)", () => {
  it("[date inputs only rendered for a temporary event]", () => {
    expect(source).toMatch(/\{isTemporary && \(\s*<div className="grid grid-cols-2 gap-3">/);
  });

  it("[both date fields marked required in the UI]", () => {
    const fn = source.slice(source.indexOf('{isTemporary && (\n          <div className="grid grid-cols-2'), source.indexOf("</div>\n        )}\n\n        <div className=\"flex items-center justify-between"));
    expect(fn).toMatch(/label="Date de début" htmlFor="event_starts_at" required/);
    expect(fn).toMatch(/label="Date de fin" htmlFor="event_ends_at" required/);
  });

  it("[server-side field errors are surfaced back onto the exact right fields] ends_at >= starts_at is enforced server-side (hotelEventSchema) and the resulting fieldErrors.ends_at reaches the FormField's own error prop", () => {
    expect(source).toMatch(/error=\{errors\.starts_at\}/);
    expect(source).toMatch(/error=\{errors\.ends_at\}/);
    expect(source).toMatch(/setErrors\(result\.fieldErrors \?\? \{\}\);/);
  });

  it("[submission clears dates when switching back to permanent] never silently submits a leftover starts_at/ends_at for a 'permanent' row", () => {
    const submitFn = source.slice(source.indexOf("function handleSubmit"), source.indexOf("return ("));
    expect(submitFn).toMatch(/starts_at: isTemporary \? startsAt : "",/);
    expect(submitFn).toMatch(/ends_at: isTemporary \? endsAt : "",/);
  });
});

describe("EventFormModal — create vs edit dispatch to the correct *Client action", () => {
  it("[new event, event === null] calls createHotelEventClient", () => {
    const submitFn = source.slice(source.indexOf("function handleSubmit"), source.indexOf("return ("));
    expect(submitFn).toMatch(/await createHotelEventClient\(hotelId, input\)/);
  });

  it("[editing, event !== null] calls updateHotelEventClient with the exact row id", () => {
    const submitFn = source.slice(source.indexOf("function handleSubmit"), source.indexOf("return ("));
    expect(submitFn).toMatch(/await updateHotelEventClient\(hotelId, event\.id, input\)/);
  });
});
