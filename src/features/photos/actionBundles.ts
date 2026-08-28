// Deliberately NOT a "use server" file — see features/partners/actionBundles.ts's
// own comment for why (Next.js only allows async function exports from a
// "use server" file). This is the shape PhotosManager.tsx actually receives
// as a prop — never a `scope` string.
import {
  setAccommodationPhotosSelectionBackoffice,
  setAccommodationPhotosSelectionClient,
  setPhotoSelectionBackoffice,
  setPhotoSelectionClient,
} from "./actions";
import type { ActionResult } from "@/lib/actionResult";

export interface PhotoActions {
  setPhotoSelection: (hotelId: string, photoId: string, isSelected: boolean) => Promise<ActionResult<null>>;
  setAccommodationPhotosSelection: (hotelId: string, accommodationTypeId: string, isSelected: boolean) => Promise<ActionResult<null>>;
}

export const PHOTO_ACTIONS_BACKOFFICE: PhotoActions = {
  setPhotoSelection: setPhotoSelectionBackoffice,
  setAccommodationPhotosSelection: setAccommodationPhotosSelectionBackoffice,
};

export const PHOTO_ACTIONS_CLIENT: PhotoActions = {
  setPhotoSelection: setPhotoSelectionClient,
  setAccommodationPhotosSelection: setAccommodationPhotosSelectionClient,
};
