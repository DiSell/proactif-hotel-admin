import { describe, expect, it } from "vitest";
import { canTransition, isTerminalStatus, statusesThatCanReachAccepted, transition, TERMINAL_STATUSES } from "./stateMachine";
import type { PartnerRequestStatus } from "./types";

const ALL_STATUSES: PartnerRequestStatus[] = [
  "draft",
  "pending_confirmation",
  "sent_to_partner",
  "accepted",
  "rejected",
  "alternative_proposed",
  "cancelled",
];

describe("canTransition — allowed transitions", () => {
  it.each([
    ["draft", "pending_confirmation"],
    ["pending_confirmation", "sent_to_partner"],
    ["pending_confirmation", "cancelled"],
    ["sent_to_partner", "accepted"],
    ["sent_to_partner", "rejected"],
    ["sent_to_partner", "alternative_proposed"],
    ["sent_to_partner", "cancelled"],
    ["alternative_proposed", "sent_to_partner"],
    ["alternative_proposed", "cancelled"],
  ] as [PartnerRequestStatus, PartnerRequestStatus][])("%s → %s is allowed", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });
});

describe("canTransition — forbidden transitions", () => {
  it.each([
    // The one rule explicitly called out as non-negotiable: no direct
    // alternative_proposed -> accepted. accepted must always come from a
    // real, final, retransmitted confirmation via sent_to_partner.
    ["alternative_proposed", "accepted"],
    ["alternative_proposed", "rejected"],
    // draft can only ever move forward one step at a time.
    ["draft", "sent_to_partner"],
    ["draft", "accepted"],
    ["draft", "cancelled"],
    // pending_confirmation cannot skip straight to a partner decision.
    ["pending_confirmation", "accepted"],
    ["pending_confirmation", "rejected"],
    ["pending_confirmation", "alternative_proposed"],
    // Terminal states never transition anywhere, including to themselves.
    ["accepted", "accepted"],
    ["accepted", "sent_to_partner"],
    ["accepted", "cancelled"],
    ["rejected", "accepted"],
    ["rejected", "sent_to_partner"],
    ["rejected", "cancelled"],
    ["cancelled", "draft"],
    ["cancelled", "sent_to_partner"],
    ["cancelled", "accepted"],
    // No going backwards.
    ["sent_to_partner", "draft"],
    ["sent_to_partner", "pending_confirmation"],
  ] as [PartnerRequestStatus, PartnerRequestStatus][])("%s → %s is forbidden", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("[exhaustive] every status pair not explicitly allowed above is forbidden", () => {
    const allowed = new Set<string>();
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (canTransition(from, to)) allowed.add(`${from}->${to}`);
      }
    }
    expect([...allowed].sort()).toEqual(
      [
        "draft->pending_confirmation",
        "pending_confirmation->sent_to_partner",
        "pending_confirmation->cancelled",
        "sent_to_partner->accepted",
        "sent_to_partner->rejected",
        "sent_to_partner->alternative_proposed",
        "sent_to_partner->cancelled",
        "alternative_proposed->sent_to_partner",
        "alternative_proposed->cancelled",
      ].sort()
    );
  });
});

describe("[non-negotiable rule] accepted is reachable ONLY from sent_to_partner", () => {
  it("statusesThatCanReachAccepted() returns exactly [sent_to_partner]", () => {
    expect(statusesThatCanReachAccepted()).toEqual(["sent_to_partner"]);
  });

  it("no status other than sent_to_partner can ever transition to accepted, checked exhaustively", () => {
    for (const status of ALL_STATUSES) {
      if (status === "sent_to_partner") continue;
      expect(canTransition(status, "accepted"), `${status} -> accepted must be false`).toBe(false);
    }
  });
});

describe("[alternative flow] guest accepting an alternative re-enters sent_to_partner, never accepted directly", () => {
  it("alternative_proposed -> sent_to_partner is the only positive path forward", () => {
    expect(canTransition("alternative_proposed", "sent_to_partner")).toBe(true);
    expect(canTransition("alternative_proposed", "accepted")).toBe(false);
  });

  it("alternative_proposed -> cancelled is the guest-refuses path", () => {
    expect(canTransition("alternative_proposed", "cancelled")).toBe(true);
  });
});

describe("transition()", () => {
  it("[allowed] returns { ok: true }, no error", () => {
    expect(transition("draft", "pending_confirmation")).toEqual({ ok: true });
  });

  it("[forbidden] returns { ok: false } with a human-readable reason naming both states", () => {
    const result = transition("alternative_proposed", "accepted");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/alternative_proposed/);
    expect(result.error).toMatch(/accepted/);
  });
});

describe("isTerminalStatus / TERMINAL_STATUSES", () => {
  it("[terminal] accepted, rejected, cancelled have no outgoing transitions and are flagged terminal", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
      for (const target of ALL_STATUSES) {
        expect(canTransition(status, target)).toBe(false);
      }
    }
  });

  it("[non-terminal] draft, pending_confirmation, sent_to_partner, alternative_proposed are not terminal", () => {
    for (const status of ["draft", "pending_confirmation", "sent_to_partner", "alternative_proposed"] as PartnerRequestStatus[]) {
      expect(isTerminalStatus(status)).toBe(false);
    }
  });
});
