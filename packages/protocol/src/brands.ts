/**
 * Which company's mark stands for an agent: a lobe-icons key (https://github.com/lobehub/lobe-icons), the collection
 * the desktop's `BrandIcons.tsx` draws from and the key a paired phone receives as `brand` on its agent, allowance and
 * session rows. One function decides it for both, so the window and the phone never draw different marks for one
 * agent. A key is a short lower-case word of letters and digits (`RUNTIME_BRAND_KEY`), never a label: the name shown
 * beside it is still the adapter's own.
 *
 * An *agent* (a runtime in the picker) is whoever ships the CLI: Codex is OpenAI's, Claude Code is Anthropic's, Cursor
 * Agent is Cursor's. Where lobe-icons draws the agent itself that mark wins over its maker's, and only an agent with no
 * mark of its own falls back to the company behind it, as Cortex Code does to Snowflake. A model's mark (whoever trained
 * it) is the interface's own question, answered in `packages/ui/src/lib/brands.ts`.
 *
 * Neither question is answered by guessing. An agent this collection has no mark for is null, and the caller draws the
 * generic glyph: a logo that belongs to a different company with the same product name is worse than no logo at all.
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
  // Agents with a mark of their own. A short name matches a whole word only, so "traefik-agent" wears no mark.
  [/claude/, 'claudecode'],
  [/anthropic/, 'anthropic'],
  [/codex|openai/, 'codex'],
  [/cursor/, 'cursor'],
  [/gemini/, 'geminicli'],
  [/antigravity/, 'antigravity'],
  [/copilot/, 'githubcopilot'],
  [/\bcline\b/, 'cline'],
  [/windsurf|codeium/, 'windsurf'],
  [/opencode/, 'opencode'],
  [/openclaw/, 'openclaw'],
  [/\bkiro\b/, 'kiro'],
  [/\bkilo(code)?\b/, 'kilocode'],
  [/\bdevin\b/, 'devin'],
  [/\btrae\b/, 'trae'],
  [/codebuddy/, 'codebuddy'],
  [/\bgoose\b/, 'goose'],
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

/** The shape every brand key has on the wire: lower-case letters and digits, at most 32. A phone checks it before use. */
export const RUNTIME_BRAND_KEY = /^[a-z0-9]{1,32}$/

/** A mark's key as a row field, only when it has the wire's shape; anything else (a label, an empty string) is not sent. */
export const brandKeyField = (brand: string | null | undefined): { readonly brand?: string } => brand && RUNTIME_BRAND_KEY.test(brand) ? { brand } : {}
