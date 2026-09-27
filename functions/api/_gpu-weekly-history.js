/**
 * GetDeploying's own weekly GPU price history — one measure, end to end.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The investor views (financial correlation, quarter-close) were built from
 * the daily snapshots google-dash captures of getdeploying's listing page. That
 * page changed what it publishes on 2026-07-28 — the cheapest vendor's price
 * (a floor) before, the median across vendors after — and no captured day
 * carries both, so every period on one side could only be compared with
 * periods on its own side. MoM/QoQ/YoY across July read "measure changed", and
 * the capture itself stopped on 2026-09-16 with a 20-day hole before that.
 *
 * getdeploying publishes the series those views need directly: a weekly
 * min / median / max per GPU and billing type, the last twelve months,
 * CC-BY-4.0, at /dataset/gpu-prices/<slug>.json (the "Get the data" link under
 * the price-history chart on each GPU's page). Its median never changed
 * meaning: H100 on-demand reads $2.99, $2.89, $2.99, $3.11 through July 2026,
 * with no step at the 28th. Its `provider_median_price` — the median across
 * providers — is the figure the listing page itself has shown since
 * 2026-07-28 ($3.34 against the listing's $3.40 on 2026-09-23), so the views
 * keep the measure they already carry after the change and gain it before.
 *
 * HOW IT FEEDS THE EXISTING VIEWS
 * ───────────────────────────────
 * The views average DAILY points by calendar period. Each week's figure is
 * applied to the seven days it covers (weeks start on Monday), up to the
 * source's last snapshot, and every point goes through normalizeDailyPoint()
 * like a captured one — so period averages weigh a week split across a month
 * boundary by its days in each month, and every downstream rule (headline,
 * coverage, growth, basis) applies unchanged. All points are on the median
 * basis, so no period is ever refused as a change of measure.
 *
 * On-demand only. Spot, reserved and custom contracts are separate series in
 * the dataset and are not the list price the dashboard tracks.
 */

import { normalizeDailyPoint } from './_gpu-price-basis.js';
import { GPU_TRACKED_SKUS } from './_gpu-tracked-skus.js';

export const WEEKLY_DATASET_BASE = 'https://getdeploying.com/dataset/gpu-prices/';

// The dataset gains one snapshot a day and a new week once a week. Three hours
// keeps a published day visible within a working morning, and bounds how often
// each Cloudflare location asks getdeploying for six ~100 KB files.
const DATASET_TTL = 3 * 3600;
const FETCH_TIMEOUT_MS = 8000;
// getdeploying answers a burst with 403 for every page (see the board-power
// fan-out in gpu-hardware-pricing-data.js), so the six files go three at a time.
const CONCURRENCY = 3;

const DAY_MS = 86400000;

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

async function fetchDataset(slug) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(WEEKLY_DATASET_BASE + encodeURIComponent(slug) + '.json', {
      headers: { 'User-Agent': 'ai-compute-pricing/1.0 (+dataset reader)', Accept: 'application/json' },
      cf: { cacheTtl: DATASET_TTL, cacheEverything: true },
      signal: ctrl.signal,
    });
    if (!r.ok) return { slug, error: 'HTTP ' + r.status };
    const j = await r.json();
    if (!j || !Array.isArray(j.data)) return { slug, error: 'no data array' };
    return { slug, json: j };
  } catch (e) {
    return { slug, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One GPU's on-demand weeks as daily points, oldest first. `through` caps the
 * last day — the source's last snapshot, or today if that is earlier — so the
 * current week never reaches past what has been observed.
 */
export function weeklyToDailyPoints(json, today) {
  const lastSnapshot = typeof json?.meta?.last_snapshot === 'string' ? json.meta.last_snapshot : null;
  const through = lastSnapshot && lastSnapshot < today ? lastSnapshot : today;
  const weeks = (json?.data || [])
    .filter(r => r && r.billing_type === 'ON_DEMAND' && typeof r.date === 'string' && isNum(r.provider_median_price) && r.provider_median_price > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const points = [];
  for (const w of weeks) {
    const start = Date.parse(w.date.slice(0, 10) + 'T00:00:00Z');
    if (!isFinite(start)) continue;
    const min = isNum(w.min_price) && w.min_price > 0 ? w.min_price : null;
    const max = isNum(w.max_price) && w.max_price > 0 ? w.max_price : null;
    for (let d = 0; d < 7; d++) {
      const date = new Date(start + d * DAY_MS).toISOString().slice(0, 10);
      if (date > through) break;
      points.push(normalizeDailyPoint({
        date,
        minPricePerHour: min,
        maxPricePerHour: max,
        medianPricePerHour: w.provider_median_price,
        providerCount: isNum(w.provider_count) ? w.provider_count : null,
        spreadAbsolute: min != null && max != null ? round4(max - min) : null,
        spreadMultiple: min != null && max != null ? round4(max / min) : null,
        priceMidpoint: min != null && max != null ? round4((min + max) / 2) : null,
        _real: true,
        weekStart: w.date.slice(0, 10),
      }));
    }
  }
  return points;
}

/**
 * Every tracked GPU's weekly history as daily series keyed by its listing
 * name ("Nvidia H100"), plus what the response should say about the source.
 * A GPU whose file could not be read is simply absent from `series` and named
 * in `failed`; the caller falls back to captured snapshots for it.
 */
export async function loadWeeklySeries(today = new Date().toISOString().slice(0, 10)) {
  const results = [];
  for (let i = 0; i < GPU_TRACKED_SKUS.length; i += CONCURRENCY) {
    const batch = GPU_TRACKED_SKUS.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(batch.map(s => fetchDataset(s.slug).then(r => ({ ...r, name: s.name })))));
  }
  const series = {};
  const failed = [];
  let firstWeek = null;
  let latestWeek = null;
  let lastSnapshot = null;
  for (const r of results) {
    const points = r.json ? weeklyToDailyPoints(r.json, today) : [];
    if (!points.length) {
      failed.push({ sku: r.name, slug: r.slug, error: r.error || 'no on-demand weeks' });
      continue;
    }
    series[r.name] = points;
    const m = r.json.meta || {};
    if (m.first_week && (!firstWeek || m.first_week < firstWeek)) firstWeek = m.first_week;
    if (m.latest_week && (!latestWeek || m.latest_week > latestWeek)) latestWeek = m.latest_week;
    if (m.last_snapshot && (!lastSnapshot || m.last_snapshot > lastSnapshot)) lastSnapshot = m.last_snapshot;
  }
  return {
    series,
    failed,
    source: {
      kind: 'getdeploying-weekly',
      url: 'https://getdeploying.com/gpus',
      datasetUrl: WEEKLY_DATASET_BASE + '<gpu>.json',
      license: 'CC-BY-4.0',
      attribution: 'GetDeploying, https://getdeploying.com/gpus',
      measure: 'weekly on-demand median across providers (provider_median_price)',
      firstWeek,
      latestWeek,
      lastSnapshot,
      skus: Object.keys(series),
      fallbackSKUs: failed.map(f => f.sku),
    },
  };
}
