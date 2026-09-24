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
 * Alongside it: the open/proprietary view (group=openness), and a model-day
 * change across the source's 2026-07-10 change of measure, measured on the
 * models that change did not touch when they are at least half the lineup.
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

/* ── Across a change of measure, on the models it did not touch ───────── */

test('a change across the source\'s change of measure is measured on the untouched models', async () => {
  const halve = (m, p) => hist(m, [[S, '2026-07-09', p], ['2026-07-10', E, p / 2]]);
  const { body: d } = await matrix('metric=input', {
    // Five models halve on 2026-07-10 — the change of measure — and six do
    // not; one of those six is genuinely cut at the quarter boundary.
    openai: [
      ...['t1', 't2', 't3', 't4', 't5'].map((m, i) => halve('gpt-' + m, (i + 1) * 4e-7)).flat(),
      ...['u1', 'u2', 'u3', 'u4', 'u5'].map(m => hist('gpt-' + m, [[S, E, 1e-6]])).flat(),
      ...hist('gpt-u6', [[S, Q2_END, 2.5e-6], [Q3_START, E, 2e-6]]),
    ],
    // Five touched and one untouched: the untouched are too few to stand for
    // the lineup, so the change stays refused.
    google: [
      ...['a', 'b', 'c', 'd', 'e'].map((m, i) => halve('gemini-' + m, (i + 1) * 2e-7)).flat(),
      ...hist('gemma-x', [[S, E, 3e-8]]),
    ],
  });
  assert.deepEqual(d.measureBreaks.events.map(e => e.effectiveDate), ['2026-07-10']);
  const q3 = cellsOf(d, '2026-Q3');
  assert.equal(q3.openai.qoqMeasureChanged, undefined);
  assert.equal(q3.openai.qoqMatchedModels, 6);
  assert.equal(q3.openai.qoq, round3(7 / 7.5 - 1));
  assert.match(q3.openai.qoqNote, /the 5 models that change touched are left out/);

  assert.equal(q3.google.qoq, null);
  assert.equal(q3.google.qoqMeasureChanged, true);
  assert.match(q3.google.qoqReason, /^Not comparable/);
  assert.match(q3.google.qoqReason, /only 1 of them was priced in both quarters, against 6 models/);
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

/** One provider-quarter's model-day level, as providerQuarterLevels builds it. */
function level(models, basis = 'origin') {
  const modelLevels = new Map(Object.entries(models));
  const prices = [...modelLevels.values()];
  return {
    mean: prices.reduce((a, b) => a + b, 0) / prices.length,
    n: prices.length * 90, basis, models: new Set(modelLevels.keys()),
    excludedN: 0, modelLevels, touched: new Set(basis === 'origin' ? [] : modelLevels.keys()),
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

  // A change of measure is refused in the weighted view even between estimates.
  assert.equal(q3.google.qoq, null);
  assert.equal(q3.google.qoqMeasureChanged, true);

  // Q2 has nothing before it.
  assert.equal(q2.anthropic.qoq, null);
  assert.equal(q2.anthropic.qoqReason,
    'Not computed: there is no Q1 2026 to compare against — the source\'s price history starts in Q2 2026.');
});
