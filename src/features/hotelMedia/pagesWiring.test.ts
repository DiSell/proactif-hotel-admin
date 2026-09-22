import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const backofficePage = readFileSync(
  join(process.cwd(), "src/app/(app)/etablissements/[id]/photos/page.tsx"),
  "utf8"
);
const clientPage = readFileSync(join(process.cwd(), "src/app/client/(portal)/photos/page.tsx"), "utf8");

describe("back-office /etablissements/[id]/photos — upload toujours disponible", () => {
  it("[canUpload inconditionnel, scope=\"backoffice\"]", () => {
    expect(backofficePage).toMatch(/<HotelMediaManager[\s\S]*?canUpload[\s\S]*?scope="backoffice"/);
    expect(backofficePage).not.toMatch(/canUpload=\{/);
  });

  it("[comportement PhotosManager/TargetedPhotoImport inchangé]", () => {
    expect(backofficePage).toMatch(/<PhotosManager hotelId=\{id\} accommodations=\{data\.accommodations\} actions=\{PHOTO_ACTIONS_BACKOFFICE\} \/>/);
  });
});

describe("client portal /client/photos — upload gated by hotels.photo_management", () => {
  it("[canUpload dérivé de data.photoManagement === \"client\", jamais recalculé ailleurs]", () => {
    expect(clientPage).toMatch(/canUpload=\{data\.photoManagement === "client"\}/);
  });

  it("[scope=\"client\"]", () => {
    expect(clientPage).toMatch(/<HotelMediaManager[\s\S]*?scope="client"/);
  });

  it("[réutilise data déjà récupérée par getPhotosManagerData, pas de second appel réseau pour le mode]", () => {
    const dataFetchCount = (clientPage.match(/getPhotosManagerData\(/g) ?? []).length;
    expect(dataFetchCount).toBe(1);
  });

  it("[sélection/désélection toujours disponible, indépendamment du mode]", () => {
    expect(clientPage).toMatch(/<PhotosManager hotelId=\{hotelId\} accommodations=\{data\.accommodations\} actions=\{PHOTO_ACTIONS_CLIENT\} \/>/);
  });
});
