import { describe, expect, it } from "vitest";
import {
  PARTNER_REQUEST_ACTOR_LABELS,
  PARTNER_REQUEST_EVENT_LABELS,
  PARTNER_REQUEST_FILTERS,
  PARTNER_REQUEST_STATUS_LABELS,
  formatPartnerRequestCreatedAt,
  formatPartnerRequestDate,
  formatPartnerRequestTime,
  matchesPartnerRequestFilter,
  statusBadgeTone,
} from "./presentation";
import type { PartnerRequestActorType, PartnerRequestEventType, PartnerRequestStatus } from "./types";

const ALL_STATUSES: PartnerRequestStatus[] = [
  "draft", "pending_confirmation", "sent_to_partner", "accepted", "rejected", "alternative_proposed", "cancelled",
];

const ALL_EVENT_TYPES: PartnerRequestEventType[] = [
  "request_created", "guest_confirmation_requested", "guest_confirmed", "sent_to_partner",
  "partner_delivery_failed", "partner_accepted", "partner_rejected", "partner_alternative_proposed",
  "guest_accepted_alternative", "guest_rejected_alternative", "guest_notification_sent",
  "guest_notification_failed", "cancelled",
];

const ALL_ACTOR_TYPES: PartnerRequestActorType[] = ["guest", "partner", "hotel", "system"];

describe("PARTNER_REQUEST_STATUS_LABELS", () => {
  it("[exhaustive] every one of the 7 statuses has a readable label", () => {
    expect(ALL_STATUSES).toHaveLength(7);
    for (const status of ALL_STATUSES) {
      expect(PARTNER_REQUEST_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("[exact labels] match the wording specified by the request", () => {
    expect(PARTNER_REQUEST_STATUS_LABELS.draft).toBe("Brouillon");
    expect(PARTNER_REQUEST_STATUS_LABELS.pending_confirmation).toBe("En attente de confirmation client");
    expect(PARTNER_REQUEST_STATUS_LABELS.sent_to_partner).toBe("Envoyée au partenaire");
    expect(PARTNER_REQUEST_STATUS_LABELS.accepted).toBe("Acceptée");
    expect(PARTNER_REQUEST_STATUS_LABELS.rejected).toBe("Refusée");
    expect(PARTNER_REQUEST_STATUS_LABELS.alternative_proposed).toBe("Alternative proposée");
    expect(PARTNER_REQUEST_STATUS_LABELS.cancelled).toBe("Annulée");
  });
});

describe("PARTNER_REQUEST_EVENT_LABELS", () => {
  it("[exhaustive] every one of the 13 event types has a readable label", () => {
    expect(ALL_EVENT_TYPES).toHaveLength(13);
    for (const eventType of ALL_EVENT_TYPES) {
      expect(PARTNER_REQUEST_EVENT_LABELS[eventType]).toBeTruthy();
    }
  });
});

describe("PARTNER_REQUEST_ACTOR_LABELS", () => {
  it("[exhaustive] every actor type has a readable label", () => {
    for (const actor of ALL_ACTOR_TYPES) {
      expect(PARTNER_REQUEST_ACTOR_LABELS[actor]).toBeTruthy();
    }
  });
});

describe("PARTNER_REQUEST_FILTERS / matchesPartnerRequestFilter", () => {
  it("[4 filters, MVP] exactly Toutes / En attente / Acceptées / Refusées / annulées", () => {
    expect(PARTNER_REQUEST_FILTERS.map((f) => f.key)).toEqual(["all", "pending", "accepted", "declined"]);
  });

  it("[all] matches every status", () => {
    for (const status of ALL_STATUSES) {
      expect(matchesPartnerRequestFilter(status, "all")).toBe(true);
    }
  });

  it("[accepted] matches only accepted", () => {
    for (const status of ALL_STATUSES) {
      expect(matchesPartnerRequestFilter(status, "accepted")).toBe(status === "accepted");
    }
  });

  it("[declined] matches rejected and cancelled, nothing else", () => {
    for (const status of ALL_STATUSES) {
      expect(matchesPartnerRequestFilter(status, "declined")).toBe(status === "rejected" || status === "cancelled");
    }
  });

  it("[pending] matches draft/pending_confirmation/sent_to_partner/alternative_proposed, and no others", () => {
    const expectedPending: PartnerRequestStatus[] = ["draft", "pending_confirmation", "sent_to_partner", "alternative_proposed"];
    for (const status of ALL_STATUSES) {
      expect(matchesPartnerRequestFilter(status, "pending")).toBe(expectedPending.includes(status));
    }
  });

  it("[every status falls into exactly one of pending/accepted/declined]", () => {
    for (const status of ALL_STATUSES) {
      const buckets = (["pending", "accepted", "declined"] as const).filter((filter) => matchesPartnerRequestFilter(status, filter));
      expect(buckets).toHaveLength(1);
    }
  });
});

describe("statusBadgeTone", () => {
  it("[covers all 7 statuses without throwing]", () => {
    for (const status of ALL_STATUSES) {
      expect(() => statusBadgeTone(status)).not.toThrow();
    }
  });

  it("[semantic tones] accepted=success, rejected/cancelled=danger, draft=neutral", () => {
    expect(statusBadgeTone("accepted")).toBe("success");
    expect(statusBadgeTone("rejected")).toBe("danger");
    expect(statusBadgeTone("cancelled")).toBe("danger");
    expect(statusBadgeTone("draft")).toBe("neutral");
  });
});

describe("formatting helpers", () => {
  it("[formatPartnerRequestDate] null renders as an em dash, never a fake date", () => {
    expect(formatPartnerRequestDate(null)).toBe("—");
  });

  it("[formatPartnerRequestDate] a real ISO date is formatted in French, not left as YYYY-MM-DD", () => {
    const formatted = formatPartnerRequestDate("2026-09-01");
    expect(formatted).not.toBe("2026-09-01");
    expect(formatted).toMatch(/2026/);
  });

  it("[formatPartnerRequestTime] free text is shown verbatim, never reparsed", () => {
    expect(formatPartnerRequestTime("vers 20h")).toBe("vers 20h");
    expect(formatPartnerRequestTime(null)).toBe("—");
  });

  it("[formatPartnerRequestCreatedAt] renders a non-empty date+time string", () => {
    expect(formatPartnerRequestCreatedAt("2026-08-24T10:30:00Z")).toMatch(/2026/);
  });
});
