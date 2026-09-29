/**
 * What the share on the read-through is a share OF.
 *
 * Three separate failings, all of them the read path being looser or blinder
 * than the rest of the repo:
 *
 *   1. The capture refuses a ranking on a SINGLE row naming a known
 *      application (openrouter.js assertLooksLikeModels). The read path
 *      applied only the weaker half-attributed test, so a stored day from the
 *      2026-08-18..09-15 Apps window that happened to clear 50% attribution
 *      was counted as a real observation.
 *
 *   2. The daily captures changed population on 2026-09-16, when the capture
 *      began filtering to paid traffic. This file had no handling for it at
 *      all: 2026-Q3's ~48 all-traffic days were averaged together with its
 *      ~13 paid-only ones and compared against an all-traffic 2026-Q2. The
 *      share is now read from the weekly PROVIDER series, whose basis never
 *      changed; the daily measure remains as a fallback, and on it the
 *      paid-only days are not counted rather than blended.
 *
 *   3. Depth was one global minimum over 365 days, so one short day anywhere
 *      narrowed what every quarter measured. It is now taken over the two
 *      quarters being compared, and published per quarter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as readThrough } from '../pricing-share-signal.js';

const cell = (slug, avg, qoq) => ({ slug, avg, avgLabel: '$' + avg, qoq, modelCount: 5 });
const PROVIDERS = [
  { slug: 'anthropic', label: 'Anthropic' }, { slug: 'deepseek', label: 'DeepSeek' },
  { slug: 'openai', label: 'OpenAI' }, { slug: 'xai', label: 'xAI' },
];
const quarterCells = () =>
  [cell('anthropic', 7, -0.1), cell('deepseek', 0.3, 0.05), cell('openai', 5, 0), cell('xai', 2, 0.03)];
const MATRIX = {
  success: true,
  providers: PROVIDERS,
  measureBreaks: { events: [], summary: null },
  quarters: [
    { quarter: '2026-Q3', partial: true, cells: quarterCells() },
    { quarter: '2026-Q2', partial: false, cells: quarterCells() },
    { quarter: '2026-Q1', partial: false, cells: quarterCells() },
  ],
};

/** A complete model ranking as the capture stores it: ranks 1..N. */
const ranking = (...pairs) => pairs.map(([provider, tokRaw], i) =>
  ({ rank: i + 1, model: provider + ' model ' + (i + 1), provider, tokRaw, isGemini: false, wowN: 0 }));

/** A week of the provider series: {x, ys} as OpenRouter serves it. */
const week = (start, ys) => ({ x: start + ' 00:00:00', ys });

/**
 * @param snapshots  canonical KV daily history, or null for "history is down"
 * @param weeks      market-share points, or null for "the live read fails"
 */
async function run(snapshots, weeks) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'openrouter.ai') {
      return weeks
        ? new Response(JSON.stringify({ data: weeks }), { status: 200 })
        : new Response('nope', { status: 503 });
    }
    const body = u.pathname === '/api/provider-pricing-matrix' ? MATRIX
      : u.pathname === '/api/history' ? (snapshots ? { success: true, snapshots } : { success: false })
      : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  };
  try {
    return await (await readThrough({ request: new Request('https://x.test/api/pricing-share-signal') })).json();
  } finally {
    globalThis.fetch = realFetch;
  }
}
const quarterOf = (d, q) => d.quarters.find(x => x.quarter === q);
const rowsOf = (d, q) => Object.fromEntries(quarterOf(d, q).rows.map(r => [r.slug, r]));
const close = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, (msg ? msg + ': ' : '') + actual + ' != ' + expected);

/* ── (1) the capture's app-name refusal, applied on the read path too ──── */

test('a day naming a known application is not counted, even when most rows are attributed', async () => {
  // Four of five rows name a model maker, so isAttributedRanking passes it —
  // and one row is "Kilo Code", which the capture refuses a whole payload for.
  const appDay = ranking(['anthropic', 40], ['deepseek', 30], ['openai', 20], ['xai', 5], ['openai', 5]);
  appDay[4].model = 'Kilo Code';
  const d = await run([
    { date: '2026-08-02', source: 'cron', or: appDay },
    { date: '2026-08-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 30], ['openai', 10], ['xai', 10]) },
    { date: '2026-05-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 30], ['openai', 10], ['xai', 10]) },
  ], null);

  assert.equal(d.shareBasis.excludedDays.appNamed, 1, 'counted as its own exclusion, not folded into another');
  assert.equal(d.shareBasis.excludedDays.notModelRanking, 0,
    'the weaker test passed this day — only the app-name test catches it');
  assert.equal(quarterOf(d, '2026-Q3').shareDays, 1, 'only the clean day of the quarter is counted');
  const q3 = rowsOf(d, '2026-Q3');
  close(q3.anthropic.shareAvg, 50, 'the Apps day does not pull Anthropic toward 40');
  close(q3.anthropic.shareQoqPP, 0);
});

/* ── (2) the 2026-09-16 change of population ────────────────────────────── */

test('the weekly provider series is the measure, and it is published in words', async () => {
  // Q2 and Q3 weeks, on a basis that never changed. "others" is in the
  // denominator and is not a provider, so the named shares sum to 90.
  const weeks = [
    ...['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27'].map(s =>
      week(s, { anthropic: 40, deepseek: 20, openai: 20, 'x-ai': 10, others: 10 })),
    ...['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'].map(s =>
      week(s, { anthropic: 30, deepseek: 30, openai: 20, 'x-ai': 10, others: 10 })),
  ];
  // The daily captures say something quite different, and straddle the break:
  // if any of this reached the answer, the numbers below would not hold.
  const d = await run([
    { date: '2026-09-20', source: 'cron', or: ranking(['deepseek', 80], ['anthropic', 10], ['openai', 5], ['xai', 5]) },
    { date: '2026-08-01', source: 'cron', or: ranking(['anthropic', 60], ['deepseek', 20], ['openai', 10], ['xai', 10]) },
    { date: '2026-05-01', source: 'cron', or: ranking(['anthropic', 60], ['deepseek', 20], ['openai', 10], ['xai', 10]) },
  ], weeks);

  const q3 = rowsOf(d, '2026-Q3');
  close(q3.anthropic.shareAvg, 30, 'Q3 is the mean of its weeks, not of its captured days');
  close(q3.anthropic.shareQoqPP, -10, 'and compares against Q2 on that same measure');
  close(q3.deepseek.shareQoqPP, 10);
  close(q3.xai.shareAvg, 10, 'x-ai is joined to the matrix\'s xai');
  close(Object.values(q3).reduce((a, r) => a + r.shareAvg, 0), 90,
    'the "others" remainder is in the denominator and gets no row of its own');

  assert.equal(d.shareBasis.measure, 'provider-weekly');
  assert.equal(d.shareBasis.fallback, false);
  assert.match(d.shareBasis.measureLabel, /all traffic, including free/i,
    'the change of measure is named, not swapped in silently');
  assert.match(d.shareBasis.measureNote, /2026-09-16/,
    'and says what it is a change FROM');
  assert.match(d.sourceNote, /all traffic, including free/i);
  assert.equal(d.shareBasis.depth, null, 'a provider-level measure has no top-N depth to quote');
  assert.equal(d.shareBasis.latestWeek, '2026-07-27');
  assert.equal(quarterOf(d, '2026-Q3').shareWeeks, 4, 'each quarter says what it was averaged over');
  assert.equal(quarterOf(d, '2026-Q3').shareDays, 0, 'and does not claim counted days it did not use');
  assert.equal(quarterOf(d, '2026-Q3').shareMeasure, 'provider-weekly');
  assert.equal(quarterOf(d, '2026-Q2').shareMeasure, 'provider-weekly',
    'one comparison, one measure — and one measure across the whole answer');
});

test('with no weekly series, the daily fallback keeps to one population', async () => {
  const d = await run([
    // Paid-traffic-only days: sound observations of a different population.
    { date: '2026-09-20', source: 'cron', or: ranking(['deepseek', 80], ['anthropic', 10], ['openai', 5], ['xai', 5]) },
    { date: '2026-09-16', source: 'cron', or: ranking(['deepseek', 80], ['anthropic', 10], ['openai', 5], ['xai', 5]) },
    { date: '2026-09-15', source: 'cron', or: ranking(['anthropic', 60], ['deepseek', 20], ['openai', 10], ['xai', 10]) },
    { date: '2026-05-01', source: 'cron', or: ranking(['anthropic', 40], ['deepseek', 40], ['openai', 10], ['xai', 10]) },
  ], null);

  assert.equal(d.shareBasis.measure, 'top-models-daily');
  assert.equal(d.shareBasis.fallback, true);
  assert.ok(d.shareBasis.fallbackReason, 'the fallback says why it is the fallback');
  assert.equal(d.shareBasis.excludedDays.variantFiltered, 2,
    'both days from 2026-09-16 are left out, not blended into the quarter');
  assert.equal(quarterOf(d, '2026-Q3').shareDays, 1);

  const q3 = rowsOf(d, '2026-Q3');
  close(q3.anthropic.shareAvg, 60, 'Q3 is the all-traffic day alone, not (60 + 10 + 10) / 3');
  close(q3.anthropic.shareQoqPP, 20, 'and Q2 is all-traffic too, so the comparison is like for like');
  assert.match(d.shareBasis.measureNote, /2026-09-16/);
  assert.equal(quarterOf(d, '2026-Q3').shareMeasure, 'top-models-daily');
});

test('the weekly series alone is enough to answer, with the daily history down', async () => {
  const weeks = [
    ...['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27'].map(s =>
      week(s, { anthropic: 40, deepseek: 20, openai: 20, 'x-ai': 10, others: 10 })),
    ...['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'].map(s =>
      week(s, { anthropic: 30, deepseek: 30, openai: 20, 'x-ai': 10, others: 10 })),
  ];
  const d = await run(null, weeks);
  assert.equal(d.success, true, 'a computable figure is not withheld for want of the fallback source');
  assert.equal(d.latestComparable, '2026-Q3');
  close(rowsOf(d, '2026-Q3').anthropic.shareQoqPP, -10);
  assert.equal(d.shareBasis.countedDays, 0);
});

test('a provider the weekly series does not name in every week has no share for that quarter', async () => {
  const weeks = [
    ...['2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27'].map(s =>
      week(s, { anthropic: 40, deepseek: 20, openai: 20, xai: 10, others: 10 })),
    // xAI drops out of the named providers for one week of Q3: it fell into
    // "others", which is unknown, not zero.
    week('2026-07-06', { anthropic: 30, deepseek: 30, openai: 20, others: 20 }),
    ...['2026-07-13', '2026-07-20', '2026-07-27'].map(s =>
      week(s, { anthropic: 30, deepseek: 30, openai: 20, xai: 10, others: 10 })),
  ];
  const d = await run([], weeks);
  const q3 = rowsOf(d, '2026-Q3');
  assert.equal(q3.xai, undefined, 'no imputed share, and no share averaged over the weeks it was named in');
  assert.deepEqual(quarterOf(d, '2026-Q3').notInTopN, [{ slug: 'xai', label: 'xAI' }],
    'it is named rather than silently dropped');
  close(q3.anthropic.shareAvg, 30, 'the providers named every week are unaffected');
});

/* ── (3) depth is per comparison ────────────────────────────────────────── */

test('a short day in one quarter does not narrow what another quarter measures', async () => {
  const d = await run([
    { date: '2026-08-01', source: 'cron', or: ranking(['anthropic', 40], ['deepseek', 30], ['openai', 20], ['xai', 10]) },
    { date: '2026-05-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 30], ['openai', 10], ['xai', 10]) },
    // One two-row day, a quarter away from the comparison on screen.
    { date: '2026-02-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 50]) },
  ], null);

  assert.equal(d.latestComparable, '2026-Q3');
  assert.equal(d.shareBasis.depth, 4, 'Q3 vs Q2 is read to the shortest list of THOSE two quarters');
  assert.equal(quarterOf(d, '2026-Q3').shareDepth, 4);

  const q3 = rowsOf(d, '2026-Q3');
  close(q3.openai.shareAvg, 20, 'OpenAI is a fifth of the top 4, not absent from a top 2');
  close(q3.openai.shareQoqPP, 10);
  close(q3.xai.shareAvg, 10);

  // Q2 vs Q1 genuinely can only be read two deep, and says so rather than
  // taking one depth for the whole window.
  assert.equal(quarterOf(d, '2026-Q2').shareDepth, 2);
  close(rowsOf(d, '2026-Q2').anthropic.shareAvg, 50 / 80 * 100,
    'in its own comparison Q2 is read to the top 2');
});
