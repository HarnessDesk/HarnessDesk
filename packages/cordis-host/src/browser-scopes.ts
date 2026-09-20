import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export interface BrowserIdentity {
  readonly invocation: string
  readonly profile: string
}

const scope = new AsyncLocalStorage<BrowserIdentity>()
const live = new Map<string, { identity: BrowserIdentity; controller: AbortController }>()
const pending = new Set<Promise<void>>()
const refused = (): Error => new Error('This browser call no longer belongs to a live invocation.')

const validProfile = (profile: string): void => {
  if (profile !== 'default') browserPartition(profile, true)
}

export const withBrowserIdentity = <T>(identity: BrowserIdentity, run: () => T): T =>
  scope.run(Object.freeze({ ...identity }), run)

export function currentBrowserIdentity(required = false): BrowserIdentity | undefined {
  const identity = scope.getStore()
  if (!identity) {
    if (required) throw refused()
    return undefined
  }
  if (live.get(identity.invocation)?.identity.profile !== identity.profile) throw refused()
  return identity
}

/** Host-owned lifetime for services that deliberately block inside a tool call. */
export function currentInvocationSignal(): AbortSignal | undefined {
  const identity = scope.getStore()
  return identity ? live.get(identity.invocation)?.controller.signal : undefined
}

/** Called only by the host/kernel entry point, never exposed on plugin context. */
export async function runBrowserInvocation<T>(
  identity: BrowserIdentity,
  run: () => T | Promise<T>,
): Promise<T> {
  validProfile(identity.profile)
  if (!identity.invocation || live.has(identity.invocation)) throw refused()
  const frozen = Object.freeze({ ...identity })
  const controller = new AbortController()
  live.set(identity.invocation, { identity: frozen, controller })
  let settled!: () => void
  const done = new Promise<void>((resolve) => {
    settled = resolve
  })
  pending.add(done)
  try {
    return await withBrowserIdentity(frozen, run)
  } finally {
    controller.abort()
    live.delete(identity.invocation)
    pending.delete(done)
    settled()
  }
}

export async function drainBrowserInvocations(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending])
}

/** Parent-owned leases are removed in the same finally as the pending tool call. */
export class BrowserInvocations {
  readonly #live = new Map<string, { identity: BrowserIdentity; plugin: string; controller: AbortController }>()

  begin(profile: string, plugin: string): BrowserIdentity {
    validProfile(profile)
    if (!plugin) throw refused()
    const identity = Object.freeze({ invocation: randomUUID(), profile })
    this.#live.set(identity.invocation, { identity, plugin, controller: new AbortController() })
    return identity
  }

  has(identity: BrowserIdentity): boolean {
    return this.#live.get(identity.invocation)?.identity.profile === identity.profile
  }

  resolve(invocation: unknown, plugin?: string): BrowserIdentity {
    const lease = typeof invocation === 'string' ? this.#live.get(invocation) : undefined
    if (!lease || (plugin !== undefined && plugin !== lease.plugin)) throw refused()
    return lease.identity
  }

  owner(invocation: unknown): string {
    this.resolve(invocation)
    return this.#live.get(invocation as string)!.plugin
  }

  signal(invocation: unknown, plugin?: string): AbortSignal {
    this.resolve(invocation, plugin)
    return this.#live.get(invocation as string)!.controller.signal
  }

  end(invocation: string): void {
    this.#live.get(invocation)?.controller.abort()
    this.#live.delete(invocation)
  }
}

export class BrowserScopes<T> {
  readonly #profiles = new Map<string, T>()

  constructor(
    private readonly create: (profile: string) => T,
    private readonly authorized: (identity: BrowserIdentity) => boolean,
  ) {}

  current(): T {
    const identity = scope.getStore()
    if (identity && !this.authorized(identity)) throw refused()
    return this.forProfile(identity?.profile ?? 'default')
  }

  /** Host lifecycle and settings only. Plugin code receives current(), not this map. */
  forProfile(profile: string): T {
    validProfile(profile)
    if (!this.#profiles.has(profile)) this.#profiles.set(profile, this.create(profile))
    return this.#profiles.get(profile)!
  }

  entries(): readonly (readonly [string, T])[] {
    return [...this.#profiles.entries()]
  }
}

export function browserPartition(profile: string | null, keep: boolean): string {
  if (profile === null) return keep ? 'persist:harnessdesk-browser' : 'harnessdesk-browser-once'
  if (!/^lane-[A-Za-z0-9-]{1,100}$/.test(profile) || profile.endsWith('\n')) {
    throw new Error('The host did not name a lane browser profile.')
  }
  return `persist:hd-${profile}`
}
