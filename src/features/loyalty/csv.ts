import { customerInputSchema } from "./schema";

export const CSV_FIELDS = ["first_name", "last_name", "email", "phone", "check_in", "check_out", "external_reference"] as const;
export type CsvField = (typeof CSV_FIELDS)[number];
export type CsvMapping = Partial<Record<CsvField, string>>;

export interface CsvPreviewRow {
  rowNumber: number;
  values: Partial<Record<CsvField, string>>;
  errors: string[];
  probableDuplicate: boolean;
}

function detectDelimiter(line: string): string {
  const candidates = [";", ",", "\t"];
  return candidates.sort((a, b) => line.split(b).length - line.split(a).length)[0];
}

export function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

export function readCsv(csvText: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { headers: lines[0] ? [lines[0]] : [], rows: [] };
  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter);
  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
  return { headers, rows };
}

function validDate(value: string | undefined): boolean {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function previewCsv(csvText: string, mapping: CsvMapping): CsvPreviewRow[] {
  const { rows } = readCsv(csvText);
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const values = Object.fromEntries(CSV_FIELDS.map((field) => [field, mapping[field] ? row[mapping[field]!] ?? "" : ""])) as Partial<Record<CsvField, string>>;
    const errors: string[] = [];
    const customer = customerInputSchema.safeParse({ firstName: values.first_name, lastName: values.last_name, email: values.email, phone: values.phone, externalReference: values.external_reference });
    if (!customer.success) errors.push("Coordonnées client invalides");
    if (!validDate(values.check_in)) errors.push("Date d’arrivée invalide (AAAA-MM-JJ attendu)");
    if (!validDate(values.check_out)) errors.push("Date de départ invalide (AAAA-MM-JJ attendu)");
    if (values.check_in && values.check_out && values.check_out < values.check_in) errors.push("Départ antérieur à l’arrivée");
    const duplicateKey = (values.email || values.external_reference || `${values.first_name}|${values.last_name}|${values.phone}`).trim().toLowerCase();
    const probableDuplicate = Boolean(duplicateKey && seen.has(duplicateKey));
    if (duplicateKey) seen.add(duplicateKey);
    return { rowNumber: index + 2, values, errors, probableDuplicate };
  });
}

