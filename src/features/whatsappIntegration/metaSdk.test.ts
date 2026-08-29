import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMetaSdkLoaderForTests, loadMetaSdk, META_SDK_SRC, type MetaSdkEnvironment } from "./metaSdk";

/** A minimal, DOM-free fake of the two browser objects this loader touches — no jsdom needed (this repo's vitest environment is "node"). */
function fakeEnvironment(): MetaSdkEnvironment & { scripts: { id: string; src: string; onerror?: () => void }[] } {
  const scripts: { id: string; src: string; onerror?: () => void }[] = [];

  const env: MetaSdkEnvironment & { scripts: typeof scripts } = {
    window: {},
    document: {
      createElement: () => {
        const el = { id: "", src: "", onerror: undefined as (() => void) | undefined };
        return el as unknown as HTMLScriptElement;
      },
      head: {
        appendChild: <T extends Node>(node: T): T => {
          scripts.push(node as unknown as { id: string; src: string; onerror?: () => void });
          return node;
        },
      },
    },
    scripts,
  };
  return env;
}

beforeEach(() => {
  __resetMetaSdkLoaderForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadMetaSdk", () => {
  it("[already loaded] window.FB present -> resolves immediately, no script appended", async () => {
    const env = fakeEnvironment();
    env.window.FB = { init: vi.fn(), login: vi.fn() };

    await loadMetaSdk({ appId: "app-1", version: "v23.0", env });

    expect(env.scripts).toHaveLength(0);
  });

  it("[first call] appends exactly one script tag with the confirmed Meta SDK src", async () => {
    const env = fakeEnvironment();
    const promise = loadMetaSdk({ appId: "app-1", version: "v23.0", env });

    expect(env.scripts).toHaveLength(1);
    expect(env.scripts[0].src).toBe(META_SDK_SRC);

    env.window.fbAsyncInit?.();
    await promise;
  });

  it("[loaded once] a second call before the first settles reuses the SAME promise, never a second script tag", async () => {
    const env = fakeEnvironment();
    const first = loadMetaSdk({ appId: "app-1", version: "v23.0", env });
    const second = loadMetaSdk({ appId: "app-1", version: "v23.0", env });

    expect(first).toBe(second);
    expect(env.scripts).toHaveLength(1);

    env.window.fbAsyncInit?.();
    await first;
  });

  it("[fbAsyncInit fires] calls FB.init with the exact confirmed parameters", async () => {
    const env = fakeEnvironment();
    const initMock = vi.fn();
    const promise = loadMetaSdk({ appId: "app-1", version: "v23.0", env });
    env.window.FB = { init: initMock, login: vi.fn() };

    env.window.fbAsyncInit?.();
    await promise;

    expect(initMock).toHaveBeenCalledWith({ appId: "app-1", autoLogAppEvents: true, xfbml: true, version: "v23.0" });
  });

  it("[script onerror] rejects, and clears the cache so a later retry is possible", async () => {
    const env = fakeEnvironment();
    const promise = loadMetaSdk({ appId: "app-1", version: "v23.0", env });

    env.scripts[0].onerror?.();

    await expect(promise).rejects.toThrow(/failed to load/i);

    // Retry: a fresh call must append a NEW script tag, not silently reuse
    // the failed one.
    const retry = loadMetaSdk({ appId: "app-1", version: "v23.0", env });
    expect(env.scripts).toHaveLength(2);
    env.window.fbAsyncInit?.();
    await retry;
  });

  it("[timeout] rejects if neither fbAsyncInit nor onerror ever fires", async () => {
    const env = fakeEnvironment();
    const promise = loadMetaSdk({ appId: "app-1", version: "v23.0", timeoutMs: 5_000, env });

    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("[never logs/exposes any secret] the loader source references only appId/version — no WHATSAPP_META_ACCESS_TOKEN/APP_SECRET anywhere", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "metaSdk.ts"), "utf8");
    expect(source).not.toMatch(/WHATSAPP_META_ACCESS_TOKEN|WHATSAPP_META_APP_SECRET|SUPABASE_SERVICE_ROLE_KEY/);
  });
});
