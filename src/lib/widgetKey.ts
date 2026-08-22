import { randomBytes } from "node:crypto";

/**
 * Public identifier embedded in the widget snippet — not a secret, just
 * needs to be unique and hard to guess/enumerate.
 */
export function generateWidgetKey(): string {
  return `ps_live_${randomBytes(18).toString("base64url")}`;
}

const DIACRITICS = /[̀-ͯ]/g; // combining marks left behind by NFD normalization

export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
