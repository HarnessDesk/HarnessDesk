import type { LeadPorts } from '../src/index.js'

type Ports = LeadPorts<{ prompt: string }, { text: string }, { version: 1; revision: number }>
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
type Assert<T extends true> = T

// These ports are interfaces only. The root build proves their type contract;
// there is no runtime implementation to test, and no vacuous runtime assertion.
export type LeadPortChecks = [
  Assert<Equal<keyof Ports, 'messages' | 'desk' | 'persistence' | 'cancellation'>>,
  Assert<Equal<keyof Ports['desk'], 'call' | 'events' | 'synced' | 'snapshot'>>,
  Assert<Equal<Parameters<Ports['messages']['request']>[0], { prompt: string }>>,
  Assert<Equal<Awaited<ReturnType<Ports['messages']['request']>>, { text: string }>>,
  Assert<Equal<Parameters<Ports['persistence']['append']>[0], { version: 1; revision: number }>>,
  Assert<Equal<keyof Ports['cancellation'], 'aborted' | 'onCancel'>>,
]
// @ts-expect-error Transport ownership must not leak through the desk port.
type NoTransport = Ports['desk']['transport']
// @ts-expect-error Cancellation is observed, not controlled by the portable loop.
type NoAbort = Ports['cancellation']['abort']
// @ts-expect-error Journal payloads retain their caller-selected shape.
type WrongEntry = Assert<Equal<Parameters<Ports['persistence']['append']>[0], { token: string }>>
