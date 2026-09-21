import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as providerMatrix } from '../provider-pricing-matrix.js';
import { onRequestGet as peerMatrix } from '../model-pricing-peer-matrix.js';

const DAY = 86400000;
const days = (f, t) => { const o = []; for (let x = Date.parse(f + 'T00:00:00Z'); x <= Date.parse(t + 'T00:00:00Z'); x += DAY) o.push(new Date(x).toISOString().slice(0, 10)); return o; };
const hist = (model, spans) => spans.flatMap(([f, t, p]) => days(f, t).map(d => ({ model, date: d + 'T00:00:00+00:00', pricing_prompt: p, pricing_completion: p * 8 })));
const S = '2026-04-01', E = '2026-09-20';
const G = ['gemini-2.5-pro','gemini-2.5-flash','gemini-2.5-flash-lite','gemini-3.1-pro-preview','gemini-3-flash-preview','gemini-3.5-flash'];
const O = ['gpt-5-mini','gpt-5.5','gpt-5-nano','gpt-5.4','gpt-5.1','gpt-5.2'];
const UPSTREAM = {
  google: [...G.flatMap((m, i) => hist(m, [[S, '2026-07-09', (i + 1) * 2e-7], ['2026-07-10', E, (i + 1) * 1e-7]])), ...hist('gemma-3-27b-it', [[S, E, 3e-8]])],
  openai: [...O.flatMap((m, i) => hist(m, [[S, '2026-07-09', (i + 1) * 4e-7], ['2026-07-10', E, (i + 1) * 2e-7]])), ...hist('gpt-5', [[S, E, 1.25e-6]])],
  anthropic: [...hist('claude-opus-4', [[S, '2026-08-13', 1.5e-5], ['2026-08-14', E, 7.5e-6]]), ...hist('claude-sonnet-4', [[S, E, 3e-6]])],
  deepseek: [1,2,3,4,5,6,7].flatMap(i => hist('ds-' + i, [[S, '2026-07-09', i * 1e-7], ['2026-07-10', E, i * 0.9e-7]])),
};
async function call(handler, path) {
  const realFetch = globalThis.fetch, realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => { const u = new URL(url); if (u.hostname.includes('pricepertoken')) return new Response(JSON.stringify({ results: UPSTREAM[u.searchParams.get('provider')] || [] }), { status: 200 }); return new Response('null', { status: 404 }); };
  try { return await (await handler({ request: new Request('https://x.test' + path), env: {}, waitUntil() {} })).json(); }
  finally { globalThis.fetch = realFetch; globalThis.caches = realCaches; }
}
test('provider matrix refuses QoQ across the change and keeps a genuine lone cut', async () => {
  const d = await call(providerMatrix, '/api/provider-pricing-matrix?metric=input');
  assert.deepEqual(d.measureBreaks.events.map(e => e.effectiveDate), ['2026-07-10']);
  const q3 = Object.fromEntries(d.quarters.find(q => q.quarter === '2026-Q3').cells.map(c => [c.slug, c]));
  for (const slug of ['google', 'openai']) { assert.equal(q3[slug].qoq, null); assert.equal(q3[slug].qoqMeasureChanged, true); assert.match(q3[slug].qoqReason, /Not comparable/); }
  assert.ok(q3.anthropic.qoq < 0, 'the real cut is still reported');
  assert.equal(q3.anthropic.qoqMeasureChanged, undefined);
  assert.equal(q3.deepseek.qoq, -0.09, 'an ordinary repricing the same day is reported as one');
});
test('peer matrix refuses Jun->Jul MoM on touched reps and keeps the lone cut', async () => {
  const d = await call(peerMatrix, '/api/model-pricing-peer-matrix');
  const reps = Object.fromEntries(d.reps.map(r => [r.key, r]));
  assert.equal(reps['google-fast'].momInput['2026-07'], undefined);
  assert.match(reps['google-fast'].measureChanged.momInput['2026-07'], /Not comparable/);
  assert.equal(reps['google-fast'].momInput['2026-08'], 0, 'no second false cut from a blended July');
  const opus = d.reps.find(r => r.providerSlug === 'anthropic' && (r.matchedModels || []).includes('claude-opus-4'));
  assert.ok(opus.momInput['2026-08'] < 0, 'the genuine August cut is reported');
  assert.equal(opus.measureChanged, undefined);
});