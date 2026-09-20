import type { RuntimeId, SeatFix } from '@harnessdesk/protocol'

import type { Section } from '../components/Settings'

/**
 * Where a fix on the refusal sheet takes a person.
 *
 * `agent` is the Agents window (Task 13's owner decision: the roster lives
 * there, never in Settings), opened on the Agent that asked for the seat —
 * the only door to it in this file, because a runtime's own trouble is never
 * fixed on the roster.
 */
export type SeatFixRoute =
  | { readonly kind: 'signIn'; readonly runtime: RuntimeId }
  | { readonly kind: 'usage'; readonly runtime: RuntimeId }
  | { readonly kind: 'settings'; readonly section: Section; readonly focus: string }
  | { readonly kind: 'agent'; readonly agent: string; readonly focus?: 'seats' }

/**
 * The one place a fix becomes a destination. A runtime's trouble is fixed
 * where runtimes live — signing in, its usage, its page in Settings ›
 * Runtimes, or adding it there — and only a seat the Agent itself asks for is
 * fixed on the Agent's own page, in the Agents window. So the one door to the
 * roster here is the one about an Agent; a sign-in never lands on it.
 */
export const routeFor = (fix: SeatFix, agent: string): SeatFixRoute => {
  switch (fix.kind) {
    case 'signIn':
      return { kind: 'signIn', runtime: fix.runtime as RuntimeId }
    case 'usage':
      return { kind: 'usage', runtime: fix.runtime as RuntimeId }
    case 'add':
      return { kind: 'settings', section: 'runtimes', focus: 'add' }
    case 'install':
    case 'runtime':
      return { kind: 'settings', section: 'runtimes', focus: fix.runtime }
    case 'seats':
      return { kind: 'agent', agent, focus: 'seats' }
  }
}
