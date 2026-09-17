/**
 * Catch-all proxy for /_nuxt/* → https://pricepertoken.com/_nuxt/*
 * Proxies Nuxt JS chunks, CSS, and fonts for the Model Pricing tab embed.
 * Pricepertoken.com is fronted by Cloudflare which blocks cross-origin
 * fetches from arbitrary iframes, so the assets must flow through our
 * origin to load inside the proxied page.
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
  const target = 'https://pricepertoken.com/_nuxt/' + segments + url.search;

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
    // Nuxt hashed assets are immutable
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.delete('content-security-policy');
    headers.delete('x-frame-options');

    return new Response(resp.body, { status: resp.status, headers });
  } catch (err) {
    return new Response('', { status: 502 });
  }
}
