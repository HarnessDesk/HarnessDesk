import type { HighlighterCore } from 'shiki/core'

/**
 * Lazy, fine-grained syntax highlighting.
 *
 * `shiki`'s default entry references every grammar it ships, which drags ~4MB of
 * languages into the bundle for a desktop app that will realistically show a
 * dozen. This uses `shiki/core` with an explicit language list and the
 * JavaScript regex engine, which also avoids shipping the Oniguruma WASM.
 *
 * Loading is deferred until the first code block appears, and mounted blocks
 * repaint once grammars arrive.
 */

const LOADERS = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
} as const

type Language = keyof typeof LOADERS

const ALIASES: Record<string, Language> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  patch: 'diff',
  'c++': 'cpp',
  h: 'c',
  kt: 'kotlin',
  md: 'markdown',
  xml: 'html',
}

let highlighter: HighlighterCore | null = null
let creating: Promise<HighlighterCore> | null = null
const loaded = new Set<Language>()
const loading = new Set<Language>()
const listeners = new Set<() => void>()

const announce = (): void => {
  for (const listener of listeners) listener()
}

export const normaliseLanguage = (language: string | undefined): Language | null => {
  if (!language) return null
  const lower = language.toLowerCase().trim()
  const resolved = ALIASES[lower] ?? lower
  return resolved in LOADERS ? (resolved as Language) : null
}

/** Fires when a grammar finishes loading, so mounted code blocks can repaint. */
export const onHighlighterReady = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const ensureCore = async (): Promise<HighlighterCore> => {
  if (highlighter) return highlighter
  if (creating) return creating
  creating = (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs'),
      ])
    highlighter = await createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })
    return highlighter
  })()
  return creating
}

const ensureLanguage = async (language: Language): Promise<void> => {
  if (loaded.has(language) || loading.has(language)) return
  loading.add(language)
  try {
    const core = await ensureCore()
    const grammar = await LOADERS[language]()
    await core.loadLanguage(grammar.default)
    loaded.add(language)
    announce()
  } finally {
    loading.delete(language)
  }
}

/**
 * Returns highlighted HTML, or null while the grammar is still loading or the
 * language is unsupported. Callers render plain text in that case — an empty
 * block would be worse than an unstyled one.
 */
export const highlight = (
  code: string,
  language: string | undefined,
  dark: boolean,
): string | null => {
  const resolved = normaliseLanguage(language)
  if (!resolved) return null
  if (!highlighter || !loaded.has(resolved)) {
    void ensureLanguage(resolved)
    return null
  }
  try {
    return highlighter.codeToHtml(code, {
      lang: resolved,
      theme: dark ? 'github-dark' : 'github-light',
    })
  } catch {
    return null
  }
}

/** Warms the core so the first code block does not wait on the engine too. */
export const ensureHighlighter = (): void => {
  void ensureCore()
}
