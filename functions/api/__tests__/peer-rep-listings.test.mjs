import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as peerMatrix } from '../model-pricing-peer-matrix.js';

/* Which listings price a peer-matrix representative, and what its changes
   compare. Upstream prices are $/token; the matrix shows $/1M. Every period
   used here is complete (the in-progress quarter/month is never compared). */

const DAY = 86400000;
const days = (f, t) => { const o = []; for (let x = Date.parse(f + 'T00:00:00Z'); x <= Date.parse(t + 'T00:00:00Z'); x += DAY) o.push(new Date(x).toISOString().slice(0, 10)); return o; };
// spans: [[from, to, input $/1M, output $/1M], ...]
const hist = (model, spans) => spans.flatMap(([f, t, i, o]) => days(f, t).map(d => ({
  model, date: d + 'T00:00:00+00:00', pricing_prompt: i / 1e6, pricing_completion: o / 1e6,
})));

async function peer(upstream) {
  const realFetch = globalThis.fetch, realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname.includes('pricepertoken')) return new Response(JSON.stringify({ results: upstream[u.searchParams.get('provider')] || [] }), { status: 200 });
    return new Response('null', { status: 404 });
  };
  try {
    const d = await (await peerMatrix({ request: new Request('https://x.test/api/model-pricing-peer-matrix'), env: {}, waitUntil() {} })).json();
    return { d, rep: key => d.reps.find(r => r.key === key) };
  } finally { globalThis.fetch = realFetch; globalThis.caches = realCaches; }
}

const INTERNAL = /pricing_|original_|matchedModels|setAside|listingChanged|\/api\//;

test('a rep is priced from its own listing, never blended with a differently priced snapshot', async () => {
  const { rep } = await peer({
    openai: [
      ...hist('gpt-4o',            [['2025-07-28', '2026-03-31', 2.5, 10]]),
      ...hist('gpt-4o-2024-08-06', [['2025-07-28', '2026-03-31', 2.5, 10]]),
      // Still sold at its own price, then delisted at the end of 2025.
      ...hist('gpt-4o-2024-05-13', [['2025-07-28', '2025-12-31', 5, 15]]),
    ],
  });
  const r = rep('openai-frontier-prev');
  // Not $3.125 / $11.25 — a price no GPT-4o SKU has.
  assert.deepEqual(r.input,  { '2025-Q3': 2.5, '2025-Q4': 2.5, '2026-Q1': 2.5 });
  assert.deepEqual(r.output, { '2025-Q3': 10,  '2025-Q4': 10,  '2026-Q1': 10 });
  // The snapshot leaving the catalog is not a -20% price cut.
  assert.deepEqual(r.qoqInput, { '2025-Q4': 0, '2026-Q1': 0 });
  assert.deepEqual(r.qoqOutput, { '2025-Q4': 0, '2026-Q1': 0 });
  assert.deepEqual(r.matchedModels, ['gpt-4o', 'gpt-4o-2024-08-06']);
  assert.deepEqual(r.setAsideModels.map(s => s.model), ['gpt-4o-2024-05-13']);
  const why = r.setAsideModels[0].reason;
  assert.match(why, /\$5\.00 input \/ \$15\.00 output/);
  assert.match(why, /gpt-4o at \$2\.50 \/ \$10\.00/);
  assert.doesNotMatch(why, INTERNAL);
  assert.equal(r.listingChanged, undefined);
});

test('the rule follows the prices, not a model name: GPT-3.5 Turbo sets aside its 0613 snapshot', async () => {
  const { rep } = await peer({
    openai: [
      ...hist('gpt-3.5-turbo',      [['2025-07-28', '2025-12-31', 0.5, 1.5]]),
      ...hist('gpt-3.5-turbo-0613', [['2025-07-28', '2025-12-31', 1, 2]]),
    ],
  });
  const r = rep('openai-legacy');
  assert.deepEqual(r.chosenCandidateNorms, ['gpt35turbo']);
  assert.deepEqual(r.input, { '2025-Q3': 0.5, '2025-Q4': 0.5 });
  assert.deepEqual(r.output, { '2025-Q3': 1.5, '2025-Q4': 1.5 });
  assert.deepEqual(r.setAsideModels.map(s => s.model), ['gpt-3.5-turbo-0613']);
});

test('a re-publish priced like the model stands in only where the own listing is absent', async () => {
  const { rep } = await peer({
    openai: [
      // The dated name is listed first; the alias arrives in Q4.
      ...hist('gpt-4o-mini-2024-07-18', [['2025-07-28', '2026-03-31', 0.15, 0.6]]),
      ...hist('gpt-4o-mini',            [['2025-10-01', '2026-03-31', 0.15, 0.6]]),
    ],
  });
  const r = rep('openai-fast-prev');
  assert.deepEqual(r.input, { '2025-Q3': 0.15, '2025-Q4': 0.15, '2026-Q1': 0.15 });
  assert.deepEqual(r.setAsideModels, []);
  // Q3 rests on the dated name alone, Q4 on the alias: the change compares
  // the listing both quarters carry — the dated name — so it is computed.
  assert.equal(r.qoqInput['2025-Q4'], 0);
  assert.equal(r.listingChanged, undefined);
  // From Q4 each quarter is priced from the alias only.
  assert.equal(r.obsCount['2025-Q4'], 92);
});

test('a successor model joining the row is not reported as a price move', async () => {
  const { rep } = await peer({
    google: [
      ...hist('gemini-3-pro-preview',   [['2025-10-01', '2026-01-31', 2, 12]]),
      ...hist('gemini-3.1-pro-preview', [['2026-02-01', '2026-06-30', 2.5, 15]]),
    ],
  });
  const r = rep('google-frontier');
  // Each level is what the source charged over the period: 31 days at $2 and
  // 59 at $2.50 in Q1.
  assert.deepEqual(r.input, { '2025-Q4': 2, '2026-Q1': 2.328, '2026-Q2': 2.5 });
  // Averaged together, Q1 read +16.4% and Q2 +7.4%. Like-for-like, neither
  // model's price moved.
  assert.deepEqual(r.qoqInput, { '2026-Q1': 0, '2026-Q2': 0 });
  // Jan and Feb share no listing: refused and named, never a bare dash.
  assert.equal(r.momInput['2026-02'], undefined);
  assert.match(r.listingChanged.momInput['2026-02'], /^Not comparable: the source lists this model as gemini-3\.1-pro-preview here and as gemini-3-pro-preview in Jan 2026\./);
  assert.doesNotMatch(r.listingChanged.momInput['2026-02'], INTERNAL);
  assert.equal(r.measureChanged, undefined, 'a listing change is not a change of measure');
  assert.equal(r.momInput['2026-03'], 0);
});

test('the frontier is priced from the winning model\'s own listing', async () => {
  const { d, rep } = await peer({
    google: [
      ...hist('gemini-2.5-pro',         [['2025-10-01', '2025-12-31', 1.25, 10]]),
      ...hist('gemini-2.5-pro-preview', [['2025-10-01', '2025-12-31', 1, 8]]),
    ],
  });
  const g = d.frontierReference.find(f => f.providerSlug === 'google');
  assert.equal(g.cells['2025-Q4'].model, 'gemini-2.5-pro');
  assert.deepEqual(g.cells['2025-Q4'].matchedVariants, ['gemini-2.5-pro', 'gemini-2.5-pro-preview']);
  assert.equal(g.input['2025-Q4'], 1.25, 'not the $1.125 blend');
  assert.equal(g.output['2025-Q4'], 10);
  const r = rep('google-frontier-prev');
  assert.deepEqual(r.input, { '2025-Q4': 1.25 });
  assert.deepEqual(r.setAsideModels.map(s => s.model), ['gemini-2.5-pro-preview']);
});
