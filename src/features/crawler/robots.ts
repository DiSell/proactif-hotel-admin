import { safeFetch } from "./networkGuard";

export interface RobotsRule {
  path: string;
  allow: boolean;
}

export interface RobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  groups: RobotsGroup[];
  sitemaps: string[];
}

const EMPTY_RULES: RobotsRules = { groups: [], sitemaps: [] };

/**
 * Minimal robots.txt parser — group by consecutive User-agent: lines,
 * Disallow:/Allow: rules attach to the group currently being defined,
 * Sitemap: lines are collected regardless of which group they appear near.
 * Deliberately simple: plain prefix matching, no `*`/`$` wildcard support —
 * enough for the directory-style Disallow rules real hotel sites use.
 */
export function parseRobotsTxt(content: string): RobotsRules {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);

  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let acceptingUserAgents = false;

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (key === "user-agent") {
      if (!current || !acceptingUserAgents) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
        acceptingUserAgents = true;
      }
      current.userAgents.push(value.toLowerCase());
    } else if (key === "disallow") {
      acceptingUserAgents = false;
      if (current && value !== "") current.rules.push({ path: value, allow: false });
    } else if (key === "allow") {
      acceptingUserAgents = false;
      if (current) current.rules.push({ path: value, allow: true });
    } else if (key === "sitemap" && value) {
      sitemaps.push(value);
    } else {
      acceptingUserAgents = false;
    }
  }

  return { groups, sitemaps };
}

function userAgentSpecificity(groupUserAgents: string[], userAgent: string): 0 | 1 | 2 {
  const uaLower = userAgent.toLowerCase();
  let best: 0 | 1 | 2 = 0;
  for (const candidate of groupUserAgents) {
    if (candidate === "*") best = Math.max(best, 1) as 0 | 1 | 2;
    else if (uaLower.includes(candidate)) best = Math.max(best, 2) as 0 | 1 | 2;
  }
  return best;
}

/**
 * True if `path` may be fetched by `userAgent` under these rules. Picks the
 * most specific applicable group (an exact product-token match beats `*`),
 * then within it the longest matching rule path; a tie between an Allow and
 * a Disallow of equal length is won by Allow, per the de facto standard. No
 * applicable group, or no matching rule, means allowed.
 */
export function isPathAllowed(rules: RobotsRules, userAgent: string, path: string): boolean {
  let bestGroup: RobotsGroup | null = null;
  let bestSpecificity = 0;
  for (const group of rules.groups) {
    const specificity = userAgentSpecificity(group.userAgents, userAgent);
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestGroup = group;
    }
  }
  if (!bestGroup) return true;

  let bestMatch: RobotsRule | null = null;
  for (const rule of bestGroup.rules) {
    if (!path.startsWith(rule.path)) continue;
    if (!bestMatch || rule.path.length > bestMatch.path.length) {
      bestMatch = rule;
    } else if (rule.path.length === bestMatch.path.length && rule.allow && !bestMatch.allow) {
      bestMatch = rule;
    }
  }

  return bestMatch ? bestMatch.allow : true;
}

/**
 * Fetches and parses /robots.txt for a site. A missing or unreachable
 * robots.txt is treated as "no restrictions" — the standard convention —
 * never as a reason to fail the whole analysis.
 */
export async function fetchRobotsRules(websiteUrl: string): Promise<RobotsRules> {
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", websiteUrl).toString();
  } catch {
    return EMPTY_RULES;
  }

  const result = await safeFetch(robotsUrl);
  if (!result.ok || !result.body) return EMPTY_RULES;
  return parseRobotsTxt(result.body);
}
