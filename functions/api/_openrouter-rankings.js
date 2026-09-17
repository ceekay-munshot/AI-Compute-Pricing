/**
 * OpenRouter rankings — direct JSON API access.
 *
 * WHY THIS EXISTS
 * The dashboard reached OpenRouter's ranking data two fragile ways, and both
 * failed silently for weeks before anyone noticed:
 *
 *   1. A headless-browser capture (scripts/capture-openrouter.mjs) that sniffed
 *      chart XHRs out of the rankings page. Its provider-series detector
 *      rejected any payload containing `"data":[`. When OpenRouter wrapped the
 *      market-share response in exactly that envelope, the capture stopped
 *      persisting provider totals — stale from 2026-06-09, unnoticed for 14
 *      weeks, and the reason every usage-weighted cell for 2026-Q2 and Q3 had
 *      to be withheld for want of a denominator.
 *
 *   2. A Firecrawl LLM extraction (/api/openrouter) asked to pull "the
 *      leaderboard rankings table". That page carries BOTH a Top Models and a
 *      Top Apps table. On 2026-08-18 the extraction drifted to Apps, and the
 *      daily history has recorded "Kilo Code" and "Cline" as models ever
 *      since — with total tokens collapsing from ~28T to ~1.8T and Gemini
 *      share reading zero.
 *
 * Both are the same failure: a guess about presentation standing in for the
 * data itself. OpenRouter serves these as plain JSON, so this module asks for
 * the JSON.
 *
 *     https://openrouter.ai/api/frontend/v1/rankings/<dataset>?view=<view>
 *
 * Datasets confirmed live on 2026-09-16:
 *   models        — one aggregate row per (model, variant) for the period,
 *                   with prompt and completion tokens counted SEPARATELY.
 *                   ~500 models. This is a period total, not a time series:
 *                   nearly every row carries the period-end date.
 *   market-share  — a genuine weekly time series of per-provider tokens,
 *                   {x: weekStart, ys: {provider: tokens}}, 52 weeks deep and
 *                   current. Top-9 providers plus an "others" bucket.
 *   tools, images — same {x, ys} series shape, not used here.
 *
 * NOTHING HERE TRUSTS THE RESPONSE. Every payload is validated before it is
 * returned, and a payload that fails validation is reported as a failure
 * rather than passed along. Storing a plausible-looking wrong answer is what
 * produced both outages above; refusing it is the whole point of this module.
 */

const RANKINGS_BASE = 'https://openrouter.ai/api/frontend/v1/rankings/';

/** Providers OpenRouter is known to attribute real model traffic to. */
const KNOWN_PROVIDERS = new Set([
  'openai', 'anthropic', 'google', 'x-ai', 'mistralai', 'deepseek',
  'meta-llama', 'cohere', 'qwen', 'tencent', 'z-ai', 'xiaomi', 'nvidia',
  'minimax', 'moonshotai', 'stepfun', 'tngtech', 'arcee-ai', 'openrouter',
  'microsoft', 'nousresearch', 'amazon', 'baidu', 'bytedance', 'perplexity',
  'inclusionai', 'liquid', 'alibaba', 'ibm-granite', 'meta',
]);

/**
 * Rows whose model name is really an APPLICATION, not a model. These are the
 * fingerprints of the 2026-08-18 regression: if they show up in something
 * claiming to be a model ranking, the source is wrong and the payload must be
 * refused rather than stored.
 */
const APP_NAME_HINTS = /^(kilo code|cline|codex|pi|omp|freebuff|roo code|chatwise|sillytavern|openrouter api|janitorai|openwebui)$/i;

export class RankingsError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'RankingsError';
    this.detail = detail || null;
  }
}

async function fetchDataset(dataset, view, { signal } = {}) {
  const url = RANKINGS_BASE + encodeURIComponent(dataset) +
    (view ? '?view=' + encodeURIComponent(view) : '');
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/json',
      // OpenRouter serves this endpoint to the rankings page; identify honestly.
      'User-Agent': 'gdash-openrouter-rankings/1.0',
    },
    signal,
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!resp.ok) {
    throw new RankingsError('HTTP ' + resp.status + ' from rankings/' + dataset);
  }
  let body;
  try {
    body = await resp.json();
  } catch (e) {
    throw new RankingsError('rankings/' + dataset + ' did not return JSON');
  }
  if (body && body.error) {
    throw new RankingsError('rankings/' + dataset + ': ' + (body.error.message || 'upstream error'));
  }
  return body;
}

/** "2026-09-15 00:00:00" → "2026-09-15" */
function isoDay(value) {
  if (typeof value !== 'string' || value.length < 10) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Per-model usage for the requested period.
 *
 * Returns { periodEnd, rows: [{provider, model, slug, variant,
 *                              promptTokens, completionTokens, totalTokens}] }
 *
 * The prompt/completion split matters: weighting an INPUT price by combined
 * tokens over-weights models whose traffic skews to output, and vice versa.
 * The weekly chart this replaces only ever published one combined number.
 */
export async function fetchModelUsage(view = 'week', opts) {
  const body = await fetchDataset('models', view, opts);
  const raw = Array.isArray(body?.data) ? body.data : null;
  if (!raw) throw new RankingsError('rankings/models: no data array');

  const rows = [];
  let latest = null;
  for (const r of raw) {
    const slug = typeof r?.model_permaslug === 'string' ? r.model_permaslug : null;
    if (!slug) continue;
    const sep = slug.indexOf('/');
    if (sep <= 0) continue;
    const prompt = Number(r.total_prompt_tokens) || 0;
    const completion = Number(r.total_completion_tokens) || 0;
    if (prompt <= 0 && completion <= 0) continue;
    const day = isoDay(r.date);
    if (day && (!latest || day > latest)) latest = day;
    rows.push({
      provider: slug.slice(0, sep),
      model: slug.slice(sep + 1),
      slug,
      // "standard" is paid list-price traffic. "free" is served at no charge
      // and "batch" at a different rate — neither belongs in a list-price
      // average, and the caller filters on this rather than guessing from
      // the slug.
      variant: typeof r.variant === 'string' ? r.variant : 'standard',
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      date: day,
    });
  }

  validateModelRows(rows);
  return { periodEnd: latest, view, rows };
}

/**
 * Reject a payload that is not a model ranking.
 *
 * The 2026-08-18 regression produced rows that were structurally perfect and
 * semantically wrong — app names under a provider of "other". Structure alone
 * cannot catch that, so these checks look at what the rows actually say.
 */
export function validateModelRows(rows) {
  if (rows.length < 20) {
    throw new RankingsError('rankings/models: only ' + rows.length +
      ' usable rows — expected hundreds; refusing rather than storing a partial ranking');
  }
  const appish = rows.filter(r => APP_NAME_HINTS.test(r.model.trim())).length;
  if (appish > 0) {
    throw new RankingsError('rankings/models: ' + appish +
      ' rows look like applications rather than models (e.g. Kilo Code, Cline) — ' +
      'this is the Top Apps table, not Top Models');
  }
  const known = rows.filter(r => KNOWN_PROVIDERS.has(r.provider)).length;
  if (known < rows.length * 0.5) {
    throw new RankingsError('rankings/models: only ' + known + ' of ' + rows.length +
      ' rows carry a recognised model provider — payload does not look like a model ranking');
  }
}

/**
 * Weekly per-provider token totals — the denominator for coverage.
 *
 * Returns { weeks: [{ start, providers: {slug: tokens} }] } sorted oldest
 * first, matching the shape /api/openrouter-chart-weekly?providers=1 serves so
 * callers need no special-casing.
 *
 * Note this is top-N providers plus "others": a provider missing from a week
 * is folded into that bucket, so its absence means unknown, never zero. The
 * weighting layer already treats it that way.
 */
export async function fetchMarketShare(view = 'week', opts) {
  const body = await fetchDataset('market-share', view, opts);
  const raw = Array.isArray(body?.data) ? body.data : null;
  if (!raw) throw new RankingsError('rankings/market-share: no data array');

  const weeks = [];
  for (const point of raw) {
    const start = isoDay(point?.x);
    const ys = point?.ys;
    if (!start || !ys || typeof ys !== 'object') continue;
    const providers = {};
    for (const [slug, tokens] of Object.entries(ys)) {
      const n = Number(tokens);
      if (n > 0) providers[slug] = n;
    }
    if (Object.keys(providers).length) weeks.push({ start, providers });
  }
  weeks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  validateMarketShare(weeks);
  return { view, weeks };
}

export function validateMarketShare(weeks) {
  if (weeks.length < 8) {
    throw new RankingsError('rankings/market-share: only ' + weeks.length +
      ' weekly points — too short to certify coverage against');
  }
  const last = weeks[weeks.length - 1];
  const keys = Object.keys(last.providers);
  const known = keys.filter(k => k === 'others' || KNOWN_PROVIDERS.has(k)).length;
  if (known < keys.length * 0.5) {
    throw new RankingsError('rankings/market-share: last week\'s keys (' +
      keys.slice(0, 6).join(', ') + ') are not recognisable providers');
  }
}

/**
 * How stale a weekly series is, in whole weeks, against today.
 *
 * Surfaced rather than computed and discarded: the two outages this module
 * replaces were both invisible precisely because nothing reported freshness.
 */
export function weeksBehind(latestWeekStart, now = new Date()) {
  if (!latestWeekStart) return null;
  const then = Date.parse(latestWeekStart + 'T00:00:00Z');
  if (!isFinite(then)) return null;
  const nowTs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((nowTs - then) / (7 * 86400000)));
}
