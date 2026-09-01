import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "ConversationModerationPanel.tsx"), "utf8");

describe("ConversationModerationPanel", () => {
  it("[block/unblock gated by ConfirmDialog, never a direct call from the button]", () => {
    expect(source).toMatch(/onClick=\{\(\) => setConfirmOpen\(true\)\}/);
    expect(source).toMatch(/<ConfirmDialog/);
    expect(source).toMatch(/onConfirm=\{handleConfirm\}/);
  });

  it("[toggles between block and unblock based on blockedAt, never a separate always-block button]", () => {
    const fn = source.slice(source.indexOf("function handleConfirm"), source.indexOf("return (", source.indexOf("function handleConfirm")));
    expect(fn).toMatch(/blockedAt \? await unblockConversationClient\(conversationId\) : await blockConversationClient\(conversationId\)/);
  });

  it("[hotelId never passed from this component] conversationId only — hotelId is resolved server-side inside the action via requireClientAccess", () => {
    const propsStart = source.indexOf("interface ConversationModerationPanelProps");
    const propsEnd = source.indexOf("}", propsStart);
    const props = source.slice(propsStart, propsEnd);
    expect(props).not.toMatch(/hotelId/);
  });

  it("[imports the client actions, never calls an RPC directly]", () => {
    expect(source).toMatch(/import \{ blockConversationClient, unblockConversationClient \} from "\.\/actions";/);
    expect(source).not.toMatch(/\.rpc\(/);
  });

  it("[flag reason shown when present, never fabricated]", () => {
    expect(source).toMatch(/\{flagReason && <p/);
  });

  it("[refreshes after a successful action]", () => {
    expect(source).toMatch(/router\.refresh\(\)/);
  });
});
