import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "InviteClientForm.tsx"), "utf8");

/**
 * Regression guards for the silent-invitation-failure fix — a "use client"
 * component, same DOM-less testing constraint as elsewhere in this repo
 * (no jsdom, see ResetPasswordForm.test.ts for the same pattern) — checked
 * at the source level. The server-side counterpart (inviteHotelClient never
 * letting an exception propagate raw) is exercised with real invocation
 * tests in actions.test.ts.
 *
 * Bug this guards against: handleSubmit awaited inviteHotelClient() inside
 * startTransition with no try/catch. useTransition still correctly resolves
 * isPending back to false when the awaited promise REJECTS (React's own
 * behavior, not a bug) — but with nothing catching the rejection, no toast
 * ever fired: the button silently stopped spinning with zero feedback,
 * exactly the "mouline puis plus rien" symptom reported.
 */
function sliceHandleSubmit(): string {
  const start = source.indexOf("function handleSubmit()");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  return (", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("InviteClientForm.handleSubmit — always produces user feedback", () => {
  it("[try/catch present] the entire body inside startTransition is wrapped — not just the ok:false branch", () => {
    const fn = sliceHandleSubmit();
    expect(fn).toMatch(/startTransition\(async \(\) => \{\s*\n(?:.*\n)*?\s*try \{/);
    expect(fn).toMatch(/\} catch \(err\) \{/);
  });

  it("[catch shows a danger toast] an unhandled exception is surfaced, never silently swallowed", () => {
    const fn = sliceHandleSubmit();
    const catchBlock = fn.slice(fn.indexOf("} catch (err) {"));
    expect(catchBlock).toMatch(/toast\.show\(.*"danger"\)/);
  });

  it("[catch never leaks the raw exception into the toast] only a static, safe message reaches the user — the exception itself is only ever passed to console.error", () => {
    const fn = sliceHandleSubmit();
    const catchBlock = fn.slice(fn.indexOf("} catch (err) {"));
    expect(catchBlock).toMatch(/console\.error\("InviteClientForm: inviteHotelClient threw", err\)/);
    // The toast call in the catch block takes a literal string, never `err` or `err.message` interpolated into it.
    const toastCallInCatch = catchBlock.match(/toast\.show\((".*?"), "danger"\)/);
    expect(toastCallInCatch).not.toBeNull();
    expect(toastCallInCatch?.[1]).not.toMatch(/err/);
  });

  it("[no false success] 'Invitation envoyée' is only reached through the result.ok === true path — the catch block never shows it", () => {
    const fn = sliceHandleSubmit();
    const catchBlock = fn.slice(fn.indexOf("} catch (err) {"));
    expect(catchBlock).not.toMatch(/Invitation envoyée/);

    const tryBlock = fn.slice(fn.indexOf("try {"), fn.indexOf("} catch (err) {"));
    expect(tryBlock).toMatch(/if \(!result\.ok \|\| !result\.data\) \{/);
    expect(tryBlock.indexOf("Invitation envoyée")).toBeGreaterThan(tryBlock.indexOf("if (!result.ok || !result.data) {"));
  });

  it("[result.ok === false still shown] the existing error-toast branch for a clean ActionResult failure is preserved", () => {
    const fn = sliceHandleSubmit();
    expect(fn).toMatch(/toast\.show\(result\.error \?\? "Erreur", "danger"\)/);
  });
});
