/**
 * The read-through must not lose a provider the matrix refused, and must not
 * rank callouts over a partial fan-out.
 *
 * Both failures were silent. The matrix refuses a price change for either of
 * two reasons — a change of measure, or too few models priced in both quarters
 * to compare like for like — and this endpoint recognised only the first. The
 * second produced priceQoq: null with no refusal flag, so the provider fell out
 * of the chart (which needs a number), out of the table (which is the numeric
 * rows plus the refused ones), and out of the "named instead of vanishing"
 * notes (which key on the refusal flag). The matrix's own written reason was
 * computed and thrown away.
 *
 * Separately, the matrix reports `degraded` when its eight-provider fan-out
 * came back with an error, and marks its own response no-store so a partial
 * answer is not replayed. This endpoint checked only `success`, so a failed
 * provider simply had no cells, was dropped, and "Biggest price cut" was then
 * decided among the survivors — and published for ten minutes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as readThrough } from '../pricing-share-signal.js';

const cell = (slug, avg, qoq, extra = {}) =>
  ({ slug, avg, avgLabel: '$' + avg, qoq, modelCount: 5, ...extra });

const TOO_FEW_REASON = 'Only 1 of 18 models was priced in both 2026-Q2 and 2026-Q3.';
const MEASURE_REASON = 'The source changed what it reports for this provider on 2026-07-10.';

/** anthropic: refused, too few matched. openai: refused, measure changed. */
function matrix({ degraded = false, providerErrors = null } = {}) {
  return {
    success: true,
    degraded,
    providerErrors,
    providers: [
      { slug: 'anthropic', label: 'Anthropic' }, { slug: 'deepseek', label: 'DeepSeek' },
      { slug: 'openai', label: 'OpenAI' },
    ],
    measureBreaks: { events: [], summary: null },
    quarters: [
      { quarter: '2026-Q3', partial: true, cells: [
        cell('anthropic', 7, null, { qoqTooFewMatched: true, qoqReason: TOO_FEW_REASON }),
        cell('deepseek', 0.3, -0.2),
        cell('openai', 5, null, { qoqMeasureChanged: true, qoqReason: MEASURE_REASON }),
      ] },
      { quarter: '2026-Q2', partial: false, cells: [
        cell('anthropic', 7.8, 0.1), cell('deepseek', 0.28, 0.1), cell('openai', 5, 0),
      ] },
    ],
  };
}

const ranking = (...pairs) => pairs.map(([provider, tokRaw], i) =>
  ({ rank: i + 1, model: provider + ' model ' + (i + 1), provider, tokRaw, isGemini: false, wowN: 0 }));

/** Every provider holds share in both quarters, so only the price side varies. */
const SNAPSHOTS = [
  { date: '2026-08-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 30], ['openai', 20]) },
  { date: '2026-05-01', source: 'cron', or: ranking(['anthropic', 40], ['deepseek', 40], ['openai', 20]) },
];

async function run(m) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const body = path === '/api/provider-pricing-matrix' ? m
      : path === '/api/history' ? { success: true, snapshots: SNAPSHOTS } : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  };
  try {
    const res = await readThrough({ request: new Request('https://x.test/api/pricing-share-signal') });
    return { res, d: await res.json() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const rowsOf = (d, q) => Object.fromEntries(
  d.quarters.find(x => x.quarter === q).rows.map(r => [r.slug, r]));

test('a provider refused for too few matched models is kept, flagged and explained', async () => {
  const { d } = await run(matrix());
  const q3 = rowsOf(d, '2026-Q3');

  // Before the fix this row was emitted with priceQoq: null and no refusal
  // flag, which put it in none of the client's buckets.
  assert.ok(q3.anthropic, 'the provider is still in the quarter');
  assert.equal(q3.anthropic.priceRefused, true);
  assert.equal(q3.anthropic.priceRefusedKind, 'too_few_matched');
  assert.equal(q3.anthropic.priceQoq, null, 'a refused change is never a number');
  assert.equal(q3.anthropic.priceQoqLabel, 'too few models');
  assert.equal(q3.anthropic.priceQoqReason, TOO_FEW_REASON,
    'the matrix\'s own wording is passed through, not discarded');
  assert.equal(q3.anthropic.priceMeasureChanged, false,
    'this refusal is NOT a change of measure, and the legacy flag must not say it is');
  assert.equal(q3.anthropic.priceReg, 'too_few_matched');
  assert.notEqual(q3.anthropic.regimeLabel, 'Insufficient data',
    'it gets its own regime rather than falling through to the empty default');
});

test('a measure-changed provider keeps its own kind and legacy flag', async () => {
  const { d } = await run(matrix());
  const q3 = rowsOf(d, '2026-Q3');
  assert.equal(q3.openai.priceRefused, true);
  assert.equal(q3.openai.priceRefusedKind, 'measure_changed');
  assert.equal(q3.openai.priceMeasureChanged, true);
  assert.equal(q3.openai.priceQoqLabel, 'measure changed');
  assert.equal(q3.openai.priceQoqReason, MEASURE_REASON);
});

test('no price callout is made from a refused change', async () => {
  const { d } = await run(matrix());
  const cut = (d.callouts || []).find(c => c.kind === 'biggest_price_cut');
  // deepseek is the only computed change (-20%), so it is the only candidate.
  assert.equal(cut && cut.slug, 'deepseek',
    'the one genuinely computed cut is the one called out');
});

test('a degraded matrix makes no callouts and is never cached', async () => {
  const errs = [{ slug: 'google', error: 'upstream 503', attempts: 3 }];
  const { res, d } = await run(matrix({ degraded: true, providerErrors: errs }));

  assert.equal(d.degraded, true, 'the degradation is published, not swallowed');
  assert.deepEqual(d.providerErrors, errs, 'and names which provider failed');
  assert.deepEqual(d.callouts, [],
    'ranking "biggest cut" over whoever survived a partial fan-out can crown the wrong provider');
  assert.equal(res.headers.get('Cache-Control'), 'no-store',
    'a partial answer must not be replayed for the cache lifetime');
});

test('a healthy matrix still caches and still makes callouts', async () => {
  const { res, d } = await run(matrix());
  assert.equal(d.degraded, false);
  assert.match(res.headers.get('Cache-Control'), /^public, max-age=\d+$/);
  assert.ok((d.callouts || []).length > 0, 'the healthy path is unchanged');
});
