/**
 * Open-weight or proprietary: which side of that line each priced model sits.
 *
 *   open         the model's weights are published for anyone to download
 *                and run, under whatever licence (Apache, MIT, Llama,
 *                research-only, non-commercial). Llama, DeepSeek, Qwen's
 *                sized releases, Gemma, gpt-oss, Kimi, GLM, MiniMax, and
 *                Mistral's and Cohere's open releases.
 *   proprietary  available only through the vendor's API — GPT, Claude,
 *                Gemini, Grok, and the API-only tiers of the open labs
 *                (Qwen Max/Plus/Turbo, GLM Turbo, Mistral Medium, …).
 *
 * The line is drawn per MODEL, not per provider: Google sells Gemini and
 * publishes Gemma, OpenAI sells GPT-5 and publishes gpt-oss.
 *
 * The rules are written out here rather than read live, and were checked on
 * 2026-09-24 against OpenRouter's catalogue, which names a Hugging Face repo
 * for a model whose weights are published. They agree on every current model
 * but five, where OpenRouter names no repo although the weights are on
 * Hugging Face: mistral-large-2407 (Mistral Research Licence), Cohere's
 * command-r-08-2024, command-r-plus-08-2024 and command-r7b-12-2024 (CC-BY-NC)
 * and minimax-m1. Those count as open. The catalogue is not the source because
 * it lists only models still offered, and most of this history's models have
 * been retired from it; a rule keeps a retired model on the side it was on.
 *
 * A rule the source outgrows fails soft: a new release from an open lab lands
 * on its provider's default side, and one from an API-only lab on proprietary.
 */

/** Providers read only for the open/proprietary view — open labs with no
 *  column of their own in the by-company matrix. */
export const OPENNESS_EXTRA_PROVIDERS = Object.freeze([
  { slug: 'qwen',       label: 'Qwen' },
  { slug: 'moonshotai', label: 'Moonshot (Kimi)' },
  { slug: 'z-ai',       label: 'Z.ai (GLM)' },
  { slug: 'minimax',    label: 'MiniMax' },
]);

/** The two columns of the open/proprietary view, in display order. */
export const OPENNESS_GROUPS = Object.freeze([
  { slug: 'proprietary', label: 'Proprietary' },
  { slug: 'open',        label: 'Open-weight' },
]);

// Per provider: the side a model lands on by default, and the patterns that
// move it to the other side. A provider missing here is proprietary.
const RULES = {
  openai:       { base: 'proprietary', flip: [/^gpt-oss/] },
  anthropic:    { base: 'proprietary', flip: [] },
  google:       { base: 'proprietary', flip: [/^gemma/] },
  xai:          { base: 'proprietary', flip: [] },
  cohere: {
    base: 'proprietary',
    // command-r, -r-plus, -r7b and command-a are published (CC-BY-NC); the
    // original `command` and command-a-plus are API-only.
    flip: [/^command-r/, /^command-a(-\d|$)/],
  },
  mistralai: {
    base: 'proprietary',
    // Mistral publishes its small and mid models and some large ones; Medium,
    // Codestral, Saba and the undated `-large` / `-small` / `-tiny` aliases
    // are API-only (an alias names whatever Mistral serves under it today).
    flip: [
      /^mistral-7b/, /^mixtral/, /^mistral-nemo/, /^mistral-small-(24b|3\.|\d{4}$)/,
      /^ministral-8b$/, /^ministral-\d+b-\d{4}$/, /^pixtral/, /^mistral-large-\d{4}$/,
      /^devstral-(small|\d{4}$)/, /^magistral-small/, /^voxtral/,
    ],
  },
  deepseek:     { base: 'open', flip: [] },
  'meta-llama': { base: 'open', flip: [] },
  qwen: {
    base: 'open',
    // Qwen publishes its sized models (qwen3-32b, qwen3.5-397b-a17b, qwq-32b);
    // Max, Plus, Turbo, Omni and the dated Flash tiers are API-only.
    // qwen3.8-flash is the exception OpenRouter lists with published weights.
    flip: [/max/, /plus/, /turbo/, /omni/, /^qwen3(\.[5-7])?-(coder-)?flash/],
  },
  moonshotai:   { base: 'open', flip: [] },
  'z-ai':       { base: 'open', flip: [/turbo/, /flashx/] },
  minimax:      { base: 'open', flip: [/-her$/] },
};

/** 'open' | 'proprietary' for one upstream (provider slug, model name). */
export function modelOpenness(slug, model) {
  const rule = RULES[slug] || { base: 'proprietary', flip: [] };
  const name = String(model || '').toLowerCase();
  const flipped = rule.flip.some(re => re.test(name));
  if (!flipped) return rule.base;
  return rule.base === 'open' ? 'proprietary' : 'open';
}
