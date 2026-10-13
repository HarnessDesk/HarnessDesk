// Path grammar names without loading the editor engine.
const LANGUAGE_NAMES: Readonly<Record<string, true>> = {
  javascript: true,
  typescript: true,
  python: true,
  json: true,
  markdown: true,
  html: true,
  css: true,
  rust: true,
  java: true,
  cpp: true,
  xml: true,
  sql: true,
  yaml: true,
  php: true,
  go: true,
  shell: true,
  ruby: true,
  swift: true,
  toml: true,
  diff: true,
  lua: true,
  perl: true,
  r: true,
  haskell: true,
  powershell: true,
  dockerfile: true,
  nginx: true,
  properties: true,
  protobuf: true,
  kotlin: true,
  scala: true,
  csharp: true,
}

const ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  console: 'shell',
  yml: 'yaml',
  patch: 'diff',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  c: 'cpp',
  h: 'cpp',
  m: 'cpp',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  scss: 'css',
  sass: 'css',
  less: 'css',
  cs: 'csharp',
  ps1: 'powershell',
  pl: 'perl',
  pm: 'perl',
  jsonc: 'json',
  json5: 'json',
  ini: 'properties',
  conf: 'properties',
  env: 'properties',
  proto: 'protobuf',
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  gitignore: 'properties',
  gitattributes: 'properties',
  editorconfig: 'properties',
}

/**
 * The grammar for a path, or null.
 *
 * Takes the whole path rather than an extension because the answer sometimes
 * is not in one: `Dockerfile`, `Makefile` and `.gitignore` have no extension
 * or *are* their extension, and a pane that opens them unhighlighted looks
 * broken in a way a rare language does not.
 */
export const languageForPath = (path: string | null | undefined): string | null => {
  if (!path) return null
  const file = path.split(/[\\/]/).pop() ?? ''
  const lower = file.toLowerCase()
  // A leading-dot file is its own name: `.gitignore` has no extension, and
  // `split('.').pop()` would happily answer `gitignore` for `.gitignore` but
  // `local` for `.env.local` — so match the whole name first.
  const whole = lower.startsWith('.') ? lower.slice(1) : lower
  if (whole in ALIASES) return ALIASES[whole] ?? null
  if (whole in LANGUAGE_NAMES) return whole
  const ext = lower.includes('.') ? (lower.split('.').pop() ?? '') : ''
  const resolved = ALIASES[ext] ?? ext
  return resolved in LANGUAGE_NAMES ? resolved : null
}

