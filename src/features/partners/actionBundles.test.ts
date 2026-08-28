import { describe, expect, it } from "vitest";
import {
  PARTNER_ACTIONS_BACKOFFICE,
  PARTNER_ACTIONS_CLIENT,
} from "./actionBundles";
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

/**
 * Proves each bundle is wired to the CORRECT scope-hardcoded function
 * reference — never the other space's, and never a plain string "scope"
 * field a component could read/forward. PartnersManager.tsx/
 * PartnerFormModal.tsx only ever call `actions.xyz(...)`; this test is what
 * guarantees `actions.xyz` really is the right hardcoded-scope function.
 *
 * requestPartnerConsents is the SINGLE unified send action — there is
 * deliberately no separate requestPartnerConsent/requestPartnerTransactionalConsent
 * pair any more, matching PartnerFormModal.tsx's own single button.
 */
describe("PARTNER_ACTIONS_BACKOFFICE", () => {
  it("every entry is the *Backoffice function, by reference identity — not a lookalike, not the *Client one", () => {
    expect(PARTNER_ACTIONS_BACKOFFICE.createHotelPartner).toBe(createHotelPartnerBackoffice);
    expect(PARTNER_ACTIONS_BACKOFFICE.updateHotelPartner).toBe(updateHotelPartnerBackoffice);
    expect(PARTNER_ACTIONS_BACKOFFICE.setHotelPartnerActive).toBe(setHotelPartnerActiveBackoffice);
    expect(PARTNER_ACTIONS_BACKOFFICE.deleteHotelPartner).toBe(deleteHotelPartnerBackoffice);
    expect(PARTNER_ACTIONS_BACKOFFICE.fetchPartnerWebsiteSummary).toBe(fetchPartnerWebsiteSummaryBackoffice);
    expect(PARTNER_ACTIONS_BACKOFFICE.requestPartnerConsents).toBe(requestPartnerConsentsBackoffice);
  });

  it("no entry is a *Client function", () => {
    expect(PARTNER_ACTIONS_BACKOFFICE.createHotelPartner).not.toBe(createHotelPartnerClient);
    expect(PARTNER_ACTIONS_BACKOFFICE.updateHotelPartner).not.toBe(updateHotelPartnerClient);
    expect(PARTNER_ACTIONS_BACKOFFICE.setHotelPartnerActive).not.toBe(setHotelPartnerActiveClient);
    expect(PARTNER_ACTIONS_BACKOFFICE.deleteHotelPartner).not.toBe(deleteHotelPartnerClient);
    expect(PARTNER_ACTIONS_BACKOFFICE.fetchPartnerWebsiteSummary).not.toBe(fetchPartnerWebsiteSummaryClient);
    expect(PARTNER_ACTIONS_BACKOFFICE.requestPartnerConsents).not.toBe(requestPartnerConsentsClient);
  });

  it("no `scope` field anywhere on the bundle — there is nothing for a component to read or forward", () => {
    expect(PARTNER_ACTIONS_BACKOFFICE).not.toHaveProperty("scope");
  });

  it("no separate requestPartnerConsent/requestPartnerTransactionalConsent entries — one unified action only", () => {
    expect(PARTNER_ACTIONS_BACKOFFICE).not.toHaveProperty("requestPartnerConsent");
    expect(PARTNER_ACTIONS_BACKOFFICE).not.toHaveProperty("requestPartnerTransactionalConsent");
  });
});

describe("PARTNER_ACTIONS_CLIENT", () => {
  it("every entry is the *Client function, by reference identity — not the *Backoffice one", () => {
    expect(PARTNER_ACTIONS_CLIENT.createHotelPartner).toBe(createHotelPartnerClient);
    expect(PARTNER_ACTIONS_CLIENT.updateHotelPartner).toBe(updateHotelPartnerClient);
    expect(PARTNER_ACTIONS_CLIENT.setHotelPartnerActive).toBe(setHotelPartnerActiveClient);
    expect(PARTNER_ACTIONS_CLIENT.deleteHotelPartner).toBe(deleteHotelPartnerClient);
    expect(PARTNER_ACTIONS_CLIENT.fetchPartnerWebsiteSummary).toBe(fetchPartnerWebsiteSummaryClient);
    expect(PARTNER_ACTIONS_CLIENT.requestPartnerConsents).toBe(requestPartnerConsentsClient);
  });

  it("no entry is a *Backoffice function", () => {
    expect(PARTNER_ACTIONS_CLIENT.createHotelPartner).not.toBe(createHotelPartnerBackoffice);
    expect(PARTNER_ACTIONS_CLIENT.updateHotelPartner).not.toBe(updateHotelPartnerBackoffice);
    expect(PARTNER_ACTIONS_CLIENT.setHotelPartnerActive).not.toBe(setHotelPartnerActiveBackoffice);
    expect(PARTNER_ACTIONS_CLIENT.deleteHotelPartner).not.toBe(deleteHotelPartnerBackoffice);
    expect(PARTNER_ACTIONS_CLIENT.fetchPartnerWebsiteSummary).not.toBe(fetchPartnerWebsiteSummaryBackoffice);
    expect(PARTNER_ACTIONS_CLIENT.requestPartnerConsents).not.toBe(requestPartnerConsentsBackoffice);
  });

  it("no `scope` field anywhere on the bundle", () => {
    expect(PARTNER_ACTIONS_CLIENT).not.toHaveProperty("scope");
  });

  it("no separate requestPartnerConsent/requestPartnerTransactionalConsent entries — one unified action only", () => {
    expect(PARTNER_ACTIONS_CLIENT).not.toHaveProperty("requestPartnerConsent");
    expect(PARTNER_ACTIONS_CLIENT).not.toHaveProperty("requestPartnerTransactionalConsent");
  });
});
