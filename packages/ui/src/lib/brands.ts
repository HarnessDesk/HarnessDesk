/**
 * Which company's mark stands for a model. The keys are lobe-icons names, the collection `BrandIcons.tsx` draws from;
 * this module is the pure half (which key applies) so it can be tested without rendering anything.
 *
 * The agent half (the key list `BRANDS`, `isBrand` and `brandForRuntime`) lives in `@harnessdesk/protocol`
 * (`brands.ts`), so the desk's phone rows carry the same key this window draws. A *model* is whoever trained it, which
 * is often someone else: Cursor offers Claude and GPT and Grok side by side, and showing Cursor's cube next to
 * "GPT-5.2" would say the wrong thing. A model nothing here places is null, and the caller draws the generic glyph.
 */

import { type Brand } from '@harnessdesk/protocol'

export { BRANDS, brandForRuntime, isBrand, type Brand } from '@harnessdesk/protocol'

const MODEL_PATTERNS: readonly (readonly [RegExp, Brand])[] = [
  // OpenAI's agentic line wears the Codex mark; everything else of theirs, the OpenAI one.
  [/codex/, 'codex'],
  [/\bgpt|\bo[134](?:-|\b)|chatgpt|davinci/, 'openai'],
  [/claude|sonnet|opus|haiku/, 'claude'],
  [/gemma/, 'gemma'],
  [/gemini/, 'gemini'],
  [/grok/, 'grok'],
  [/deepseek/, 'deepseek'],
  [/llama/, 'meta'],
  [/mistral|mixtral|codestral|devstral|magistral|ministral/, 'mistral'],
  [/qwen|qwq/, 'qwen'],
  [/kimi|moonshot/, 'kimi'],
  [/\bglm|zhipu|chatglm/, 'zhipu'],
  [/minimax/, 'minimax'],
  [/doubao/, 'doubao'],
  [/command-?r|cohere|aya\b/, 'cohere'],
  [/sonar|perplexity/, 'perplexity'],
  [/phi-?\d|copilot/, 'microsoft'],
  // Cursor's own models (Composer) and the agent's "Auto" routing.
  [/composer|cursor/, 'cursor'],
]

/**
 * The mark for a model, from its id and label. Models named for their maker
 * get that maker; a vendor's own routing choice ("Auto", "default") gets the
 * agent's mark, since it is the agent deciding; anything unrecognised gets
 * null and the generic model glyph, which is honest about not knowing.
 */
export const brandForModel = (model: string, agent: Brand | null): Brand | null => {
  const text = model.toLowerCase()
  for (const [pattern, brand] of MODEL_PATTERNS) if (pattern.test(text)) return brand
  if (/^\s*(auto|default)\b/.test(text)) return agent
  return null
}
