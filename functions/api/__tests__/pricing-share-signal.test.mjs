import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as readThrough } from '../pricing-share-signal.js';
import { isAttributedRanking } from '../openrouter.js';

/* ── Fixture ──────────────────────────────────────────────────────────────
   Every provider is priced in both quarters and none is refused, so the only
   thing that varies between tests is the share side. */
const cell = (slug, avg, qoq) => ({ slug, avg, avgLabel: '$' + avg, qoq, modelCount: 5 });
const MATRIX = {
  success: true,
  providers: [
    { slug: 'anthropic', label: 'Anthropic' }, { slug: 'deepseek', label: 'DeepSeek' },
    { slug: 'openai', label: 'OpenAI' }, { slug: 'xai', label: 'xAI' },
  ],
  measureBreaks: { events: [], summary: null },
  quarters: [
    { quarter: '2026-Q3', partial: true, cells: [cell('anthropic', 7, -0.1), cell('deepseek', 0.3, 0.05), cell('openai', 5, 0), cell('xai', 2, 0.03)] },
    { quarter: '2026-Q2', partial: false, cells: [cell('anthropic', 7.8, 0.1), cell('deepseek', 0.28, 0.1), cell('openai', 5, 0), cell('xai', 1.9, 0)] },
  ],
};

/** A complete model ranking as the capture stores it: ranks 1..N. */
const ranking = (...pairs) => pairs.map(([provider, tokRaw], i) =>
  ({ rank: i + 1, model: provider + ' model ' + (i + 1), provider, tokRaw, isGemini: false, wowN: 0 }));

async function run(snapshots) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const body = path === '/api/provider-pricing-matrix' ? MATRIX
      : path === '/api/history' ? { success: true, snapshots } : null;
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

/* ── (a) backfill copies ──────────────────────────────────────────────── */

test('a gap-fill copy of a later capture is not counted as a second observed day', async () => {
  const later = ranking(['anthropic', 90], ['deepseek', 10]);
  const d = await run([
    { date: '2026-08-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 50]) },
    { date: '2026-05-03', source: 'cron', or: later },
    // Filled in on 05-03 and stored under 05-02: 05-03's list, re-dated.
    { date: '2026-05-02', source: 'autofill-gap', backfill: true, or: later },
    { date: '2026-05-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 50]) },
  ]);
  const q3 = rowsOf(d, '2026-Q3');
  close(q3.anthropic.sharePrev, 70, 'Q2 is (50 + 90) / 2, not (50 + 90 + 90) / 3');
  close(q3.anthropic.shareQoqPP, -20);
  close(q3.deepseek.sharePrev, 30);
  assert.equal(quarterOf(d, '2026-Q2').shareDays, 2);
  assert.equal(d.shareBasis.excludedDays.backfill, 1);
});

/* ── (b) app rankings ─────────────────────────────────────────────────── */

test('the capture\'s model-ranking test reads the rows, not a list of names', () => {
  const apps = (deepseekHarness) => [
    { rank: 3, model: 'Kilo Code', provider: 'other' }, { rank: 4, model: 'Cline', provider: 'other' },
    { rank: 6, model: 'pi', provider: 'other' }, { rank: 7, model: 'omp', provider: 'other' },
    { rank: 8, model: deepseekHarness ? 'DeepSeek Harness' : 'Framer', provider: deepseekHarness ? 'deepseek' : 'other' },
    { rank: 9, model: 'Codex', provider: 'other' }, { rank: 10, model: 'Zazen (Freebuff fork)', provider: 'other' },
  ];
  assert.equal(isAttributedRanking(apps(false)), false, 'the 2026-08-18 list');
  assert.equal(isAttributedRanking(apps(true)), false, 'the 2026-08-22 list, one app filed under deepseek');
  const models = ranking(['anthropic', 9], ['deepseek', 8], ['xiaomi', 7], ['google', 6], ['anthropic', 5],
    ['minimax', 4], ['minimax', 3], ['openrouter', 2], ['google', 1], ['openai', 1]);
  assert.equal(isAttributedRanking(models), true);
  models[7].provider = 'other';
  assert.equal(isAttributedRanking(models), true, 'one unattributed model does not disqualify a model ranking');
  assert.equal(isAttributedRanking([]), false);
});

test('a day whose list is an app ranking is not counted, even where an app is filed under a model maker', async () => {
  const d = await run([
    // The 2026-08-18..09-15 shape. Ranks complete, so only the attribution
    // test can refuse it.
    { date: '2026-08-02', source: 'cron', or: [
      { rank: 1, model: 'Kilo Code', provider: 'other', tokRaw: 300 },
      { rank: 2, model: 'Cline', provider: 'other', tokRaw: 200 },
      { rank: 3, model: 'DeepSeek Harness', provider: 'deepseek', tokRaw: 100 },
    ] },
    { date: '2026-08-01', source: 'cron', or: ranking(['deepseek', 40], ['anthropic', 30], ['openai', 20], ['xai', 10]) },
    { date: '2026-05-01', source: 'cron', or: ranking(['deepseek', 40], ['anthropic', 30], ['openai', 20], ['xai', 10]) },
  ]);
  const q3 = rowsOf(d, '2026-Q3');
  close(q3.deepseek.shareAvg, 40, 'not (40 + 100 / 600 * 100) / 2');
  close(q3.deepseek.shareQoqPP, 0);
  assert.equal(q3.deepseek.shareReg, 'flat');
  assert.equal(quarterOf(d, '2026-Q3').shareDays, 1);
  assert.equal(d.shareBasis.excludedDays.notModelRanking, 1);
  assert.equal(d.shareBasis.depth, 4, 'an uncounted list does not set the depth');
});

test('a ranking with ranks missing is not counted: absence from it proves nothing', async () => {
  const d = await run([
    { date: '2026-08-02', source: 'cron', or: [
      { rank: 1, provider: 'anthropic', tokRaw: 50 }, { rank: 2, provider: 'deepseek', tokRaw: 30 },
      { rank: 4, provider: 'xai', tokRaw: 20 },
    ] },
    { date: '2026-08-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 30], ['openai', 20]) },
    { date: '2026-05-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 30], ['openai', 20]) },
  ]);
  const q3 = rowsOf(d, '2026-Q3');
  close(q3.openai.shareAvg, 20, 'the gapped day does not count OpenAI as zero');
  assert.equal(q3.xai, undefined, 'nor does it give xAI a share');
  assert.equal(d.shareBasis.excludedDays.incompleteRanking, 1);
});

/* ── (c) one day-set, one depth ───────────────────────────────────────── */

test('every provider is averaged over the same counted days, absent days as zero, to one depth', async () => {
  const d = await run([
    // Read to the shortest counted depth (3): this list's own top 3, 40/30/20 of 90.
    { date: '2026-08-02', source: 'cron', or: ranking(['openai', 40], ['anthropic', 30], ['deepseek', 20], ['minimax', 5], ['z-ai', 5]) },
    { date: '2026-08-01', source: 'cron', or: ranking(['openai', 40], ['anthropic', 30], ['deepseek', 30]) },
    { date: '2026-05-02', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 30], ['xai', 20]) },
    { date: '2026-05-01', source: 'cron', or: ranking(['anthropic', 50], ['deepseek', 30], ['openai', 20]) },
  ]);
  assert.equal(d.shareBasis.depth, 3);
  const q2 = rowsOf(d, '2026-Q2');
  close(q2.openai.shareAvg, 10, 'OpenAI is (20 + 0) / 2, not 20 over the one day it appears');
  close(q2.xai.shareAvg, 10);
  close(Object.values(q2).reduce((a, r) => a + r.shareAvg, 0), 100, 'one day-set: the quarter\'s shares sum to 100');

  const q3 = rowsOf(d, '2026-Q3');
  const openaiQ3 = (40 + (40 / 90) * 100) / 2;
  close(q3.openai.shareAvg, openaiQ3, 'the 5-row day is read as its top 3');
  close(q3.openai.shareQoqPP, openaiQ3 - 10);
  close(Object.values(q3).reduce((a, r) => a + r.shareAvg, 0), 100);

  // xAI had a share in Q2 and no model in the top 3 on any counted Q3 day:
  // no row and no imputed share, but named rather than silently dropped.
  assert.equal(q3.xai, undefined);
  assert.deepEqual(quarterOf(d, '2026-Q3').notInTopN, [{ slug: 'xai', label: 'xAI' }]);
});
