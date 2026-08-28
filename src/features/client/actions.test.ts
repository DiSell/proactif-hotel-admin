import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * Regression guards for the client-only chatbot personalization actions —
 * Supabase-touching (requireClientAccess + createAdminClient), same
 * testing constraint as every other Server Action in this repo (see
 * src/features/knowledge/actions.test.ts) — checked at the source level.
 * requireClientAccess itself is already exhaustively covered at runtime in
 * src/lib/auth/session.test.ts — not re-tested here.
 */
function sliceFunction(exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}`);
  expect(start).toBeGreaterThan(-1);
  const nextExport = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, nextExport === -1 ? undefined : nextExport);
}

describe("updateChatbotPersonalization", () => {
  it("[hotelId never accepted as input] the exported function takes only `input`, never a hotelId parameter — always resolved from the caller's own session", () => {
    const signatureStart = source.indexOf("export async function updateChatbotPersonalization(");
    const signatureEnd = source.indexOf(")", signatureStart);
    const signature = source.slice(signatureStart, signatureEnd);
    expect(signature).not.toMatch(/hotelId/);
  });

  it("[tenant isolation] hotelId comes from requireClientAccess(), then every write is scoped by it", () => {
    const fn = sliceFunction("updateChatbotPersonalization");
    expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
    expect(fn).toMatch(/\.eq\("id", hotelId\)/);
    expect(fn).toMatch(/\.eq\("hotel_id", hotelId\)/);
  });

  it("[validated input] parses through clientChatbotPersonalizationSchema before writing anything, never the raw input", () => {
    const fn = sliceFunction("updateChatbotPersonalization");
    expect(fn).toMatch(/clientChatbotPersonalizationSchema\.safeParse\(input\)/);
  });

  it("[assistant name reused] writes hotels.assistant_name — no new column", () => {
    const fn = sliceFunction("updateChatbotPersonalization");
    expect(fn).toMatch(/assistant_name:\s*parsed\.data\.assistant_name/);
  });

  it("[welcome message targets the field the real widget reads] writes widget_settings.welcome_message, NEVER chatbot_settings — see the migration's own comment on why", () => {
    const fn = sliceFunction("updateChatbotPersonalization");
    expect(fn).toMatch(/welcome_message:\s*parsed\.data\.welcome_message/);
    expect(fn).toMatch(/from\("widget_settings"\)/);
    expect(fn).not.toMatch(/from\("chatbot_settings"\)/);
  });

  it("[upsert] creates widget_settings when absent, updates when present — a hotel that never visited the widget settings page still gets its welcome message saved", () => {
    const fn = sliceFunction("updateChatbotPersonalization");
    expect(fn).toMatch(/existingWidgetSettings/);
    expect(fn).toMatch(/\.insert\(\{\s*hotel_id:\s*hotelId,\s*welcome_message:\s*parsed\.data\.welcome_message\s*\}\)/);
  });
});

describe("setPhotoManagementMode", () => {
  it("[client-only] guarded by requireClientAccess, never requireHotelAccess/requireSuperadmin — the delegation decision belongs to the client alone", () => {
    const fn = sliceFunction("setPhotoManagementMode");
    expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
    expect(fn).not.toMatch(/requireHotelAccess/);
  });

  it("[hotelId never accepted as input] the exported function takes only `mode`, never a hotelId parameter", () => {
    const signatureStart = source.indexOf("export async function setPhotoManagementMode(");
    const signatureEnd = source.indexOf(")", signatureStart);
    const signature = source.slice(signatureStart, signatureEnd);
    expect(signature).not.toMatch(/hotelId/);
  });

  it("[writes hotels.photo_management, scoped by hotelId]", () => {
    const fn = sliceFunction("setPhotoManagementMode");
    expect(fn).toMatch(/photo_management:\s*parsed\.data/);
    expect(fn).toMatch(/\.eq\("id", hotelId\)/);
  });
});
