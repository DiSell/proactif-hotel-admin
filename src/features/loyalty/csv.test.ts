import { describe, expect, it } from "vitest";
import { previewCsv, readCsv } from "./csv";

const mapping = { first_name: "Prénom", last_name: "Nom", email: "Mail client", check_in: "Arrivée", check_out: "Départ", external_reference: "Référence" } as const;

describe("loyalty CSV import", () => {
  it("reads a valid mapped CSV without assuming column names", () => {
    const csv = "Prénom;Nom;Mail client;Arrivée;Départ;Référence\nAlice;Martin;alice@example.com;2026-01-01;2026-01-03;R-1";
    expect(readCsv(csv).headers).toContain("Mail client");
    expect(previewCsv(csv, mapping)[0]).toMatchObject({ errors: [], probableDuplicate: false, values: { email: "alice@example.com", check_out: "2026-01-03" } });
  });

  it("reports invalid email and dates", () => {
    const row = previewCsv("Prénom;Nom;Mail client;Arrivée;Départ;Référence\nA;B;bad;nope;2025-01-01;X", mapping)[0];
    expect(row.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("flags probable duplicates without merging them", () => {
    const rows = previewCsv("Prénom;Nom;Mail client;Arrivée;Départ;Référence\nA;B;a@b.fr;;;1\nA;B;a@b.fr;;;2", mapping);
    expect(rows[0].probableDuplicate).toBe(false);
    expect(rows[1].probableDuplicate).toBe(true);
  });
});

