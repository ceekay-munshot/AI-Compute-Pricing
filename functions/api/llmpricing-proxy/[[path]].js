/**
 * Cloudflare Pages Function — sanand0 LLM Pricing reverse proxy
 * Mount: /api/llmpricing-proxy/[[path]]
 *
 * Hybrid SPA: GitHub Pages serves a small static HTML shell at
 * https://sanand0.github.io/llmpricing/ and a `script.js` ES-module that
 * fetches three relative siblings — README.md, elo.csv, narrative.json —
 * and renders an Observable Plot scatter (input-token cost × LMArena ELO).
 *
 * Single catch-all so the iframe document URL ends in a slash and every
 * relative URL the page emits (script src, fetch, anchor href) lands back
 * on this function:
 *   - empty path  → return cleaned HTML (chrome stripped, chart kept)
 *   - any subpath → proxy to https://sanand0.github.io/llmpricing/<path>
 *
 * The query string (?quality=overall|coding|hard) is read by script.js from
 * window.location.search inside the iframe, so we just preserve it.
 *
 * Style mirrors the existing pricepertoken / openrouter-rankings proxies.
 */

const UPSTREAM_ORIGIN = 'https://sanand0.github.io';
const UPSTREAM_BASE = '/llmpricing/';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function corsHeaders(extra) {
  const h = new Headers(extra || {});
  h.set('Access-Control-Allow-Origin', '*');
  return h;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders({
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }),
  });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return onRequestOptions();
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const reqUrl = new URL(context.request.url);
  const raw = context.params.path;
  const segments = Array.isArray(raw) ? raw.join('/') : raw || '';

  // Empty path → serve the rewritten HTML shell.
  if (segments === '') {
    return serveHtml(reqUrl.search);
  }

  // Otherwise → proxy the asset (script.js, README.md, elo.csv, narrative.json, …).
  return proxyAsset(segments, reqUrl.search);
}

async function serveHtml(search) {
  let resp;
  try {
    resp = await fetch(UPSTREAM_ORIGIN + UPSTREAM_BASE + search, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
  } catch (err) {
    return new Response('Upstream fetch failed: ' + err.message, { status: 502 });
  }

  if (!resp.ok) {
    return new Response('Upstream returned ' + resp.status, { status: 502 });
  }

  let html = await resp.text();

  // ── 1. Error suppression — silences module/network errors that can otherwise
  //       leave the iframe blank if the upstream is briefly slow. Runs before
  //       any other scripts so it catches early failures.
  const errorSuppress = `
<script>
window.addEventListener('unhandledrejection', function(e){ e.preventDefault(); });
window.addEventListener('error', function(e){
  var m = (e && e.message ? e.message : '').toLowerCase();
  if (m.indexOf('module') !== -1 || m.indexOf('chunk') !== -1 || m.indexOf('network') !== -1) {
    e.preventDefault(); return true;
  }
});
</script>`;

  // ── 2. Cleanup CSS — strip the navbar/title/README/scrollytelling wrapper,
  //       keep the controls row + chart. Light theme is forced so the embed
  //       blends with the dashboard regardless of the user's OS preference.
  const cleanupCSS = `
<style id="gdash-llmp-clean">
:root[data-bs-theme="dark"], html[data-bs-theme="dark"] { color-scheme: light; }
html, body {
  background: #ffffff !important;
  color: #111827 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow-x: hidden !important;
}
/* Top fixed navbar + dark-mode toggle */
nav.navbar, nav.fixed-top { display: none !important; }
/* Body padding-top reserved for the navbar — reclaim it */
body { padding-top: 0 !important; }
/* Page hero (H1 + H2 + README) above the chart */
.container > h1.display-1,
.container > h2.display-6,
#README { display: none !important; }
/* The long scrolly-section beneath the chart (cards, gaps, narrative) */
#scrolly-section { display: none !important; }
/* Container padding/width tweaks for a tighter embed */
.container {
  max-width: 100% !important;
  padding-left: 12px !important;
  padding-right: 12px !important;
}
/* Sticky chart wrapper — disable sticky inside the iframe (no sibling content
   to scroll past now), and reset the top offset that assumes a navbar height. */
#chart-sticky {
  position: static !important;
  top: auto !important;
  padding-top: 8px !important;
  padding-bottom: 8px !important;
}
/* Plot SVG — let it scale to container width */
#llm-cost > svg { width: 100% !important; height: auto !important; max-width: 100% !important; }
/* Lightweight scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
</style>`;

  // ── 3. Force light Bootstrap theme + retarget any anchor clicks that escape
  //       the embed (the navbar brand href=".", external links, etc) so they
  //       open in a new tab instead of breaking the iframe.
  const postHydrate = `
<script>
(function(){
  function setLight(){
    try {
      document.documentElement.setAttribute('data-bs-theme','light');
      var dark = document.querySelectorAll('[data-bs-theme="dark"]');
      for (var i = 0; i < dark.length; i++) dark[i].setAttribute('data-bs-theme','light');
    } catch (e) {}
  }
  function retargetLinks(){
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var h = anchors[i].getAttribute('href') || '';
      if (!h || h.charAt(0) === '#') continue;
      // Quality dropdown: keep relative ?quality=… so navigation stays inside
      // /api/llmpricing-proxy/?quality=…
      if (h.charAt(0) === '?') continue;
      // Anything else (navbar brand, external) → open in new tab.
      anchors[i].setAttribute('target', '_blank');
      anchors[i].setAttribute('rel', 'noopener');
    }
  }
  setLight();
  retargetLinks();
  setTimeout(setLight, 500);
  setTimeout(retargetLinks, 1500);
  setTimeout(retargetLinks, 4000);
})();
</script>`;

  // Inject — errorSuppress first so it's installed before any module evaluates.
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
  if (html.includes('</body>')) {
    html = html.replace('</body>', postHydrate + '</body>');
  } else {
    html = html + postHydrate;
  }

  return new Response(html, {
    status: 200,
    headers: corsHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=600',
    }),
  });
}

async function proxyAsset(segments, search) {
  const target = UPSTREAM_ORIGIN + UPSTREAM_BASE + segments + search;

  let resp;
  try {
    resp = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
      },
    });
  } catch (err) {
    return new Response('Upstream fetch failed: ' + err.message, { status: 502 });
  }

  // Clone headers, drop frame/CSP gating that would block embedding, surface CORS.
  const headers = new Headers();
  const ct = resp.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);
  const cl = resp.headers.get('content-length');
  if (cl) headers.set('Content-Length', cl);
  // GitHub static assets are content-addressed (etag is stable), 5-min edge
  // cache is plenty — same as the upstream max-age.
  headers.set('Cache-Control', 'public, max-age=300, s-maxage=600');
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(resp.body, { status: resp.status, headers });
}
