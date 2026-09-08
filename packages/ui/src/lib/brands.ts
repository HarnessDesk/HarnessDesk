/**
 * Which company's mark stands for an agent or a model.
 *
 * The keys are lobe-icons names (https://github.com/lobehub/lobe-icons), the
 * collection `BrandIcons.tsx` draws from; this module is the pure half —
 * which key applies — so it can be tested without rendering anything.
 *
 * Two questions are answered here. An *agent* (a runtime in the picker) is
 * whoever ships the CLI: Codex is OpenAI's, Claude Code is Anthropic's, Cursor
 * Agent is Cursor's. Where lobe-icons draws the agent itself that mark wins
 * over its maker's — Kimi CLI wears Kimi's, not Moonshot's, the way Codex
 * wears Codex's and not OpenAI's — and only an agent with no mark of its own
 * falls back to the company behind it, as Cortex Code does to Snowflake. A
 * *model* is whoever trained it, which is often someone else: Cursor offers
 * Claude and GPT and Grok side by side, and showing Cursor's cube next to
 * "GPT-5.2" would say the wrong thing.
 *
 * Neither question is answered by guessing. An agent this collection has no
 * mark for is null, and the caller draws the generic glyph: a logo that
 * belongs to a different company with the same product name is worse than no
 * logo at all.
 */

export const BRANDS = [
  // Agents
  'codex',
  'claudecode',
  'cursor',
  'geminicli',
  'githubcopilot',
  'antigravity',
  'cline',
  'windsurf',
  'opencode',
  'openclaw',
  'kiro',
  'kilocode',
  'devin',
  'trae',
  'amp',
  'codebuddy',
  'goose',
  'hermesagent',
  'junie',
  'pi',
  'poolside',
  'qoder',
  // Companies and models
  'openai',
  'claude',
  'anthropic',
  'deepseek',
  'gemini',
  'gemma',
  'google',
  'grok',
  'xai',
  'meta',
  'mistral',
  'qwen',
  'kimi',
  'zhipu',
  'minimax',
  'doubao',
  'cohere',
  'perplexity',
  'microsoft',
  'langchain',
  'snowflake',
  // Routers and local hosts
  'openrouter',
  'ollama',
  'groq',
  'huggingface',
] as const

export type Brand = (typeof BRANDS)[number]

const KNOWN = new Set<string>(BRANDS)

export const isBrand = (value: unknown): value is Brand => typeof value === 'string' && KNOWN.has(value)

/**
 * Ordered: the first pattern that matches wins, so the specific come before
 * the general. It is read against an agent's id and name together, which is
 * all a registry entry gives us — most of the ACP registry's forty agents
 * declare no brand of their own, so this list is what decides whether such a
 * row wears a logo or the generic glyph.
 *
 * A pattern is only ever a word the agent is actually called; two of them
 * (`amp`, `pi`) are short enough to turn up inside an unrelated name, so they
 * are bounded. An agent not named here stays null on purpose — `Nova`, say,
 * whose mark in lobe-icons is Amazon's Nova and not the agent of that name.
 */
const AGENT_PATTERNS: readonly (readonly [RegExp, Brand])[] = [
  // Agents with a mark of their own.
  [/claude/, 'claudecode'],
  [/anthropic/, 'anthropic'],
  [/codex|openai/, 'codex'],
  [/cursor/, 'cursor'],
  [/gemini/, 'geminicli'],
  [/antigravity/, 'antigravity'],
  [/copilot/, 'githubcopilot'],
  [/cline/, 'cline'],
  [/windsurf|codeium/, 'windsurf'],
  [/opencode/, 'opencode'],
  [/openclaw/, 'openclaw'],
  [/kiro/, 'kiro'],
  [/kilo/, 'kilocode'],
  [/devin/, 'devin'],
  [/trae/, 'trae'],
  [/codebuddy/, 'codebuddy'],
  [/goose/, 'goose'],
  [/hermes/, 'hermesagent'],
  [/junie/, 'junie'],
  [/qoder/, 'qoder'],
  [/poolside/, 'poolside'],
  [/\bamp\b/, 'amp'],
  [/\bpi\b/, 'pi'],
  // Agents that wear their maker's mark, having none of their own.
  [/deepagents|langchain/, 'langchain'],
  [/cortex|snowflake/, 'snowflake'],
  [/deepseek/, 'deepseek'],
  [/openrouter/, 'openrouter'],
  [/ollama/, 'ollama'],
  [/grok|xai/, 'grok'],
  [/mistral/, 'mistral'],
  [/qwen/, 'qwen'],
  [/kimi|moonshot/, 'kimi'],
  [/\bglm\b|zhipu/, 'zhipu'],
]

/**
 * The mark for a runtime. What it declares wins; otherwise its id and name
 * are read for the vendors this interface knows. Null means "no mark" — the
 * caller falls back to the generic agent glyph rather than guessing.
 */
export const brandForRuntime = (runtime: {
  readonly id: string
  readonly presentation: { readonly name: string; readonly brand?: string }
}): Brand | null => {
  if (isBrand(runtime.presentation.brand)) return runtime.presentation.brand
  const text = `${runtime.id} ${runtime.presentation.name}`.toLowerCase()
  for (const [pattern, brand] of AGENT_PATTERNS) if (pattern.test(text)) return brand
  return null
}

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
