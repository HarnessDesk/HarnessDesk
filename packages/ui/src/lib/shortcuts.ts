/**
 * Every key the window itself answers to.
 *
 * One table, read by two places: the handler in the app shell dispatches from
 * it, and the Keyboard shortcuts page prints it. Before this they were two
 * lists, which is the arrangement where a page confidently documents a key
 * that stopped working three commits ago.
 *
 * Keys inside a component — Escape in a dialog, ↑ in the composer — are not
 * here. They belong to whatever has focus, and a global table that claimed
 * them would be lying about who wins.
 *
 * Two of these chords are owned by a surface as well as by the window. The
 * browser pane steps its page's history on ⌘[ and ⌘], and the file editor
 * outdents and indents on the same pair — CodeMirror's `defaultKeymap` binds
 * `Mod-[` and `Mod-]`. Both say so the way the DOM says it: the pane stops
 * the event in the capture phase, so it never reaches the window's handler at
 * all, and the editor marks it handled, so it arrives with `defaultPrevented`
 * set. `shortcutFor` answers null for that second case, which is what keeps
 * ⌘[ from outdenting a line *and* navigating away from the file it was typed
 * in.
 *
 * Having focus is not the claim; answering the key is. A composer, a filter
 * box, any plain input or textarea binds neither bracket, so the event
 * arrives unmarked and the window still answers — which is the whole point of
 * giving back and forward a key that no width can fold away.
 */

export interface Shortcut {
  /** The action name `run()` dispatches on. */
  readonly action: string
  readonly label: string
  /** The letter or punctuation, lower-case; matched against `event.key`. */
  readonly key: string
  /** Whether Shift is part of the chord. Absent means it must not be held. */
  readonly shift?: boolean
  /** Which group it belongs to on the shortcuts page. */
  readonly group: 'Sessions' | 'Window' | 'Finding things'
}

export const SHORTCUTS: readonly Shortcut[] = [
  { action: 'new-session', label: 'New session', key: 'n', group: 'Sessions' },
  { action: 'open-folder', label: 'Open folder…', key: 'o', group: 'Sessions' },
  { action: 'close-pane', label: 'Close the focused pane', key: 'w', group: 'Sessions' },
  { action: 'toggle-sidebar', label: 'Show or hide the sidebar', key: 'b', group: 'Window' },
  /* Back and forward through what the middle has shown. The header's arrows
     are the other route and they fold away in a header under 520px, which a
     wide window reaches as soon as a panel is docked beside the conversation
     — so the pair needs a way in that no width can take. ⌘[ and ⌘] because
     that is what a browser binds them to, and because the browser pane
     already answers to them for its own page: its handler runs in the
     capture phase and stops the event, so a focused page still wins. */
  { action: 'nav-back', label: 'Back', key: '[', group: 'Window' },
  { action: 'nav-forward', label: 'Forward', key: ']', group: 'Window' },
  { action: 'show-changes', label: 'Show changes', key: 'd', shift: true, group: 'Window' },
  { action: 'settings', label: 'Settings', key: ',', group: 'Window' },
  { action: 'usage', label: 'Dashboard', key: 'u', group: 'Window' },
  { action: 'palette', label: 'Command palette', key: 'k', group: 'Finding things' },
]

/**
 * The chord a key event is, or null when it is not ours to answer.
 *
 * `metaKey || ctrlKey` rather than platform detection: this app is macOS
 * today, and a Linux build with Control would otherwise silently answer to
 * nothing at all.
 *
 * `defaultPrevented` is the other half of the question. A window-wide chord
 * runs on top of whatever has focus, so the one thing it must not do is fire
 * a second meaning onto a key the focused surface has already spent. The flag
 * is the DOM's own record of that, set by anything that handled the event —
 * no list of surfaces to keep up to date, and nothing here that names the
 * editor. Optional because most callers build the chord by hand; absent reads
 * as unhandled, which is what a synthesised chord is.
 */
export const shortcutFor = (event: {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly defaultPrevented?: boolean
}): Shortcut | null => {
  if (event.defaultPrevented) return null
  if (!(event.metaKey || event.ctrlKey)) return null
  const key = event.key.toLowerCase()
  return (
    SHORTCUTS.find(
      (shortcut) => shortcut.key === key && Boolean(shortcut.shift) === event.shiftKey,
    ) ?? null
  )
}

/** How a chord is written where a person reads it: ⇧⌘D, ⌘,. */
export const chordOf = (shortcut: Shortcut): string =>
  `${shortcut.shift ? '⇧' : ''}⌘${shortcut.key === ',' ? ',' : shortcut.key.toUpperCase()}`
