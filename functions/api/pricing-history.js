/**
 * Cloudflare Pages Function — Quarterly Model Pricing History
 * Route: /api/pricing-history
 * Method: GET
 *
 * Reads canonical daily snapshots from HISTORY_KV, filters each snapshot's
 * `pricing.models` array to the stable tracked basket, and derives a
 * quarterly average series with QoQ and YoY comparisons.
 *
 * Query params:
 *   ?metric=input   (default)  — input price per 1M tokens
 *   ?metric=output             — output price per 1M tokens
 *   ?range=N                   — number of days to scan (default 400, max 400)
 *
 * Methodology (documented here because it is the whole point):
 *   1. For each captured day, look at snapshot.pricing.models. That list
 *      contains only basket members present on pricepertoken.com that day.
 *   2. Tag every one of those observations with the MEASURE it sits on —
 *      which figure the source was reporting for that model that day (see
 *      "The change of measure" below).
 *   3. Group observations by calendar quarter (Q1 = Jan-Mar, UTC).
 *   4. quarterAvg = equal-weighted mean of the quarter's observations, all
 *      resting on ONE measure: the measure most of the quarter's touched
 *      observations are on wins, the rest are left out and counted
 *      (`excludedObs`), never blended. quarterCoverage = observations per
 *      observed day, rounded to the nearest basket member.
 *      quarterDayCount = days observed.
 *   5. QoQ = (quarterAvg[q] - quarterAvg[q-1]) / quarterAvg[q-1]
 *      YoY = (quarterAvg[q] - quarterAvg[q-4]) / quarterAvg[q-4]
 *      Both are null unless the exact adjacent / year-earlier quarter
 *      exists with real data. Across a change of measure they are LINKED,
 *      not refused (see below).
 *   6. The current calendar quarter is marked partial:true (QTD avg).
 *
 * The change of measure:
 *   On 2026-07-10 the figure pricepertoken reports for two dozen Google and
 *   OpenAI models fell to exactly half of the day before — the source
 *   changing WHICH price it reports, not the market repricing. Six of the
 *   sixteen basket members sit in the families that change touched, so read
 *   raw this endpoint published a Q3-26 basket average no composition
 *   produces and a large negative QoQ that never happened. Every level here
 *   now rests on one measure and every comparison across the change is taken
 *   at the exact factor of the change, by _model-price-basis.js — the same
 *   module the pricing and peer matrices use.
 *
 *   The DATES are detected in pricepertoken's live per-model history, not in
 *   this basket: the module needs at least 5 models stepping by one exact
 *   factor at a provider, and the basket holds only ~2 Google and ~4 OpenAI
 *   slugs in the touched families. Detecting from the basket alone could MISS
 *   the change — and a missed change is published as a measured price move,
 *   which is precisely the error this exists to remove. The dates are then
 *   applied to the basket, where a member counts as touched only if its OWN
 *   captured series stepped by that exact factor across that date.
 *
 *   If a provider's live history cannot be read on a request, its basket
 *   members cannot be classified. Growth is withheld only where that matters:
 *   where such a member's own series shows an exact halving or doubling that
 *   a change of measure could be hiding in (`growthWithheld` says so in
 *   words). A provider whose members never took such a step cannot be hiding
 *   one, so its numbers are unaffected.
 *
 * Explicitly NOT done:
 *   - No synthetic backfill.
 *   - No "closest available quarter" comparisons.
 *   - No usage weighting.
 *   - No computation from the full 530-model site universe.
 *   - No rescaling of a published level: a figure after the change is exactly
 *     what the source now reports. Only comparisons are linked.
 *
 * Response:
 *   {
 *     success,
 *     metric: 'input' | 'output',
 *     basket: { size, members: [{slug, provider, label}, ...] },
 *     trackingSinceDate,
 *     measureBreaks: { headline, detail } | null,
 *     sourceHistory: { readable: [...], errors: [...], growthWithheld: null },
 *     quarters: [
 *       {
 *         id: '2026-Q2',
 *         start: '2026-04-01', end: '2026-06-30',
 *         avg: 3.42, avgLabel: '$3.42',
 *         qoq: -0.031, qoqLabel: '-3.1%', qoqNote: null,
 *         yoy: null, yoyLabel: null, yoyNote: null,
 *         coverage: { matched: 14, basket: 16, ratio: 0.875 },
 *         basis: null, excludedObs: 0,
 *         dayCount: 12,
 *         partial: true,
 *         notes: 'QTD avg · partial quarter',
 *       },
 *       ...
 *     ]
 *   }
 */

import { PRICING_BASKET, BASKET_SIZE } from './_pricing-basket.js';
import {
  BASIS_ORIGIN,
  detectMeasureBreaks,
  modelBasisTimeline,
  priceSteps,
  tallyFor,
  addToTally,
  resolveTally,
  resolvePeriodTallies,
  growthSeries,
  describeMeasureBreaks,
  sparse,
} from './_model-price-basis.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// The per-model daily history the change of measure is detected in. Same
// upstream, same subrequest cache lifetime as the pricing and peer matrices.
const UPSTREAM_BASE = 'https://api.pricepertoken.com/api/provider-pricing-history/';
const CACHE_TTL = 3600;

/**
 * Basket provider label -> upstream provider slug. Slugs match upstream's
 * provider query parameter exactly, as in provider-pricing-matrix.js — note
 * 'mistralai', which is not the basket's 'mistral-ai-' slug prefix. A basket
 * member whose provider is missing here has no readable history, so it falls
 * under the withholding rule below rather than being silently trusted.
 */
const UPSTREAM_PROVIDER = {
  'OpenAI':     'openai',
  'Anthropic':  'anthropic',
  'Google':     'google',
  'Xai':        'xai',
  'Mistral AI': 'mistralai',
  'Deepseek':   'deepseek',
  'Cohere':     'cohere',
};

/** Upstream provider slug -> the label the basket shows, for the caption. */
const PROVIDER_LABEL = Object.fromEntries(
  Object.entries(UPSTREAM_PROVIDER).map(([label, slug]) => [slug, label])
);

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      ...CORS,
    },
  });
}

function parseDateUTC(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function quarterOf(d) {
  return { year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1 };
}

function quarterKey(d) {
  const { year, quarter } = quarterOf(d);
  return year + '-Q' + quarter;
}

function quarterRange(d) {
  const { year, quarter } = quarterOf(d);
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/** "2026-Q2" -> "2025-Q2" */
function yearAgoKey(key) {
  const m = key.match(/^(\d{4})-Q(\d)$/);
  if (!m) return null;
  return (parseInt(m[1], 10) - 1) + '-Q' + m[2];
}

/** "2026-Q2" -> "2026-Q1"; "2026-Q1" -> "2025-Q4" */
function priorKey(key) {
  const m = key.match(/^(\d{4})-Q(\d)$/);
  if (!m) return null;
  const y = parseInt(m[1], 10), q = parseInt(m[2], 10);
  if (q === 1) return (y - 1) + '-Q4';
  return y + '-Q' + (q - 1);
}

function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }

function formatPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n >= 10) return '$' + n.toFixed(2);
  if (n >= 1)  return '$' + n.toFixed(2);
  return '$' + n.toFixed(3);
}

function formatPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const sign = n > 0 ? '+' : '';
  return sign + (n * 100).toFixed(1) + '%';
}

/** The metric's price on one snapshot row, or null when it is not a price. */
function priceOf(m, metric) {
  const v = metric === 'input' ? m.input : m.output;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/* ── The change of measure, detected upstream and applied to the basket ── */

async function fetchProvider(slug) {
  const url = UPSTREAM_BASE + '?provider=' + encodeURIComponent(slug);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'gdash-pricing-history/1.0',
        Accept: 'application/json',
      },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
    if (!r.ok) return { slug, rows: [], error: 'HTTP ' + r.status };
    const j = await r.json();
    return { slug, rows: Array.isArray(j?.results) ? j.results : [] };
  } catch (e) {
    return { slug, rows: [], error: e.message };
  }
}

/**
 * Every date on which the source changed what it reports, for both metrics,
 * read from the live per-model history of the basket's own providers.
 *
 * Returns { input, output, readable, errors }: `readable` is the set of
 * provider slugs whose history actually arrived — a provider that did not
 * cannot be classified, and its members are handled by suspectSlugs().
 */
async function detectBreaks() {
  const slugs = Array.from(
    new Set(PRICING_BASKET.map(b => UPSTREAM_PROVIDER[b.provider]).filter(Boolean))
  ).sort();
  const fetched = await Promise.all(slugs.map(fetchProvider));
  const withRows = fetched.filter(f => f.rows.length);
  return {
    input:  withRows.length ? detectMeasureBreaks(fetched, 'input')  : [],
    output: withRows.length ? detectMeasureBreaks(fetched, 'output') : [],
    readable: new Set(withRows.map(f => f.slug)),
    errors: fetched.filter(f => f.error).map(f => ({ provider: f.slug, error: f.error })),
  };
}

/** slug -> (day -> price per 1M) for this metric, usable prices only. */
function basketSeries(dailies, metric) {
  const out = new Map();
  for (const s of dailies) {
    for (const m of s.pricing.models) {
      if (!m || typeof m.slug !== 'string') continue;
      const v = priceOf(m, metric);
      if (v === null || v <= 0) continue;
      let days = out.get(m.slug);
      if (!days) out.set(m.slug, (days = new Map()));
      days.set(s.date, v);
    }
  }
  return out;
}

/**
 * The measure a timeline's segments put `day` on. basisAt() in
 * _model-price-basis.js is not exported; this is the same walk, kept here so
 * the route stays self-contained.
 */
function basisAtDay(segments, day) {
  let basis = BASIS_ORIGIN;
  for (const seg of segments) {
    if (seg.from === null || seg.from <= day) basis = seg.basis;
    else break;
  }
  return basis;
}

/**
 * Which measure each basket member's price is on, day by day, for one metric.
 *
 * The dates come from `events` — detected upstream, never from this basket
 * (see the header). Applying them here is safe: modelBasisTimeline() marks a
 * member touched only where its OWN captured series stepped by the change's
 * exact factor across the change's date.
 *
 *   basisOf(slug, day)  the measure that member's price is on, or null for a
 *                       member no change touched (it counts on whichever
 *                       measure a quarter is on)
 *   linkOf(slug, day)   what the observation is multiplied by to put it on
 *                       the earlier measure — 1 untouched, the inverse of the
 *                       change's exact factor for a member it moved, null for
 *                       one first captured after the change
 */
function basketBasisBook(series, events) {
  const timelines = new Map();
  if (events && events.length) {
    for (const entry of PRICING_BASKET) {
      const days = series.get(entry.slug);
      if (!days || !days.size) continue;
      const t = modelBasisTimeline(days, events, UPSTREAM_PROVIDER[entry.provider] || null);
      if (t.touched) timelines.set(entry.slug, t);
    }
  }
  return {
    basisOf(slug, day) {
      const t = timelines.get(slug);
      return t && day ? basisAtDay(t.segments, day) : null;
    },
    linkOf(slug, day) {
      const t = timelines.get(slug);
      if (!t || !day) return 1;
      const b = basisAtDay(t.segments, day);
      if (b === BASIS_ORIGIN) return 1;
      if (!t.changes.some(c => c.kind === 'moved' && c.basis === b)) return null;
      const ev = events.find(e => e.effectiveDate === b);
      return ev && ev.factor > 0 ? 1 / ev.factor : null;
    },
  };
}

/**
 * Basket members whose measure this request could not establish: their
 * provider's live history did not arrive, AND their own captured series takes
 * an exact halving or doubling — the one step a change of measure is hiding
 * in. Without the per-model history there is no telling that step apart from
 * a real price cut, so growth resting on such a member is withheld.
 *
 * A member whose provider failed to load but which never took such a step is
 * on one measure throughout whatever happened upstream, so it is not suspect
 * and its numbers stand.
 */
function suspectSlugs(series, readable) {
  const out = new Set();
  for (const entry of PRICING_BASKET) {
    const up = UPSTREAM_PROVIDER[entry.provider] || null;
    if (up && readable.has(up)) continue;
    const days = series.get(entry.slug);
    if (!days || days.size < 2) continue;
    if (priceSteps(days).some(s => s.direction !== 0)) out.add(entry.slug);
  }
  return out;
}

/** Why growth resting on `suspect` members is withheld, in words. */
function withheldReason(suspect) {
  const labels = Array.from(
    new Set(PRICING_BASKET.filter(b => suspect.has(b.slug)).map(b => b.provider))
  ).sort();
  return (
    'Growth withheld: ' + labels.join(', ') + ' per-model price history could not be read on ' +
    'this request, and ' + (suspect.size === 1 ? 'a basket member of it steps' : suspect.size +
    ' basket members of it step') + ' by exactly half or double somewhere in the captured ' +
    'window. Without that history there is no telling such a step apart from the source ' +
    'changing which price it reports — and reporting a change of measure as a price move is ' +
    'the one error this figure must not make. The averages themselves are the figures the ' +
    'source published, unchanged.'
  );
}

export async function onRequestGet({ request, env }) {
  const kv = env?.HISTORY_KV;
  if (!kv) {
    return jsonResp({ success: false, error: 'HISTORY_KV not bound' }, 500);
  }

  const url = new URL(request.url);
  const view = (url.searchParams.get('view') || 'basket').toLowerCase();
  if (view !== 'basket' && view !== 'by-slug') {
    return jsonResp(
      { success: false, error: 'view must be "basket" (default) or "by-slug"' },
      400
    );
  }
  const metric = (url.searchParams.get('metric') || 'input').toLowerCase();
  if (metric !== 'input' && metric !== 'output') {
    return jsonResp(
      { success: false, error: 'metric must be "input" or "output"' },
      400
    );
  }
  const range = Math.min(
    parseInt(url.searchParams.get('range') || '400', 10) || 400,
    400
  );

  // ── Load index + all daily snapshots in range ──
  const index = (await kv.get('index:days', 'json')) || [];
  const days = index.slice(0, range);
  const dailies = (
    await Promise.all(days.map(d => kv.get('day:' + d, 'json')))
  ).filter(s => s && s.pricing && Array.isArray(s.pricing.models));

  if (!dailies.length) {
    return jsonResp({
      success: true,
      view,
      metric,
      basket: { size: BASKET_SIZE, members: PRICING_BASKET },
      trackingSinceDate: null,
      quarters: [],
      models: view === 'by-slug' ? [] : undefined,
      message:
        'No canonical pricing snapshots yet. Run /api/history-capture to create the first snapshot.',
    });
  }

  // Tracking-since = earliest day that has basket-pricing data
  const trackingSinceDate = dailies.reduce(
    (min, s) => (s.date < min ? s.date : min),
    dailies[0].date
  );

  // The dates the source changed what it reports, from its live per-model
  // history — only once there are snapshots to apply them to.
  const breaks = await detectBreaks();

  // ── view=by-slug: per-model quarterly series (input + output together) ──
  // Used by the Model Pricing matrix table. Same canonical basket, same
  // quarter grouping, same real-only / no-backfill rule as the default
  // basket-averaged view — just sliced per-slug instead of averaged across.
  if (view === 'by-slug') {
    return jsonResp(buildBySlugResponse(dailies, trackingSinceDate, breaks));
  }

  // ── Per-member, per-quarter observations, each on its own measure ──
  const series = basketSeries(dailies, metric);
  const book = basketBasisBook(series, breaks[metric]);
  const perSlug = new Map();        // slug -> qid -> tally
  const touchedIn = new Map();      // slug -> Set(qid) a change applies in
  const daysSeen = new Map();       // qid -> Set of dates with an observation
  const obsIn = new Map();          // qid -> observations captured
  const ranges = new Map();         // qid -> { start, end }
  for (const s of dailies) {
    const dt = parseDateUTC(s.date);
    const key = quarterKey(dt);
    let seen = false;
    for (const m of s.pricing.models) {
      if (!m || typeof m.slug !== 'string') continue;
      const v = priceOf(m, metric);
      if (v === null) continue;
      const basis = book.basisOf(m.slug, s.date);
      if (!perSlug.has(m.slug)) perSlug.set(m.slug, new Map());
      addToTally(tallyFor(perSlug.get(m.slug), key), basis, v, m.slug, book.linkOf(m.slug, s.date));
      if (basis != null) {
        if (!touchedIn.has(m.slug)) touchedIn.set(m.slug, new Set());
        touchedIn.get(m.slug).add(key);
      }
      obsIn.set(key, (obsIn.get(key) || 0) + 1);
      seen = true;
    }
    if (!seen) continue;
    if (!ranges.has(key)) ranges.set(key, quarterRange(dt));
    if (!daysSeen.has(key)) daysSeen.set(key, new Set());
    daysSeen.get(key).add(s.date);
  }

  // ── The basket's quarterly level ──
  // Each member contributes ONE figure: its own quarterly mean, settled on
  // its own measure first (so a member the change moved is never a blend of
  // $1.25 and $0.625), carrying what that figure links to on the earlier
  // measure. Every member then weighs the same whatever days it was captured
  // on, which is what _pricing-basket.js promises — pooling raw observations
  // instead would let a moved member weigh less after the change than before
  // it and print a few percent of drift where nothing was repriced.
  const tallies = new Map();        // qid -> tally, one observation per member
  const excludedObsIn = new Map();  // qid -> observations left off-measure
  for (const [slug, byQ] of perSlug) {
    for (const [qid, t] of byQ) {
      const r = resolveTally(t);
      if (r.mean === null) continue;
      if (r.excludedN) excludedObsIn.set(qid, (excludedObsIn.get(qid) || 0) + r.excludedN);
      // An untouched member counts on whichever measure the quarter settles
      // on; a touched one counts only on its own.
      const basis = touchedIn.get(slug)?.has(qid) ? r.basis : null;
      const link = r.linkedMean === null ? null : (r.mean !== 0 ? r.linkedMean / r.mean : 1);
      addToTally(tallyFor(tallies, qid), basis, r.mean, slug, link);
    }
  }

  if (!tallies.size) {
    return jsonResp({
      success: true,
      metric,
      basket: { size: BASKET_SIZE, members: PRICING_BASKET },
      trackingSinceDate,
      quarters: [],
      message:
        'No pricing observations for metric=' + metric +
        ' in captured snapshots yet.',
    });
  }

  // Snapshot prices are already per 1M tokens, so no scaling.
  const resolved = resolvePeriodTallies(tallies, 1);
  const events = breaks[metric];
  const suspect = suspectSlugs(series, breaks.readable);
  const growthWithheld = suspect.size ? withheldReason(suspect) : null;
  const qoqAll = growthWithheld ? null : growthSeries(resolved.levels, priorKey, { events });
  const yoyAll = growthWithheld ? null : growthSeries(resolved.levels, yearAgoKey, { events });

  // ── Build output sorted newest quarter first ──
  const todayKey = quarterKey(new Date());
  const sortedKeys = Array.from(tallies.keys()).sort().reverse();

  const quarters = sortedKeys.map(key => {
    const avg = resolved.values[key];
    const dayCount = daysSeen.get(key).size;
    const basis = resolved.basis[key] || null;
    const excludedObs = excludedObsIn.get(key) || 0;
    const excludedMembers = resolved.excluded[key] || 0;
    const partial = key === todayKey;

    const qoq = qoqAll && key in qoqAll.growth ? qoqAll.growth[key] : null;
    const yoy = yoyAll && key in yoyAll.growth ? yoyAll.growth[key] : null;
    // A comparison either rests on a link across the change, or was refused
    // because one side could not be linked, or was withheld for want of the
    // provider's history. Whichever it is, the reader is told in words.
    const qoqNote = growthWithheld ||
      (qoqAll && (qoqAll.linked[key] || qoqAll.measureChanged[key])) || null;
    const yoyNote = growthWithheld ||
      (yoyAll && (yoyAll.linked[key] || yoyAll.measureChanged[key])) || null;

    // Coverage is observations per observed day, as before: how much of the
    // basket the source actually priced across the quarter.
    const matched = Math.round((obsIn.get(key) || 0) / dayCount);
    const coverageRatio = matched / BASKET_SIZE;
    const lowCoverage = coverageRatio < 0.625; // <10/16

    const notes = [];
    if (partial) notes.push('QTD avg · partial quarter');
    notes.push('basket coverage ' + matched + '/' + BASKET_SIZE);
    if (lowCoverage) notes.push('low coverage — comparisons may be noisy');
    if (dayCount < 7 && !partial)
      notes.push('only ' + dayCount + ' observed day' + (dayCount === 1 ? '' : 's'));
    if (basis)
      notes.push('on the measure the source has reported since ' + basis);
    if (excludedObs)
      notes.push(excludedObs + ' observation' + (excludedObs === 1 ? '' : 's') +
        ' on the other measure left out — a blend of two measures describes nothing');
    if (excludedMembers)
      notes.push(excludedMembers + ' basket member' + (excludedMembers === 1 ? '' : 's') +
        ' left out of this average, their quarter resting on the other measure');
    if (qoq === null) notes.push(qoqNote || 'QoQ: insufficient prior-quarter history');
    // One withheld reason covers both comparisons — don't say it twice.
    const yoyLine = yoyNote || 'YoY: insufficient year-ago history';
    if (yoy === null && !notes.includes(yoyLine)) notes.push(yoyLine);

    return {
      id: key,
      start: ranges.get(key).start,
      end: ranges.get(key).end,
      avg: avg === null ? null : round2(avg),
      avgLabel: formatPrice(avg),
      qoq,
      qoqLabel: formatPct(qoq),
      qoqNote,
      yoy,
      yoyLabel: formatPct(yoy),
      yoyNote,
      coverage: {
        matched,
        basket: BASKET_SIZE,
        ratio: round2(coverageRatio),
      },
      basis,
      excludedObs,
      excludedMembers,
      dayCount,
      partial,
      notes,
    };
  });

  return jsonResp({
    success: true,
    metric,
    methodology:
      'Each basket member\'s own quarterly mean, resting on one measure, then the ' +
      'equal-weighted mean of those across matched members. Stable tracked basket only. ' +
      'QoQ vs immediately prior quarter; YoY vs same calendar quarter one year earlier, ' +
      'linked at the exact factor of the change where the source changed what it reports. ' +
      'Real captured snapshots only — no backfill, no synthetic data.',
    basket: {
      size: BASKET_SIZE,
      members: PRICING_BASKET,
    },
    trackingSinceDate,
    measureBreaks: describeMeasureBreaks([events], s => PROVIDER_LABEL[s] || s),
    sourceHistory: {
      readable: Array.from(breaks.readable).sort(),
      errors: breaks.errors,
      growthWithheld,
    },
    quarters,
  });
}

/* ── view=by-slug helper ──────────────────────────────────────
   Builds a per-model quarterly series across the canonical basket. Same
   real-only / no-backfill rule as the default basket-averaged view, and the
   same change-of-measure treatment: each slug's quarterly level rests on one
   measure, and growth across the change is linked at its exact factor.
   Response shape:
     {
       success, view: 'by-slug', trackingSinceDate,
       basket: { size, members: [...] },
       measureBreaks: { headline, detail } | null,
       quarters: [{ id, start, end, partial, dayCount }, ...],   // chronological
       models: [{
         slug, provider, label,
         input:    { '<qid>': avg, ... },
         output:   { '<qid>': avg, ... },
         dayCount: { '<qid>': n,   ... },
         qoqInput, qoqOutput,    // (current - prior) / prior
         yoyInput, yoyOutput,    // (current - same-quarter-prior-year) / same-quarter-prior-year
         priceBasis,             // sparse: only quarters off the original measure
         basisExcludedObs,       // sparse: only quarters that left observations out
         measureChanged,         // sparse: why a growth cell is empty, in words
         linkedChange,           // sparse: what a linked growth cell rests on
         growthWithheld,         // why this slug carries no growth at all, or absent
         coverageDays  // total observed days across all quarters
       }, ...]
     }
*/
function buildBySlugResponse(dailies, trackingSinceDate, breaks) {
  const todayQ = quarterKey(new Date());

  // Per-slug observation list
  const obsBySlug = new Map(); // slug -> [{date,input,output}, ...]
  const allQuarters = new Set();
  for (const s of dailies) {
    const qid = quarterKey(parseDateUTC(s.date));
    allQuarters.add(qid);
    if (!Array.isArray(s.pricing?.models)) continue;
    for (const m of s.pricing.models) {
      if (!m?.slug) continue;
      if (!obsBySlug.has(m.slug)) obsBySlug.set(m.slug, []);
      obsBySlug.get(m.slug).push({
        date: s.date,
        input:  typeof m.input  === 'number' && isFinite(m.input)  ? m.input  : null,
        output: typeof m.output === 'number' && isFinite(m.output) ? m.output : null,
      });
    }
  }

  // Quarter list, chronological so the renderer reads left → right
  const quarterIds = Array.from(allQuarters).sort();
  const dayCountByQ = {};
  for (const s of dailies) {
    const qid = quarterKey(parseDateUTC(s.date));
    dayCountByQ[qid] = (dayCountByQ[qid] || 0) + 1;
  }
  const quarters = quarterIds.map(qid => {
    const m = qid.match(/^(\d{4})-Q(\d)$/);
    const y = parseInt(m[1], 10);
    const q = parseInt(m[2], 10);
    const startMonth = (q - 1) * 3;
    const start = new Date(Date.UTC(y, startMonth, 1)).toISOString().slice(0, 10);
    const end   = new Date(Date.UTC(y, startMonth + 3, 0)).toISOString().slice(0, 10);
    return { id: qid, start, end, partial: qid === todayQ, dayCount: dayCountByQ[qid] || 0 };
  });

  // Which measure each member's price is on, per metric. The per-slug view is
  // per-slug all the way through, so an unreadable provider costs growth only
  // on its own members, never on anyone else's.
  const seriesIn  = basketSeries(dailies, 'input');
  const seriesOut = basketSeries(dailies, 'output');
  const books = {
    input:  basketBasisBook(seriesIn,  breaks.input),
    output: basketBasisBook(seriesOut, breaks.output),
  };
  const suspect = new Set([
    ...suspectSlugs(seriesIn,  breaks.readable),
    ...suspectSlugs(seriesOut, breaks.readable),
  ]);

  // Per-slug per-quarter averages + comparisons
  const models = [];
  for (const basketEntry of PRICING_BASKET) {
    const obs = obsBySlug.get(basketEntry.slug) || [];
    const tIn = new Map(), tOut = new Map();
    for (const o of obs) {
      const qid = quarterKey(parseDateUTC(o.date));
      if (o.input !== null) {
        addToTally(tallyFor(tIn, qid), books.input.basisOf(basketEntry.slug, o.date),
          o.input, basketEntry.slug, books.input.linkOf(basketEntry.slug, o.date));
      }
      if (o.output !== null) {
        addToTally(tallyFor(tOut, qid), books.output.basisOf(basketEntry.slug, o.date),
          o.output, basketEntry.slug, books.output.linkOf(basketEntry.slug, o.date));
      }
    }
    // Snapshot prices are already per 1M tokens, so no scaling.
    const rIn = resolvePeriodTallies(tIn, 1);
    const rOut = resolvePeriodTallies(tOut, 1);

    const input = {}, output = {}, dayCount = {};
    for (const qid of new Set([...Object.keys(rIn.values), ...Object.keys(rOut.values)])) {
      input[qid]  = rIn.values[qid]  == null ? null : round2(rIn.values[qid]);
      output[qid] = rOut.values[qid] == null ? null : round2(rOut.values[qid]);
      dayCount[qid] = Math.max(rIn.n[qid] || 0, rOut.n[qid] || 0);
    }

    // Don't compute growth for the partial (QTD) quarter — partial averages
    // can't be cleanly compared against full-quarter comparators. Same rule
    // as the default basket-averaged view had, kept here.
    const withheld = suspect.has(basketEntry.slug) ? withheldReason(new Set([basketEntry.slug])) : null;
    const g = (levels, priorOf, events) =>
      withheld ? { growth: {}, measureChanged: {}, linked: {} }
               : growthSeries(levels, priorOf, { skip: todayQ, events });
    const qoqIn  = g(rIn.levels,  priorKey,   breaks.input);
    const qoqOut = g(rOut.levels, priorKey,   breaks.output);
    const yoyIn  = g(rIn.levels,  yearAgoKey, breaks.input);
    const yoyOut = g(rOut.levels, yearAgoKey, breaks.output);

    models.push({
      slug: basketEntry.slug,
      provider: basketEntry.provider,
      label: basketEntry.label,
      input,
      output,
      dayCount,
      qoqInput: qoqIn.growth,
      qoqOutput: qoqOut.growth,
      yoyInput: yoyIn.growth,
      yoyOutput: yoyOut.growth,
      // Sparse on purpose — a slug the change never touched carries none of
      // these keys at all, so a renderer looks one up by the field it already
      // reads the value by and finds nothing to say.
      priceBasis: sparse({ input: rIn.basis, output: rOut.basis }),
      basisExcludedObs: sparse({ input: rIn.excluded, output: rOut.excluded }),
      measureChanged: sparse({
        qoqInput: qoqIn.measureChanged, qoqOutput: qoqOut.measureChanged,
        yoyInput: yoyIn.measureChanged, yoyOutput: yoyOut.measureChanged,
      }),
      linkedChange: sparse({
        qoqInput: qoqIn.linked, qoqOutput: qoqOut.linked,
        yoyInput: yoyIn.linked, yoyOutput: yoyOut.linked,
      }),
      ...(withheld ? { growthWithheld: withheld } : {}),
      coverageDays: obs.length,
    });
  }

  return {
    success: true,
    view: 'by-slug',
    methodology:
      'Per-slug arithmetic mean of daily prices within each calendar quarter, resting on ' +
      'one measure. QoQ vs immediately prior quarter; YoY vs same calendar quarter one year ' +
      'earlier, linked at the exact factor of the change where the source changed what it ' +
      'reports. Real captured snapshots only — no backfill, no synthetic data. The current ' +
      'in-progress quarter (QTD) is shown but its growth comparisons are suppressed ' +
      'because partial-quarter averages aren\'t cleanly comparable against full quarters.',
    basket: { size: BASKET_SIZE, members: PRICING_BASKET },
    trackingSinceDate,
    measureBreaks: describeMeasureBreaks([breaks.input, breaks.output], s => PROVIDER_LABEL[s] || s),
    sourceHistory: {
      readable: Array.from(breaks.readable).sort(),
      errors: breaks.errors,
    },
    quarters,
    models,
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
