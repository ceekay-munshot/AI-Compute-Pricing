/**
 * Cloudflare Pages Function — Provider-Grouped Quarterly Pricing Matrix
 * Route: /api/provider-pricing-matrix
 * Method: GET
 *
 * Fan-out proxy against pricepertoken.com's public historical pricing API:
 *     https://api.pricepertoken.com/api/provider-pricing-history/?provider=<slug>
 *
 * That upstream endpoint returns ONE row per (model, day) with fields:
 *     provider, model, date, pricing_prompt, pricing_completion, ...
 *
 * We call it once per configured provider in parallel, aggregate into a
 * quarter-by-provider matrix of equal-weighted average input (or output)
 * price per 1M tokens, and return the matrix plus per-cell model counts
 * for transparency (so the reader can see how coverage shifts over time).
 *
 * This is DERIVED from a real live upstream — not local captured snapshots.
 * The matrix is edge-cached for CACHE_TTL seconds (functions/api/_edge-cache.js),
 * and its upstream subrequests are cached for the same period — see CACHE_TTL.
 *
 * Honesty rules — the whole reason this exists:
 *   - No synthetic backfill. Quarters prior to the upstream's depth simply
 *     don't appear in the response.
 *   - Upstream's earliest date observed is 2025-07-28, so the historical
 *     floor is 2025-Q3 (partial). Client asked for 2023+; we do not fake it.
 *   - YoY is only returned when a same-quarter one year earlier row exists
 *     with real data.
 *   - A price CHANGE is like-for-like. QoQ and YoY compare the models a
 *     provider priced in BOTH quarters, each at its own average price in each,
 *     so a model listed or retired between them cannot read as a price move.
 *     The level stays the whole lineup's average — a true statement of what
 *     the lineup costs. Anthropic's 2026-Q3 read "-10.4%" and was named the
 *     biggest price cut with not one of its models repriced: four models left
 *     the lineup, four joined, and the fourteen priced in both quarters did not
 *     move. Where too few models were priced in both to stand for the
 *     provider, the change is refused with a reason (matchedModelGrowth).
 *     Model-day view only. The usage-weighted view compares the levels it
 *     shows, measured or estimated, so its QoQ/YoY reconcile with its Avg
 *     cells; a change resting on an estimate says so (<key>Estimated, <key>Note).
 *   - The source can change WHAT it reports: on 2026-07-10 its figure for 13
 *     Google and 10 OpenAI models fell to exactly half on one day. Every price
 *     is read, and every quarter's measure decided, by _model-price-basis.js:
 *     a quarter averages one measure only, and QoQ/YoY between quarters on
 *     different measures compare only the models the change touched in
 *     neither (model-day view), or are refused with a reason
 *     (qoqMeasureChanged / qoqReason, yoyMeasureChanged / yoyReason) instead
 *     of being printed as a price move.
 *
 * Query params:
 *   ?metric=input   (default) — pricing_prompt, scaled to per 1M tokens
 *   ?metric=output            — pricing_completion, scaled to per 1M tokens
 *   ?weight=equal   (default) — every model in the lineup counts once
 *   ?weight=usage             — each model counts in proportion to the tokens
 *                               it actually served on OpenRouter, so the cell
 *                               reads as what the market pays rather than what
 *                               the price list says. Coverage is measured per
 *                               provider-quarter and cells that cannot clear
 *                               the gate are withheld with a stated reason —
 *                               see _usage-weights.js for the limits.
 *   ?group=company  (default) — one column per provider (PROVIDERS)
 *   ?group=openness           — two columns, proprietary and open-weight,
 *                               pooling every model of PROVIDERS plus the open
 *                               labs in OPENNESS_EXTRA_PROVIDERS, classed per
 *                               model by _model-openness.js. Model-day only.
 *   ?refresh=1                — bypass edge cache (diagnostic only)
 */

import {
  PPT_TO_OR_PROVIDER,
  MIN_COVERAGE,
  MIN_WEIGHTED_MODELS,
  MAX_TOP_WEIGHT_SHARE,
  priceModelCandidates,
  buildUsageWeights,
  weightedAverage,
  gateReason,
} from './_usage-weights.js';
import { fetchMarketShare } from './_openrouter-rankings.js';
import { withEdgeCache } from './_edge-cache.js';
import { modelOpenness, OPENNESS_EXTRA_PROVIDERS, OPENNESS_GROUPS } from './_model-openness.js';
import {
  BASIS_ORIGIN,
  readPrice,
  rowDay,
  isAltBillingSku,
  buildBasisBook,
  tallyFor,
  addToTally,
  resolveTally,
  countsToward,
  basisGrowth,
  isMeasureChange,
  measureChangeReason,
  periodLabel,
  describeMeasureBreaks,
} from './_model-price-basis.js';

const UPSTREAM_BASE = 'https://api.pricepertoken.com/api/provider-pricing-history/';
// One hour, and it is the bound on how far behind pricepertoken this can fall.
// Two caches use it and their lifetimes ADD: the upstream subrequests
// (cf.cacheTtl in fetchProvider) and the edge cache over the computed matrix
// (withEdgeCache in onRequestGet). At the previous 6 hours each, the matrix
// could trail a source that publishes daily by ~12 hours — long enough for a
// reader to see yesterday's prices well into today. At 1 hour each the worst
// case is ~2 hours. Upstream load stays modest: the edge cache means the
// eight-provider fan-out runs at most once an hour per Cloudflare location,
// where before any caching it ran on every single request.
const CACHE_TTL = 3600;

/**
 * Provider families we render as columns. Slugs match upstream's provider
 * query parameter exactly (verified live — do not translate without checking).
 * `label` is the human column header. Order here controls column order in UI.
 */
const PROVIDERS = [
  { slug: 'openai',     label: 'OpenAI' },
  { slug: 'anthropic',  label: 'Anthropic' },
  { slug: 'google',     label: 'Google' },
  { slug: 'xai',        label: 'xAI' },
  { slug: 'mistralai',  label: 'Mistral AI' },
  { slug: 'deepseek',   label: 'DeepSeek' },
  { slug: 'meta-llama', label: 'Meta' },
  { slug: 'cohere',     label: 'Cohere' },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // max-age=0 for the browser, s-maxage for shared caches. The old header
      // put the full 6 hours in the BROWSER cache, which bought no upstream
      // protection at all (the expensive pricepertoken fan-out is already
      // subrequest-cached via cf.cacheTtl) and pinned whatever a tab first
      // loaded -- good or degraded -- for six hours. Two tabs opened minutes
      // apart could therefore disagree about the same URL indefinitely.
      // Revalidating costs one cheap function call per load.
      'Cache-Control': 'public, max-age=0, must-revalidate, s-maxage=' + CACHE_TTL,
      ...CORS,
      ...extraHeaders,
    },
  });
}

function quarterOf(dateStr) {
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(5, 7), 10);
  const q = Math.floor((m - 1) / 3) + 1;
  return y + '-Q' + q;
}

/** "2026-Q2" → "2026-Q1"; "2026-Q1" → "2025-Q4" */
function priorQuarter(key) {
  const m = key.match(/^(\d{4})-Q(\d)$/);
  if (!m) return null;
  const y = +m[1], q = +m[2];
  return q === 1 ? (y - 1) + '-Q4' : y + '-Q' + (q - 1);
}

/** "2026-Q2" → "2025-Q2" */
function yearAgoQuarter(key) {
  const m = key.match(/^(\d{4})-Q(\d)$/);
  if (!m) return null;
  return (+m[1] - 1) + '-Q' + m[2];
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

function formatPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n >= 10) return '$' + n.toFixed(2);
  if (n >= 1)  return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);
  return '$' + n.toFixed(4);
}

function formatPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const sign = n > 0 ? '+' : '';
  return sign + (n * 100).toFixed(1) + '%';
}

/**
 * Fetch one provider's full history; returns { rows, error?, attempts }.
 *
 * Retries, because this upstream is genuinely flaky under our own fan-out.
 * Measured on production: roughly one request in eight came back with six of
 * the eight providers failing at once — a mix of HTTP 502 and "Unterminated
 * string in JSON", the latter being a large body cut off mid-transfer. Both
 * are the signature of a rate limit or a throttled connection, not of a
 * permanently broken provider, and both clear on a retry.
 *
 * The consequence of not retrying was severe out of proportion to the cause:
 * losing the providers that carry measured cells also removes the ratios the
 * estimate pass derives from, so a transient upstream hiccup emptied the
 * ENTIRE table — no measured values and no estimates either. The dashboard
 * showed a full grid of dashes and a "partial data" warning, intermittently,
 * on roughly one load in eight.
 */
function slimRow(row) {
  return {
    model: row?.model,
    date: row?.date,
    pricing_prompt: row?.pricing_prompt,
    pricing_completion: row?.pricing_completion,
  };
}

async function fetchProvider(slug, attempts = 3) {
  const url = UPSTREAM_BASE + '?provider=' + encodeURIComponent(slug);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'gdash-provider-pricing/1.0',
          Accept: 'application/json',
        },
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      });
      if (!r.ok) {
        lastError = 'HTTP ' + r.status;
      } else {
        // Parsed inside the retry loop on purpose: a truncated body throws
        // here, not at fetch, and a truncation is exactly what a retry fixes.
        const j = await r.json();
        // Only the four fields anything here reads are kept. Each upstream row
        // carries fifteen, and the open/proprietary view holds twelve
        // providers' histories (~50 MB of JSON) in one Worker at once.
        const rows = Array.isArray(j?.results) ? j.results.map(slimRow) : [];
        if (rows.length) return { slug, rows, attempts: attempt };
        lastError = 'empty results array';
      }
    } catch (e) {
      lastError = e.message;
    }
    if (attempt < attempts) await new Promise(res => setTimeout(res, 250 * attempt));
  }
  return { slug, rows: [], error: lastError, attempts };
}

/**
 * Run the provider fan-out in small batches rather than all eight at once.
 *
 * Eight simultaneous large requests — about 35MB in total, 12MB for OpenAI
 * alone — is what trips the upstream's limits. Four at a time costs one extra
 * round trip and removed the failures in testing.
 */
async function fetchAllProviders(providers, batchSize = 4) {
  const out = [];
  for (let i = 0; i < providers.length; i += batchSize) {
    const batch = providers.slice(i, i + batchSize);
    out.push(...await Promise.all(batch.map(p => fetchProvider(p.slug))));
  }
  return out;
}

/**
 * Every provider-quarter's model-day level, on ONE measure.
 *
 * Returns slug -> quarter -> resolveTally() result ({ mean, n, basis, models,
 * excludedN, ... }, mean in $/token), plus `modelLevels`: model -> that
 * model's own mean price in the quarter on the quarter's measure, which the
 * like-for-like growth in buildMatrix compares (modelLevelsOn). Its keys are
 * exactly `models`. `touched` holds the models the source's change of measure
 * touched, which a comparison across that change leaves out. Computed once per
 * request and read by both weightings — the model-day average in buildMatrix
 * and the usage-weighted resolver — so the two always stand on the same
 * measure in the same quarter.
 *
 * `columnOf(slug, model)` says which column an observation counts toward and
 * under what model key, or null to leave it out. By default the column is the
 * provider; the open/proprietary view (group=openness) pools every provider's
 * models into two columns, keyed "<provider>/<model>" so two providers'
 * same-named models stay distinct.
 *
 * A quarter holding observations from both sides of a change of measure takes
 * the measure covering most of the touched models' observations and leaves the
 * rest out, counted; untouched models always count. See _model-price-basis.js.
 */
const BY_PROVIDER = (slug, model) => ({ column: slug, model });

function providerQuarterLevels(providerResults, metric, book, columnOf = BY_PROVIDER) {
  const acc = new Map();                           // column -> { tallies, byModel }
  for (const pr of providerResults) {
    // An empty provider still gets its (empty) column, as it always has.
    if (columnOf === BY_PROVIDER && !acc.has(pr.slug)) acc.set(pr.slug, { tallies: new Map(), byModel: new Map() });
    for (const row of pr.rows) {
      // Alternate-billing SKUs are the same model sold on different terms —
      // ':batch' is ~50% off async, plus ':beta', ':thinking', ':free',
      // ':extended', ':exacto'. They are not a repricing of the standard SKU,
      // so they must not move a provider's average.
      //
      // pricepertoken began cataloguing ':batch' rows for every provider on
      // 2026-07-29. Including them made Q3-26 look like a synchronized
      // industry-wide price cut: Anthropic read as -21.8% (actually -8.0%)
      // and OpenAI as -18.3% (actually -11.9%), while Google's real cut was
      // understated at -13.5% (actually -18.8%). That inverted the ranking
      // the read-through panel headlines — it named Anthropic the biggest
      // price cutter when Anthropic had in fact cut the least and Google the
      // most. No provider's list price changed on that date; the upstream
      // catalog just grew a column.
      if (isAltBillingSku(row?.model)) continue;
      // Strictly > 0: $0.00 rows are free/experimental SKUs (Google's
      // gemini-2.5-pro-exp-*, lyria-*) and drag a paid-lineup average down.
      const v = readPrice(row, metric);
      if (v === null) continue;
      const day = rowDay(row);
      if (!day) continue;
      const at = columnOf(pr.slug, row.model);
      if (!at) continue;
      let a = acc.get(at.column);
      if (!a) acc.set(at.column, (a = { tallies: new Map(), byModel: new Map() }));
      const q = quarterOf(day);
      const basis = book.basisOf(pr.slug, row.model, day);
      addToTally(tallyFor(a.tallies, q), basis, v, at.model || null);
      // The same observation, kept per model and per measure, so each model's
      // own level can be read on whichever measure the quarter resolves to.
      if (at.model) {
        let models = a.byModel.get(q);
        if (!models) a.byModel.set(q, (models = new Map()));
        let slots = models.get(at.model);
        if (!slots) models.set(at.model, (slots = new Map()));
        const s = slots.get(basis) || [0, 0];
        s[0] += v;
        s[1] += 1;
        slots.set(basis, s);
      }
    }
  }
  const out = new Map();
  for (const [column, a] of acc) {
    const levels = new Map();
    for (const [q, t] of a.tallies) {
      const stat = resolveTally(t);
      stat.modelLevels = modelLevelsOn(a.byModel.get(q), stat.basis);
      stat.touched = touchedModels(a.byModel.get(q));
      levels.set(q, stat);
    }
    out.set(column, levels);
  }
  return out;
}

/**
 * The models in one provider-quarter that a change of measure touched: every
 * observation of a touched model carries the measure it was on (basisOf()
 * returns null only for a model no change ever touched).
 */
function touchedModels(models) {
  const out = new Set();
  for (const [model, slots] of models || []) {
    for (const b of slots.keys()) {
      if (b != null) { out.add(model); break; }
    }
  }
  return out;
}

/**
 * Each model's own mean price in one provider-quarter ($/token), on the
 * quarter's measure: exactly the observations the quarter's level counts for
 * that model — countsToward(), the rule _model-price-basis.js states for one
 * day against a period — and no others.
 *
 * A model whose every observation in the quarter sits on the other side of a
 * change of measure gets no entry, just as it has no place in the level, so it
 * cannot re-enter a comparison through the like-for-like growth below.
 */
function modelLevelsOn(models, basis) {
  const out = new Map();
  for (const [model, slots] of models || []) {
    let sum = 0;
    let n = 0;
    for (const [b, [s, k]] of slots) {
      if (!countsToward(b, basis)) continue;
      sum += s;
      n += k;
    }
    if (n) out.set(model, sum / n);
  }
  return out;
}

// A like-for-like price change needs at least this many models priced in both
// quarters. One model's change is that model's, not its provider's — the line
// the usage weighting (MIN_WEIGHTED_MODELS) and the estimate pass in
// buildMatrix draw for the same reason.
const MIN_MATCHED_MODELS = 2;
// ...and they must be at least this share of the models priced in the later
// quarter, the lineup whose average the cell shows. Below half, the change
// describes what is left of an older lineup, not the one on the page.
// Measured on 2026-09-21: Anthropic 2026-Q3 against 2025-Q3 matches 5 of 18
// (13 models listed since, 7 retired) and is refused; against 2026-Q2 it
// matches 14 of 18, and DeepSeek's YoY 8 of 15, and both are computed.
const MIN_MATCHED_SHARE = 0.5;

/**
 * A provider's price change between two quarters, LIKE-FOR-LIKE: measured on
 * the models priced in both, never on the two lineup averages — which move
 * whenever a model is listed or retired, with no price changing at all.
 *
 * `cur` and `prior` are providerQuarterLevels() entries. Each matched model
 * enters at its own mean price in each quarter, and the change is the ratio of
 * the matched models' average prices:
 *
 *     growth = mean(matched, cur) / mean(matched, prior) - 1
 *
 * Why the ratio of averages, and not the mean of each model's own % change:
 *   - It is the change of the SAME statistic the cell shows as its level (an
 *     equal-weighted mean of $/token), held to one fixed lineup. With no model
 *     entering or leaving, and each priced every day, it is the figure the
 *     matrix has always printed, so what this removes is the lineup-mix
 *     artefact and nothing else.
 *   - It weighs each model's move by its price, as the level does. A mean of
 *     % changes (or their geometric mean) gives a $0.03 model the same say as
 *     a $15 one: DeepSeek's r1-distill-llama-70b went from $0.033 to $0.800 per
 *     1M input tokens between 2025-Q3 and 2026-Q3, which alone carries a mean
 *     of % changes to +318% against +73% for the matched models' average.
 *
 * Across a change of measure (`untouchedOnly`), only models the change touched
 * in NEITHER quarter are matched: their figures are on the same measure on both
 * sides, so a model the change moved cannot come back in. The share rule still
 * counts the whole lineup, so the untouched models must be at least half of it
 * — Google's 2026-Q3, where 13 of 29 were touched, stays refused.
 *
 * Returns { growth, matched, models, onlyNow, onlyThen, touched } — touched
 * counts the models priced in both quarters that were left out for it. growth
 * is null when fewer than MIN_MATCHED_MODELS, or fewer than MIN_MATCHED_SHARE
 * of `models`, were matched.
 */
function matchedModelGrowth(cur, prior, { untouchedOnly = false } = {}) {
  const leftOut = (model) => untouchedOnly && (cur.touched.has(model) || prior.touched.has(model));
  let sumNow = 0;
  let sumThen = 0;
  let matched = 0;
  let onlyNow = 0;
  // Priced in both quarters but touched by the change: the models this leaves
  // out. A model listed after the change is on its measure from day one and
  // is simply "priced only now", like any other new listing.
  let touched = 0;
  for (const [model, now] of cur.modelLevels) {
    const then = prior.modelLevels.get(model);
    if (then === undefined) { onlyNow += 1; continue; }
    if (leftOut(model)) { touched += 1; continue; }
    sumNow += now;
    sumThen += then;
    matched += 1;
  }
  let onlyThen = 0;
  for (const model of prior.modelLevels.keys()) {
    if (!cur.modelLevels.has(model)) onlyThen += 1;
  }
  const models = cur.modelLevels.size;
  const out = { growth: null, matched, models, onlyNow, onlyThen, touched };
  if (matched < MIN_MATCHED_MODELS || matched < MIN_MATCHED_SHARE * models) return out;
  // Untouched models stand on no particular measure, so across a change they
  // compare on one; otherwise each quarter keeps its own.
  const g = basisGrowth(
    { value: sumNow / matched, basis: untouchedOnly ? BASIS_ORIGIN : cur.basis },
    { value: sumThen / matched, basis: untouchedOnly ? BASIS_ORIGIN : prior.basis },
  );
  // + 0 turns a rounded -0 (float noise on an unchanged lineup) into 0, so a
  // lineup whose prices did not move can never print as a cut.
  out.growth = g === null ? null : g + 0;
  return out;
}

function modelsPhrase(n) {
  return n + (n === 1 ? ' model' : ' models');
}

/** What a like-for-like change rests on, in words, for its tooltip. */
function likeForLikeNote(m, nowLabel, thenLabel, changeDate) {
  const outside = [];
  if (m.onlyNow) outside.push(modelsPhrase(m.onlyNow) + ' priced only in ' + nowLabel);
  if (m.onlyThen) outside.push(modelsPhrase(m.onlyThen) + ' priced only in ' + thenLabel);
  const lead = 'Like-for-like: the ' + modelsPhrase(m.matched) + ' priced in both ' + thenLabel +
    ' and ' + nowLabel + ', each at its own average price in each quarter.';
  // Across a change of measure the models it touched are left out too, and
  // the note says so first: they are the reason this change is not simply the
  // two averages'.
  const acrossChange = m.touched
    ? ' The source changed how it reports prices' + (changeDate ? ' on ' + changeDate : '') +
      ', so the ' + modelsPhrase(m.touched) + ' that change touched ' +
      (m.touched === 1 ? 'is' : 'are') + ' left out; the rest are reported the same way in both quarters.'
    : '';
  return lead + acrossChange +
    (outside.length
      ? ' ' + outside.join(' and ') + (m.onlyNow + m.onlyThen === 1 ? ' is' : ' are') +
        ' left out of the change; each quarter\'s average price still includes them.'
      : (m.touched ? '' : ' No model was added or dropped between them.'));
}

/** Why a like-for-like change is blank, in words, for its tooltip. */
function tooFewMatchedReason(m, nowLabel, thenLabel) {
  const lead = 'A price change is measured on the models priced in both quarters';
  if (m.matched === 0) {
    return 'Not computed: no model priced in ' + nowLabel + ' was also priced in ' + thenLabel +
      '. ' + lead + ', so there is nothing to compare.';
  }
  const who = m.matched === m.models
    ? (m.models === 1 ? 'the one model' : 'all ' + m.models + ' models')
    : 'only ' + m.matched + ' of the ' + m.models + ' models';
  return 'Not computed: ' + who + ' priced in ' + nowLabel + (m.matched === 1 ? ' was' : ' were') +
    ' also priced in ' + thenLabel + '. ' + lead +
    (m.matched < MIN_MATCHED_MODELS
      ? ', and one model\'s change is not the provider\'s.'
      : ', and fewer than half of this lineup were, so it would not stand for the provider.' +
        ' Comparing the two quarters\' averages instead would measure models being listed and retired, not prices moving.');
}

/**
 * What a usage-weighted change resting on an estimate rests on, in words, for
 * its tooltip. `m` is the like-for-like list-price change over the same two
 * quarters (matchedModelGrowth), offered as a cross-check: an estimate scales
 * the quarter's list-price AVERAGE, which a model being listed or retired
 * moves with no price changing.
 */
function estimatedChangeNote(cur, prior, nowLabel, thenLabel, m) {
  const both = cur.estimated && prior.estimated;
  const sameRatio = both && cur.ratio === prior.ratio;
  const which = both
    ? 'Both are estimates: their measured values were withheld, so each is its quarter\'s ' +
      'list-price average scaled by this provider\'s usage-weighted-to-list ratio' +
      (sameRatio ? ' — the same ratio in both, so this change is the list-price average\'s.' : '.')
    : (cur.estimated ? nowLabel : thenLabel) + ' is an estimate: its measured value was withheld, ' +
      'so it is that quarter\'s list-price average scaled by this provider\'s ' +
      'usage-weighted-to-list ratio.';
  return 'Change between the usage-weighted prices shown for ' + thenLabel + ' and ' + nowLabel + '. ' +
    which +
    (m && m.growth !== null
      ? ' For reference, the list prices of the ' + modelsPhrase(m.matched) + ' priced in both ' +
        'quarters moved ' + formatPct(m.growth) + ' like-for-like.'
      : '');
}

/** Why a change has nothing to compare against, in words, for its tooltip. */
function noComparatorReason(thenKey, earliestQuarter) {
  const then = periodLabel(thenKey);
  return thenKey < earliestQuarter
    ? 'Not computed: there is no ' + then + ' to compare against — the source\'s price ' +
      'history starts in ' + periodLabel(earliestQuarter) + '.'
    : 'Not computed: ' + then + ' has no price for this provider to compare against.';
}

/** The date of the change of measure between two quarters' levels, or null. */
function changeDateOf(cur, prior) {
  const dated = [cur?.basis, prior?.basis].filter(b => b && b !== BASIS_ORIGIN).sort();
  return dated[dated.length - 1] || null;
}

/**
 * Build the matrix from each provider's quarter levels (providerQuarterLevels).
 *
 * Default (weighting omitted): the average is equal-weighted across every
 * (model, day) observation in the quarter — i.e., one point per model per day
 * that the upstream recorded a price for. This mirrors how pricepertoken's own
 * chart aggregates the data and avoids collapsing-to-one-model bias when some
 * models have more dated observations than others.
 *
 * With `weighting` supplied, each model's mean price in the quarter is instead
 * weighted by the tokens it served, and cells that cannot clear the coverage
 * gate are withheld. The equal-weighted level is retained on every cell as
 * `equalAvg` so the two are always comparable side by side.
 */
function buildMatrix(levelsBySlug, weighting, events, columns = PROVIDERS) {
  // Each cell's unrounded level ($/1M) — the one shown, and the list-price
  // one — for the estimate and growth passes. The cells carry levels rounded
  // to $0.001, which is 2% of Mistral's $0.049: a change divided from those
  // can be off by more than a point.
  const exact = new WeakMap();
  const exactEqual = new WeakMap();
  // Collect the union of quarter keys across providers
  const allQuarters = new Set();
  for (const levels of levelsBySlug.values()) {
    for (const q of levels.keys()) allQuarters.add(q);
  }

  // Sort quarters newest first
  const quarters = Array.from(allQuarters).sort().reverse();

  // Build output rows (one row per quarter)
  const rows = quarters.map(q => {
    const cells = columns.map(p => {
      const stat = levelsBySlug.get(p.slug)?.get(q);
      if (!stat || stat.mean === null) {
        return { slug: p.slug, avg: null, avgLabel: '—', obsCount: 0, modelCount: 0 };
      }
      // Upstream values are $/token; scale to $/1M tokens
      const equalAvg = stat.mean * 1_000_000;
      const cell = {
        slug: p.slug,
        avg: round3(equalAvg),
        avgLabel: formatPrice(equalAvg),
        obsCount: stat.n,
        modelCount: stat.models.size,
        // The measure this cell stands on: 'origin', or the date of the
        // source change it was reported after. The QoQ/YoY pass below reads
        // it, and the matrix marks a cell reported after a change.
        basis: stat.basis,
        // Observations in the quarter from the other side of a change, left
        // out rather than blended in. 0 almost everywhere.
        basisExcludedObs: stat.excludedN,
      };
      exact.set(cell, equalAvg);
      exactEqual.set(cell, equalAvg);
      if (!weighting) return cell;

      // Usage-weighted view. `avg` is deliberately REPLACED rather than added
      // alongside, so every downstream consumer — the QoQ/YoY pass below, the
      // trend chart, the matrix — reads one consistent series and cannot mix
      // a weighted level with an equal-weighted change. The equal-weighted
      // level stays available as `equalAvg` for tooltips.
      const modelWeights = weighting.weights.get(q)?.get(p.slug);
      const coverage = weighting.coverage.get(q)?.has(p.slug)
        ? weighting.coverage.get(q).get(p.slug)
        : null;
      const w = weightedAverage(modelWeights, coverage, weighting.seriesAvailable);
      const weightedAvg = w.avg === null ? null : w.avg * 1_000_000;

      cell.equalAvg = cell.avg;
      cell.equalAvgLabel = cell.avgLabel;
      cell.avg = weightedAvg === null ? null : round3(weightedAvg);
      cell.avgLabel = weightedAvg === null ? '—' : formatPrice(weightedAvg);
      if (weightedAvg === null) exact.delete(cell);
      else exact.set(cell, weightedAvg);
      cell.weightedModelCount = w.models;
      cell.coverage = w.coverage === null ? null : round3(w.coverage);
      cell.coverageLabel = w.coverage === null ? null : (w.coverage * 100).toFixed(0) + '%';
      cell.topWeightShare = w.topShare === null ? null : round3(w.topShare);
      cell.topWeightShareLabel = w.topShare === null ? null : (w.topShare * 100).toFixed(0) + '%';
      // A withheld cell still gets an ESTIMATE so the table can be read across
      // without holes. It is never presented as measured: the UI renders it
      // greyed and suffixed "est", and `estimateBasis` says where it came from.
      //   provisional — the weighting computed this from real tokens; the gate
      //                 withheld it because the basis was too thin to publish
      //                 as measured. Real arithmetic, narrow evidence.
      //   modelled    — no usage data at all, so there was nothing to compute.
      //                 Filled in a second pass from the provider's own
      //                 measured weighted-to-list ratio.
      if (w.provisional !== null) {
        // Kept for reference and tooltips only. NOT used as the estimate: a
        // provisional built from one or two models is a sample of a lineup, not
        // an estimate of its blend, and mixing the two methods across a row
        // produced nonsense — OpenAI swinging $5.50 to $0.039 between quarters
        // purely because one quarter fell back to a different method.
        cell.provisionalAvg = round3(w.provisional * 1_000_000);
        cell.provisionalAvgLabel = formatPrice(w.provisional * 1_000_000);
      }
      cell.gate = w.gate;
      cell.gateReason = gateReason(w.gate, w.coverage, w.models);
      return cell;
    });
    return { quarter: q, cells };
  });

  // ── Second pass: model an estimate for cells with no usage data at all ──
  // Nothing was computable for these, so the estimate comes from how far this
  // provider's MEASURED weighted prices sat below its list prices, applied to
  // the list price here. Providers with no measured cell anywhere fall back to
  // the cross-provider median ratio, which is a weaker basis and is reported as
  // such. Ratios observed live span 0.33–1.09, so these carry real uncertainty
  // and are labelled, never published as measured.
  if (weighting) {
    // ONE method for every estimate, so a row reads consistently: take how far
    // this provider's weighted price sits below its list price, and apply that
    // ratio to the list price of the quarter being estimated.
    //
    // The ratio is sourced in descending order of evidence:
    //   measured    — from this provider's published cells. Strongest.
    //   provisional — from its own computed-but-withheld cells, using only
    //                 those resting on at least two models, since a
    //                 single-model figure describes a model and not a lineup.
    //   peer        — the median ratio across all measured cells anywhere.
    //                 Weakest, and flagged as such.
    const measured = new Map();
    const provisional = new Map();
    const allMeasured = [];
    for (const row of rows) {
      for (const c of row.cells) {
        if (!(c.equalAvg > 0)) continue;
        if (c.avg !== null) {
          const r = exact.get(c) / exactEqual.get(c);
          if (isFinite(r) && r > 0) {
            if (!measured.has(c.slug)) measured.set(c.slug, []);
            measured.get(c.slug).push(r);
            allMeasured.push(r);
          }
        } else if (c.provisionalAvg > 0 && (c.weightedModelCount || 0) >= 2) {
          const r = c.provisionalAvg / c.equalAvg;
          if (isFinite(r) && r > 0) {
            if (!provisional.has(c.slug)) provisional.set(c.slug, []);
            provisional.get(c.slug).push(r);
          }
        }
      }
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    allMeasured.sort((a, b) => a - b);
    const peer = allMeasured.length ? allMeasured[Math.floor(allMeasured.length / 2)] : null;
    for (const row of rows) {
      for (const c of row.cells) {
        if (c.avg !== null || !(c.equalAvg > 0)) continue;
        const own = measured.get(c.slug);
        const prov = provisional.get(c.slug);
        let ratio = null, basis = null;
        if (own && own.length) { ratio = mean(own); basis = 'measured-ratio'; }
        else if (prov && prov.length) { ratio = mean(prov); basis = 'provisional-ratio'; }
        else if (peer) { ratio = peer; basis = 'peer-ratio'; }
        if (!ratio) continue;
        const est = exactEqual.get(c) * ratio;
        exact.set(c, est);
        c.estimateAvg = round3(est);
        c.estimateAvgLabel = formatPrice(est);
        c.estimateBasis = basis;
        c.estimateRatio = round3(ratio);
      }
    }
  }

  // Attach QoQ / YoY per cell (against same provider, adjacent periods).
  //
  // In the model-day view the change is LIKE-FOR-LIKE (matchedModelGrowth):
  // measured on the models priced in both quarters, never on the two lineup
  // averages, so a model listed or retired between them is not a price move.
  // The level stays the whole lineup's average. Where too few models were
  // priced in both, the change is refused with a reason instead.
  //
  // The usage-weighted view compares the levels it SHOWS: what the market paid
  // does move when it buys a different mix. Where a quarter's measured value
  // was withheld, the Avg view shows its estimate, and the change is taken
  // from that same figure — otherwise QoQ/YoY sat blank under an Avg row with
  // every cell filled (29 of 40 cells on 2026-09-24), and the two views of one
  // series disagreed. A change resting on an estimate says so
  // (<key>Estimated, <key>Note), with the like-for-like list-price change
  // beside it as a cross-check.
  //
  // Whether two quarters can be compared at all is decided in ONE place,
  // _model-price-basis.js: a quarter is on the changed measure if ANY model in
  // it was touched by the change, and the difference of two levels on
  // different measures is refused — one touched $1.25 model among cheap
  // untouched ones carries most of an equal-weighted $/token mean, so there is
  // no share of touched models below which that difference stops being the
  // artefact (Google's -19.5% for 2026-Q3 was 13 of its 29 models). The
  // model-day view can still measure the change like-for-like on the models
  // the change touched in neither quarter, when those are at least half the
  // lineup; the weighted view has no per-model split to fall back on, so there
  // the change stays refused.
  const rowByQuarter = new Map(rows.map(r => [r.quarter, r]));
  const earliestQuarter = quarters[quarters.length - 1];
  const level = (c) => {
    if (!c) return null;
    if (c.avg !== null) return { value: exact.get(c) ?? c.avg, basis: c.basis, estimated: false };
    if (weighting && c.estimateAvg != null) {
      return { value: exact.get(c) ?? c.estimateAvg, basis: c.basis, estimated: true, ratio: c.estimateRatio };
    }
    return null;
  };
  for (const row of rows) {
    row.cells.forEach((cell, idx) => {
      const stats = levelsBySlug.get(cell.slug);
      const cur = level(cell);
      const nowLabel = periodLabel(row.quarter);
      // For each of qoq (the prior quarter) and yoy (the same quarter a year
      // earlier) this writes <key> and <key>Label, and where they apply
      // <key>MeasureChanged + <key>Reason (a change of measure),
      // <key>MatchedModels (models priced in both quarters),
      // <key>TooFewMatched + <key>Reason (refused: too few of them),
      // <key>Estimated (usage-weighted: a side is an estimate),
      // <key>Reason alone (nothing to compare against), or
      // <key>Note (what a figure rests on).
      for (const [key, then] of [['qoq', priorQuarter(row.quarter)], ['yoy', yearAgoQuarter(row.quarter)]]) {
        const thenLabel = periodLabel(then);
        const prior = level(rowByQuarter.get(then)?.cells?.[idx]);
        let growth = basisGrowth(cur, prior);
        if (cur && !prior) {
          cell[key + 'Reason'] = noComparatorReason(then, earliestQuarter);
        } else if (isMeasureChange(cur, prior)) {
          const m = weighting
            ? null
            : matchedModelGrowth(stats.get(row.quarter), stats.get(then), { untouchedOnly: true });
          if (m && m.growth !== null) {
            growth = m.growth;
            cell[key + 'MatchedModels'] = m.matched;
            cell[key + 'Note'] = likeForLikeNote(m, nowLabel, thenLabel, changeDateOf(cur, prior));
          } else {
            // Refused: a model the change moved cannot come back in, and too
            // few it left alone remain to stand for the lineup.
            cell[key + 'MeasureChanged'] = true;
            cell[key + 'Reason'] = measureChangeReason(cur, prior, thenLabel, events) +
              (m ? ' Measuring it on the models the change did not touch was tried: ' +
                (m.matched === 1 ? 'only 1 of them was' : 'only ' + m.matched + ' of them were') +
                ' priced in both quarters, against ' + m.models + ' models priced in ' + nowLabel +
                ' — too few to stand for the lineup.' : '');
          }
        } else if (growth !== null && !weighting) {
          const m = matchedModelGrowth(stats.get(row.quarter), stats.get(then));
          growth = m.growth;
          cell[key + 'MatchedModels'] = m.matched;
          if (growth === null) {
            cell[key + 'TooFewMatched'] = true;
            cell[key + 'Reason'] = tooFewMatchedReason(m, nowLabel, thenLabel);
          } else {
            cell[key + 'Note'] = likeForLikeNote(m, nowLabel, thenLabel);
          }
        } else if (growth !== null && (cur.estimated || prior.estimated)) {
          cell[key + 'Estimated'] = true;
          const m = matchedModelGrowth(stats.get(row.quarter), stats.get(then));
          cell[key + 'Note'] = estimatedChangeNote(cur, prior, nowLabel, thenLabel, m);
        }
        cell[key] = growth;
        cell[key + 'Label'] = formatPct(growth);
      }
    });
  }

  return { quarters: rows };
}

// Exported for the growth tests, which drive the usage-weighted path with
// synthetic weights; the route itself exports only its handlers.
export { buildMatrix };

/** Mark the current calendar quarter (UTC) as partial in the response. */
function currentQuarterKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based
  return y + '-Q' + (Math.floor(m / 3) + 1);
}

/**
 * Fetch one of this origin's own endpoints. The weekly OpenRouter series
 * already lives behind /api/openrouter-chart-weekly with its own KV-backed
 * capture and fallback handling; re-reading KV here would duplicate that
 * logic and let the two drift.
 */
async function fetchSameOrigin(request, path) {
  try {
    const r = await fetch(new URL(request.url).origin + path, {
      headers: { 'User-Agent': 'gdash-provider-pricing/1.0', Accept: 'application/json' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

/**
 * Build the resolver that maps an OpenRouter model name to a priced model AND
 * the price in force over a given day window, using only rows present in THIS
 * request's upstream payload. Deriving it from live data rather than a
 * hardcoded table means a renamed or delisted model degrades into "unpriced" —
 * visibly lowering coverage — instead of silently matching the wrong price.
 *
 * Prices are indexed BY DAY, and a lookup averages only the days in the window
 * it is asked about. Two problems that solves:
 *
 *   - A catalog spanning all history would count a model as covered in a
 *     quarter where it has no price row at all.
 *   - A quarterly mean price would charge a mid-quarter reprice to every token
 *     of the quarter. Traffic concentrated after a price cut would be billed
 *     partly at the old price, which nobody paid. Measured on live data this
 *     moves Google's 2025-Q3 weighted input price by -2.8%.
 *
 * A window with no priced day returns null, so those tokens are dropped and
 * count against coverage rather than borrowing a price from another week.
 */
function makeModelResolver(providerResults, metric, book, levelsBySlug) {
  const catalog = new Map();                       // slug -> model -> (day -> price)
  for (const pr of providerResults) {
    const byModel = new Map();
    for (const row of pr.rows) {
      if (typeof row?.model !== 'string' || isAltBillingSku(row.model)) continue;
      const v = readPrice(row, metric);
      if (v === null) continue;
      const day = rowDay(row);
      if (!day) continue;
      if (!byModel.has(row.model)) byModel.set(row.model, new Map());
      byModel.get(row.model).set(day, v);
    }
    catalog.set(pr.slug, byModel);
  }

  /**
   * Mean of a model's daily prices across [from, to], counting only days on
   * the quarter's own measure — the same days the model-day level for that
   * provider-quarter rests on — so a week straddling a change of measure is
   * charged at one measure, never a blend. { price, priced }: price is null
   * when no day counts; priced says whether the window had any price at all.
   */
  const meanOver = (slug, model, days, from, to, basis) => {
    let sum = 0;
    let n = 0;
    let priced = false;
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const v = days.get(day);
      if (typeof v !== 'number') continue;
      priced = true;
      if (!countsToward(book.basisOf(slug, model, day), basis)) continue;
      sum += v; n += 1;
    }
    return { price: n ? sum / n : null, priced };
  };

  return (pptSlug, orModel, quarter, from, to) => {
    const byModel = catalog.get(pptSlug);
    if (!byModel) return null;
    const basis = levelsBySlug.get(pptSlug)?.get(quarter)?.basis || BASIS_ORIGIN;
    for (const candidate of priceModelCandidates(orModel)) {
      const days = byModel.get(candidate);
      if (!days) continue;
      const m = meanOver(pptSlug, candidate, days, from, to, basis);
      if (m.price !== null) return { model: candidate, price: m.price };
      // Priced in this window, but only on the other side of a change: the
      // tokens are dropped (lowering coverage) rather than re-matched to a
      // different candidate name.
      if (m.priced) return null;
    }
    return null;
  };
}

/**
 * Overlay accumulated full-catalogue weeks onto the top-9 weekly chart.
 *
 * The chart names ~9 models a week and rolls the rest into "Others", which is
 * the real ceiling on usage-weighted coverage — it is why OpenAI can only ever
 * be measured at 2–16% of its own volume. /api/openrouter-model-usage banks the
 * full ~500-model ranking one completed week at a time; wherever it has a week,
 * that week's weights come from the full catalogue instead.
 *
 * Two things this fixes at once. Coverage stops being capped at whatever the
 * top-9 happened to include. And because the full catalogue counts prompt and
 * completion tokens separately, the INPUT average can be weighted by prompt
 * tokens and the OUTPUT average by completion tokens, rather than both sharing
 * one combined count as the chart forces.
 *
 * Weeks are keyed by ISO start and replaced wholesale, never blended: mixing a
 * 9-model numerator with a 500-model one inside a single week would produce a
 * coverage figure describing neither.
 */
function overlayRichModelWeeks(chartSeries, richSeries, metric) {
  const rich = Array.isArray(richSeries?.weeks) ? richSeries.weeks : [];
  if (!rich.length) return { series: chartSeries, richWeeks: [] };

  const byStart = new Map();
  for (const w of (chartSeries?.weeks || [])) {
    if (w?.start) byStart.set(w.start, w);
  }
  const used = [];
  for (const w of rich) {
    const tokens = metric === 'output' ? w.completionTokens : w.promptTokens;
    if (!w?.start || !tokens || !Object.keys(tokens).length) continue;
    byStart.set(w.start, {
      start: w.start,
      end: w.end,
      partial: false,           // only completed weeks are ever banked
      allModels: tokens,
      totalRaw: Object.values(tokens).reduce((s, v) => s + v, 0),
    });
    used.push(w.start);
  }
  return {
    series: { weeks: [...byStart.keys()].sort().map(s => byStart.get(s)) },
    richWeeks: used.sort(),
  };
}

/** Latest week start in a {weeks:[{start}]} payload, or null. */
function lastWeekStart(series) {
  const weeks = series?.weeks;
  if (!Array.isArray(weeks) || !weeks.length) return null;
  return weeks[weeks.length - 1]?.start || null;
}

/**
 * Union the captured provider history with the live market-share series,
 * keyed by week start, live winning on overlap.
 *
 * Neither source covers the whole span on its own: the capture reaches back to
 * 2025-05-26 but stopped on 2026-06-08, while the live dataset starts at
 * 2025-09-22 and is current. Preferring live on overlap means a week is
 * described by the authoritative source wherever one exists, and the stale
 * copy only fills the head of the history it uniquely holds.
 */
function mergeProviderWeeks(captured, live) {
  const byStart = new Map();
  for (const w of (captured?.weeks || [])) {
    if (w?.start && w.providers) byStart.set(w.start, w);
  }
  for (const w of (live?.weeks || [])) {
    if (w?.start && w.providers) byStart.set(w.start, w);
  }
  if (!byStart.size) return null;
  return {
    weeks: [...byStart.keys()].sort().map(start => byStart.get(start)),
  };
}

/**
 * For the open/proprietary footnote: per side, the labs contributing a priced
 * model and how many models each, over the whole history. Alternate-billing
 * SKUs and unpriced rows are left out, as they are from the averages.
 */
function opennessSummary(results, metric) {
  const label = new Map([...PROVIDERS, ...OPENNESS_EXTRA_PROVIDERS].map(p => [p.slug, p.label]));
  const sides = new Map(OPENNESS_GROUPS.map(g => [g.slug, new Map()]));
  for (const pr of results) {
    for (const row of pr.rows) {
      if (typeof row?.model !== 'string' || isAltBillingSku(row.model)) continue;
      if (readPrice(row, metric) === null) continue;
      const labs = sides.get(modelOpenness(pr.slug, row.model));
      if (!labs.has(pr.slug)) labs.set(pr.slug, new Set());
      labs.get(pr.slug).add(row.model);
    }
  }
  return OPENNESS_GROUPS.map(g => ({
    slug: g.slug,
    label: g.label,
    labs: [...sides.get(g.slug)]
      .map(([slug, models]) => ({ slug, label: label.get(slug) || slug, models: models.size }))
      .sort((a, b) => b.models - a.models),
  }));
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const metric = (url.searchParams.get('metric') || 'input').toLowerCase();
  if (metric !== 'input' && metric !== 'output') {
    return jsonResp({ success: false, error: 'metric must be "input" or "output"' }, 400);
  }
  const group = (url.searchParams.get('group') || 'company').toLowerCase();
  if (group !== 'company' && group !== 'openness') {
    return jsonResp({ success: false, error: 'group must be "company" or "openness"' }, 400);
  }
  const weight = (url.searchParams.get('weight') || 'equal').toLowerCase();
  if (weight !== 'equal' && weight !== 'usage') {
    return jsonResp({ success: false, error: 'weight must be "equal" or "usage"' }, 400);
  }
  // The usage weighting certifies each provider-quarter against that
  // provider's own OpenRouter total, and a provider's total cannot be split
  // into its open and proprietary models, so the open/proprietary view is
  // model-day only. Refused rather than quietly answered in model-day terms.
  if (group === 'openness' && weight === 'usage') {
    return jsonResp({ success: false, error: 'group=openness is available with weight=equal only' }, 400);
  }

  // Validation runs OUTSIDE the cache so a 400 is never stored.
  //
  // metric, weight and group all go in the key. They are the only parameters
  // this handler reads, and each changes every figure in the body — a key that
  // dropped one would hand a reader another question's numbers, plausibly and
  // with no error.
  // The client's cache-busting b=<build hash> is deliberately NOT in the key:
  // it does not affect the body, and anything a caller can set freely would let
  // one request per distinct value trigger another ~35 MB upstream fan-out.
  return withEdgeCache(
    context,
    // browserTtl 0 restores the decision documented in jsonResp above: a
    // browser max-age pinned whatever a tab first loaded, and let two tabs
    // opened minutes apart disagree. With the edge cache in front, that
    // revalidation now costs ~80 ms instead of a full fan-out.
    { params: { metric, weight, group }, ttl: CACHE_TTL, browserTtl: 0 },
    () => buildProviderMatrix(request, metric, weight, group),
  );
}

/**
 * The real work: eight upstream providers, ~35 MB downloaded to produce ~6.6 KB.
 * Runs only on an edge-cache miss now, where it used to run on every request.
 */
async function buildProviderMatrix(request, metric, weight, group = 'company') {
  const openness = group === 'openness';
  // The open/proprietary view also reads the open labs that have no company
  // column — without Qwen, Kimi, GLM and MiniMax the open-weight side would be
  // mostly DeepSeek and Llama. ~15 MB more upstream, on this view only.
  const results = await fetchAllProviders(openness ? [...PROVIDERS, ...OPENNESS_EXTRA_PROVIDERS] : PROVIDERS);
  const anyRows = results.some(r => r.rows.length);
  if (!anyRows) {
    return jsonResp({
      success: false,
      error: 'Upstream returned no rows for any provider',
      errors: results.map(r => ({ slug: r.slug, error: r.error })),
    }, 502, { 'Cache-Control': 'no-store' });
  }

  // Which measure every observation sits on, decided once from this
  // request's own rows (see _model-price-basis.js), and every
  // provider-quarter's level on one measure. Both weightings read these.
  const book = buildBasisBook(results, metric);
  const levels = openness
    ? providerQuarterLevels(results, metric, book, (slug, model) =>
        ({ column: modelOpenness(slug, model), model: slug + '/' + model }))
    : providerQuarterLevels(results, metric, book);

  // Usage weighting needs two separate captures: per-model tokens for the
  // weights, and per-provider totals for the coverage denominator. If either
  // is missing the request does NOT silently fall back to equal weighting —
  // that would answer a different question than the one asked — it returns
  // the matrix with every weighted cell withheld and says why.
  let weighting = null;
  let weightMeta = null;
  if (weight === 'usage') {
    // The provider denominator is read LIVE from OpenRouter's market-share
    // dataset rather than from the browser-captured copy in KV. That capture
    // silently stopped persisting on 2026-06-09 — its detector rejected the
    // payload once OpenRouter wrapped it in `{"data":[…]}` — and every
    // usage-weighted cell for 2026-Q2 and Q3 was withheld for want of a
    // denominator that was in fact available the whole time. The captured copy
    // is still merged underneath because it reaches back further (2025-05-26)
    // than the live dataset (2025-09-22), so the union covers more history
    // than either alone.
    const [chartSeries, capturedProviders, liveProviders, richSeries] = await Promise.all([
      fetchSameOrigin(request, '/api/openrouter-chart-weekly?full=1'),
      fetchSameOrigin(request, '/api/openrouter-chart-weekly?providers=1'),
      fetchMarketShare('week').catch(e => ({ error: e.message })),
      fetchSameOrigin(request, '/api/openrouter-model-usage'),
    ]);
    const liveOk = !!liveProviders && Array.isArray(liveProviders.weeks);
    const providerSeries = mergeProviderWeeks(capturedProviders, liveOk ? liveProviders : null);
    const { series: modelSeries, richWeeks } =
      overlayRichModelWeeks(chartSeries, richSeries, metric);

    const built = buildUsageWeights(
      modelSeries, providerSeries, makeModelResolver(results, metric, book, levels),
    );
    // Both series are required. Without the model series there are no weights;
    // without the provider series there is no denominator to certify them
    // against. Either way the weighted view has nothing it can honestly say.
    const seriesAvailable = !!modelSeries && !!providerSeries;
    weighting = { weights: built.weights, coverage: built.coverage, seriesAvailable };
    weightMeta = {
      source: 'weights from openrouter.ai/rankings weekly token series; provider totals ' +
        'read live from the market-share dataset, merged over the captured history',
      modelSeriesAvailable: !!modelSeries,
      providerSeriesAvailable: !!providerSeries,
      providerSeriesLive: liveOk,
      providerSeriesLiveError: liveOk ? null : (liveProviders?.error || 'unavailable'),
      providerSeriesCapturedLatestWeek: lastWeekStart(capturedProviders),
      // Weeks whose weights came from the full ~500-model catalogue rather
      // than the top-9 chart. Coverage on these is not capped by the chart,
      // and input/output are weighted by prompt/completion tokens separately.
      fullCatalogueWeeks: richWeeks,
      fullCatalogueWeekCount: richWeeks.length,
      providerSeriesLiveLatestWeek: liveOk ? lastWeekStart(liveProviders) : null,
      modelSeriesLatestWeek: built.modelSeriesLatestWeek,
      providerSeriesLatestWeek: built.providerSeriesLatestWeek,
      uncertifiedQuarters: Array.from(built.uncertifiedQuarters).sort().reverse(),
      incompleteProviderQuarters: Array.from(built.incompleteProviderQuarters).sort().reverse(),
      minCoverage: MIN_COVERAGE,
      minWeightedModels: MIN_WEIGHTED_MODELS,
      maxTopWeightShare: MAX_TOP_WEIGHT_SHARE,
      providerSlugMap: PPT_TO_OR_PROVIDER,
      caveats: [
        'OpenRouter is one marketplace, not the whole market — first-party API traffic is not represented.',
        'Where the full per-model catalogue has been banked for a week, coverage is not capped; elsewhere OpenRouter names only its top models each week and buckets the rest as "Others".',
        'Chart-sourced weeks combine prompt and completion into one count, so input and output share weights there; full-catalogue weeks weight input by prompt tokens and output by completion tokens.',
        'A quarter publishes only when every week in it appears in both captures; a partly-measured quarter is withheld.',
        'A provider absent from a week\'s ranking is folded into "others" by OpenRouter, so that provider-quarter\'s coverage is unknowable and withheld.',
        '":free" and other variant SKUs are excluded from the weights — folding them into the paid model would price free traffic as paid.',
        'Tokens are charged at the price in force the week they were served, not a quarterly mean, so mid-quarter repricing is not spread over traffic that never paid it.',
        'A cell where one model carries more than ' + (MAX_TOP_WEIGHT_SHARE * 100).toFixed(0) + '% of the weight is withheld — that is one model\'s price, not a provider average.',
      ],
    };
  }

  const columns = openness ? OPENNESS_GROUPS : PROVIDERS;
  const { quarters } = buildMatrix(levels, weighting, book.events, columns);
  const currentQ = currentQuarterKey();
  quarters.forEach(q => { q.partial = q.quarter === currentQ; });

  // Figure out earliest date observed across all providers (honest floor)
  let earliestDate = null;
  for (const r of results) {
    for (const row of r.rows) {
      if (typeof row.date === 'string' && (!earliestDate || row.date < earliestDate)) {
        earliestDate = row.date;
      }
    }
  }

  // A response that lost providers must NOT be cached. Every 200 used to carry
  // a six-hour cache regardless of content, so a single flaky moment upstream
  // was pinned at the edge and served to everyone for six hours — which is why
  // the dashboard kept showing "upstream temporarily unavailable" long after
  // the upstream had recovered, and why two browser tabs on the same URL
  // disagreed: one held the cached failure, the other a healthy response.
  const degraded = results.some(r => r.error);
  return jsonResp({
    success: true,
    degraded,
    metric,
    weight,
    group,
    weighting: weightMeta,
    source: UPSTREAM_BASE,
    // Which labs each side of the open/proprietary view draws on, for the
    // footnote. Classified per model, see _model-openness.js.
    openness: openness ? opennessSummary(results, metric) : undefined,
    sourceNote: openness
      ? 'Upstream is pricepertoken.com\'s own historical pricing API, read for ' +
        [...PROVIDERS, ...OPENNESS_EXTRA_PROVIDERS].length + ' labs. Each model is ' +
        'classed open-weight (its weights are published to download, under any ' +
        'licence) or proprietary (API-only), and each side is averaged ' +
        'equal-weighted across every (model, day) observation in the quarter. ' +
        'QoQ/YoY are like-for-like over the models priced in both quarters, as in ' +
        'the by-company view; across the source\'s change of measure they compare ' +
        'only the models it did not touch, and are not computed where those are ' +
        'fewer than half of the quarter\'s models.'
      : weight === 'usage'
      ? 'Prices come from pricepertoken.com\'s historical pricing API; weights ' +
        'come from OpenRouter\'s weekly per-model token volumes. Each model\'s ' +
        'mean price in the quarter is weighted by the tokens it served, so the ' +
        'cell reads as what was actually paid rather than a list-price mean. ' +
        'A cell that cannot be measured this way is withheld as a measurement. ' +
        'Where a ratio of usage-weighted to list price exists to scale from, the ' +
        'cell carries an estimate instead: the quarter\'s list-price average ' +
        'times that ratio, reported with its basis and the reason the ' +
        'measurement was withheld. QoQ/YoY compare the figures shown, measured ' +
        'or estimated; a change resting on an estimate says so. Where the source ' +
        'changed what it reports, each quarter averages one measure only and ' +
        'QoQ/YoY across the change are not computed.'
      : 'Upstream is pricepertoken.com\'s own historical pricing API. ' +
        'Per-provider daily model prices are averaged equal-weighted across ' +
        'every (model, day) observation in each calendar quarter. No synthetic ' +
        'backfill — pre-upstream quarters simply do not appear. QoQ/YoY are ' +
        'like-for-like: they compare only the models priced in both quarters, ' +
        'each at its own average price, so a model being listed or retired is ' +
        'not read as a price move; they are not computed where fewer than two ' +
        'models, or fewer than half of the quarter\'s models, were priced in ' +
        'both. Where the source changed what it reports, each quarter averages ' +
        'one measure only, and QoQ/YoY across the change compare only the models ' +
        'it did not touch — not computed where those are fewer than half the ' +
        'quarter\'s models.',
    earliestDateObserved: earliestDate ? earliestDate.slice(0, 10) : null,
    // Every day on which the source changed what it reports, found from this
    // response's own rows, and the plain-words caption the matrix shows for
    // it ({ headline, detail }, or null when there is none).
    measureBreaks: {
      events: book.events,
      summary: describeMeasureBreaks([book.events], slug => PROVIDERS.find(p => p.slug === slug)?.label || slug),
    },
    providers: columns,
    quarters,
    providerErrors: results.filter(r => r.error).map(r => ({ slug: r.slug, error: r.error, attempts: r.attempts })),
    // Providers that needed more than one attempt. Zero here is the healthy
    // state; a persistent non-zero count means the upstream is degrading and
    // the retries are the only thing hiding it.
    providerRetries: results.filter(r => !r.error && r.attempts > 1)
      .map(r => ({ slug: r.slug, attempts: r.attempts })),
  }, 200, degraded ? { 'Cache-Control': 'no-store' } : {});
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
