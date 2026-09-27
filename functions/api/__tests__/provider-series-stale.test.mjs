/**
 * A stale captured provider series must never stand in for the live one.
 *
 * The usage-weighted matrix divides each provider's spend by its share of
 * OpenRouter token volume. Those provider totals are read LIVE
 * (fetchMarketShare), with google-dash's captured copy merged underneath —
 * the captured copy earns its place only by reaching back further
 * (2025-05-26) than the live dataset (2025-09-22).
 *
 * That capture has been dead since 2026-06-09. Verified against the live
 * endpoint on 2026-09-23: providers.latestStoredWeek 2026-06-08,
 * weeksBehind 15, lastCaptureError null — nothing upstream records the
 * failure, so nothing upstream will report it.
 *
 * While the live read works this costs nothing: live weeks sit on top. When
 * the live read FAILED, the weighting quietly fell through to those months-old
 * totals and divided this quarter's spend by a stale share, publishing the
 * result as a measured figure with nothing on screen saying so.
 *
 * It is now refused, and the refusal says which of the two it is: the series
 * could not be LOADED, or it loaded and was too OLD to stand in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as providerMatrix } from '../provider-pricing-matrix.js';
import { weightedAverage, gateReason } from '../_usage-weights.js';

const DAY = 86400000;
const SLUGS = ['openai', 'anthropic', 'google', 'xai', 'mistralai', 'deepseek', 'meta-llama', 'cohere'];

const days = (f, t) => {
  const o = [];
  for (let x = Date.parse(f + 'T00:00:00Z'); x <= Date.parse(t + 'T00:00:00Z'); x += DAY) {
    o.push(new Date(x).toISOString().slice(0, 10));
  }
  return o;
};
const hist = (model, from, to, price) => days(from, to).map(d =>
  ({ model, date: d + 'T00:00:00+00:00', pricing_prompt: price, pricing_completion: price * 5 }));

/** ISO Monday of the week containing now — the same anchor the endpoint uses. */
function currentIsoWeekStart() {
  const d = new Date();
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 86400000)
    .toISOString().slice(0, 10);
}
const weekStartBack = (n) => new Date(
  Date.parse(currentIsoWeekStart() + 'T00:00:00Z') - n * 7 * 86400000).toISOString().slice(0, 10);

/** A provider-level weekly series (bare slugs, no "/" — provider shape). */
const providerWeeks = (starts) => ({
  success: true,
  weeks: starts.map(start => ({
    start,
    providers: { openai: 5e11, google: 4e11, anthropic: 3e11 },
  })),
});

/** A model-level weekly series (slug keys with "/"). */
const modelWeeks = (starts) => ({
  success: true,
  weeks: starts.map(start => ({
    start,
    totalRaw: 1e12,
    allModels: { 'openai/gpt-x': 5e11, 'google/gemini-x': 4e11, Others: 1e11 },
    topModels: [
      { slug: 'openai/gpt-x', tokens: 5e11 },
      { slug: 'google/gemini-x', tokens: 4e11 },
    ],
  })),
});

/**
 * @param capturedBack how many weeks behind the captured provider series is
 * @param liveWorks    whether the live market-share dataset answers
 */
function mockFetch({ capturedBack, liveWorks }) {
  // validateMarketShare refuses a series under 8 weekly points as too short
  // to certify coverage against, so the live fixture must clear that bar.
  const recent = Array.from({ length: 10 }, (_, i) => weekStartBack(10 - i));
  return async (url) => {
    const u = new URL(url, 'https://x.test');
    if (u.hostname.includes('pricepertoken')) {
      const slug = u.searchParams.get('provider');
      return new Response(JSON.stringify({
        results: hist(slug + '-a', '2026-04-01', '2026-09-20', 2e-6),
      }), { status: 200 });
    }
    if (u.hostname.includes('openrouter.ai')) {
      // The LIVE provider totals.
      if (!liveWorks) return new Response('upstream down', { status: 503 });
      return new Response(JSON.stringify({
        data: recent.map(x => ({ x, ys: { openai: 5e11, google: 4e11, anthropic: 3e11 } })),
      }), { status: 200 });
    }
    if (u.pathname === '/api/openrouter-chart-weekly') {
      if (u.searchParams.get('providers') === '1') {
        // The CAPTURED fallback, as stale as the case under test.
        return new Response(JSON.stringify(
          providerWeeks([weekStartBack(capturedBack + 1), weekStartBack(capturedBack)])), { status: 200 });
      }
      return new Response(JSON.stringify(modelWeeks(recent)), { status: 200 });
    }
    if (u.pathname === '/api/openrouter-model-usage') {
      return new Response(JSON.stringify({ success: true, weeksStored: 0, weeks: [] }), { status: 200 });
    }
    return new Response('null', { status: 404 });
  };
}

async function run(opts) {
  const real = globalThis.fetch, realCaches = globalThis.caches;
  globalThis.fetch = mockFetch(opts);
  // The endpoint runs through withEdgeCache; Node has no Cache API. A cache
  // that never hits keeps each case independent.
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  try {
    const res = await providerMatrix({
      request: new Request('https://x.test/api/provider-pricing-matrix?metric=input&weight=usage'),
      env: {}, waitUntil() {},
    });
    return await res.json();
  } finally {
    globalThis.fetch = real; globalThis.caches = realCaches;
  }
}

const anyCell = (d) => (d.quarters || []).flatMap(q => q.cells || []);

test('live read down + a months-old captured series refuses the weighted view', async () => {
  const d = await run({ capturedBack: 15, liveWorks: false });

  assert.equal(d.weighting.providerSeriesLive, false, 'the live read failed in this fixture');
  assert.equal(d.weighting.providerSeriesStale, true);
  assert.ok(d.weighting.providerSeriesCapturedWeeksBehind >= 15,
    'weeks-behind is reported, got ' + d.weighting.providerSeriesCapturedWeeksBehind);

  const cells = anyCell(d);
  assert.ok(cells.length > 0, 'the matrix still renders its grid');
  for (const c of cells) {
    assert.equal(c.avg, null, 'no weighted level is published off a stale denominator');
    assert.equal(c.gate, 'provider-series-stale');
  }
  // Critically: not offered as an estimate either. An estimate scales a list
  // price by a measured ratio — there is no trustworthy ratio here.
  assert.ok(cells.every(c => c.estimateAvgLabel == null || c.avg === null),
    'a stale denominator does not become an estimate');
});

test('live read down but a fresh captured series still computes', async () => {
  const d = await run({ capturedBack: 1, liveWorks: false });
  assert.equal(d.weighting.providerSeriesLive, false);
  assert.equal(d.weighting.providerSeriesStale, false,
    'a one-week-old fallback is a fallback working, not a fault');
  assert.ok(anyCell(d).every(c => c.gate !== 'provider-series-stale'));
});

test('a stale capture costs nothing while the live read works', async () => {
  const d = await run({ capturedBack: 15, liveWorks: true });
  assert.equal(d.weighting.providerSeriesLive, true);
  assert.equal(d.weighting.providerSeriesStale, false,
    'live weeks sit on top; the captured copy only supplies older history');
  assert.ok(anyCell(d).every(c => c.gate !== 'provider-series-stale'));
});

test('the two series refusals are told apart, and the reason is accurate', () => {
  const loadFailed = weightedAverage(new Map(), null, false);
  assert.equal(loadFailed.gate, 'series-unavailable', 'the default is unchanged');

  const stale = weightedAverage(new Map(), null, false, 'provider-series-stale');
  assert.equal(stale.gate, 'provider-series-stale');
  assert.equal(stale.avg, null);
  assert.equal(stale.provisional, null, 'nothing survives to be offered as an estimate');

  const why = gateReason('provider-series-stale');
  assert.match(why, /stale|months old/i);
  assert.doesNotMatch(why, /could not be loaded/i,
    'it loaded — saying otherwise would be the same class of wrong label this fixes');
});
