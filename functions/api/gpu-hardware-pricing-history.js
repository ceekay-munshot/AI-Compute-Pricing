/**
 * Cloudflare Pages Function — GPU Pricing History Read
 * Route: /api/gpu-hardware-pricing-history
 * Method: GET
 *
 * Layers on top of the canonical daily history (`index:days` + the
 * `day:YYYY-MM-DD` snapshots written by /api/history-capture). Extracts
 * the `gpu` block from each snapshot.
 *
 * Query params:
 *   ?window=<integer days>   For daily view: default 60, clamp 7..180.
 *                            For quarterly view: auto-bumps to 400 unless
 *                            explicitly set, so multiple quarters are
 *                            included.
 *   ?view=daily|quarter      Default daily. Quarter returns calendar-
 *                            quarter aggregations and QoQ comparisons.
 *   ?include=real|all        Default real. "real" excludes synthetic /
 *                            backfill-only snapshots from the primary
 *                            output (investor-facing). "all" includes
 *                            everything for debugging. trackingSinceDate
 *                            is always reported against the filter used.
 *
 * Real-vs-synthetic classification:
 *   A snapshot is "real" iff !snapshot.backfill AND its source string
 *   does not contain "backfill" (case-insensitive). This cleanly excludes
 *   both main-capture backfills (source:"backfill") and GPU-only validation
 *   seeds (source:"gpu-refresh-backfill"), while keeping cron captures,
 *   manual dev runs, and mid-day gpu-refresh merges.
 *
 * Response — daily view:
 *   {
 *     success, view:"daily",
 *     trackingSinceDate, latestDate, daysWithGPU,
 *     trackedSKUs, availableSKUs,
 *     enough: { d7, d30 },
 *     latest: { "Nvidia H100": {...} },
 *     series: { "Nvidia H100": [ {date, minPricePerHour, ...} ] },
 *     comparisons: { d7: {...}, d30: {...} },
 *     signals: { "Nvidia H100": "loosening" | ... }
 *   }
 *
 * Response — quarter view:
 *   {
 *     success, view:"quarter",
 *     trackingSinceRealDate, latestRealSnapshotDate,
 *     quartersAvailable: ["2026-Q1","2026-Q2"],
 *     trackedSKUs, availableSKUs,
 *     series: {
 *       "Nvidia H100": [
 *         {
 *           quarter:"2026-Q1", year, q, periodStart, periodEnd,
 *           firstRealSnapshotDateInQuarter, lastRealSnapshotDateInQuarter,
 *           daysCoveredInQuarter, quarterDayCount, coverageRatioWithinQuarter,
 *           lowCoverage,
 *           quarterOpenMinPricePerHour, quarterCloseMinPricePerHour,
 *           quarterAverageMinPricePerHour, quarterLowMinPricePerHour,
 *           quarterHighMinPricePerHour,
 *           quarterCloseProviderCount, quarterAverageProviderCount,
 *           quarterCloseSpreadMultiple, quarterAverageSpreadMultiple,
 *           isQuarterComplete, isQTD
 *         }, ...
 *       ]
 *     },
 *     qoq: {
 *       "Nvidia H100": {
 *         status: "ok" | "insufficient",
 *         currentQuarter, priorQuarter,
 *         currentClose, priorClose, qoqPct, qoqAbs,
 *         currentProviders, priorProviders, providerDelta,
 *         currentSpread, priorSpread, spreadDelta,
 *         currentIsQTD, coverageRatio
 *       }
 *     },
 *     signals: { "Nvidia H100": "loosening" | "tightening" | "stable" | "insufficient-data" }
 *   }
 */

import {
  BASIS_FLOOR,
  BASIS_MEDIAN,
  BASIS_LABEL,
  normalizeDailyPoint,
  periodHeadline,
  pricedDatesForBasis,
  periodGrowth,
  growthRefusalReason,
  detectBasisTimeline,
  basisChangeForPeriods,
  pctChange,
} from './_gpu-price-basis.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TRACKED_SKUS = [
  'Nvidia H100',
  'Nvidia H200',
  'Nvidia B200',
  'Nvidia GB200',
  'Nvidia A100',
  'Nvidia L40S',
];

function jsonResp(data, status = 200, cache = 'public, max-age=120, s-maxage=300') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cache,
      ...CORS,
    },
  });
}

function isRealSnapshot(snap) {
  if (!snap) return false;
  if (snap.backfill === true) return false;
  const src = typeof snap.source === 'string' ? snap.source : '';
  if (/backfill/i.test(src)) return false;
  return true;
}

export async function onRequestGet({ request, env }) {
  const kv = env?.HISTORY_KV;
  if (!kv) {
    return jsonResp(
      { success: false, error: 'HISTORY_KV not bound' },
      500,
      'no-store'
    );
  }

  const url = new URL(request.url);
  const view = (url.searchParams.get('view') || 'daily').toLowerCase();
  const isQuarter = view === 'quarter' || view === 'quarterly';
  const isFinancial = view === 'financial' || view === 'correlation';
  const include = (url.searchParams.get('include') || 'real').toLowerCase();
  const keepAll = include === 'all';

  // Window: daily default 60, quarter/financial default 400 (full cap).
  const windowParam = url.searchParams.get('window');
  let windowDays;
  if (windowParam != null) {
    windowDays = parseInt(windowParam, 10);
    if (!isFinite(windowDays) || windowDays < 7) windowDays = (isQuarter || isFinancial) ? 400 : 60;
    if (windowDays > 400) windowDays = 400;
  } else {
    windowDays = (isQuarter || isFinancial) ? 400 : 60;
  }

  const index = (await kv.get('index:days', 'json')) || [];
  if (!index.length) {
    if (isFinancial) return emptyFinancialResponse('no history yet');
    return emptyResponse('no history yet', isQuarter);
  }

  const dates = index.slice(0, windowDays);
  // Fetch all snapshots in parallel — same pattern as /api/history
  const snaps = await Promise.all(
    dates.map(async d => {
      const s = await kv.get('day:' + d, 'json');
      return s ? { date: d, snap: s } : null;
    })
  );

  // Build per-SKU series, newest-first → we'll reverse per-series to
  // oldest-first for chart friendliness.
  const series = {};
  const latestBySku = {};
  let daysWithGPU = 0;
  let trackingSince = null;    // earliest snapshot date (possibly synthetic if keepAll)
  let latestDate = null;
  let trackingSinceReal = null;
  let latestRealDate = null;

  for (const entry of snaps) {
    if (!entry) continue;
    const { date, snap } = entry;
    if (!snap || !snap.gpu || !Array.isArray(snap.gpu.models)) continue;
    const real = isRealSnapshot(snap);
    if (!real && !keepAll) continue;
    daysWithGPU++;
    if (!latestDate) latestDate = date;
    trackingSince = date; // loop is newest-first, so last non-null wins as earliest
    if (real) {
      if (!latestRealDate) latestRealDate = date;
      trackingSinceReal = date;
    }
    for (const m of snap.gpu.models) {
      const sku = m.gpuModel;
      if (!series[sku]) series[sku] = [];
      // Normalize on the way in, once, so every view below (daily, quarter,
      // financial) and every consumer of this endpoint sees the same measure
      // in the same field. The 2026-07-28 → 2026-08-21 captures carry their
      // price in maxPricePerHour because the parser of the day was still
      // looking for a range; normalizeDailyPoint moves it to the median
      // field it belongs in. See _gpu-price-basis.js for why that is safe.
      series[sku].push(normalizeDailyPoint({
        date,
        minPricePerHour: m.minPricePerHour,
        maxPricePerHour: m.maxPricePerHour,
        medianPricePerHour: m.medianPricePerHour,
        providerCount: m.providerCount,
        spreadAbsolute: m.spreadAbsolute,
        spreadMultiple: m.spreadMultiple,
        priceMidpoint: m.priceMidpoint,
        _real: real,
      }));
      if (!latestBySku[sku]) {
        latestBySku[sku] = normalizeDailyPoint({ date, ...m, _real: real });
      }
    }
  }

  // Flip each series to chronological order (oldest → newest) for charts.
  for (const k of Object.keys(series)) series[k].reverse();

  // Available SKUs — intersection of trackedSKUs and what we actually have data for.
  const availableSKUs = TRACKED_SKUS.filter(s => series[s] && series[s].length);

  // Comparisons: take the latest point and the point closest-to-but-not-newer
  // than N days ago; compute delta. If no such prior point exists, null.
  const mkComparison = nDays => {
    const out = {};
    for (const sku of availableSKUs) {
      const pts = series[sku];
      if (!pts || pts.length < 2) {
        out[sku] = { status: 'insufficient', pointsAvailable: pts?.length || 0 };
        continue;
      }
      const latest = pts[pts.length - 1];
      const targetTs = Date.parse(latest.date + 'T00:00:00Z') - nDays * 86400000;
      // walk backwards to find the oldest point that is NOT newer than targetTs
      let priorIdx = -1;
      for (let i = pts.length - 2; i >= 0; i--) {
        if (Date.parse(pts[i].date + 'T00:00:00Z') <= targetTs) {
          priorIdx = i;
          break;
        }
      }
      if (priorIdx < 0) {
        out[sku] = { status: 'insufficient', pointsAvailable: pts.length, oldest: pts[0].date };
        continue;
      }
      const prior = pts[priorIdx];
      // The requested window and the window actually measured are two
      // different things once the feed has a gap in it. Between 2026-08-21
      // and 2026-09-11 nothing was captured, so the "7-day" comparator was
      // silently 26 days old and still labelled d7. Report the real span.
      const actualSpanDays = Math.round(
        (Date.parse(latest.date + 'T00:00:00Z') - Date.parse(prior.date + 'T00:00:00Z')) / 86400000
      );
      // Price deltas are computed on the headline measure, and only when both
      // ends were measured the same way. A floor compared to a median is a
      // change of units, not a price move.
      const comparableBasis =
        latest.dailyBasis && prior.dailyBasis && latest.dailyBasis === prior.dailyBasis
          ? latest.dailyBasis
          : null;
      const priceDeltaPct = comparableBasis ? pctChange(latest.dailyPrice, prior.dailyPrice) : null;
      out[sku] = {
        status: 'ok',
        latestDate: latest.date,
        priorDate: prior.date,
        requestedWindowDays: nDays,
        actualSpanDays,
        // A comparator more than half again as old as asked for is not the
        // window it claims to be; consumers should say so rather than print
        // "7D" over a 26-day move.
        windowStretched: actualSpanDays > nDays * 1.5,
        priceBasis: comparableBasis,
        latestBasis: latest.dailyBasis || null,
        priorBasis: prior.dailyBasis || null,
        basisChanged: !!(latest.dailyBasis && prior.dailyBasis && latest.dailyBasis !== prior.dailyBasis),
        priceDeltaAbs:
          comparableBasis && latest.dailyPrice != null && prior.dailyPrice != null
            ? +(latest.dailyPrice - prior.dailyPrice).toFixed(4)
            : null,
        priceDeltaPct,
        // Retained under their original names so existing consumers keep
        // working; they mean "floor delta" and are null outside the floor era.
        minDeltaAbs:
          latest.minPricePerHour != null && prior.minPricePerHour != null
            ? +(latest.minPricePerHour - prior.minPricePerHour).toFixed(4)
            : null,
        minDeltaPct:
          latest.minPricePerHour != null && prior.minPricePerHour && prior.minPricePerHour > 0
            ? +(
                ((latest.minPricePerHour - prior.minPricePerHour) / prior.minPricePerHour) *
                100
              ).toFixed(2)
            : null,
        providerDelta:
          latest.providerCount != null && prior.providerCount != null
            ? latest.providerCount - prior.providerCount
            : null,
        spreadMultipleDelta:
          latest.spreadMultiple != null && prior.spreadMultiple != null
            ? +(latest.spreadMultiple - prior.spreadMultiple).toFixed(3)
            : null,
      };
    }
    return out;
  };

  const d7 = mkComparison(7);
  const d30 = mkComparison(30);

  // Signal classification — uses the 7D window.
  // loosening: providers ↑ or price ↓ meaningfully (>= 2%)
  // tightening: providers ↓ or price ↑ meaningfully (>= 2%)
  // stable: small movement in both dimensions
  //
  // A signal is a market claim, so it is refused whenever the evidence has
  // gone missing rather than quietly falling back to whatever is left. Two
  // ways that used to happen:
  //   • the price delta went null when the feed stopped publishing a floor,
  //     leaving provider count as the sole input. GB200 then read
  //     "tightening" because one vendor dropped off a listing page.
  //   • the comparator drifted to 26 days old across the capture gap and the
  //     move was still labelled a 7-day signal.
  const signals = {};
  const signalBasis = {};
  for (const sku of availableSKUs) {
    const c = d7[sku];
    if (!c || c.status !== 'ok') {
      signals[sku] = 'insufficient-data';
      signalBasis[sku] = { reason: 'no comparable observation 7 days back' };
      continue;
    }
    if (c.priceDeltaPct == null) {
      signals[sku] = 'insufficient-data';
      signalBasis[sku] = {
        reason: c.basisChanged
          ? 'the price measure changed between ' + c.priorDate + ' (' + c.priorBasis + ') and ' +
            c.latestDate + ' (' + c.latestBasis + '), so the two are not comparable'
          : 'no price on one side of the comparison',
        priorDate: c.priorDate,
        latestDate: c.latestDate,
      };
      continue;
    }
    if (c.windowStretched) {
      signals[sku] = 'insufficient-data';
      signalBasis[sku] = {
        reason: 'nearest comparator is ' + c.actualSpanDays + ' days old, not 7 — capture gap',
        priorDate: c.priorDate,
        latestDate: c.latestDate,
      };
      continue;
    }
    const pricePct = c.priceDeltaPct;
    const providerDelta = c.providerDelta;
    const priceDown = pricePct != null && pricePct <= -2;
    const priceUp = pricePct != null && pricePct >= 2;
    const providersUp = providerDelta != null && providerDelta > 0;
    const providersDown = providerDelta != null && providerDelta < 0;
    if ((priceDown && !providersDown) || (providersUp && !priceUp)) {
      signals[sku] = 'loosening';
    } else if ((priceUp && !providersUp) || (providersDown && !priceDown)) {
      signals[sku] = 'tightening';
    } else {
      signals[sku] = 'stable';
    }
  }

  // Enough-data flags: we need at least one point ≥ Nd old AND a latest point.
  const hasPoint = (sku, nDays) => {
    const pts = series[sku];
    if (!pts || pts.length < 2) return false;
    const latestTs = Date.parse(pts[pts.length - 1].date + 'T00:00:00Z');
    const target = latestTs - nDays * 86400000;
    return pts.some(p => Date.parse(p.date + 'T00:00:00Z') <= target);
  };
  const enough = {
    d7: availableSKUs.some(s => hasPoint(s, 7)),
    d30: availableSKUs.some(s => hasPoint(s, 30)),
  };

  if (isQuarter) {
    return buildQuarterResponse({
      series,
      latestBySku,
      trackingSinceReal,
      latestRealDate,
      trackingSince,
      latestDate,
      daysWithGPU,
      availableSKUs,
      windowDays,
      include,
    });
  }

  if (isFinancial) {
    return buildFinancialResponse({
      series,
      trackingSinceReal,
      latestRealDate,
      trackingSince,
      latestDate,
      daysWithGPU,
      availableSKUs,
      windowDays,
      include,
    });
  }

  return jsonResp({
    success: true,
    view: 'daily',
    include,
    trackingSinceDate: trackingSinceReal || trackingSince,
    trackingSinceRealDate: trackingSinceReal,
    latestDate: latestRealDate || latestDate,
    latestRealSnapshotDate: latestRealDate,
    daysWithGPU,
    windowDays,
    trackedSKUs: TRACKED_SKUS,
    availableSKUs,
    enough,
    latest: latestBySku,
    series,
    comparisons: { d7, d30 },
    signals,
    signalBasis,
    basisTimeline: detectBasisTimeline(series),
  });
}

/* ─── Quarter aggregation ──────────────────────────────────
   Calendar quarters: Q1=Jan–Mar, Q2=Apr–Jun, Q3=Jul–Sep, Q4=Oct–Dec (UTC).
   Aggregates operate on the already-filtered per-SKU series (real-only by
   default; series points include a `_real` flag but the caller already
   applied the include filter, so every point here is eligible). */

function quarterIdForDate(date) {
  const [y, m] = date.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return { id: y + '-Q' + q, year: y, q };
}

function quarterBounds(year, q) {
  const startMonth = (q - 1) * 3; // 0-indexed
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 1)); // exclusive
  end.setUTCDate(end.getUTCDate() - 1); // inclusive last day
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    days: Math.round((Date.UTC(year, startMonth + 3, 1) - Date.UTC(year, startMonth, 1)) / 86400000),
  };
}

function daysInclusive(startDate, endDate) {
  return Math.round(
    (Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400000
  ) + 1;
}

function avg(nums) {
  const valid = nums.filter(n => typeof n === 'number' && isFinite(n));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function aggregateQuartersForSKU(series, todayStr) {
  if (!series || !series.length) return [];
  // Group by quarter, preserving chronological order (series is already oldest-first).
  const groups = new Map();
  for (const pt of series) {
    const { id, year, q } = quarterIdForDate(pt.date);
    if (!groups.has(id)) groups.set(id, { id, year, q, points: [] });
    groups.get(id).points.push(pt);
  }
  const quarters = Array.from(groups.values()).sort((a, b) => a.id < b.id ? -1 : 1);
  return quarters.map(g => {
    const { start: periodStart, end: periodEnd, days: totalDaysInQuarter } = quarterBounds(g.year, g.q);
    const pts = g.points; // already ordered oldest → newest
    const first = pts[0];
    const last = pts[pts.length - 1];
    const mins = pts.map(p => p.minPricePerHour);
    const providers = pts.map(p => p.providerCount);
    const spreads = pts.map(p => p.spreadMultiple);
    const uniqDates = new Set(pts.map(p => p.date));
    const daysCovered = uniqDates.size;

    const isQTD = periodStart <= todayStr && todayStr <= periodEnd;
    const isComplete = periodEnd < todayStr;
    // Effective denominator for QTD: days elapsed so far within quarter
    const effectiveDays = isQTD ? daysInclusive(periodStart, todayStr) : totalDaysInQuarter;
    const coverageRatio = effectiveDays > 0 ? daysCovered / effectiveDays : null;

    const quarterAvgMin = avg(mins);
    const quarterAvgProviders = avg(providers);
    const quarterAvgSpread = avg(spreads);

    // The min-price fields above are floor-era only: the source stopped
    // publishing a floor on 2026-07-28, so open/close/average would all read
    // null for any quarter after that while the rows kept arriving. The
    // headline fields below carry whatever measure the quarter is actually
    // on, and say which, so a quarter never renders as priceless just
    // because the source renamed its field.
    const head = periodHeadline(pts);
    const pricedPts = pts.filter(p => p.dailyBasis === head.priceBasis && p.dailyPrice != null);
    const firstPriced = pricedPts[0] || null;
    const lastPriced = pricedPts[pricedPts.length - 1] || null;

    return {
      quarter: g.id,
      year: g.year,
      q: g.q,
      periodStart,
      periodEnd,
      firstRealSnapshotDateInQuarter: first.date,
      lastRealSnapshotDateInQuarter: last.date,
      daysCoveredInQuarter: daysCovered,
      quarterDayCount: effectiveDays,
      coverageRatioWithinQuarter: coverageRatio != null ? +coverageRatio.toFixed(3) : null,
      lowCoverage: coverageRatio != null && coverageRatio < 0.25,
      quarterOpenMinPricePerHour: first.minPricePerHour,
      quarterCloseMinPricePerHour: last.minPricePerHour,
      quarterAverageMinPricePerHour: quarterAvgMin != null ? +quarterAvgMin.toFixed(4) : null,
      // Basis-aware open/close/average — use these in preference to the
      // Min fields above, and never compare across a differing priceBasis.
      priceBasis: head.priceBasis,
      quarterOpenPricePerHour: firstPriced ? firstPriced.dailyPrice : null,
      quarterClosePricePerHour: lastPriced ? lastPriced.dailyPrice : null,
      quarterAveragePricePerHour: head.headlinePricePerHour,
      quarterOpenDate: firstPriced ? firstPriced.date : null,
      quarterCloseDate: lastPriced ? lastPriced.date : null,
      mixedBasis: head.mixedBasis,
      basisDayCounts: head.basisDayCounts,
      quarterLowMinPricePerHour: mins.length ? Math.min.apply(null, mins.filter(n => typeof n === 'number')) : null,
      quarterHighMinPricePerHour: mins.length ? Math.max.apply(null, mins.filter(n => typeof n === 'number')) : null,
      quarterCloseProviderCount: last.providerCount,
      quarterAverageProviderCount: quarterAvgProviders != null ? +quarterAvgProviders.toFixed(2) : null,
      quarterCloseSpreadMultiple: last.spreadMultiple,
      quarterAverageSpreadMultiple: quarterAvgSpread != null ? +quarterAvgSpread.toFixed(3) : null,
      isQuarterComplete: isComplete,
      isQTD,
      snapshotCount: pts.length,
    };
  });
}

// A supply signal is a claim about the market, so it needs a price move to
// rest on. With no comparable price the only input left is vendor count, and
// one provider dropping off a listing page would read as "tightening" — a
// market call manufactured out of a directory edit.
function classifyQoQSignal(qoqPct, providerDelta) {
  if (qoqPct == null) return 'insufficient-data';
  const priceDown = qoqPct != null && qoqPct <= -2;
  const priceUp = qoqPct != null && qoqPct >= 2;
  const providersUp = providerDelta != null && providerDelta > 0;
  const providersDown = providerDelta != null && providerDelta < 0;
  if ((priceDown && !providersDown) || (providersUp && !priceUp)) return 'loosening';
  if ((priceUp && !providersUp) || (providersDown && !priceDown)) return 'tightening';
  return 'stable';
}

function buildQuarterResponse(ctx) {
  const { series, latestBySku, trackingSinceReal, latestRealDate, trackingSince, latestDate,
          daysWithGPU, availableSKUs, windowDays, include } = ctx;
  const today = new Date().toISOString().slice(0, 10);

  const quarterSeries = {};
  const qoq = {};
  const signals = {};
  const quarterIdSet = new Set();

  for (const sku of availableSKUs) {
    const agg = aggregateQuartersForSKU(series[sku] || [], today);
    quarterSeries[sku] = agg;
    for (const a of agg) quarterIdSet.add(a.quarter);

    if (agg.length >= 2) {
      const current = agg[agg.length - 1];
      const prior = agg[agg.length - 2];
      // Close on the quarter's own measure, not on the floor field, which is
      // empty for every quarter after the source dropped its range.
      const currentClose = current.quarterClosePricePerHour;
      const priorClose = prior.quarterClosePricePerHour;
      // A close-to-close move only means something when both closes measure
      // the same thing. Across the change the two are different statistics,
      // so the comparison is refused rather than reported as a price move.
      const basisComparable = !!(current.priceBasis && prior.priceBasis && current.priceBasis === prior.priceBasis);
      const qoqAbs = (basisComparable && currentClose != null && priorClose != null)
        ? +(currentClose - priorClose).toFixed(4) : null;
      const qoqPct = basisComparable ? pctChange(currentClose, priorClose) : null;
      const providerDelta = (current.quarterCloseProviderCount != null && prior.quarterCloseProviderCount != null)
        ? current.quarterCloseProviderCount - prior.quarterCloseProviderCount
        : null;
      const spreadDelta = (current.quarterCloseSpreadMultiple != null && prior.quarterCloseSpreadMultiple != null)
        ? +(current.quarterCloseSpreadMultiple - prior.quarterCloseSpreadMultiple).toFixed(3)
        : null;
      qoq[sku] = {
        status: 'ok',
        currentQuarter: current.quarter,
        priorQuarter: prior.quarter,
        currentClose,
        priorClose,
        qoqAbs,
        qoqPct,
        currentProviders: current.quarterCloseProviderCount,
        priorProviders: prior.quarterCloseProviderCount,
        providerDelta,
        currentSpread: current.quarterCloseSpreadMultiple,
        priorSpread: prior.quarterCloseSpreadMultiple,
        spreadDelta,
        currentIsQTD: current.isQTD,
        currentCoverageRatio: current.coverageRatioWithinQuarter,
        priorCoverageRatio: prior.coverageRatioWithinQuarter,
        lowCoverageFlag: current.lowCoverage || prior.lowCoverage,
        currentBasis: current.priceBasis,
        priorBasis: prior.priceBasis,
        basisComparable,
        basisChanged: !!(current.priceBasis && prior.priceBasis && current.priceBasis !== prior.priceBasis),
      };
      signals[sku] = classifyQoQSignal(qoqPct, providerDelta);
    } else {
      qoq[sku] = {
        status: 'insufficient',
        quartersAvailable: agg.length,
        latestQuarter: agg[agg.length - 1]?.quarter || null,
        currentIsQTD: agg[agg.length - 1]?.isQTD || false,
      };
      signals[sku] = 'insufficient-data';
    }
  }

  const quartersAvailable = Array.from(quarterIdSet).sort();

  return jsonResp({
    success: true,
    view: 'quarter',
    include,
    trackingSinceRealDate: trackingSinceReal,
    latestRealSnapshotDate: latestRealDate,
    trackingSinceAny: trackingSince,
    latestDateAny: latestDate,
    daysWithGPU,
    windowDays,
    today,
    trackedSKUs: TRACKED_SKUS,
    availableSKUs,
    quartersAvailable,
    series: quarterSeries,
    qoq,
    signals,
  });
}

function emptyResponse(reason, isQuarter) {
  if (isQuarter) {
    return jsonResp({
      success: true,
      view: 'quarter',
      trackingSinceRealDate: null,
      latestRealSnapshotDate: null,
      trackingSinceAny: null,
      latestDateAny: null,
      daysWithGPU: 0,
      windowDays: 0,
      trackedSKUs: TRACKED_SKUS,
      availableSKUs: [],
      quartersAvailable: [],
      series: {},
      qoq: {},
      signals: {},
      note: reason,
    });
  }
  return jsonResp({
    success: true,
    view: 'daily',
    trackingSinceDate: null,
    trackingSinceRealDate: null,
    latestDate: null,
    latestRealSnapshotDate: null,
    daysWithGPU: 0,
    windowDays: 0,
    trackedSKUs: TRACKED_SKUS,
    availableSKUs: [],
    enough: { d7: false, d30: false },
    latest: {},
    series: {},
    comparisons: { d7: {}, d30: {} },
    signals: {},
    note: reason,
  });
}

/* ─── Financial correlation view ──────────────────────────
   Analyst-worksheet matrix. Unlike the quarter view (which uses quarter-
   CLOSE values), this view uses PERIOD AVERAGES — the arithmetic mean of
   every real daily minPricePerHour within the calendar period. Averages
   are computed from daily snapshots directly (not month-of-months) so
   uneven daily coverage doesn't skew quarterly numbers.

   QoQ growth = (current quarter avg - prior quarter avg) / prior quarter avg
   YoY growth = (current quarter avg - same quarter previous year avg) / same quarter previous year avg
   MoM growth = month analog of QoQ

   Quarter labels are quarter-end month format (Q1→Mar, Q2→Jun, Q3→Sep,
   Q4→Dec) — matches equity analyst period conventions. */

const FINANCIAL_PRIMARY_SKUS = ['Nvidia B200', 'Nvidia H200', 'Nvidia H100'];
const FINANCIAL_SECONDARY_SKUS = ['Nvidia GB200', 'Nvidia A100', 'Nvidia L40S'];

function monthIdForDate(dateStr) {
  return dateStr.slice(0, 7); // "2026-04-21" → "2026-04"
}

function monthBounds(year, monthIdx /* 1-12 */) {
  const start = new Date(Date.UTC(year, monthIdx - 1, 1));
  const nextStart = new Date(Date.UTC(year, monthIdx, 1));
  const end = new Date(nextStart.getTime() - 86400000);
  const days = Math.round((nextStart.getTime() - start.getTime()) / 86400000);
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
    days,
  };
}

function quarterEndLabel(year, q) {
  const endMonth = q * 3; // Q1→3, Q2→6, Q3→9, Q4→12
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[endMonth] + '-' + String(year % 100).padStart(2, '0');
}

function monthLabel(year, monthIdx) {
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[monthIdx] + '-' + String(year % 100).padStart(2, '0');
}

function avgOrNull(arr) {
  const valid = arr.filter(n => typeof n === 'number' && isFinite(n));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// headline(), periodGrowth() and pctChange() now live in _gpu-price-basis.js.
// The rule they implement changed in one important way: a period that
// straddles a basis change takes the basis of the MAJORITY of its priced
// days and averages only those days, instead of preferring any median it can
// find. July 2026 holds 27 floor days and 4 median days — under the old rule
// its "monthly average" was a 4-day median wearing a month's label.

function buildFinancialResponse(ctx) {
  const { series, trackingSinceReal, latestRealDate, trackingSince, latestDate,
          daysWithGPU, availableSKUs, windowDays, include } = ctx;
  const today = new Date().toISOString().slice(0, 10);
  const todayMonthId = today.slice(0, 7);
  const { id: todayQuarterId } = quarterIdForDate(today);

  // Build per-SKU month + quarter aggregates.
  const monthlyBySku = {};
  const quarterlyBySku = {};
  const monthIdSet = new Set();
  const quarterIdSet = new Set();

  for (const sku of availableSKUs) {
    const pts = series[sku] || [];
    const monthBuckets = new Map();
    const quarterBuckets = new Map();

    for (const p of pts) {
      const mid = monthIdForDate(p.date);
      if (!monthBuckets.has(mid)) monthBuckets.set(mid, []);
      monthBuckets.get(mid).push(p);
      const { id: qid } = quarterIdForDate(p.date);
      if (!quarterBuckets.has(qid)) quarterBuckets.set(qid, []);
      quarterBuckets.get(qid).push(p);
    }

    const months = [];
    for (const [mid, arr] of Array.from(monthBuckets.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1)) {
      monthIdSet.add(mid);
      const [y, m] = mid.split('-').map(Number);
      const { start, end, days: denom } = monthBounds(y, m);
      const dates = new Set(arr.map(p => p.date));
      const daysCovered = dates.size;
      const isMTD = mid === todayMonthId;
      // For MTD use days elapsed (today inclusive); for completed months use full month length.
      const effectiveDays = isMTD ? daysInclusive(start, today) : denom;
      const coverage = effectiveDays > 0 ? +(daysCovered / effectiveDays).toFixed(3) : null;
      // Priced days are counted separately from snapshot days. A snapshot can
      // land with providerCount populated but minPricePerHour null (which is
      // exactly what the upstream feed started doing on 2026-07-28), so
      // "days covered" alone overstates how much of the period actually
      // carries a price. Every downstream average, growth and coverage badge
      // needs the priced count to be honest.
      const head = periodHeadline(arr);
      // Coverage is measured against the basis this period actually reports.
      // Counting a straddle month's 4 median days towards a floor headline
      // would overstate how much of the month the printed number rests on.
      const pricedDates = head.priceBasis
        ? pricedDatesForBasis(arr, head.priceBasis)
        : new Set();
      const daysWithPrice = pricedDates.size;
      const medianDates = pricedDatesForBasis(arr, BASIS_MEDIAN);
      months.push({
        period: mid,
        label: monthLabel(y, m),
        year: y,
        month: m,
        periodStart: start,
        periodEnd: end,
        daysCoveredInMonth: daysCovered,
        daysWithPriceInMonth: daysWithPrice,
        monthDayCount: effectiveDays,
        coverageRatioWithinMonth: coverage,
        // Share of the period that the PRINTED number actually rests on. The
        // old Math.max(floorDays, medianDays) was there to stop a
        // median-only month reading as 0% priced; the basis-aware count
        // makes that unnecessary, and taking the max would now inflate a
        // straddle month by counting days its average excludes.
        pricedCoverageRatioWithinMonth: effectiveDays > 0
          ? +(daysWithPrice / effectiveDays).toFixed(3) : null,
        isPartialMonth: isMTD || daysCovered < denom,
        isMTD,
        hasPrice: head.headlinePricePerHour != null,
        daysWithMedianInMonth: medianDates.size,
        hasMedian: medianDates.size > 0,
        // The headline figure the matrix renders, plus which measure it is,
        // how many days of each measure the period holds, and — for a period
        // that straddles the change — what the OTHER measure averaged over
        // its own days. That last field is what answers "why did September
        // jump?": July's own median days sat at ~$3.06, so measured the same
        // way as September nothing jumped.
        ...head,
        avgMinPricePerHour: roundMaybe(avgOrNull(arr.map(p => p.minPricePerHour)), 4),
        avgMaxPricePerHour: roundMaybe(avgOrNull(arr.map(p => p.maxPricePerHour)), 4),
        avgMedianPricePerHour: roundMaybe(avgOrNull(arr.map(p => p.medianPricePerHour)), 4),
        avgPriceMidpoint:   roundMaybe(avgOrNull(arr.map(p => p.priceMidpoint)), 4),
        avgProviderCount:   roundMaybe(avgOrNull(arr.map(p => p.providerCount)), 2),
        avgSpreadMultiple:  roundMaybe(avgOrNull(arr.map(p => p.spreadMultiple)), 3),
      });
    }
    monthlyBySku[sku] = months;

    const quarters = [];
    for (const [qid, arr] of Array.from(quarterBuckets.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1)) {
      quarterIdSet.add(qid);
      const m = /^(\d{4})-Q([1-4])$/.exec(qid);
      const y = parseInt(m[1], 10);
      const qi = parseInt(m[2], 10);
      const { start, end, days: denom } = quarterBounds(y, qi);
      const dates = new Set(arr.map(p => p.date));
      const daysCovered = dates.size;
      const isQTD = qid === todayQuarterId;
      const effectiveDays = isQTD ? daysInclusive(start, today) : denom;
      const coverage = effectiveDays > 0 ? +(daysCovered / effectiveDays).toFixed(3) : null;
      const headQ = periodHeadline(arr);
      const pricedDatesQ = headQ.priceBasis
        ? pricedDatesForBasis(arr, headQ.priceBasis)
        : new Set();
      const daysWithPriceQ = pricedDatesQ.size;
      const medianDatesQ = pricedDatesForBasis(arr, BASIS_MEDIAN);
      quarters.push({
        period: qid,
        label: quarterEndLabel(y, qi),
        year: y,
        q: qi,
        periodStart: start,
        periodEnd: end,
        daysCoveredInQuarter: daysCovered,
        daysWithPriceInQuarter: daysWithPriceQ,
        quarterDayCount: effectiveDays,
        coverageRatioWithinQuarter: coverage,
        pricedCoverageRatioWithinQuarter: effectiveDays > 0
          ? +(daysWithPriceQ / effectiveDays).toFixed(3) : null,
        isPartialQuarter: isQTD || daysCovered < denom,
        isQTD,
        hasPrice: headQ.headlinePricePerHour != null,
        daysWithMedianInQuarter: medianDatesQ.size,
        hasMedian: medianDatesQ.size > 0,
        ...headQ,
        avgMinPricePerHour: roundMaybe(avgOrNull(arr.map(p => p.minPricePerHour)), 4),
        avgMaxPricePerHour: roundMaybe(avgOrNull(arr.map(p => p.maxPricePerHour)), 4),
        avgMedianPricePerHour: roundMaybe(avgOrNull(arr.map(p => p.medianPricePerHour)), 4),
        avgPriceMidpoint:   roundMaybe(avgOrNull(arr.map(p => p.priceMidpoint)), 4),
        avgProviderCount:   roundMaybe(avgOrNull(arr.map(p => p.providerCount)), 2),
        avgSpreadMultiple:  roundMaybe(avgOrNull(arr.map(p => p.spreadMultiple)), 3),
      });
    }
    quarterlyBySku[sku] = quarters;
  }

  // ── Period labels are CONTINUOUS, not observation-derived ────────────
  // Previously the label list was built from the set of periods that had
  // observations, so a calendar period with zero captures simply vanished
  // from the matrix. That is the worst possible failure mode for a tracking
  // dashboard: a stalled feed renders as a shorter, apparently-healthy table
  // rather than as a visible hole. We now emit every calendar period from the
  // first observed one through the current one, tagging each with whether it
  // has observations at all and whether any of them carry a price, so the UI
  // can draw the gap explicitly.
  const observedMonthIds = Array.from(monthIdSet).sort();
  const observedQuarterIds = Array.from(quarterIdSet).sort();

  const monthHasData = new Set(observedMonthIds);
  const monthHasPrice = new Set();
  for (const sku of availableSKUs) {
    for (const m of (monthlyBySku[sku] || [])) if (m.hasPrice) monthHasPrice.add(m.period);
  }
  const quarterHasData = new Set(observedQuarterIds);
  const quarterHasPrice = new Set();
  for (const sku of availableSKUs) {
    for (const q of (quarterlyBySku[sku] || [])) if (q.hasPrice) quarterHasPrice.add(q.period);
  }

  const lastObservedMonthId = observedMonthIds[observedMonthIds.length - 1];
  const lastObservedQuarterId = observedQuarterIds[observedQuarterIds.length - 1];
  // The axis runs to today, or past it if an observation somehow sits in the
  // future (upstream clock skew) — never stop short of real data.
  const monthAxisEnd = lastObservedMonthId && lastObservedMonthId > todayMonthId ? lastObservedMonthId : todayMonthId;
  const quarterAxisEnd = lastObservedQuarterId && lastObservedQuarterId > todayQuarterId ? lastObservedQuarterId : todayQuarterId;

  const monthlyLabels = enumerateMonthIds(observedMonthIds[0] || todayMonthId, monthAxisEnd)
    .map(mid => {
      const [y, m] = mid.split('-').map(Number);
      return {
        period: mid,
        label: monthLabel(y, m),
        hasData: monthHasData.has(mid),
        hasPrice: monthHasPrice.has(mid),
        isMTD: mid === todayMonthId,
      };
    });
  const quarterlyLabels = enumerateQuarterIds(observedQuarterIds[0] || todayQuarterId, quarterAxisEnd)
    .map(qid => {
      const m = /^(\d{4})-Q([1-4])$/.exec(qid);
      return {
        period: qid,
        label: quarterEndLabel(+m[1], +m[2]),
        hasData: quarterHasData.has(qid),
        hasPrice: quarterHasPrice.has(qid),
        isQTD: qid === todayQuarterId,
      };
    });

  // Growth matrices: MoM / QoQ / YoY (per SKU, keyed by period id, value = pct or null).
  // Every null is accompanied by a reason, because "the cell is empty" and
  // "these two numbers measure different things" look identical on screen
  // and mean completely different things to a reader. The reason strings are
  // what the matrix puts in the tooltip of a blank growth cell.
  const mom = {};
  const qoq = {};
  const yoyMonth = {};
  const yoyQuarter = {};
  const momReason = {};
  const qoqReason = {};

  for (const sku of availableSKUs) {
    mom[sku] = {};
    qoq[sku] = {};
    yoyMonth[sku] = {};
    yoyQuarter[sku] = {};
    momReason[sku] = {};
    qoqReason[sku] = {};

    // MoM
    const months = monthlyBySku[sku];
    const monthByPeriod = Object.fromEntries(months.map(x => [x.period, x]));
    for (const cur of months) {
      const priorId = priorMonthId(cur.period);
      const prior = monthByPeriod[priorId];
      mom[sku][cur.period] = periodGrowth(cur, prior);
      if (mom[sku][cur.period] == null) {
        momReason[sku][cur.period] = growthRefusalReason(cur, prior, prior ? prior.label : priorId);
      }
      const yoyId = yearPriorMonthId(cur.period);
      const yoyPrior = monthByPeriod[yoyId];
      yoyMonth[sku][cur.period] = periodGrowth(cur, yoyPrior);
    }

    // QoQ + YoY (quarter)
    const quarters = quarterlyBySku[sku];
    const quarterByPeriod = Object.fromEntries(quarters.map(x => [x.period, x]));
    for (const cur of quarters) {
      const priorId = priorQuarterId(cur.period);
      const prior = quarterByPeriod[priorId];
      qoq[sku][cur.period] = periodGrowth(cur, prior);
      if (qoq[sku][cur.period] == null) {
        qoqReason[sku][cur.period] = growthRefusalReason(cur, prior, prior ? prior.label : priorId);
      }
      const yoyId = yearPriorQuarterId(cur.period);
      const yoyPrior = quarterByPeriod[yoyId];
      yoyQuarter[sku][cur.period] = periodGrowth(cur, yoyPrior);
    }
  }

  // ── Feed integrity ───────────────────────────────────────────────────
  // Two independent failure modes have to be reported separately, because
  // they look identical in the rendered matrix (an em-dash) but mean very
  // different things:
  //   1. the GPU block stopped arriving altogether  → no rows at all
  //   2. the GPU block still arrives but minPricePerHour comes back null
  //      → provider counts keep updating while every price cell goes blank
  // Reporting only "latest snapshot date" hides both, because the wider
  // history capture can be perfectly healthy while the GPU feed is dead.
  let latestGPUObservationDate = null;
  let latestPricedObservationDate = null;
  const observationDates = new Set();
  const pricedDatesAll = new Set();
  for (const sku of availableSKUs) {
    for (const p of (series[sku] || [])) {
      observationDates.add(p.date);
      if (!latestGPUObservationDate || p.date > latestGPUObservationDate) latestGPUObservationDate = p.date;
      // dailyPrice is the post-normalization headline, so a day whose price
      // was captured into the wrong field counts as priced here rather than
      // being reported as a hole in the feed.
      const anyPrice = typeof p.dailyPrice === 'number' && isFinite(p.dailyPrice);
      if (anyPrice) {
        pricedDatesAll.add(p.date);
        if (!latestPricedObservationDate || p.date > latestPricedObservationDate) latestPricedObservationDate = p.date;
      }
    }
  }
  const daysSince = d => (d ? Math.max(0, daysInclusive(d, today) - 1) : null);
  const daysSinceLatestGPUObservation = daysSince(latestGPUObservationDate);
  const daysSinceLatestPricedObservation = daysSince(latestPricedObservationDate);

  const monthsMissing  = monthlyLabels.filter(l => !l.hasData).map(l => l.period);
  const monthsUnpriced = monthlyLabels.filter(l => l.hasData && !l.hasPrice).map(l => l.period);

  // ── Capture gaps ─────────────────────────────────────────────────────
  // A run of calendar days with no observation at all, inside the tracked
  // window. The month columns already thin out when this happens, but a
  // reader cannot tell a thin month from a short one without being told
  // where the hole is. The 2026-08-22 → 2026-09-10 outage is why September
  // shows six days and August twenty-one.
  const sortedObservationDates = Array.from(observationDates).sort();
  const captureGaps = [];
  for (let i = 1; i < sortedObservationDates.length; i++) {
    const prevD = Date.parse(sortedObservationDates[i - 1] + 'T00:00:00Z');
    const curD = Date.parse(sortedObservationDates[i] + 'T00:00:00Z');
    const missing = Math.round((curD - prevD) / 86400000) - 1;
    if (missing > 0) {
      captureGaps.push({
        afterDate: sortedObservationDates[i - 1],
        beforeDate: sortedObservationDates[i],
        missingDays: missing,
      });
    }
  }
  // Only gaps long enough to visibly distort a monthly average are worth
  // surfacing to a customer; a single missed cron slot is noise.
  const significantCaptureGaps = captureGaps.filter(g => g.missingDays >= 5);

  // ── Basis changes ────────────────────────────────────────────────────
  const basisTimeline = detectBasisTimeline(series);
  const monthBasis = basisChangeForPeriods(monthlyBySku, monthlyLabels.map(l => l.period));
  const quarterBasis = basisChangeForPeriods(quarterlyBySku, quarterlyLabels.map(l => l.period));

  const dataQuality = {
    // Staleness is measured against the GPU feed itself, never against the
    // wider history capture — those can and do diverge.
    latestGPUObservationDate,
    latestPricedObservationDate,
    daysSinceLatestGPUObservation,
    daysSinceLatestPricedObservation,
    // 3 days of slack absorbs a single missed cron slot plus the capture
    // window; beyond that the feed is genuinely not updating.
    gpuFeedStale:   daysSinceLatestGPUObservation   != null && daysSinceLatestGPUObservation   > 3,
    priceFieldStale: daysSinceLatestPricedObservation != null && daysSinceLatestPricedObservation > 3,
    // Set when the GPU rows keep arriving but carry no usable price — the
    // upstream shape changed rather than the capture stopping.
    priceFieldDroppedWhileFeedLive:
      latestGPUObservationDate != null &&
      latestPricedObservationDate != null &&
      latestGPUObservationDate > latestPricedObservationDate,
    observationDays: observationDates.size,
    pricedDays: pricedDatesAll.size,
    unpricedDays: observationDates.size - pricedDatesAll.size,
    monthsMissing,
    monthsUnpriced,
    quartersMissing:  quarterlyLabels.filter(l => !l.hasData).map(l => l.period),
    quartersUnpriced: quarterlyLabels.filter(l => l.hasData && !l.hasPrice).map(l => l.period),
    captureGaps,
    significantCaptureGaps,
    // How many days were rescued out of maxPricePerHour by the era-2 remap.
    // Kept visible rather than silent: if this number ever starts growing
    // again it means the capture has regressed to writing prices into the
    // wrong field, and the matrix would otherwise just look fine.
    remappedPriceDays: (() => {
      const d = new Set();
      for (const sku of availableSKUs) {
        for (const p of (series[sku] || [])) if (p.basisRemapped) d.add(p.date);
      }
      return d.size;
    })(),
  };

  // Everything the UI needs to explain the step in the price row without
  // hard-coding a date: which measure each period is on, where the boundary
  // falls, and which periods straddle it.
  const priceBasisInfo = {
    timeline: basisTimeline,
    currentBasis: basisTimeline.currentBasis,
    labels: BASIS_LABEL,
    monthly: monthBasis,
    quarterly: quarterBasis,
    // Set when more than one measure appears in the window on screen; the
    // matrix uses this to decide whether to render the basis row at all.
    hasChange: (basisTimeline.changes || []).length > 0,
  };

  return jsonResp({
    success: true,
    view: 'financial',
    include,
    dataQuality,
    trackingSinceRealDate: trackingSinceReal,
    latestRealSnapshotDate: latestRealDate,
    trackingSinceAny: trackingSince,
    latestDateAny: latestDate,
    daysWithGPU,
    windowDays,
    today,
    primarySKUs: FINANCIAL_PRIMARY_SKUS,
    secondarySKUs: FINANCIAL_SECONDARY_SKUS,
    trackedSKUs: TRACKED_SKUS,
    availableSKUs,
    monthly: {
      labels: monthlyLabels,
      series: monthlyBySku,
      mom,
      momReason,
      yoy: yoyMonth,
    },
    quarterly: {
      labels: quarterlyLabels,
      series: quarterlyBySku,
      qoq,
      qoqReason,
      yoy: yoyQuarter,
    },
    priceBasis: priceBasisInfo,
    methodology: {
      avgBasis: 'daily',
      note:
        'Period averages are arithmetic means of the daily headline price within the period. ' +
        'The source changed what it publishes mid-history: through 2026-07-27 it gave a vendor min-max range and the headline is the FLOOR (min $/hr); from 2026-07-28 it publishes a single vendor MEDIAN. ' +
        'A period takes the basis of the majority of its priced days and averages only those days. ' +
        'MoM/QoQ/YoY = (current period avg - prior period avg) / prior period avg x 100, computed only when both periods share a basis — a floor compared against a median is a change of measure, not a price move. ' +
        'Only real snapshots are included (synthetic backfill excluded by default).',
    },
  });
}

function roundMaybe(v, digits) {
  if (v == null || !isFinite(v)) return null;
  return +v.toFixed(digits);
}

// Inclusive calendar enumeration between two period ids. Used to emit a
// continuous column axis so a period with zero captures renders as a visible
// gap instead of silently disappearing from the matrix.
function enumerateMonthIds(startId, endId) {
  if (!startId || !endId || startId > endId) return startId ? [startId] : [];
  const out = [];
  let [y, m] = startId.split('-').map(Number);
  const [ey, em] = endId.split('-').map(Number);
  // Hard stop at 600 periods so a malformed id can never spin forever.
  for (let guard = 0; guard < 600; guard++) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    if (y === ey && m === em) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function enumerateQuarterIds(startId, endId) {
  if (!startId || !endId || startId > endId) return startId ? [startId] : [];
  const out = [];
  const sm = /^(\d{4})-Q([1-4])$/.exec(startId);
  const em = /^(\d{4})-Q([1-4])$/.exec(endId);
  if (!sm || !em) return [startId];
  let y = +sm[1], q = +sm[2];
  const ey = +em[1], eq = +em[2];
  for (let guard = 0; guard < 200; guard++) {
    out.push(y + '-Q' + q);
    if (y === ey && q === eq) break;
    q += 1;
    if (q > 4) { q = 1; y += 1; }
  }
  return out;
}

function priorMonthId(monthId) {
  const [y, m] = monthId.split('-').map(Number);
  if (m === 1) return (y - 1) + '-12';
  return y + '-' + String(m - 1).padStart(2, '0');
}

function yearPriorMonthId(monthId) {
  const [y, m] = monthId.split('-').map(Number);
  return (y - 1) + '-' + String(m).padStart(2, '0');
}

function priorQuarterId(qid) {
  const m = /^(\d{4})-Q([1-4])$/.exec(qid);
  if (!m) return null;
  const y = +m[1], q = +m[2];
  if (q === 1) return (y - 1) + '-Q4';
  return y + '-Q' + (q - 1);
}

function yearPriorQuarterId(qid) {
  const m = /^(\d{4})-Q([1-4])$/.exec(qid);
  if (!m) return null;
  return (+m[1] - 1) + '-Q' + m[2];
}

function emptyFinancialResponse(reason) {
  return jsonResp({
    success: true,
    view: 'financial',
    trackingSinceRealDate: null,
    latestRealSnapshotDate: null,
    trackingSinceAny: null,
    latestDateAny: null,
    daysWithGPU: 0,
    windowDays: 0,
    primarySKUs: FINANCIAL_PRIMARY_SKUS,
    secondarySKUs: FINANCIAL_SECONDARY_SKUS,
    trackedSKUs: TRACKED_SKUS,
    availableSKUs: [],
    monthly: { labels: [], series: {}, mom: {}, momReason: {}, yoy: {} },
    quarterly: { labels: [], series: {}, qoq: {}, qoqReason: {}, yoy: {} },
    priceBasis: {
      timeline: { segments: [], changes: [], currentBasis: null },
      currentBasis: null,
      labels: BASIS_LABEL,
      monthly: { basisByPeriod: {}, mixedPeriods: [], boundaries: [] },
      quarterly: { basisByPeriod: {}, mixedPeriods: [], boundaries: [] },
      hasChange: false,
    },
    dataQuality: {
      latestGPUObservationDate: null,
      latestPricedObservationDate: null,
      daysSinceLatestGPUObservation: null,
      daysSinceLatestPricedObservation: null,
      gpuFeedStale: false,
      priceFieldStale: false,
      priceFieldDroppedWhileFeedLive: false,
      observationDays: 0,
      pricedDays: 0,
      unpricedDays: 0,
      monthsMissing: [],
      monthsUnpriced: [],
      quartersMissing: [],
      quartersUnpriced: [],
      captureGaps: [],
      significantCaptureGaps: [],
      remappedPriceDays: 0,
    },
    note: reason,
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
