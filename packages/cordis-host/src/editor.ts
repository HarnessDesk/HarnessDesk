import { isAbsolute, resolve } from 'node:path'

import { Service, type Context } from '@deepseek-ai/cordis'

import { PermissionDenied } from './permissions.js'
import { currentActor } from './provenance.js'

import type { EditorEdit, EditorEvent, UiDecoration } from '@harnessdesk/protocol'

import type { HostRuntime } from './runtime.js'

/**
 * `ctx.editor` — the file the person is looking at, driven as data.
 *
 * The shape is `ctx.browser`'s, on purpose: a small set of verbs plus a
 * buffer read on demand, because both services solve the same problem — a
 * plugin wants to drive something that lives in a process it is not in.
 * Events are pulled here for the reason they are pulled there, written out
 * once in `extension-protocol` and not repeated.
 *
 * What a plugin can do:
 *
 * - **open** a file, which puts it in front of the person.
 * - **decorate** it — the diagnostics a linter, type checker or review pass
 *   produced, as line numbers and messages.
 * - **applyEdits** — what a formatter or codemod would change.
 * - **events** — what the person did since it last asked.
 *
 * What a plugin cannot do, and the list is the point: contribute a
 * component, register a CodeMirror extension, receive a keystroke, or read
 * the text of a file it was not already allowed to read. There is no
 * `ctx.editor.text()`; a plugin that wants content reads it through
 * `ctx.fs`, under the gate, so opening a file in the editor never becomes a
 * way to see files the manifest did not ask for.
 *
 * **Two grants, not one.** `editor` opens the surface — showing and marking
 * up. Writing needs `workspace.write` as well, so this cannot become a
 * second road to the disk that skips the permission a person actually read
 * on the consent dialog.
 */

/**
 * The plane's implementation, supplied by whoever is hosting.
 *
 * The server implements this against its own record of open documents and
 * pushes the result to every window. Unlike the browser service there is no
 * fallback engine, and there should not be: a browser can always be started,
 * whereas "the file the person is looking at" is meaningless in a process
 * with no host. A plugin calling into a process without one is told so
 * plainly rather than having its call quietly succeed against nothing.
 */
export interface EditorEngine {
  open(path: string, pluginId: string): Promise<void>
  applyEdits(
    path: string,
    edits: readonly EditorEdit[],
    pluginId: string,
  ): Promise<{ hash: string }>
  decorate(path: string, decorations: readonly UiDecoration[], pluginId: string): Promise<void>
  close(path: string): Promise<void>
  /**
   * Everything the person has done since *this plugin* last drained.
   *
   * Per-caller, where the browser's equivalent is one shared ring. The
   * difference is not an inconsistency: a browser has one page, so two
   * plugins reading the console are reading the same thing and racing over
   * it is at worst wasteful. Editor events are the person's activity, which
   * every interested plugin is entitled to all of — one shared ring would
   * mean a formatter and a linter silently starving each other, and the
   * symptom (a plugin that works alone and misses events once you install a
   * second) is one nobody would diagnose.
   */
  drain(pluginId: string): Promise<readonly EditorEvent[]>
}

/**
 * One plane per plugin host — module state, for the reason the browser's is:
 * cordis hands plugins a proxy of the service, which native `#private` fields
 * refuse.
 */
const state: { engine: EditorEngine | null } = { engine: null }

export const setEditorEngine = (engine: EditorEngine | null): void => {
  state.engine = engine
}

const engine = (): EditorEngine => {
  const found = state.engine
  if (!found) {
    throw new Error('This process has no editor: `ctx.editor` needs a running HarnessDesk host.')
  }
  return found
}

/** Relative paths resolve against the workspace, exactly as `ctx.fs` resolves them. */
const resolveInWorkspace = (runtime: HostRuntime, path: string): string => {
  if (isAbsolute(path)) return resolve(path)
  const root = runtime.workspace.root
  return root ? resolve(root, path) : resolve(path)
}

export class EditorService extends Service {
  static [Service.tracker] = { associate: 'editor', property: 'ctx' }

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'editor')
  }

  /**
   * Who is asking.
   *
   * The instance id is `<plugin id>#<n>` — built that way by the kernel — and
   * what a person needs to see attributed on a mark in their file is the
   * plugin, not which load of it. Splitting here rather than carrying a
   * second id keeps one source for the name.
   */
  private who(): string {
    const instanceId = this.runtime.owner(this.ctx).instanceId
    return instanceId.split('#')[0] ?? instanceId
  }

  /** Shows a file. On a host with no window open it is recorded, not lost. */
  async open(path: string): Promise<void> {
    const target = resolveInWorkspace(this.runtime, path)
    const gate = this.runtime.owner(this.ctx).gate
    gate.assertEditor()
    // Showing a file is showing its contents, so it takes the read grant too.
    gate.assertWorkspaceRead(target)
    await engine().open(target, this.who())
  }

  /** Marks lines. An empty list clears this plugin's marks on that file. */
  async decorate(path: string, decorations: readonly UiDecoration[]): Promise<void> {
    const target = resolveInWorkspace(this.runtime, path)
    const gate = this.runtime.owner(this.ctx).gate
    gate.assertEditor()
    gate.assertWorkspaceRead(target)
    await engine().decorate(target, decorations, this.who())
  }

  /** Clears everything this plugin marked on a file. */
  async clearDecorations(path: string): Promise<void> {
    await this.decorate(path, [])
  }

  /**
   * Changes the file, and returns the hash of what was written.
   *
   * The hash is the point of the return: a plugin that edits and then wants
   * to know whether the person has since changed it again has something to
   * compare, without this service handing back file contents.
   */
  async applyEdits(path: string, edits: readonly EditorEdit[]): Promise<{ hash: string }> {
    const target = resolveInWorkspace(this.runtime, path)
    this.runtime.owner(this.ctx).gate.assertEditorWrite(target)
    /*
     * The plugin's grants say what it may do; they cannot say who asked. For
     * this one call the difference is the point: an agent that calls a
     * plugin's tool, which calls this, has written a file with no approval
     * anywhere on the path — the privilege laundered through the plugin.
     *
     * the editor-plane decision projects no write tool to agents because an agent's edits
     * belong to its own runtime and its own approval. A write reached this way
     * is that same capability, re-admitted through a side door, so it is
     * refused here rather than being made to work.
     */
    if (currentActor() === 'agent') {
      throw new PermissionDenied(
        'editor.write',
        'an agent cannot write files through a plugin — editing on an agent’s behalf belongs to that agent’s own runtime, where its own approval applies',
      )
    }
    return engine().applyEdits(target, edits, this.who())
  }

  /** Stops showing a file, and drops this plugin's marks on it. */
  async close(path: string): Promise<void> {
    const target = resolveInWorkspace(this.runtime, path)
    this.runtime.owner(this.ctx).gate.assertEditor()
    await engine().close(target)
  }

  /** Everything the person has done since this plugin last asked. */
  async events(): Promise<readonly EditorEvent[]> {
    this.runtime.owner(this.ctx).gate.assertEditor()
    return engine().drain(this.who())
  }
}
