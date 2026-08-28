import { describe, expect, it } from "vitest";
import { PHOTO_ACTIONS_BACKOFFICE, PHOTO_ACTIONS_CLIENT } from "./actionBundles";
import {
  setAccommodationPhotosSelectionBackoffice,
  setAccommodationPhotosSelectionClient,
  setPhotoSelectionBackoffice,
  setPhotoSelectionClient,
} from "./actions";

/**
 * Proves each bundle is wired to the CORRECT scope-hardcoded function
 * reference — never the other space's, and never a plain string "scope"
 * field a component could read/forward. PhotosManager.tsx only ever calls
 * `actions.xyz(...)`; this test is what guarantees `actions.xyz` really is
 * the right hardcoded-scope function.
 */
describe("PHOTO_ACTIONS_BACKOFFICE", () => {
  it("every entry is the *Backoffice function, by reference identity", () => {
    expect(PHOTO_ACTIONS_BACKOFFICE.setPhotoSelection).toBe(setPhotoSelectionBackoffice);
    expect(PHOTO_ACTIONS_BACKOFFICE.setAccommodationPhotosSelection).toBe(setAccommodationPhotosSelectionBackoffice);
  });

  it("no entry is a *Client function", () => {
    expect(PHOTO_ACTIONS_BACKOFFICE.setPhotoSelection).not.toBe(setPhotoSelectionClient);
    expect(PHOTO_ACTIONS_BACKOFFICE.setAccommodationPhotosSelection).not.toBe(setAccommodationPhotosSelectionClient);
  });

  it("no `scope` field anywhere on the bundle", () => {
    expect(PHOTO_ACTIONS_BACKOFFICE).not.toHaveProperty("scope");
  });
});

describe("PHOTO_ACTIONS_CLIENT", () => {
  it("every entry is the *Client function, by reference identity", () => {
    expect(PHOTO_ACTIONS_CLIENT.setPhotoSelection).toBe(setPhotoSelectionClient);
    expect(PHOTO_ACTIONS_CLIENT.setAccommodationPhotosSelection).toBe(setAccommodationPhotosSelectionClient);
  });

  it("no entry is a *Backoffice function", () => {
    expect(PHOTO_ACTIONS_CLIENT.setPhotoSelection).not.toBe(setPhotoSelectionBackoffice);
    expect(PHOTO_ACTIONS_CLIENT.setAccommodationPhotosSelection).not.toBe(setAccommodationPhotosSelectionBackoffice);
  });

  it("no `scope` field anywhere on the bundle", () => {
    expect(PHOTO_ACTIONS_CLIENT).not.toHaveProperty("scope");
  });
});
