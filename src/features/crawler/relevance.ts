import { RELEVANCE_KEYWORDS } from "./config";

export interface ClassifyRelevanceInput {
  url: string;
  title: string;
  headings: string[];
}

export interface RelevanceResult {
  matchedCategories: string[];
  score: number;
}

/**
 * Keyword-based PRIORITIZATION signal only — matching "spa" in a URL or
 * title never means the hotel has a spa, only that the page is worth
 * surfacing/pre-checking for a human to judge. The actual page content is
 * what gets indexed, never an assumption derived from this score.
 */
export function classifyPageRelevance({ url, title, headings }: ClassifyRelevanceInput): RelevanceResult {
  const haystack = [url, title, ...headings].join(" ").toLowerCase();
  const matchedCategories: string[] = [];

  for (const [category, keywords] of Object.entries(RELEVANCE_KEYWORDS)) {
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      matchedCategories.push(category);
    }
  }

  return { matchedCategories, score: matchedCategories.length };
}

/** Purely structural — the homepage is always worth reviewing regardless of keyword matches. */
export function isHomepage(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path === "/" || path === "";
  } catch {
    return false;
  }
}

const TECHNICAL_ONLY_KEYWORDS = [
  "mentions-legales", "mentions légales", "privacy", "confidentialite", "confidentialité",
  "cookies", "plan-du-site", "sitemap", "legal-notice", "terms-of-service", "aviso-legal",
];

/** A page that only matches boilerplate-legal keywords, with no hotel-relevance signal at all, is probably not worth indexing by default. */
export function looksTechnicalOnly(url: string, title: string, relevanceScore: number): boolean {
  if (relevanceScore > 0) return false;
  const haystack = `${url} ${title}`.toLowerCase();
  return TECHNICAL_ONLY_KEYWORDS.some((keyword) => haystack.includes(keyword));
}
