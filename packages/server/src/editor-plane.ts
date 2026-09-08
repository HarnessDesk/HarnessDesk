import {
  applyLineEdits,
  type EditorDocument,
  type EditorEdit,
  type EditorEvent,
  type RuntimeFiles,
  type UiDecoration,
  type WireNotification,
} from '@harnessdesk/protocol'
import type { EditorEngine } from '@harnessdesk/cordis-host'

import { asText, confine, sha256 } from './workspace.js'

/**
 * The editor plane, host-side.
 *
 * The plane is **host-owned and the renderer projects it**. That is not an
 * implementation detail, it is the design: the browser⇄host wire is
 * client-initiated only — the host may push, but it may never ask a window a
 * question and wait for the answer. A plane that lived in the renderer would
 * therefore need the wire inverted, and with two windows open it would need
 * an answer to "which one?" that nobody has.
 *
 * So `open`, `decorate` and `applyEdits` change this record and are pushed
 * down; every window renders the same plane; and a plugin calling `open` on a
 * host with no window at all is recorded rather than refused, because a
 * window opening a moment later should show what was asked for. A plugin
 * never has to ask whether anybody is looking, which is the one question it
 * has no way to answer.
 *
 * What comes back up are *reports* — `editor/report` on the wire — buffered
 * here per draining plugin.
 */

/** How many events are kept for a plugin that never drains. */
const EVENT_CAP = 500

interface Held {
  readonly path: string
  readonly openedAt: number
  /**
   * Marks by the plugin that set them.
   *
   * Kept apart rather than merged into one list because clearing is
   * per-plugin: a linter calling `clearDecorations` must not take a review's
   * findings off the same file with it.
   */
  readonly decorations: Map<string, readonly UiDecoration[]>
  /** Who opened it, for attribution when no plugin has marked it. */
  readonly openedBy: string
}

export interface EditorPlaneOptions {
  /**
   * The filesystem view that reads and writes.
   *
   * The host's local view, not a runtime's. The plane is not tied to a
   * conversation, so there is no runtime to ask — and a path is a path on
   * this machine for every runtime that exists today. A runtime whose files
   * lived elsewhere would need the plane to carry one; that is a change to
   * make when such a runtime exists, not a parameter nobody can fill in.
   */
  readonly files: () => RuntimeFiles
  /** The paths a plugin may reach — the same roots the renderer is held to. */
  readonly roots: () => string[]
  readonly push: (notification: WireNotification) => void
  readonly log?: (level: 'warn' | 'info', message: string) => void
}

export class EditorPlane implements EditorEngine {
  readonly #documents = new Map<string, Held>()
  /** One queue per draining plugin; see `EditorEngine.drain`. */
  readonly #events = new Map<string, EditorEvent[]>()
  /** Plugins that have drained at least once, so nothing is buffered for nobody. */
  readonly #drainers = new Set<string>()

  constructor(private readonly options: EditorPlaneOptions) {}

  // ------------------------------------------------------------ the plugins' side

  async open(path: string, pluginId: string): Promise<void> {
    const target = this.#confine(path)
    const existing = this.#documents.get(target)
    if (existing) {
      // Already shown. Re-opening is not an error and must not reset the
      // marks another plugin has put on it.
      return
    }
    this.#documents.set(target, {
      path: target,
      openedAt: Date.now(),
      decorations: new Map(),
      openedBy: pluginId,
    })
    this.#publish()
  }

  async decorate(
    path: string,
    decorations: readonly UiDecoration[],
    pluginId: string,
  ): Promise<void> {
    const target = this.#confine(path)
    // Marking a file that is not open opens it. A plugin that has found
    // something worth pointing at should not also have to remember to ask
    // for the file first, and the alternative — dropping the marks — is a
    // silent failure.
    if (!this.#documents.has(target)) await this.open(target, pluginId)
    const held = this.#documents.get(target)
    if (!held) return
    if (decorations.length === 0) held.decorations.delete(pluginId)
    else held.decorations.set(pluginId, decorations)
    this.#publish()
  }

  async applyEdits(
    path: string,
    edits: readonly EditorEdit[],
    pluginId: string,
  ): Promise<{ hash: string }> {
    const target = this.#confine(path)
    const files = this.options.files()
    if (!files.write) {
      throw new Error('This runtime cannot write files from the interface.')
    }
    const before = await files.read(target)
    // The plugin gets text, not bytes: an edit is expressed in lines, and a
    // file this cannot decode as text is a file a line edit cannot describe.
    const { content, truncated } = asText(before)
    if (truncated) {
      throw new Error(`${target} is too large to edit through the editor plane.`)
    }
    const after = applyLineEdits(content, edits)
    const bytes = Buffer.from(after, 'utf8')
    await files.write(target, bytes)
    // The person is shown what was changed to their file, rather than finding
    // it later. Opening is idempotent, so an already-open file just stays.
    await this.open(target, pluginId)
    const hash = sha256(bytes)
    // A write is something that happened to the document, so it goes in the
    // same queue the person's own saves do — including, deliberately, back to
    // the plugin that made it. A formatter that re-formats its own output is
    // a bug in the formatter, and hiding the event would hide it.
    this.#record({ kind: 'saved', path: target, at: Date.now(), hash })
    return { hash }
  }

  async close(path: string): Promise<void> {
    const target = this.#confine(path)
    if (!this.#documents.delete(target)) return
    this.#publish()
  }

  async drain(pluginId: string): Promise<readonly EditorEvent[]> {
    this.#drainers.add(pluginId)
    const queued = this.#events.get(pluginId) ?? []
    this.#events.set(pluginId, [])
    return queued
  }

  // ------------------------------------------------------------ the window's side

  /** A window reporting what the person did. Never fails a report. */
  report(event: EditorEvent): void {
    this.#record(event)
  }

  /** The plane as the wire carries it. */
  documents(): readonly EditorDocument[] {
    return [...this.#documents.values()].map((held) => ({
      path: held.path,
      // Whoever marked it, else whoever opened it. A file with marks from two
      // plugins names the first to have marked it, which is imprecise and
      // still better than naming the one that merely opened it.
      pluginId: [...held.decorations.keys()][0] ?? held.openedBy,
      decorations: [...held.decorations.values()].flat(),
      openedAt: held.openedAt,
    }))
  }

  /** Sent to a client that has just connected, so it renders without replaying. */
  notification(): WireNotification {
    return { method: 'editor/plane', params: { documents: this.documents() } }
  }

  // ------------------------------------------------------------------- internals

  #record(event: EditorEvent): void {
    // Buffered only for plugins that have shown they read. Without this, a
    // host with no editor-aware plugin installed would accumulate every
    // keystroke's worth of `changed` for nobody, forever.
    for (const pluginId of this.#drainers) {
      const queue = this.#events.get(pluginId) ?? []
      queue.push(event)
      // Oldest out. A plugin that stopped draining has stopped caring about
      // the beginning, and an unbounded queue is a leak with a slow fuse.
      this.#events.set(pluginId, queue.length > EVENT_CAP ? queue.slice(-EVENT_CAP) : queue)
    }
  }

  #publish(): void {
    this.options.push(this.notification())
  }

  /**
   * The same confinement the renderer is held to.
   *
   * A plugin's own permission gate has already checked this path against the
   * workspace it was granted. This is the second check, on the host's own
   * terms, because the two answer different questions: the gate asks what
   * this plugin may reach, and this asks what is open at all.
   */
  #confine(path: string): string {
    return confine(path, this.options.roots())
  }
}
