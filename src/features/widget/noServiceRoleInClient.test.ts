import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "../../"); // src/

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Repo-wide security regression guard: the service-role client
 * (lib/supabase/admin.ts, createAdminClient) bypasses RLS entirely and must
 * never be reachable from code that ships to the browser. A "use client"
 * component importing it — even transitively via a re-export — would bundle
 * a service-role-capable code path into client JS. This scans every real
 * source file under src/ (excluding tests) for the combination of a "use
 * client" directive and any reference to the admin client / its secret env
 * var name.
 */
describe("service-role client — never referenced from a client component", () => {
  const files = collectSourceFiles(srcRoot);
  const clientComponentFiles = files.filter((path) => {
    const content = readFileSync(path, "utf8");
    return /^\s*["']use client["'];?\s*$/m.test(content.split("\n").slice(0, 5).join("\n"));
  });

  it("sanity check — this scan actually found client components to check (a zero-file result would make every assertion below vacuous)", () => {
    expect(clientComponentFiles.length).toBeGreaterThan(0);
  });

  it("no 'use client' file imports createAdminClient / lib/supabase/admin", () => {
    const offenders = clientComponentFiles.filter((path) => {
      const content = readFileSync(path, "utf8");
      return /createAdminClient/.test(content) || /lib\/supabase\/admin/.test(content);
    });
    expect(offenders).toEqual([]);
  });

  it("no 'use client' file references the service-role env var name", () => {
    const offenders = clientComponentFiles.filter((path) => {
      const content = readFileSync(path, "utf8");
      return /SUPABASE_SERVICE_ROLE_KEY/.test(content);
    });
    expect(offenders).toEqual([]);
  });

  it("PublicWidgetChat.tsx specifically never touches Supabase at all — it only calls the public fetch API", () => {
    const path = join(srcRoot, "features/widget/PublicWidgetChat.tsx");
    const content = readFileSync(path, "utf8");
    expect(content).toMatch(/^"use client";/);
    expect(content).not.toMatch(/supabase/i);
    expect(content).toMatch(/fetch\(`\/api\/widget\//);
  });
});
