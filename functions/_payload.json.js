/**
 * Proxy for /_payload.json → https://pricepertoken.com/_payload.json
 * Nuxt uses this for client-side hydration of initial page state.
 * Preserves query string (Nuxt build hash identifier).
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

  const url = new URL(context.request.url);
  const target = 'https://pricepertoken.com/_payload.json' + url.search;

  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent':
          context.request.headers.get('User-Agent') ||
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=300');
    headers.delete('content-security-policy');
    headers.delete('x-frame-options');

    return new Response(resp.body, { status: resp.status, headers });
  } catch (err) {
    return new Response('{}', {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
