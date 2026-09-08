import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from '@codemirror/language'
import { lintGutter, linter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { Extension, Text } from '@codemirror/state'

import type { UiDecoration } from '@harnessdesk/protocol'

/**
 * CodeMirror, wired to HarnessDesk's tokens.
 *
 * Two rules shape this file.
 *
 * **Grammars load lazily, by name.** The same discipline `lib/highlight.ts`
 * applies to Shiki applies here: an explicit loader table, one dynamic import
 * per language, nothing in the initial chunk. The editor opens on plain text
 * and reconfigures when its grammar lands, which is a frame or two later and
 * invisible — where eagerly importing every grammar would put several
 * megabytes into the first paint of an app that mostly shows conversations.
 *
 * **Colour comes from CSS, not from a theme object.** Every value below is a
 * `var(--hd-code-*)` reference resolved by `styles/editor.css`, so switching
 * palette or theme re-colours a mounted editor with no React involved and no
 * editor rebuild. That indirection is also the seam an editor theme
 * contributed by a plugin will re-ground: it sets the tokens, and every
 * mounted view follows.
 *
 * Shiki stays where it was — the conversation transcript. Two highlighters
 * sounds like one too many, and it is worth being plain about why it is not:
 * a transcript renders hundreds of short static blocks, where Shiki's
 * HTML-in, HTML-out shape costs nothing and reuses the DOM the message
 * already builds. An editor needs an incremental parse tree it can decorate,
 * fold, and re-highlight per keystroke, which is the thing Shiki cannot do.
 */

/** A grammar, however it is packaged. `null` means "no highlighting for this". */
type LanguageLoader = () => Promise<Extension>

const stream = (load: () => Promise<StreamParser<unknown>>): LanguageLoader => async () =>
  StreamLanguage.define(await load())

/**
 * Every language the editor can highlight, keyed by canonical name.
 *
 * Lezer grammars where one exists — they give a real tree, which is what
 * folding, bracket matching and indentation read. Stream parsers from
 * `legacy-modes` for the long tail, which highlight correctly and do nothing
 * else; that is the honest trade for a language nobody opens twice a month.
 */
const LOADERS: Record<string, LanguageLoader> = {
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  python: async () => (await import('@codemirror/lang-python')).python(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  go: async () => (await import('@codemirror/lang-go')).go(),

  shell: stream(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  ruby: stream(async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  swift: stream(async () => (await import('@codemirror/legacy-modes/mode/swift')).swift),
  toml: stream(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml),
  diff: stream(async () => (await import('@codemirror/legacy-modes/mode/diff')).diff),
  lua: stream(async () => (await import('@codemirror/legacy-modes/mode/lua')).lua),
  perl: stream(async () => (await import('@codemirror/legacy-modes/mode/perl')).perl),
  r: stream(async () => (await import('@codemirror/legacy-modes/mode/r')).r),
  haskell: stream(async () => (await import('@codemirror/legacy-modes/mode/haskell')).haskell),
  powershell: stream(async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  dockerfile: stream(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
  nginx: stream(async () => (await import('@codemirror/legacy-modes/mode/nginx')).nginx),
  properties: stream(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties),
  protobuf: stream(async () => (await import('@codemirror/legacy-modes/mode/protobuf')).protobuf),
  kotlin: stream(async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  scala: stream(async () => (await import('@codemirror/legacy-modes/mode/clike')).scala),
  csharp: stream(async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp),
}

/**
 * File extensions and the names people type in a fence, mapped to a grammar.
 *
 * Deliberately the same aliases `lib/highlight.ts` accepts, plus the ones an
 * editor sees that a transcript does not — dotfiles arrive here as their own
 * extension, and `Dockerfile` arrives with none at all.
 */
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
  if (whole in LOADERS) return whole
  const ext = lower.includes('.') ? (lower.split('.').pop() ?? '') : ''
  const resolved = ALIASES[ext] ?? ext
  return resolved in LOADERS ? resolved : null
}

const cache = new Map<string, Extension>()
const pending = new Map<string, Promise<Extension | null>>()

/**
 * Loads one grammar. Resolves to null for an unknown language or a failed
 * import, which callers render as plain text — an editor that refused to open
 * because a grammar chunk 404'd would be a far worse failure than an
 * uncoloured one.
 */
export const loadLanguage = async (name: string | null): Promise<Extension | null> => {
  if (!name) return null
  const hit = cache.get(name)
  if (hit) return hit
  const inFlight = pending.get(name)
  if (inFlight) return inFlight
  const loader = LOADERS[name]
  if (!loader) return null
  const promise = loader()
    .then((extension) => {
      cache.set(name, extension)
      return extension
    })
    .catch(() => null)
    .finally(() => pending.delete(name))
  pending.set(name, promise)
  return promise
}

/** Every language name the editor knows, for settings and tests. */
export const knownLanguages = (): readonly string[] => Object.keys(LOADERS).sort()

// ------------------------------------------------------------------- theming

/**
 * Token colours, as references into `styles/editor.css`.
 *
 * `HighlightStyle` is built once and never rebuilt: because every value is a
 * `var()`, the same object is correct in light, dark, Blueprint and
 * Editorial. Rebuilding it per theme — the obvious first draft — produced a
 * new StyleModule on every toggle and leaked a stylesheet per switch.
 */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.moduleKeyword, tags.controlKeyword], color: 'var(--hd-code-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--hd-code-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--hd-code-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--hd-code-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--hd-code-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.definition(tags.typeName)], color: 'var(--hd-code-type)' },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: 'var(--hd-code-variable)' },
  { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName), tags.atom], color: 'var(--hd-code-constant)' },
  { tag: [tags.operator, tags.operatorKeyword, tags.derefOperator], color: 'var(--hd-code-operator)' },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.paren, tags.brace], color: 'var(--hd-code-punctuation)' },
  { tag: [tags.invalid], color: 'var(--hd-code-invalid)' },
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: 'var(--hd-code-heading)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--hd-code-link)', textDecoration: 'underline' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.strong], fontWeight: '600' },
  { tag: [tags.strikethrough], textDecoration: 'line-through' },
  { tag: [tags.inserted], color: 'var(--hd-code-string)' },
  { tag: [tags.deleted], color: 'var(--hd-code-invalid)' },
])

export interface EditorLook {
  readonly fontFamily: string
  readonly fontSize: number
  readonly lineHeight: number
}

/**
 * The editor's chrome, as a CodeMirror theme.
 *
 * Rebuilt when the *look* changes (font, size) but not when the theme does,
 * for the reason above: colour is a token, so a dark switch needs no new
 * StyleModule. `dark` still crosses over because CodeMirror uses it for
 * things CSS cannot reach from here — which selection layer wins, and the
 * default caret it draws before ours applies.
 */
export const editorTheme = (look: EditorLook, dark: boolean): Extension =>
  EditorView.theme(
    {
      '&': {
        height: '100%',
        fontFamily: look.fontFamily,
        fontSize: `${look.fontSize}px`,
        backgroundColor: 'transparent',
        color: 'var(--hdp-alias-label-primary)',
      },
      '.cm-scroller': {
        fontFamily: 'inherit',
        lineHeight: String(look.lineHeight),
        // The pane owns the scroll container's inset; the editor's own
        // padding would double it at the top of the first line.
        padding: '8px 0',
      },
      '.cm-content': { padding: '0' },
      '.cm-line': { padding: '0 16px' },
      '.cm-gutters': {
        backgroundColor: 'var(--hd-code-gutter-bg)',
        color: 'var(--hd-code-gutter-fg)',
        border: 'none',
        paddingLeft: '8px',
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px', minWidth: '2.2em' },
      '.cm-activeLine': { backgroundColor: 'var(--hd-code-active-line)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--hdp-alias-label-secondary)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--hd-code-cursor)', borderLeftWidth: '2px' },
      // CodeMirror draws selection on two different elements depending on
      // whether the view is focused, and styling only one leaves the
      // selection invisible the moment the pane loses focus.
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--hd-code-selection)',
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--hd-code-matching-bracket)',
        outline: 'none',
      },
      '.cm-nonmatchingBracket': { color: 'var(--hd-code-invalid)' },
      '.cm-searchMatch': { backgroundColor: 'var(--hd-code-search-match)' },
      '.cm-searchMatch.cm-searchMatch-selected': { outline: '1px solid var(--hd-code-cursor)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--hdp-alias-interactive-bg-hover)',
        border: 'none',
        color: 'var(--hdp-alias-label-secondary)',
        padding: '0 6px',
        borderRadius: '4px',
      },
      '.cm-panels': {
        backgroundColor: 'var(--hdp-alias-bg-layer-1)',
        color: 'var(--hdp-alias-label-primary)',
        borderColor: 'var(--hdp-alias-border-l1)',
      },
      '.cm-panel input, .cm-panel button': {
        fontFamily: 'inherit',
        backgroundColor: 'var(--hdp-alias-bg-base)',
        color: 'var(--hdp-alias-label-primary)',
        border: '1px solid var(--hdp-alias-border-l1)',
        borderRadius: '4px',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--hdp-alias-bg-layer-1)',
        border: '1px solid var(--hdp-alias-border-l1)',
        borderRadius: '6px',
        color: 'var(--hdp-alias-label-primary)',
      },
    },
    { dark },
  )

/** Theme plus token colours — what every editor mounts with. */
export const look = (settings: EditorLook, dark: boolean): Extension => [
  editorTheme(settings, dark),
  syntaxHighlighting(codeHighlightStyle),
]

// --------------------------------------------------------------- diagnostics

/**
 * Marked lines, from whoever is doing the marking.
 *
 * A plugin computing diagnostics — a linter, a type checker, a review pass —
 * has line numbers and a message, and little else it could reasonably be
 * asked for. So `UiDecoration` is line-based, 1-based and inclusive, which is
 * how every compiler and stack trace it will be reading already counts; the
 * one conversion into CodeMirror's character offsets happens here, once,
 * instead of in every plugin that ever reports one.
 *
 * This routes through `@codemirror/lint` rather than a hand-rolled line
 * decoration because everything a diagnostic needs beyond a coloured row —
 * the underline, the hover carrying the message, the panel that lists them,
 * the keyboard walk between them — is already in that package and would
 * otherwise be re-implemented worse. `severity: 'hint'` is ours: the linter
 * knows three, so a hint travels as an info wearing its own class.
 */
export const asDiagnostics = (marks: readonly UiDecoration[], doc: Text): readonly Diagnostic[] => {
  const total = doc.lines
  const out: Diagnostic[] = []
  for (const mark of marks) {
    // A plugin reporting against a file that has since been edited will name
    // lines that no longer exist. Clamping shows the diagnostic at the end of
    // the document rather than throwing inside the editor's own update cycle.
    const first = Math.min(Math.max(1, Math.trunc(mark.fromLine)), total)
    const last = Math.min(Math.max(first, Math.trunc(mark.toLine ?? first)), total)
    out.push({
      from: doc.line(first).from,
      to: doc.line(last).to,
      severity: mark.severity === 'hint' ? 'info' : mark.severity,
      ...(mark.severity === 'hint' ? { markClass: 'hd-diag-hint' } : {}),
      message: mark.message ?? '',
    })
  }
  // `setDiagnostics` requires them ordered by position, and a plugin has no
  // reason to have sorted its own output.
  return out.sort((a, b) => a.from - b.from || a.to - b.to)
}

/**
 * The lint machinery, without a linter.
 *
 * `linter(null)` installs the state field, the gutter and the panel but
 * registers no source, so nothing re-runs on every keystroke: diagnostics
 * arrive only when someone dispatches `setDiagnostics`. A plugin's marks are
 * *reported*, not computed here, and a source that recomputed them would be
 * computing them from data this process does not have.
 */
export const diagnosticsExtension = (): Extension => [linter(null), lintGutter({ hoverTime: 200 })]

/** Puts a plugin's marks on a running view; an empty list clears them. */
export const applyDecorations = (view: EditorView, marks: readonly UiDecoration[]): void => {
  view.dispatch(setDiagnostics(view.state, asDiagnostics(marks, view.state.doc)))
}
