/**
 * The editor's standing appearance, and how it is read back off the host.
 *
 * Kept out of `store.ts` for the same reason `notice-policy` and
 * `system-notifications` are: hydration of a preference written by an older
 * build is validation work, not state work, and it is worth being able to
 * test it without a store.
 *
 * Every field is clamped rather than trusted. These values reach CodeMirror
 * as CSS, so a stored `fontSize: 0` from a bad write — or from a hand-edited
 * preferences file — would render an unreadable pane with no way back to the
 * setting that caused it.
 */

export interface EditorPrefs {
  /** Empty means "follow the app's code face"; see the note in `store.ts`. */
  readonly fontFamily: string
  readonly fontSize: number
  readonly lineHeight: number
  readonly lineNumbers: boolean
  readonly wrap: boolean
  readonly tabSize: number
}

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  fontFamily: '',
  fontSize: 13,
  lineHeight: 1.55,
  lineNumbers: true,
  wrap: false,
  tabSize: 2,
}

/** The token the empty `fontFamily` resolves to, so the palette keeps reaching it. */
export const INHERITED_CODE_FACE = 'var(--hdp-font-family-code)'

export const FONT_SIZES = [11, 12, 13, 14, 16] as const
export const TAB_SIZES = [2, 4, 8] as const

/**
 * Coding faces worth offering, in the order they are preferred.
 *
 * Offered only when actually installed — a picker listing fonts the machine
 * does not have is a list of ways to make the editor look wrong. The check
 * happens in the renderer, so it lives beside the list rather than in it.
 */
export const CANDIDATE_FACES: readonly { readonly name: string; readonly stack: string }[] = [
  { name: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, monospace" },
  { name: 'Fira Code', stack: "'Fira Code', ui-monospace, monospace" },
  { name: 'IBM Plex Mono', stack: "'IBM Plex Mono', ui-monospace, monospace" },
  { name: 'Source Code Pro', stack: "'Source Code Pro', ui-monospace, monospace" },
  { name: 'SF Mono', stack: "'SF Mono', ui-monospace, monospace" },
  { name: 'Menlo', stack: "Menlo, ui-monospace, monospace" },
  { name: 'Monaco', stack: "Monaco, ui-monospace, monospace" },
  { name: 'Cascadia Code', stack: "'Cascadia Code', ui-monospace, monospace" },
  { name: 'Consolas', stack: "Consolas, ui-monospace, monospace" },
]

/**
 * Which of the candidates this machine can actually draw.
 *
 * `document.fonts.check` answers for a family the browser can resolve, which
 * on a desktop app means installed. It throws on a malformed spec rather than
 * answering false, hence the guard — one unquotable family name must not
 * empty the whole list.
 */
export const installedFaces = (
  fonts: FontFaceSet | undefined = typeof document === 'undefined' ? undefined : document.fonts,
): readonly { readonly name: string; readonly stack: string }[] => {
  if (!fonts?.check) return []
  return CANDIDATE_FACES.filter((face) => {
    try {
      return fonts.check(`12px "${face.name}"`)
    } catch {
      return false
    }
  })
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** Reads a stored preference blob, filling and clamping whatever it lacks. */
export const readEditorPrefs = (raw: unknown): EditorPrefs => {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<EditorPrefs>
  return {
    fontFamily: typeof source.fontFamily === 'string' ? source.fontFamily : DEFAULT_EDITOR_PREFS.fontFamily,
    fontSize: clamp(source.fontSize, 9, 28, DEFAULT_EDITOR_PREFS.fontSize),
    lineHeight: clamp(source.lineHeight, 1.1, 2.4, DEFAULT_EDITOR_PREFS.lineHeight),
    lineNumbers: typeof source.lineNumbers === 'boolean' ? source.lineNumbers : DEFAULT_EDITOR_PREFS.lineNumbers,
    wrap: typeof source.wrap === 'boolean' ? source.wrap : DEFAULT_EDITOR_PREFS.wrap,
    // Anything else would indent with a width no formatter agrees with.
    tabSize: TAB_SIZES.includes(source.tabSize as (typeof TAB_SIZES)[number])
      ? (source.tabSize as number)
      : DEFAULT_EDITOR_PREFS.tabSize,
  }
}

/** What the editor mounts with: the preference, resolved to real CSS. */
export const editorLook = (prefs: EditorPrefs): { fontFamily: string; fontSize: number; lineHeight: number } => ({
  fontFamily: prefs.fontFamily.trim() === '' ? INHERITED_CODE_FACE : prefs.fontFamily,
  fontSize: prefs.fontSize,
  lineHeight: prefs.lineHeight,
})
