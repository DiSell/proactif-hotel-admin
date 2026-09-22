// Deliberately NOT a "use server" file — see features/photos/actionBundles.ts's
// own comment for why (Next.js only allows async function exports from a
// "use server" file). This is the shape HotelMediaManager.tsx receives as a
// prop — never a `scope` string. Only the selection toggle is bundled here:
// addHotelMediaPhoto is superadmin-only regardless of which page renders
// the component, so it is imported directly, never scope-bundled.
import { setHotelMediaSelectionBackoffice, setHotelMediaSelectionClient } from "./actions";
import type { ActionResult } from "@/lib/actionResult";

export interface HotelMediaActions {
  setSelection: (hotelId: string, photoId: string, isSelected: boolean) => Promise<ActionResult<null>>;
}

export const HOTEL_MEDIA_ACTIONS_BACKOFFICE: HotelMediaActions = {
  setSelection: setHotelMediaSelectionBackoffice,
};

export const HOTEL_MEDIA_ACTIONS_CLIENT: HotelMediaActions = {
  setSelection: setHotelMediaSelectionClient,
};
