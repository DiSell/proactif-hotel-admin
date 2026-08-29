/**
 * Loads the Facebook JavaScript SDK exactly once, for Meta WhatsApp
 * Embedded Signup only — never used for anything else in this app (no
 * generic "Facebook Login" elsewhere in this codebase). Snippet confirmed
 * against Meta's current Embedded Signup implementation docs
 * (developers.facebook.com/documentation/business-messaging/whatsapp/
 * embedded-signup/implementation, checked 2026-08-29):
 *
 *   <script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
 *   window.fbAsyncInit = function () {
 *     FB.init({ appId, autoLogAppEvents: true, xfbml: true, version });
 *   };
 *
 * Deliberately NOT pasted into layout.tsx/a global <Script> tag (task
 * section 4's own explicit instruction) — this loader is only invoked from
 * EmbeddedSignupButton.tsx, on demand, so a client-portal visitor who never
 * opens the WhatsApp page never fetches connect.facebook.net at all.
 */

export const META_SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface MetaSdkWindow {
  FB?: {
    init: (params: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
    login: (callback: (response: unknown) => void, params: Record<string, unknown>) => void;
  };
  fbAsyncInit?: () => void;
}

export interface MetaSdkEnvironment {
  window: MetaSdkWindow;
  document: Pick<Document, "createElement"> & { head: Pick<HTMLHeadElement, "appendChild"> };
}

function defaultEnvironment(): MetaSdkEnvironment {
  return { window: window as unknown as MetaSdkWindow, document };
}

export interface LoadMetaSdkOptions {
  appId: string;
  /** Graph API version — Meta's own docs recommend always using the latest at FB.init() time. Never hardcode this beyond a single configurable default; see EmbeddedSignupButton.tsx's own doc comment on where this value comes from. */
  version: string;
  timeoutMs?: number;
  env?: MetaSdkEnvironment;
}

// Module-level: the SDK really must load only once for the lifetime of the
// page, per task section 4 ("le SDK doit être chargé une seule fois").
// Keyed by nothing — this app only ever loads ONE Meta app's SDK — a second
// concurrent/later call simply reuses this same in-flight/settled promise
// rather than injecting a second <script> tag.
let sdkPromise: Promise<void> | null = null;

/** Test-only: clears the module-level cache so each test starts from a clean slate. Never called from application code. */
export function __resetMetaSdkLoaderForTests(): void {
  sdkPromise = null;
}

/**
 * Resolves once `window.FB` is ready to call (`FB.login`, etc.). Rejects on
 * script load failure or timeout — never leaves a caller awaiting forever.
 * Safe to call multiple times: every call after the first one returns the
 * SAME promise, whether the load already finished or is still in flight.
 */
export function loadMetaSdk(options: LoadMetaSdkOptions): Promise<void> {
  const env = options.env ?? defaultEnvironment();

  if (env.window.FB) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      sdkPromise = null; // allow a later retry once the transient failure has passed
      reject(new Error("Meta SDK load timed out"));
    }, timeoutMs);

    env.window.fbAsyncInit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      env.window.FB?.init({ appId: options.appId, autoLogAppEvents: true, xfbml: true, version: options.version });
      resolve();
    };

    // No "already inserted" guard here by design: the module-level
    // sdkPromise cache above is what prevents a double-insert for
    // concurrent calls. A guard keyed on a persistent element id would
    // instead make every RETRY after a failed load hang forever — a
    // script tag whose onerror already fired never fires again, so a
    // fresh <script> must always be created for a fresh attempt.
    const script = env.document.createElement("script");
    script.id = "meta-whatsapp-sdk";
    script.src = META_SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      sdkPromise = null;
      reject(new Error("Meta SDK script failed to load"));
    };
    env.document.head.appendChild(script);
  });

  return sdkPromise;
}
