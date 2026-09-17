/**
 * Usage weights for provider price averages.
 *
 * WHAT THIS IS FOR
 * The provider pricing matrix averages a provider's lineup by (model, day)
 * observation: a model nobody calls counts as much as the one carrying the
 * traffic. That answers "what is on the menu", not "what does the market
 * actually pay". This module supplies the second answer by weighting each
 * model's price by the tokens it actually served, at the price in force at
 * the time it served them.
 *
 * WEIGHT SOURCE
 * /api/openrouter-chart-weekly — the weekly "Top Models" token series
 * captured from openrouter.ai/rankings. Each week carries
 * `allModels: { "<orProvider>/<model>": tokens }`. This is REAL observed
 * volume, not a survey or an estimate.
 *
 * THE HONESTY LIMITS — every one of them is surfaced in the response,
 * because a weighted average that hides its own coverage is worse than no
 * weighted average at all:
 *
 *   1. OpenRouter is a slice of the market, not the market. First-party API
 *      traffic (most of OpenAI's and Google's real volume) never appears.
 *      Weights describe OpenRouter's mix only.
 *
 *   2. OpenRouter's weekly chart names only its top ~9 models and buckets
 *      everything else into "Others". A provider whose traffic is spread
 *      across many mid-tier models is therefore under-represented, and
 *      "Others" cannot be split back out by provider. This is why coverage
 *      is measured and enforced rather than assumed — see gate below.
 *
 *   3. OpenRouter publishes ONE token count per model, prompt and completion
 *      combined. The same weight is therefore applied to the input average
 *      and the output average. A model whose traffic skews unusually far to
 *      one side is weighted slightly off on both.
 *
 *   4. Coverage needs a denominator — the provider's total OpenRouter
 *      tokens — from a separate capture (?providers=1). Two ways it can be
 *      incomplete, and both withhold rather than assume:
 *        a. A week of the quarter is missing from one of the two captures.
 *           Certifying a quarter on a subset of its weeks would publish a
 *           price averaged over more weeks than the coverage figure covers.
 *           Both directions count: a model week with no provider week, and
 *           a provider week with no model week.
 *        b. A provider is absent from a week's ranking, where OpenRouter
 *           folds it into `others`. Absence is not zero traffic, so that
 *           provider-quarter's denominator is short by an unknown amount
 *           and its coverage is unknowable — even though other providers
 *           in the same week are fine.
 *
 *   5. OpenRouter's `:free` variants serve tokens at no charge. Folding them
 *      into the paid SKU would count free traffic at the paid price and
 *      inflate a metric whose whole claim is "what was paid", so variant
 *      SKUs are excluded from the weights AND from the coverage numerator —
 *      they lower coverage, which is the visible, correct outcome.
 *
 *   6. Prices are taken from the week the tokens were served, not from a
 *      quarterly mean. A model repriced mid-quarter whose traffic is not
 *      uniform either side of the change would otherwise be charged a blend
 *      of the old and new price for all of its volume — which is not what
 *      anyone paid. Tokens in a week where the model carries no price are
 *      dropped and count against coverage.
 *
 * THE GATE
 * A weighted cell is published only when all of these hold:
 *   - the weight series was actually available;
 *   - at least MIN_WEIGHTED_MODELS priced models carry a weight, so the
 *     number is an average and not one model wearing a provider's name;
 *   - coverage is KNOWN for that provider-quarter; and
 *   - coverage is at least MIN_COVERAGE of the provider's own OpenRouter
 *     tokens.
 * Otherwise the cell is null and carries a `gate` string naming which test
 * it failed, so the UI can say why rather than showing a bare dash.
 *
 * Measured against live data on 2026-09-16, the slug reconciliation below
 * matches 100% of named OpenRouter tokens to a priced model for every week
 * at or after the pricing floor (2025-07-28); earlier weeks predate upstream
 * pricing entirely and match 0% by construction.
 */

/** Minimum priced models carrying a weight before a cell is an "average". */
export const MIN_WEIGHTED_MODELS = 2;
/**
 * Minimum share of a provider's own OpenRouter tokens the weights must cover.
 *
 * Deliberately lower than the concentration bar below. A volume-weighted price
 * over a fifth of a provider's traffic is a real, useful number as long as the
 * reader can see it is a fifth — and every cell states its coverage. What
 * actually misleads is not low coverage but a single model wearing a
 * provider's name, which MAX_TOP_WEIGHT_SHARE catches directly instead of
 * being approximated by a high coverage bar.
 */
export const MIN_COVERAGE = 0.15;
/**
 * Most of a cell's weight one model may carry.
 *
 * "At least two models" does not make an average: measured on live data,
 * 2026-Q2 Google cleared two models with the larger holding 93% of the weight,
 * and 2025-Q3 DeepSeek with 90%. Those are single-model prices with a second
 * model rounding to nothing. 85% admits genuine blends and rejects impostors.
 */
export const MAX_TOP_WEIGHT_SHARE = 0.85;

/**
 * pricepertoken provider slug → OpenRouter provider slug.
 *
 * Only `xai` actually differs (OpenRouter spells it `x-ai`), but the map is
 * explicit for all eight so a future rename fails loudly here instead of
 * silently zeroing a provider's weights.
 *
 * `cohere` has no OpenRouter presence in any captured week — it is listed so
 * the omission is visibly deliberate rather than an oversight.
 */
export const PPT_TO_OR_PROVIDER = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'x-ai',
  mistralai: 'mistralai',
  deepseek: 'deepseek',
  'meta-llama': 'meta-llama',
  cohere: 'cohere',
};

const OR_TO_PPT_PROVIDER = Object.fromEntries(
  Object.entries(PPT_TO_OR_PROVIDER).map(([ppt, or]) => [or, ppt]),
);

/**
 * Candidate pricepertoken model names for one OpenRouter model name, most
 * specific first. The caller takes the first candidate that exists in the
 * price catalog, so a more specific SKU always wins over its base model.
 *
 * Every rule here was derived from observed mismatches, not guessed:
 *
 *   gpt-5.6-luna-20260709      → gpt-5.6-luna        (trailing -YYYYMMDD)
 *   deepseek-v4-flash-20260731 → deepseek-v4-flash-0731, then -flash
 *                                (upstream keeps some dated SKUs as -MMDD)
 *   gpt-4.1-mini-2025-04-14    → gpt-4.1-mini        (trailing -YYYY-MM-DD)
 *   claude-3-7-sonnet-…        → claude-3.7-sonnet   (dashed version number)
 *   claude-4.5-sonnet-…        → claude-sonnet-4.5   (tier/version swapped)
 *
 * Kept deliberately narrow: exact matching after these rewrites, never fuzzy
 * or prefix matching. A model we cannot name exactly is reported as unpriced
 * and drags coverage down — which is the correct, visible outcome. Guessing
 * would silently attach a wrong price to real volume.
 */
export function priceModelCandidates(orModel) {
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };

  push(orModel);

  const dated = orModel.match(/^(.*)-(\d{8})$/);            // -YYYYMMDD
  if (dated) { push(dated[1] + '-' + dated[2].slice(4)); push(dated[1]); }

  const hyphenDated = orModel.match(/^(.*)-(\d{4})-(\d{2})-(\d{2})$/); // -YYYY-MM-DD
  if (hyphenDated) { push(hyphenDated[1] + '-' + hyphenDated[3] + hyphenDated[4]); push(hyphenDated[1]); }

  for (const base of [...out]) {                            // claude-3-7-x → claude-3.7-x
    const m = base.match(/^claude-(\d+)-(\d+)-(.*)$/);
    if (m) push('claude-' + m[1] + '.' + m[2] + '-' + m[3]);
  }
  for (const base of [...out]) {                            // claude-<ver>-<tier> → claude-<tier>-<ver>
    const m = base.match(/^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku)(.*)$/);
    if (m) push('claude-' + m[2] + '-' + m[1] + m[3]);
  }
  return out;
}

/** "2026-05-04" → "2026-Q2" */
function quarterOf(dateStr) {
  const m = parseInt(dateStr.slice(5, 7), 10);
  return dateStr.slice(0, 4) + '-Q' + (Math.floor((m - 1) / 3) + 1);
}

const DAY_MS = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * The last day a week's token count actually describes.
 *
 * A completed week ends on its scheduled end date. The CURRENT week is still
 * accumulating: the endpoint still labels it with the following Sunday, but
 * its token count only covers the days captured so far. Spreading that count
 * over all seven scheduled days would push observed traffic onto days that
 * have not happened — and across a quarter boundary, into a quarter that has
 * not started. A capture on 30 June would land most of its tokens in Q3.
 */
function observedEnd(week, observedThrough) {
  const end = typeof week.end === 'string' ? week.end : week.start;
  if (!week.partial || !observedThrough) return end;
  return observedThrough < end ? observedThrough : end;
}

/**
 * Split one week's tokens across the calendar quarters it touches, pro-rata
 * by observed day. Four weeks a year straddle a quarter boundary; assigning
 * such a week wholly to its start quarter would misplace up to six days of
 * volume, which a quarterly comparison then reports as a trend.
 *
 * Returns [{ quarter, fraction, from, to }] with fractions summing to 1,
 * where from/to bound the days of that week falling in that quarter — the
 * price lookup needs them to charge tokens at the price in force.
 */
function quarterSplit(startStr, endStr) {
  const start = Date.parse(startStr + 'T00:00:00Z');
  const end = Date.parse((endStr || startStr) + 'T00:00:00Z');
  if (!isFinite(start)) return [];
  const days = isFinite(end) && end >= start ? Math.round((end - start) / DAY_MS) + 1 : 7;

  const spans = new Map();
  for (let i = 0; i < days; i++) {
    const day = iso(start + i * DAY_MS);
    const q = quarterOf(day);
    const span = spans.get(q);
    if (span) { span.n += 1; span.to = day; }
    else spans.set(q, { n: 1, from: day, to: day });
  }
  return Array.from(spans, ([quarter, s]) => ({
    quarter, fraction: s.n / days, from: s.from, to: s.to,
  }));
}

/**
 * Whether an OpenRouter model name carries a variant suffix (":free" and any
 * future sibling).
 *
 * These are excluded from the weights entirely rather than folded into the
 * base SKU. `:free` is the one that appears in the captured series today and
 * it serves tokens at no charge — mapping `x-ai/grok-4.1-fast:free` onto the
 * paid `grok-4.1-fast` price would count free traffic at the paid rate. It is
 * not a rounding error: measured across the captured weeks, `:free` is 9.2% of
 * all named tokens and 11.9% of xAI's, a provider that publishes weighted
 * cells.
 *
 * Any other suffix that appears later is excluded too. A paid routing variant
 * would only lose us a little coverage, which is visible; guessing that it
 * prices like the base SKU would silently corrupt the average, which is not.
 */
function hasVariantSuffix(model) {
  return model.indexOf(':') >= 0;
}

/**
 * Build per-(provider, quarter) usage weights and coverage.
 *
 * @param {object} modelSeries    /api/openrouter-chart-weekly?full=1 payload
 * @param {object} providerSeries /api/openrouter-chart-weekly?providers=1 payload
 * @param {(pptSlug: string, orModel: string, quarter: string, from: string, to: string)
 *          => {model: string, price: number}|null} resolvePriced
 *        Returns the price-catalog model name AND the price in force over
 *        [from, to] for that model, or null when the model carries no price
 *        in that window. Both parts are the caller's job so this module never
 *        needs the pricing payload itself. The window is load-bearing twice
 *        over: a catalog spanning all history would count a model as covered
 *        in a quarter where it has no price row, and a quarterly mean price
 *        would charge mid-quarter repricing to traffic that never paid it.
 *
 * @returns {{
 *   weights: Map<string, Map<string, Map<string, {tokens:number, cost:number}>>>,
 *   coverage: Map<string, Map<string, number>>,
 *   uncertifiedQuarters: Set<string>,
 *   incompleteProviderQuarters: Set<string>,   // "quarter|pptSlug"
 *   providerSeriesLatestWeek: string|null,
 *   modelSeriesLatestWeek: string|null,
 * }}
 */
export function buildUsageWeights(modelSeries, providerSeries, resolvePriced) {
  const modelWeeks = Array.isArray(modelSeries?.weeks) ? modelSeries.weeks : [];
  const providerWeeks = Array.isArray(providerSeries?.weeks) ? providerSeries.weeks : [];

  // The capture time bounds the still-accumulating current week. `updatedAt`
  // is when the series was last captured; `fetchedAt` is a fallback.
  const capturedThrough = typeof modelSeries?.updatedAt === 'string'
    ? modelSeries.updatedAt.slice(0, 10)
    : (typeof modelSeries?.fetchedAt === 'string' ? modelSeries.fetchedAt.slice(0, 10) : null);

  const providerByWeek = new Map(providerWeeks.map((w) => [w.start, w]));
  const modelByWeek = new Map(modelWeeks.map((w) => [w.start, w]));

  const weights = new Map();        // quarter → slug → model → {tokens, cost}
  const covNumerator = new Map();   // quarter → slug → priced+named tokens
  const covDenominator = new Map(); // quarter → slug → provider total tokens

  // Quarters we cannot certify at all: some week of the quarter is missing
  // from one of the two captures, in EITHER direction.
  const uncertifiedQuarters = new Set();
  // "quarter|slug" pairs where the provider was absent from at least one
  // week's ranking, so its denominator is short by an unknown amount even
  // though the quarter itself is otherwise fully aligned.
  const incompleteProviderQuarters = new Set();

  const addTotal = (map, quarter, slug, value) => {
    if (!map.has(quarter)) map.set(quarter, new Map());
    const byProvider = map.get(quarter);
    byProvider.set(slug, (byProvider.get(slug) || 0) + value);
  };

  // ── Pass 1: weeks the model series has ──
  for (const week of modelWeeks) {
    if (typeof week?.start !== 'string') continue;
    const split = quarterSplit(week.start, observedEnd(week, capturedThrough));
    if (!split.length) continue;
    const aligned = providerByWeek.has(week.start);

    if (!aligned) {
      for (const { quarter } of split) uncertifiedQuarters.add(quarter);
    }

    for (const [slug, tokens] of Object.entries(week.allModels || {})) {
      if (slug === 'Others' || !(tokens > 0)) continue;
      const sep = slug.indexOf('/');
      if (sep <= 0) continue;
      const pptSlug = OR_TO_PPT_PROVIDER[slug.slice(0, sep)];
      if (!pptSlug) continue;                       // provider we do not price
      const orModel = slug.slice(sep + 1);
      if (hasVariantSuffix(orModel)) continue;      // free/variant SKU — not paid volume

      for (const { quarter, fraction, from, to } of split) {
        const priced = resolvePriced(pptSlug, orModel, quarter, from, to);
        if (!priced) continue;                      // unpriced in this window — lowers coverage
        const share = tokens * fraction;

        if (!weights.has(quarter)) weights.set(quarter, new Map());
        const byProvider = weights.get(quarter);
        if (!byProvider.has(pptSlug)) byProvider.set(pptSlug, new Map());
        const byModel = byProvider.get(pptSlug);
        const entry = byModel.get(priced.model) || { tokens: 0, cost: 0 };
        entry.tokens += share;
        entry.cost += priced.price * share;         // charged at the price then in force
        byModel.set(priced.model, entry);

        if (aligned) addTotal(covNumerator, quarter, pptSlug, share);
      }
    }

    if (!aligned) continue;
    const providers = providerByWeek.get(week.start).providers || {};
    for (const [pptSlug, orSlug] of Object.entries(PPT_TO_OR_PROVIDER)) {
      const total = providers[orSlug];
      if (typeof total === 'number' && total > 0) {
        for (const { quarter, fraction } of split) {
          addTotal(covDenominator, quarter, pptSlug, total * fraction);
        }
      } else {
        // Absent from this week's ranking. OpenRouter folds small providers
        // into `others`, so this is "unknown, probably small" — never zero.
        // The denominator for this provider-quarter is therefore short by an
        // unmeasurable amount, and a ratio built on it would overstate.
        for (const { quarter } of split) {
          incompleteProviderQuarters.add(quarter + '|' + pptSlug);
        }
      }
    }
  }

  // ── Pass 2: weeks only the provider series has ──
  // The loop above never visits these, so without this pass a quarter could
  // be certified while missing model weights for part of it — the mirror of
  // the case pass 1 catches.
  for (const week of providerWeeks) {
    if (typeof week?.start !== 'string' || modelByWeek.has(week.start)) continue;
    for (const { quarter } of quarterSplit(week.start, week.end)) {
      uncertifiedQuarters.add(quarter);
    }
  }

  const coverage = new Map();
  for (const [quarter, byProvider] of covDenominator) {
    if (uncertifiedQuarters.has(quarter)) continue;   // partly-measured: leave unknown
    const out = new Map();
    for (const [slug, total] of byProvider) {
      if (!(total > 0)) continue;
      if (incompleteProviderQuarters.has(quarter + '|' + slug)) continue;
      const named = covNumerator.get(quarter)?.get(slug) || 0;
      // Clamp at 1: OpenRouter's model chart and provider chart classify a
      // small number of community-hosted models differently, which can put
      // the ratio a few points over 100%. Clamping keeps the published
      // number honest without inventing a reconciliation we cannot verify.
      out.set(slug, Math.min(named / total, 1));
    }
    coverage.set(quarter, out);
  }

  const lastWeek = (arr) => (arr.length ? arr[arr.length - 1].start || null : null);
  return {
    weights,
    coverage,
    uncertifiedQuarters,
    incompleteProviderQuarters,
    providerSeriesLatestWeek: lastWeek(providerWeeks),
    modelSeriesLatestWeek: lastWeek(modelWeeks),
  };
}

/**
 * Apply weights to one provider-quarter.
 *
 * @param {Map<string, {tokens:number, cost:number}>|undefined} modelWeights
 *        priceModel → tokens served and what they cost at the prices in force
 *        when they were served. Cost is accumulated per week upstream, so this
 *        is a true volume-weighted average and not a mean of quarterly means.
 * @param {number|null} coverage 0..1, or null when unknown
 * @param {boolean} seriesAvailable whether the weight series loaded at all
 *
 * @returns {{avg:number|null, models:number, coverage:number|null,
 *            topShare:number|null, gate:string|null}}
 *          avg is in the upstream's native $/token unit; the caller scales.
 *          topShare is the largest single model's share of the weight, so a
 *          reader can tell a genuine blend from a number one model dominates —
 *          "4 models" alone does not distinguish the two.
 */
export function weightedAverage(modelWeights, coverage, seriesAvailable = true) {
  let cost = 0;
  let tokens = 0;
  let models = 0;
  let topTokens = 0;

  for (const [, entry] of modelWeights || []) {
    if (!entry || !(entry.tokens > 0)) continue;
    cost += entry.cost;
    tokens += entry.tokens;
    models += 1;
    if (entry.tokens > topTokens) topTokens = entry.tokens;
  }
  const topShare = tokens > 0 ? topTokens / tokens : null;
  // The value the weighting actually produced, returned whatever the gate then
  // decides. A withheld cell is not a cell we could not compute — it is one we
  // computed on a basis too thin to publish as measured. Keeping the number
  // lets the UI offer it as an explicit estimate rather than leaving a hole,
  // without it ever being mistaken for a measured value.
  const provisional = tokens > 0 ? cost / tokens : null;

  // Checked before "no usage": an outage is not evidence that nobody used
  // anything, and reporting it as zero volume would be a false statement
  // about the market rather than about our data.
  if (!seriesAvailable) {
    return { avg: null, provisional: null, models: 0, coverage: null, topShare: null, gate: 'series-unavailable' };
  }
  if (tokens <= 0) {
    return { avg: null, provisional: null, models: 0, coverage, topShare: null, gate: 'no-usage' };
  }
  if (models < MIN_WEIGHTED_MODELS) {
    return { avg: null, provisional, models, coverage, topShare, gate: 'too-few-models' };
  }
  if (coverage === null || coverage === undefined) {
    return { avg: null, provisional, models, coverage: null, topShare, gate: 'coverage-unknown' };
  }
  if (coverage < MIN_COVERAGE) {
    return { avg: null, provisional, models, coverage, topShare, gate: 'low-coverage' };
  }
  if (topShare !== null && topShare > MAX_TOP_WEIGHT_SHARE) {
    return { avg: null, provisional, models, coverage, topShare, gate: 'single-model-dominated' };
  }
  return { avg: cost / tokens, provisional, models, coverage, topShare, gate: null };
}

/** Human-readable reason a weighted cell was withheld. */
export function gateReason(gate, coverage, models) {
  const pct = coverage === null || coverage === undefined
    ? null
    : (coverage * 100).toFixed(0) + '%';
  switch (gate) {
    case 'series-unavailable':
      return 'The OpenRouter weekly token series could not be loaded, so no weights ' +
        'could be built. This says nothing about actual usage.';
    case 'no-usage':
      return 'No paid OpenRouter token volume recorded for this provider in this quarter ' +
        '(free-tier variants are excluded from paid weights).';
    case 'too-few-models':
      return 'Only ' + models + ' priced model' + (models === 1 ? '' : 's') +
        ' carried volume — one model is not a provider average.';
    case 'coverage-unknown':
      return 'Coverage cannot be measured for the whole quarter — either a week of it is ' +
        'missing from one of the two captures, or this provider fell out of OpenRouter\'s ' +
        'weekly ranking, where its traffic is folded into "others" and cannot be counted.';
    case 'low-coverage':
      return 'Weights cover only ' + pct + ' of this provider\'s OpenRouter tokens — ' +
        'below the ' + (MIN_COVERAGE * 100).toFixed(0) + '% needed to call it an average.';
    case 'single-model-dominated':
      return 'One model carries more than ' + (MAX_TOP_WEIGHT_SHARE * 100).toFixed(0) +
        '% of the weight, so this would be that model\'s price under the provider\'s ' +
        'name rather than an average across its lineup.';
    default:
      return null;
  }
}
