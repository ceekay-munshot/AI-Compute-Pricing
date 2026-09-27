/**
 * The GPU investor views read getdeploying's weekly history: one measure
 * across the whole year, where the captured snapshots switch from the
 * cheapest vendor's price to the median on 2026-07-28 and stop on 2026-09-16.
 *
 * What these pin down: a week covers its seven days and never runs past the
 * source's last snapshot; only on-demand counts; nothing is ever a change of
 * measure; the snapshots are not read when the history covers every GPU; and a
 * GPU whose file cannot be read falls back to its snapshots on its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyToDailyPoints } from '../_gpu-weekly-history.js';
import { onRequestGet } from '../gpu-hardware-pricing-history.js';
import { GPU_TRACKED_SKUS } from '../_gpu-tracked-skus.js';

const DAY = 86400000;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

/** A dataset file: on-demand weeks from `first` with `priceOf(weekIndex)`, plus spot noise. */
function dataset(slug, { first = '2025-09-22', weeks = 53, priceOf = () => 3, lastSnapshot } = {}) {
  const data = [];
  for (let i = 0; i < weeks; i++) {
    const date = addDays(first, 7 * i);
    const p = priceOf(i, date);
    data.push({ gpu_slug: slug, date, billing_type: 'ON_DEMAND', reservation_months: null,
      min_price: p / 2, max_price: p * 4, median_price: p * 0.95, provider_median_price: p, provider_count: 40, offering_count: 140 });
    // Spot is a different product, and deliberately far off the on-demand price.
    data.push({ gpu_slug: slug, date, billing_type: 'SPOT', reservation_months: null,
      min_price: 0.1, max_price: 0.2, median_price: 0.15, provider_median_price: 0.15, provider_count: 5, offering_count: 9 });
  }
  const latest = addDays(first, 7 * (weeks - 1));
  return { meta: { first_week: first, latest_week: latest, last_snapshot: lastSnapshot || addDays(latest, 2) }, data };
}

test('a week covers its seven days, never past the last snapshot, on-demand only', () => {
  const pts = weeklyToDailyPoints(dataset('nvidia-h100', { first: '2026-09-07', weeks: 3, priceOf: i => [3.2, 3.15, 3.2][i], lastSnapshot: '2026-09-23' }), '2026-09-24');
  assert.equal(pts[0].date, '2026-09-07');
  assert.equal(pts[pts.length - 1].date, '2026-09-23', 'the current week stops at the last snapshot');
  assert.equal(pts.length, 7 + 7 + 3);
  assert.ok(pts.every(p => p.dailyBasis === 'median'), 'one measure throughout');
  assert.deepEqual([...new Set(pts.map(p => p.dailyPrice))], [3.2, 3.15]);
  assert.equal(pts[7].weekStart, '2026-09-14');
  assert.equal(pts[0].minPricePerHour, 1.6);
  assert.equal(pts[0].spreadMultiple, 8);
});

test('a week is never extended past today, even if the source says it saw later days', () => {
  const pts = weeklyToDailyPoints(dataset('nvidia-h100', { first: '2026-09-21', weeks: 1, lastSnapshot: '2026-09-27' }), '2026-09-24');
  assert.equal(pts[pts.length - 1].date, '2026-09-24');
});

/* ── The endpoint ────────────────────────────────────────────────────── */

async function call(qs, { files, kv = null }) {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const slug = u.pathname.split('/').pop().replace(/\.json$/, '');
    seen.push(slug);
    const f = files[slug];
    return f ? new Response(JSON.stringify(f), { status: 200 }) : new Response('nope', { status: 403 });
  };
  try {
    const env = kv ? { HISTORY_KV: kv } : {};
    const res = await onRequestGet({ request: new Request('https://x.test/api/gpu-hardware-pricing-history' + qs), env });
    return { status: res.status, body: await res.json(), seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Flat through July, then +10% from 2026-08-03: a real move, and the only one.
const allFiles = Object.fromEntries(GPU_TRACKED_SKUS.map(s => [s.slug,
  dataset(s.slug, { priceOf: (i, date) => (date >= '2026-08-03' ? 3.3 : 3) })]));

test('the financial view is one measure end to end, and July is compared like any month', async () => {
  const { status, body: d } = await call('?view=financial&window=400', { files: allFiles });
  assert.equal(status, 200, 'no snapshot store is needed when the history covers every GPU');
  assert.equal(d.source.kind, 'getdeploying-weekly');
  assert.deepEqual(d.source.fallbackSKUs, []);
  assert.equal(d.source.license, 'CC-BY-4.0');
  assert.equal(d.priceBasis.hasChange, false);
  assert.equal(d.trackingSinceRealDate, '2025-09-22');
  assert.equal(d.dataQuality.significantCaptureGaps.length, 0);
  const mom = d.monthly.mom['Nvidia H100'];
  assert.equal(mom['2026-07'], 0, 'July against June: nothing moved, and it is computed');
  assert.ok(mom['2026-08'] > 0, 'the August rise is reported');
  assert.equal(d.monthly.momReason['Nvidia H100']['2026-07'], undefined);
  const jun = d.monthly.series['Nvidia H100'].find(m => m.period === '2026-06');
  assert.equal(jun.priceBasis, 'median');
  assert.equal(jun.headlinePricePerHour, 3);
  assert.match(d.methodology.note, /weekly on-demand median/);
});

test('a GPU whose file cannot be read falls back to its captured snapshots, alone', async () => {
  const files = { ...allFiles };
  delete files['nvidia-gb200'];
  const store = new Map([
    ['index:days', ['2026-09-10', '2026-09-09']],
    ['day:2026-09-10', { source: 'cron', gpu: { models: [{ gpuModel: 'Nvidia GB200', medianPricePerHour: 17, providerCount: 3 }] } }],
    ['day:2026-09-09', { source: 'cron', gpu: { models: [{ gpuModel: 'Nvidia GB200', medianPricePerHour: 17, providerCount: 3 }] } }],
  ]);
  const kv = { async get(key) { return store.has(key) ? structuredClone(store.get(key)) : null; } };
  const { body: d } = await call('?view=financial&window=400', { files, kv });
  assert.deepEqual(d.source.fallbackSKUs, ['Nvidia GB200']);
  assert.ok(!d.source.skus.includes('Nvidia GB200'));
  const gb = d.monthly.series['Nvidia GB200'];
  assert.deepEqual(gb.map(m => m.period), ['2026-09'], 'GB200 is priced from its snapshots');
  assert.equal(d.monthly.series['Nvidia H100'][0].period, '2025-09', 'the others keep the weekly history');
  // The read-me wording only claims one source when every GPU came from it.
  assert.equal(d.methodology.avgBasis, 'daily');
});

test('the quarter view reads the same weekly history', async () => {
  const { body: d } = await call('?view=quarter&window=400', { files: allFiles });
  assert.equal(d.source.kind, 'getdeploying-weekly');
  assert.equal(d.qoq['Nvidia H100'].basisChanged, false);
  assert.equal(d.qoq['Nvidia H100'].currentBasis, 'median');
});

test('the daily view stays on the captured snapshots and never asks for the history', async () => {
  const store = new Map([['index:days', []]]);
  const kv = { async get(key) { return store.has(key) ? store.get(key) : null; } };
  const { seen } = await call('?window=60', { files: allFiles, kv });
  assert.deepEqual(seen, []);
});
