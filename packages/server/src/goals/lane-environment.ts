import { laneEnvironmentOf, type Lane } from '@harnessdesk/protocol'

import { laneEnvironment } from './lanes.js'

const LANE_KEYS = [
  'HARNESSDESK_GOAL_ID',
  'HARNESSDESK_LANE_ID',
  'HARNESSDESK_PORT_START',
  'HARNESSDESK_PORT_END',
  'HARNESSDESK_PORT_COUNT',
  'PORT',
] as const

/** A retained checkout keeps its allocation after its Seat is released. */
export function environmentForCheckout(
  cwd: string,
  lanes: readonly Lane[],
): Readonly<Record<string, string>> | undefined {
  const matches = lanes.filter((lane) => lane.cwd !== '' && lane.cwd === cwd)
  if (matches.length > 1) {
    throw new Error('This checkout has conflicting lane records. Repair them before reopening it.')
  }
  return matches[0] ? laneEnvironmentOf(laneEnvironment(matches[0])) : undefined
}

/** Finds a retained lane by its durable Seat without asking the runtime to reopen first. */
export function environmentForSession(
  runtime: string,
  sessionId: string,
  lanes: readonly Lane[],
  seats: readonly {
    readonly id: string
    readonly session: { readonly runtime: string; readonly sessionId: string }
  }[],
): Readonly<Record<string, string>> | undefined {
  const seatIds = new Set(
    seats
      .filter((seat) => seat.session.runtime === runtime && seat.session.sessionId === sessionId)
      .map((seat) => seat.id),
  )
  const matches = lanes.filter((lane) => lane.seat !== null && seatIds.has(lane.seat))
  if (matches.length > 1) {
    throw new Error('This conversation has conflicting lane records. Repair them before reopening it.')
  }
  return matches[0] ? laneEnvironmentOf(laneEnvironment(matches[0])) : undefined
}

export function requireLaneSupport(
  runtime: { capabilities: { sessionEnvironment: boolean }; presentation: { name: string } },
  environment: Readonly<Record<string, string>> | undefined,
): void {
  if (environment && !runtime.capabilities.sessionEnvironment) {
    throw new Error(
      `${runtime.presentation.name} cannot pass a lane environment to a session. ` +
        'Choose a runtime with lane support, or turn isolation off.',
    )
  }
}

/** Appends the durable lane allocation to the Seat's one standing-order turn. */
export function laneStandingOrder(
  text: string,
  environment: Readonly<Record<string, string>> | undefined,
): string {
  if (!environment) return text
  const lane = laneEnvironmentOf(environment)
  const values = LANE_KEYS.map((key) => `${key}=${lane[key]}`).join('\n')
  return (
    `${text}\n\nThis Seat has a dedicated HarnessDesk lane. Its environment has:\n${values}\n\n` +
    'Use PORT as the default. Applications that ignore PORT must be started with an explicit port argument ' +
    'inside HARNESSDESK_PORT_START through HARNESSDESK_PORT_END (inclusive).'
  )
}
