/**
 * The GPU history endpoint: what counts as a captured day, and where the
 * holes are.
 *
 * From 2026-08-22 to 2026-09-10 the capture ran every day and got nothing —
 * each of those snapshots carries `gpu: { models: [], coverage: 0 }`. The
 * endpoint counted them as GPU days, so the daily view said "52 real
 * snapshots" over a series of 36 dates. After 2026-09-16 the GPU block stopped
 * arriving at all (`gpu: null`) while the wider capture carried on.
 *
 * The handler is driven against an in-memory stand-in for the history store,
 * shaped like the live one. The stand-in has only `get`: google-dash is the
 * sole writer of that store, so any write from this read endpoint throws here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  onRequestGet,
  captureGapsFromSeries,
  SIGNIFICANT_GAP_DAYS,
} from '../gpu-hardware-pricing-history.js';

function isoDays(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// The live era-3 row shape: a median, no range.
const row = (sku, median, providers) => ({
  gpuModel: sku,
  minPricePerHour: null,
  maxPricePerHour: null,
  medianPricePerHour: median,
  providerCount: providers,
  spreadAbsolute: null,
  spreadMultiple: null,
  priceMidpoint: null,
});

//   08-01 → 08-21  GPU rows
//   08-22 → 09-10  capture ran, GPU block came back empty
//   09-11 → 09-16  GPU rows
//   09-17 → 09-21  no GPU block at all
function liveShapedStore() {
  const store = new Map();
  const days = isoDays('2026-08-01', '2026-09-21');
  for (const d of days) {
    let gpu;
    if (d <= '2026-08-21' || (d >= '2026-09-11' && d <= '2026-09-16')) {
      gpu = { models: [row('Nvidia H100', 3.39, d < '2026-09-11' ? 52 : 53)], coverage: 1 };
    } else if (d <= '2026-09-10') {
      gpu = { models: [], coverage: 0 };
    } else {
      gpu = null;
    }
    store.set('day:' + d, { source: 'cron', backfill: false, gpu });
  }
  store.set('index:days', days.slice().reverse()); // newest first, as stored
  return store;
}

function envFor(store) {
  return {
    HISTORY_KV: {
      async get(key, type) {
        assert.equal(type, 'json');
        return store.has(key) ? structuredClone(store.get(key)) : null;
      },
    },
  };
}

// These tests are about the captured snapshots, which the quarter and
// financial views now fall back to when getdeploying's weekly history cannot
// be read. The history is made unreachable here so they exercise that path.
async function call(qs, store) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    const res = await onRequestGet({
      request: new Request('https://example.test/api/gpu-hardware-pricing-history' + qs),
      env: envFor(store),
    });
    assert.equal(res.status, 200);
    return res.json();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ── What counts as a day ─────────────────────────────────────────────── */

test('a capture whose GPU block came back empty is not a GPU day', async () => {
  const j = await call('?window=60', liveShapedStore());
  const dates = j.series['Nvidia H100'].map(p => p.date);
  assert.equal(dates.length, 27, '21 August days and 6 September days carry rows');
  assert.equal(j.daysWithGPU, dates.length,
    'the day count must match the dates drawn — live it read 52 over 36');
});

test('empty and missing GPU blocks do not move the dates the view reports', async () => {
  const j = await call('?window=60', liveShapedStore());
  assert.equal(j.latestDate, '2026-09-16');
  assert.equal(j.trackingSinceDate, '2026-08-01');
});

test('the quarter and financial views count days the same way', async () => {
  const store = liveShapedStore();
  const q = await call('?view=quarter&window=400', store);
  const fin = await call('?view=financial&window=400', store);
  assert.equal(q.daysWithGPU, 27);
  assert.equal(fin.daysWithGPU, fin.dataQuality.observationDays);
  assert.equal(fin.dataQuality.latestGPUObservationDate, '2026-09-16');
});

/* ── Where the holes are ─────────────────────────────────────────────── */

test('the daily view reports the outage as one significant gap', async () => {
  const j = await call('?window=60', liveShapedStore());
  assert.deepEqual(j.significantCaptureGaps, [
    { afterDate: '2026-08-21', beforeDate: '2026-09-11', missingDays: 20 },
  ]);
});

test('the financial view reads the same gaps as the daily view', async () => {
  const store = liveShapedStore();
  const daily = await call('?window=60', store);
  const fin = await call('?view=financial&window=400', store);
  assert.deepEqual(fin.dataQuality.significantCaptureGaps, daily.significantCaptureGaps);
});

test('a one-day miss is a gap but not a significant one', () => {
  const g = captureGapsFromSeries({ A: [{ date: '2026-06-20' }, { date: '2026-06-22' }] }, ['A']);
  assert.deepEqual(g.captureGaps, [{ afterDate: '2026-06-20', beforeDate: '2026-06-22', missingDays: 1 }]);
  assert.deepEqual(g.significantCaptureGaps, []);
});

test('a day observed for any tracked SKU closes the gap for all of them', () => {
  const g = captureGapsFromSeries({
    A: [{ date: '2026-08-01' }, { date: '2026-08-10' }],
    B: [{ date: '2026-08-05' }],
  }, ['A', 'B']);
  assert.deepEqual(g.captureGaps.map(x => x.missingDays), [3, 4]);
  assert.deepEqual(g.significantCaptureGaps, []);
});

test('the significance threshold is five missing days', () => {
  assert.equal(SIGNIFICANT_GAP_DAYS, 5);
  // The real 2026-04-30 → 2026-05-05 hole: four days, not reported.
  const four = captureGapsFromSeries({ A: [{ date: '2026-04-30' }, { date: '2026-05-05' }] }, ['A']);
  assert.equal(four.significantCaptureGaps.length, 0);
  const five = captureGapsFromSeries({ A: [{ date: '2026-04-30' }, { date: '2026-05-06' }] }, ['A']);
  assert.equal(five.significantCaptureGaps.length, 1);
});

/* ── The 7-day comparator across the hole ────────────────────────────── */

test('a 7-day comparator that lands in the gap is flagged, not passed off as 7 days', async () => {
  const j = await call('?window=60', liveShapedStore());
  const c = j.comparisons.d7['Nvidia H100'];
  assert.equal(c.status, 'ok');
  assert.equal(c.priorDate, '2026-08-21');
  assert.equal(c.actualSpanDays, 26);
  assert.equal(c.windowStretched, true);
  // The provider move is real but spans 26 days. The page keys on the flag
  // above to keep it out from under a "7D" heading; the signal already does.
  assert.equal(c.providerDelta, 1);
  assert.equal(j.signals['Nvidia H100'], 'insufficient-data');
});

test('the daily price comparison uses the resolved median, not the empty floor field', async () => {
  const j = await call('?window=60', liveShapedStore());
  const c30 = j.comparisons.d30['Nvidia H100'];
  assert.equal(c30.windowStretched, false);
  assert.equal(c30.priceBasis, 'median');
  assert.equal(c30.priceDeltaPct, 0);
  assert.equal(c30.minDeltaPct, null, 'the floor field is empty in the median era');
  assert.equal(j.latest['Nvidia H100'].dailyPrice, 3.39);
  assert.equal(j.latest['Nvidia H100'].dailyBasis, 'median');
});
