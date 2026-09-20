import { Fragment } from "react";

/**
 * MOBILE LISIBILITÉ chantier — shared by PublicWidgetChat.tsx (the real
 * customer-facing widget) and ChatPreview.tsx (the admin test/preview
 * widget), which both used to render `{message.content}` as a raw text
 * node: the browser's default `white-space: normal` collapses every `\n`
 * the model produces, and any Markdown syntax (`**bold**`, `- item`) shows
 * up as literal characters instead of being interpreted — see this
 * chantier's own audit for the real, reproduced evidence.
 *
 * Deliberately a small, hand-rolled parser rather than a Markdown library
 * (react-markdown or similar): the audit's own required subset is narrow
 * (paragraphs, line breaks, bullet/numbered lists, bold) and package.json
 * has no Markdown-capable dependency already installed — pulling one in for
 * five rules would be a heavier, harder-to-audit dependency for no real
 * gain.
 *
 * The parsing (parseAssistantMessageBlocks/parseInlineSegments below) is
 * deliberately split from the JSX-producing component: this repo's vitest
 * runs with environment "node" (no jsdom) and only collects "*.test.ts"
 * files (see vitest.config.mts) — real component rendering can't be
 * exercised, but these two pure functions can be invoked directly and
 * asserted on exactly like every other pure function in this codebase, and
 * are the entire "what structure gets produced" decision. The component
 * itself is exercised the same way PublicWidgetChat.roomCatalogue.test.ts
 * already exercises other "use client" JSX (source-level assertions —
 * see AssistantMessageContent.wiring.test.ts).
 *
 * SECURITY: this renderer never interprets HTML. Every fragment of the
 * model's text reaches React exclusively as a text child (`{segment.text}`),
 * which React escapes automatically — there is no dangerouslySetInnerHTML
 * anywhere in this file, and no auto-linking of URLs (never introduced, so
 * never a regression either).
 */

const BULLET_LINE_PATTERN = /^\s*[-*]\s+(.*)$/;
const NUMBERED_LINE_PATTERN = /^\s*\d+[.)]\s+(.*)$/;
const BOLD_SEGMENT_PATTERN = /(\*\*[^*\n]+\*\*)/g;

export type AssistantMessageBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "bullet-list"; items: string[] }
  | { type: "numbered-list"; items: string[] };

function isUniformList(lines: string[], pattern: RegExp): boolean {
  return lines.length > 0 && lines.every((line) => pattern.test(line));
}

/**
 * Splits on blank lines (`\n{2,}`) into blocks, then classifies each block:
 * every non-empty line matching the same bullet/numbered marker -> a list,
 * otherwise a paragraph (its own internal single `\n`s are preserved as
 * separate `lines`, rendered as soft line breaks — see the component).
 * A single short line ("Bonjour", "Le 1837 compte 36 logements.") always
 * produces exactly one paragraph block with one line — never artificially
 * split into a list or multiple blocks.
 */
export function parseAssistantMessageBlocks(content: string): AssistantMessageBlock[] {
  const rawBlocks = content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return rawBlocks.map((block): AssistantMessageBlock => {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (isUniformList(lines, BULLET_LINE_PATTERN)) {
      return { type: "bullet-list", items: lines.map((line) => line.replace(BULLET_LINE_PATTERN, "$1")) };
    }
    if (isUniformList(lines, NUMBERED_LINE_PATTERN)) {
      return { type: "numbered-list", items: lines.map((line) => line.replace(NUMBERED_LINE_PATTERN, "$1")) };
    }
    return { type: "paragraph", lines };
  });
}

export interface InlineSegment {
  text: string;
  bold: boolean;
}

/** The ONLY inline markup this renderer understands: `**bold**`. Never HTML, never a link. */
export function parseInlineSegments(text: string): InlineSegment[] {
  return text
    .split(BOLD_SEGMENT_PATTERN)
    .filter((part) => part.length > 0)
    .map((part) => (part.startsWith("**") && part.endsWith("**") && part.length > 4 ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false }));
}

function renderInline(text: string, keyPrefix: string) {
  return parseInlineSegments(text).map((segment, index) =>
    segment.bold ? <strong key={`${keyPrefix}-${index}`}>{segment.text}</strong> : <Fragment key={`${keyPrefix}-${index}`}>{segment.text}</Fragment>
  );
}

export interface AssistantMessageContentProps {
  content: string;
}

export function AssistantMessageContent({ content }: AssistantMessageContentProps) {
  const blocks = parseAssistantMessageBlocks(content);
  if (blocks.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, wordBreak: "break-word" }}>
      {blocks.map((block, blockIndex) => {
        if (block.type === "bullet-list") {
          return (
            <ul key={blockIndex} style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4, listStyle: "disc" }}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} style={{ lineHeight: 1.5 }}>
                  {renderInline(item, `${blockIndex}-${itemIndex}`)}
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === "numbered-list") {
          return (
            <ol key={blockIndex} style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4, listStyle: "decimal" }}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} style={{ lineHeight: 1.5 }}>
                  {renderInline(item, `${blockIndex}-${itemIndex}`)}
                </li>
              ))}
            </ol>
          );
        }

        return (
          <p key={blockIndex} style={{ margin: 0, lineHeight: 1.5 }}>
            {block.lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderInline(line, `${blockIndex}-${lineIndex}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
