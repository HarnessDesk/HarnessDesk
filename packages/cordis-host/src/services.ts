import { Service, type Context } from '@deepseek-ai/cordis'
import {
  GLOBAL_SCOPE,
  type CapabilityScope,
  type ContextChip,
  type ContributionId,
  type HookEvent,
  type JsonSchema,
  type ToolResult,
  type ToolResultPart,
  type UiDock,
  type UiSlot,
  type ScopeQuery,
} from '@harnessdesk/protocol'

import type { HostRuntime } from './runtime.js'
import type {
  CommandHandler,
  ContextResolver,
  HookHandler,
  ToolExecutor,
} from './store.js'

/**
 * The plugin-facing API.
 *
 * Every service uses Cordis's context tracker, so `this.ctx` inside a method is
 * the *calling plugin's* context. That is what lets `this.ctx.effect()` bind a
 * registration's cleanup to the caller's fiber: when the plugin unloads, its
 * contributions withdraw themselves, with no teardown code in the plugin.
 */

const tracker = (name: string) => ({ associate: name, property: 'ctx' })

/** The image types a model reads: the four the Anthropic and OpenAI APIs both take. */
const MODEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * An image part a model can read, or a sentence saying what it was. A plugin
 * that returns a PDF, or any other file, as an image part hands every agent
 * something its model refuses (#51); what it was is still worth saying. A data
 * URL's own type is what reaches the model, so it's read, and a declared type
 * has to agree with it: `mimeType: 'image/png'` on a PDF's data URL went to
 * Codex as an image (review of #187, round 1). A part whose type can't be
 * told, a link that declares none, goes as it is.
 */
const modelReadable = (part: ToolResultPart): ToolResultPart => {
  if (part.type !== 'image') return part
  const types = [/^data:([^;,]+)/i.exec(part.url)?.[1], part.mimeType]
    .filter((type): type is string => Boolean(type))
    .map((type) => type.toLowerCase())
  const unreadable = types.find((type) => !MODEL_IMAGE_TYPES.has(type))
  if (unreadable === undefined) return part
  return { type: 'text', text: `An image part held ${unreadable}, which isn't an image a model can read, so it was left out.` }
}

/** Narrows a plugin's result to the shapes the transcript can render. */
const normaliseResult = (value: unknown): ToolResult => {
  if (value === undefined || value === null) {
    return { ok: true, content: [{ type: 'text', text: '' }] }
  }
  if (typeof value === 'string') return { ok: true, content: [{ type: 'text', text: value }] }
  if (typeof value === 'object' && 'ok' in (value as object)) {
    const result = value as ToolResult
    return result.ok && Array.isArray(result.content) ? { ...result, content: result.content.map(modelReadable) } : result
  }
  if (Array.isArray(value)) return { ok: true, content: (value as ToolResultPart[]).map(modelReadable) }
  return { ok: true, content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

// ---------------------------------------------------------------------- tools

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  /** Defaults to the plugin's id, so two plugins can both offer `search`. */
  readonly namespace?: string
  readonly scope?: CapabilityScope
  /** Ask the user before every call, whatever the plugin's granted permissions. */
  readonly requiresApproval?: boolean
  execute(args: never, scope: ScopeQuery): unknown
}

export class ToolsService extends Service {
  static [Service.tracker] = tracker('tools')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'tools')
  }

  /** Registers a tool every agent can call. Disposed with the calling plugin. */
  register(spec: ToolSpec): () => void {
    const owner = this.runtime.owner(this.ctx)
    const executor: ToolExecutor = async (args, scope) =>
      normaliseResult(await (spec.execute as (a: unknown, s: ScopeQuery) => unknown)(args, scope))

    const added = this.runtime.store.add(
      {
        kind: 'tool',
        owner: owner.instanceId,
        scope: spec.scope ?? GLOBAL_SCOPE,
        namespace: spec.namespace ?? String(owner.instanceId),
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        ...(spec.requiresApproval ? { requiresApproval: true } : {}),
      },
      { executor },
    )
    return this.ctx.effect(() => () => added.dispose(), `tool:${spec.name}`) as unknown as () => void
  }
}

// ---------------------------------------------------------------------- hooks

export interface HookSpec {
  readonly event: HookEvent
  readonly match?: readonly string[]
  readonly priority?: number
  readonly timeoutMs?: number
  readonly scope?: CapabilityScope
  handle: HookHandler
}

export class HooksService extends Service {
  static [Service.tracker] = tracker('hooks')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'hooks')
  }

  /**
   * Observes or vetoes a point in the agent loop.
   *
   * `timeoutMs` is capped rather than optional: a hook that hangs would hang the
   * turn, so an overrunning hook is skipped instead of waited on.
   */
  register(spec: HookSpec): () => void {
    const owner = this.runtime.owner(this.ctx)
    const added = this.runtime.store.add(
      {
        kind: 'hook',
        owner: owner.instanceId,
        scope: spec.scope ?? GLOBAL_SCOPE,
        event: spec.event,
        ...(spec.match ? { match: spec.match } : {}),
        priority: spec.priority ?? 100,
        timeoutMs: Math.min(spec.timeoutMs ?? 5_000, 30_000),
      },
      { hook: spec.handle },
    )
    return this.ctx.effect(() => () => added.dispose(), `hook:${spec.event}`) as unknown as () => void
  }
}

// -------------------------------------------------------------------- context

export interface ContextSpec {
  readonly label: string
  readonly form?: 'instructions' | 'resource'
  readonly mimeType?: string
  readonly scope?: CapabilityScope
  /**
   * Makes the provider a composer chip: resolved only when the user attaches
   * it, never folded into every turn. See docs/extending.md.
   */
  readonly chip?: ContextChip
  resolve: ContextResolver
}

export class ContextService extends Service {
  static [Service.tracker] = tracker('context')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'context')
  }

  /** Contributes instructions or reference material to a turn — not a tool call. */
  register(spec: ContextSpec): () => void {
    const owner = this.runtime.owner(this.ctx)
    const added = this.runtime.store.add(
      {
        kind: 'context',
        owner: owner.instanceId,
        scope: spec.scope ?? GLOBAL_SCOPE,
        label: spec.label,
        form: spec.form ?? 'instructions',
        ...(spec.mimeType ? { mimeType: spec.mimeType } : {}),
        ...(spec.chip ? { chip: spec.chip } : {}),
      },
      { resolver: spec.resolve },
    )
    return this.ctx.effect(
      () => () => added.dispose(),
      `context:${spec.label}`,
    ) as unknown as () => void
  }
}

// ------------------------------------------------------------------- commands

export interface CommandSpec {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  readonly scope?: CapabilityScope
  run: CommandHandler
}

export class CommandsService extends Service {
  static [Service.tracker] = tracker('commands')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'commands')
  }

  register(spec: CommandSpec): () => void {
    const owner = this.runtime.owner(this.ctx)
    const added = this.runtime.store.add(
      {
        kind: 'command',
        owner: owner.instanceId,
        scope: spec.scope ?? GLOBAL_SCOPE,
        name: spec.name,
        description: spec.description,
        ...(spec.argumentHint ? { argumentHint: spec.argumentHint } : {}),
      },
      { command: spec.run },
    )
    return this.ctx.effect(() => () => added.dispose(), `command:/${spec.name}`) as unknown as () => void
  }
}

// ------------------------------------------------------------------------- ui

export interface UiSpec {
  readonly slot: UiSlot
  readonly label: string
  /** Resolved by the renderer's component registry, e.g. `hd.panel`. */
  readonly component: string
  readonly icon?: string
  readonly order?: number
  readonly scope?: CapabilityScope
  /** What the component renders — JSON only, `UiPanelData` for `hd.panel`. */
  readonly data?: unknown
  /**
   * The panel areas this may be docked into, making it a *panel* rather than
   * an occupant of a fixed slot: it gets a tab, the person can move it between
   * the areas named here, expand it and close it, and where they put it is
   * remembered per project. The first entry is where it opens.
   *
   * `slot` stays required and stays meaningful — it is where a build that does
   * not know about panels draws the contribution, so an older HarnessDesk
   * shows something rather than nothing.
   */
  readonly mounts?: readonly UiDock[]
}

export class UiService extends Service {
  static [Service.tracker] = tracker('ui')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'ui')
  }

  register(spec: UiSpec): () => void {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertUiContribute()
    const added = this.runtime.store.add({
      kind: 'ui',
      owner: owner.instanceId,
      scope: spec.scope ?? GLOBAL_SCOPE,
      slot: spec.slot,
      label: spec.label,
      component: spec.component,
      ...(spec.icon ? { icon: spec.icon } : {}),
      ...(spec.data !== undefined ? { data: spec.data } : {}),
      ...(spec.mounts && spec.mounts.length > 0 ? { mounts: spec.mounts } : {}),
      order: spec.order ?? 100,
    })
    return this.ctx.effect(() => () => added.dispose(), `ui:${spec.slot}`) as unknown as () => void
  }
}

// ---------------------------------------------------------------- diagnostics

/** Exposes the id a plugin was registered under, mostly for its own logging. */
export class PluginInfoService extends Service {
  static [Service.tracker] = tracker('plugin')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'harness')
  }

  get instanceId(): string {
    return String(this.runtime.owner(this.ctx).instanceId)
  }

  get workspaceRoot(): string | null {
    return this.runtime.workspace.root
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.runtime.store.emit({
      type: 'extension/log',
      owner: this.runtime.owner(this.ctx).instanceId,
      level,
      message,
    })
  }
}

export type { ContributionId }
