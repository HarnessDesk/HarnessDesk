import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  parseClientMessage, wireCodeOf, type HostMethodName, type HostParams, type PhoneLinkState, type PhonePairing, type PhoneTier,
  type WireNotification,
} from '@harnessdesk/protocol'
import { PhoneCallError, PhoneLinkService, type Device, type PhonePolicy } from '@harnessdesk/phone-link'
import type { Host } from './host.js'
import type { Logger } from './log.js'
import { WorkspaceFeed } from './phone-work.js'

/** What the wire methods under `phone/` reach: the window decides, the service obeys. */
export interface PhoneLinkControl {
  state(): PhoneLinkState
  pairing(): PhonePairing
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
  const state = (): PhoneLinkState => ({
    enabled: true, deskName: service.name, deskId: service.deskId, port: service.port,
    devices: service.devices().map(({ id, name, tiers, createdAt, lastSeenAt }) => ({ id, name, tiers, createdAt, lastSeenAt })),
    pending: service.pending().map(({ id, name, deviceId, requestedAt }) => ({ id, name, deviceId, requestedAt })),
  })
  const control: PhoneLinkControl = {
    state,
    pairing: () => {
      const code = service.createPairingCode()
      return { url: code.url, expiresAt: code.expiresAt, addresses: service.lanAddresses() }
    },
    allow: (id, tiers) => { service.allow(id, tiers); return state() },
    deny: id => { service.deny(id); return state() },
    revoke: async device => { await service.revoke(device); return state() },
    onChange: listener => service.onChange(() => listener()),
  }
  host.attachPhoneLink(control)
  log.info('phone link listening', { port: service.port, deskId: service.deskId })
  return { service, control, close: async () => { detach(); feed.dispose(); await service.close() } }
}

/** What the window sees when the phone link is not running. */
export const phoneLinkOff: PhoneLinkState = { enabled: false, deskName: '', deskId: '', port: null, devices: [], pending: [] }

export type { HostParams }
