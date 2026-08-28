// Deliberately NOT a "use server" file — Next.js only allows async function
// exports from one of those (see actions.ts's own doc comment), and these
// are plain objects bundling function references together. This is the
// shape PartnersManager.tsx/PartnerFormModal.tsx actually receive as a
// prop — never a `scope` string. A page hands in EITHER
// PARTNER_ACTIONS_BACKOFFICE or PARTNER_ACTIONS_CLIENT; the components
// themselves stay scope-agnostic, simply invoking whichever function
// reference they were given.
import {
  createHotelPartnerBackoffice,
  createHotelPartnerClient,
  deleteHotelPartnerBackoffice,
  deleteHotelPartnerClient,
  fetchPartnerWebsiteSummaryBackoffice,
  fetchPartnerWebsiteSummaryClient,
  requestPartnerConsentsBackoffice,
  requestPartnerConsentsClient,
  setHotelPartnerActiveBackoffice,
  setHotelPartnerActiveClient,
  updateHotelPartnerBackoffice,
  updateHotelPartnerClient,
} from "./actions";
import type { HotelPartnerInput } from "./schema";
import type { ActionResult } from "@/lib/actionResult";

export interface PartnerActions {
  createHotelPartner: (hotelId: string, input: HotelPartnerInput) => Promise<ActionResult<{ id: string }>>;
  updateHotelPartner: (hotelId: string, partnerId: string, input: HotelPartnerInput) => Promise<ActionResult<null>>;
  setHotelPartnerActive: (hotelId: string, partnerId: string, isActive: boolean) => Promise<ActionResult<null>>;
  deleteHotelPartner: (hotelId: string, partnerId: string) => Promise<ActionResult<null>>;
  fetchPartnerWebsiteSummary: (
    hotelId: string,
    url: string
  ) => Promise<ActionResult<{ description: string; address: string | null; openingHours: string | null }>>;
  /**
   * Sends the SINGLE partner consent email covering both independent
   * authorizations (chatbot recommendation + transactional WhatsApp) — see
   * actions.ts's own doc comment on requestPartnerConsentsInternal. There
   * is deliberately no separate "requestPartnerTransactionalConsent" entry
   * any more: one user action, one email, one link.
   */
  requestPartnerConsents: (hotelId: string, partnerId: string) => Promise<ActionResult<null>>;
}

export const PARTNER_ACTIONS_BACKOFFICE: PartnerActions = {
  createHotelPartner: createHotelPartnerBackoffice,
  updateHotelPartner: updateHotelPartnerBackoffice,
  setHotelPartnerActive: setHotelPartnerActiveBackoffice,
  deleteHotelPartner: deleteHotelPartnerBackoffice,
  fetchPartnerWebsiteSummary: fetchPartnerWebsiteSummaryBackoffice,
  requestPartnerConsents: requestPartnerConsentsBackoffice,
};

export const PARTNER_ACTIONS_CLIENT: PartnerActions = {
  createHotelPartner: createHotelPartnerClient,
  updateHotelPartner: updateHotelPartnerClient,
  setHotelPartnerActive: setHotelPartnerActiveClient,
  deleteHotelPartner: deleteHotelPartnerClient,
  fetchPartnerWebsiteSummary: fetchPartnerWebsiteSummaryClient,
  requestPartnerConsents: requestPartnerConsentsClient,
};
