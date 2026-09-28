/**
 * Cloudflare Pages Function — Pricing / Share Read-Through
 * Route: /api/pricing-share-signal
 * Method: GET
 *
 * Joins EXISTING sources — no duplicated logic:
 *   1. /api/provider-pricing-matrix?metric=input  — per-provider quarterly
 *      average input $/1M token and pre-computed QoQ%. This is the pricing
 *      source of truth.
 *   2. fetchMarketShare('week') (./_openrouter-rankings.js) — OpenRouter's own
 *      weekly per-provider token series, 52 weeks deep and current. This is
 *      the market-share source of truth.
 *   3. /api/history?view=daily&range=365           — canonical KV daily
 *      snapshots, each with a top-N OpenRouter rankings array containing
 *      { rank, provider, tokRaw } rows. The FALLBACK share source, read only
 *      when (2) cannot be.
 *
 * WHICH MEASURE A SHARE RESTS ON
 * ──────────────────────────────
 * The daily captures changed population on 2026-09-16, when the capture began
 * filtering the rankings to paid ("standard") traffic. 2026-Q3 therefore holds
 * ~48 all-traffic days and ~13 paid-only ones; 2026-Q2 is all-traffic
 * throughout. KV history starts 2026-04-21, so Q3-vs-Q2 is the ONLY share
 * comparison that exists — and it is exactly the one that straddles the break.
 *
 * It cannot be linked across the way _model-price-basis.js links prices across
 * 2026-07-10. A price is a level and that change of measure was one exact
 * factor; a share is a ratio whose numerator AND denominator both change
 * population, so the correction is (1+phi_p)/(1+phi_bar) with phi varying by
 * provider and by week, and shares sum to 100% on both sides, so there is no
 * uniform-factor signature to detect in the first place. Nothing here links,
 * rescales or blends across it.
 *
 * The share is read instead from the weekly PROVIDER series, whose basis never
 * changed — the filter touched the 'models' dataset, not 'market-share' — and
 * whose weeks average into quarters with no boundary to cross. That series is
 * ALL TRAFFIC, INCLUDING FREE. A paid-only history does not exist and cannot
 * be reconstructed (stored rows carry no variant), so this IS a change of
 * measure from the top-N daily captures, and the measure in force is published
 * (shareBasis.measure / measureLabel / measureNote, and per quarter) so it can
 * be named on screen rather than silently swapped underneath the reader.
 *
 * Weekly measure (preferred): a provider's share of ALL OpenRouter tokens in a
 * week — every provider the series names, plus its "others" remainder, in the
 * denominator — averaged over the weeks of the quarter. A provider the series
 * does not name in every week of a quarter has no share for it: absence folds
 * into "others", so it means unknown, never zero.
 *
 * Daily measure (fallback): a day counts only if it is a real capture (not a
 * gap-fill copy of a later one), its list is a MODEL ranking (at least half
 * its rows name a model maker AND no row names a known application), the list
 * is complete (ranks run 1..N with none missing), and it predates the
 * 2026-09-16 change of population — see uncountedReason. Share of a day is
 * provider tokens / total tokens over the top `depth` rows; share of a quarter
 * is the mean over EVERY counted day of the quarter — one day-set for every
 * provider, so a provider with no row in that top `depth` on a counted day has
 * a share of exactly zero for it: the list is complete, so its absence is an
 * observation.
 *
 * `depth` is the shortest counted list among the days of the TWO quarters
 * being compared — not of the whole window, where one short day narrowed what
 * every quarter measured at once. It is published per quarter (`shareDepth`).
 *
 * Joining (by normalized provider slug) with the pricing matrix yields
 * per-(provider, quarter) rows with priceQoq and shareQoq in the same period.
 * A comparison rests entirely on ONE measure; the two are never mixed inside
 * one of them.
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
 *     and its share are observed. A provider the measure in force does not
 *     observe in a quarter — outside the top `depth` on every counted day of
 *     it, or not named in every week of it — gets no row and no share, never
 *     an imputed one, and is named in that quarter's `notInTopN` when it had
 *     a share the quarter before, so it does not vanish silently.
 *   - "latestComparable" is the most recent quarter that has both a real
 *     priceQoq AND a real shareQoq, both observed on one measure.
 *   - Upstream source-floor limitations (pricing: 2025-07-28; market share:
 *     52 weeks of the provider series, or whatever the KV index holds when
 *     the daily measure stands in) propagate through without fabrication.
 *   - Directional ecosystem read-through. Not a causal claim.
 */

import { isRealSnapshot } from './gpu-hardware-pricing-history.js';
import { isAttributedRanking } from './openrouter.js';
import { fetchMarketShare } from './_openrouter-rankings.js';

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
 * Model names that are really APPLICATIONS — the fingerprints of the
 * 2026-08-18 regression, verbatim from the two capture-side copies
 * (openrouter.js assertLooksLikeModels, _openrouter-rankings.js
 * validateModelRows). The capture refuses a payload on a SINGLE such row; the
 * read path applied only the weaker half-attributed test, so a stored Apps day
 * that happened to clear 50% attribution was counted. One fingerprint, both
 * ends.
 */
const APP_NAME_HINTS = /^(kilo code|cline|codex|pi|omp|freebuff|roo code|chatwise|sillytavern|openrouter api|janitorai|openwebui)$/i;

/**
 * The day the daily capture began filtering the rankings to paid ("standard")
 * traffic. Days from here on measure a different population from the days
 * before them, and a stored row does not say which — it carries no variant —
 * so this is the one thing about a day that cannot be read off the capture.
 */
const VARIANT_BREAK_DATE = '2026-09-16';

/**
 * Why a day's ranking is not counted toward market share, or null if it is.
 * Every test but the last reads what the capture itself recorded — never a
 * list of names.
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
 *   'appNamed'          A row names a known application. The capture refuses a
 *                       payload on one such row; half-attribution alone would
 *                       let a mostly-model list carrying "Kilo Code" through,
 *                       and the window those rows come from is known corrupt.
 *   'incompleteRanking' Ranks do not run 1..N. Only in a complete list does a
 *                       provider's absence mean it was outside the top N,
 *                       which is what lets an absent day count as zero share.
 *   'variantFiltered'   Dated on or after the 2026-09-16 change of population.
 *                       The day is a sound observation of PAID traffic; the
 *                       days before it observe all traffic. Averaging the two
 *                       into one quarter measures nothing, and no paid-only
 *                       prior quarter exists to compare against instead, so
 *                       this measure keeps to the population it has all of.
 */
function uncountedReason(snapshot, rows) {
  if (!isRealSnapshot(snapshot)) return 'backfill';
  if (!isAttributedRanking(rows)) return 'notModelRanking';
  if (rows.some(m => APP_NAME_HINTS.test(String((m && m.model) || '').trim()))) return 'appNamed';
  if (!rows.every((m, i) => +m.rank === i + 1)) return 'incompleteRanking';
  const day = typeof snapshot.date === 'string' ? snapshot.date.slice(0, 10) : '';
  if (day && day >= VARIANT_BREAK_DATE) return 'variantFiltered';
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

/**
 * Quarterly per-provider share from the weekly provider series.
 *
 * A week is filed under the quarter its start date falls in. The denominator
 * is the week's whole traffic — every provider the series names plus its
 * "others" remainder — so a quarter's named shares sum to under 100% by
 * exactly the size of that remainder, and "others" itself is not a provider
 * and gets no row.
 *
 * A provider the series does not name in every week of a quarter gets no
 * share for that quarter: its absence from a week means it fell into
 * "others", which is unknown, never zero — the opposite of the daily measure,
 * where a complete ranking makes absence an observation.
 */
function quarterlyShareFromWeeks(weeks) {
  const acc = new Map(); // quarterKey -> { weeks, sums: Map(slug -> summed weekly share %), seen: Map(slug -> weeks) }
  for (const w of weeks || []) {
    const q = quarterOfDate(w && w.start);
    if (!q) continue;
    const entries = Object.entries((w && w.providers) || {});
    const total = entries.reduce((a, [, n]) => a + (+n || 0), 0);
    if (total <= 0) continue;
    let bucket = acc.get(q);
    if (!bucket) { bucket = { weeks: 0, sums: new Map(), seen: new Map() }; acc.set(q, bucket); }
    bucket.weeks++;
    for (const [raw, tok] of entries) {
      if (raw === 'others') continue; // the unlisted remainder, not a provider
      const slug = normalizeProviderSlug(raw);
      if (!slug) continue;
      bucket.sums.set(slug, (bucket.sums.get(slug) || 0) + ((+tok || 0) / total) * 100);
      bucket.seen.set(slug, (bucket.seen.get(slug) || 0) + 1);
    }
  }
  const byQuarter = new Map(), weekCounts = new Map();
  for (const [q, bucket] of acc) {
    const avg = new Map();
    for (const [slug, sum] of bucket.sums) {
      if (bucket.seen.get(slug) !== bucket.weeks) continue;
      avg.set(slug, sum / bucket.weeks);
    }
    byQuarter.set(q, avg);
    weekCounts.set(q, bucket.weeks);
  }
  return { byQuarter, weekCounts };
}

/**
 * Mean per-provider share of the top `depth` rows over a set of counted days.
 * Null when no day of the set has any tokens to divide by.
 */
function shareOfDays(days, depth) {
  const sums = new Map();
  let used = 0;
  for (const { rows } of days) {
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
    used++;
    for (const [slug, tok] of perProv) {
      sums.set(slug, (sums.get(slug) || 0) + (tok / total) * 100); // percent
    }
  }
  if (!used) return null;
  const avg = new Map();
  for (const [slug, sum] of sums) avg.set(slug, sum / used);
  return { avg, days: used };
}

/** The weekly provider series, or the reason it could not be read. */
async function weeklyProviderSeries() {
  try {
    const series = await fetchMarketShare('week');
    return { series, error: null };
  } catch (e) {
    return { series: null, error: (e && e.message) || 'market-share read failed' };
  }
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
  const [pricing, history, weekly] = await Promise.all([
    localFetch(request, '/api/provider-pricing-matrix?metric=input'),
    localFetch(request, '/api/history?view=daily&range=365'),
    weeklyProviderSeries(),
  ]);

  if (!pricing || !pricing.success) {
    return jsonResp({ success: false, error: 'pricing matrix unavailable' }, 502);
  }

  // The preferred measure. Built first because the daily captures are only the
  // fallback: with this series in hand every figure below is computable, and a
  // figure that can be computed is not withheld for want of the fallback.
  const weeklyShare = weekly.series ? quarterlyShareFromWeeks(weekly.series.weeks) : null;
  const onWeekly = !!(weeklyShare && weeklyShare.byQuarter.size);
  if ((!history || !history.success) && !onWeekly) {
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

  // ── The day census (see uncountedReason) ──
  // Kept whether or not the daily measure is the one in force: it is also the
  // account of what the capture window holds and of what was left out of it.
  const countedByQuarter = new Map(); // quarterKey -> [{ rows }] — rows in rank order
  let countedDays = 0;
  const excludedDays = { backfill: 0, notModelRanking: 0, appNamed: 0, incompleteRanking: 0, variantFiltered: 0 };
  for (const s of (history && history.snapshots) || []) {
    const rows = rankedRows(s);
    if (!rows.length) continue;
    const q = quarterOfDate(s.date);
    if (!q) continue;
    const why = uncountedReason(s, rows);
    if (why) { excludedDays[why]++; continue; }
    countedDays++;
    const list = countedByQuarter.get(q);
    if (list) list.push({ rows }); else countedByQuarter.set(q, [{ rows }]);
  }

  /**
   * Everything one (quarter, prior quarter) comparison needs, on ONE measure.
   *
   * On the daily measure both sides are read to the same depth — the shortest
   * counted list among THESE two quarters' days, so a longer list's first
   * `depth` rows are, by its own ranking, that day's top `depth`. Taking the
   * minimum over the whole window instead let one short day anywhere in 365
   * narrow what every quarter measured.
   */
  function comparison(qKey, priorKey) {
    if (onWeekly) {
      return {
        now: weeklyShare.byQuarter.get(qKey) || null,
        prior: (priorKey && weeklyShare.byQuarter.get(priorKey)) || null,
        depth: null, daysNow: 0,
        weeksNow: weeklyShare.weekCounts.get(qKey) || 0,
      };
    }
    const daysNow = countedByQuarter.get(qKey) || [];
    const daysPrior = (priorKey && countedByQuarter.get(priorKey)) || [];
    const pair = daysNow.concat(daysPrior);
    const depth = pair.length ? Math.min(...pair.map(c => c.rows.length)) : 0;
    const now = depth ? shareOfDays(daysNow, depth) : null;
    const prior = depth ? shareOfDays(daysPrior, depth) : null;
    return {
      now: now && now.avg, prior: prior && prior.avg,
      depth, daysNow: now ? now.days : 0, weeksNow: 0,
    };
  }

  // ── Walk pricing matrix quarters — pair with share quarters ──
  const pricingProviders = pricing.providers || [];
  const slugToLabel = {};
  for (const p of pricingProviders) slugToLabel[p.slug] = p.label;

  // Find the latest quarter for which we can compute BOTH priceQoq and shareQoq.
  let latestComparable = null;
  let latestCmp = null;  // the comparison the callouts and the basis note describe
  let firstCmp = null;   // ...or, with none comparable, the newest quarter shown at all
  const allQuarterRows = []; // { quarter, rows: [...] } newest first

  for (const q of pricing.quarters || []) {
    const prior = priorQuarterKey(q.quarter);
    const priorQuarter = (pricing.quarters || []).find(x => x.quarter === prior);
    const cmp = comparison(q.quarter, prior);
    const shareNow = cmp.now;
    const sharePrior = cmp.prior;

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
      allQuarterRows.push({
        quarter: q.quarter, partial: q.partial,
        // What this quarter's share was measured over, on the measure in
        // force: counted days and the depth they were read to, or the weeks
        // averaged. Published per quarter because depth is now per comparison.
        shareDays: cmp.daysNow, shareDepth: cmp.depth, shareWeeks: cmp.weeksNow,
        shareMeasure: onWeekly ? 'provider-weekly' : 'top-models-daily',
        rows, notInTopN,
      });
      if (!firstCmp) firstCmp = cmp;
      if (!latestComparable && rows.some(r => typeof r.priceQoq === 'number' && typeof r.shareQoqPP === 'number')) {
        latestComparable = q.quarter;
        latestCmp = cmp;
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

  // ── What the shares on this page are a share OF ──
  // The depth quoted alongside them is the one the quarters on screen were
  // read to — the latest comparable comparison, or the newest quarter shown
  // when none is comparable. On the weekly measure there is no depth: it is
  // provider-level, so `depth` is null rather than a number that means
  // nothing, and the note says what the measure is instead.
  const basisCmp = latestCmp || firstCmp;
  const depth = onWeekly ? null : (basisCmp ? basisCmp.depth : 0);
  // With no quarter on screen there is no comparison and so no depth; the
  // measure is still named, without quoting a top-0.
  const topN = depth ? 'the top ' + depth : 'the top-N';
  const measureLabel = onWeekly
    ? 'OpenRouter provider weekly tokens — all traffic, including free'
    : 'share of ' + topN + ' OpenRouter models by weekly tokens, captured daily';
  const measureNote = onWeekly
    ? 'Each provider\'s share of all OpenRouter tokens in a week — every provider the series names ' +
      'plus its "others" remainder in the denominator — averaged over the weeks of the quarter. ' +
      'This counts FREE traffic as well as paid. The daily captures the page read before ' +
      VARIANT_BREAK_DATE + ' counted all traffic too, but from that day they count paid traffic only, ' +
      'and no paid-only history exists to compare a quarter against — a stored ranking row does not ' +
      'record which it is. This series\' basis never changed, so its weeks average into quarters with ' +
      'no break to cross.'
    : 'Each counted day\'s share of ' + topN + ' OpenRouter models by weekly tokens, averaged ' +
      'over every counted day of the quarter; a provider outside ' + topN + ' on a counted day ' +
      'counts as zero for it. Days from ' + VARIANT_BREAK_DATE + ' are not counted: from that day the ' +
      'capture records paid traffic only, and averaging those with the all-traffic days before them ' +
      'would measure neither.';

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
    // What a share is measured over: which of the two measures it rests on,
    // in words a page can print, and the captured days left out of the daily
    // one. Each quarter carries its own `shareDays`, `shareDepth`,
    // `shareWeeks` and `shareMeasure`, because depth is per comparison.
    shareBasis: {
      measure: onWeekly ? 'provider-weekly' : 'top-models-daily',
      measureLabel, measureNote,
      depth,
      weeks: onWeekly ? (basisCmp ? basisCmp.weeksNow : 0) : null,
      latestWeek: weekly.series && weekly.series.weeks.length
        ? weekly.series.weeks[weekly.series.weeks.length - 1].start : null,
      // True when the weekly series could not be read and the daily captures
      // stood in for it, with the upstream's own words for why.
      fallback: !onWeekly,
      fallbackReason: onWeekly ? null
        : (weekly.error || 'the weekly provider series covered no quarter'),
      countedDays, excludedDays,
    },
    // The matrix's account of any change in what the source reports, passed
    // through so the block can explain providers kept off the chart.
    measureBreaks: pricing.measureBreaks || null,
    providers: pricingProviders,
    sourceNote:
      'Directional ecosystem read-through · not a causal claim. ' +
      'Pricing QoQ: api.pricepertoken.com provider pricing history (equal-weighted, quarterly). ' +
      'Market share (' + measureLabel + '): ' + measureNote + ' ' +
      (onWeekly
        ? 'A provider the series does not name in every week of a quarter has no share for it — ' +
          'its absence folds into "others", so it is unknown, never an imputed zero. '
        : 'Also not counted: gap-fill copies of a later capture, and days whose stored list is not a ' +
          'complete model ranking. A provider with no model in ' + topN + ' on any counted day ' +
          'of a quarter has no share for it, never an imputed one. ') +
      'A comparison rests entirely on one of these two measures; they are never mixed within one. ' +
      'Where the source changed how it reports a provider\'s prices between the two quarters, ' +
      'or where too few of its models were priced in both quarters to compare like for like, ' +
      'that provider\'s price change is not computed and it makes no price callout.',
  }, 200, pricingDegraded ? { 'Cache-Control': 'no-store' } : {});
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
