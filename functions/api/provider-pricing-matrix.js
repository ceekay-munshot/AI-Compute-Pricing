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
 * The matrix is cached at the CF edge for CACHE_TTL seconds.
 *
 * Honesty rules — the whole reason this exists:
 *   - No synthetic backfill. Quarters prior to the upstream's depth simply
 *     don't appear in the response.
 *   - Upstream's earliest date observed is 2025-07-28, so the historical
 *     floor is 2025-Q3 (partial). Client asked for 2023+; we do not fake it.
 *   - YoY is only returned when a same-quarter one year earlier row exists
 *     with real data.
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

const UPSTREAM_BASE = 'https://api.pricepertoken.com/api/provider-pricing-history/';
const CACHE_TTL = 21600; // 6 hours

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
        const rows = Array.isArray(j?.results) ? j.results : [];
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
 * Build the matrix from a list of provider rowsets.
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
function buildMatrix(providerResults, metric, weighting) {
  const priceField = metric === 'output' ? 'pricing_completion' : 'pricing_prompt';

  // Collect the union of quarter keys across providers
  const allQuarters = new Set();
  const perProvider = new Map();

  for (const pr of providerResults) {
    // quarter -> { sum, count, modelSet }
    const buckets = new Map();
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
      if (typeof row?.model === 'string' && row.model.includes(':')) continue;
      const v = row?.[priceField];
      // Strictly > 0: $0.00 rows are free/experimental SKUs (Google's
      // gemini-2.5-pro-exp-*, lyria-*) and drag a paid-lineup average down.
      if (typeof v !== 'number' || !isFinite(v) || v <= 0) continue;
      const dateStr = row?.date;
      if (typeof dateStr !== 'string' || dateStr.length < 10) continue;
      const q = quarterOf(dateStr);
      allQuarters.add(q);
      if (!buckets.has(q)) buckets.set(q, { sum: 0, count: 0, models: new Set() });
      const b = buckets.get(q);
      b.sum += v;
      b.count += 1;
      if (row.model) b.models.add(row.model);
    }
    perProvider.set(pr.slug, buckets);
  }

  // Sort quarters newest first
  const quarters = Array.from(allQuarters).sort().reverse();

  // Build output rows (one row per quarter)
  const rows = quarters.map(q => {
    const cells = PROVIDERS.map(p => {
      const b = perProvider.get(p.slug);
      const stat = b && b.get(q);
      if (!stat) {
        return { slug: p.slug, avg: null, avgLabel: '—', obsCount: 0, modelCount: 0 };
      }
      // Upstream values are $/token; scale to $/1M tokens
      const equalAvg = (stat.sum / stat.count) * 1_000_000;
      const cell = {
        slug: p.slug,
        avg: round3(equalAvg),
        avgLabel: formatPrice(equalAvg),
        obsCount: stat.count,
        modelCount: stat.models.size,
      };
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
          const r = c.avg / c.equalAvg;
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
        const est = c.equalAvg * ratio;
        c.estimateAvg = round3(est);
        c.estimateAvgLabel = formatPrice(est);
        c.estimateBasis = basis;
        c.estimateRatio = round3(ratio);
      }
    }
  }

  // Attach QoQ / YoY per cell (against same provider, adjacent periods).
  // Null-safe: if the comparison quarter is absent or has null avg, leave null.
  const rowByQuarter = new Map(rows.map(r => [r.quarter, r]));
  for (const row of rows) {
    row.cells.forEach((cell, idx) => {
      const priorRow = rowByQuarter.get(priorQuarter(row.quarter));
      const yearRow  = rowByQuarter.get(yearAgoQuarter(row.quarter));
      const priorCell = priorRow?.cells?.[idx];
      const yearCell  = yearRow?.cells?.[idx];
      cell.qoq = (cell.avg !== null && priorCell?.avg && priorCell.avg > 0)
        ? round3((cell.avg - priorCell.avg) / priorCell.avg) : null;
      cell.qoqLabel = formatPct(cell.qoq);
      cell.yoy = (cell.avg !== null && yearCell?.avg && yearCell.avg > 0)
        ? round3((cell.avg - yearCell.avg) / yearCell.avg) : null;
      cell.yoyLabel = formatPct(cell.yoy);
    });
  }

  return { quarters: rows };
}

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
function makeModelResolver(providerResults, priceField) {
  const catalog = new Map();                       // slug -> model -> (day -> price)
  for (const pr of providerResults) {
    const byModel = new Map();
    for (const row of pr.rows) {
      if (typeof row?.model !== 'string' || row.model.includes(':')) continue;
      const v = row?.[priceField];
      if (typeof v !== 'number' || !isFinite(v) || v <= 0) continue;
      const date = row?.date;
      if (typeof date !== 'string' || date.length < 10) continue;
      if (!byModel.has(row.model)) byModel.set(row.model, new Map());
      byModel.get(row.model).set(date.slice(0, 10), v);
    }
    catalog.set(pr.slug, byModel);
  }

  /** Mean of a model's daily prices across [from, to]; null if none priced. */
  const meanOver = (days, from, to) => {
    let sum = 0;
    let n = 0;
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
      const v = days.get(new Date(t).toISOString().slice(0, 10));
      if (typeof v === 'number') { sum += v; n += 1; }
    }
    return n ? sum / n : null;
  };

  return (pptSlug, orModel, _quarter, from, to) => {
    const byModel = catalog.get(pptSlug);
    if (!byModel) return null;
    for (const candidate of priceModelCandidates(orModel)) {
      const days = byModel.get(candidate);
      if (!days) continue;
      const price = meanOver(days, from, to);
      if (price !== null) return { model: candidate, price };
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

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const metric = (url.searchParams.get('metric') || 'input').toLowerCase();
  if (metric !== 'input' && metric !== 'output') {
    return jsonResp({ success: false, error: 'metric must be "input" or "output"' }, 400);
  }
  const weight = (url.searchParams.get('weight') || 'equal').toLowerCase();
  if (weight !== 'equal' && weight !== 'usage') {
    return jsonResp({ success: false, error: 'weight must be "equal" or "usage"' }, 400);
  }

  const results = await fetchAllProviders(PROVIDERS);
  const anyRows = results.some(r => r.rows.length);
  if (!anyRows) {
    return jsonResp({
      success: false,
      error: 'Upstream returned no rows for any provider',
      errors: results.map(r => ({ slug: r.slug, error: r.error })),
    }, 502, { 'Cache-Control': 'no-store' });
  }

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

    const priceField = metric === 'output' ? 'pricing_completion' : 'pricing_prompt';
    const built = buildUsageWeights(
      modelSeries, providerSeries, makeModelResolver(results, priceField),
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

  const { quarters } = buildMatrix(results, metric, weighting);
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
    weighting: weightMeta,
    source: UPSTREAM_BASE,
    sourceNote: weight === 'usage'
      ? 'Prices come from pricepertoken.com\'s historical pricing API; weights ' +
        'come from OpenRouter\'s weekly per-model token volumes. Each model\'s ' +
        'mean price in the quarter is weighted by the tokens it served, so the ' +
        'cell reads as what was actually paid rather than a list-price mean. ' +
        'Cells whose weights do not cover enough of a provider\'s volume are ' +
        'withheld with a stated reason, never estimated.'
      : 'Upstream is pricepertoken.com\'s own historical pricing API. ' +
        'Per-provider daily model prices are averaged equal-weighted across ' +
        'every (model, day) observation in each calendar quarter. No synthetic ' +
        'backfill — pre-upstream quarters simply do not appear.',
    earliestDateObserved: earliestDate ? earliestDate.slice(0, 10) : null,
    providers: PROVIDERS,
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
