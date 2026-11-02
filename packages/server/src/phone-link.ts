import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  parseClientMessage, wireCodeOf, type HarnessDeskAccountStatus, type HostMethodName, type HostParams, type PhoneLinkState,
  type PhonePairing, type PhoneRelayState, type PhoneTier, type WireNotification,
} from '@harnessdesk/protocol'
import { PhoneCallError, PhoneLinkService, RelayLink, type AccountOffer, type Device, type PhonePolicy } from '@harnessdesk/phone-link'
import type { PhoneInvite, RelayAccess } from './harnessdesk-account.js'
import type { Host } from './host.js'
import type { Logger } from './log.js'
import { WorkspaceFeed } from './phone-work.js'

/** What the wire methods under `phone/` reach: the window decides, the service obeys. */
export interface PhoneLinkControl {
  state(): PhoneLinkState
  pairing(): Promise<PhonePairing>
  allow(id: string, tiers?: readonly PhoneTier[]): PhoneLinkState
  deny(id: string): PhoneLinkState
  revoke(device: string): Promise<PhoneLinkState>
  onChange(listener: () => void): () => void
}

/**
 * What a paired phone may ask this desk for, and hear from it. The Lead is the phone's job: read the thread, write
 * to it, stop and resume it, and decide a card. Beside it the phone may read three projections of the work (sessions,
 * Teams, spend), inspect a redacted conversation and control ordinary sessions with the desk's existing authority.
 *
 * The `workspace/…` names are the ones the phone ships with: the same work as one snapshot, a conversation, and the
 * session controls and approval answers. They share a prefix with the window's folder and file methods; the window's
 * `workspace/recent`, `workspace/readFile` and the rest stay `notOnPhoneSurface`.
 */
export const PHONE_POLICY: PhonePolicy = {
  methods: {
    'lead/thread/read': 'read',
    'lead/settings/read': 'read',
    // Exact repeat/card JSON and method results: packages/phone-link/lead.md.
    'lead/schedule/read': 'read',
    // The work itself, read-only and redacted: projections written for the phone, never the desk's own records.
    'phone/sessions/list': 'read',
    'phone/teams/list': 'read',
    'phone/dashboard/read': 'read',
    'workspace/read': 'read',
    'workspace/sessions/list': 'read',
    'workspace/session/start': 'run',
    'workspace/session/send': 'run',
    'workspace/stop': 'run',
    'workspace/thread/read': 'read',
    'workspace/approval/decide': 'answer',
    'lead/thread/send': 'run',
    'lead/stop': 'run',
    'lead/resume': 'run',
    'lead/repeat/control': 'run',
    'lead/card/decide': 'answer',
    'lead/action/perform': 'answer',
    'lead/approval/revoke': 'answer',
    'lead/budget/raise': 'answer',
  },
  topics: { lead: 'read', workspace: 'read' },
  // A phone the person allows can answer a card, which is what a phone is for; the window can narrow it later.
  defaultTiers: ['read', 'run', 'answer'],
}

export interface PhoneLinkOptions {
  readonly home: string
  /** 0 picks a free port. */
  readonly port?: number
  readonly host?: string
  readonly name?: string
  readonly includeLoopback?: boolean
  /** How long changes to the work are gathered before one snapshot goes to the phones that are listening. */
  readonly workspaceDelayMs?: number
  /** The desk's HarnessDesk account. With it, phones away from this network reach the desk through the relay. */
  readonly account?: PhoneRelayAccount
  /** For tests. */
  readonly relay?: { readonly heartbeatMs?: number; readonly random?: () => number; readonly maxBackoffMs?: number }
}

/** The part of the HarnessDesk account the phone link uses. The desk key stays inside it. */
export interface PhoneRelayAccount {
  status(): Promise<HarnessDeskAccountStatus>
  onChange(listener: (status: HarnessDeskAccountStatus) => void): () => void
  relayAccess(fresh: boolean): Promise<RelayAccess>
  createPhoneInvite(): Promise<PhoneInvite>
  unlinkPhone(deviceId: string): Promise<HarnessDeskAccountStatus>
}

export interface RunningPhoneLink {
  readonly service: PhoneLinkService
  readonly control: PhoneLinkControl
  close(): Promise<void>
}

/**
 * What may have changed the phone's snapshot: a session or Team starting, finishing, being renamed or removed, an
 * approval asked or answered. Token and cost updates are left out on purpose: they arrive many times a second.
 */
const WORKSPACE_EVENTS = new Set([
  'session/started', 'session/status', 'session/title', 'session/closed', 'turn/started', 'turn/completed',
  'approval/requested', 'approval/resolved',
])
const WORKSPACE_METHODS = new Set(['goal/changed', 'team/changed', 'session/removed', 'seat/activity'])

/** Starts the LAN listener against a running host and hands the window its controls. */
export async function startPhoneLink(host: Pick<Host, 'call' | 'addBroadcaster' | 'attachPhoneLink'>, logger: Logger, options: PhoneLinkOptions): Promise<RunningPhoneLink> {
  const log = logger.child('phone-link')
  const call = async (method: string, params: unknown, device: Device): Promise<unknown> => {
    let parsed
    try { parsed = parseClientMessage({ id: 0, method, params: params ?? {} }) } catch (error) {
      throw new PhoneCallError('badRequest', error instanceof Error ? error.message : String(error))
    }
    try { return await host.call(parsed.method as HostMethodName, parsed.params as never) } catch (error) {
      log.info('phone request failed', { device: device.id, method, code: wireCodeOf(error) })
      throw new PhoneCallError(wireCodeOf(error) ?? 'methodFailed', error instanceof Error ? error.message : String(error))
    }
  }
  const service = await PhoneLinkService.start({
    dir: join(options.home, 'phone-link'), policy: PHONE_POLICY, call, port: options.port, host: options.host,
    name: options.name ?? hostname(), includeLoopback: options.includeLoopback,
    log: (message, fields) => log.info(message, fields),
  })
  const feed = new WorkspaceFeed({
    build: () => host.call('workspace/read', {}),
    publish: snapshot => service.publish('workspace', snapshot),
    listening: () => service.listening('workspace'),
    delayMs: options.workspaceDelayMs,
    onError: error => log.info('workspace snapshot failed', { error: error instanceof Error ? error.name : 'error' }),
  })
  const detach = host.addBroadcaster((notification: WireNotification) => {
    if (notification.method === 'lead/changed') service.publish('lead', notification.params)
    // Session pages extend beyond the metadata snapshot's bounded session portion. Every index change invalidates
    // them, even when that snapshot is byte-for-byte identical.
    else if (notification.method === 'session/indexChanged' || notification.method === 'lead/chats/controlChanged') feed.poke(true)
    else if (WORKSPACE_METHODS.has(notification.method) || (notification.method === 'event' && WORKSPACE_EVENTS.has(notification.params.event.type))) feed.poke()
  })
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of listeners) listener() }
  const account = options.account
  let relayState: PhoneRelayState = 'off'
  const unlinks = account ? await UnlinkOutbox.open(join(options.home, 'phone-link', 'relay-unlinks.json'), account, log) : null
  const relay = account ? new RelayLink({
    credentials: fresh => account.relayAccess(fresh),
    attach: (conn, dev, transport) => service.attachRelay(conn, dev, transport),
    onState: next => {
      relayState = next
      if (next === 'connected') void unlinks!.flush()
      changed()
    },
    log: (message, fields) => log.info(message, fields),
    ...options.relay,
  }) : null
  // The relay runs while the desk is signed in and Reachable from your phone is on. It starts on the change to that,
  // not on every status: a desk another copy replaced, or the account refused, stays stopped until the person acts.
  let reachable = false
  const follow = (status: HarnessDeskAccountStatus) => {
    const next = status.status === 'signedIn' && status.desk.reachable
    if (status.status === 'signedIn') void unlinks?.flush()
    if (next === reachable) return
    reachable = next
    if (next) relay?.start()
    else relay?.stop()
  }
  const unfollow = account?.onChange(follow)
  if (account) void account.status().then(follow, error => log.info('account status failed', { error: error instanceof Error ? error.name : 'error' }))

  const state = (): PhoneLinkState => ({
    enabled: true, deskName: service.name, deskId: service.deskId, port: service.port, relay: relayState,
    devices: service.devices().map(({ id, name, tiers, createdAt, lastSeenAt }) => ({ id, name, tiers, createdAt, lastSeenAt, route: service.routeOf(id) })),
    pending: service.pending().map(({ id, name, deviceId, requestedAt }) => ({ id, name, deviceId, requestedAt })),
  })
  const control: PhoneLinkControl = {
    state,
    pairing: async () => {
      let invite: AccountOffer | undefined
      // An invite that cannot be made leaves a code for this network, which still pairs.
      if (account && reachable) invite = await account.createPhoneInvite().catch(error => {
        log.info('phone invite failed', { error: error instanceof Error ? error.name : 'error' })
        return undefined
      })
      const code = service.createPairingCode(600, invite)
      return { url: code.url, expiresAt: code.expiresAt, addresses: service.lanAddresses(), away: invite !== undefined }
    },
    allow: (id, tiers) => { service.allow(id, tiers); return state() },
    deny: id => { service.deny(id); return state() },
    revoke: async device => {
      await service.revoke(device)
      // Removed here first; the account link follows, now or once the account can be reached.
      await unlinks?.add(device)
      return state()
    },
    onChange: listener => {
      listeners.add(listener)
      const off = service.onChange(() => listener())
      return () => { listeners.delete(listener); off() }
    },
  }
  host.attachPhoneLink(control)
  log.info('phone link listening', { port: service.port, deskId: service.deskId })
  return {
    service, control,
    close: async () => { detach(); unfollow?.(); relay?.stop(); feed.dispose(); await service.close() },
  }
}

/**
 * Phones removed on this desk whose account link has not been removed yet. The phone is refused here the moment it is
 * removed; this only stops the account handing it new tickets for the relay, so it waits for the account when that
 * cannot be reached, and survives a restart.
 */
class UnlinkOutbox {
  #ids: Set<string>
  #flushing: Promise<void> = Promise.resolve()

  private constructor(private readonly file: string, private readonly account: PhoneRelayAccount, private readonly log: Logger, ids: readonly string[]) {
    this.#ids = new Set(ids)
  }

  static async open(file: string, account: PhoneRelayAccount, log: Logger): Promise<UnlinkOutbox> {
    const ids = await readFile(file, 'utf8').then(text => {
      const value: unknown = JSON.parse(text)
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 64) : []
    }).catch(() => [])
    return new UnlinkOutbox(file, account, log, ids)
  }

  async add(id: string): Promise<void> {
    this.#ids.add(id)
    await this.#save()
    await this.flush()
  }

  flush(): Promise<void> {
    this.#flushing = this.#flushing.then(() => this.#flush(), () => this.#flush())
    return this.#flushing
  }

  async #flush(): Promise<void> {
    if (this.#ids.size === 0) return
    let status: HarnessDeskAccountStatus
    try { status = await this.account.status() } catch { return }
    if (status.status === 'pending') return
    let changed = false
    for (const id of [...this.#ids]) {
      // A desk that signed out took its links with it, and a phone the account never linked has nothing to remove.
      if (status.status === 'signedIn' && status.phones.some(phone => phone.deviceId === id)) {
        try { status = await this.account.unlinkPhone(id) } catch (error) {
          this.log.info('phone unlink waits for the account', { error: error instanceof Error ? error.name : 'error' })
          continue
        }
      }
      this.#ids.delete(id)
      changed = true
    }
    if (changed) await this.#save()
  }

  async #save(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify([...this.#ids]), { mode: 0o600 })
      await rename(temporary, this.file)
    } catch (error) { this.log.info('phone unlink list not saved', { error: error instanceof Error ? error.name : 'error' }) }
  }
}

/** What the window sees when the phone link is not running. */
export const phoneLinkOff: PhoneLinkState = { enabled: false, deskName: '', deskId: '', port: null, relay: 'off', devices: [], pending: [] }

export type { HostParams }
