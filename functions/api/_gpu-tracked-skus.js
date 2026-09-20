/**
 * The GPU SKUs this dashboard tracks, and their getdeploying slugs.
 *
 * The listing endpoint fetches one detail page per SKU to read board power,
 * which the list page does not publish. That fan-out has to be bounded, and the
 * bound has to be the same set the table renders — otherwise the server fetches
 * power for SKUs nobody shows, or the table shows a SKU whose power was never
 * fetched. js/dashboard.jsx's GPU_STRATEGIC_ORDER is the client half of this
 * pair and must stay name-for-name identical; the names below are exactly the
 * `data-name` values on getdeploying's list page, which is what the parser keys
 * rows by.
 *
 * Exports no onRequest* handler, so Pages cannot route it — the same property
 * that keeps the other _-prefixed modules private. The underscore alone does
 * not do that (functions/_payload.json.js IS a live route); the absence of a
 * handler export does.
 */

export const GPU_TRACKED_SKUS = [
  { name: 'Nvidia H100', slug: 'nvidia-h100' },
  { name: 'Nvidia H200', slug: 'nvidia-h200' },
  { name: 'Nvidia B200', slug: 'nvidia-b200' },
  { name: 'Nvidia GB200', slug: 'nvidia-gb200' },
  { name: 'Nvidia A100', slug: 'nvidia-a100' },
  { name: 'Nvidia L40S', slug: 'nvidia-l40s' },
];

export const GPU_TRACKED_SKU_NAMES = GPU_TRACKED_SKUS.map(s => s.name);
