import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");
const grantMigration = readFileSync(
  join(here, "..", "..", "..", "supabase", "migrations", "0040_chatbot_settings_price_communication_service_role_grant.sql"),
  "utf8"
);

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

describe("blockConversationClient / unblockConversationClient", () => {
  it("[hotelId never accepted as input] each exported function takes only `conversationId`", () => {
    for (const name of ["blockConversationClient", "unblockConversationClient"]) {
      const signatureStart = source.indexOf(`export async function ${name}(`);
      const signatureEnd = source.indexOf(")", signatureStart);
      const signature = source.slice(signatureStart, signatureEnd);
      expect(signature).not.toMatch(/hotelId/);
      expect(signature).toMatch(/conversationId/);
    }
  });

  it("[hotelId resolved from the caller's own session, never trusted from elsewhere]", () => {
    for (const name of ["blockConversationClient", "unblockConversationClient"]) {
      const fn = sliceFunction(name);
      expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
    }
  });

  it("[calls the matching SECURITY DEFINER RPC with p_hotel_id/p_conversation_id]", () => {
    const blockFn = sliceFunction("blockConversationClient");
    expect(blockFn).toMatch(/\.rpc\("block_conversation", \{ p_hotel_id: hotelId, p_conversation_id: conversationId \}\)/);

    const unblockFn = sliceFunction("unblockConversationClient");
    expect(unblockFn).toMatch(/\.rpc\("unblock_conversation", \{ p_hotel_id: hotelId, p_conversation_id: conversationId \}\)/);
  });
});

/**
 * The ONE chatbot_settings field a hotel_admin may write themselves — see
 * this function's own doc comment for why it's a dedicated, narrow action
 * rather than a reuse of the superadmin-only saveAssistantSettings.
 */
describe("setAllowPriceCommunication", () => {
  it("[hotelId never accepted as input] the exported function takes only `allow`, never a hotelId parameter", () => {
    const signatureStart = source.indexOf("export async function setAllowPriceCommunication(");
    const signatureEnd = source.indexOf(")", signatureStart);
    const signature = source.slice(signatureStart, signatureEnd);
    expect(signature).not.toMatch(/hotelId/);
    expect(signature).toMatch(/allow: boolean/);
  });

  it("[client-only, resolved from the caller's own session]", () => {
    const fn = sliceFunction("setAllowPriceCommunication");
    expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
    expect(fn).not.toMatch(/requireHotelAccess/);
    expect(fn).not.toMatch(/requireSuperadmin/);
  });

  it("[service-role client — chatbot_settings has no hotel_admin WRITE policy, only a read one]", () => {
    const fn = sliceFunction("setAllowPriceCommunication");
    expect(fn).toMatch(/const supabase = createAdminClient\(\);/);
  });

  it("[writes ONLY allow_price_communication, scoped by hotel_id via UPDATE — never an upsert/insert]", () => {
    const fn = sliceFunction("setAllowPriceCommunication");
    expect(fn).toMatch(/\.from\("chatbot_settings"\)\s*\n\s*\.update\(\{ allow_price_communication: parsed\.data \}\)\s*\n\s*\.eq\("hotel_id", hotelId\)/);
    expect(fn).not.toMatch(/\.upsert\(/);
    expect(fn).not.toMatch(/\.insert\(/);
    // Never touches any other chatbot_settings column (tone, formality, etc.) — the narrow-scope guarantee.
    expect(fn).not.toMatch(/tone:|formality:|response_length:|commercial_proactivity:|custom_instructions:/);
  });

  it("[tenant isolation] hotelId comes from requireClientAccess(), never from any other input — hotel A can only ever affect its own row (requireClientAccess's own cross-hotel guarantees are exhaustively covered in src/lib/auth/session.test.ts, not re-proven here, same convention as every other action in this file)", () => {
    const fn = sliceFunction("setAllowPriceCommunication");
    expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
    expect(fn).toMatch(/\.eq\("hotel_id", hotelId\)/);
  });

  it("[validated through the dedicated boolean schema, not the broader superadmin one]", () => {
    const fn = sliceFunction("setAllowPriceCommunication");
    expect(fn).toMatch(/allowPriceCommunicationSchema\.safeParse\(allow\)/);
    expect(fn).not.toMatch(/chatbotSettingsSchema/);
  });
});

/**
 * The migration fixing the real "permission denied for table
 * chatbot_settings" gap found by exercising the real database — see the
 * migration file's own header for the full incident. service_role needs
 * this GRANT for setAllowPriceCommunication's UPDATE above to ever succeed
 * against production; this file only proves the grant is column-scoped and
 * additive, never a broad table-wide UPDATE for service_role on an
 * otherwise superadmin-owned table.
 */
describe("0040_chatbot_settings_price_communication_service_role_grant.sql", () => {
  it("[column-scoped, not a bare table-wide grant] grants UPDATE on allow_price_communication only", () => {
    expect(grantMigration).toMatch(/grant update \(allow_price_communication\) on public\.chatbot_settings to service_role;/);
    expect(grantMigration).not.toMatch(/grant update on public\.chatbot_settings/);
  });

  it("[additive only] no other GRANT, no RLS policy change, no table/column DDL", () => {
    const grantStatements = grantMigration.match(/^grant .*/gm) ?? [];
    expect(grantStatements).toEqual(["grant update (allow_price_communication) on public.chatbot_settings to service_role;"]);
    expect(grantMigration).not.toMatch(/create policy|alter policy|drop policy/);
    expect(grantMigration).not.toMatch(/alter table|create table|drop table/);
    expect(grantMigration).not.toMatch(/revoke/);
  });
});
