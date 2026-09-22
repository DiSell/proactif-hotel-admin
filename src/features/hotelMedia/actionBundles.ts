// Deliberately NOT a "use server" file — see features/photos/actionBundles.ts's
// own comment for why (Next.js only allows async function exports from a
// "use server" file). This is the shape HotelMediaManager.tsx receives as a
// prop — never a `scope` string, so the component itself never has to
// choose which Server Action to call.
import {
  addHotelMediaPhotoBackoffice,
  addHotelMediaPhotoClient,
  setHotelMediaSelectionBackoffice,
  setHotelMediaSelectionClient,
} from "./actions";
import type { ActionResult } from "@/lib/actionResult";

export interface HotelMediaActions {
  setSelection: (hotelId: string, photoId: string, isSelected: boolean) => Promise<ActionResult<null>>;
  addPhoto: (hotelId: string, input: unknown) => Promise<ActionResult<{ id: string }>>;
}

export const HOTEL_MEDIA_ACTIONS_BACKOFFICE: HotelMediaActions = {
  setSelection: setHotelMediaSelectionBackoffice,
  addPhoto: addHotelMediaPhotoBackoffice,
};

export const HOTEL_MEDIA_ACTIONS_CLIENT: HotelMediaActions = {
  setSelection: setHotelMediaSelectionClient,
  addPhoto: addHotelMediaPhotoClient,
};
