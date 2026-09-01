import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-level only — no jsdom in this repo's vitest config (environment:
 * "node"), same convention as every other Client Component in this
 * codebase (see e.g. EmbeddedSignupButton.test.ts's own doc comment).
 * displayState() is a pure function but deliberately NOT exported (task:
 * "sans refactoring") — verified here by inspecting its exact conditions
 * instead of importing and calling it directly.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "EventsManager.tsx"), "utf8");

function sliceFunction(name: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const nextFn = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, nextFn === -1 ? undefined : nextFn);
}

describe("EventsManager — état affiché (Actif / Futur / Expiré / Désactivé)", () => {
  it("[disabled wins over everything else] is_active === false -> 'disabled', checked FIRST", () => {
    const fn = sliceFunction("displayState");
    const disabledCheckIndex = fn.indexOf('if (!event.is_active) return "disabled";');
    expect(disabledCheckIndex).toBeGreaterThan(-1);
    // Must be the first condition in the function body.
    const bodyStart = fn.indexOf("{") + 1;
    expect(fn.slice(bodyStart, disabledCheckIndex).trim()).toBe("");
  });

  it("[permanent, active] always 'active' — no date logic applies to a permanent row", () => {
    const fn = sliceFunction("displayState");
    expect(fn).toMatch(/if \(event\.type === "permanent"\) return "active";/);
  });

  it("[temporary, not yet started] 'upcoming' when today < starts_at", () => {
    const fn = sliceFunction("displayState");
    expect(fn).toMatch(/if \(event\.starts_at && todayIso < event\.starts_at\) return "upcoming";/);
  });

  it("[temporary, past its end] 'expired' when today > ends_at", () => {
    const fn = sliceFunction("displayState");
    expect(fn).toMatch(/if \(event\.ends_at && todayIso > event\.ends_at\) return "expired";/);
  });

  it("[temporary, within window] falls through to 'active'", () => {
    const fn = sliceFunction("displayState");
    expect(fn.trim().endsWith('return "active";\n}') || fn.includes('return "active";\n}')).toBe(true);
  });

  it("[the 4 required badge labels, correctly mapped]", () => {
    expect(source).toMatch(/active: \{ label: "Actif", tone: "success" \}/);
    expect(source).toMatch(/upcoming: \{ label: "Futur", tone: "warning" \}/);
    expect(source).toMatch(/expired: \{ label: "Expiré", tone: "neutral" \}/);
    expect(source).toMatch(/disabled: \{ label: "Désactivé", tone: "neutral" \}/);
  });
});

describe("EventsManager — actions CRUD wired to the real *Client server actions", () => {
  it("[toggle active/inactive] calls setHotelEventActiveClient with the OPPOSITE of the current is_active, then refreshes", () => {
    const fn = sliceFunction("toggleActive");
    expect(fn).toMatch(/setHotelEventActiveClient\(hotelId, event\.id, !event\.is_active\)/);
    expect(fn).toMatch(/router\.refresh\(\)/);
  });

  it("[delete] calls deleteHotelEventClient for the confirmed target only, then refreshes", () => {
    const fn = sliceFunction("handleDelete");
    expect(fn).toMatch(/deleteHotelEventClient\(hotelId, target\.id\)/);
    expect(fn).toMatch(/router\.refresh\(\)/);
  });

  it("[create] '+ Ajouter un événement' opens EventFormModal with event=null (create mode)", () => {
    expect(source).toMatch(/setFormTarget\("new"\)/);
    expect(source).toMatch(/event=\{formTarget === "new" \? null : formTarget\}/);
  });

  it("[edit] 'Modifier' opens EventFormModal with the exact row being edited", () => {
    expect(source).toMatch(/onClick=\{\(\) => setFormTarget\(event\)\}/);
  });

  it("[confirm-before-delete] delete is gated by ConfirmDialog, never a direct call from the row button", () => {
    expect(source).toMatch(/onClick=\{\(\) => setDeleteTarget\(event\)\}/);
    expect(source).toMatch(/<ConfirmDialog/);
    expect(source).toMatch(/onConfirm=\{handleDelete\}/);
  });

  it("[imports only the *Client actions] no admin/backoffice variant imported — matches the task's own confirmed scope", () => {
    expect(source).toMatch(/import \{ deleteHotelEventClient, setHotelEventActiveClient \} from "\.\/actions";/);
    expect(source).not.toMatch(/Backoffice/);
  });
});
