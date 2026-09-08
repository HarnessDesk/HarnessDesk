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
  { action: 'show-changes', label: 'Show changes', key: 'd', shift: true, group: 'Window' },
  { action: 'settings', label: 'Settings', key: ',', group: 'Window' },
  { action: 'usage', label: 'Dashboard', key: 'u', group: 'Window' },
  { action: 'palette', label: 'Command palette', key: 'k', group: 'Finding things' },
]

/**
 * The chord a key event is, or null when it is not one of ours.
 *
 * `metaKey || ctrlKey` rather than platform detection: this app is macOS
 * today, and a Linux build with Control would otherwise silently answer to
 * nothing at all.
 */
export const shortcutFor = (event: {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
}): Shortcut | null => {
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
