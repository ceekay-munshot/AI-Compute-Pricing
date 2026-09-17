/**
 * Cloudflare Pages Function — Pricing / Share Read-Through
 * Route: /api/pricing-share-signal
 * Method: GET
 *
 * Joins two EXISTING sources — no new upstream, no duplicated logic:
 *   1. /api/provider-pricing-matrix?metric=input  — per-provider quarterly
 *      average input $/1M token and pre-computed QoQ%. This is the pricing
 *      source of truth.
 *   2. /api/history?view=daily&range=365           — canonical KV daily
 *      snapshots, each with a top-N OpenRouter rankings array containing
 *      { provider, tokRaw } rows. This is the market-share source of truth.
 *
 * For each day we compute provider token share = provider_tokRaw / total
 * tokRaw_in_snapshot. We then mean those daily shares within each calendar
 * quarter to get a provider-quarter share. Joining (by normalized provider
 * slug) with the pricing matrix yields per-(provider, quarter) rows with
 * priceQoq and shareQoq in the same period.
 *
 * Classification rules (deliberately simple and transparent):
 *   Price regime:
 *     priceQoq <= -0.02  → "cut"
 *     |priceQoq| <  0.02 → "hold"
 *     priceQoq >=  0.02  → "up"
 *   Share regime (absolute percentage-point delta):
 *     shareQoq >=  0.3 pp → "gain"
 *     |shareQoq| < 0.3 pp → "flat"
 *     shareQoq <= -0.3 pp → "loss"
 *
 * Honesty:
 *   - We only return a row for a provider in a quarter when BOTH its price
 *     and its share are observed. Providers outside the OR top-N on every
 *     captured day of a quarter are omitted — never imputed.
 *   - "latestComparable" is the most recent quarter that has both a real
 *     priceQoq AND a real shareQoq computed from real snapshots.
 *   - Upstream source-floor limitations (pricing: 2025-07-28; market share:
 *     whatever the KV index holds) propagate through without fabrication.
 *   - Directional ecosystem read-through. Not a causal claim.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CACHE_TTL = 600; // 10 min

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + CACHE_TTL,
      ...CORS,
    },
  });
}

/**
 * Normalize provider strings between the two sources.
 * Pricing matrix uses: openai, anthropic, google, xai, mistralai, deepseek, meta-llama, cohere.
 * OpenRouter `or[].provider` strings seen historically:
 *   anthropic, google, openai, meta-llama, deepseek, mistralai, x-ai, xai,
 *   cohere, minimax, xiaomi, nvidia, qwen, stepfun, ...
 * We map known aliases and leave others untouched.
 */
function normalizeProviderSlug(s) {
  if (!s) return '';
  const k = String(s).toLowerCase().trim();
  const ALIAS = {
    'x-ai': 'xai',
    'meta': 'meta-llama',
    'mistral-ai': 'mistralai',
    'mistralai': 'mistralai',
    'anthropic': 'anthropic',
    'google': 'google',
    'openai': 'openai',
    'deepseek': 'deepseek',
    'cohere': 'cohere',
    'meta-llama': 'meta-llama',
    'xai': 'xai',
  };
  return ALIAS[k] || k;
}

function quarterOfDate(iso) {
  if (typeof iso !== 'string' || iso.length < 10) return null;
  const y = parseInt(iso.slice(0, 4), 10);
  const m = parseInt(iso.slice(5, 7), 10);
  if (!y || !m) return null;
  return y + '-Q' + (Math.floor((m - 1) / 3) + 1);
}

function priorQuarterKey(key) {
  const m = key && key.match(/^(\d{4})-Q(\d)$/);
  if (!m) return null;
  const y = +m[1], q = +m[2];
  return q === 1 ? (y - 1) + '-Q4' : y + '-Q' + (q - 1);
}

function classifyPrice(qoq) {
  if (typeof qoq !== 'number' || !isFinite(qoq)) return 'unknown';
  if (qoq <= -0.02) return 'cut';
  if (qoq >= 0.02) return 'up';
  return 'hold';
}

function classifyShare(deltaPP) {
  if (typeof deltaPP !== 'number' || !isFinite(deltaPP)) return 'unknown';
  if (deltaPP >= 0.3) return 'gain';
  if (deltaPP <= -0.3) return 'loss';
  return 'flat';
}

/** Human-readable regime label + short interpretation. */
function regimeFor(priceReg, shareReg) {
  const key = priceReg + '|' + shareReg;
  const table = {
    'cut|gain':   { label: 'Price cut → share gain',         note: 'Cut appears to be translating into volume pickup.' },
    'cut|flat':   { label: 'Price cut · no share response',  note: 'Cut not yet converting into share — elasticity weak.' },
    'cut|loss':   { label: 'Price cut + share loss',         note: 'Anomaly — cut did not defend share.' },
    'hold|gain':  { label: 'Price resilient · share gain',   note: 'Pricing power — gaining without cutting.' },
    'hold|flat':  { label: 'Stable price · stable share',    note: 'Status quo; neither side moving.' },
    'hold|loss':  { label: 'Price held · share loss',        note: 'Losing ground without defending on price.' },
    'up|gain':    { label: 'Price up · share gain',          note: 'Strong pricing power — raising and still gaining.' },
    'up|flat':    { label: 'Price up · share flat',          note: 'Price increase absorbed; watch next quarter.' },
    'up|loss':    { label: 'Price up · share loss',          note: 'Weak position — market pushed back on price.' },
  };
  return table[key] || { label: 'Insufficient data', note: '' };
}

async function localFetch(request, path) {
  const origin = new URL(request.url).origin;
  try {
    const r = await fetch(origin + path, {
      headers: { 'User-Agent': 'gdash-pricing-share/1.0' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

export async function onRequestGet({ request }) {
  const [pricing, history] = await Promise.all([
    localFetch(request, '/api/provider-pricing-matrix?metric=input'),
    localFetch(request, '/api/history?view=daily&range=365'),
  ]);

  if (!pricing || !pricing.success) {
    return jsonResp({ success: false, error: 'pricing matrix unavailable' }, 502);
  }
  if (!history || !history.success) {
    return jsonResp({ success: false, error: 'canonical history unavailable' }, 502);
  }

  // ── Per-day per-provider share, then bucket by quarter ──
  // dailyShares[date] = { total, byProvider: { slug: tokRaw } }
  const shareByQuarter = new Map(); // quarterKey -> Map(slug -> [share1, share2, ...])
  for (const s of history.snapshots || []) {
    const arr = Array.isArray(s.or) ? s.or : [];
    if (!arr.length) continue;
    const q = quarterOfDate(s.date);
    if (!q) continue;
    const total = arr.reduce((acc, m) => acc + (+m.tokRaw || 0), 0);
    if (total <= 0) continue;
    // Sum tokRaw per provider in this snapshot (same provider can hold multiple models)
    const perProv = new Map();
    for (const m of arr) {
      const slug = normalizeProviderSlug(m.provider);
      if (!slug) continue;
      perProv.set(slug, (perProv.get(slug) || 0) + (+m.tokRaw || 0));
    }
    let q2p = shareByQuarter.get(q);
    if (!q2p) { q2p = new Map(); shareByQuarter.set(q, q2p); }
    for (const [slug, tok] of perProv) {
      const share = (tok / total) * 100; // percent
      const list = q2p.get(slug) || [];
      list.push(share);
      q2p.set(slug, list);
    }
  }

  // Compute avg share per (quarter, provider)
  const quarterlyShare = new Map(); // quarterKey -> Map(slug -> avgSharePct)
  for (const [q, provMap] of shareByQuarter) {
    const avg = new Map();
    for (const [slug, arr] of provMap) {
      if (!arr.length) continue;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      avg.set(slug, mean);
    }
    quarterlyShare.set(q, avg);
  }

  // ── Walk pricing matrix quarters — pair with share quarters ──
  const pricingProviders = pricing.providers || [];
  const slugToLabel = {};
  for (const p of pricingProviders) slugToLabel[p.slug] = p.label;

  // Find the latest quarter for which we can compute BOTH priceQoq and shareQoq.
  let latestComparable = null;
  const allQuarterRows = []; // { quarter, rows: [...] } newest first

  for (const q of pricing.quarters || []) {
    const prior = priorQuarterKey(q.quarter);
    const priorQuarter = (pricing.quarters || []).find(x => x.quarter === prior);
    const shareNow = quarterlyShare.get(q.quarter);
    const sharePrior = quarterlyShare.get(prior);

    const rows = [];
    for (const c of q.cells || []) {
      const slug = c.slug;
      if (typeof c.avg !== 'number') continue;
      const priorCell = (priorQuarter && priorQuarter.cells.find(x => x.slug === slug)) || null;
      const priceQoq = (typeof c.qoq === 'number') ? c.qoq : null;

      const shareAvg = shareNow && shareNow.get(slug);
      const sharePrev = sharePrior && sharePrior.get(slug);
      const shareQoqPP = (typeof shareAvg === 'number' && typeof sharePrev === 'number')
        ? (shareAvg - sharePrev) : null;

      // We include a provider only if we can characterize BOTH dimensions
      // for THIS quarter. Pure pricing rows (no share observation in this
      // quarter) are skipped — being explicit about what we don't know.
      if (typeof shareAvg !== 'number') continue;

      const priceReg = classifyPrice(priceQoq);
      const shareReg = classifyShare(shareQoqPP);
      const regime   = regimeFor(priceReg, shareReg);

      rows.push({
        slug,
        label: slugToLabel[slug] || slug,
        avg: c.avg,
        avgLabel: c.avgLabel,
        priceQoq,
        priceQoqLabel: (typeof priceQoq === 'number') ? ((priceQoq >= 0 ? '+' : '') + (priceQoq * 100).toFixed(1) + '%') : '—',
        priceReg,
        shareAvg,
        shareAvgLabel: shareAvg.toFixed(1) + '%',
        sharePrev: (typeof sharePrev === 'number') ? sharePrev : null,
        shareQoqPP,
        shareQoqLabel: (typeof shareQoqPP === 'number') ? ((shareQoqPP >= 0 ? '+' : '') + shareQoqPP.toFixed(2) + 'pp') : '—',
        shareReg,
        regimeLabel: regime.label,
        note: regime.note,
        modelCount: c.modelCount || 0,
      });
    }
    if (rows.length) {
      allQuarterRows.push({ quarter: q.quarter, partial: q.partial, rows });
      if (!latestComparable && rows.some(r => typeof r.priceQoq === 'number' && typeof r.shareQoqPP === 'number')) {
        latestComparable = q.quarter;
      }
    }
  }

  // ── Derive ranked callouts for the latest comparable quarter ──
  let callouts = [];
  const latestObj = allQuarterRows.find(x => x.quarter === latestComparable);
  if (latestObj) {
    const r = latestObj.rows.filter(x => typeof x.priceQoq === 'number' && typeof x.shareQoqPP === 'number');

    const by = (fn) => [...r].sort(fn);

    const biggestCut = by((a,b) => a.priceQoq - b.priceQoq)[0];
    if (biggestCut && biggestCut.priceQoq < 0) callouts.push({
      kind: 'biggest_price_cut',
      title: 'Biggest price cut',
      provider: biggestCut.label, slug: biggestCut.slug,
      detail: biggestCut.priceQoqLabel + ' input · share ' + biggestCut.shareQoqLabel,
    });

    const strongestGainer = by((a,b) => b.shareQoqPP - a.shareQoqPP)[0];
    if (strongestGainer && strongestGainer.shareQoqPP > 0) callouts.push({
      kind: 'strongest_share_gain',
      title: 'Strongest share gainer',
      provider: strongestGainer.label, slug: strongestGainer.slug,
      detail: strongestGainer.shareQoqLabel + ' share · price ' + strongestGainer.priceQoqLabel,
    });

    const pricingPower = r
      .filter(x => x.priceReg !== 'cut' && x.shareReg === 'gain')
      .sort((a, b) => b.shareQoqPP - a.shareQoqPP)[0];
    if (pricingPower) callouts.push({
      kind: 'pricing_power',
      title: 'Strongest pricing power',
      provider: pricingPower.label, slug: pricingPower.slug,
      detail: 'Price ' + pricingPower.priceReg + ' (' + pricingPower.priceQoqLabel + '), share ' + pricingPower.shareQoqLabel,
    });

    const weakConv = r
      .filter(x => x.priceReg === 'cut' && x.shareReg !== 'gain')
      .sort((a, b) => a.priceQoq - b.priceQoq)[0];
    if (weakConv) callouts.push({
      kind: 'weak_conversion',
      title: 'Weakest conversion',
      provider: weakConv.label, slug: weakConv.slug,
      detail: 'Cut ' + weakConv.priceQoqLabel + ' · share only ' + weakConv.shareQoqLabel,
    });

    const disconnect = r
      .filter(x => (x.priceReg === 'up' && x.shareReg === 'gain') || (x.priceReg === 'cut' && x.shareReg === 'loss'))
      .sort((a, b) => Math.abs(b.shareQoqPP) - Math.abs(a.shareQoqPP))[0];
    if (disconnect) callouts.push({
      kind: 'anomaly',
      title: 'Biggest disconnect',
      provider: disconnect.label, slug: disconnect.slug,
      detail: 'Price ' + disconnect.priceQoqLabel + ' but share ' + disconnect.shareQoqLabel,
    });

    callouts = callouts.slice(0, 5);
  }

  return jsonResp({
    success: true,
    latestComparable,
    priorComparable: priorQuarterKey(latestComparable),
    quarters: allQuarterRows,
    callouts,
    thresholds: {
      priceCutPct: -2, priceUpPct: 2,
      shareGainPP: 0.3, shareLossPP: -0.3,
    },
    providers: pricingProviders,
    sourceNote:
      'Directional ecosystem read-through · not a causal claim. ' +
      'Pricing QoQ: api.pricepertoken.com provider pricing history (equal-weighted, quarterly). ' +
      'Market share: canonical HISTORY_KV snapshots of OpenRouter top-N by weekly tokens, averaged over observed days per quarter. ' +
      'Providers outside the OR top-N during a quarter are omitted, never imputed.',
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
