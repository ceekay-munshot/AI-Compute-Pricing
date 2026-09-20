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
import { withEdgeCache } from './_edge-cache.js';

const SOURCE_URL = 'https://getdeploying.com/gpus';
const DETAIL_BASE = 'https://getdeploying.com/gpus/';

// This endpoint used to re-scrape a 543 KB page on EVERY request. It now also
// reads one detail page per tracked SKU for board power, which would have made
// that seven fetches per request, so the edge cache is a precondition of the
// feature rather than a nicety. 300 s keeps the path inside the ~5 minute
// freshness budget the README's table already gives it.
const EDGE_TTL = 300;

// Board power is a hardware specification: it changes when a new SKU appears,
// not when a price moves. It rides the same 300 s entry as the prices only
// because it lives in the same payload — there is no separate, longer cache,
// because a second lifetime stacked on this one is exactly the kind of drift
// the Freshness section warns about.
const DETAIL_HEAD_BYTES = 65536;  // the ld+json block sits well inside this
const DETAIL_TIMEOUT_MS = 6000;
// Three at a time. A Worker holds at most six simultaneous outbound
// connections, so 1 list + 3 detail leaves headroom and nothing queues.
const DETAIL_CONCURRENCY = 3;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
  // No query parameter varies this body, so the path alone is the key.
  return withEdgeCache(
    context,
    { params: {}, ttl: EDGE_TTL, browserTtl: 0 },
    () => buildGpuPricing(),
  );
}

async function buildGpuPricing() {
  try {
    const [list, power] = await Promise.all([fetchList(), fetchBoardPower()]);

    if (!list.ok) {
      return json({ ok: false, error: 'upstream_' + list.status }, 502);
    }

    const rows = parseRows(list.html).map(r => withBoardPower(r, power.bySku));
    const sourceUpdatedAt = parseUpdatedAt(list.html);

    // A board-power outage deliberately does NOT mark this no-store. Blank watt
    // cells are the accepted outcome; un-caching the response would instead put
    // a live 543 KB scrape plus six subrequests on every request for as long as
    // the outage lasted, which is worse than the state this replaces. Prices
    // are unaffected — they come from the list page, which succeeded or this
    // line was never reached.
    return json(
      {
        ok: true,
        sourceUrl: SOURCE_URL,
        sourceUpdatedAt,
        fetchedAt: new Date().toISOString(),
        count: rows.length,
        boardPower: { requested: power.requested, resolved: power.resolved, errors: power.errors },
        rows,
      },
      200,
      'public, max-age=300, s-maxage=600'
    );
  } catch (err) {
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
 * { watts, variant } for `expectedSku` from a detail page's JSON-LD, or null.
 *
 * `variant` is getdeploying's own "Specification variant" string where it
 * publishes one (H100 "H100 SXM", A100 "A100 PCIe"; H200, B200, GB200 and L40S
 * publish none today). It is carried because board power is form-factor
 * dependent and the figure cannot be honestly attributed without it.
 *
 * The block body is NOT entity-decoded: inside a <script> the content is raw
 * JSON, and decoding &amp; or &quot; there would corrupt it.
 */
export function boardPowerFromLdJson(html, expectedSku) {
  LD_JSON_RE.lastIndex = 0;
  let m;
  while ((m = LD_JSON_RE.exec(html)) !== null) {
    let doc;
    try { doc = JSON.parse(m[1]); } catch { continue; }
    for (const node of ldNodes(doc)) {
      if (!node || node['@type'] !== 'Product') continue;
      if (!productNameMatches(node.name, expectedSku)) continue;
      if (!offerIsPerGpu(node)) return null;
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
      if (watts == null) return null;
      const v = pick('specification variant');
      return { watts, variant: typeof v === 'string' && v.trim() ? v.trim() : null };
    }
  }
  return null;
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
    if (!resp.ok) return { sku: sku.name, found: null, error: 'http_' + resp.status };
    const found = boardPowerFromLdJson(await readHead(resp, DETAIL_HEAD_BYTES), sku.name);
    return found == null
      ? { sku: sku.name, found: null, error: 'no_board_power' }
      : { sku: sku.name, found, error: null };
  } catch (err) {
    return { sku: sku.name, found: null, error: (err && err.name) || 'fetch_error' };
  }
}

async function fetchBoardPower() {
  const bySku = new Map();
  const errors = [];
  for (let i = 0; i < GPU_TRACKED_SKUS.length; i += DETAIL_CONCURRENCY) {
    const batch = GPU_TRACKED_SKUS.slice(i, i + DETAIL_CONCURRENCY);
    const settled = await Promise.all(batch.map(fetchOneBoardPower));
    for (const r of settled) {
      if (r.found) bySku.set(r.sku, r.found);
      else errors.push({ sku: r.sku, error: r.error });
    }
  }
  return { bySku, requested: GPU_TRACKED_SKUS.length, resolved: bySku.size, errors };
}

function withBoardPower(row, bySku) {
  const found = bySku.get(row.gpuModel) || null;
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
