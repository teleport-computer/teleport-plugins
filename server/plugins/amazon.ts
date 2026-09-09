// Amazon plugin — delegated read of the owner's REAL shopping cart via the
// authenticated /gp/cart/view.html page (the same vault-jar pattern as reddit/otter), plus
// the `amazon:cart-substitute` write: a scoped friend may replace ONE cart line (remove ASIN
// X, add a comparable ASIN Y within a price band and the same category), enforced server-side.
// cart-share v2's "friend substitutes an item in your cart" is the real write path, not a mock.
//
// This is the missing piece for cart-share v2: a friend holds a scoped, revocable
// `amazon:cart-read` capability that can read the logged-in cart line items (name,
// price, qty, ASIN) but CANNOT check out. The write/substitute path (`amazon:cart-
// substitute`) is gated server-side to one remove + one add within a price band / same
// category — checkout, address, payment, and arbitrary adds are rejected (403).
//
// Amazon is bot-defended (like nytimes/twitter): there is no clean cart .json API and
// the cart HTML is behind a robot wall. So this plugin tries the authenticated HTML
// fetch first and, if Amazon returns a captcha / robot check, throws a CLEAR error
// pointing at the browser path (GET /api/amazon/screenshot renders the logged-in cart
// via the Browser SPI). It NEVER masks a robot wall or an expired jar as an empty
// cart — a visible, honest error is the correct outcome (a silent empty/fake cart is
// a rejected outcome). The DOM parser is a pure exported function (parseCart) so it is
// testable without a jar; Amazon captchas CI, so no live network is in the test.
//
// Live end-to-end verification against a real logged-in cart requires the owner's
// amazon.com jar, which only the owner can sync via the extension. The code + parser
// test + honest error paths are delivered here; the owner does the live-jar proof.

import { requireNetworkLog } from "../browser.ts";
import { cookieHeader, Jar, Plugin, PluginItem, SubstituteOp, SubstituteResult } from "./types.ts";

// Live Amazon base. Override via AMAZON_BASE (e2e/mock) through configureAmazon();
// never read Deno.env at module top level (the isolated container runs --deny-env —
// env arrives via the handler's ctx.env, same pattern as reddit/otter).
let BASE = "https://www.amazon.com";
// The in-TEE Browser SPI (login-with-anything/tee-browser) — the same instrument the twitter
// path drives (server/twitter-actions.ts). The cart-substitute WRITE runs here, not as a raw
// server-side replay: Amazon bot-walls the raw CSRF-scrape POST on TLS/behavioral fingerprint
// (#98/#103), while OUR in-TEE browser performs the real signed add + remove with its own
// page's anti-csrftoken-a2z and we reify the captured trajectory. These are the SHARED browser
// creds (the handler also keeps BROWSER_SPI_URL/BROWSER_SPI_SECRET); amazon reads them through
// this same configure seam so substitute(jar, op) needs no extra args.
let SPI_URL = "";
let SPI_SECRET = "";
// Settle delay after a browser /navigate before /capture-trace (lets the logged-in XHR fire).
// Overridable via configureAmazon so the SPI-mock test can zero it (no real browser to wait on).
let NAV_DELAY_MS = 5000;
let PRE_REMOVE_DELAY_MS = 3000;
export function configureAmazon(env: Record<string, string>): void {
  if (env.AMAZON_BASE) BASE = env.AMAZON_BASE.replace(/\/$/, "");
  SPI_URL = (env.BROWSER_SPI_URL || "").replace(/\/$/, "");
  SPI_SECRET = env.BROWSER_SPI_SECRET || "";
  if (env.BROWSER_NAV_DELAY_MS !== undefined) NAV_DELAY_MS = Number(env.BROWSER_NAV_DELAY_MS) || 0;
  if (env.BROWSER_PRE_REMOVE_DELAY_MS !== undefined) PRE_REMOVE_DELAY_MS = Number(env.BROWSER_PRE_REMOVE_DELAY_MS) || 0;
}

const CART_PATH = "/gp/cart/view.html";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function headers(jar: Jar): Record<string, string> {
  return {
    "Cookie": cookieHeader(jar),
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

// One parsed cart line — the full detail fetchItem returns; listItems maps this to
// PluginItem. Kept as a pure value so the parser is testable without a jar.
export interface CartLine {
  asin: string;
  title: string;
  price: string;
  qty: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Decode a numeric code point, refusing out-of-range / lone-surrogate values so a
// malformed numeric entity can't throw or emit a broken half-string (it contributes
// nothing instead). Used by decodeEntities for the &#NN; / &#xNN; forms Amazon emits.
function fromCodePointSafe(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
    return "";
  }
  return String.fromCodePoint(n);
}

function decodeEntities(s: string): string {
  // Numeric forms (&#039; / &#x27;) first, BEFORE &amp; — so a literal sequence like
  // `&amp;#039;` (the visible text "&#039;") is not re-decoded once &amp; opens it up.
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => fromCodePointSafe(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePointSafe(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

// Read a `name="value"` attribute off a single opening tag.
function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${escapeRe(name)}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : undefined;
}

// Text content of the first element carrying `cls` as a whole class token. Captures
// inner text up to the matching close tag and strips any nested tags.
function classText(html: string, cls: string): string | undefined {
  const re = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bclass="[^"]*\\b${escapeRe(cls)}(?![\\w-])[^"]*"[^>]*>`,
    "i",
  );
  const open = html.match(re);
  if (!open || open.index === undefined) return undefined;
  const tag = open[1].toLowerCase();
  const after = html.slice(open.index + open[0].length);
  const closeRe = new RegExp(`</${tag}\\s*>`, "i");
  const close = after.match(closeRe);
  const inner = close && close.index !== undefined ? after.slice(0, close.index) : after.slice(0, 240);
  const text = inner.replace(/<[^>]+>/g, "").trim();
  return text ? decodeEntities(text) : undefined;
}

// value="..." off the first <input> carrying `cls` (attribute order varies).
function inputValue(html: string, cls: string): string | undefined {
  const re = new RegExp(
    `<input\\b[^>]*\\bclass="[^"]*\\b${escapeRe(cls)}(?![\\w-])[^"]*"[^>]*>`,
    "i",
  );
  const m = html.match(re);
  return m ? attr(m[0], "value") : undefined;
}

// Normalize a raw cart-line title into a clean product name: decode any entities
// classText left encoded, drop the trailing "Opens in a new tab" Amazon appends to the
// product link's aria-label / screen-reader span, collapse the newline/tab whitespace
// the HTML leaves behind, and trim. No truncation — length is the consumer's call.
// cart-share v2 used to scrub this client-side; it belongs at the source so every
// reader (items endpoint, fetchItem, screenshots) gets the same clean name.
function cleanTitle(raw: string): string {
  const stripped = decodeEntities(raw).replace(/\s*Opens in a new tab\s*$/i, "");
  return stripped.replace(/\s+/g, " ").trim();
}

// Pure DOM parser — turns the authenticated /gp/cart/view.html HTML into cart lines.
// Each product row is an element carrying the standalone `sc-list-item` class AND a
// `data-asin` (rows without data-asin — headers, save-for-later spacers — are skipped).
// Title: .sc-product-title / .sc-product-link. Price: .sc-product-price / .sc-price /
// the a-offscreen span, falling back to data-price. Qty: .sc-quantity-textfield value,
// falling back to data-quantity. Exported so it is testable without a jar.
export function parseCart(html: string): CartLine[] {
  const lines: CartLine[] = [];
  // Opening tags carrying the standalone `sc-list-item` class (not sc-list-item-content
  // / -border-less on their own — the (?![\w-]) lookahead requires a real token break).
  const openRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bclass="[^"]*\bsc-list-item(?![\w-])[^"]*"[^>]*>/gi;
  const positions: { start: number; tag: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) positions.push({ start: m.index, tag: m[0] });
  for (let i = 0; i < positions.length; i++) {
    const asin = attr(positions[i].tag, "data-asin");
    if (!asin) continue; // sc-list-item without data-asin isn't a product line
    const end = i + 1 < positions.length ? positions[i + 1].start : positions[i].start + 6000;
    const block = html.slice(positions[i].start, end);
    const title =
      classText(block, "sc-product-title") ||
      classText(block, "sc-product-link") ||
      "";
    const price =
      classText(block, "sc-product-price") ||
      classText(block, "sc-price") ||
      classText(block, "a-offscreen") ||
      attr(positions[i].tag, "data-price") ||
      "";
    const qtyStr =
      inputValue(block, "sc-quantity-textfield") ||
      attr(positions[i].tag, "data-quantity") ||
      "1";
    const qty = Number(qtyStr) || 1;
    lines.push({ asin, title: cleanTitle(title), price: price.trim(), qty });
  }
  return lines;
}

// Captcha / robot-wall detection — Amazon returns 200 with a "Robot Check" page or
// redirects to /errors/validateCaptcha when it doesn't trust the request. This is the
// signal that the frozen fetch path is blocked and the browser path is required.
export function isCaptcha(html: string, finalUrl: string): boolean {
  return /\/errors\/validateCaptcha/i.test(finalUrl) ||
    /Robot Check|Type the characters you see|To discuss automated access|validateCaptcha|api-na\.captcha/i.test(html);
}

// A genuine empty-cart page (signed in, no items). Distinct from "blocked/unparseable":
// this state legitimately yields zero lines and must NOT throw.
export function isEmptyCart(html: string): boolean {
  return /sc-empty-cart|Your (?:Amazon )?(?:Shopping )?Cart is empty|Your Shopping Cart is empty/i.test(html);
}

async function fetchCartHtml(jar: Jar): Promise<{ html: string; url: string; status: number; ok: boolean }> {
  const r = await fetch(`${BASE}${CART_PATH}`, { headers: headers(jar), signal: AbortSignal.timeout(60_000) });
  const html = await r.text();
  return { html, url: r.url, status: r.status, ok: r.ok };
}

// The shared read behind listItems + fetchItem + substitute. Throws a clear, honest error
// on every failure mode — never returns an empty array AS success when the real cause is a
// robot wall, an expired jar, or an unparseable page. Exposes the raw HTML too, so the write
// path (substitute) can scrape the real mutation form + CSRF off the SAME page without a
// second fetch.
async function readCartWithHtml(jar: Jar): Promise<{ lines: CartLine[]; html: string; url: string }> {
  const { html, url, status, ok } = await fetchCartHtml(jar);
  if (isCaptcha(html, url)) {
    throw new Error(
      "amazon rejected the jar — robot check (captcha); amazon is a BROWSER-PATH site — run via GET /api/amazon/screenshot or sync a fresh jar",
    );
  }
  if (status === 401 || status === 403) {
    throw new Error("amazon rejected the jar — cookies expired");
  }
  if (!ok) {
    throw new Error(`amazon cart ${status}: ${html.slice(0, 200)}`);
  }
  const lines = parseCart(html);
  if (lines.length === 0 && !isEmptyCart(html)) {
    // Got a 200 page but no cart lines and no empty-cart marker — the fetch didn't hit
    // a recognized cart surface. Say so honestly rather than returning [] as success.
    throw new Error(
      "could not read amazon cart lines (no sc-list-item blocks and not an empty-cart page) — amazon is a BROWSER-PATH site; run via GET /api/amazon/screenshot or sync a fresh jar",
    );
  }
  return { lines, html, url };
}
async function readCart(jar: Jar): Promise<CartLine[]> {
  return (await readCartWithHtml(jar)).lines;
}

// --- cart-write: the `amazon:cart-substitute` capability (#98) ---
// A friend holds a scoped token carrying the `amazon:cart-substitute` cap and may replace
// ONE active-cart line (remove ASIN X) with ONE comparable ASIN Y within a price band and
// the same category. Enforcement is SERVER-SIDE (the helpers below + the handler route),
// NEVER trusted from the client. The cap grants NO reads — scopeReads(["amazon:cart-substitute"])
// is an EMPTY set, so a substitute-only token is denied at every read chokepoint (a friend
// view reads the cart via a separate `amazon:cart-read` cap). Checkout / address / payment /
// arbitrary add / quantity-bomb are rejected (403): there is no endpoint for them and
// normalizeSubstitute refuses the shape.
//
// Amazon bot-defends writes harder than reads, so substitute() scrapes the anti-CSRF token +
// the active-cart form off the SAME cart page the read already fetches (real markup at runtime,
// never a hardcoded fixture) and POSTs the remove + add. On a captcha / robot wall it throws a
// clear browser-path error rather than masking a failure as success. The gate helpers + the
// endpoint/CSRF parsing are pure exported functions, testable without a jar (Amazon captchas CI);
// the live write proof (issue acceptance #1) is operator-run against a logged-in session.

// A scope-gate denial — the handler maps this to 403 (vs a generic Error → 502). Carries a
// short reason so the 403 body is legible. Used for every shape a cart-substitute token must
// NOT be able to perform: arbitrary add, invalid ASIN, quantity-bomb, out-of-band/cross-
// category substitute, and an unreadable replacement price (fail closed).
export class SubstituteDeniedError extends Error {
  code = "denied" as const;
  constructor(public reason: string) {
    super(reason);
    this.name = "SubstituteDeniedError";
  }
}

const ASIN_RE = /^[A-Z0-9]{10}$/;
// A substitute may add at most this many units of the replacement — bounds a quantity-bomb.
export const MAX_SUBSTITUTE_QTY = 5;
// Price band: the replacement's unit price may be at most PRICE_BAND_MULT × the removed line's
// unit price AND at most PRICE_BAND_ADD above it. Bounded so "swap the jerky for an organic
// alternative" can't be turned into substituting in a $400 espresso machine. Both must hold.
const PRICE_BAND_MULT = 1.5;
const PRICE_BAND_ADD = 25;

// Validate + normalize a substitute op. Throws SubstituteDeniedError for every shape a
// cart-substitute token must NOT perform: missing removeAsin (arbitrary add), missing/invalid
// ASINs, same ASIN, non-integer or out-of-band qty (quantity-bomb). Pure (no jar, no network).
export function normalizeSubstitute(op: Partial<SubstituteOp>): SubstituteOp {
  const removeAsin = (op.removeAsin ?? "").toString().toUpperCase().trim();
  const addAsin = (op.addAsin ?? "").toString().toUpperCase().trim();
  const qtyRaw = op.qty;
  if (!removeAsin) {
    throw new SubstituteDeniedError(
      "not a substitute: removeAsin is required (arbitrary add is not permitted by amazon:cart-substitute)",
    );
  }
  if (!addAsin) throw new SubstituteDeniedError("not a substitute: addAsin is required");
  if (!ASIN_RE.test(removeAsin)) throw new SubstituteDeniedError(`removeAsin '${removeAsin}' is not a valid ASIN`);
  if (!ASIN_RE.test(addAsin)) throw new SubstituteDeniedError(`addAsin '${addAsin}' is not a valid ASIN`);
  if (removeAsin === addAsin) throw new SubstituteDeniedError("removeAsin and addAsin must differ");
  if (!Number.isInteger(qtyRaw) || (qtyRaw as number) < 1) {
    throw new SubstituteDeniedError("qty must be a positive integer");
  }
  const qty = qtyRaw as number;
  if (qty > MAX_SUBSTITUTE_QTY) {
    throw new SubstituteDeniedError(
      `qty ${qty} exceeds the substitute maximum (${MAX_SUBSTITUTE_QTY}) — quantity-bomb is not permitted`,
    );
  }
  return { removeAsin, addAsin, qty };
}

// Parse a dollar price string Amazon emits ('$13.99', '$ 13.99', '13.99') to a number, or
// null when unparseable. Pure.
export function parsePrice(s: string): number | null {
  const m = s.replace(/[$,\s]/g, "").match(/^\d+(?:\.\d+)?$/);
  return m ? Number(m[0]) : null;
}

// Price-band check: the replacement must be within PRICE_BAND_MULT × removed AND within
// removed + PRICE_BAND_ADD. False (denied) when either price is unparseable (fail closed) or
// the band is exceeded. Pure — this is the heart of the scope gate's price enforcement.
export function priceBandOk(removedPrice: string, addedPrice: string): boolean {
  const a = parsePrice(removedPrice);
  const b = parsePrice(addedPrice);
  if (a === null || b === null) return false; // fail closed when a price can't be verified
  return b <= a * PRICE_BAND_MULT && b <= a + PRICE_BAND_ADD;
}

// Coarse category bucket from a product title — the same-category guard. Keyword-based and
// deliberately coarse (cart-share substitutes grocery/pantry staples); returns "unknown" when
// no signal. sameCategory treats an unknown as compatible (the price band still bounds the
// swap), so classification is lenient but the price check is strict. Pure.
export function categorize(title: string): string {
  const t = title.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  // \b token boundaries so "oat" (oat milk) doesn't match inside "oats" (the grain), etc.
  if (has(/\b(beef|jerky|poultry|chicken|turkey|pork|bacon|sausage|salmon|tuna|meat|protein)\b/)) return "protein";
  if (has(/\b(coffee|tea|espresso|k-?cup|grounds|beans)\b/)) return "coffee-tea";
  if (has(/\b(almond|oat|soy|milk|cream|yogurt|cheese|butter)\b/)) return "dairy";
  if (has(/\b(cereal|granola|oats|oatmeal|muesli|pancake|syrup|jam|honey|pasta|rice|grain|flour|sugar|oil|vinegar|sauce|spice)\b/)) {
    return "pantry";
  }
  if (has(/\b(snack|chip|cracker|cookie|candy|chocolate|nut|popcorn)\b/)) return "snack";
  return "unknown";
}
export function sameCategory(removedTitle: string, addedTitle: string): boolean {
  const a = categorize(removedTitle);
  const b = categorize(addedTitle);
  return a === "unknown" || b === "unknown" ? true : a === b;
}

// value="..." off the first <input> carrying name="<name>" (attribute order varies).
function inputValueByName(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`<input\\b[^>]*\\bname="${escapeRe(name)}"[^>]*>`, "i"));
  return m ? attr(m[0], "value") : undefined;
}
// content="..." off the first <meta name="<name>">.
function metaContent(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`<meta\\b[^>]*\\bname="${escapeRe(name)}"[^>]*>`, "i"));
  return m ? attr(m[0], "content") : undefined;
}
// Inner text of the first element with id="<id>" (strips nested tags).
function textById(html: string, id: string): string | undefined {
  const m = html.match(new RegExp(`<[a-zA-Z][a-zA-Z0-9]*\\b[^>]*\\bid="${escapeRe(id)}"[^>]*>([\\s\\S]*?)<\\/[a-zA-Z]`, "i"));
  return m ? decodeEntities(m[1]).replace(/<[^>]+>/g, "").trim() : undefined;
}

export interface CartUpdateForm {
  action: string; // the active-cart mutation endpoint scraped from the real cart page
  csrfToken: string | null; // anti-CSRF token scraped from the real cart page (null if absent)
}
// Scrape the active-cart mutation form + the anti-CSRF token off the REAL cart page HTML (the
// same page readCart fetches). Returns null when the page carries no activeCartViewForm (then
// substitute() throws an honest browser-path error — never guesses field names). Pure.
export function parseCartUpdateForm(html: string): CartUpdateForm | null {
  const formMatch = html.match(/<form\b[^>]*\bname="activeCartViewForm"[^>]*>/i);
  if (!formMatch) return null;
  const action = attr(formMatch[0], "action") || "/gp/cart/ajax/update.html";
  const csrfToken = inputValueByName(html, "csrf-token") || metaContent(html, "csrf-token") || null;
  return { action, csrfToken };
}

// The name= of the quantity <input> inside THIS asin's cart row (so the remove POST sets the
// right line to 0). Walks the same sc-list-item split parseCart uses; undefined when absent.
// Pure — scrapes real markup at runtime.
export function cartQtyFieldName(html: string, asin: string): string | undefined {
  const positions: { start: number; tag: string }[] = [];
  let m: RegExpExecArray | null;
  const openRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bclass="[^"]*\bsc-list-item(?![\w-])[^"]*"[^>]*>/gi;
  while ((m = openRe.exec(html)) !== null) positions.push({ start: m.index, tag: m[0] });
  for (let i = 0; i < positions.length; i++) {
    if (attr(positions[i].tag, "data-asin") !== asin) continue;
    const end = i + 1 < positions.length ? positions[i + 1].start : positions[i].start + 6000;
    const block = html.slice(positions[i].start, end);
    const q = block.match(/<input\b[^>]*\bclass="[^"]*\bsc-quantity-textfield(?![\w-])[^"]*"[^>]*>/i);
    if (q) { const n = attr(q[0], "name"); if (n) return n; }
  }
  return undefined;
}

// Pure scraper for a product's offer price + title off a /dp/<asin> page's HTML — the addAsin
// side of a substitute. Amazon's standard DP containers, scraped at runtime; a miss yields ""
// and the price-band check fails CLOSED. Exported so it is testable without a jar, and reused
// by the browser path on the browser-captured DP dom (the raw server-side DP fetch that used to
// live here bot-walls — see #103). Pure.
export function parseAsinOffer(html: string): { price: string; title: string } {
  const title = textById(html, "productTitle") || "";
  const price =
    textById(html, "priceblock_ourprice") ||
    textById(html, "priceblock_dealprice") ||
    textById(html, "priceblock_saleprice") ||
    classText(html, "a-offscreen") ||
    "";
  return { price: price.trim(), title: cleanTitle(title) };
}

// --- #103: browser-path cart substitute (RFC 0001 reification) --------------------------
// The raw server-side CSRF-scrape POST is the WRONG path for the cart-substitute WRITE
// (#98/#103): it bot-walls on TLS/behavioral fingerprint even though the page's own
// anti-csrftoken-a2z is readable. The in-TEE browser (ours) performs the real signed add +
// remove with its own page's CSRF and full state, so we drive the Browser SPI, capture the
// FULL network trajectory (/capture-trace), and reduce it to the cart API calls of interest
// here — the ground truth an unofficial cart API is reified from. This mirrors the twitter
// path exactly (server/twitter-actions.ts: browserTrace() + reifyTrace() over the OP_PATTERNS
// map a.k.a. TWEET_OPS).

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function jarToBrowserCookies(jar: Jar) {
  return Object.entries(jar).map(([name, value]) => ({
    name, value, domain: ".amazon.com", path: "/", secure: true, httpOnly: false, sameSite: "no_restriction",
  }));
}

// Which captured Amazon request carried out which cart write — the analog of the twitter
// OP_PATTERNS map. The add endpoint is /gp/aws/cart/add.html (classic) or the smart-wagon
// handle-buy-box / hz/cart/add AJAX; the remove is the cart /gp/cart/ajax/update.html AJAX
// (a quantity.<n>=0 field marks a delete vs a plain update). The real anti-csrftoken-a2z rides
// the request body (`csrf-token`) or a header, captured at the network layer — NOT scraped +
// replayed server-side.
const CART_ADD_RE = /\/gp\/aws\/cart\/add\.html\b|\/gp\/product\/handle-buy-box\b|\/hz\/cart\/add\b/;
const CART_UPDATE_RE = /\/gp\/cart\/ajax\/update\.html\b/;
const CART_OPS_RE = new RegExp(`${CART_ADD_RE.source}|${CART_UPDATE_RE.source}`);

// Pull the first `name=value` field off a form-encoded body or query string (url-decoded).
function formField(body: string, name: string): string | undefined {
  if (!body) return undefined;
  const re = new RegExp(`(?:^|[&?])${name}=([^&]*)`, "i");
  const m = body.match(re);
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : undefined;
}
function pickHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return lower[name.toLowerCase()];
}

// Normalize a captured network_log entry to one field-name convention. The Browser SPI has
// emitted two schemas (twitter-actions reads snake_case post_data/request_headers;
// server/browser.ts documents camelCase requestBody/requestHeaders) — accept BOTH so the
// reifier is robust to whichever the live bridge returns.
function normEntry(e: {
  method?: string; url?: string;
  request_headers?: Record<string, string>; requestHeaders?: Record<string, string>;
  post_data?: unknown; requestBody?: unknown;
  status?: number;
  response_body?: unknown; responseBody?: unknown;
}): {
  method: string; url: string; headers: Record<string, string>;
  body: string; status: number | null; response: string;
} {
  const headers = (e.request_headers || e.requestHeaders || {}) as Record<string, string>;
  const body = e.post_data ?? e.requestBody ?? "";
  const response = e.response_body ?? e.responseBody ?? "";
  return {
    method: (e.method || "GET").toUpperCase(),
    url: e.url || "",
    headers: typeof headers === "object" && headers ? headers : {},
    body: typeof body === "string" ? body : String(body),
    status: typeof e.status === "number" ? e.status : null,
    response: typeof response === "string" ? response : "",
  };
}

// The analog of twitter-actions.reifyTrace: reduce a captured Amazon network_log to the cart
// API calls of interest. `action` ("cart.add" | "cart.remove" | "cart.update") filters;
// omit it for every cart op. Each reified op carries the real anti-CSRF token (from the
// request body `csrf-token` field or the `anti-csrftoken-a2z` header — captured at the
// network layer, never scraped-and-replayed server-side) plus the ASIN/qty + status. Pure.
export function reifyAmazonTrace(networkLog: unknown[], action?: string): unknown[] {
  const out: unknown[] = [];
  for (const raw of networkLog || []) {
    const e = normEntry(raw as Parameters<typeof normEntry>[0]);
    if (!CART_OPS_RE.test(e.url)) continue;
    let op: string;
    if (CART_ADD_RE.test(e.url)) op = "cart.add";
    else op = /quantity\.[^=]+=0(?:&|$)/i.test(e.body) || /\bdelete\b/i.test(e.url) ? "cart.remove" : "cart.update";
    if (action && op !== action) continue;
    let asinUrl: URL | null = null;
    try { asinUrl = new URL(e.url, BASE); } catch { /* relative or malformed — fall back to body only */ }
    const asin =
      formField(e.body, "ASIN") ||
      formField(e.body, "ASIN.1") ||
      (asinUrl ? asinUrl.searchParams.get("ASIN.1") || asinUrl.searchParams.get("ASIN") : null);
    const qty = formField(e.body, "Quantity") || formField(e.body, "Quantity.1");
    const csrf = formField(e.body, "csrf-token") || pickHeader(e.headers, "anti-csrftoken-a2z") || null;
    out.push({
      op,
      method: e.method,
      url: e.url.split("?")[0],
      asin: asin || null,
      qty: qty || null,
      csrf_token: csrf,
      status: e.status,
      response_body: e.response ? e.response.slice(0, 400) : null,
    });
  }
  return out;
}

// --- Browser SPI bridge (mirrors server/twitter-actions.ts bridge + server/browser.ts spi) ---

async function browserSpi(spiUrl: string, path: string, body: unknown, secret: string): Promise<any> {
  const r = await fetch(`${spiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`browser SPI ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Inject the jar + navigate + /capture-trace in one step (mirrors browser.browserCaptureTrace).
async function browserNavigate(
  spiUrl: string, jar: Jar, targetUrl: string, secret: string,
): Promise<{ dom_html: string; network_log: unknown[]; url: string }> {
  await browserSpi(spiUrl, "/session", { cookies: jarToBrowserCookies(jar), userAgent: BROWSER_UA }, secret);
  await browserSpi(spiUrl, "/navigate", { url: targetUrl }, secret);
  if (NAV_DELAY_MS > 0) await new Promise((res) => setTimeout(res, NAV_DELAY_MS)); // let logged-in XHR settle
  const t = await browserSpi(spiUrl, "/capture-trace", {}, secret);
  return { dom_html: t.dom_html || "", network_log: requireNetworkLog(t), url: t.url || targetUrl };
}

// Re-capture after an actuation (jar already injected) — navigate + /capture-trace.
async function browserCapture(
  spiUrl: string, secret: string, targetUrl: string,
): Promise<{ dom_html: string; network_log: unknown[]; url: string }> {
  await browserSpi(spiUrl, "/navigate", { url: targetUrl }, secret);
  if (NAV_DELAY_MS > 0) await new Promise((res) => setTimeout(res, NAV_DELAY_MS));
  const t = await browserSpi(spiUrl, "/capture-trace", {}, secret);
  return { dom_html: t.dom_html || "", network_log: requireNetworkLog(t), url: t.url || targetUrl };
}

// Run a script in the browser. The in-TEE browser runs its OWN page JS (proven in #98: it
// reads its own page's anti-csrftoken-a2z + full state normally), so clicking the Add-to-
// Cart button / submitting the active-cart form are real user actions it performs — the
// signed add.html / cart-update AJAX the network layer then captures. Returns the script's
// value (a short status string) so the caller can surface an honest no-op.
async function browserEval(spiUrl: string, script: string, secret: string): Promise<unknown> {
  const r = await browserSpi(spiUrl, "/eval", { script }, secret);
  return (r as { text?: unknown }).text ?? r;
}

// Click the Add-to-Cart button on the DP page (id=add-to-cart-button is Amazon's standard;
// fall back to the first add-to-cart button). Real user action -> real signed add request.
const ADD_TO_CART_CLICK =
  "(function(){var b=document.getElementById('add-to-cart-button')||document.querySelector('button[data-csa-c-type=item],input#add-to-cart-button');if(b){b.click();return 'clicked';}return 'no-add-button';})();";

// Set the removeAsin quantity field to 0 and submit activeCartViewForm (the browser performs
// the real cart-update AJAX with the page's own anti-csrftoken-a2z). qtyName is the scraped
// field name for that row (cartQtyFieldName); csrf is the scraped token, re-injected if the
// form lacks the hidden field. Best-effort zeroes the first quantity field when no name was
// scraped — the reified ops + the after re-read are the ground-truth check either way.
function removeLineScript(qtyName: string | undefined, csrf: string | null): string {
  const setQty = qtyName
    ? `var i=document.querySelector('input[name="${qtyName}"]');if(i){i.value='0';}`
    : `var i=document.querySelector('.sc-quantity-textfield');if(i){i.value='0';}`;
  const ensureCsrf = csrf
    ? `if(!f.querySelector('input[name=csrf-token]')){var h=document.createElement('input');h.type='hidden';h.name='csrf-token';h.value=${JSON.stringify(csrf)};f.appendChild(h);}`
    : "";
  return `(function(){${setQty}var f=document.forms['activeCartViewForm']||document.querySelector('form[name=\\"activeCartViewForm\\"]');if(!f)return 'no-active-cart-form';${ensureCsrf}f.submit();return 'submitted';})();`;
}

// Drive the in-TEE browser to perform the cart substitute, capture the full trajectory, and
// reify it. Mirrors browserTrace (twitter) + browserFeed (browser.ts). Server-side policy
// (price band, same category, remove-one+add-one, qty bound) runs on BROWSER-CAPTURED ground
// truth BEFORE any actuation and throws SubstituteDeniedError for any shape the cap must not
// permit (NO actuation on a denial). The live write proof (issue acceptance #1) is operator-
// run against a logged-in session; this is the verifiable instrument + the reified evidence.
export async function browserSubstitute(
  spiUrl: string, jar: Jar, op: SubstituteOp, secret: string,
): Promise<SubstituteResult> {
  if (!spiUrl) throw new Error("BROWSER_SPI_URL not configured — no browser SPI to drive");
  const { removeAsin, addAsin } = op;
  // qty rides the add click's Quantity on the DP page; the shape gate (normalizeSubstitute)
  // already bounded it before this runs.

  // 1. inject jar + navigate the cart + capture: BEFORE state, the mutation form, the qty field.
  const cartUrl = `${BASE}${CART_PATH}`;
  const beforeCap = await browserNavigate(spiUrl, jar, cartUrl, secret);
  if (isCaptcha(beforeCap.dom_html, beforeCap.url)) {
    throw new Error("amazon browser-path: cart page came back as a robot check — sync a fresh jar");
  }
  const before = parseCart(beforeCap.dom_html);
  const removed = before.find((l) => l.asin === removeAsin);
  if (!removed) throw new SubstituteDeniedError(`removeAsin ${removeAsin} is not in the active cart`);
  const form = parseCartUpdateForm(beforeCap.dom_html);
  const qtyName = cartQtyFieldName(beforeCap.dom_html, removeAsin);

  // 2. navigate the addAsin DP page + capture: its offer price + title (the addAsin side).
  const dpCap = await browserNavigate(spiUrl, jar, `${BASE}/dp/${addAsin}`, secret);
  if (isCaptcha(dpCap.dom_html, dpCap.url)) {
    throw new Error(`amazon browser-path: ASIN ${addAsin} DP page came back as a robot check — sync a fresh jar`);
  }
  const offer = parseAsinOffer(dpCap.dom_html);

  // 3. SERVER-SIDE POLICY GATE on browser-captured ground truth — deny BEFORE any actuation.
  if (!priceBandOk(removed.price, offer.price)) {
    throw new SubstituteDeniedError(
      `addAsin ${addAsin} (${offer.price || "?"}) is outside the substitute price band of ${removeAsin} (${removed.price}) — refused`,
    );
  }
  if (!sameCategory(removed.title, offer.title)) {
    throw new SubstituteDeniedError(
      `addAsin ${addAsin} is a different category than ${removeAsin} — substitute must stay within the same category`,
    );
  }

  // 4. ACTUATE the add: click Add-to-Cart on the DP page (real signed add request in the trace).
  await browserEval(spiUrl, ADD_TO_CART_CLICK, secret);

  // 5. ACTUATE the remove: on the cart, zero the removeAsin line + submit activeCartViewForm
  //    (real signed cart-update AJAX in the trace).
  await browserSpi(spiUrl, "/navigate", { url: cartUrl }, secret);
  if (PRE_REMOVE_DELAY_MS > 0) await new Promise((res) => setTimeout(res, PRE_REMOVE_DELAY_MS));
  const rmStatus = await browserEval(spiUrl, removeLineScript(qtyName, form?.csrfToken || null), secret);
  if (rmStatus === "no-active-cart-form") {
    throw new Error(
      "amazon browser-path: the cart page carried no activeCartViewForm — could not actuate the remove; perform the edit via the browser path",
    );
  }

  // 6. capture the AFTER cart dom + the FULL network trajectory, and reify the cart writes.
  const afterCap = await browserCapture(spiUrl, secret, cartUrl);
  const after = parseCart(afterCap.dom_html);
  const ops = reifyAmazonTrace(afterCap.network_log);

  // 7. confirm against ground truth (no local mutation): the add appeared, the remove is gone.
  const added = after.find((l) => l.asin === addAsin);
  if (!added) {
    throw new Error(
      `substitute actuated but addAsin ${addAsin} did not appear on re-read — amazon likely bot-walled the browser write; inspect the reified ops`,
    );
  }
  return {
    removed,
    added: { asin: added.asin, title: added.title, price: added.price },
    before,
    after,
    path: "browser-path",
    ops,
  };
}

export const amazonPlugin: Plugin = {
  id: "amazon",
  label: "Amazon (cart)",
  cookieDomains: [".amazon.com"],
  renderUrl: "https://www.amazon.com/gp/cart/view.html",

  // at-main is Amazon's auth token; sess-at-main / x-main ride alongside when signed in.
  loggedIn(jar: Jar): boolean {
    return !!jar["at-main"];
  },

  async listItems(jar: Jar): Promise<PluginItem[]> {
    const lines = await readCart(jar);
    return lines.map((l): PluginItem => ({
      id: l.asin,
      title: l.title,
      meta: { asin: l.asin, price: l.price, qty: l.qty },
    }));
  },

  async fetchItem(jar: Jar, asin: string): Promise<unknown> {
    const lines = await readCart(jar);
    const hit = lines.find((l) => l.asin === asin);
    if (!hit) throw new Error(`amazon cart item ${asin} not in cart`);
    return hit;
  },

  // The write behind the `amazon:cart-substitute` cap (#98), driven via the in-TEE Browser
  // SPI (#103). Server-side scope enforcement (normalize + price band + same category + qty
  // bound) runs BEFORE any actuation and throws SubstituteDeniedError for any shape the cap
  // must NOT permit; the handler maps that to 403. The actuation drives the REAL logged-in
  // browser (inject jar → add ASIN Y → remove ASIN X → /capture-trace → reify), which performs
  // the signed add.html + cart-update AJAX with its own anti-csrftoken-a2z; the reified ops
  // (cart.add + cart.remove) are returned as ground-truth evidence (RFC 0001). The raw server-
  // side CSRF-scrape POST is DEMOTED: it bot-walls on TLS/behavioral fingerprint even though
  // the CSRF token is readable (#98/#103), so with no Browser SPI configured substitute()
  // throws the documented browser-path error rather than replay a dead end. The live write
  // proof (issue acceptance #1) is operator-run against a logged-in session.
  async substitute(jar: Jar, op: Partial<SubstituteOp>): Promise<SubstituteResult> {
    const norm = normalizeSubstitute(op); // shape gate (throws SubstituteDeniedError → 403)
    if (!SPI_URL) {
      throw new Error(
        "amazon cart writes are BROWSER-PATH — the raw server-side CSRF-scrape POST bot-walls on TLS/behavioral fingerprint even though the CSRF token is readable; set BROWSER_SPI_URL (handler env) to drive the in-TEE browser that performs the real signed add + remove (#103)",
      );
    }
    return browserSubstitute(SPI_URL, jar, norm, SPI_SECRET);
  },
};
