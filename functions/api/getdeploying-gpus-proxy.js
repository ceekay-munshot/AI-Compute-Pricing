/**
 * Cloudflare Pages Function — GetDeploying GPU Pricing Reverse Proxy
 * Route: /api/getdeploying-gpus-proxy
 * Method: GET
 *
 * Fetches https://getdeploying.com/gpus and returns the full HTML for
 * iframe embedding in the "GPU Hardware Pricing" tab. The companion
 * catch-all proxy at /static/* forwards CSS, the Alpine.js app bundle,
 * and provider logos to getdeploying.com so the table renders and stays
 * interactive (search box + All / High Performance / Mid-Range / Budget
 * filter pills).
 *
 * Upstream sends `x-frame-options: DENY`, so we MUST proxy rather than
 * iframe directly. We strip that header and CSP on the response so the
 * dashboard can host the page inside an iframe.
 *
 * Cleanup CSS hides everything outside the live table clip shown in the
 * product screenshot: top nav, sponsor sticky banner, hero H1/subtitle,
 * GPU Providers grid, FAQ, and footer. The "Updated {date}" caption is
 * preserved.
 */

const TARGET_URL = 'https://getdeploying.com/gpus';

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

    // Do NOT rewrite relative /static/* URLs — they must flow through our
    // /static/[[path]].js catch-all proxy so assets load from our origin.

    // ── 1. Error suppression — runs before any other scripts ──
    const errorSuppress = `
<script>
window.addEventListener('unhandledrejection', function(e){ e.preventDefault(); });
window.addEventListener('error', function(e){
  var m = (e.message || '').toLowerCase();
  if (m.indexOf('chunk') !== -1 || m.indexOf('plausible') !== -1 || m.indexOf('junglestack') !== -1 || m.indexOf('network') !== -1 || m.indexOf('script') !== -1) {
    e.preventDefault(); return true;
  }
});
// Neutralize Plausible analytics calls (cross-origin, fail in iframe)
window.plausible = function(){};
</script>`;

    // ── 2. Cleanup CSS — hide page chrome, keep the GPU table clip ──
    const cleanupCSS = `
<style id="gdash-gd-clean">
/* Top site nav */
nav { display: none !important; }
/* Nav spacer */
body > div.h-\\[53px\\] { display: none !important; }
/* Sticky sponsor banner + flash messages + sponsor hidden tracking div */
#sticky-sponsor-header,
section[x-data*="messages"],
div[data-sponsor] { display: none !important; }
/* Hero header: hide the H1 "Cloud GPU Index" + the subtitle, keep the
   "Updated {date}" caption that matches the screenshot */
main > header h1,
main > header > div > p.subtitle,
main > header > div > p:nth-of-type(1) { display: none !important; }
main > header p.text-muted-foreground.body-2 { display: block !important; }
/* Tighten the header so the table sits close to the top of the iframe */
main > header {
  padding-top: 4px !important;
  padding-bottom: 8px !important;
}
/* Hide post-table sections: GPU Providers grid + FAQ + footer */
section#providers,
section#faq,
footer { display: none !important; }
/* "Back to top" link that sits inside main */
main a[href="#top"] { display: none !important; }
/* Body reset — clean scrolling, no extra top padding */
html, body {
  background: #fff !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow-x: hidden !important;
}
main {
  padding-top: 0 !important;
  padding-bottom: 16px !important;
  min-height: 0 !important;
}
/* Collapse the big space-y-24 gap that originally separated table from
   hidden sections — prevents a huge blank area under the table */
main > div.space-y-24 > :not(#gpus) { display: none !important; }
main > div.space-y-24 { padding-top: 0 !important; }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
</style>
<script>
document.addEventListener('DOMContentLoaded', function(){
  // Retarget every anchor so in-iframe clicks open a new tab at getdeploying.com
  function retargetLinks(){
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href') || '';
      if (h.charAt(0) === '#') continue;
      if (h.charAt(0) === '/' && h.charAt(1) !== '/') {
        links[i].setAttribute('href', 'https://getdeploying.com' + h);
      }
      links[i].setAttribute('target', '_blank');
      links[i].setAttribute('rel', 'noopener');
    }
  }
  retargetLinks();
  setTimeout(retargetLinks, 1500);
  setTimeout(retargetLinks, 4000);
});
</script>`;

    // ── 3. Inject — errorSuppress first, cleanupCSS just before </head> ──
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
