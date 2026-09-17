/**
 * Cloudflare Pages Function — PricePerToken Pricing History Reverse Proxy
 * Route: /api/pricepertoken-history-proxy
 * Method: GET
 *
 * Fetches https://pricepertoken.com/pricing-history and returns HTML for
 * iframe embedding in the AI Insights tab. Relies on the existing
 * /_nuxt/* and /_payload.json catch-all proxies for Nuxt assets.
 *
 * Hides everything except the interactive chart card (.historical-charts)
 * and the "How this data is calculated" explanation beneath it — matching
 * the screenshot layout.
 */

const TARGET_URL = 'https://pricepertoken.com/pricing-history';

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

    // Route the embed's client-side API calls through our origin.
    // Nuxt reads apiBaseUrl from window.__NUXT__.config.public — replace
    // the upstream host with our catch-all at /ppt-api/*.
    html = html.split('https://api.pricepertoken.com').join('/ppt-api');

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

    // ── 2. Cleanup CSS — hide page chrome, keep chart + methodology ──
    const cleanupCSS = `
<style id="gdash-ppt-history-clean">
/* Top black promo strip */
div.bg-black.text-white { display: none !important; }
/* Main site header / nav bar */
header, header[data-v-8b7adbe1], header.sticky { display: none !important; }
/* Sponsor asides (left/right RunPod + "Your Ad Here") */
aside.fixed, aside.left-4, aside.right-4,
body aside[class*="lg:flex"][class*="fixed"] { display: none !important; }
/* Reclaim page width reserved by the fixed asides */
.lg\\:px-52 { padding-left: 0 !important; padding-right: 0 !important; }
/* Hero block — logo, "LLM API Pricing Histories", subtitle, last-updated */
main > div.text-center.mb-8 { display: none !important; }
/* Footer block below the chart — "Built by …", newsletter signup,
   archive link columns, follow/terms/privacy, copyright */
main div.max-w-7xl.py-12 { display: none !important; }
/* Newsletter promo and sticky promo banner */
main div[data-v-02bc130b],
[class*="PromoBanner"] { display: none !important; }
/* Footer */
footer { display: none !important; }
/* Modals / cookie / popups */
[role="dialog"], [aria-modal="true"] { display: none !important; }
/* Lead-magnet newsletter popup (bottom-left) + feedback chip (bottom-right) */
div.fixed.bottom-4.left-4,
div.fixed.bottom-4.right-4,
div[class*="fixed"][class*="bottom-4"][class*="z-50"] { display: none !important; }
/* Exit-intent / scroll-depth overlays */
div.fixed.inset-0,
div[class*="fixed"][class*="inset-0"][class*="z-50"] { display: none !important; }
/* Body reset — shrink-wrap to content so the iframe doesn't
   inherit a 100vh wrapper that leaves empty space below. */
html, body {
  background: #fff !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow-x: hidden !important;
}
.min-h-screen { min-height: 0 !important; }
/* padding-top leaves room for hover tooltips that can extend above
   the chart card — without it they clip against the iframe edge. */
main { padding-top: 40px !important; padding-bottom: 8px !important; }
main > div.space-y-8 > section { margin-bottom: 0 !important; }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
</style>
<script>
document.addEventListener('DOMContentLoaded', function(){
  // Post the document body's natural height up to the parent so the
  // dashboard iframe can size to content at any viewport width (chart
  // + methodology both reflow).
  function postHeight(){
    // Measure main content only — documentElement.scrollHeight inherits
    // the iframe viewport size and would over-report.
    var main = document.querySelector('main');
    var h = 0;
    if (main) {
      var r = main.getBoundingClientRect();
      h = Math.ceil(r.bottom + window.scrollY);
    } else {
      h = document.body.scrollHeight;
    }
    if (!h) return;
    try { parent.postMessage({ __ppt: 'history-height', height: h }, '*'); } catch(e){}
  }
  postHeight();
  window.addEventListener('load', postHeight);
  setTimeout(postHeight, 500);
  setTimeout(postHeight, 1500);
  setTimeout(postHeight, 3000);
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(postHeight);
    ro.observe(document.body);
  }

  // ECharts hover tooltip — ECharts picks "above the cursor" or "below"
  // based on viewport space. In a short iframe it miscalculates and
  // places the tooltip at translate(x, -900) which clips against the
  // iframe top. Two-part fix:
  //   (1) Clamp y to 4 so the tooltip always starts inside the iframe.
  //   (2) Ensure the iframe is tall enough to show the full tooltip —
  //       measure tooltip height and postHeight up to the parent so
  //       the iframe grows. Shrinks back on mouseleave via ResizeObserver.
  function looksLikeTooltip(el){
    if (!el || el.nodeType !== 1 || !el.style) return false;
    var z = el.style.zIndex;
    return (z === '9999999' || z === '99999999') &&
           el.style.position === 'absolute';
  }
  function clampAndFit(el){
    if (!el || !el.style) return;
    // Skip hidden tooltips (ECharts hides with opacity:0 or display:none)
    if (el.style.display === 'none' || el.style.visibility === 'hidden') return;

    var t = el.style.transform || '';
    var m = t.match(/translate(3d)?\\s*\\(\\s*([-\\d.]+)px\\s*,\\s*([-\\d.]+)px/);
    if (m) {
      var x = parseFloat(m[2]);
      var y = parseFloat(m[3]);
      if (y < 4) {
        // Use translate3d to match ECharts format (avoids an override loop)
        var newT = 'translate3d(' + x + 'px, 4px, 0px)';
        if (t !== newT) {
          __clamping = true;
          el.style.transform = newT;
          __clamping = false;
        }
      }
    }

    // If tooltip is taller than the iframe body, grow the iframe.
    var rect = el.getBoundingClientRect();
    var needed = rect.bottom + 20;  // tooltip bottom + small buffer
    var have = document.documentElement.clientHeight;
    if (needed > have) {
      try {
        parent.postMessage({ __ppt: 'history-height', height: Math.ceil(needed) }, '*');
      } catch(e){}
    }
  }
  var __clamping = false;
  var mo = new MutationObserver(function(muts){
    if (__clamping) return;
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      if (looksLikeTooltip(t)) clampAndFit(t);
      if (muts[i].addedNodes) {
        for (var j = 0; j < muts[i].addedNodes.length; j++) {
          var n = muts[i].addedNodes[j];
          if (looksLikeTooltip(n)) {
            clampAndFit(n);
            mo.observe(n, { attributes: true, attributeFilter: ['style'] });
          }
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

  // When the user moves off the chart, shrink back to natural content height.
  document.addEventListener('mouseleave', postHeight, true);
  document.addEventListener('mouseout', function(e){
    if (e.target && e.target.tagName === 'CANVAS') setTimeout(postHeight, 150);
  }, true);

  // Force every anchor out of the iframe so nav clicks open a real tab
  function retargetLinks(){
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href') || '';
      if (h.charAt(0) === '#') continue;
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
