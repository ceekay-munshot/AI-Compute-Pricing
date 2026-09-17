/**
 * Cloudflare Pages Function — Model Pricing Peer Matrix
 * Route: /api/model-pricing-peer-matrix
 * Method: GET
 *
 * Powers the "Model Pricing by Provider" finance-model table on the Model
 * Pricing tab. Returns per-(provider × tier) representative-model quarterly
 * input/output pricing using the SAME upstream that provider-pricing-matrix
 * uses, but filtered to specific peer-pair models so QoQ math reflects real
 * provider repricing on the same model rather than a drifting lineup average.
 *
 * Why a separate endpoint (not a new mode on /api/pricing-history):
 *   /api/pricing-history reads from the canonical HISTORY_KV daily snapshots,
 *   which have only existed for as long as the dashboard has been running.
 *   In dev / preview that's just a handful of days; the resulting table only
 *   has one column. This endpoint goes upstream to pricepertoken's own
 *   historical pricing API which has real coverage back to 2025-07-28, giving
 *   us 4+ real quarters of multi-period peer comparison the customer asked
 *   for.
 *
 * Upstream:
 *   https://api.pricepertoken.com/api/provider-pricing-history/?provider=<slug>
 *   Same source provider-pricing-matrix.js uses. Each row is one
 *   (model, day) observation with pricing_prompt + pricing_completion in
 *   $/token (we scale to $/1M for display).
 *
 * Peer-model selection — fixed deterministic mapping. Frontier picks the
 * production flagship the hyperscaler markets first; Fast / Cost-efficient
 * picks the cheap high-volume tier each provider sells. Reasoning specialty
 * (o3, Opus) intentionally NOT included — they're tracked elsewhere and
 * mixing them would muddy the apples-to-apples peer comparison.
 *
 * Model-name matching — upstream casing / punctuation varies. Normalize by
 * lowercasing and stripping [-\s_.] then test:
 *   - exact match against target normalized form
 *   - OR target as a prefix, with a suffix that is NOT a tier marker
 *     (mini / lite / flash / haiku / nano / micro). This catches dated /
 *     preview / exp variants of the same model class while rejecting
 *     same-family-different-tier names.
 *
 * Response shape:
 *   {
 *     success, source, earliestDateObserved,
 *     quarters: [{ id, start, end, partial }, ...],   // chronological
 *     reps: [
 *       {
 *         key, provider, tier, label, modelDisplay, chosenCandidateNorms,
 *         input, output, qoqInput, qoqOutput, yoyInput, yoyOutput,
 *         obsCount, matchedModels, hasData,
 *         repFreshness: {
 *           status: 'OK' | 'WATCH' | 'REVIEW' | 'STALE',
 *           reason: '...combined evidence sentence...',
 *           ppEvidence: { newerStable:[...], newerLimited:[...] },
 *           firecrawlEvidence: { enabled, possibleNewerModels:[...] },
 *         }
 *       }, ...
 *     ],
 *     frontierReference: [
 *       { providerSlug, providerLabel,
 *         cells: { '<qid>': { display, matchedVariants:[...] } | null, ... } },
 *     ],
 *     providerCatalog,
 *     externalCatalog: {
 *       source: 'firecrawl',
 *       enabled: bool,
 *       reason?: string,                               // when enabled=false
 *       generatedAt?: ISO,
 *       allowlist?: [{ slug, url }, ...],
 *       providers: { '<slug>': {
 *           providerLabel, scrapedUrl, ok, error?,
 *           observedModels: [...],                     // names from docs
 *           possibleNewerModels: [...],                // observed but NOT in pp catalog
 *       }, ... },
 *       notes: [...],
 *       degraded?: bool,                                // all scrapes failed
 *     },
 *     providerErrors,
 *   }
 *
 * Firecrawl is optional and used ONLY for model-discovery / freshness drift.
 * Pricing math (avg, QoQ, YoY) remains sourced exclusively from pricepertoken.
 * Reps are NOT auto-promoted from Firecrawl observations — that's a deliberate
 * human decision; this audit just tells the operator when their fixed reps
 * may be stale.
 */

const UPSTREAM_BASE = 'https://api.pricepertoken.com/api/provider-pricing-history/';
const CACHE_TTL = 86400; // 24 hours — Firecrawl + pricepertoken responses both
                         // change at most daily; longer cache reduces load on
                         // both upstreams and amortizes Firecrawl quota use.

/* Peer-pair representatives. Each rep declares an ordered list of `candidates`;
   the row uses the FIRST candidate with at least one matching upstream row.
   Each candidate may itself match a SET of model norms (`norms: [...]`) —
   when a provider's flagship transitions across closely-related sub-versions
   (e.g. Google's gemini-3-pro-preview → gemini-3.1-pro-preview successor)
   we aggregate them so the row reads as one continuous model-class series
   instead of either alone giving sparse QoQ coverage.

   Picks anchor to the latest model class with reasonable upstream history
   so QoQ reflects real provider repricing on a model the customer would
   recognize as current. The literal newest point version per quarter
   (Claude Opus 4.7, GPT-5.5 Pro, Gemini 3.1 Pro) is surfaced separately
   in the Frontier Reference table so the fixed-rep QoQ math doesn't
   drift with each new point release. */
const PEER_MODELS = [
  // ── Frontier (current generation) — the flagship each hyperscaler
  //    markets first today.
  { key:'google-frontier',    provider:'Google',    tier:'Frontier',              providerSlug:'google',
    label:'Google / Gemini — Frontier',
    candidates:[
      // Continuous gen-3 Pro lineage (3-pro-preview deprecated 2026-03-25,
      // succeeded by 3.1-pro-preview from 2026-02-20). Together: Q4-25 +
      // Q1-26 + Q2-26 + Q3-26 coverage.
      {norms:['gemini3propreview','gemini31propreview'], display:'Gemini 3 Pro Preview'},
      // Defensive fallback if gen-3 ever vanishes from upstream
      {norms:['gemini25pro'], display:'Gemini 2.5 Pro'},
    ]},
  { key:'openai-frontier',    provider:'OpenAI',    tier:'Frontier',              providerSlug:'openai',
    label:'OpenAI — Frontier',
    candidates:[ {norms:['gpt5'], display:'GPT-5'} ] },
  { key:'anthropic-frontier', provider:'Anthropic', tier:'Frontier',              providerSlug:'anthropic',
    label:'Anthropic — Frontier',
    candidates:[ {norms:['claudeopus4'], display:'Claude Opus 4'} ] },

  // ── Frontier (prior generation) — the flagship one generation back.
  //    These carry the FULL upstream window (2025-07-28 →) where the
  //    current-gen rows only start when that generation shipped, so they
  //    are what make multi-period QoQ and monthly YoY actually computable.
  { key:'google-frontier-prev',    provider:'Google',    tier:'Frontier — prior gen', providerSlug:'google',
    label:'Google / Gemini — Frontier (prior gen)',
    candidates:[
      {norms:['gemini25pro'],  display:'Gemini 2.5 Pro'},
      {norms:['geminipro15'],  display:'Gemini 1.5 Pro'},
    ]},
  { key:'openai-frontier-prev',    provider:'OpenAI',    tier:'Frontier — prior gen', providerSlug:'openai',
    label:'OpenAI — Frontier (prior gen)',
    candidates:[
      {norms:['gpt4o'],  display:'GPT-4o'},
      {norms:['gpt41'],  display:'GPT-4.1'},
    ]},
  { key:'anthropic-frontier-prev', provider:'Anthropic', tier:'Frontier — prior gen', providerSlug:'anthropic',
    label:'Anthropic — Frontier (prior gen)',
    candidates:[
      {norms:['claudesonnet4'],   display:'Claude Sonnet 4'},
      {norms:['claude35sonnet'],  display:'Claude 3.5 Sonnet'},
    ]},

  // ── Fast / Cost-efficient — same generation as Frontier where possible
  { key:'google-fast',        provider:'Google',    tier:'Fast / Cost-efficient', providerSlug:'google',
    label:'Google / Gemini — Fast / Cost-efficient',
    candidates:[
      {norms:['gemini3flashpreview'], display:'Gemini 3 Flash Preview'},
      {norms:['gemini25flash'],       display:'Gemini 2.5 Flash'},
    ]},
  { key:'openai-fast',        provider:'OpenAI',    tier:'Fast / Cost-efficient', providerSlug:'openai',
    label:'OpenAI — Fast / Cost-efficient',
    candidates:[ {norms:['gpt5mini'], display:'GPT-5 mini'} ] },
  { key:'anthropic-fast',     provider:'Anthropic', tier:'Fast / Cost-efficient', providerSlug:'anthropic',
    label:'Anthropic — Fast / Cost-efficient',
    candidates:[
      {norms:['claudehaiku45'], display:'Claude Haiku 4.5'},
      {norms:['claude3haiku'],  display:'Claude 3 Haiku'},
    ]},

  // ── Fast / Cost-efficient (prior generation) — the cheap tier one
  //    generation back. Full-window coverage, same rationale as the
  //    prior-gen frontier rows.
  { key:'google-fast-prev',    provider:'Google',    tier:'Fast — prior gen', providerSlug:'google',
    label:'Google / Gemini — Fast (prior gen)',
    candidates:[
      {norms:['gemini25flash'],   display:'Gemini 2.5 Flash'},
      {norms:['gemini20flash'],   display:'Gemini 2.0 Flash'},
    ]},
  { key:'openai-fast-prev',    provider:'OpenAI',    tier:'Fast — prior gen', providerSlug:'openai',
    label:'OpenAI — Fast (prior gen)',
    candidates:[
      {norms:['gpt4omini'],  display:'GPT-4o mini'},
      {norms:['gpt41mini'],  display:'GPT-4.1 mini'},
    ]},
  { key:'anthropic-fast-prev', provider:'Anthropic', tier:'Fast — prior gen', providerSlug:'anthropic',
    label:'Anthropic — Fast (prior gen)',
    candidates:[
      {norms:['claude35haiku'], display:'Claude 3.5 Haiku'},
      {norms:['claude3haiku'],  display:'Claude 3 Haiku'},
    ]},

  // ── Legacy — prior-generation flagship. First candidate with data wins.
  //    Google's norm list is ordered `geminipro15` FIRST because upstream
  //    spells it `gemini-pro-1.5` (normalizes to `geminipro15`), NOT
  //    `gemini-1.5-pro`. The old `gemini15pro` norm matched nothing, which
  //    is why the Google Legacy row silently vanished from the matrix.
  { key:'google-legacy',    provider:'Google',    tier:'Legacy', providerSlug:'google',
    label:'Google / Gemini — Legacy',
    candidates:[
      {norms:['geminipro15'],    display:'Gemini 1.5 Pro'},
      {norms:['geminiflash15'],  display:'Gemini 1.5 Flash'},
      {norms:['gemini20flash'],  display:'Gemini 2.0 Flash'},
    ]},
  { key:'openai-legacy',    provider:'OpenAI',    tier:'Legacy', providerSlug:'openai',
    label:'OpenAI — Legacy',
    candidates:[
      {norms:['gpt4turbo'],  display:'GPT-4 Turbo'},
      {norms:['gpt35turbo'], display:'GPT-3.5 Turbo'},
    ]},
  { key:'anthropic-legacy', provider:'Anthropic', tier:'Legacy', providerSlug:'anthropic',
    label:'Anthropic — Legacy',
    candidates:[
      {norms:['claude3opus'],   display:'Claude 3 Opus'},
      {norms:['claude3sonnet'], display:'Claude 3 Sonnet'},
    ]},
];

/* ─────────────────────────────────────────────────────────────────────
   Automatic frontier detection.

   This replaced a hand-maintained priority list per provider, which went
   stale the moment a provider shipped anything: the list topped out at
   Claude Opus 4.7 / GPT-5.5 Pro / Gemini 3.1 Pro while the upstream catalog
   already carried Opus 4.8, Opus 5, Fable 5.1, the whole GPT-5.6 family and
   GPT-6 Astra — so the dashboard kept presenting months-old models as each
   provider's current frontier.

   Nothing here is a list of known models. Each provider declares how its
   model NAMES are shaped, and the frontier for a period is derived from
   whatever the upstream catalog actually contains in that period. A model
   released tomorrow is picked up on the next fetch with no code change,
   and because selection runs per period against that period's own rows,
   history stays intact — Sep-25 still resolves to what was frontier in
   Sep-25, not to today's flagship.

   Selection, per provider per period:
     1. Drop specialty SKUs (see FRONTIER_EXCLUDE) and alternate-billing
        rows — these are modality, latency or billing variants, not a better
        model, and several are priced ABOVE the flagship (claude-opus-*-fast
        at $30 vs $5, o1-pro at $150) so they would otherwise win outright.
     2. Match the remainder against the provider's `flagship` line patterns
        and read each one's version number out of its name.
     3. Take the highest version found across ALL flagship lines. Line order
        breaks ties only — it is deliberately NOT a preference ranking, or a
        provider that stopped shipping under one line name would pin the
        frontier to that line forever (the exact staleness this replaced).
     4. If a period has no flagship match at all, fall back to the `fallback`
        lines, so an early period with only a cost tier still resolves.
     5. Within the winning version, take the priciest variant — that is the
        top SKU of that generation (gpt-5.5-pro $23 over gpt-5.5 $3.87).
        Equal prices fall back to the shortest name, i.e. the base model.

   Version comparison is [major, minor] integer pairs, not a float, so 3.10
   sorts above 3.9 rather than below it.

   Models that match a provider prefix but no line pattern are reported in
   the response as `frontierUnclassified`, so a naming scheme this parser
   does not understand shows up as a visible signal instead of silently
   narrowing what the table can see.
   ───────────────────────────────────────────────────────────────────── */

/* Specialty / non-comparable SKUs, tested against the raw upstream name.
   Deliberately broad: anything here is never eligible to be a frontier. */
const FRONTIER_EXCLUDE =
  /(image|audio|video|embedding|tts|realtime|search|deep-?research|codex|instruct|customtools|custom-tools|safeguard|oss|gemma|lyria|-fast\b|exacto|guard|moderation|whisper|dall|sora|veo|imagen|embed|\bmini\b|-mini|\bnano\b|-nano|\blite\b|-lite|haiku|chat)/i;

/* Per-provider name grammar. Each line's regex must expose the version in
   one of its capture groups; alternatives exist because providers reorder
   the tier word and the version over time (claude-3-opus → claude-opus-4). */
const FRONTIER_LINES = {
  google: {
    flagship: [
      { name:'Pro',    re:/^gemini[-.]?(?:(\d+(?:\.\d+)?)[-.]?pro\b|pro[-.]?(\d+(?:\.\d+)?)\b)/i },
      { name:'Ultra',  re:/^gemini[-.]?(?:(\d+(?:\.\d+)?)[-.]?ultra\b|ultra[-.]?(\d+(?:\.\d+)?)\b)/i },
    ],
    fallback: [
      { name:'Flash',  re:/^gemini[-.]?(?:(\d+(?:\.\d+)?)[-.]?flash\b|flash[-.]?(\d+(?:\.\d+)?)\b)/i },
    ],
  },
  openai: {
    // `gpt-<version>` covers gpt-4, gpt-4o, gpt-5, gpt-5.5-pro, gpt-6-astra.
    // The `o<n>` reasoning line is intentionally not flagship: o1-pro at
    // $150/1M is a specialty SKU, not OpenAI's general-purpose flagship.
    flagship: [
      { name:'GPT',    re:/^gpt[-.]?(\d+(?:\.\d+)?)/i },
    ],
    fallback: [],
    // Recognized but never frontier. Listing them keeps the drift signal
    // meaningful — without this the o-series fills `unclassified` on every
    // response and a genuinely new naming scheme would be lost in the noise.
    ignore: [
      { name:'O-series', re:/^o\d/i },
      { name:'ChatGPT',  re:/^chatgpt|^gpt-chat/i },
    ],
  },
  anthropic: {
    // Opus and Fable compete on version, not on line order — see step 3.
    flagship: [
      { name:'Opus',   re:/^claude[-.]?(?:opus[-.]?(\d+(?:\.\d+)?)\b|(\d+(?:\.\d+)?)[-.]?opus\b)/i },
      { name:'Fable',  re:/^claude[-.]?(?:fable[-.]?(\d+(?:\.\d+)?)\b|(\d+(?:\.\d+)?)[-.]?fable\b)/i },
    ],
    fallback: [
      { name:'Sonnet', re:/^claude[-.]?(?:sonnet[-.]?(\d+(?:\.\d+)?)\b|(\d+(?:\.\d+)?)[-.]?sonnet\b)/i },
    ],
  },
};

/** [major, minor] from a version string; null when unparseable. */
function versionKey(v) {
  if (typeof v !== 'string' || !v) return null;
  const m = v.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0];
}

function compareVersion(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

/** First non-empty capture group — the version, wherever the line put it. */
function matchLine(modelName, line) {
  const m = String(modelName).match(line.re);
  if (!m) return null;
  const raw = m.slice(1).find(g => g != null);
  const key = versionKey(raw);
  return key ? { line: line.name, version: raw, key } : null;
}

/* Turn an upstream slug into the label the table shows. Derived rather than
   looked up, so a model nobody has seen before still renders with a sensible
   name. "gpt-6-astra" → "GPT-6 Astra"; "claude-opus-4.8" → "Claude Opus 4.8";
   "gemini-3.1-pro-preview" → "Gemini 3.1 Pro Preview". */
const DISPLAY_UPPER = new Set(['gpt', 'ai', 'api', 'oss']);
function prettifyModelName(slug) {
  const parts = String(slug || '').split(/[-_]/).filter(Boolean);
  const words = parts.map(p => {
    const low = p.toLowerCase();
    if (DISPLAY_UPPER.has(low)) return low.toUpperCase();
    if (/^\d/.test(p)) return p;
    return p.charAt(0).toUpperCase() + p.slice(1);
  });
  // Providers write their generation attached to the family name — GPT-6,
  // not "GPT 6" — so re-attach a leading numeric token to the family word.
  if (words.length >= 2 && DISPLAY_UPPER.has(parts[0].toLowerCase()) && /^\d/.test(words[1])) {
    return [words[0] + '-' + words[1], ...words.slice(2)].join(' ');
  }
  return words.join(' ');
}

/**
 * Pick the frontier model for one period from that period's observations.
 *
 * @param entries [{ model, avgInput }] — standard-SKU rows seen in the period
 * @param rules   FRONTIER_LINES entry for the provider
 * @returns { display, model, line, version, matchedVariants, viaFallback } | null
 */
function pickFrontier(entries, rules) {
  if (!rules || !entries.length) return null;

  const consider = (lines) => {
    const hits = [];
    for (const e of entries) {
      if (FRONTIER_EXCLUDE.test(e.model)) continue;
      for (const line of lines) {
        const m = matchLine(e.model, line);
        if (m) { hits.push({ ...e, ...m }); break; }
      }
    }
    if (!hits.length) return null;

    // Highest version wins across every line, then priciest variant of it,
    // then the shortest name (the base model rather than a suffixed sibling).
    let best = null;
    for (const h of hits) {
      if (!best) { best = h; continue; }
      const c = compareVersion(h.key, best.key);
      if (c > 0) { best = h; continue; }
      if (c < 0) continue;
      const ap = typeof h.avgInput === 'number' ? h.avgInput : -1;
      const bp = typeof best.avgInput === 'number' ? best.avgInput : -1;
      if (ap > bp) { best = h; continue; }
      if (ap < bp) continue;
      if (h.model.length < best.model.length) best = h;
    }
    if (!best) return null;

    /* Group the winner with its own dated re-publishes only —
       gpt-4o + gpt-4o-2024-08-06, not the whole generation.

       Grouping by line+version instead looked reasonable and was badly
       wrong: every gen-5 GPT shares line=GPT and version=5, so the frontier
       price became an average of gpt-5, gpt-5-pro, gpt-5-mini AND
       gpt-5-nano — $0.68/1M for what the table called the frontier.
       modelMatches already encodes the right notion of "same model": it
       accepts date stamps and rejects tier and sibling-line suffixes. */
    const bestNorm = normalizeModel(best.model);
    const sameClass = hits
      .filter(h => modelMatches(h.model, bestNorm))
      .map(h => h.model);
    if (!sameClass.includes(best.model)) sameClass.push(best.model);
    return { best, sameClass };
  };

  const flagship = consider(rules.flagship || []);
  const chosen = flagship || consider(rules.fallback || []);
  if (!chosen) return null;

  return {
    display: prettifyModelName(chosen.best.model),
    model: chosen.best.model,
    line: chosen.best.line,
    version: chosen.best.version,
    matchedVariants: chosen.sameClass.slice().sort(),
    viaFallback: !flagship,
  };
}

const FRONTIER_REFERENCE_PROVIDERS = [
  { slug:'google',    label:'Google / Gemini' },
  { slug:'openai',    label:'OpenAI' },
  { slug:'anthropic', label:'Anthropic' },
];

/* External catalog (Firecrawl) — discovery / freshness only. Per provider:
   the docs URL we scrape, and a regex that pulls model names out of the
   markdown response. Each provider's regex anchors on the family token so
   we don't pick up unrelated text. The set of observed names is normalized
   the same way pricepertoken model strings are (lowercased, punctuation
   stripped) so drift comparison against providerCatalog is apples-to-apples. */
const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';
const FIRECRAWL_TIMEOUT_MS = 25000;
const EXTERNAL_PROVIDERS = [
  {
    slug:'anthropic', label:'Anthropic',
    url:'https://docs.anthropic.com/en/docs/about-claude/models/overview',
    // Examples: claude-opus-4.7, claude-sonnet-4.6, claude-3-5-sonnet, claude-3.5-haiku
    pattern:/claude[-\.][a-z0-9][a-z0-9\-\.]{1,40}/gi,
  },
  {
    slug:'openai', label:'OpenAI',
    url:'https://platform.openai.com/docs/models',
    // Examples: gpt-5, gpt-5-mini, gpt-5.5-pro, gpt-4o, o1, o3
    pattern:/gpt[-\.][a-z0-9][a-z0-9\-\.]{0,40}/gi,
  },
  {
    slug:'google', label:'Google / Gemini',
    url:'https://ai.google.dev/gemini-api/docs/models',
    // Examples: gemini-3-pro-preview, gemini-2.5-pro, gemini-3.1-flash-lite-preview
    pattern:/gemini[-\.][a-z0-9][a-z0-9\-\.]{1,50}/gi,
  },
];

/* Suffixes that mark a DIFFERENT product from the rep, not a dated variant
   of it. Anything whose post-prefix remainder starts with one of these is
   rejected from the rep's match set.

   Two families are in here:

     tier / modality markers — mini, lite, flash, haiku, nano, micro, and the
       non-text modalities (image, audio, video, embedding, tts, realtime).

     sibling product lines — pro, max, chat, codex, instruct, search,
       deepresearch, customtools, fast, thinking, latest, exp.

   The sibling-product-line half is what keeps `gpt-5-pro` ($15/1M) out of
   the `gpt-5` ($1.25/1M) row. Before this list existed the two were averaged
   together, and gpt-5-pro's arrival on 2025-10-07 showed up on the dashboard
   as a fabricated "+272.4% QoQ price increase" for GPT-5 in Dec-25 — GPT-5's
   list price never moved. `customtools` does the same job for
   gemini-3.1-pro-preview-customtools ($2.00) vs gemini-3.1-pro-preview
   ($1.69), and `fast` for claude-opus-4.x-fast ($30) vs claude-opus-4.x ($5).

   `exp` is here because Google's experimental SKUs (gemini-2.5-pro-exp-03-25)
   are priced at $0.00 and would drag any average they land in to zero. */
const VARIANT_REJECT_PREFIXES =
  /^(mini|lite|flash|haiku|nano|micro|image|audio|video|embedding|tts|realtime|pro|max|chat|codex|instruct|search|deepresearch|customtools|fast|thinking|latest|exp)/;
// Pure short-numeric suffixes mark a version bump, not a dated variant —
// e.g. "gpt5" target should match "gpt-5" and "gpt-5-2025-08-07" but NOT
// "gpt-5.1" or "gpt-5.5" (which are different model classes). After normalize
// the version-bump shows up as 1–3 digits followed by non-digit/end; date
// stamps show up as 4+ contiguous digits which fall through this rule.
const VERSION_BUMP_SUFFIX = /^\d{1,3}([^0-9]|$)/;

/* Alternate-BILLING SKUs. Upstream tags these with a colon suffix:
   ':batch' (~50% off async), ':beta', ':thinking', ':free', ':extended',
   ':exacto'. They are the same model sold on different terms, NOT a repricing
   of the standard SKU, so they must never enter a price average.

   This matters more than it sounds. pricepertoken began cataloguing ':batch'
   rows for every provider on 2026-07-29. Because the old matcher swept them
   in, each rep's Q3-26 average fell by roughly half a batch-weighting —
   producing a synchronized "price cut" of -18% to -21.8% across Google,
   OpenAI and Anthropic simultaneously, in the same quarter, which the
   read-through panel then reported as real competitive repricing. No
   provider cut list prices; the upstream catalog just grew a column. */
const ALT_BILLING_SKU = /:/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + CACHE_TTL + ', s-maxage=' + CACHE_TTL,
      ...CORS,
      ...extraHeaders,
    },
  });
}

function normalizeModel(s) {
  return String(s || '').toLowerCase().replace(/[-\s_.]+/g, '');
}

function modelMatches(modelStr, targetNorm) {
  // Alternate-billing SKUs are excluded before anything else, so every
  // consumer of the matcher (rep pricing, frontier reference) sees standard
  // list-price rows only.
  if (ALT_BILLING_SKU.test(String(modelStr || ''))) return false;
  const n = normalizeModel(modelStr);
  if (n === targetNorm) return true;
  if (!n.startsWith(targetNorm)) return false;
  const suffix = n.slice(targetNorm.length);
  if (VARIANT_REJECT_PREFIXES.test(suffix)) return false;
  if (VERSION_BUMP_SUFFIX.test(suffix)) return false;
  return true;
}

function quarterOf(dateStr) {
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(5, 7), 10);
  return y + '-Q' + (Math.floor((m - 1) / 3) + 1);
}

function priorQuarter(key) {
  const m = key.match(/^(\d{4})-Q(\d)$/);
  if (!m) return null;
  const y = +m[1], q = +m[2];
  return q === 1 ? (y - 1) + '-Q4' : y + '-Q' + (q - 1);
}

function yearAgoQuarter(key) {
  const m = key.match(/^(\d{4})-Q(\d)$/);
  if (!m) return null;
  return (+m[1] - 1) + '-Q' + m[2];
}

function quarterRange(key) {
  const m = key.match(/^(\d{4})-Q(\d)$/);
  const y = +m[1], q = +m[2];
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(y, startMonth, 1)).toISOString().slice(0, 10);
  const end   = new Date(Date.UTC(y, startMonth + 3, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function currentQuarterKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-Q' + (Math.floor(d.getUTCMonth() / 3) + 1);
}

// Monthly counterparts. Same key shape as the rest of the dashboard:
//   '2026-04', '2025-12', etc.  Calendar months, UTC.
function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

function priorMonth(key) {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2];
  if (mo === 1) return (y - 1) + '-12';
  return y + '-' + String(mo - 1).padStart(2, '0');
}

function yearAgoMonth(key) {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  return (+m[1] - 1) + '-' + m[2];
}

function monthRange(key) {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  const y = +m[1], mo = +m[2];
  const start = new Date(Date.UTC(y, mo - 1, 1)).toISOString().slice(0, 10);
  const end   = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function currentMonthKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function round3(n) { return Math.round(n * 1000) / 1000; }

/* Per-model history aggregation — used for the Google all-models view.
   Reads a provider fetch result and returns one entry per distinct upstream
   model name with quarterly + monthly input/output averages and QoQ/MoM/YoY
   change ratios. Matches the same scaling, partial-period suppression, and
   field-name conventions used by the rep-level math above so the client
   renderer can reuse its formatters. */
function buildPerModelHistory(providerData, todayQ, todayM) {
  if (!providerData || !Array.isArray(providerData.rows) || !providerData.rows.length) return [];

  const byModel = new Map();
  for (const row of providerData.rows) {
    if (typeof row?.model !== 'string') continue;
    if (typeof row?.date !== 'string' || row.date.length < 10) continue;
    const key = row.model;
    let entry = byModel.get(key);
    if (!entry) {
      entry = {
        model: row.model,
        norm: normalizeModel(row.model),
        firstDate: row.date,
        lastDate: row.date,
        obsCount: 0,
        qBuckets: new Map(),
        mBuckets: new Map(),
      };
      byModel.set(key, entry);
    }
    if (row.date < entry.firstDate) entry.firstDate = row.date;
    if (row.date > entry.lastDate)  entry.lastDate  = row.date;
    entry.obsCount += 1;

    const qid = quarterOf(row.date);
    const mid = monthOf(row.date);
    if (!entry.qBuckets.has(qid)) entry.qBuckets.set(qid, { sumIn:0, nIn:0, sumOut:0, nOut:0 });
    if (!entry.mBuckets.has(mid)) entry.mBuckets.set(mid, { sumIn:0, nIn:0, sumOut:0, nOut:0 });
    const qb = entry.qBuckets.get(qid);
    const mb = entry.mBuckets.get(mid);
    const inP  = row?.pricing_prompt;
    const outP = row?.pricing_completion;
    if (typeof inP  === 'number' && isFinite(inP)  && inP  >= 0) { qb.sumIn  += inP;  qb.nIn  += 1; mb.sumIn  += inP;  mb.nIn  += 1; }
    if (typeof outP === 'number' && isFinite(outP) && outP >= 0) { qb.sumOut += outP; qb.nOut += 1; mb.sumOut += outP; mb.nOut += 1; }
  }

  const out = [];
  for (const e of byModel.values()) {
    const input = {}, output = {};
    for (const [qid, b] of e.qBuckets) {
      input[qid]  = b.nIn  ? round3((b.sumIn  / b.nIn)  * 1_000_000) : null;
      output[qid] = b.nOut ? round3((b.sumOut / b.nOut) * 1_000_000) : null;
    }
    const inputMonthly = {}, outputMonthly = {};
    for (const [mid, b] of e.mBuckets) {
      inputMonthly[mid]  = b.nIn  ? round3((b.sumIn  / b.nIn)  * 1_000_000) : null;
      outputMonthly[mid] = b.nOut ? round3((b.sumOut / b.nOut) * 1_000_000) : null;
    }

    // Per-quarter QoQ/YoY (same partial-period suppression as the rep math)
    const qoqInput = {}, qoqOutput = {}, yoyInput = {}, yoyOutput = {};
    for (const qid of Object.keys(input)) {
      if (qid === todayQ) continue;
      const pq = priorQuarter(qid), yq = yearAgoQuarter(qid);
      const inCur = input[qid], outCur = output[qid];
      const inPri = input[pq],  outPri = output[pq];
      const inYa  = input[yq],  outYa  = output[yq];
      if (inCur  != null && inPri  != null && inPri  > 0) qoqInput[qid]  = round3((inCur  - inPri)  / inPri);
      if (inCur  != null && inYa   != null && inYa   > 0) yoyInput[qid]  = round3((inCur  - inYa)   / inYa);
      if (outCur != null && outPri != null && outPri > 0) qoqOutput[qid] = round3((outCur - outPri) / outPri);
      if (outCur != null && outYa  != null && outYa  > 0) yoyOutput[qid] = round3((outCur - outYa)  / outYa);
    }

    const momInput = {}, momOutput = {}, yoyInputMonthly = {}, yoyOutputMonthly = {};
    for (const mid of Object.keys(inputMonthly)) {
      if (mid === todayM) continue;
      const pm = priorMonth(mid), ym = yearAgoMonth(mid);
      const inCur = inputMonthly[mid], outCur = outputMonthly[mid];
      const inPri = inputMonthly[pm],  outPri = outputMonthly[pm];
      const inYa  = inputMonthly[ym], outYa  = outputMonthly[ym];
      if (inCur  != null && inPri  != null && inPri  > 0) momInput[mid]         = round3((inCur  - inPri)  / inPri);
      if (inCur  != null && inYa   != null && inYa   > 0) yoyInputMonthly[mid]  = round3((inCur  - inYa)   / inYa);
      if (outCur != null && outPri != null && outPri > 0) momOutput[mid]        = round3((outCur - outPri) / outPri);
      if (outCur != null && outYa  != null && outYa  > 0) yoyOutputMonthly[mid] = round3((outCur - outYa)  / outYa);
    }

    out.push({
      model: e.model,
      norm: e.norm,
      firstDate: e.firstDate.slice(0, 10),
      lastDate: e.lastDate.slice(0, 10),
      obsCount: e.obsCount,
      input, output,
      inputMonthly, outputMonthly,
      qoqInput, qoqOutput,
      momInput, momOutput,
      yoyInput, yoyOutput,
      yoyInputMonthly, yoyOutputMonthly,
    });
  }

  // Newest model first (by lastDate desc, tie-break firstDate desc)
  out.sort((a, b) => {
    if (a.lastDate !== b.lastDate)   return a.lastDate < b.lastDate ? 1 : -1;
    if (a.firstDate !== b.firstDate) return a.firstDate < b.firstDate ? 1 : -1;
    return a.model < b.model ? -1 : 1;
  });
  return out;
}

async function fetchProvider(slug) {
  const url = UPSTREAM_BASE + '?provider=' + encodeURIComponent(slug);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'gdash-model-pricing-peer/1.0',
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

/* Firecrawl markdown scrape. The API key is read ONLY from env — never logged,
   never returned, never embedded in the response. If the key is missing this
   helper returns null synchronously so callers can degrade to enabled=false
   without making any network call. */
async function fetchFirecrawlMarkdown(env, url) {
  const key = env?.FIRECRAWL_API_KEY;
  if (!key) return { ok: false, error: 'no-key' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FIRECRAWL_TIMEOUT_MS);
  try {
    const resp = await fetch(FIRECRAWL_BASE + '/scrape', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const j = await resp.json();
    const md = j?.data?.markdown || j?.markdown || '';
    if (!md) return { ok: false, error: 'no markdown in response' };
    return { ok: true, markdown: md };
  } catch (e) {
    return { ok: false, error: (e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch failed')) };
  } finally {
    clearTimeout(t);
  }
}

/* Extract model names from scraped markdown using the provider's regex,
   then normalize and dedupe. Returns the unique model strings as they
   appear in the source (cleaned of trailing punctuation), so the operator
   can audit visually, plus their normalized form for drift comparison. */
function extractModels(markdown, pattern) {
  if (!markdown) return [];
  const matches = markdown.match(pattern) || [];
  const seen = new Map();
  for (const raw of matches) {
    let cleaned = raw.toLowerCase();
    // Strip trailing image/asset extensions that the regex catches when a
    // model name appears inside a markdown image filename (e.g.
    // "gpt-image-2.png", "gpt-4o-mini-tts.png").
    cleaned = cleaned.replace(/\.(png|jpe?g|gif|svg|webp)$/i, '');
    // Strip trailing punctuation that might cling from sentence context
    cleaned = cleaned.replace(/[\.\,\)\]\:\;]+$/, '');
    if (!/\d/.test(cleaned)) continue;
    if (cleaned.length < 5 || cleaned.length > 60) continue;
    const norm = normalizeModel(cleaned);
    if (!seen.has(norm)) seen.set(norm, cleaned);
  }
  return Array.from(seen, ([norm, model]) => ({ model, norm })).sort((a, b) => a.model < b.model ? -1 : 1);
}

/* Build the externalCatalog block. Returns a fully-shaped object whether or
   not Firecrawl is enabled. Pricing math is independent — this can fail
   completely without affecting the rest of the response. Providers are
   keyed by slug (object form, per spec) for easy per-provider lookup. */
async function buildExternalCatalog(env, providerCatalog) {
  if (!env?.FIRECRAWL_API_KEY) {
    return {
      source: 'firecrawl',
      enabled: false,
      reason: 'FIRECRAWL_API_KEY not configured',
      providers: {},
      notes: [],
    };
  }

  const ppByProvider = new Map(
    (providerCatalog || []).map(pc => [
      pc.providerSlug,
      new Set((pc.models || []).map(m => normalizeModel(m.model))),
    ])
  );

  const providers = {};
  const notes = [];
  let anyOk = false;

  await Promise.all(
    EXTERNAL_PROVIDERS.map(async p => {
      const r = await fetchFirecrawlMarkdown(env, p.url);
      if (!r.ok) {
        providers[p.slug] = {
          providerLabel: p.label,
          scrapedUrl: p.url,
          ok: false,
          error: r.error,
          observedModels: [],
          possibleNewerModels: [],
        };
        notes.push(p.label + ' scrape failed: ' + r.error);
        return;
      }
      anyOk = true;
      const observed = extractModels(r.markdown, p.pattern);
      const ppNorms = ppByProvider.get(p.slug) || new Set();
      const possibleNewerModels = observed
        .filter(o => !ppNorms.has(o.norm))
        .map(o => o.model);

      providers[p.slug] = {
        providerLabel: p.label,
        scrapedUrl: p.url,
        ok: true,
        observedModels: observed.map(o => o.model),
        possibleNewerModels,
      };
    })
  );

  return {
    source: 'firecrawl',
    enabled: true,
    generatedAt: new Date().toISOString(),
    allowlist: EXTERNAL_PROVIDERS.map(p => ({ slug: p.slug, url: p.url })),
    providers,
    notes,
    // Honest signal flag: when ALL Firecrawl calls failed, surface that the
    // audit was attempted but unusable. Endpoint still returns success:true
    // because pricepertoken pricing math is independent.
    degraded: !anyOk,
  };
}

/* Per-rep freshness computation. Status hierarchy (most actionable first):
     STALE  — pricepertoken catalog has a non-version-bump newer same-provider
              model with ≥60 obs (about 2 months daily). Operator can rotate
              the fixed rep with confidence — full QoQ history would carry over.
     REVIEW — pricepertoken sees a newer model but with limited obs (<60).
              Operator should evaluate; rotation might fragment QoQ.
     WATCH  — Firecrawl saw a model on the official docs page that
              pricepertoken hasn't cataloged at all yet. Pricepertoken needs
              to ingest before action is possible.
     OK     — no actionable signal.
   The reason field always cites both sources separately so the operator
   can see what evidence drove the status. */
const REP_FRESHNESS_PP_STABLE_OBS = 60;
function computeRepFreshness(rep, providerData, externalCatalog) {
  const ppRows = providerData?.rows || [];
  const repNorms = rep.chosenCandidateNorms || [];
  const repFirstDate = rep.matchedModels?.length
    ? ppRows.filter(r => rep.matchedModels.includes(r.model))
        .map(r => r.date)
        .sort()[0] || null
    : null;

  // pricepertoken evidence: same-provider models in catalog that
  //   - aren't already part of this rep's matched set (so version-bump
  //     successors of the rep's own candidate are excluded — they're the
  //     same model class, intentionally),
  //   - have firstDate strictly later than the rep's own firstDate,
  //   - have ≥REP_FRESHNESS_PP_STABLE_OBS observations.
  // Aggregate per distinct upstream model name.
  const repModelSet = new Set(rep.matchedModels || []);
  // A candidate model that is a version-bump sibling of any rep norm
  // (e.g. claude-opus-4.7 vs rep claude-opus-4) or a tier sibling
  // (e.g. gpt-5-mini vs rep gpt-5) is the SAME class for fixed-rep
  // purposes — the matcher already rejects these so they aren't part
  // of repModelSet. Without this guard the freshness check treats every
  // version bump as a "newer model class" and floods every rep with
  // STALE noise — exactly the lineup-churn signal the customer wanted
  // the fixed-rep design to suppress in the first place.
  const isVersionOrTierSibling = (candNorm) =>
    repNorms.some(rn => {
      if (candNorm === rn) return false;
      if (!candNorm.startsWith(rn)) return false;
      const suffix = candNorm.slice(rn.length);
      return VARIANT_REJECT_PREFIXES.test(suffix) || VERSION_BUMP_SUFFIX.test(suffix);
    });
  const ppByModel = new Map();
  for (const row of ppRows) {
    if (typeof row?.model !== 'string') continue;
    if (repModelSet.has(row.model)) continue;
    if (isVersionOrTierSibling(normalizeModel(row.model))) continue;
    if (typeof row?.date !== 'string') continue;
    const e = ppByModel.get(row.model) || { model: row.model, firstDate: row.date, obs: 0 };
    if (row.date < e.firstDate) e.firstDate = row.date;
    e.obs += 1;
    ppByModel.set(row.model, e);
  }
  const ppNewerStable = [];
  const ppNewerLimited = [];
  for (const e of ppByModel.values()) {
    if (!repFirstDate || e.firstDate > repFirstDate) {
      // Reject obvious version-bump siblings using the same matcher rules.
      // If repNorms contains a target the candidate matches, it'd already
      // be inside repModelSet — so anything reaching here is a genuinely
      // different class (different prefix or version-bumped).
      if (e.obs >= REP_FRESHNESS_PP_STABLE_OBS) ppNewerStable.push(e);
      else ppNewerLimited.push(e);
    }
  }

  // Firecrawl evidence: provider's possibleNewerModels (already filtered
  // to "Firecrawl observed but pricepertoken doesn't have").
  const fcProvider = externalCatalog?.providers?.[rep.providerSlug] || null;
  const firecrawlEnabled = !!externalCatalog?.enabled;
  const firecrawlPossibleNewer = fcProvider?.possibleNewerModels || [];

  // Decide status. Only Firecrawl evidence escalates status today —
  // pp-evidence stays visible in ppEvidence for transparency but doesn't
  // claim STALE/REVIEW because detecting "genuinely newer model class"
  // (vs version bump, peer tier, specialty mode like audio/image/codex)
  // requires per-provider class parsing that's out of scope here.
  // Bias is conservative on purpose: better to under-flag than to push
  // the operator to rotate a rep on a noisy heuristic, which would defeat
  // the whole point of having stable peer reps for QoQ continuity.
  let status = 'OK';
  const reasonParts = [];

  if (ppNewerStable.length || ppNewerLimited.length) {
    const top = [...ppNewerStable, ...ppNewerLimited].sort((a, b) => b.obs - a.obs).slice(0, 2);
    reasonParts.push(
      'pricepertoken: same-provider newer-launched models in catalog — ' +
      top.map(t => t.model + ' (' + t.obs + ' obs)').join(', ') +
      '. Operator review only; status escalation requires per-provider class parsing not yet implemented.'
    );
  } else {
    reasonParts.push('pricepertoken: no newer-launched same-provider models.');
  }

  if (firecrawlEnabled && firecrawlPossibleNewer.length) {
    status = 'WATCH';
    reasonParts.push(
      'Firecrawl/' + (fcProvider?.providerLabel || rep.provider) +
      ' docs: ' + firecrawlPossibleNewer.slice(0, 3).join(', ') +
      (firecrawlPossibleNewer.length > 3 ? ' (+' + (firecrawlPossibleNewer.length - 3) + ' more)' : '') +
      ' present on official page but not in pricepertoken catalog yet.'
    );
  } else if (!firecrawlEnabled) {
    reasonParts.push('Firecrawl: disabled (' + (externalCatalog?.reason || 'no env key') + ').');
  } else {
    reasonParts.push('Firecrawl: official docs lineup matches pricepertoken catalog.');
  }

  return {
    status,
    reason: reasonParts.join(' '),
    ppEvidence: {
      newerStable: ppNewerStable.map(e => ({ model: e.model, obs: e.obs, firstDate: e.firstDate.slice(0, 10) })),
      newerLimited: ppNewerLimited.map(e => ({ model: e.model, obs: e.obs, firstDate: e.firstDate.slice(0, 10) })),
    },
    firecrawlEvidence: {
      enabled: firecrawlEnabled,
      possibleNewerModels: firecrawlPossibleNewer.slice(0, 10),
    },
  };
}

export async function onRequestGet({ request, env }) {
  // Fetch each unique provider once even if multiple reps share it
  const providerSlugs = Array.from(new Set(PEER_MODELS.map(r => r.providerSlug)));
  const fetched = await Promise.all(providerSlugs.map(s => fetchProvider(s)));
  const byProvider = new Map(fetched.map(f => [f.slug, f]));

  if (![...byProvider.values()].some(f => f.rows.length)) {
    return jsonResp({
      success: false,
      error: 'Upstream returned no rows for any provider',
      providerErrors: fetched.map(f => ({ slug: f.slug, error: f.error })),
    }, 502, { 'Cache-Control': 'no-store' });
  }

  const allQuarters = new Set();
  const allMonths = new Set();
  let earliestDate = null;

  // For each rep model, walk its candidate list and pick the FIRST candidate
  // with at least one matching upstream row. Each candidate may declare a
  // SET of norms (`norms: [...]`) — when a flagship transitions across
  // closely-related sub-versions (e.g. Gemini 3 Pro → 3.1 Pro), all matching
  // rows from the set are aggregated into one continuous series.
  // Buckets are accumulated at BOTH quarter and month granularity so the
  // client can render either view without a second round-trip.
  const reps = PEER_MODELS.map(rep => {
    const provider = byProvider.get(rep.providerSlug);
    let chosen = null;
    let matched = [];
    for (const cand of rep.candidates) {
      const norms = Array.isArray(cand.norms) ? cand.norms : [cand.norm];
      const hits = (provider?.rows || []).filter(row =>
        typeof row?.model === 'string' && norms.some(n => modelMatches(row.model, n))
      );
      if (hits.length > 0) {
        chosen = cand;
        matched = hits;
        break;
      }
    }

    const matchedModelSet = new Set();
    const buckets = new Map();
    const monthBuckets = new Map();
    for (const row of matched) {
      const dateStr = row?.date;
      if (typeof dateStr !== 'string' || dateStr.length < 10) continue;
      if (!earliestDate || dateStr < earliestDate) earliestDate = dateStr;
      const qid = quarterOf(dateStr);
      const mid = monthOf(dateStr);
      allQuarters.add(qid);
      allMonths.add(mid);
      if (!buckets.has(qid)) buckets.set(qid, { sumIn: 0, nIn: 0, sumOut: 0, nOut: 0 });
      if (!monthBuckets.has(mid)) monthBuckets.set(mid, { sumIn: 0, nIn: 0, sumOut: 0, nOut: 0 });
      const b = buckets.get(qid);
      const mb = monthBuckets.get(mid);
      const inP  = row?.pricing_prompt;
      const outP = row?.pricing_completion;
      // Strictly > 0: a $0.00 observation on a paid model class is a free /
      // experimental SKU that upstream files under the same family (Google's
      // gemini-2.5-pro-exp-* rows are $0.00). Averaging those in drags the
      // rep's price toward zero and reads as a price cut that never happened.
      // buildPerModelHistory below keeps >= 0 on purpose — there each model is
      // its own row, so a genuinely free model should show as free.
      if (typeof inP  === 'number' && isFinite(inP)  && inP  > 0) { b.sumIn  += inP;  b.nIn  += 1; mb.sumIn  += inP;  mb.nIn  += 1; }
      if (typeof outP === 'number' && isFinite(outP) && outP > 0) { b.sumOut += outP; b.nOut += 1; mb.sumOut += outP; mb.nOut += 1; }
      if (row.model) matchedModelSet.add(row.model);
    }

    const input = {}, output = {}, obsCount = {};
    for (const [qid, b] of buckets) {
      // Upstream is $/token; scale to $/1M for display parity with the rest
      // of the dashboard's pricing surfaces.
      input[qid]  = b.nIn  ? round3((b.sumIn  / b.nIn)  * 1_000_000) : null;
      output[qid] = b.nOut ? round3((b.sumOut / b.nOut) * 1_000_000) : null;
      obsCount[qid] = b.nIn || b.nOut;
    }

    const inputMonthly = {}, outputMonthly = {}, monthObsCount = {};
    for (const [mid, mb] of monthBuckets) {
      inputMonthly[mid]  = mb.nIn  ? round3((mb.sumIn  / mb.nIn)  * 1_000_000) : null;
      outputMonthly[mid] = mb.nOut ? round3((mb.sumOut / mb.nOut) * 1_000_000) : null;
      monthObsCount[mid] = mb.nIn || mb.nOut;
    }

    return {
      key: rep.key,
      provider: rep.provider,
      providerSlug: rep.providerSlug,
      tier: rep.tier,
      label: rep.label,
      modelDisplay: chosen?.display || rep.candidates[0]?.display || null,
      chosenCandidateNorms: chosen ? (chosen.norms || [chosen.norm]) : null,
      hasData: chosen !== null,
      input,
      output,
      obsCount,
      // Monthly counterparts — same shape, keyed by 'YYYY-MM'. Quarter
      // semantics still drive the default Model Pricing matrix view; these
      // fields exist so consumers (e.g. Google subset table) can render a
      // monthly cut without a second fetch.
      inputMonthly,
      outputMonthly,
      monthObsCount,
      matchedModels: Array.from(matchedModelSet).sort(),
      _buckets: buckets,
    };
  });

  const todayQ = currentQuarterKey();
  const todayM = currentMonthKey();

  // Compute QoQ / YoY for input + output. Suppress for the QTD quarter so
  // partial-quarter averages don't get compared against full quarters.
  // Same logic mirrored at month granularity into momInput/momOutput/
  // yoyInputMonthly/yoyOutputMonthly so consumers can pick the granularity
  // they want without a second round-trip.
  for (const rep of reps) {
    rep.qoqInput = {};
    rep.qoqOutput = {};
    rep.yoyInput = {};
    rep.yoyOutput = {};
    for (const qid of Object.keys(rep.input)) {
      if (qid === todayQ) continue;
      const pq = priorQuarter(qid);
      const yq = yearAgoQuarter(qid);
      const inCur = rep.input[qid],  outCur = rep.output[qid];
      const inPri = rep.input[pq],   outPri = rep.output[pq];
      const inYa  = rep.input[yq],   outYa  = rep.output[yq];
      if (inCur  != null && inPri  != null && inPri  > 0) rep.qoqInput[qid]  = round3((inCur  - inPri)  / inPri);
      if (inCur  != null && inYa   != null && inYa   > 0) rep.yoyInput[qid]  = round3((inCur  - inYa)   / inYa);
      if (outCur != null && outPri != null && outPri > 0) rep.qoqOutput[qid] = round3((outCur - outPri) / outPri);
      if (outCur != null && outYa  != null && outYa  > 0) rep.yoyOutput[qid] = round3((outCur - outYa)  / outYa);
    }

    rep.momInput = {};
    rep.momOutput = {};
    rep.yoyInputMonthly = {};
    rep.yoyOutputMonthly = {};
    for (const mid of Object.keys(rep.inputMonthly)) {
      if (mid === todayM) continue; // suppress MTD vs full-month comparisons
      const pm = priorMonth(mid);
      const ym = yearAgoMonth(mid);
      const inCur = rep.inputMonthly[mid],  outCur = rep.outputMonthly[mid];
      const inPri = rep.inputMonthly[pm],   outPri = rep.outputMonthly[pm];
      const inYa  = rep.inputMonthly[ym],   outYa  = rep.outputMonthly[ym];
      if (inCur  != null && inPri  != null && inPri  > 0) rep.momInput[mid]         = round3((inCur  - inPri)  / inPri);
      if (inCur  != null && inYa   != null && inYa   > 0) rep.yoyInputMonthly[mid]  = round3((inCur  - inYa)   / inYa);
      if (outCur != null && outPri != null && outPri > 0) rep.momOutput[mid]        = round3((outCur - outPri) / outPri);
      if (outCur != null && outYa  != null && outYa  > 0) rep.yoyOutputMonthly[mid] = round3((outCur - outYa)  / outYa);
    }
    delete rep._buckets;
  }

  // Quarters chronological so the renderer reads left → right
  const quarters = Array.from(allQuarters).sort().map(qid => {
    const range = quarterRange(qid);
    return { id: qid, start: range.start, end: range.end, partial: qid === todayQ };
  });

  // Months chronological — same convention as quarters; partial flag flipped
  // for the current calendar month so the renderer can label it MTD.
  const months = Array.from(allMonths).sort().map(mid => {
    const range = monthRange(mid);
    return { id: mid, start: range.start, end: range.end, partial: mid === todayM };
  });

  /* Frontier Reference by Period — which model was each provider's frontier
     in each period, and what it cost there.

     Two things are emitted per provider:

       cells / cellsMonthly    — the frontier LABEL per quarter / per month.
       input,  output          — that frontier model's average price in that
       inputMonthly, ...         period, in $/1M tokens.

     The label half answers the customer's "the frontier today is not the same
     model as 12 quarters ago" point. The priced half answers the follow-on
     question — what it costs to stay at the frontier — which the label-only
     table could not.

     Read the change rows on this series carefully: because the underlying
     model CHANGES between periods, a move here is the cost of the frontier
     moving, not a provider repricing one model. That is a different (and
     deliberately separate) measure from the fixed-rep matrix above, which is
     the one to read for same-model repricing. The UI labels both. */
  function buildFrontierSeries(provider, rules, periodOf, currentPeriodKey, priorPeriodFn, yearAgoPeriodFn) {
    // period -> model -> price accumulator
    const byPeriod = new Map();
    for (const row of provider?.rows || []) {
      if (typeof row?.date !== 'string' || row.date.length < 10) continue;
      if (typeof row?.model !== 'string') continue;
      const pid = periodOf(row.date);
      if (!byPeriod.has(pid)) byPeriod.set(pid, new Map());
      const models = byPeriod.get(pid);
      // Alternate-billing rows never represent the frontier — same exclusion
      // the rep math applies, for the same reason.
      if (ALT_BILLING_SKU.test(row.model)) continue;
      const acc = models.get(row.model) || { sumIn: 0, nIn: 0, sumOut: 0, nOut: 0 };
      const inP = row?.pricing_prompt, outP = row?.pricing_completion;
      if (typeof inP  === 'number' && isFinite(inP)  && inP  > 0) { acc.sumIn  += inP;  acc.nIn  += 1; }
      if (typeof outP === 'number' && isFinite(outP) && outP > 0) { acc.sumOut += outP; acc.nOut += 1; }
      models.set(row.model, acc);
    }

    const cells = {}, input = {}, output = {};
    for (const [pid, models] of byPeriod) {
      // Feed the picker each model observed in THIS period with its own
      // average input price, so "priciest variant of the winning generation"
      // is decided on what the period actually charged.
      const entries = Array.from(models.entries()).map(([model, acc]) => ({
        model,
        avgInput: acc.nIn ? (acc.sumIn / acc.nIn) * 1_000_000 : null,
      }));
      const picked = pickFrontier(entries, rules);
      if (!picked) { cells[pid] = null; continue; }
      cells[pid] = {
        display: picked.display,
        model: picked.model,
        line: picked.line,
        version: picked.version,
        viaFallback: picked.viaFallback,
        matchedVariants: picked.matchedVariants,
      };
      // Price the frontier across every variant of the winning model class
      // in this period (dated re-publishes of the same model).
      let sumIn = 0, nIn = 0, sumOut = 0, nOut = 0;
      for (const m of picked.matchedVariants) {
        const acc = models.get(m);
        if (!acc) continue;
        sumIn += acc.sumIn; nIn += acc.nIn; sumOut += acc.sumOut; nOut += acc.nOut;
      }
      input[pid]  = nIn  ? round3((sumIn  / nIn)  * 1_000_000) : null;
      output[pid] = nOut ? round3((sumOut / nOut) * 1_000_000) : null;
    }

    // Period-over-period and year-over-year on the frontier cost series.
    // Suppressed for the in-progress period, same rule as the rep matrix.
    const chgInput = {}, chgOutput = {}, yoyInput = {}, yoyOutput = {};
    for (const pid of Object.keys(input)) {
      if (pid === currentPeriodKey) continue;
      const pp = priorPeriodFn(pid), yp = yearAgoPeriodFn(pid);
      const inCur = input[pid],  outCur = output[pid];
      const inPri = input[pp],   outPri = output[pp];
      const inYa  = input[yp],   outYa  = output[yp];
      if (inCur  != null && inPri  != null && inPri  > 0) chgInput[pid]  = round3((inCur  - inPri)  / inPri);
      if (outCur != null && outPri != null && outPri > 0) chgOutput[pid] = round3((outCur - outPri) / outPri);
      if (inCur  != null && inYa   != null && inYa   > 0) yoyInput[pid]  = round3((inCur  - inYa)   / inYa);
      if (outCur != null && outYa  != null && outYa  > 0) yoyOutput[pid] = round3((outCur - outYa)  / outYa);
    }
    return { cells, input, output, chgInput, chgOutput, yoyInput, yoyOutput };
  }

  const frontierReference = FRONTIER_REFERENCE_PROVIDERS.map(prov => {
    const provider = byProvider.get(prov.slug);
    const rules = FRONTIER_LINES[prov.slug] || null;
    const q = buildFrontierSeries(provider, rules, quarterOf, todayQ, priorQuarter, yearAgoQuarter);
    const m = buildFrontierSeries(provider, rules, monthOf,   todayM, priorMonth,   yearAgoMonth);

    /* Drift signal. Models the parser could not place on any line — not
       specialty SKUs, not alternate billing, just names whose shape this
       grammar does not recognize. Empty is the healthy state. A provider
       adopting a new naming scheme shows up here first, BEFORE it can
       quietly hold the frontier back to an older model, which is the
       failure mode the hand-maintained priority list had. */
    // Versioned lines are matched through matchLine (they must yield a
    // parseable version). `ignore` lines are plain shape tests — they exist
    // only to say "this name is recognized", so they carry no version group
    // and must not go through matchLine, which returns null without one.
    const versionedLines = [...(rules?.flagship || []), ...(rules?.fallback || [])];
    const ignoreLines = rules?.ignore || [];
    const unclassified = [];
    const seen = new Set();
    for (const row of provider?.rows || []) {
      if (typeof row?.model !== 'string') continue;
      if (seen.has(row.model)) continue;
      seen.add(row.model);
      if (ALT_BILLING_SKU.test(row.model)) continue;
      if (FRONTIER_EXCLUDE.test(row.model)) continue;
      if (ignoreLines.some(line => line.re.test(row.model))) continue;
      if (versionedLines.some(line => matchLine(row.model, line))) continue;
      unclassified.push(row.model);
    }

    // Newest period first — that's the one whose correctness matters most.
    const latestQ = Object.keys(q.cells).sort().pop();
    const latestM = Object.keys(m.cells).sort().pop();

    return {
      providerSlug: prov.slug,
      providerLabel: prov.label,
      // What this provider's frontier resolves to right now, and how.
      currentFrontier: (latestM && m.cells[latestM]) || (latestQ && q.cells[latestQ]) || null,
      unclassifiedModels: unclassified.sort(),
      // Quarterly (default view)
      cells: q.cells,
      input: q.input,
      output: q.output,
      chgInput: q.chgInput,
      chgOutput: q.chgOutput,
      yoyInput: q.yoyInput,
      yoyOutput: q.yoyOutput,
      // Monthly counterparts — same shape, keyed 'YYYY-MM', so the client's
      // granularity toggle needs no second round-trip.
      cellsMonthly: m.cells,
      inputMonthly: m.input,
      outputMonthly: m.output,
      momInput: m.chgInput,
      momOutput: m.chgOutput,
      yoyInputMonthly: m.yoyInput,
      yoyOutputMonthly: m.yoyOutput,
    };
  });

  const providerErrors = fetched.filter(f => f.error).map(f => ({ slug: f.slug, error: f.error }));

  // Provider catalog — per-provider list of distinct model names actually
  // observed in the upstream window, with first/last date and obs count.
  // Surfaces which model classes are real so peer/legacy/frontier picks can
  // be audited (e.g. "is Claude 4.7 in the upstream yet?").
  const providerCatalog = fetched.map(f => {
    const m = new Map();
    for (const row of f.rows || []) {
      if (typeof row?.model !== 'string') continue;
      if (typeof row?.date !== 'string' || row.date.length < 10) continue;
      const e = m.get(row.model) || { model: row.model, firstDate: row.date, lastDate: row.date, obsCount: 0 };
      if (row.date < e.firstDate) e.firstDate = row.date;
      if (row.date > e.lastDate)  e.lastDate  = row.date;
      e.obsCount += 1;
      m.set(row.model, e);
    }
    const models = Array.from(m.values()).sort((a, b) =>
      a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0
    );
    return { providerSlug: f.slug, modelCount: models.length, models };
  });

  // Google all-models history — for the Google Cloud / Model API Usage tab.
  // Same upstream rows the rep math reads, but bucketed per *individual* model
  // (no peer-pair filtering) so the Google-focused tab can show every model
  // Google has shipped in the upstream window. Quarter + month granularity
  // emitted in parallel so the client picks the view via toggle without a
  // second round-trip. Models are tier-classified on the client (Pro / Flash /
  // Flash-Lite / Specialty) — we leave the raw norm + display name here and
  // let the renderer decide how to group, so the classifier stays close to
  // the visual logic.
  const googleProvider = byProvider.get('google');
  const googleModels = buildPerModelHistory(googleProvider, todayQ, todayM);

  // External catalog is OPTIONAL — used only for discovery/freshness drift.
  // Pricing math (avg, QoQ, YoY) above is fully sourced from pricepertoken
  // and independent of this block. If FIRECRAWL_API_KEY is missing or the
  // scrape fails, we return enabled=false and the rest of the response is
  // unaffected. Reps are NOT auto-promoted from these observations — that's
  // a deliberate human decision; this block just surfaces drift signals.
  const externalCatalog = await buildExternalCatalog(env, providerCatalog);

  // Per-rep freshness audit. Combines two evidence sources without ever
  // letting Firecrawl drive pricing math or auto-rotate reps:
  //   pricepertoken evidence — does the upstream catalog already have a
  //     newer model class with substantial obs (>=60 days ≈ 2 months)?
  //     "Newer" excludes pure version-bump siblings of the rep's own
  //     candidate norms (so claudeopus4.7 doesn't trigger STALE for the
  //     claudeopus4 rep — same model class, just incremented).
  //   Firecrawl evidence — does the official-docs scrape mention model
  //     names that pricepertoken hasn't cataloged at all (= newer launch
  //     not yet ingested by pricepertoken)?
  // Status priority: STALE > REVIEW > WATCH > OK.
  for (const rep of reps) {
    rep.repFreshness = computeRepFreshness(rep, byProvider.get(rep.providerSlug), externalCatalog);
  }

  return jsonResp({
    success: true,
    source: UPSTREAM_BASE,
    sourceNote:
      'Per-model arithmetic mean of daily pricepertoken.com observations within each ' +
      'calendar quarter, filtered to a fixed peer-pair set so QoQ math reflects real ' +
      'provider repricing on the same model. No synthetic backfill — pre-upstream ' +
      'quarters simply do not appear. Frontier Reference is a separate informational ' +
      'projection — it picks the highest-tier-available model per (provider, quarter) ' +
      'and is intentionally not used for the main QoQ/YoY math — it is priced separately ' +
      'so the cost of staying at the frontier is visible, but because the underlying model ' +
      'changes between periods its change rows measure frontier movement, not repricing. ' +
      'Alternate-billing SKUs (:batch, :beta, :thinking, :free, :extended, :exacto) and ' +
      'sibling product lines (gpt-5-pro vs gpt-5, *-customtools, *-fast) are excluded from ' +
      'every price average, as are $0.00 experimental rows — each of these would otherwise ' +
      'register as a price move when only the upstream catalog changed. externalCatalog (when ' +
      'enabled) is a Firecrawl-discovered list of models the provider currently ' +
      'documents, used purely as a freshness audit signal — pricing math never reads it.',
    earliestDateObserved: earliestDate ? earliestDate.slice(0, 10) : null,
    // Coverage — lets the client explain an empty change section instead of
    // rendering a wall of dashes with no reason given. Upstream history
    // starts 2025-07-28, so no QUARTER yet has a year-ago comparator (the
    // only candidate, 2026-Q3, is the in-progress quarter and is suppressed)
    // while MONTHLY YoY is already computable from 2026-07 onward. That gap
    // is exactly why the matrix offers a month/quarter granularity toggle.
    coverage: {
      quarterCount: quarters.length,
      monthCount: months.length,
      quarterlyYoYAvailable: reps.some(r => Object.keys(r.yoyInput || {}).length > 0
                                         || Object.keys(r.yoyOutput || {}).length > 0),
      monthlyYoYAvailable:   reps.some(r => Object.keys(r.yoyInputMonthly || {}).length > 0
                                         || Object.keys(r.yoyOutputMonthly || {}).length > 0),
    },
    quarters,
    months,
    reps,
    frontierReference,
    providerCatalog,
    googleModels,
    externalCatalog,
    providerErrors,
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
