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
 *      { rank, provider, tokRaw } rows. This is the market-share source of
 *      truth.
 *
 * Which days count (see uncountedReason): a day counts only if it is a real
 * capture (not a gap-fill copy of a later one), its list is a MODEL ranking
 * (at least half its rows name a model maker), and the list is complete
 * (ranks run 1..N with none missing).
 *
 * Share of a day: provider tokens / total tokens over the top `depth` rows,
 * where `depth` is the shortest counted list — so a 30-row day and a 10-row
 * day both measure "share of the top 10", not two different things. On a
 * counted day a provider with no row in that top `depth` has a share of
 * exactly zero: the list is complete, so its absence is an observation.
 *
 * Share of a quarter: the mean of the daily shares over EVERY counted day of
 * the quarter — one day-set for every provider. Joining (by normalized
 * provider slug) with the pricing matrix yields per-(provider, quarter) rows
 * with priceQoq and shareQoq in the same period.
 *
 * Classification rules (deliberately simple and transparent):
 *   Price regime:
 *     priceQoq <= -0.02  → "cut"
 *     |priceQoq| <  0.02 → "hold"
 *     priceQoq >=  0.02  → "up"
 *     refused            → "measure_changed" — the pricing matrix declined to
 *                          compare the quarters because the source changed
 *                          what it reports between them. No price read is
 *                          made, and no price callout can name the provider.
 *   Share regime (absolute percentage-point delta):
 *     shareQoq >=  0.3 pp → "gain"
 *     |shareQoq| < 0.3 pp → "flat"
 *     shareQoq <= -0.3 pp → "loss"
 *
 * Honesty:
 *   - We only return a row for a provider in a quarter when BOTH its price
 *     and its share are observed. A provider with no model in the top
 *     `depth` on any counted day of a quarter gets no row and no share —
 *     never an imputed one — and is named in that quarter's `notInTopN` when
 *     it had a share the quarter before, so it does not vanish silently.
 *   - "latestComparable" is the most recent quarter that has both a real
 *     priceQoq AND a real shareQoq computed from counted days.
 *   - Upstream source-floor limitations (pricing: 2025-07-28; market share:
 *     whatever the KV index holds) propagate through without fabrication.
 *   - Directional ecosystem read-through. Not a causal claim.
 */

import { isRealSnapshot } from './gpu-hardware-pricing-history.js';
import { isAttributedRanking } from './openrouter.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CACHE_TTL = 600; // 10 min

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + CACHE_TTL,
      ...CORS,
      ...extraHeaders,
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

/** A snapshot's ranking rows in rank order. A row with no rank sorts first as 0. */
function rankedRows(snapshot) {
  const arr = Array.isArray(snapshot && snapshot.or) ? snapshot.or : [];
  return [...arr].sort((a, b) => (+a.rank || 0) - (+b.rank || 0));
}

/**
 * Why a day's ranking is not counted toward market share, or null if it is.
 * Every test reads what the capture itself recorded — never a list of names.
 *
 *   'backfill'          The capture job marks the copies it writes to fill a
 *                       gap. Each is the later capture's list re-dated, not a
 *                       second observation; the GPU history reader already
 *                       leaves them out, by this same rule.
 *   'notModelRanking'   Fewer than half the rows name a model maker. The
 *                       capture files a row it cannot attribute under
 *                       "other"; from 2026-08-18 to 09-15 it stored
 *                       OpenRouter's Top Apps table ("Kilo Code", "Cline"),
 *                       one app of which ("DeepSeek Harness") it attributed
 *                       to deepseek. Same test the capture now applies before
 *                       it stores a ranking at all.
 *   'incompleteRanking' Ranks do not run 1..N. Only in a complete list does a
 *                       provider's absence mean it was outside the top N,
 *                       which is what lets an absent day count as zero share.
 */
function uncountedReason(snapshot, rows) {
  if (!isRealSnapshot(snapshot)) return 'backfill';
  if (!isAttributedRanking(rows)) return 'notModelRanking';
  if (!rows.every((m, i) => +m.rank === i + 1)) return 'incompleteRanking';
  return null;
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

// A provider whose price change the matrix refused because the source changed
// what it reports between the two quarters. Deliberately outside the 3x3
// table: no price regime applies, so no read-through is claimed.
const TOO_FEW_MATCHED_REGIME = {
  label: 'Too few models to compare',
  note: 'The provider\'s lineup changed too much between the two quarters for a like-for-like price change, so none is computed and no price read is made.',
};

const MEASURE_CHANGED_REGIME = {
  label: 'Price measure changed',
  note: 'The source changed how it reports this provider\'s prices between the two quarters, so the price change is not computed and no price read is made.',
};

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

  // The matrix fans out to eight providers and reports `degraded` when any of
  // them came back with an error; it marks its OWN response no-store so a
  // partial answer is never replayed. This endpoint used to check only
  // `success`, so a provider that failed simply had no cells, was dropped
  // silently below, and the callouts were then ranked over the survivors --
  // published for ten minutes as if the fan-out had been whole.
  const pricingDegraded = pricing.degraded === true;
  const pricingProviderErrors = pricing.providerErrors || null;

  // ── Which days count (see uncountedReason) ──
  const counted = []; // { q, rows } — rows in rank order
  const excludedDays = { backfill: 0, notModelRanking: 0, incompleteRanking: 0 };
  for (const s of history.snapshots || []) {
    const rows = rankedRows(s);
    if (!rows.length) continue;
    const q = quarterOfDate(s.date);
    if (!q) continue;
    const why = uncountedReason(s, rows);
    if (why) { excludedDays[why]++; continue; }
    counted.push({ q, rows });
  }
  // Every day is read to the same depth: the shortest counted list. A longer
  // list's first `depth` rows are, by its own ranking, that day's top `depth`.
  const depth = counted.length ? Math.min(...counted.map(c => c.rows.length)) : 0;

  // ── Per-day per-provider share of the top `depth`, summed by quarter ──
  const shareSums = new Map(); // quarterKey -> { days, sums: Map(slug -> summed daily share %) }
  for (const { q, rows } of counted) {
    const top = rows.slice(0, depth);
    const total = top.reduce((acc, m) => acc + (+m.tokRaw || 0), 0);
    if (total <= 0) continue;
    // Sum tokRaw per provider in this snapshot (same provider can hold multiple models)
    const perProv = new Map();
    for (const m of top) {
      const slug = normalizeProviderSlug(m.provider);
      if (!slug) continue;
      perProv.set(slug, (perProv.get(slug) || 0) + (+m.tokRaw || 0));
    }
    let bucket = shareSums.get(q);
    if (!bucket) { bucket = { days: 0, sums: new Map() }; shareSums.set(q, bucket); }
    bucket.days++;
    for (const [slug, tok] of perProv) {
      bucket.sums.set(slug, (bucket.sums.get(slug) || 0) + (tok / total) * 100); // percent
    }
  }

  // Avg share per (quarter, provider) over EVERY counted day of the quarter:
  // a day on which the provider is outside the top `depth` adds zero.
  const quarterlyShare = new Map(); // quarterKey -> Map(slug -> avgSharePct)
  const shareDays = new Map(); // quarterKey -> counted days
  for (const [q, { days, sums }] of shareSums) {
    const avg = new Map();
    for (const [slug, sum] of sums) avg.set(slug, sum / days);
    quarterlyShare.set(q, avg);
    shareDays.set(q, days);
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
      // Refused by the matrix, for EITHER of its two reasons -- a change of
      // measure (_model-price-basis.js) or too few models priced in both
      // quarters to be like-for-like. Never read as a number, even if one
      // were present. Only the first was handled here, so a too-few-matched
      // provider fell through every bucket below: off the chart, out of the
      // table, and absent from the notes that exist to name who was left out.
      const measureChanged = c.qoqMeasureChanged === true;
      const tooFewMatched  = c.qoqTooFewMatched === true;
      const priceRefused   = measureChanged || tooFewMatched;
      const priceQoq = (!priceRefused && typeof c.qoq === 'number') ? c.qoq : null;

      const shareAvg = shareNow && shareNow.get(slug);
      const sharePrev = sharePrior && sharePrior.get(slug);
      const shareQoqPP = (typeof shareAvg === 'number' && typeof sharePrev === 'number')
        ? (shareAvg - sharePrev) : null;

      // We include a provider only if we can characterize BOTH dimensions
      // for THIS quarter. Pure pricing rows (no share observation in this
      // quarter) are skipped — being explicit about what we don't know.
      if (typeof shareAvg !== 'number') continue;

      const priceReg = measureChanged ? 'measure_changed'
        : tooFewMatched ? 'too_few_matched'
        : classifyPrice(priceQoq);
      const shareReg = classifyShare(shareQoqPP);
      const regime   = measureChanged ? MEASURE_CHANGED_REGIME
        : tooFewMatched ? TOO_FEW_MATCHED_REGIME
        : regimeFor(priceReg, shareReg);

      rows.push({
        slug,
        label: slugToLabel[slug] || slug,
        avg: c.avg,
        avgLabel: c.avgLabel,
        priceQoq,
        priceQoqLabel: measureChanged ? 'measure changed'
          : tooFewMatched ? 'too few models'
          : (typeof priceQoq === 'number') ? ((priceQoq >= 0 ? '+' : '') + (priceQoq * 100).toFixed(1) + '%') : '—',
        priceRefused,
        priceRefusedKind: measureChanged ? 'measure_changed' : tooFewMatched ? 'too_few_matched' : null,
        // Retained so a reader written against the older shape keeps working:
        // it still means "the source changed what it reports", not "refused".
        priceMeasureChanged: measureChanged,
        // The matrix's own wording for the refusal, whichever it was. The
        // too-few-matched reason used to be computed upstream and discarded.
        priceQoqReason: priceRefused ? (c.qoqReason || null) : null,
        priceReg,
        shareAvg,
        // Two decimals under 1%: a provider in the top N on a few days of the
        // quarter must not read as "0.0%".
        shareAvgLabel: shareAvg.toFixed(shareAvg < 1 ? 2 : 1) + '%',
        sharePrev: (typeof sharePrev === 'number') ? sharePrev : null,
        shareQoqPP,
        shareQoqLabel: (typeof shareQoqPP === 'number') ? ((shareQoqPP >= 0 ? '+' : '') + shareQoqPP.toFixed(2) + 'pp') : '—',
        shareReg,
        regimeLabel: regime.label,
        note: regime.note,
        modelCount: c.modelCount || 0,
      });
    }
    // Priced providers that had a share last quarter and no model in the top
    // `depth` on any counted day of this one: no row, no share — but named,
    // so they do not silently drop out of the read-through.
    const notInTopN = (shareNow && sharePrior)
      ? (q.cells || [])
          .filter(c => typeof c.avg === 'number' && sharePrior.has(c.slug) && !shareNow.has(c.slug))
          .map(c => ({ slug: c.slug, label: slugToLabel[c.slug] || c.slug }))
      : [];
    if (rows.length) {
      allQuarterRows.push({ quarter: q.quarter, partial: q.partial, shareDays: shareDays.get(q.quarter) || 0, rows, notInTopN });
      if (!latestComparable && rows.some(r => typeof r.priceQoq === 'number' && typeof r.shareQoqPP === 'number')) {
        latestComparable = q.quarter;
      }
    }
  }

  // ── Derive ranked callouts for the latest comparable quarter ──
  let callouts = [];
  const latestObj = allQuarterRows.find(x => x.quarter === latestComparable);
  if (latestObj) {
    // Every PRICE callout reads only rows whose price change was actually
    // computed. A refused change is not a zero and not a cut — and without
    // this, "Strongest pricing power" (which only asks "not a cut") would
    // crown a provider whose price move is unknown.
    const r = latestObj.rows.filter(x =>
      !x.priceRefused && typeof x.priceQoq === 'number' && typeof x.shareQoqPP === 'number');
    // The share callout needs only a share change. A provider whose price
    // change was refused still gained or lost share, and its detail says the
    // price change is not computed instead of quoting one.
    const shareRows = latestObj.rows.filter(x =>
      typeof x.shareQoqPP === 'number' && (typeof x.priceQoq === 'number' || x.priceRefused));

    const by = (fn) => [...r].sort(fn);

    const biggestCut = by((a,b) => a.priceQoq - b.priceQoq)[0];
    if (biggestCut && biggestCut.priceQoq < 0) callouts.push({
      kind: 'biggest_price_cut',
      title: 'Biggest price cut',
      provider: biggestCut.label, slug: biggestCut.slug,
      detail: biggestCut.priceQoqLabel + ' input · share ' + biggestCut.shareQoqLabel,
    });

    const strongestGainer = [...shareRows].sort((a,b) => b.shareQoqPP - a.shareQoqPP)[0];
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

    // Ranking "biggest cut" or "strongest gainer" over whoever survived a
    // partial fan-out can crown the wrong provider outright, so no callout is
    // made until the matrix is whole again.
    if (pricingDegraded) callouts = [];
    callouts = callouts.slice(0, 5);
  }

  return jsonResp({
    success: true,
    // True when the upstream matrix could not reach every provider. The rows
    // below are then a subset and no callouts are made.
    degraded: pricingDegraded,
    providerErrors: pricingProviderErrors,
    latestComparable,
    priorComparable: priorQuarterKey(latestComparable),
    quarters: allQuarterRows,
    callouts,
    thresholds: {
      priceCutPct: -2, priceUpPct: 2,
      shareGainPP: 0.3, shareLossPP: -0.3,
    },
    // What a share is measured over, and the captured days left out of it.
    // Each quarter carries its own counted-day total as `shareDays`.
    shareBasis: { depth, countedDays: counted.length, excludedDays },
    // The matrix's account of any change in what the source reports, passed
    // through so the block can explain providers kept off the chart.
    measureBreaks: pricing.measureBreaks || null,
    providers: pricingProviders,
    sourceNote:
      'Directional ecosystem read-through · not a causal claim. ' +
      'Pricing QoQ: api.pricepertoken.com provider pricing history (equal-weighted, quarterly). ' +
      'Market share: each captured day\'s share of the top ' + depth + ' OpenRouter models by weekly tokens, ' +
      'averaged over every counted day of the quarter; a provider outside the top ' + depth + ' on a day counts as zero for it. ' +
      'Not counted: gap-fill copies of a later capture, and days whose stored list is not a complete model ranking. ' +
      'A provider with no model in the top ' + depth + ' on any counted day of a quarter has no share for it, never an imputed one. ' +
      'Where the source changed how it reports a provider\'s prices between the two quarters, ' +
      'or where too few of its models were priced in both quarters to compare like for like, ' +
      'that provider\'s price change is not computed and it makes no price callout.',
  }, 200, pricingDegraded ? { 'Cache-Control': 'no-store' } : {});
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
