import type {
  CommandSpec,
  ContextSpec,
  HookSpec,
  ToolSpec,
  UiSpec,
} from './services.js'
import type { EditorEdit, EditorEvent, ScopeQuery, UiDecoration,
  ForgeReference,
} from '@harnessdesk/protocol'

import type { HttpRequestInit } from './capabilities.js'
import type {
  CdpEvent,
  ConsoleEntry,
  EmulateOptions,
  NetworkEntry,
  PointerOptions,
  PointerTarget,
  ReadPageOptions,
  ScreenshotOptions,
  WaitOptions,
} from './browser.js'

/**
 * The context a HarnessDesk plugin receives.
 *
 * Declared structurally so plugin authors never import Cordis. A plugin is a
 * plain object with `apply(ctx)`, and this is what `ctx` offers — which is also
 * the whole API surface a plugin is allowed to reach.
 */
import type { ForgeIdentity, ForgeSeat } from './forge.js'

export interface HarnessContext {
  /** Tools any agent can call. */
  readonly tools: { register(spec: ToolSpec): () => void }
  /** Observe or veto points in the agent's loop. */
  readonly hooks: { register(spec: HookSpec): () => void }
  /** Instructions and reference material folded into a turn. */
  readonly context: { register(spec: ContextSpec): () => void }
  /** Slash commands. */
  readonly commands: { register(spec: CommandSpec): () => void }
  /** Panels, rows, and settings sections. Requires the `ui` permission. */
  readonly ui: { register(spec: UiSpec): () => void }

  /** Filesystem access, confined to the open workspace by the permission gate. */
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
    list(path?: string): Promise<{ name: string; directory: boolean }[]>
    exists(path: string): Promise<boolean>
  }
  /** Network access, limited to the hosts the manifest declares. */
  readonly http: {
    fetch(
      url: string,
      init?: HttpRequestInit,
    ): Promise<{ status: number; headers: Record<string, string>; body: string }>
    json<T = unknown>(url: string, init?: HttpRequestInit): Promise<T>
  }
  /** Run a program. Requires the `shell` permission; arguments are never shell-interpreted. */
  readonly shell: {
    run(
      command: string,
      args?: readonly string[],
      options?: { cwd?: string; timeoutMs?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>
  }
  readonly workspace: { readonly root: string | null; readonly branch: string | null }
  /**
   * A visible browser this plugin can drive, in the DevTools protocol.
   * Requires the `browser` permission.
   *
   * Coordinates in `click` and in a `{x, y}` pointer target are the
   * *screenshot's* pixels, so a model acts where it was shown to act. A
   * `ref_3` from `readPage` is resolved by the page and needs no such
   * correction.
   */
  readonly browser: {
    /** `handedOff` when the setting sent the page to the default browser, which cannot be looked at. */
    open(url: string): Promise<{ url: string; title: string; handedOff?: true }>
    page(): Promise<{ url: string; title: string }>
    screenshot(options?: ScreenshotOptions): Promise<string>
    pdf(options?: { landscape?: boolean; printBackground?: boolean }): Promise<string>
    click(x: number, y: number, options?: PointerOptions): Promise<void>
    clickRef(ref: string, options?: PointerOptions): Promise<void>
    hover(target: PointerTarget): Promise<void>
    scroll(deltaX: number, deltaY: number, target?: PointerTarget): Promise<void>
    drag(from: PointerTarget, to: PointerTarget): Promise<void>
    key(key: string, count?: number, modifiers?: readonly string[]): Promise<void>
    type(text: string, options?: { ref?: string; submit?: boolean }): Promise<void>
    fill(ref: string, value: string | boolean): Promise<unknown>
    upload(ref: string, files: readonly string[]): Promise<void>
    evaluate(expression: string): Promise<unknown>
    readPage(options?: ReadPageOptions): Promise<string>
    history(direction: 'back' | 'forward' | 'reload'): Promise<{ url: string; title: string }>
    waitFor(options?: WaitOptions): Promise<boolean>
    emulate(options?: EmulateOptions): Promise<void>
    console(options?: {
      limit?: number
      onlyErrors?: boolean
      pattern?: string
    }): Promise<readonly ConsoleEntry[]>
    network(options?: {
      limit?: number
      urlPattern?: string
      requestId?: string
    }): Promise<readonly NetworkEntry[] | { body: string; base64: boolean }>
    /** Any DevTools method at all — the ceiling this service does not impose. */
    cdp(method: string, params?: Record<string, unknown>): Promise<unknown>
    events(options?: { method?: string; limit?: number }): Promise<readonly CdpEvent[]>
    close(): Promise<void>
  }
  /**
   * The file the person is looking at, driven as data. Requires the `editor`
   * permission — and `applyEdits` requires `workspace.write` on top, so the
   * editor never becomes a second road to the disk.
   *
   * There is deliberately no way to read a file's text through this service.
   * A plugin that wants content reads it with `ctx.fs`, under the gate that
   * governs every other read it makes.
   */
  readonly editor: {
    open(path: string): Promise<void>
    decorate(path: string, decorations: readonly UiDecoration[]): Promise<void>
    clearDecorations(path: string): Promise<void>
    applyEdits(path: string, edits: readonly EditorEdit[]): Promise<{ hash: string }>
    close(path: string): Promise<void>
    events(): Promise<readonly EditorEvent[]>
  }
  /**
   * The shared board and messages to the other conversations, routed by the
   * host. Requires the `team` permission.
   *
   * Every verb takes the `ScopeQuery` its tool invocation carried: which
   * conversation is asking is the substance here — a claim needs an owner,
   * a message needs a sender — and the host refuses unscoped writes rather
   * than guessing. Results are prose composed host-side for the calling
   * model; expected outcomes (a claim someone else holds, a path conflict)
   * are sentences, not throws.
   */
  /**
   * What the desk adds around a git forge a plugin reaches with its own
   * `gh`: the seat of the calling conversation, for a signature, and the
   * record of what was published, drawn in the transcript. Requires the
   * `forge` permission. Every verb takes the `ScopeQuery` its tool
   * invocation carried, for the reason the team verbs do.
   */
  readonly forge: {
    seat(scope?: ScopeQuery): Promise<ForgeSeat | null>
    identity(scope?: ScopeQuery): Promise<ForgeIdentity>
    publish(reference: ForgeReference, scope?: ScopeQuery): Promise<void>
  }
  readonly team: {
    board(scope?: ScopeQuery): Promise<string>
    addIntent(
      args: {
        readonly title: string
        readonly detail?: string
        readonly files?: readonly string[]
        readonly dependsOn?: readonly number[]
      },
      scope?: ScopeQuery,
    ): Promise<string>
    /** `files` are the paths this claim will touch, added to the intent's own. */
    claim(intent: number, scope?: ScopeQuery, files?: readonly string[]): Promise<string>
    /** The next open, unblocked, unconflicted card, whichever it is, taken atomically. */
    claimNext(scope?: ScopeQuery, files?: readonly string[]): Promise<string>
    conflicts(paths: readonly string[], scope?: ScopeQuery): Promise<string>
    complete(
      intent: number,
      args: { readonly note?: string; readonly handoff?: string },
      scope?: ScopeQuery,
    ): Promise<string>
    release(
      intent: number,
      args: { readonly reason?: string; readonly blocked?: boolean },
      scope?: ScopeQuery,
    ): Promise<string>
    handoff(intent: number, scope?: ScopeQuery): Promise<string>
    status(scope?: ScopeQuery): Promise<string>
    send(
      args: { readonly to: string; readonly text: string; readonly wake?: boolean },
      scope?: ScopeQuery,
    ): Promise<string>
  }
  /** The iOS Simulator, via simctl. Requires the `ios` permission. */
  readonly ios: {
    devices(): Promise<readonly { udid: string; name: string; state: string; runtime: string }[]>
    booted(): Promise<{ udid: string; name: string; state: string; runtime: string }>
    boot(udid: string): Promise<void>
    install(appPath: string): Promise<void>
    launch(bundleId: string): Promise<void>
    terminate(bundleId: string): Promise<void>
    openUrl(url: string): Promise<void>
    screenshot(): Promise<string>
    tap(x: number, y: number): Promise<void>
  }
  /**
   * Android devices and emulators, via adb. Requires the `android` permission.
   * Every call that touches a device takes an optional `serial` — one of the
   * serials `devices()` lists. Without it adb picks the device, which it can
   * only do when exactly one is attached; with two, the call is refused with
   * the serials to choose from.
   */
  readonly android: {
    devices(): Promise<readonly { serial: string; state: string; description: string }[]>
    install(apkPath: string, serial?: string): Promise<void>
    launch(target: string, serial?: string): Promise<void>
    screenshot(serial?: string): Promise<string>
    tap(x: number, y: number, serial?: string): Promise<void>
    key(key: string, serial?: string): Promise<void>
    text(text: string, serial?: string): Promise<void>
    logcat(lines?: number, tag?: string, serial?: string): Promise<string>
  }
  readonly harness: {
    readonly instanceId: string
    readonly workspaceRoot: string | null
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  }

  /** Cordis lifecycle, available for plugins that need tracked cleanup directly. */
  effect(execute: () => () => void, label?: string): () => void
  on(event: string, listener: (...args: never[]) => void): () => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin(plugin: any, config?: unknown): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provide(name: string, value?: any): () => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): any
}

/** A plugin definition, in the shape Cordis accepts. */
export interface HarnessPluginModule<Config = Record<string, unknown>> {
  readonly name: string
  /** Service names this plugin needs before it will start. */
  readonly inject?: readonly string[]
  readonly provide?: string | readonly string[]
  apply(ctx: HarnessContext, config: Config): void | Promise<void>
}
