import type { UiDecoration } from './capability.js'

/**
 * The editor plane.
 *
 * Two planes were already drawn: who does the work (the agent), and what they
 * can do (the extension kernel). This is the second one reaching a surface
 * the person is looking at — a plugin annotating a file, formatting it,
 * showing what it would change — without one line of its code running in the
 * window.
 *
 * It is shaped after `ctx.browser` deliberately, down to the pull-drained
 * events, because the two problems are the same problem: something a plugin
 * wants to drive lives in a process the plugin is not in, and the honest
 * answer is a small set of verbs plus a buffer that is read on demand.
 *
 * Where it differs from the browser is *who holds the state*. The browser
 * pane answers DevTools calls directly, so the engine can round-trip to it.
 * A CodeMirror view lives in the renderer, and the browser⇄host wire is
 * client-initiated only — the host may push, but it may never ask and wait.
 * So the plane is **host-owned and the renderer projects it**: `open`,
 * `applyEdits` and `decorate` change the host's own record and are pushed
 * down; what the person then does comes back up as reports. Nothing in this
 * file requires the host to interrogate a window, which is what keeps it
 * working when there are two windows, or none.
 */

/**
 * One replacement, in the same 1-based inclusive lines a decoration uses.
 *
 * Lines rather than character offsets, for the same reason: a plugin that
 * computed this has line numbers — from a formatter, a codemod, a linter's
 * fix — and asking it for offsets would mean asking it to model the
 * document's newlines, which it has no reliable way to do from a copy it
 * read some time ago.
 *
 * `toLine` absent replaces one line. `text` empty deletes the range; `text`
 * with no trailing newline still ends the line, because a replacement that
 * silently joined the next one would be a corruption a plugin could not see
 * coming.
 */
export interface EditorEdit {
  readonly fromLine: number
  readonly toLine?: number
  readonly text: string
}

/**
 * A file the plane is holding open, and what has been said about it.
 *
 * Deliberately carries no runtime. A path is a path on this machine, and the
 * plane is not per-conversation: the window opens it through whichever
 * runtime that window is looking at, the same way it opens any other file.
 * A field here would be a second answer to a question the renderer already
 * answers, and the two would disagree the first time someone switched panes.
 */
export interface EditorDocument {
  readonly path: string
  /**
   * Which plugin asked. Carried so the interface can say who is marking a
   * person's file — an unattributed annotation appearing in someone's editor
   * is indistinguishable from the app having an opinion.
   */
  readonly pluginId: string
  readonly decorations: readonly UiDecoration[]
  readonly openedAt: number
}

/**
 * What happened in an editor, for whoever drains it.
 *
 * `changed` is typing, `saved` is disk. A formatter wants the second and a
 * linter wants the first, and collapsing them would make one of the two
 * wrong. Neither carries the file's text: a plugin that wants the content
 * reads it through `ctx.fs`, under the permission gate, rather than being
 * handed the contents of any file the person happens to open.
 */
export type EditorEvent =
  | { readonly kind: 'opened'; readonly path: string; readonly at: number }
  | { readonly kind: 'closed'; readonly path: string; readonly at: number }
  | { readonly kind: 'changed'; readonly path: string; readonly at: number }
  | { readonly kind: 'saved'; readonly path: string; readonly at: number; readonly hash: string }

/**
 * Applies line edits to text.
 *
 * Shared rather than duplicated because both ends need the same answer: the
 * host performs the write, and its tests assert against the same function a
 * plugin's expectations are formed by. Edits are applied from the bottom up
 * so earlier line numbers stay valid as later ones are replaced — the bug
 * every top-down implementation of this has, and it only shows when a plugin
 * sends more than one.
 */
export const applyLineEdits = (source: string, edits: readonly EditorEdit[]): string => {
  if (edits.length === 0) return source
  // A trailing newline is a line in every editor and not in `split`, so it is
  // taken off here and put back at the end. Without that, editing the last
  // line of a file silently strips the newline the file ended with.
  const trailing = source.endsWith('\n')
  const lines = (trailing ? source.slice(0, -1) : source).split('\n')
  const ordered = edits
    .map((edit, index) => {
      const from = Math.min(Math.max(1, Math.trunc(edit.fromLine)), lines.length + 1)
      const to = Math.min(Math.max(from, Math.trunc(edit.toLine ?? from)), lines.length)
      return { from, to, text: edit.text, asked: Math.trunc(edit.fromLine), index }
    })
    /* From the bottom up, so each splice leaves the lines above it where the
       edits above expect them. Two appends past the end clamp to the same
       line, and by that line alone the later one went in first — `A` then `B`
       came out `B`, `A` (#61). So a tie goes by the line each asked for, and
       two appends that asked for the same one go in reverse, which leaves
       them in the order given. Replacements that share a line keep the order
       they always had. */
    .sort(
      (a, b) =>
        b.from - a.from || b.asked - a.asked || (a.to < a.from && b.to < b.from ? b.index - a.index : 0),
    )
  for (const edit of ordered) {
    // `text: ''` deletes; anything else replaces, and a multi-line
    // replacement splits into the lines it actually contains rather than
    // becoming one line with newlines inside it.
    const replacement = edit.text === '' ? [] : edit.text.split('\n')
    lines.splice(edit.from - 1, edit.to - edit.from + 1, ...replacement)
  }
  const out = lines.join('\n')
  return trailing ? `${out}\n` : out
}
