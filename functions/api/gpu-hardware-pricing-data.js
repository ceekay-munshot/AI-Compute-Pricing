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

const SOURCE_URL = 'https://getdeploying.com/gpus';

export async function onRequestGet() {
  try {
    const resp = await fetch(SOURCE_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!resp.ok) {
      return json({ ok: false, error: 'upstream_' + resp.status }, 502);
    }

    const html = await resp.text();
    const rows = parseRows(html);
    const sourceUpdatedAt = parseUpdatedAt(html);

    return json(
      {
        ok: true,
        sourceUrl: SOURCE_URL,
        sourceUpdatedAt,
        fetchedAt: new Date().toISOString(),
        count: rows.length,
        rows,
      },
      200,
      'public, max-age=300, s-maxage=600'
    );
  } catch (err) {
    return json({ ok: false, error: err.message || 'parse_error' }, 502);
  }
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
    if (parsed) rows.push(parsed);
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
