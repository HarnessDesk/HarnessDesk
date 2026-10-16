import type { RuntimeId, SessionId } from './ids.js'
import type { SeatId } from './evidence.js'

/** An observation, never a declaration of what the host wanted loaded. */
export interface LoadoutItem {
  readonly name: string
  readonly group: string | null
  readonly origin: string | null
  readonly pathLabel: string | null
  readonly digest: string | null
  readonly tokens: number | null
  readonly count: number | null
  readonly enabled: boolean | null
}
export type LoadoutPart =
  | { readonly reported: true; readonly items: readonly LoadoutItem[]; readonly more: number }
  | { readonly reported: false; readonly reason: string }

export interface ConversationLoadout {
  readonly version: 1
  readonly runtime: RuntimeId
  readonly session: SessionId
  readonly seat: SeatId | null
  readonly epoch: number
  readonly observedAt: number
  readonly build: string
  readonly approximate: boolean
  readonly source: string
  readonly skills: LoadoutPart
  readonly mcp: LoadoutPart
  readonly memory: LoadoutPart
  readonly agents: LoadoutPart
}

/** Raw paths exist only between the adapter and host; digests are always host-computed. */
export interface RuntimeLoadoutItem extends Omit<LoadoutItem, 'digest' | 'pathLabel'> {
  readonly path: string | null
}
export type RuntimeLoadoutPart =
  | { readonly reported: true; readonly items: readonly RuntimeLoadoutItem[]; readonly more: number }
  | { readonly reported: false; readonly reason: string; readonly notReady?: boolean }
export interface RuntimeLoadout {
  readonly approximate: boolean
  readonly source: string
  readonly skills: RuntimeLoadoutPart
  readonly mcp: RuntimeLoadoutPart
  readonly memory: RuntimeLoadoutPart
  readonly agents: RuntimeLoadoutPart
}
export interface ConversationLoadouts {
  readonly session: SessionId
  readonly runtime: RuntimeId
  readonly seat: SeatId | null
  readonly epochs: readonly ConversationLoadout[]
}
