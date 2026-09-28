/**
 * QoQ / YoY are filled wherever there is something honest to compare, and say
 * why where there is not.
 *
 * The report that started this: in the usage-weighted view the Avg $/1M
 * matrix had every one of its 40 cells filled while QoQ and YoY were almost
 * entirely blank. 29 of those cells were estimates — the measured value was
 * withheld on coverage, and the Avg view showed its estimate — but growth was
 * taken only between two MEASURED levels, so every change touching an
 * estimate was dropped. Growth now follows the figure the Avg view shows.
 *
 * Alongside it: the open/proprietary view (group=openness), and changes
 * across the source's 2026-07-10 change of measure, linked at its exact
 * factor so both quarters stand on one measure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as providerMatrix, buildMatrix } from '../provider-pricing-matrix.js';
import { modelOpenness } from '../_model-openness.js';

const DAY = 86400000;
const days = (f, t) => {
  const o = [];
  for (let x = Date.parse(f + 'T00:00:00Z'); x <= Date.parse(t + 'T00:00:00Z'); x += DAY) o.push(new Date(x).toISOString().slice(0, 10));
  return o;
};
/** Upstream rows for one model: spans of [from, to, $/token input]. */
const hist = (model, spans) => spans.flatMap(([f, t, p]) =>
  days(f, t).map(d => ({ model, date: d + 'T00:00:00+00:00', pricing_prompt: p, pricing_completion: p * 4 })));

const S = '2026-04-01', E = '2026-09-20';
const Q2_END = '2026-06-30', Q3_START = '2026-07-01';

async function matrix(qs, upstream, seen = []) {
  const realFetch = globalThis.fetch, realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname.includes('pricepertoken')) {
      const slug = u.searchParams.get('provider');
      seen.push(slug);
      // Every provider carries one row, so none is retried as empty; dated a
      // year early so it never enters the quarters under test.
      const rows = upstream[slug] || hist(slug + '-filler', [['2025-04-01', '2025-04-01', 1e-6]]);
      return new Response(JSON.stringify({ results: rows }), { status: 200 });
    }
    return new Response('null', { status: 404 });
  };
  try {
    const res = await providerMatrix({ request: new Request('https://x.test/api/provider-pricing-matrix?' + qs), env: {}, waitUntil() {} });
    return { status: res.status, body: await res.json() };
  } finally { globalThis.fetch = realFetch; globalThis.caches = realCaches; }
}
const cellsOf = (d, quarter) => Object.fromEntries(d.quarters.find(q => q.quarter === quarter).cells.map(c => [c.slug, c]));

/* ── Open-weight or proprietary, per model ───────────────────────────── */

test('models are classed per model, not per provider', () => {
  const cases = [
    ['openai', 'gpt-5.5', 'proprietary'], ['openai', 'gpt-oss-120b', 'open'],
    ['google', 'gemini-2.5-pro', 'proprietary'], ['google', 'gemma-3-27b-it', 'open'],
    ['anthropic', 'claude-opus-4.8', 'proprietary'], ['xai', 'grok-4.6', 'proprietary'],
    ['deepseek', 'deepseek-v4-pro', 'open'], ['meta-llama', 'llama-4-maverick', 'open'],
    ['qwen', 'qwen3-235b-a22b', 'open'], ['qwen', 'qwen3-max', 'proprietary'],
    ['qwen', 'qwen3.6-plus', 'proprietary'], ['qwen', 'qwen3.7-flash', 'proprietary'],
    ['mistralai', 'mistral-small-3.2-24b-instruct', 'open'], ['mistralai', 'mistral-medium-3.1', 'proprietary'],
    ['mistralai', 'mistral-large-2411', 'open'], ['mistralai', 'mistral-large', 'proprietary'],
    ['mistralai', 'ministral-3b', 'proprietary'], ['mistralai', 'ministral-8b-2512', 'open'],
    ['cohere', 'command-r-plus-08-2024', 'open'], ['cohere', 'command-a', 'open'], ['cohere', 'command-a-plus', 'proprietary'],
    ['z-ai', 'glm-5.1', 'open'], ['z-ai', 'glm-5-turbo', 'proprietary'],
    ['moonshotai', 'kimi-k3', 'open'], ['minimax', 'minimax-m2.7', 'open'], ['minimax', 'minimax-m2-her', 'proprietary'],
    ['some-new-lab', 'anything', 'proprietary'],
  ];
  for (const [slug, model, want] of cases) assert.equal(modelOpenness(slug, model), want, slug + '/' + model);
});

test('group=openness pools every lab into two columns, like-for-like', async () => {
  const seen = [];
  const { body: d } = await matrix('metric=input&group=openness', {
    openai: [
      ...hist('gpt-5', [[S, E, 1.25e-6]]),
      // A real cut on an open model, at the quarter boundary.
      ...hist('gpt-oss-120b', [[S, Q2_END, 1e-7], [Q3_START, E, 8e-8]]),
      // Alternate billing never counts, on either side.
      ...hist('gpt-oss-120b:batch', [[Q3_START, E, 1e-9]]),
    ],
    google: [...hist('gemini-2.5-pro', [[S, E, 1.25e-6]]), ...hist('gemma-3-27b-it', [[S, E, 1e-7]])],
    qwen: [...hist('qwen3-max', [[S, E, 1.2e-6]]), ...hist('qwen3-32b', [[S, E, 1e-7]])],
    deepseek: hist('deepseek-v3.2', [[S, E, 3e-7]]),
  }, seen);
  assert.equal(d.success, true);
  assert.equal(d.group, 'openness');
  assert.deepEqual(d.providers.map(p => p.slug), ['proprietary', 'open']);
  for (const extra of ['qwen', 'moonshotai', 'z-ai', 'minimax']) assert.ok(seen.includes(extra), 'fetched ' + extra);

  const q2 = cellsOf(d, '2026-Q2'), q3 = cellsOf(d, '2026-Q3');
  // Proprietary: gpt-5, gemini-2.5-pro, qwen3-max, none repriced.
  assert.equal(q3.proprietary.modelCount, 3);
  assert.equal(q3.proprietary.avg, round3((1.25 + 1.25 + 1.2) / 3));
  assert.equal(q3.proprietary.qoq, 0);
  // Open: gpt-oss 0.10 -> 0.08, gemma, qwen3-32b and deepseek flat.
  assert.equal(q2.open.modelCount, 4);
  assert.equal(q3.open.qoq, round3((0.08 + 0.1 + 0.1 + 0.3) / 0.6 - 1));
  assert.equal(q3.open.qoqMatchedModels, 4);
  assert.match(q3.open.qoqNote, /^Like-for-like: the 4 models priced in both Q2 2026 and Q3 2026/);

  // The footnote's lab lists: Qwen and OpenAI appear on both sides.
  const side = Object.fromEntries(d.openness.map(g => [g.slug, Object.fromEntries(g.labs.map(l => [l.slug, l.models]))]));
  assert.equal(side.open.qwen, 1);
  assert.equal(side.proprietary.qwen, 1);
  assert.equal(side.open.openai, 1, 'the :batch listing is not a model');
  assert.match(d.sourceNote, /open-weight/);
});

test('group=openness is list prices only, and a bad group is refused', async () => {
  const usage = await matrix('metric=input&group=openness&weight=usage', {});
  assert.equal(usage.status, 400);
  assert.match(usage.body.error, /weight=equal only/);
  const bad = await matrix('metric=input&group=vendor', {});
  assert.equal(bad.status, 400);
});

/* ── Across a change of measure, linked at its exact factor ─────────── */

test('a change across the source\'s change of measure is linked, and a real cut still shows', async () => {
  const halve = (m, p) => hist(m, [[S, '2026-07-09', p], ['2026-07-10', E, p / 2]]);
  const { body: d } = await matrix('metric=input', {
    // Five models halve on 2026-07-10 — the change of measure — and six do
    // not; one of those six is genuinely cut at the quarter boundary.
    openai: [
      ...['t1', 't2', 't3', 't4', 't5'].map((m, i) => halve('gpt-' + m, (i + 1) * 4e-7)).flat(),
      ...['u1', 'u2', 'u3', 'u4', 'u5'].map(m => hist('gpt-' + m, [[S, E, 1e-6]])).flat(),
      ...hist('gpt-u6', [[S, Q2_END, 2.5e-6], [Q3_START, E, 2e-6]]),
    ],
    // Five halve and one does not: all six link, and nothing moved.
    google: [
      ...['a', 'b', 'c', 'd', 'e'].map((m, i) => halve('gemini-' + m, (i + 1) * 2e-7)).flat(),
      ...hist('gemma-x', [[S, E, 3e-8]]),
    ],
  });
  assert.deepEqual(d.measureBreaks.events.map(e => e.effectiveDate), ['2026-07-10']);
  const q3 = cellsOf(d, '2026-Q3');
  // Halved models enter at their Q2 prices ($0.4 + 0.8 + 1.2 + 1.6 + 2.0 = 6.0
  // per 1M); the untouched five at $1 and the real cut $2.50 -> $2.00.
  assert.equal(q3.openai.qoq, round3((6 + 5 + 2) / (6 + 5 + 2.5) - 1));
  assert.equal(q3.openai.qoqLinked, true);
  assert.equal(q3.openai.qoqMatchedModels, 11);
  assert.equal(q3.openai.qoqMeasureChanged, undefined);
  assert.match(q3.openai.qoqNote, /the 5 models it moved are compared at the price they would have been reported at before it/);

  assert.equal(q3.google.qoq, 0);
  assert.equal(q3.google.qoqLinked, true);
  assert.equal(q3.google.qoqMatchedModels, 6);

  // The level itself is still what the source reports: the halved figures.
  assert.ok(q3.google.avg < cellsOf(d, '2026-Q2').google.avg * 0.6);
});

test('a model first listed after the change cannot be linked, and too few linkable models say so', async () => {
  const { body: d } = await matrix('metric=input', {
    google: [
      // Five halve (the change), and three are listed after it: Q3's lineup is
      // 8, of which 5 are priced in both quarters — enough, and linked.
      ...['a', 'b', 'c', 'd', 'e'].map((m, i) => hist('gemini-' + m, [[S, '2026-07-09', (i + 1) * 2e-7], ['2026-07-10', E, (i + 1) * 1e-7]])).flat(),
      ...['n1', 'n2', 'n3'].map(m => hist('gemini-' + m, [['2026-07-15', E, 3e-7]])).flat(),
    ],
    openai: [
      // Five halve, and seven are listed after it: 5 of 12 priced in both.
      // Under half the lineup, and linkable — so the change is published for
      // those five and marked, not dropped.
      ...['a', 'b', 'c', 'd', 'e'].map((m, i) => hist('gpt-' + m, [[S, '2026-07-09', (i + 1) * 4e-7], ['2026-07-10', E, (i + 1) * 2e-7]])).flat(),
      ...['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'].map(m => hist('gpt-' + m, [['2026-07-15', E, 1e-6]])).flat(),
    ],
    anthropic: [
      // One model priced in both quarters: below the hard floor of two, so
      // refused whatever the measure. One model's change is not a provider's.
      ...hist('claude-a', [[S, '2026-07-09', 4e-7], ['2026-07-10', E, 2e-7]]),
      ...['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'].map(m => hist('claude-' + m, [['2026-07-15', E, 1e-6]])).flat(),
    ],
  });
  const q3 = cellsOf(d, '2026-Q3');
  assert.equal(q3.google.qoq, 0);
  assert.equal(q3.google.qoqMatchedModels, 5);
  assert.equal(q3.google.qoqLineupModels, 8);
  assert.equal(q3.google.qoqLowMatchedShare, undefined, '5 of 8 is most of the lineup');
  assert.match(q3.google.qoqNote, /3 models priced only in Q3 2026/);
  // Linked at the change's exact factor, so the five did not move — a correct
  // figure for them, published with the count that qualifies it.
  assert.equal(q3.openai.qoq, 0);
  assert.equal(q3.openai.qoqLinked, true);
  assert.equal(q3.openai.qoqMatchedModels, 5);
  assert.equal(q3.openai.qoqLineupModels, 12);
  assert.equal(q3.openai.qoqLowMatchedShare, true);
  assert.equal(q3.openai.qoqTooFewMatched, undefined);
  assert.equal(q3.openai.qoqReason, undefined);
  assert.match(q3.openai.qoqNote, /Only 5 of the 12 models priced in Q3 2026 were also priced in Q2 2026 — under half the lineup/);
  // The hard floor still refuses, and still says why.
  assert.equal(q3.anthropic.qoq, null);
  assert.equal(q3.anthropic.qoqTooFewMatched, true);
  assert.equal(q3.anthropic.qoqMatchedModels, 1);
  assert.equal(q3.anthropic.qoqLineupModels, 8);
  assert.match(q3.anthropic.qoqReason, /only 1 of the 8 models priced in Q3 2026 was also priced in Q2 2026/);
  assert.match(q3.anthropic.qoqReason, /one model's change is not the provider's/);
});

test('a change with nothing to compare against says so', async () => {
  const { body: d } = await matrix('metric=input', {
    anthropic: [...hist('claude-a', [[S, E, 3e-6]]), ...hist('claude-b', [[S, E, 1.5e-5]])],
  });
  // The other providers' filler rows sit in 2025-Q2, so the history reaches
  // back past these quarters: the gap is this provider's, and says so. (The
  // weighted test below covers a quarter before the history starts.)
  const q2 = cellsOf(d, '2026-Q2').anthropic, q3 = cellsOf(d, '2026-Q3').anthropic;
  assert.equal(q2.qoq, null);
  assert.equal(q2.qoqReason, 'Not computed: Q1 2026 has no price for this provider to compare against.');
  assert.equal(q3.yoyReason, 'Not computed: Q3 2025 has no price for this provider to compare against.');
  assert.equal(q3.qoq, 0);
  assert.equal(q3.qoqReason, undefined, 'a computed change carries no reason');
});

/* ── Usage-weighted: growth follows the figure the Avg view shows ────── */

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * One provider-quarter's model-day level, as providerQuarterLevels builds it.
 * On a changed measure every model here is one the change halved, so its
 * earlier-measure level is twice the reported one.
 */
function level(models, basis = 'origin') {
  const modelLevels = new Map(Object.entries(models));
  const prices = [...modelLevels.values()];
  const modelLinked = new Map([...modelLevels].map(([m, v]) => [m, basis === 'origin' ? v : v * 2]));
  return {
    mean: prices.reduce((a, b) => a + b, 0) / prices.length,
    n: prices.length * 90, basis, models: new Set(modelLevels.keys()),
    excludedN: 0, modelLevels, modelLinked,
  };
}
const weights = (entries) => new Map(Object.entries(entries).map(([m, [tokens, price]]) => [m, { tokens, cost: tokens * price }]));

test('usage-weighted QoQ/YoY are taken from the level shown, estimates included', () => {
  const levels = new Map([
    // List prices: $5 then $6 per 1M.
    ['anthropic', new Map([['2026-Q2', level({ a: 2e-6, b: 8e-6 })], ['2026-Q3', level({ a: 2.4e-6, b: 9.6e-6 })]])],
    ['cohere', new Map([['2026-Q2', level({ c: 1e-6, d: 1e-6 })], ['2026-Q3', level({ c: 1.1e-6, d: 1.1e-6 })]])],
    // Every model on the changed measure in Q3: the change stays refused.
    ['google', new Map([['2026-Q2', level({ g: 1e-6, h: 1e-6 })], ['2026-Q3', level({ g: 5e-7, h: 5e-7 }, '2026-07-10')]])],
  ]);
  const weighting = {
    seriesAvailable: true,
    weights: new Map([
      // Q2 measured: an even blend paying $3 per 1M, 0.6 of the $5 list.
      ['2026-Q2', new Map([['anthropic', weights({ a: [50, 2e-6], b: [50, 4e-6] })]])],
      // Q3 withheld: one model carries 95% of the weight.
      ['2026-Q3', new Map([['anthropic', weights({ a: [95, 2.4e-6], b: [5, 9.6e-6] })]])],
    ]),
    coverage: new Map([['2026-Q2', new Map([['anthropic', 0.9]])], ['2026-Q3', new Map([['anthropic', 0.9]])]]),
  };
  const columns = [{ slug: 'anthropic' }, { slug: 'cohere' }, { slug: 'google' }];
  const { quarters } = buildMatrix(levels, weighting, [], columns);
  const q3 = Object.fromEntries(quarters.find(q => q.quarter === '2026-Q3').cells.map(c => [c.slug, c]));
  const q2 = Object.fromEntries(quarters.find(q => q.quarter === '2026-Q2').cells.map(c => [c.slug, c]));

  // Measured Q2, estimated Q3 ($6 list x 0.6 = $3.60): +20%, and says which.
  assert.equal(q2.anthropic.avg, 3);
  assert.equal(q3.anthropic.avg, null);
  assert.equal(q3.anthropic.gate, 'single-model-dominated');
  assert.equal(q3.anthropic.estimateAvg, 3.6);
  assert.equal(q3.anthropic.qoq, 0.2);
  assert.equal(q3.anthropic.qoqLabel, '+20.0%');
  assert.equal(q3.anthropic.qoqEstimated, true);
  assert.match(q3.anthropic.qoqNote, /Q3 2026 is an estimate/);
  assert.match(q3.anthropic.qoqNote, /list prices of the 2 models priced in both quarters moved \+20\.0% like-for-like/);

  // No usage at all, both quarters estimated on the peer ratio: the change is
  // the list-price average's, and the note says so.
  assert.equal(q3.cohere.qoq, 0.1);
  assert.equal(q3.cohere.qoqEstimated, true);
  assert.match(q3.cohere.qoqNote, /Both are estimates/);
  assert.match(q3.cohere.qoqNote, /the same ratio in both/);

  // Across a change of measure the weighted levels cannot be compared, so the
  // change is the linked like-for-like list-price one, and says so.
  assert.equal(q3.google.qoq, 0);
  assert.equal(q3.google.qoqLinked, true);
  assert.equal(q3.google.qoqMeasureChanged, undefined);
  assert.match(q3.google.qoqNote, /stand on different measures, so this is the like-for-like list-price change instead/);

  // Q2 has nothing before it.
  assert.equal(q2.anthropic.qoq, null);
  assert.equal(q2.anthropic.qoqReason,
    'Not computed: there is no Q1 2026 to compare against — the source\'s price history starts in Q2 2026.');
});

/* ── No usage series at all: list prices, marked, instead of 40 dashes ── */

test('with no usage series every weighted cell shows its list price, marked and compared like-for-like', async () => {
  // Nothing but pricepertoken answers, so neither the model nor the provider
  // token series loads: not one cell can be weighted, and none can be
  // estimated either — there is no measured cell anywhere to take a ratio
  // from. The whole matrix used to come back as grey dashes although every
  // list price sat on the same cell. It now shows that list price as itself.
  const { body: d } = await matrix('metric=input&weight=usage', {
    anthropic: [
      ...hist('claude-a', [[S, E, 3e-6]]),
      ...hist('claude-b', [[S, Q2_END, 1.5e-5], [Q3_START, E, 1.2e-5]]),
      ...hist('claude-old', [[S, Q2_END, 7.5e-5]]),
      ...hist('claude-new', [[Q3_START, E, 1e-6]]),
    ],
  });
  assert.equal(d.weighting.modelSeriesAvailable, false);
  assert.equal(d.weighting.unweightedFallback, true);
  assert.match(d.weighting.unweightedFallbackReason, /no usage weights exist for any provider/);

  const q3 = cellsOf(d, '2026-Q3'), q2 = cellsOf(d, '2026-Q2');
  const a3 = q3.anthropic;
  // The measurement is still withheld, and still says why...
  assert.equal(a3.avg, null);
  assert.equal(a3.gate, 'series-unavailable');
  assert.match(a3.gateReason, /could not be loaded/);
  // ...but the cell is not empty: it is the list price, declared as such.
  assert.equal(a3.equalAvg, round3((3 + 12 + 1) / 3));
  assert.equal(a3.estimateAvg, a3.equalAvg);
  assert.equal(a3.estimateAvgLabel, a3.equalAvgLabel);
  assert.equal(a3.estimateBasis, 'list-price');
  assert.equal(a3.estimateRatio, 1, 'declared, not derived from any measured cell');
  assert.equal(a3.estimateDeclared, true);
  assert.equal(a3.estimateMarker, 'list price · no usage weights');
  // No cell anywhere is left blank while its list price exists.
  for (const row of d.quarters) {
    for (const c of row.cells) {
      if (!(c.equalAvg > 0)) continue;
      assert.equal(c.estimateBasis, 'list-price', row.quarter + '/' + c.slug);
      assert.ok(c.estimateAvgLabel, row.quarter + '/' + c.slug + ' has no figure to show');
    }
  }

  // Both quarters show a list-price average, so the change is the
  // like-for-like list-price one — claude-a flat and claude-b $15 -> $12 —
  // and NOT the ratio of the two lineup averages, which the retired $75 model
  // alone would drive to about -83%.
  assert.equal(a3.qoq, round3(15 / 18 - 1));
  assert.equal(a3.qoqLabel, '-16.7%');
  assert.equal(a3.qoqListPrice, true);
  assert.equal(a3.qoqMatchedModels, 2);
  assert.equal(a3.qoqLineupModels, 3);
  assert.equal(a3.qoqEstimated, undefined, 'nothing here was scaled by a ratio');
  assert.match(a3.qoqNote, /^No usage weights could be built, so both quarters show their list-price average/);
  assert.match(a3.qoqNote, /Like-for-like: the 2 models priced in both Q2 2026 and Q3 2026/);
  assert.ok(a3.qoq > -0.5, 'the lineup-average ratio was about -83%');
  assert.equal(q2.anthropic.estimateBasis, 'list-price');
});
