import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "HotelMediaManager.tsx"), "utf8");

describe("HotelMediaManager — surfaces the action's result, never swallows it", () => {
  it("[uses useToast, shows an error toast on failure]", () => {
    expect(source).toMatch(/import \{ useToast \} from "@\/components\/ui\/Toast";/);
    expect(source).toMatch(/if \(!result\.ok\) \{\s*toast\.show\(result\.error \?\? "Erreur", "danger"\);/);
  });

  it("[refreshes the page after a successful toggle]", () => {
    expect(source).toMatch(/router\.refresh\(\)/);
  });
});

describe("HotelMediaManager — upload gated by canUpload, never unconditional", () => {
  it("[the upload form only renders when canUpload is true]", () => {
    expect(source).toMatch(/\{canUpload && <CategoryUploadForm/);
  });
});

describe("HotelMediaManager — aucune régression room_photos / PhotosManager", () => {
  it("[ce fichier ne référence jamais room_photos ni accommodation_types]", () => {
    expect(source).not.toMatch(/room_photos/);
    expect(source).not.toMatch(/accommodation_types/);
  });
});
