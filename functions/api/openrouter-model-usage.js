/**
 * Cloudflare Pages Function — accumulated per-model OpenRouter usage.
 * Route: /api/openrouter-model-usage
 *
 * WHY THIS EXISTS
 * The weekly chart the dashboard has always used names only OpenRouter's top
 * ~9 models per week and rolls everything else into "Others". That is why
 * usage-weighted pricing could only ever cover 2–16% of OpenAI's volume, and
 * why most cells in that view are withheld: not because the weighting is
 * wrong, but because the weights describe a ninth of the market.
 *
 * OpenRouter's rankings API serves the full picture — ~500 models, with prompt
 * and completion tokens counted separately. Its one limitation is that it is a
 * ROLLING WINDOW, not a history: `view=week` returns the trailing seven days
 * and nothing older. Fetching it once tells you about now; fetching it every
 * week builds the history that does not otherwise exist.
 *
 * So this endpoint accumulates. Each qualifying capture is written to KV under
 * the ISO week it represents, and the accumulated set is served back as a
 * weekly series in the same shape as /api/openrouter-chart-weekly?full=1, so
 * the weighting layer can consume either without special-casing.
 *
 * WHICH CAPTURES QUALIFY, AND WHY THE DAY MATTERS
 * `view=week` is a trailing seven days from the moment you ask. Taken on a
 * Wednesday it spans Wed–Tue, which straddles two ISO weeks and matches
 * neither. Attributing that to a Monday-start week would silently misplace
 * several days of volume — the same class of error as splitting a partial week
 * across days that have not happened.
 *
 * A capture is therefore only stored as week W when it is taken on the Monday
 * or Tuesday after W ends, where the trailing seven days and W coincide (or
 * miss by one day). Captures on any other weekday are still reported for
 * freshness but are NOT stored as a week and never reach the weighting. The
 * daily capture schedule guarantees a qualifying capture every Monday.
 *
 * Verified against live data on 2026-09-16: the trailing-week total is 0.98x
 * the last complete market-share week, so the two sources describe the same
 * span and can be compared directly. (An earlier reading of 2.49x came from
 * comparing a full trailing week against market-share's two-day partial
 * current week — an artifact of the comparison, not a disagreement.)
 *
 * Query params:
 *   (none)      — serve the accumulated weekly series, newest last
 *   ?refresh=1  — fetch upstream now and store if the capture qualifies
 *   ?debug=1    — coverage, freshness and why the last capture did or did not
 *                 store, so this feed cannot rot unnoticed the way the two it
 *                 supersedes did
 */

import { fetchModelUsage, weeksBehind, RankingsError } from './_openrouter-rankings.js';

const KV_PREFIX = 'or-model-usage:';
const KV_INDEX = 'or-model-usage:index';
const KV_FIRST_SEEN = 'or-model-usage:first-seen';
const CACHE_TTL = 900; // 15 min

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(data, status = 200, cache = 'public, max-age=' + CACHE_TTL) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...CORS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

const DAY_MS = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

/** Monday of the ISO week containing `date`. */
export function isoWeekStart(dateStr) {
  const t = Date.parse(dateStr + 'T00:00:00Z');
  if (!isFinite(t)) return null;
  const dow = new Date(t).getUTCDay();          // 0 Sun … 6 Sat
  const backToMonday = (dow + 6) % 7;
  return iso(t - backToMonday * DAY_MS);
}

/**
 * Decide which completed ISO week a capture taken on `capturedOn` describes.
 *
 * Returns { weekStart } when the trailing seven days line up with a completed
 * week, or { weekStart: null, reason } when they do not. Refusing is the point:
 * a capture that does not cleanly describe a week is worse than no capture,
 * because it looks like data.
 */
export function attributableWeek(capturedOn) {
  const t = Date.parse(capturedOn + 'T00:00:00Z');
  if (!isFinite(t)) return { weekStart: null, reason: 'unparseable capture date' };
  const dow = new Date(t).getUTCDay();
  // Monday (1): trailing 7 days == previous Mon–Sun exactly.
  // Tuesday (2): off by one day; close enough to attribute, and it keeps a
  // missed Monday run from losing the week entirely.
  if (dow !== 1 && dow !== 2) {
    return {
      weekStart: null,
      reason: 'captured on ' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow] +
        ' — a trailing week only coincides with a completed ISO week on Mon or Tue',
    };
  }
  const daysBack = dow === 1 ? 7 : 8;
  return { weekStart: isoWeekStart(iso(t - daysBack * DAY_MS)) };
}

/**
 * Collapse the API's per-(model, variant) rows into per-model token totals for
 * one week.
 *
 * Only the `standard` variant is kept. `free` serves at no charge and `batch`
 * at a different rate; folding either into the paid model would put volume
 * nobody paid list price for into a list-price average.
 */
function toWeekPayload(rows, weekStart) {
  const prompt = {};
  const completion = {};
  for (const r of rows) {
    if (r.variant !== 'standard') continue;
    prompt[r.slug] = (prompt[r.slug] || 0) + r.promptTokens;
    completion[r.slug] = (completion[r.slug] || 0) + r.completionTokens;
  }
  const models = Object.keys(prompt).length;
  return {
    start: weekStart,
    end: iso(Date.parse(weekStart + 'T00:00:00Z') + 6 * DAY_MS),
    models,
    promptTokens: prompt,
    completionTokens: completion,
  };
}

/**
 * Whether a week SHOULD already have been banked by now.
 *
 * Needed so health checks can distinguish "the accumulator is broken" from
 * "it was only deployed on Wednesday and the week's capture window had already
 * passed". Without this the very first run alerts on a system working
 * perfectly, and an alert that cries wolf on day one is one nobody reads on
 * day ninety.
 *
 * A bank is expected once a Monday has elapsed since the endpoint first ran.
 */
export function bankOverdue(firstSeen, todayISO, weeksStored) {
  if (weeksStored > 0) return false;
  if (!firstSeen) return false;
  const first = Date.parse(firstSeen.slice(0, 10) + 'T00:00:00Z');
  const today = Date.parse(todayISO + 'T00:00:00Z');
  if (!isFinite(first) || !isFinite(today)) return false;
  // Walk forward from the day after first-seen looking for an elapsed Monday.
  for (let t = first + DAY_MS; t <= today; t += DAY_MS) {
    if (new Date(t).getUTCDay() === 1) return true;
  }
  return false;
}

async function readIndex(kv) {
  if (!kv) return [];
  const idx = await kv.get(KV_INDEX, 'json');
  return Array.isArray(idx) ? idx : [];
}

async function readWeeks(kv, index) {
  if (!kv || !index.length) return [];
  const got = await Promise.all(index.map(w => kv.get(KV_PREFIX + w, 'json')));
  return got.filter(Boolean).sort((a, b) => (a.start < b.start ? -1 : 1));
}

/* captureNow() — REMOVED. google-dash is the sole writer of HISTORY_KV.
 * Upstream this function fetches the current ranking and banks it under
 * or-usage:<week>, updating or-usage:index. It was already unreachable here
 * (the GET handler below never called it) but still held two live kv.put
 * calls, so one future call site would have re-armed a second writer on a
 * shared namespace. Two writers corrupt the index and break both
 * dashboards, so the code is gone rather than merely unused. The read path
 * is untouched. Pinned by __tests__/no-kv-writes.test.mjs. */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const kv = env?.HISTORY_KV || null;
  const todayISO = iso(Date.now());

  // ── READ-ONLY DIVERGENCE FROM google-dash ── (see README, "Shared KV, sole writer")
  // Upstream, this endpoint does read-through capture: every request is a chance
  // to bank the current ISO week, and it also stamps KV_FIRST_SEEN on first run.
  // Both writes are disabled here. This dashboard is a read-only consumer of
  // google-dash's KV namespace, and google-dash must remain its sole writer —
  // two deployments banking weeks into one index would corrupt the series for
  // both dashboards. The read path below is untouched, so the numbers rendered
  // here are identical to google-dash's.
  const firstSeen = kv ? await kv.get(KV_FIRST_SEEN) : null;

  const index = await readIndex(kv);
  const attribution = attributableWeek(todayISO);
  const alreadyHave = attribution.weekStart && index.includes(attribution.weekStart);
  let capture = { attempted: false, stored: false, reason: alreadyHave
    ? 'week ' + attribution.weekStart + ' already stored'
    : (attribution.reason || 'not a capture day') };
  // Capture disabled — see the read-only note above. google-dash banks the weeks
  // into this same namespace; this dashboard only reads what is already there.

  const storedIndex = capture.stored && !index.includes(capture.weekStart)
    ? [...index, capture.weekStart].sort()
    : index;
  const weeks = await readWeeks(kv, storedIndex);
  const latest = weeks.length ? weeks[weeks.length - 1].start : null;

  if (url.searchParams.get('debug') === '1') {
    return jsonResp({
      success: true,
      debug: true,
      kvBound: !!kv,
      today: todayISO,
      weeksStored: weeks.length,
      firstWeek: weeks.length ? weeks[0].start : null,
      latestWeek: latest,
      weeksBehind: weeksBehind(latest),
      modelsInLatestWeek: weeks.length ? weeks[weeks.length - 1].models : 0,
      firstSeenAt: firstSeen,
      // True only when a Monday has passed since this endpoint first ran and
      // nothing has banked — i.e. a real fault, not a fresh deploy.
      overdue: bankOverdue(firstSeen, todayISO, weeks.length),
      capture,
      note: 'Accumulates OpenRouter\'s full per-model rankings (~500 models, prompt and ' +
        'completion split) one completed ISO week at a time. The weekly chart it ' +
        'supplements names only the top ~9 models, which is what caps usage-weighted ' +
        'coverage today.',
    }, 200, 'no-store');
  }

  return jsonResp({
    success: true,
    source: 'openrouter.ai/api/frontend/v1/rankings/models, accumulated weekly',
    weeksStored: weeks.length,
    latestWeek: latest,
    weeksBehind: weeksBehind(latest),
    capture,
    weeks,
  });
}
