import { AsyncLocalStorage } from 'node:async_hooks'

import type { Context } from '@deepseek-ai/cordis'
import {
  pluginInstanceId,
  type PluginInstanceId,
  type PluginPermissions,
} from '@harnessdesk/protocol'

import { PermissionGate } from './permissions.js'
import type { ContributionStore } from './store.js'
import { canonicalRoot } from './workspace-scope.js'

/**
 * State every service shares, plus the answer to "which plugin is calling?".
 *
 * Ownership is carried on the context itself rather than inferred from the
 * fiber. Cordis contexts inherit prototypally from the context they were
 * extended from, so a plugin — and every child context it creates, including
 * sub-plugins it loads — reads back the same owner. Walking fibers instead
 * would race plugin startup, because `apply()` can run before the fiber handle
 * is returned to the loader.
 */

/** Own property planted on each plugin's context by the kernel. */
export const OWNER = Symbol.for('harnessdesk.plugin.owner')

export interface WorkspaceState {
  readonly root: string | null
  readonly branch: string | null
  /**
   * The checkouts the host admits a conversation in this folder to, as real paths: the folder's own checkout, and its
   * project's main checkout, which is what a conversation with no checkout of its own is admitted to. A call admitted
   * to one of them runs in this workspace, as it was opened. The folder's own real path counts without being listed.
   */
  readonly admitted?: readonly string[]
}

export interface RegisteredPlugin {
  readonly instanceId: PluginInstanceId
  readonly permissions: PluginPermissions
  readonly gate: PermissionGate
}

export class HostRuntime {
  readonly #byInstance = new Map<string, RegisteredPlugin>()
  #workspace: WorkspaceState = { root: null, branch: null }
  /** The real paths a call may be admitted to and still run in the open workspace, resolved once. */
  #openCheckouts: readonly string[] = []
  readonly #contextWorkspace = new AsyncLocalStorage<WorkspaceState>()

  constructor(readonly store: ContributionStore) {}

  get workspace(): WorkspaceState {
    return this.#contextWorkspace.getStore() ?? this.#workspace
  }

  /** True while a call runs in a checkout other than the open workspace: a Seat's lane or another clone. */
  get inOtherCheckout(): boolean {
    const entered = this.#contextWorkspace.getStore()
    return entered !== undefined && entered !== this.#workspace
  }

  setWorkspace(state: WorkspaceState): void {
    this.#workspace = state
    this.#openCheckouts = state.root === null ? [] : [state.root, ...(state.admitted ?? [])].map(canonicalRoot)
  }

  /**
   * Context resolution and tool calls run in the checkout the host admitted for the conversation they serve. A call
   * admitted to the open workspace's own checkout runs in the open workspace as it was opened — a subfolder, a linked
   * worktree, a folder reached through a link — with its branch. Any other checkout, a Seat's lane or another clone, is
   * entered as it is, and its branch is unknown here.
   */
  withContextWorkspace<T>(root: string | undefined, run: () => T): T {
    const workspace = root === undefined || this.#openCheckouts.includes(canonicalRoot(root))
      ? this.#workspace
      : { root, branch: null }
    return this.#contextWorkspace.run(workspace, run)
  }

  /** Records a plugin and returns the context metadata that identifies it. */
  register(
    instanceId: PluginInstanceId,
    permissions: PluginPermissions,
  ): { entry: RegisteredPlugin; meta: Record<symbol, unknown> } {
    const entry: RegisteredPlugin = {
      instanceId,
      permissions,
      gate: new PermissionGate(permissions, () => this.workspace.root, () => this.inOtherCheckout),
    }
    this.#byInstance.set(instanceId, entry)
    return { entry, meta: { [OWNER]: instanceId } }
  }

  forget(instanceId: PluginInstanceId): void {
    this.#byInstance.delete(instanceId)
  }

  /**
   * The plugin that owns a context.
   *
   * Falls back to a fully trusted host identity for contributions made directly
   * on the root — HarnessDesk's own built-in features — so every contribution
   * still has an owner and a revision.
   */
  owner(ctx: Context): RegisteredPlugin {
    const instanceId = (ctx as unknown as Record<symbol, unknown>)[OWNER] as
      | PluginInstanceId
      | undefined
    const found = instanceId ? this.#byInstance.get(instanceId) : undefined
    if (found) return found
    return this.#host()
  }

  #host(): RegisteredPlugin {
    const id = pluginInstanceId('harnessdesk:host')
    const existing = this.#byInstance.get(id)
    if (existing) return existing
    return this.register(id, ALL_PERMISSIONS).entry
  }
}

/** Built-in features run fully trusted; third-party plugins never do. */
export const ALL_PERMISSIONS: PluginPermissions = {
  workspace: { read: true, write: true },
  shell: true,
  network: { hosts: ['*'] },
  agents: { invoke: true },
  ui: { contribute: true },
  browser: true,
  ios: true,
  android: true,
  editor: true,
  team: true,
  forge: true,
  secrets: [],
}
