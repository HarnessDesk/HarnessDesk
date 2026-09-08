import { describe, expect, it } from 'vitest'

import { type Brand, BRANDS, brandForModel, brandForRuntime, isBrand } from './brands'

const runtime = (id: string, name: string, brand?: string) => ({
  id,
  presentation: brand ? { name, brand } : { name },
})

describe('brandForRuntime', () => {
  it('takes what the runtime declares', () => {
    expect(brandForRuntime(runtime('x', 'Anything', 'geminicli'))).toBe('geminicli')
  })

  it('ignores a declared brand it has no mark for, and reads the name instead', () => {
    expect(brandForRuntime(runtime('codex', 'OpenAI Codex', 'not-a-brand'))).toBe('codex')
  })

  it('knows the agents this app ships with or registers', () => {
    expect(brandForRuntime(runtime('codex', 'OpenAI Codex'))).toBe('codex')
    expect(brandForRuntime(runtime('claude-code', 'Claude Code'))).toBe('claudecode')
    expect(brandForRuntime(runtime('cursor', 'Cursor Agent'))).toBe('cursor')
    expect(brandForRuntime(runtime('gemini', 'Gemini CLI'))).toBe('geminicli')
    expect(brandForRuntime(runtime('copilot', 'GitHub Copilot CLI'))).toBe('githubcopilot')
    expect(brandForRuntime(runtime('cline', 'Cline'))).toBe('cline')
    expect(brandForRuntime(runtime('windsurf', 'Windsurf'))).toBe('windsurf')
    expect(brandForRuntime(runtime('ollama', 'Ollama'))).toBe('ollama')
    expect(brandForRuntime(runtime('router', 'OpenRouter'))).toBe('openrouter')
    expect(brandForRuntime(runtime('ds', 'DeepSeek Harness'))).toBe('deepseek')
  })

  it('reads the id when the name says nothing', () => {
    expect(brandForRuntime(runtime('claude-code', 'My Agent'))).toBe('claudecode')
  })

  /**
   * The public ACP registry, entry by entry.
   *
   * It hands the interface forty agents and a brand for none of them, so every
   * row here is placed by its id and name alone — both the registry's own,
   * from the document `acp-registry.ts` fetches. Null is a decision too: it
   * draws the generic glyph, which is what an agent lobe-icons has no mark for
   * should get. A table rather than a list of assertions so that adding a mark
   * is one edited cell, and so the count can be held against the catalogue.
   */
  const REGISTRY: readonly (readonly [string, string, Brand | null])[] = [
    ['agoragentic-acp', 'Agoragentic', null],
    ['amp-acp', 'Amp', 'amp'],
    ['antigravity-acp', 'Google Antigravity', 'antigravity'],
    ['auggie', 'Auggie CLI', null],
    ['autohand', 'Autohand Code', null],
    ['claude-acp', 'Claude Agent', 'claudecode'],
    ['cline', 'Cline', 'cline'],
    ['codebuddy-code', 'Codebuddy Code', 'codebuddy'],
    ['codex-acp', 'Codex', 'codex'],
    // Snowflake's, and LangChain's: the product has no mark of its own, so the
    // row wears the company's and says whose agent it is.
    ['cortex-code', 'Cortex Code', 'snowflake'],
    ['corust-agent', 'Corust Agent', null],
    ['crow-cli', 'crow-cli', null],
    ['cursor', 'Cursor', 'cursor'],
    ['deepagents', 'DeepAgents', 'langchain'],
    ['devin', 'Devin', 'devin'],
    ['dimcode', 'DimCode', null],
    ['dirac', 'Dirac', null],
    ['factory-droid', 'Factory Droid', null],
    ['fast-agent', 'fast-agent', null],
    ['gemini', 'Gemini CLI', 'geminicli'],
    ['github-copilot-cli', 'GitHub Copilot', 'githubcopilot'],
    ['glm-acp-agent', 'GLM Agent', 'zhipu'],
    ['goose', 'goose', 'goose'],
    ['grok-build', 'Grok Build', 'grok'],
    ['harn', 'Harn', null],
    ['junie', 'Junie', 'junie'],
    ['kilo', 'Kilo', 'kilocode'],
    ['kimi', 'Kimi CLI', 'kimi'],
    ['minion-code', 'Minion Code', null],
    ['mistral-vibe', 'Mistral Vibe', 'mistral'],
    // lobe-icons draws Amazon's Nova; this Nova is somebody else's agent of
    // the same name, and the wrong logo is worse than no logo.
    ['nova', 'Nova', null],
    ['opencode', 'OpenCode', 'opencode'],
    ['pi-acp', 'pi ACP', 'pi'],
    ['poolside', 'Poolside', 'poolside'],
    ['qoder', 'Qoder CLI', 'qoder'],
    ['qwen-code', 'Qwen Code', 'qwen'],
    ['sigit', 'siGit Code', null],
    ['stakpak', 'Stakpak', null],
    ['vtcode', 'VT Code', null],
  ]

  it.each(REGISTRY)('places the registry entry %s (%s)', (id, name, brand) => {
    expect(brandForRuntime(runtime(id, name))).toBe(brand)
  })

  it('covers the registry the app actually lists', () => {
    // The catalogue was thirty-nine when this was written. A registry that
    // grows is not a failure — it is the prompt to place the new agents above.
    expect(REGISTRY).toHaveLength(39)
    expect(new Set(REGISTRY.map(([id]) => id)).size).toBe(REGISTRY.length)
  })

  it('places the agents this build registers itself, brand declared or not', () => {
    expect(brandForRuntime(runtime('openclaw', 'OpenClaw', 'openclaw'))).toBe('openclaw')
    expect(brandForRuntime(runtime('hermes', 'Hermes Agent', 'hermesagent'))).toBe('hermesagent')
    // And by name alone, for a row that arrives without the host's brand.
    expect(brandForRuntime(runtime('openclaw', 'OpenClaw'))).toBe('openclaw')
    expect(brandForRuntime(runtime('hermes', 'Hermes Agent'))).toBe('hermesagent')
  })

  it('is null for an agent it cannot place', () => {
    expect(brandForRuntime(runtime('acme', 'Acme Agent'))).toBeNull()
  })
})

describe('brandForModel', () => {
  it('names the maker, not the agent offering the model', () => {
    expect(brandForModel('GPT-5.2', 'cursor')).toBe('openai')
    expect(brandForModel('claude-4-sonnet', 'cursor')).toBe('claude')
    expect(brandForModel('Cursor Grok 4.6', 'cursor')).toBe('grok')
    expect(brandForModel('gemini-2.5-pro', 'cursor')).toBe('gemini')
    expect(brandForModel('deepseek-v3', 'openrouter')).toBe('deepseek')
    expect(brandForModel('Kimi K2', 'cursor')).toBe('kimi')
  })

  it("gives OpenAI's agentic models the Codex mark and the rest the OpenAI one", () => {
    expect(brandForModel('gpt-5.3-codex', 'codex')).toBe('codex')
    expect(brandForModel('Codex 5.3', 'cursor')).toBe('codex')
    expect(brandForModel('gpt-5.4-mini', 'codex')).toBe('openai')
    expect(brandForModel('o3', 'codex')).toBe('openai')
    expect(brandForModel('o4-mini', 'codex')).toBe('openai')
  })

  it("gives the agent's own routing choice the agent's mark", () => {
    expect(brandForModel('Auto (default)', 'cursor')).toBe('cursor')
    expect(brandForModel('default', 'codex')).toBe('codex')
    expect(brandForModel('auto', null)).toBeNull()
  })

  it("gives Cursor's own models Cursor's mark", () => {
    expect(brandForModel('composer-1', 'cursor')).toBe('cursor')
  })

  it('is null for a model it cannot place, rather than guessing the agent', () => {
    expect(brandForModel('mystery-9000', 'cursor')).toBeNull()
  })

  it('does not mistake words that merely contain a maker', () => {
    // "gpt" must be a word start: "egpt" is nobody's model.
    expect(brandForModel('egpt', null)).toBeNull()
    // "o3" only as its own token, not inside "foo3".
    expect(brandForModel('foo3', null)).toBeNull()
  })
})

describe('the brand list', () => {
  it('has no duplicates and only lower-case keys, as lobe-icons names them', () => {
    expect(new Set(BRANDS).size).toBe(BRANDS.length)
    for (const brand of BRANDS) expect(brand).toMatch(/^[a-z]+$/)
  })

  it('answers isBrand for exactly its members', () => {
    expect(isBrand('codex')).toBe(true)
    expect(isBrand('Codex')).toBe(false)
    expect(isBrand(undefined)).toBe(false)
  })
})
