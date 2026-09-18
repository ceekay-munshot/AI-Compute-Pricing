/**
 * Cloudflare Pages Function — PricePerToken Reverse Proxy
 * Route: /api/pricepertoken-proxy
 * Method: GET
 *
 * Fetches https://pricepertoken.com/ and returns the HTML for iframe
 * embedding in the "Model Pricing" tab. Companion catch-all proxies at
 * /_nuxt/* and /_payload.json forward those requests to pricepertoken.com
 * so the Nuxt bundle and hydration payload load through our origin.
 * (Direct cross-origin loads from pricepertoken.com are blocked by the
 * upstream Cloudflare edge, so relative URLs must route via our proxy.)
 *
 * Injects:
 *   1. Error suppression (hydration/chunk failures must not blank the iframe)
 *   2. CSS that hides page chrome — top promo strip, header, sponsor asides,
 *      newsletter promo, hero title, footer — leaves the New Model Releases
 *      timeline, provider/capability filter, pricing table, and cost chart.
 */

const TARGET_URL = 'https://pricepertoken.com/';

export async function onRequestGet(context) {
  try {
    const resp = await fetch(TARGET_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!resp.ok) {
      return new Response('Upstream returned ' + resp.status, { status: 502 });
    }

    let html = await resp.text();

    // Do NOT rewrite URLs — keep them relative so /_nuxt/* and
    // /_payload.json hit our catch-all proxies and load through our origin.

    // ── 1. Error suppression — runs before any other scripts ──
    const errorSuppress = `
<script>
window.addEventListener('unhandledrejection', function(e){ e.preventDefault(); });
window.addEventListener('error', function(e){
  var m = (e.message || '').toLowerCase();
  if (m.indexOf('chunk') !== -1 || m.indexOf('hydrat') !== -1 || m.indexOf('nuxt') !== -1 || m.indexOf('network') !== -1) {
    e.preventDefault(); return true;
  }
});
</script>`;

    // ── 2. Cleanup CSS — hide page chrome, keep pricing content ──
    const cleanupCSS = `
<style id="gdash-ppt-clean">
/* Top black promo strip ("Join the conversation…") */
div.bg-black.text-white { display: none !important; }
/* Main site header / nav bar */
header, header[data-v-8b7adbe1], header.sticky { display: none !important; }
/* Sponsor asides (left/right RunPod + "Your Ad Here") */
aside.fixed, aside.left-4, aside.right-4,
body aside[class*="lg:flex"][class*="fixed"] { display: none !important; }
/* Reclaim page width reserved by the fixed asides */
.lg\\:px-52 { padding-left: 0 !important; padding-right: 0 !important; }
/* Hero title + subtitle */
main > div.text-center.mb-12 > h1,
main > div.text-center.mb-12 > h2 { display: none !important; }
/* Newsletter promo (amber) and any sticky promo banner */
main div[data-v-02bc130b],
[class*="PromoBanner"] { display: none !important; }
/* Upstream's paid sponsor slots and its own product promos.
   Anchored on structure and on rel="sponsored" — never on a sponsor's name or
   CTA text, because the inventory rotates (the bundle carries several sponsors
   with per-slot taglines). Every rule here fails SAFE: if upstream restyles,
   the selector stops matching and the chrome simply reappears; none of these
   can match the pricing table, the chart, or the "Last updated" stamp.
   Deliberately NOT widened to [class*="amber"] or [class*="sticky"] — either
   would silently swallow the New Model Releases timeline or the table header. */
/* Purple "Get the MCP" bar — the upstream vendor's own product ad. */
div.bg-violet-600.text-white:has(a[href$="/mcp"]) { display: none !important; }
/* Newsletter signup card, and the hero sponsor card that shares its container.
   Matched via :has() on the email input / the sponsored link, so the sibling
   "Last updated: …" stamp (div.mt-6.text-sm.text-gray-500) survives. */
div.my-8.max-w-4xl.mx-auto:has(input[type="email"]),
div.my-8.max-w-4xl.mx-auto:has(a[rel~="sponsored"]) { display: none !important; }
/* Pinned sponsor row frozen above the pricing table, and the hero sponsor
   strip. Both currently out of rotation upstream, so they render as empty Vue
   placeholders today — these rules are pre-emptive and must be re-checked
   against a live sponsor before being trusted. */
div.sticky.z-30.bg-gradient-to-r.from-sky-50.to-indigo-50 { display: none !important; }
a.bg-gradient-to-r.from-sky-50.to-indigo-50 { display: none !important; }
/* Floating bottom-right sponsor banner. The existing div.fixed.bottom-4.right-4
   rule above does not match it — the component has no plain bottom-4 class —
   so this is an addition, not a replacement. */
div.fixed.z-50.bottom-0.inset-x-0.bg-white.shadow-lg { display: none !important; }
/* Everything after the pricing table + chart:
   FAQ section (max-w-3xl wrapper) plus the entire post-chart .mt-8
   block — "Built by", Price Per Token Newsletter, Archive link columns,
   Follow us / Terms / Privacy / copyright. The chart itself is also a
   .mt-12 sibling, so we only target FAQ by its max-w-3xl constraint. */
main > div.mt-12.max-w-3xl,
main > div.mt-8 { display: none !important; }
/* Footer */
footer { display: none !important; }
/* Modals / cookie / popups */
[role="dialog"], [aria-modal="true"] { display: none !important; }
/* Lead-magnet newsletter popup (bottom-left gradient) + feedback chip (bottom-right) */
div.fixed.bottom-4.left-4,
div.fixed.bottom-4.right-4,
div[class*="fixed"][class*="bottom-4"][class*="z-50"] { display: none !important; }
/* Exit-intent / scroll-depth overlays ("Wait! Before you go…") */
div.fixed.inset-0,
div[class*="fixed"][class*="inset-0"][class*="z-50"] { display: none !important; }
/* Body reset — clean scrolling */
html, body {
  background: #fff !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow-x: hidden !important;
}
main { padding-top: 0 !important; padding-bottom: 16px !important; }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
</style>
<script>
document.addEventListener('DOMContentLoaded', function(){
  // Force every anchor out of the iframe so nav clicks open a real tab
  function retargetLinks(){
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href') || '';
      // Skip in-page anchors
      if (h.charAt(0) === '#') continue;
      // Rewrite relative paths → absolute pricepertoken.com
      if (h.charAt(0) === '/' && h.charAt(1) !== '/') {
        links[i].setAttribute('href', 'https://pricepertoken.com' + h);
      }
      links[i].setAttribute('target', '_blank');
      links[i].setAttribute('rel', 'noopener');
    }
  }
  retargetLinks();
  setTimeout(retargetLinks, 2000);
  setTimeout(retargetLinks, 5000);
});
</script>`;

    // ── 3. Inject — errorSuppress must be first so it catches early scripts ──
    if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>' + errorSuppress);
    } else {
      html = errorSuppress + html;
    }
    if (html.includes('</head>')) {
      html = html.replace('</head>', cleanupCSS + '</head>');
    } else {
      html = cleanupCSS + html;
    }

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300, s-maxage=600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response('Proxy error: ' + err.message, { status: 502 });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
