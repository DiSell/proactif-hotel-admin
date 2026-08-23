/**
 * Every tunable knob for the site-analysis crawler, in one place — nothing
 * else in this feature should hardcode a number. This is a deliberately
 * small, admin-triggered MVP crawler, not a search-engine-grade one: the
 * limits below exist to keep it fast, polite, and predictable, not to
 * maximize coverage.
 */

/**
 * Ceiling on genuinely USEFUL pages kept per run — status "relevant" or
 * "probably_technical" only. This is the number that actually matters for
 * the admin's import decision, and the one shown as "N pages" everywhere
 * in the UI/API contract.
 */
export const MAX_USEFUL_PAGES = 30;

/**
 * Separate, larger ceiling on total real HTTP fetch ATTEMPTS per run —
 * every status counts here except robots_disallowed (which never actually
 * fetches). Exists because a stale sitemap can bury useful pages behind a
 * long run of 404s: real-world testing against le1837.com found 19 of 30
 * attempts were dead sitemap entries, so a single shared budget between
 * "pages found" and "pages worth keeping" let a bad sitemap silently starve
 * the crawl of useful content.
 *
 * Set to 60 — deliberately conservative for this MVP (2x MAX_USEFUL_PAGES,
 * not the wider margin a higher real-world hit rate would want) rather than
 * the maximum that would reliably reach 30 useful pages even at the worst
 * hit rate observed so far (~23%, which would need closer to 130). At a
 * conservative budget the crawler may often stop via this limit rather
 * than MAX_USEFUL_PAGES on a site with many dead sitemap entries — that's
 * the accepted trade-off for now; see stoppedReason in CrawlResult to tell
 * which happened, and revisit this number with more real-world data.
 */
export const MAX_FETCH_ATTEMPTS = 60;

/**
 * Hard ceiling on the wall-clock duration of one analysis run, checked
 * between batches (not a mid-request abort — an in-flight batch is still
 * allowed to finish, bounded by REQUEST_TIMEOUT_MS per request). Exists
 * independently of MAX_FETCH_ATTEMPTS: a slow site can burn a lot of real
 * time reaching even a modest attempt count. 75s sits in the middle of the
 * 60-90s admin-tool range this is meant for — long enough for a normal
 * site, short enough that a stuck "Analyser le site" click has a clear
 * upper bound.
 */
export const MAX_CRAWL_DURATION_MS = 75_000;

/**
 * Ceiling on how many distinct candidate URLs are INSPECTED for
 * prioritization (sitemap entries + links discovered along the way) before
 * any download happens. A sitemap can legitimately list far more URLs than
 * MAX_USEFUL_PAGES or MAX_FETCH_ATTEMPTS — this bounds memory/sort cost
 * while still letting the crawler see enough of the address space to
 * prioritize correctly, rather than just taking the first N in sitemap
 * order. Also doubles as the absolute backstop on total pages recorded in
 * one run (see crawl.ts), so a site whose robots.txt disallows almost
 * everything — which consumes queue slots without ever counting as a fetch
 * attempt — still can't grow the result unboundedly.
 */
export const MAX_CANDIDATE_URLS = 500;

/** Max link-following depth from the homepage when no sitemap is used to seed discovery. */
export const MAX_DEPTH = 3;

/** Per-request network timeout. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Hard ceiling on a single response body, enforced while streaming (not trusted from Content-Length alone). */
export const MAX_HTML_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Hard ceiling on a single downloaded image, enforced while streaming — a separate, more generous budget than MAX_HTML_SIZE_BYTES (semantically different content). */
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Ceiling on how many <img> a single page's extraction records — a pathological page with hundreds of images shouldn't blow up the admin curation UI. */
export const MAX_IMAGES_PER_PAGE = 20;

/** Redirect hops followed per request before giving up — each hop is fully re-validated (protocol, domain, DNS/SSRF). */
export const MAX_REDIRECTS = 5;

/** How many pages are fetched at once — a courtesy limit, not a performance target. */
export const CRAWL_CONCURRENCY = 2;

/** Minimum delay between requests issued by one crawl run, in ms. */
export const REQUEST_DELAY_MS = 250;

/** Identifies the crawler to site operators and to robots.txt matching. */
export const USER_AGENT = "ProactifSystemBot/1.0 (+https://proactifsystem.example.com/bot)";

/**
 * Below this many characters of extracted visible text, a page is flagged
 * "insufficient content / likely JS-rendered" rather than indexed blindly.
 */
export const MIN_CONTENT_CHARS = 200;

/** File extensions never worth fetching as an HTML page. */
export const EXCLUDED_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
  ".css", ".js", ".mjs", ".map",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".rar", ".7z", ".tar", ".gz",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav",
  ".woff", ".woff2", ".ttf", ".eot",
  ".xml", ".json", ".rss", ".atom",
];

/** Path substrings that mark a URL as administrative/technical/infinite rather than content to crawl. */
export const EXCLUDED_PATH_KEYWORDS = [
  "/wp-admin", "/wp-login", "/admin", "/login", "/signin", "/sign-in", "/register",
  "/cart", "/checkout", "/panier", "/commande", "/paiement", "/payment",
  "/account", "/mon-compte", "/my-account",
  "/search", "/recherche", "?s=",
  "/feed", "/wp-json", "/xmlrpc.php",
  "/cgi-bin",
];

/** Query-string parameter names stripped during normalization — pure tracking noise, never part of page identity. */
export const TRACKING_QUERY_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid",
  "ref", "referrer", "source",
];

/** Query-string parameter names that signal a calendar/search widget likely to generate unbounded URLs. */
export const INFINITE_QUERY_PARAMS = ["date", "checkin", "checkout", "arrival", "departure", "month", "year", "page"];

/** Keyword groups used only to PRIORITIZE crawling/pre-checking — never an assertion that the hotel has any of these. */
export const RELEVANCE_KEYWORDS: Record<string, string[]> = {
  rooms: ["chambre", "room", "suite", "appartement", "apartment", "habitacion", "alojamiento"],
  pricing: ["tarif", "price", "precio", "rate"],
  booking: ["reservation", "réservation", "booking", "reserva", "book-now"],
  spa: ["spa", "bien-etre", "bien-être", "wellness", "bienestar"],
  pool: ["piscine", "pool", "piscina"],
  restaurant: ["restaurant", "petit-dejeuner", "petit-déjeuner", "breakfast", "desayuno", "gastronomie"],
  services: ["service", "equipement", "équipement", "amenities", "servicio", "instalacion", "instalación"],
  parking: ["parking", "garage", "aparcamiento"],
  access: ["acces", "accès", "access", "comment-venir", "getting-here", "como-llegar", "cómo-llegar"],
  contact: ["contact", "contacto"],
  faq: ["faq", "questions", "preguntas"],
  policy: ["conditions", "reglement", "règlement", "policy", "cgv", "terminos", "términos", "cancellation", "annulation"],
  pets: ["animaux", "animal", "pets", "mascota", "chien", "dog"],
  events: ["seminaire", "séminaire", "meeting", "conference", "conférence", "evento", "groupe", "group"],
  offers: ["offre", "offer", "promo", "oferta", "deal"],
  activities: ["activite", "activité", "activity", "actividad", "loisir"],
  nearby: ["alentour", "environ", "nearby", "around", "cerca", "tourisme", "tourism", "turismo"],
};
