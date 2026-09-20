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
 * Routine data changes do NOT need a bump — the TTLs bound those.
 */
const CACHE_SCHEMA = 'v2';

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
