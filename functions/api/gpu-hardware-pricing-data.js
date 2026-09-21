/**
 * Cloudflare Pages Function — GetDeploying GPU Pricing Parser
 * Route: /api/gpu-hardware-pricing-data
 * Method: GET
 *
 * Fetches https://getdeploying.com/gpus (same SSR Django page used by the
 * live iframe reverse-proxy embed) and parses the pre-rendered GPU table
 * rows into normalized JSON. Used by the GPU Hardware Pricing tab to
 * render KPI summary cards and the strategic comparison table above the
 * live embed.
 *
 * Parsing strategy — regex against each `<tr data-gpu …>` block:
 *   - data-* attributes give us name, vram (GB), minprice (USD/hr),
 *     providers (count), segment (HIGH_PERFORMANCE | MID_RANGE | BUDGET),
 *     default (original sort order).
 *   - Max price lives in the 3rd <td> as a second "$…" span; parsed by
 *     extracting all "$<number>" occurrences from that cell and taking the
 *     last one when different from the min.
 *   - VRAM cell text (e.g. "80GB HBM3", "40GB / 80GB HBM2e") is captured
 *     from the 2nd <td>.
 *   - Vendor slug comes from the row's /gpus/<slug> href, prefix before
 *     the first hyphen (nvidia-h100 → nvidia). Resilient to additions.
 *
 * Anchoring on `data-*` attributes (not class names or DOM position)
 * makes the parser resilient to presentation tweaks upstream.
 */

// The source has published this listing three different ways and the price moved
// between fields each time. _gpu-price-basis.js is the single rule for which field
// holds today's measure and what that measure IS; the history endpoint normalizes
// with it on the way in for exactly the same reason. Resolving here means the live
// table, the KPI cards and the workbook cannot drift into three different answers.
import { normalizeDailyPoint } from './_gpu-price-basis.js';
import { GPU_TRACKED_SKUS } from './_gpu-tracked-skus.js';
import { withEdgeCache, schemaCacheKey } from './_edge-cache.js';

const SOURCE_URL = 'https://getdeploying.com/gpus';
const DETAIL_BASE = 'https://getdeploying.com/gpus/';

// This endpoint used to re-scrape a 543 KB page on EVERY request. It now also
// reads one detail page per tracked SKU for board power, which would have made
// that seven fetches per request, so the edge cache is a precondition of the
// feature rather than a nicety. 300 s keeps the path inside the ~5 minute
// freshness budget the README's table already gives it.
const EDGE_TTL = 300;

// Board power is a hardware specification: it changes when a new SKU appears,
// not when a price moves. Each model's figure is kept in its own entry (see
// POWER_TTL below) and copied into this 300 s payload on every build, so a
// wattage can be up to a week old while the price beside it is minutes old.
// That is acceptable for a nameplate rating and is why the Freshness table's
// 5-minute figure speaks for the prices only.
const DETAIL_HEAD_BYTES = 65536;  // the ld+json block sits well inside this
const DETAIL_TIMEOUT_MS = 6000;
// Three at a time. A Worker holds at most six simultaneous outbound
// connections, so 1 list + 3 detail leaves headroom and nothing queues.
const DETAIL_CONCURRENCY = 3;

// Board power is wanted for every model in the listing — 107 of them — and it
// only exists on each model's own page. Fetching 107 pages per cache miss is
// not an option: the source rate-limits, and a burst like that returns 403 for
// EVERY page including the listing, which would take the whole GPU tab down
// rather than just the watt column (observed first-hand while building this).
// Cloudflare also caps a request's outbound subrequests.
//
// So the figures accumulate instead. Each miss tops up a few models and each
// result is cached on its own for a week, with the strategic SKUs filled first
// so the rows people actually look at are never the ones waiting. There is NO
// fixed time by which every model carries a wattage: caches.default is per
// Cloudflare location, so each location fills its own copy, and only on its
// own misses — one with steady traffic fills within hours, a quiet one can take
// days. That is why every row says which state it is in (boardPowerStatus)
// instead of leaving a blank for the reader to guess at.
const DETAIL_PER_REQUEST = 6;
const POWER_TTL = 7 * 24 * 3600;

// A page that WAS read and carries no usable figure is remembered too. Before
// this it was never cached, so it was refetched on every miss, and six such
// models at the top of the fill order would take every top-up slot forever and
// starve every model below them. A day rather than a week, so a figure the
// source adds later still turns up. Only a verdict about the page's CONTENT is
// remembered — a refusal, a timeout or a page that is not recognisably a card
// page says nothing about the card and is retried (see absenceIsCacheable).
const NO_POWER_TTL = 24 * 3600;

// getdeploying rate-limits, and when it does it answers 403 to EVERYTHING,
// including the listing — observed repeatedly while this was being built. The
// old behaviour on that was a 502 and an empty GPU tab. Prices that are a few
// minutes old are worth far more to a reader than no prices at all, so the last
// good listing is kept for a day and served when the source refuses, labelled
// as stale rather than passed off as current.
const LAST_GOOD_TTL = 24 * 3600;

// A fallback listing must never be stored in the edge cache. Stored, it would
// replay for the full EDGE_TTL after the source recovered — old prices
// outliving the outage that was their only excuse — and every replay would
// carry the servedAt of the first one. `private` is what keeps it out:
// storable() in _edge-cache.js refuses a private response, so withEdgeCache
// hands it back untouched, headers included, and puts nothing. The reader's
// own browser may still keep it for a minute, which bounds how often one
// reader can send us to a source that is refusing us. Pinned by
// __tests__/gpu-stale-fallback.test.mjs.
const FALLBACK_CACHE_CONTROL = 'private, max-age=60';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
  // No query parameter varies this body, so the path alone is the key.
  return withEdgeCache(
    context,
    { params: {}, ttl: EDGE_TTL, browserTtl: 0 },
    () => buildGpuPricing(context),
  );
}

// Versioned with the edge cache's schema: this copy is served under whatever
// labels the current code prints, so it must be abandoned whenever the payload
// changes shape, exactly as the response entries are.
function lastGoodKey(baseUrl) {
  return schemaCacheKey(baseUrl, '/__gpu-listing-last-good');
}

// The most recent listing that parsed, or null. Never throws: a failure to read
// the fallback must not turn a degraded response into no response.
async function readLastGood(baseUrl) {
  try {
    const hit = await caches.default.match(lastGoodKey(baseUrl));
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

async function buildGpuPricing(context) {
  try {
    const list = await fetchList();

    if (!list.ok) {
      // Serve the last good listing rather than an empty tab. It is marked
      // stale and carries the time it was captured, so nothing here presents
      // old prices as current.
      const stale = await readLastGood(context.request.url);
      if (stale) {
        return json(
          { ...stale, stale: true, staleReason: 'upstream_' + list.status, servedAt: new Date().toISOString() },
          200,
          FALLBACK_CACHE_CONTROL,
        );
      }
      return json({ ok: false, error: 'upstream_' + list.status }, 502);
    }

    // Board power needs the parsed rows to know which models exist at all, so
    // it runs after the listing rather than alongside it.
    const parsed = parseRows(list.html);
    const power = await fetchBoardPower(context, parsed);
    const rows = parsed.map(r => withBoardPower(r, power));
    const sourceUpdatedAt = parseUpdatedAt(list.html);

    // A board-power outage deliberately does NOT mark this no-store. Blank watt
    // cells are the accepted outcome; un-caching the response would instead put
    // a live 543 KB scrape plus six subrequests on every request for as long as
    // the outage lasted, which is worse than the state this replaces. Prices
    // are unaffected — they come from the list page, which succeeded or this
    // line was never reached.
    const payload = {
        ok: true,
        sourceUrl: SOURCE_URL,
        sourceUpdatedAt,
        fetchedAt: new Date().toISOString(),
        count: rows.length,
        // Operator-facing only; nothing here is rendered. One count per
        // boardPowerStatus, for the Cloudflare location that built this
        // response — another location can be further along or further behind.
        // `errors` lists only the reads attempted in this build.
        boardPower: { ...countBoardPowerStatus(rows), total: rows.length, errors: power.errors },
        rows,
    };

    // Keep this as the fallback for the next time the source refuses. Stored
    // only when rows actually parsed, so an empty parse can never become the
    // thing we fall back to.
    if (rows.length) {
      context.waitUntil(caches.default.put(
        lastGoodKey(context.request.url),
        new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + LAST_GOOD_TTL },
        }),
      ));
    }

    return json(payload, 200, 'public, max-age=300, s-maxage=600');
  } catch (err) {
    const stale = await readLastGood(context.request.url);
    if (stale) {
      return json(
        { ...stale, stale: true, staleReason: err.message || 'parse_error', servedAt: new Date().toISOString() },
        200,
        FALLBACK_CACHE_CONTROL,
      );
    }
    return json({ ok: false, error: err.message || 'parse_error' }, 502);
  }
}

async function fetchList() {
  const resp = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!resp.ok) return { ok: false, status: resp.status, html: '' };
  return { ok: true, status: resp.status, html: await resp.text() };
}

/* ─────────────────────────────────────────────────────────────────────
   BOARD POWER

   getdeploying publishes board power as schema.org JSON-LD on each GPU's
   detail page, and not at all on the list page. Reading it rather than
   hard-coding a table means the figure is attributable and moves when the
   source moves — the alternative was a constant in this repo that would
   silently rot, and whose A100 value a human would very likely have written
   as the 400 W SXM part when getdeploying publishes the 300 W PCIe one.

   Every failure path here lands on a blank cell. None of them may produce a
   number, and none of them may fail the request: prices come from the list
   page and must survive a detail-page outage untouched.
   ───────────────────────────────────────────────────────────────────── */

const LD_JSON_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// Every page wraps its nodes in @graph — a parser reading the root as a
// Product matches nothing. Verified on all six pages: the root keys are
// ["@context","@graph"] with BreadcrumbList, Product and FAQPage inside.
function ldNodes(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc['@graph'])) return doc['@graph'];
  return doc ? [doc] : [];
}

// Values arrive as strings with a unit and a thousands separator: "700 W",
// "1,000 W". Anything that is not <number> W is refused rather than coerced.
export function parseWatts(value) {
  if (typeof value !== 'string') return null;
  const m = /^\s*([\d,]+(?:\.\d+)?)\s*W\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// getdeploying names these "Nvidia H100 Cloud GPU" (verified on all six).
// Accept that exact shape and nothing else. A prefix test is NOT enough: this
// upstream publishes a specification variant per page, so a slug that ever
// resolved to "Nvidia H100 NVL Cloud GPU" would pass startsWith and staple the
// NVL board power onto the H100 median price — a wrong number under a right
// label, which is the one failure this repo refuses.
const PRODUCT_SUFFIX = ' Cloud GPU';
export function productNameMatches(name, expectedSku) {
  if (typeof name !== 'string') return false;
  const bare = name.endsWith(PRODUCT_SUFFIX) ? name.slice(0, -PRODUCT_SUFFIX.length) : name;
  return bare.trim() === expectedSku;
}

// The price is per GPU ("USD per GPU per hour, on-demand" on every page). The
// derived $/kW divides by a per-GPU wattage, so if the upstream ever changes
// that basis — to a per-node or per-superchip price — the division silently
// rescales. GB200 is the live example: 1,200 W is its per-GPU figure while the
// superchip is ~2,700 W. So the basis is checked, and a page that stops saying
// per GPU yields no watts at all rather than a quietly halved ratio.
const PER_GPU_OFFER = 'usd per gpu per hour';
function offerIsPerGpu(node) {
  const offers = node && node.offers;
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  return list.some(o => String((o && o.description) || '').toLowerCase().startsWith(PER_GPU_OFFER));
}

/**
 * Board power for `expectedSku` from a detail page's JSON-LD, and why not.
 *
 * Returns { found, reason }. `found` is { watts, variant } or null; when it is
 * null, `reason` says which of four things happened, because they do not mean
 * the same thing:
 *
 *   other_card      the page is a card page (it has a Product) but for a
 *                   different card name — see productNameMatches
 *   not_per_gpu     this card's Product is there, but its price is not per GPU
 *   no_board_power  this card's Product is there, per GPU, with no "<n> W"
 *                   board power
 *   not_card_page   no Product at all: no JSON-LD, unparseable JSON-LD, or only
 *                   site-wide nodes. That is what a challenge page, an error
 *                   page or a truncated read looks like, as much as any real
 *                   page, so it is evidence of nothing about the card.
 *
 * The first three are the source's own content and read the same on the next
 * fetch; the last is not. absenceIsCacheable is the one rule built on that.
 *
 * `variant` is getdeploying's own "Specification variant" string where it
 * publishes one (H100 "H100 SXM", A100 "A100 PCIe"; H200, B200, GB200 and L40S
 * publish none today). It is carried because board power is form-factor
 * dependent and the figure cannot be honestly attributed without it.
 *
 * The block body is NOT entity-decoded: inside a <script> the content is raw
 * JSON, and decoding &amp; or &quot; there would corrupt it.
 */
export function readBoardPower(html, expectedSku) {
  LD_JSON_RE.lastIndex = 0;
  let sawProduct = false;
  let m;
  while ((m = LD_JSON_RE.exec(html)) !== null) {
    let doc;
    try { doc = JSON.parse(m[1]); } catch { continue; }
    for (const node of ldNodes(doc)) {
      if (!node || node['@type'] !== 'Product') continue;
      sawProduct = true;
      if (!productNameMatches(node.name, expectedSku)) continue;
      if (!offerIsPerGpu(node)) return { found: null, reason: 'not_per_gpu' };
      const props = Array.isArray(node.additionalProperty) ? node.additionalProperty : [];
      const pick = (wanted) => {
        for (const p of props) {
          if (!p || p['@type'] !== 'PropertyValue') continue;
          if (String(p.name == null ? '' : p.name).trim().toLowerCase() !== wanted) continue;
          return p.value;
        }
        return null;
      };
      const watts = parseWatts(pick('board power'));
      if (watts == null) return { found: null, reason: 'no_board_power' };
      const v = pick('specification variant');
      return { found: { watts, variant: typeof v === 'string' && v.trim() ? v.trim() : null }, reason: null };
    }
  }
  return { found: null, reason: sawProduct ? 'other_card' : 'not_card_page' };
}

/** { watts, variant } for `expectedSku`, or null. readBoardPower without the reason. */
export function boardPowerFromLdJson(html, expectedSku) {
  return readBoardPower(html, expectedSku).found;
}

// The one rule for which failed reads may be remembered (for NO_POWER_TTL).
// An allowlist, so anything not named here — http_403, http_429, any other
// status, TimeoutError, AbortError, fetch_error, not_card_page, and whatever
// new failure appears next — is retried rather than cached. Remembering a
// refusal would tell readers for a day that the source publishes nothing, on
// the strength of a rate limit.
const CACHEABLE_ABSENCE = new Set(['other_card', 'not_per_gpu', 'no_board_power']);
export function absenceIsCacheable(reason) {
  return CACHEABLE_ABSENCE.has(reason);
}

// How this source says "too many requests". Once it has said it, every other
// page this top-up asks for is refused too, and asking anyway deepens a limit
// that takes the listing down with it.
function isRefusal(error) {
  return error === 'http_403' || error === 'http_429';
}

// Read only the head of the document: the ld+json block sits early and the
// pages are ~800 KB.
async function readHead(resp, maxBytes) {
  // Fall back to a full read rather than losing the field — if getReader() or
  // cancel() behaves differently on the Workers runtime than in Node, the cost
  // is bandwidth, not six blank cells.
  let reader;
  try {
    if (!resp.body) return await resp.text();
    reader = resp.body.getReader();
  } catch {
    return await resp.text();
  }
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder('utf-8').decode(buf);
}

async function fetchOneBoardPower(sku) {
  try {
    const resp = await fetch(DETAIL_BASE + sku.slug, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
    });
    if (!resp.ok) return { sku: sku.name, slug: sku.slug, found: null, error: 'http_' + resp.status };
    const { found, reason } = readBoardPower(await readHead(resp, DETAIL_HEAD_BYTES), sku.name);
    return { sku: sku.name, slug: sku.slug, found, error: found ? null : reason };
  } catch (err) {
    return { sku: sku.name, slug: sku.slug, found: null, error: (err && err.name) || 'fetch_error' };
  }
}

// Board power is cached per model, on our own origin, so one model's figure
// survives independently of the listing response it happened to arrive with.
//
// Deliberately NOT versioned with CACHE_SCHEMA. A positive entry is still
// exactly { watts, variant }, and a bump would throw away a week of reads at
// every location and refetch them all from a source that answers bursts with
// 403. The negative entry added alongside it, { unpublished: true }, is new and
// has no watts, so code that predates it reads it as a miss and refetches —
// harmless in either direction.
function powerCacheKey(baseUrl, slug) {
  return new Request(new URL('/__board-power/' + encodeURIComponent(slug), baseUrl).toString(), { method: 'GET' });
}

function putPower(cache, baseUrl, slug, entry, ttl) {
  return cache.put(powerCacheKey(baseUrl, slug), new Response(JSON.stringify(entry), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl },
  }));
}

function slugFromDetailUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /\/gpus\/([^/?#]+)/.exec(url);
  return m ? m[1] : null;
}

/**
 * Board power for as many models as are already known, plus a few fresh ones.
 *
 * Returns { bySku, unpublished, failed, errors }: figures keyed by gpuModel,
 * the models whose page was read and gives no usable figure, and the models
 * whose read failed in THIS build. Every other model is simply not read yet.
 * None of the three is ever a guess, and none is a reason to fail the listing.
 * boardPowerStatus turns them into one answer per row.
 */
export async function fetchBoardPower(context, rows) {
  const cache = caches.default;
  const baseUrl = context.request.url;
  const bySku = new Map();
  const unpublished = new Set();
  const failed = new Set();
  const errors = [];

  // Fill order: the strategic SKUs first, then the models the most providers
  // offer. A reader scanning the top of the table should not be the one
  // looking at blanks while an obscure card gets its figure.
  const priority = new Map(GPU_TRACKED_SKUS.map((s, i) => [s.name, i]));
  const candidates = rows
    .filter(r => slugFromDetailUrl(r.detailUrl))
    .sort((a, b) => {
      const pa = priority.has(a.gpuModel) ? priority.get(a.gpuModel) : 1e6;
      const pb = priority.has(b.gpuModel) ? priority.get(b.gpuModel) : 1e6;
      if (pa !== pb) return pa - pb;
      return (b.providerCount || 0) - (a.providerCount || 0);
    });

  const misses = [];
  for (const row of candidates) {
    const slug = slugFromDetailUrl(row.detailUrl);
    let hit = null;
    try { hit = await cache.match(powerCacheKey(baseUrl, slug)); } catch { hit = null; }
    if (hit) {
      try {
        const entry = await hit.json();
        if (entry && typeof entry.watts === 'number') { bySku.set(row.gpuModel, entry); continue; }
        // Remembered as unpublished: skipped, so it no longer takes a top-up
        // slot from the models below it.
        if (entry && entry.unpublished === true) { unpublished.add(row.gpuModel); continue; }
      } catch { /* fall through to a refetch */ }
    }
    misses.push({ name: row.gpuModel, slug });
  }

  const topUp = misses.slice(0, DETAIL_PER_REQUEST);
  for (let i = 0; i < topUp.length; i += DETAIL_CONCURRENCY) {
    const batch = topUp.slice(i, i + DETAIL_CONCURRENCY);
    const settled = await Promise.all(batch.map(sku => fetchOneBoardPower(sku)));
    let refused = false;
    for (const r of settled) {
      if (r.found) {
        bySku.set(r.sku, r.found);
        context.waitUntil(putPower(cache, baseUrl, r.slug, r.found, POWER_TTL));
        continue;
      }
      errors.push({ sku: r.sku, error: r.error });
      if (absenceIsCacheable(r.error)) {
        unpublished.add(r.sku);
        context.waitUntil(putPower(cache, baseUrl, r.slug, { unpublished: true }, NO_POWER_TTL));
      } else {
        // Not cached: the next miss tries it again, first in line.
        failed.add(r.sku);
        if (isRefusal(r.error)) refused = true;
      }
    }
    // The source is rate-limiting. The models not yet tried stay pending for
    // the next miss rather than being fired into a refusal.
    if (refused) break;
  }

  return { bySku, unpublished, failed, errors };
}

/**
 * Why a row does or does not carry board power — one answer per row, decided
 * here so that nothing downstream infers it from a blank. A blank used to be
 * described to readers as "no rated board power published for this card" when
 * most blanks were cards that simply had not been read yet.
 *
 *   known        a figure is attached
 *   pending      not read yet by the Cloudflare location that built this
 *                response (never read there, its entry expired, or this
 *                build stopped early on a refusal); nothing is known either way
 *   unpublished  the card's page was read and gives no board power usable with
 *                a per-GPU price (see absenceIsCacheable)
 *   failed       read in this build and the source refused, timed out, or
 *                returned something that is not a card page; retried next miss
 *   no_page      the listing links no page for this card, so there is nothing
 *                to read
 */
export function boardPowerStatus(row, power) {
  const name = row && row.gpuModel;
  if (power.bySku.has(name)) return 'known';
  if (!slugFromDetailUrl(row && row.detailUrl)) return 'no_page';
  if (power.unpublished.has(name)) return 'unpublished';
  if (power.failed.has(name)) return 'failed';
  return 'pending';
}

function countBoardPowerStatus(rows) {
  const counts = { known: 0, pending: 0, unpublished: 0, failed: 0, no_page: 0 };
  for (const r of rows) counts[r.boardPowerStatus] += 1;
  return counts;
}

function withBoardPower(row, power) {
  const found = power.bySku.get(row.gpuModel) || null;
  const watts = found ? found.watts : null;
  const price = row.dailyPrice;
  return {
    ...row,
    // Board power exactly as published by getdeploying on this SKU's page.
    boardPowerWatts: watts,
    // getdeploying's own "Specification variant", or null where it publishes
    // none. Board power is form-factor dependent — their A100 page says
    // "A100 PCIe" at 300 W where SXM is 400 W, their H100 page says "H100 SXM"
    // — so this is what lets the UI attribute the figure rather than a comment
    // in this file asserting it once and rotting.
    boardPowerVariant: found ? found.variant : null,
    // Why boardPowerWatts is or is not set — see boardPowerStatus. The table
    // words each blank cell from this rather than assuming one reason for all.
    boardPowerStatus: boardPowerStatus(row, power),
    // $/hr per kilowatt of RATED board power: the hourly rental price of a unit
    // of installed power capacity. NOT an electricity cost, and nothing
    // downstream may label it as one. Both sides denominate one GPU, checked
    // rather than assumed (see offerIsPerGpu).
    pricePerKilowattHour:
      price != null && watts != null ? Math.round((price / (watts / 1000)) * 100) / 100 : null,
  };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

/* ─── Row extraction ──────────────────────────────────────────────────
   getdeploying.com has served two different layouts for this listing, and
   the capture must survive both:

     legacy  <tr data-gpu ... data-minprice="0.40" data-providers="48">
             with <td> cells whose price cell read "$0.07 - $14.90"
     current <article data-gpu ... data-price="3.39" data-providers="53">
             a card that publishes a single MEDIAN price and no range

   The switch to cards silently emptied this parser (it split on
   `<tr data-gpu`, which stopped matching), and an earlier rename of
   data-minprice → data-price had already nulled every min price. Both
   markers are matched now, and every field falls back to text extraction
   so a presentation change degrades one field instead of the whole feed.  */
function parseRows(html) {
  const rows = [];
  // `data-gpu` is the stable marker across both layouts; capture the element
  // name so we know which closing tag ends the block.
  const opener = /<(article|tr|div)\s+data-gpu\b/gi;
  let m;
  while ((m = opener.exec(html)) !== null) {
    const closeTag = '</' + m[1].toLowerCase() + '>';
    const rest = html.slice(m.index);
    const end = rest.toLowerCase().indexOf(closeTag);
    const block = end === -1 ? rest : rest.slice(0, end);
    const parsed = parseRow(block);
    // minPricePerHour / maxPricePerHour / medianPricePerHour are left exactly as
    // parsed — the raw capture stays the evidence — and dailyBasis records which
    // of them the headline came from.
    if (parsed) rows.push(normalizeDailyPoint(parsed));
  }
  return rows;
}

function parseRow(row) {
  const name = attr(row, 'data-name');
  if (!name) return null;

  const segment = attr(row, 'data-segment') || null;
  const vramNumRaw = attr(row, 'data-vram');
  const providersRaw = attr(row, 'data-providers');
  const defaultRaw = attr(row, 'data-default');

  // Vendor from /gpus/<slug>
  const slugMatch = row.match(/href="\/gpus\/([a-z0-9-]+)"/i);
  const slug = slugMatch ? slugMatch[1] : null;
  const vendor = slug ? slug.split('-')[0] : firstWord(name).toLowerCase();

  const text = visibleText(row);

  // ── Price ───────────────────────────────────────────────────────────
  // Two different meanings have lived in these attributes, so they are
  // kept as two different fields rather than folded together:
  //   data-minprice → the cheapest listing  (legacy layout)
  //   data-price    → the MEDIAN listing    (current layout; the sort
  //                   control labels it "Cheapest median")
  // Conflating them would splice a floor series onto a median series
  // mid-history and silently change what the number means.
  const legacyMin = num(attr(row, 'data-minprice'));
  const currentPrice = num(attr(row, 'data-price'));
  const isMedianLayout = legacyMin == null && currentPrice != null;

  const medianPricePerHour = isMedianLayout ? round4(currentPrice)
    : round4(num(textAfter(text, /median(?:\s+price)?\s*\$?\s*/i)));

  // Legacy cells carried "$min - $max"; cards publish a single figure. A
  // range is only inferred from an explicit "$X - $Y" pair, never from "this
  // block happens to contain two dollar signs" — a sponsor slot or a config
  // line inside a card would otherwise be read as a price range.
  const cell = priceCellText(row);
  const range = matchRange(cell || text);
  const priceNums = dollarValues(cell);
  const minPrice = legacyMin != null ? legacyMin : (range ? range[0] : null);
  const maxPrice = range ? range[1]
    : (minPrice != null && priceNums.length === 1 ? priceNums[0] : null);

  return {
    gpuModel: name,
    vendor,
    slug,
    // Legacy rows carried the spec in the 2nd <td>; cards put it in the
    // heading. Prefer the cell when it exists so the old layout is unchanged.
    vram: (extractTds(row)[1] ? stripTags(extractTds(row)[1]).replace(/\s+/g, ' ').trim() : null)
          || vramText(text, name, attr(row, 'data-vram')),
    vramGB: num(vramNumRaw),
    minPricePerHour: minPrice,
    maxPricePerHour: (maxPrice != null && minPrice != null && maxPrice < minPrice) ? null : maxPrice,
    medianPricePerHour,
    providerCount: int(providersRaw),
    category: normalizeSegment(segment),
    segmentRaw: segment,
    defaultRank: int(defaultRaw),
    detailUrl: slug ? 'https://getdeploying.com/gpus/' + slug : null,
  };
}

function round4(v) {
  if (v == null || !isFinite(v)) return null;
  return +v.toFixed(4);
}

function visibleText(block) {
  return stripTags(block).replace(/\s+/g, ' ').trim();
}

// Legacy layout only: the 3rd <td> held the price range. Returns null on the
// card layout, where the caller falls back to the card's own text.
function priceCellText(row) {
  const tds = extractTds(row);
  return tds[2] ? stripTags(tds[2]) : null;
}

// Explicit "$1.23 - $45.60" (any dash/en-dash, optional "to"). Returns
// [min, max] or null.
function matchRange(text) {
  if (!text) return null;
  const m = /\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:-|–|—|to)\s*\$\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (!isFinite(a) || !isFinite(b)) return null;
  return [Math.min(a, b), Math.max(a, b)];
}

function dollarValues(text) {
  if (!text) return [];
  const out = [];
  const re = /\$\s*([0-9]+(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(parseFloat(m[1]));
  return out;
}

function textAfter(text, re) {
  if (!text) return null;
  const m = re.exec(text);
  if (!m) return null;
  const tail = text.slice(m.index + m[0].length);
  const n = /^([0-9]+(?:\.[0-9]+)?)/.exec(tail);
  return n ? n[1] : null;
}

// "Nvidia H100 80GB HBM3 · Q3 2022 …" → "80GB HBM3". Falls back to the
// numeric data-vram attribute when the heading is not in that shape.
function vramText(text, name, vramAttr) {
  if (text && name && text.startsWith(name)) {
    const after = text.slice(name.length).trim();
    const spec = after.split('·')[0].trim();
    if (spec && /\d/.test(spec) && spec.length <= 40) return spec;
  }
  const n = num(vramAttr);
  return n != null ? Math.round(n) + 'GB' : null;
}

function normalizeSegment(seg) {
  if (!seg) return null;
  const map = {
    // Current upstream vocabulary
    DATACENTER: 'Data Center',
    WORKSTATION: 'Workstation',
    CONSUMER: 'Consumer',
    // Legacy vocabulary — kept so historical snapshots keep their labels
    HIGH_PERFORMANCE: 'High Performance',
    MID_RANGE: 'Mid-Range',
    BUDGET: 'Budget',
  };
  return map[seg] || seg;
}

function attr(chunk, name) {
  // Match data-name="…" allowing extra whitespace; stop at the first ".
  const re = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i');
  const m = chunk.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function extractTds(row) {
  const out = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(row)) !== null) {
    out.push(m[1]);
    if (out.length >= 6) break;
  }
  return out;
}


function parseUpdatedAt(html) {
  // Header markup:
  //   <p class="text-muted-foreground body-2">
  //     <span>Updated April 21, 2026</span>
  const m = html.match(/Updated\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/);
  if (!m) return null;
  const iso = toIsoDate(m[1]);
  return { text: m[1], iso };
}

function toIsoDate(str) {
  // "April 21, 2026" → "2026-04-21"
  const d = new Date(str + ' UTC');
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

function int(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return isFinite(n) ? n : null;
}

function firstWord(s) {
  return (s || '').trim().split(/\s+/)[0] || '';
}

function json(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'Access-Control-Allow-Origin': '*',
    },
  });
}
