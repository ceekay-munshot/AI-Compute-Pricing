/**
 * Edge cache for the expensive read-only endpoints.
 *
 * WHY THIS FILE EXISTS
 * Four handlers set s-maxage and none of it did anything. Cloudflare Pages
 * Functions do not honour s-maxage on their own — a dynamic Function response
 * bypasses the edge cache unless the code puts it there itself. Measured before
 * this: three identical back-to-back GETs of /api/provider-pricing-matrix took
 * 3.51s, 3.54s and 3.12s, and no /api/* response carried a cf-cache-status
 * header at all. Every visitor was paying for a fresh ~35 MB upstream fan-out
 * to receive 6.6 KB of JSON.
 *
 * caches.default really is a store here — verified on a preview deployment
 * before this was written, not assumed: a probe handler returned cached:false
 * once and then cached:true with an unchanged timestamp on eight consecutive
 * calls. Note the cache is per-PoP, so the first reader in each data centre
 * still pays cold cost; this shortens the tail, it does not abolish it.
 *
 * WHY THE LEADING UNDERSCORE IS NOT WHAT MAKES THIS SAFE
 * Pages DOES route underscore-named files: functions/_payload.json.js serves
 * /_payload.json and functions/_nuxt/[[path]].js serves /_nuxt/*, both asserted
 * live by functions/__tests__/embed-routes.test.mjs. Only _middleware is
 * special-cased. What keeps this module unroutable is that it exports no
 * onRequest* handler, the same property that keeps _gpu-price-basis.js and
 * _pricing-basket.js private. Preserve THAT, not the underscore.
 *
 * NO KV. google-dash is the sole writer of HISTORY_KV and this repo must never
 * write to it. An edge cache is not a KV write; nothing here touches a binding.
 */

/**
 * Bump this on any deploy that changes a cached payload's SHAPE, or any cache
 * setting attached to it. Entries already in the edge cache are NOT evicted by
 * a deploy: they keep serving, with the headers they were stored with, until
 * their old TTL runs out. Shortening a TTL therefore does nothing to the copies
 * already out there — observed live, where provider-pricing-matrix kept
 * answering s-maxage=21600 from an entry stored before the TTL was cut to 3600.
 * Changing the key is the only way to abandon them.
 *
 * The same goes for a change in what a cached payload's values MEAN, even
 * when its shape is untouched. v5: model-pricing levels began resting on one
 * measure per period and growth across the source's 2026-07-10 change began
 * to be refused — a stored matrix still carrying the phantom "Google -19.5%"
 * cut must not be replayed for the rest of its TTL.
 *
 * It also versions the payload copies handlers keep for themselves through
 * schemaCacheKey() below, so one bump abandons both. v6: the GPU listing's
 * last-good fallback moved onto a schema-versioned key, and a stale serve
 * stopped being stored in the edge cache.
 *
 * v7: GPU listing rows gained boardPowerStatus (known / pending /
 * unpublished / failed) and the listing's boardPower block its counts.
 *
 * v8: provider-pricing-matrix QoQ/YoY became like-for-like — measured on the
 * models priced in both quarters — and are refused where too few were. A
 * stored matrix still carrying lineup-mix moves (Anthropic 2026-Q3 "-10.4%",
 * named the biggest price cut with no model repriced) must not be replayed.
 *
 * v9: provider-pricing-matrix's usage-weighted QoQ/YoY are taken from the
 * level each cell shows, estimated or measured, where they were blank beside
 * every estimate; model-day QoQ/YoY across the 2026-07-10 change are measured
 * on the models it did not touch; cells with nothing to compare carry a
 * reason; and group=openness is new. A stored v8 matrix would show the old
 * blanks for the rest of its TTL.
 *
 * Routine data changes do NOT need a bump — the TTLs bound those.
 */
const CACHE_SCHEMA = 'v9';

/**
 * Build the cache key.
 *
 * Only parameters that genuinely change the body belong here. Two rules, both
 * learned the hard way elsewhere in this repo:
 *
 *  - OMITTING one serves wrong numbers. provider-pricing-matrix varies on both
 *    metric and weight; a key that forgot `weight` would hand a reader the
 *    usage-weighted figures under the model-day label, plausibly and silently.
 *    Every caller must enumerate its real parameter surface.
 *
 *  - INCLUDING a free-form one is a denial-of-service lever. The client appends
 *    a cache-busting `b=<build hash>`, and an attacker can append anything at
 *    all. If that reached the key, each distinct value would miss and kick off
 *    another 35 MB upstream fan-out. So `b`/`v` are deliberately excluded: they
 *    do not affect the body, which is exactly why serving a cached body to a
 *    new value of them is correct rather than stale.
 */
export function edgeCacheKey(request, params) {
  const url = new URL(request.url);
  const canonical = new URL(url.origin + url.pathname);
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    if (value !== undefined && value !== null && value !== '') {
      canonical.searchParams.set(name, String(value));
    }
  }
  canonical.searchParams.set('__schema', CACHE_SCHEMA);
  // A bare GET, so no incoming header or method folds into the match.
  return new Request(canonical.toString(), { method: 'GET' });
}

/**
 * Key for a copy a handler keeps for itself in caches.default and may serve
 * later — the GPU listing's last-good fallback is the case this exists for.
 *
 * Versioned with CACHE_SCHEMA for the same reason response keys are. The
 * fallback holds a whole payload; unversioned, a bump abandoned every response
 * entry and left the fallback free to hand back the PRE-bump shape, under the
 * new code's labels, for up to a day the next time the source refused.
 *
 * Only for copies of a payload. Per-item facts whose shape never changes (board
 * power per GPU) must NOT use this: a bump would throw them all away and refill
 * them one detail-page fetch at a time from a source that rate-limits.
 */
export function schemaCacheKey(baseUrl, pathname) {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set('__schema', CACHE_SCHEMA);
  return new Request(url.toString(), { method: 'GET' });
}

/**
 * Never store something that should not be replayed. A cached error is worse
 * than a slow success: it pins a failure for the whole TTL.
 */
function storable(response) {
  if (response.status !== 200) return false;
  if (response.headers.has('Set-Cookie')) return false;
  if ((response.headers.get('Vary') || '').trim() === '*') return false;
  const cc = (response.headers.get('Cache-Control') || '').toLowerCase();
  // no-cache matters as much as no-store: a stored no-cache response would be
  // replayed from match() with no revalidation, which is precisely what the
  // header asks us not to do.
  return !cc.includes('no-store') && !cc.includes('no-cache') && !cc.includes('private');
}

/**
 * Wrap a handler in the edge cache.
 *
 * @param context      the Pages Functions context (needs request + waitUntil)
 * @param options      { params, ttl, browserTtl }
 *                     params     — everything that varies the body (see above)
 *                     ttl        — edge lifetime, seconds
 *                     browserTtl — max-age sent to the reader, seconds.
 *                                  REQUIRED, never defaulted. An earlier draft
 *                                  defaulted it to 0 and would have rewritten
 *                                  model-pricing-peer-matrix's max-age=86400 to
 *                                  zero, making the commonest case slower while
 *                                  claiming to speed it up. Pass 0 on purpose
 *                                  or not at all.
 * @param build        async () => Response, run only on a miss
 */
export async function withEdgeCache(context, options, build) {
  const { params = {}, ttl, browserTtl } = options;
  if (!(ttl > 0)) throw new Error('withEdgeCache: ttl (seconds) is required');
  if (!(browserTtl >= 0)) throw new Error('withEdgeCache: browserTtl is required — pass 0 deliberately');

  const cache = caches.default;
  const key = edgeCacheKey(context.request, params);

  const hit = await cache.match(key);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('X-Edge-Cache', 'HIT');
    return new Response(hit.body, { status: hit.status, headers });
  }

  const fresh = await build();
  if (!storable(fresh)) return fresh;

  const headers = new Headers(fresh.headers);
  headers.set('Cache-Control', `public, max-age=${browserTtl}, s-maxage=${ttl}`);
  headers.set('X-Edge-Cache', 'MISS');
  const body = await fresh.arrayBuffer();

  const toStore = new Response(body, { status: fresh.status, headers });
  // clone() because put() consumes the body it is handed, and we still have to
  // return one. waitUntil so storing never delays the reader.
  context.waitUntil(cache.put(key, toStore.clone()));
  return toStore;
}
