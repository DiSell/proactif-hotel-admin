import { afterEach, describe, expect, it, vi } from "vitest";

// vi.stubEnv/unstubAllEnvs, not direct process.env.NODE_ENV assignment —
// Next.js 16's own ambient types mark NODE_ENV readonly on ProcessEnv,
// so a plain assignment fails `tsc --noEmit` even though it works at
// runtime. vi.stubEnv is the typed, Vitest-native way to do this and
// restores cleanly regardless.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("currentOrigin", () => {
  it("[SITE_URL set] returns it verbatim, trailing slash trimmed — never derived from any request header", async () => {
    vi.stubEnv("SITE_URL", "https://admin.proactifsystem.fr/");
    const { currentOrigin } = await import("./currentOrigin");
    expect(await currentOrigin()).toBe("https://admin.proactifsystem.fr");
  });

  it("[SITE_URL unset, development] falls back to http://localhost:3000 by default", async () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PORT", "");
    const { currentOrigin } = await import("./currentOrigin");
    expect(await currentOrigin()).toBe("http://localhost:3000");
  });

  it("[SITE_URL unset, development, custom PORT] honors PORT", async () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PORT", "4000");
    const { currentOrigin } = await import("./currentOrigin");
    expect(await currentOrigin()).toBe("http://localhost:4000");
  });

  it("[SITE_URL unset, production] throws — never silently falls back to something guessed from the request", async () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const { currentOrigin } = await import("./currentOrigin");
    await expect(currentOrigin()).rejects.toThrow(/SITE_URL is not set/);
  });

  it("[never reads request headers] the module never imports next/headers — the fix for the Host-header trust issue is structural, not a runtime check", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "currentOrigin.ts"), "utf8");
    expect(source).not.toMatch(/next\/headers/);
    expect(source).not.toMatch(/headersList\.get\("host"\)/);
  });
});
