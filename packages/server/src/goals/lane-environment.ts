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

/**
 * The environment a runtime is handed for a lane: all six values when it can
 * take them per session, and none when it cannot — never a refusal.
 *
 * What a lane needs from a runtime is its checkout. The checkout is the
 * Seat's cwd, which every runtime takes, and it is the confinement: the cwd
 * comes only from the desk's own lane record, and a Seat whose checkout is not
 * its lane's is released (`LANE_REFUSED`). The browser profile is found by
 * that cwd (`setBrowserResolver`), not by anything in the agent's
 * environment. The ports are a reservation, and the agent is told them in its
 * standing order either way (`laneStandingOrder`); the environment variables
 * are a convenience on top, for commands that read `PORT` on their own.
 *
 * So nothing in a lane depends on a variable the agent's process must carry,
 * and refusing a runtime that cannot take them per session refused every
 * isolated Seat on it: a comparison with one competitor on an agent whose own
 * ACP server claims nothing, or on a row running a bridge built before lane
 * support, could not start at all. Such a runtime runs in its lane without the
 * variables, and its standing order says so.
 *
 * `sessionEnvironment` is an observation — an ACP agent claims it in its
 * handshake — so a runtime that has not shaken hands yet is handed none; its
 * adapter would refuse them anyway (`environmentMeta`).
 */
export function laneEnvironmentFor(
  runtime: { readonly info: { capabilities: { sessionEnvironment: boolean } } },
  environment: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  return environment && runtime.info.capabilities.sessionEnvironment ? environment : undefined
}

/**
 * Appends the durable lane allocation to the Seat's one standing-order turn.
 *
 * `handed` says whether the runtime was given the values as environment
 * variables (`laneEnvironmentFor`). When it was not, the values are the same
 * reservation and the order says to pass them to each command explicitly —
 * nothing in the agent's environment will.
 */
export function laneStandingOrder(
  text: string,
  environment: Readonly<Record<string, string>> | undefined,
  handed = true,
): string {
  if (!environment) return text
  const lane = laneEnvironmentOf(environment)
  const values = LANE_KEYS.map((key) => `${key}=${lane[key]}`).join('\n')
  const heading = handed
    ? 'Its environment has:'
    : 'Its reserved values are below. They are not set in your environment, so give them to each command explicitly (for example PORT=' +
      `${lane['PORT']} before the command):`
  return (
    `${text}\n\nThis Seat has a dedicated HarnessDesk lane. ${heading}\n${values}\n\n` +
    'Use PORT as the default. Applications that ignore PORT must be started with an explicit port argument ' +
    'inside HARNESSDESK_PORT_START through HARNESSDESK_PORT_END (inclusive).'
  )
}
