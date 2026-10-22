/** What a paired phone may do. `answer` is the verb that settles a decision for the person. */
export type PhoneTier = 'read' | 'run' | 'answer'

export interface PhoneDeviceView {
  readonly id: string
  readonly name: string
  readonly tiers: readonly PhoneTier[]
  readonly createdAt: number
  readonly lastSeenAt: number | null
}

/** A phone that showed a valid pairing code and is waiting for the person at the desk. */
export interface PhonePendingView {
  readonly id: string
  readonly name: string
  readonly deviceId: string
  readonly requestedAt: number
}

export interface PhoneLinkState {
  /** False until the desk is started with the phone link on. Nothing below is meaningful then. */
  readonly enabled: boolean
  readonly deskName: string
  readonly deskId: string
  readonly port: number | null
  readonly devices: readonly PhoneDeviceView[]
  readonly pending: readonly PhonePendingView[]
}

export interface PhonePairing {
  /** The `harnessdesk://pair?c=…` link the code carries. */
  readonly url: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
  readonly addresses: readonly { readonly host: string; readonly port: number }[]
}
