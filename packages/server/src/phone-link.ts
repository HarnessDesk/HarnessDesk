import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  parseClientMessage, wireCodeOf, type HostMethodName, type HostParams, type PhoneLinkState, type PhonePairing, type PhoneTier,
  type WireNotification,
} from '@harnessdesk/protocol'
import { PhoneCallError, PhoneLinkService, type Device, type PhonePolicy } from '@harnessdesk/phone-link'
import type { Host } from './host.js'
import type { Logger } from './log.js'

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
 * What a paired phone may ask this desk for, and hear from it. The Lead is the phone's whole job for now:
 * read the thread, write to it, stop and resume it, and decide a card. Settings, sessions and everything else
 * stay behind the window.
 */
export const PHONE_POLICY: PhonePolicy = {
  methods: {
    'lead/thread/read': 'read',
    'lead/settings/read': 'read',
    'lead/thread/send': 'run',
    'lead/stop': 'run',
    'lead/resume': 'run',
    'lead/card/decide': 'answer',
    'lead/action/perform': 'answer',
  },
  topics: { lead: 'read' },
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
}

export interface RunningPhoneLink {
  readonly service: PhoneLinkService
  readonly control: PhoneLinkControl
  close(): Promise<void>
}

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
  const detach = host.addBroadcaster((notification: WireNotification) => {
    if (notification.method === 'lead/changed') service.publish('lead', notification.params)
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
  return { service, control, close: async () => { detach(); await service.close() } }
}

/** What the window sees when the phone link is not running. */
export const phoneLinkOff: PhoneLinkState = { enabled: false, deskName: '', deskId: '', port: null, devices: [], pending: [] }

export type { HostParams }
