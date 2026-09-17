/**
 * Catch-all proxy for /ppt-api/* → https://api.pricepertoken.com/*
 * Used by the pricing-history iframe embed so its client-side fetches
 * (which otherwise target api.pricepertoken.com and fail cross-origin)
 * flow through our origin instead.
 *
 * The embed's HTML is rewritten in pricepertoken-history-proxy.js to
 * replace apiBaseUrl="https://api.pricepertoken.com" with "/ppt-api".
 */
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const path = context.params.path;
  const segments = Array.isArray(path) ? path.join('/') : path;
  const url = new URL(context.request.url);
  const target = 'https://api.pricepertoken.com/' + segments + url.search;

  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent':
          context.request.headers.get('User-Agent') ||
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': context.request.headers.get('Accept') || '*/*',
      },
    });

    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    // Only cache successful responses — a 502 should never stick.
    if (resp.ok) {
      headers.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    } else {
      headers.set('Cache-Control', 'no-store');
    }
    headers.delete('content-security-policy');
    headers.delete('x-frame-options');

    return new Response(resp.body, { status: resp.status, headers });
  } catch (err) {
    return new Response('{"error":"proxy error"}', {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
