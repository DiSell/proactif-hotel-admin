import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "RoomPhotoModal.tsx"), "utf8");

/**
 * Source-level audit for RoomPhotoModal — same constraint as every other
 * "use client" component test in this repo: vitest's environment is "node"
 * (no jsdom/@testing-library/react anywhere in this repo), so a real
 * render/click can't be exercised. Confirms the STRUCTURAL properties a
 * render test would otherwise check.
 *
 * PHOTOS / CARROUSEL chantier: replaces the old static 2-column grid with a
 * main photo + a clickable, scrollable thumbnail strip — see the component's
 * own doc comment for the full rationale.
 */
function sliceFn(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const nextFn = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, nextFn === -1 ? undefined : nextFn);
}

describe("RoomPhotoModal — outer wrapper resets carousel state per photo set", () => {
  it("[key forces a remount] the outer component keys RoomPhotoModalInner by the exact photo URLs, so selectedIndex always starts fresh for a different accommodation/photo set — never a stale index carried over via useEffect", () => {
    const outer = sliceFn("RoomPhotoModal");
    expect(outer).toMatch(/key=\{photos\.map\(\(p\) => p\.url\)\.join\("\|"\)\}/);
    expect(outer).not.toMatch(/useEffect/);
  });
});

describe("RoomPhotoModalInner — main photo + thumbnail strip", () => {
  const inner = sliceFn("RoomPhotoModalInner");

  it("[state] selectedIndex starts at 0, derives the currently shown photo from it", () => {
    expect(inner).toMatch(/const \[selectedIndex, setSelectedIndex\] = useState\(0\);/);
    expect(inner).toMatch(/const selectedPhoto = photos\[selectedIndex\] \?\? null;/);
  });

  it("[empty state unchanged] falls back to the exact same 'no photo' message when there is nothing to show — never crashes on an empty array", () => {
    expect(inner).toMatch(/!selectedPhoto \? \(/);
    expect(inner).toMatch(/Aucune photo disponible pour cet hébergement\./);
  });

  it("[main photo] renders selectedPhoto, never the raw first photo directly — so clicking a thumbnail actually changes what's shown", () => {
    const mainPhotoBlock = inner.slice(inner.indexOf("!selectedPhoto ? ("), inner.indexOf("{photos.length > 1"));
    expect(mainPhotoBlock).toMatch(/src=\{selectedPhoto\.url\}/);
    expect(mainPhotoBlock).not.toMatch(/photos\[0\]/);
  });

  it("[thumbnail strip only for 2+ photos] a single photo shows no thumbnail row at all — not a real carousel", () => {
    expect(inner).toMatch(/\{photos\.length > 1 && \(/);
  });

  it("[thumbnails are clickable and set the main photo] each thumbnail's onClick sets selectedIndex to its own index", () => {
    const thumbBlock = inner.slice(inner.indexOf("{photos.length > 1"));
    expect(thumbBlock).toMatch(/onClick=\{\(\) => setSelectedIndex\(index\)\}/);
  });

  it("[active thumbnail is visually distinct] the currently selected thumbnail gets a different border/opacity than the others", () => {
    const thumbBlock = inner.slice(inner.indexOf("{photos.length > 1"));
    expect(thumbBlock).toMatch(/const isActive = index === selectedIndex;/);
    expect(thumbBlock).toMatch(/isActive \? "border-ink" : "border-transparent opacity-70/);
    expect(thumbBlock).toMatch(/aria-selected=\{isActive\}/);
  });

  it("[horizontally scrollable] the thumbnail strip allows horizontal overflow scrolling, never wraps or clips silently", () => {
    const thumbBlock = inner.slice(inner.indexOf("{photos.length > 1"));
    expect(thumbBlock).toMatch(/className="flex gap-2 overflow-x-auto pb-1"/);
    expect(thumbBlock).toMatch(/flex-shrink-0/); // each thumbnail keeps its own size instead of shrinking to fit
  });

  it("[order preserved] photos are mapped in the exact array order received — never re-sorted client-side (server/room_photos.position is the single source of truth)", () => {
    const thumbBlock = inner.slice(inner.indexOf("{photos.length > 1"));
    expect(thumbBlock).toMatch(/photos\.map\(\(photo, index\) => \{/);
    expect(thumbBlock).not.toMatch(/\.sort\(/);
  });

  it("[modal chrome unchanged] 'Voir la page' / 'Réserver' links and the max-height/max-width constraints are untouched by this chantier", () => {
    expect(inner).toMatch(/max-h-\[85vh\] w-full max-w-lg/);
    expect(inner).toMatch(/Voir la page/);
    expect(inner).toMatch(/Réserver/);
  });
});
