import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "HotelMediaManager.tsx"), "utf8");

const mockCreateClient = vi.fn(() => ({ __client: "backoffice" }));
const mockCreateClientPortalBrowserClient = vi.fn(() => ({ __client: "client-portal" }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => mockCreateClient(),
  createClientPortalBrowserClient: () => mockCreateClientPortalBrowserClient(),
}));

afterEach(() => {
  mockCreateClient.mockClear();
  mockCreateClientPortalBrowserClient.mockClear();
});

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
    expect(source).toMatch(/\{canUpload && \(\s*<CategoryUploadForm/);
  });
});

describe("resolveHotelMediaBrowserClient — jamais de cookie back-office depuis /client/photos", () => {
  it("[scope=\"client\"] utilise createClientPortalBrowserClient(), jamais createClient()", async () => {
    const { resolveHotelMediaBrowserClient } = await import("./HotelMediaManager");
    resolveHotelMediaBrowserClient("client");
    expect(mockCreateClientPortalBrowserClient).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("[scope=\"backoffice\"] utilise createClient(), jamais createClientPortalBrowserClient()", async () => {
    const { resolveHotelMediaBrowserClient } = await import("./HotelMediaManager");
    resolveHotelMediaBrowserClient("backoffice");
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateClientPortalBrowserClient).not.toHaveBeenCalled();
  });

  it("[le composant délègue toujours à cette résolution, jamais d'appel direct à createClient/createClientPortalBrowserClient ailleurs dans le fichier]", () => {
    expect(source).toMatch(/const supabase = resolveHotelMediaBrowserClient\(scope\);/);
    const occurrencesOfCreateClient = (source.match(/\bcreateClient\(\)/g) ?? []).length;
    const occurrencesOfPortalClient = (source.match(/\bcreateClientPortalBrowserClient\(\)/g) ?? []).length;
    // Each factory is called exactly once, inside resolveHotelMediaBrowserClient itself.
    expect(occurrencesOfCreateClient).toBe(1);
    expect(occurrencesOfPortalClient).toBe(1);
  });

  it("[le composant n'importe plus la Server Action directement] addPhoto vient toujours du bundle d'actions", () => {
    expect(source).not.toMatch(/import \{ addHotelMediaPhoto[^}]*\} from "\.\/actions";/);
    expect(source).toMatch(/addPhoto\(hotelId,/);
  });
});

describe("HotelMediaManager — aucune régression room_photos / PhotosManager", () => {
  it("[ce fichier ne référence jamais room_photos ni accommodation_types]", () => {
    expect(source).not.toMatch(/room_photos/);
    expect(source).not.toMatch(/accommodation_types/);
  });
});
