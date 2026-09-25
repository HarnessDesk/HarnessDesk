import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { CheckRun, Sha } from '@harnessdesk/protocol'

import { isSha } from './records.js'

/**
 * What the forge says about a checkout's branch: its pull request, and the
 * checks the forge ran on that pull request's head. Read with the person's own
 * `gh`, the way the forge plane reaches it (`../forge.ts`) — through
 * `execFile`, never a shell — in the checkout, so `gh` finds the branch's
 * pull request itself.
 *
 * Observed, never reported: this is the desk reading the forge, not an agent
 * saying what it opened.
 */

/** `gh`, run in a checkout. Overridable so a test answers as the forge would. */
export type GhInCheckout = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>

const run = promisify(execFile)

export const ghInCheckout: GhInCheckout = async (args, cwd) => {
  try {
    const result = await run('gh', [...args], { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    return {
      stdout: failure.stdout?.toString() ?? '',
      stderr: failure.stderr?.toString() ?? failure.message ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    }
  }
}

/** The fields asked for, and nothing more. */
export const PR_FIELDS = 'number,state,headRefOid,url,statusCheckRollup'

export type PullRequestRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'unreachable'; readonly why: string }
  | {
      readonly kind: 'found'
      readonly pr: { readonly number: number; readonly head: Sha; readonly state: 'open' | 'merged' | 'closed'; readonly url: string | null }
      readonly ci: readonly CheckRun[]
    }

const STATES: Readonly<Record<string, 'open' | 'merged' | 'closed'>> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/** One entry of the forge's roll-up, as a check run with a state a surface can draw. */
const checkRunOf = (value: unknown): CheckRun | null => {
  const entry = value as {
    __typename?: unknown
    name?: unknown
    context?: unknown
    status?: unknown
    conclusion?: unknown
    state?: unknown
    detailsUrl?: unknown
    targetUrl?: unknown
  } | null
  if (typeof entry !== 'object' || entry === null) return null
  const name = typeof entry.name === 'string' ? entry.name : typeof entry.context === 'string' ? entry.context : null
  if (name === null) return null
  const url = typeof entry.detailsUrl === 'string' ? entry.detailsUrl : typeof entry.targetUrl === 'string' ? entry.targetUrl : null
  const word = (value: unknown): string => (typeof value === 'string' ? value.toUpperCase() : '')
  if (entry.__typename === 'StatusContext' || entry.context !== undefined) {
    const state = word(entry.state)
    return {
      name,
      url,
      state: state === 'SUCCESS' ? 'passed' : state === 'FAILURE' || state === 'ERROR' ? 'failed' : 'pending',
    }
  }
  if (word(entry.status) !== 'COMPLETED') return { name, url, state: 'pending' }
  const conclusion = word(entry.conclusion)
  return {
    name,
    url,
    state:
      conclusion === 'SUCCESS'
        ? 'passed'
        : conclusion === 'CANCELLED'
          ? 'cancelled'
          : ['SKIPPED', 'NEUTRAL', 'STALE'].includes(conclusion)
            ? 'skipped'
            : 'failed',
  }
}

/** The checkout's branch's pull request and its checks, or why there is none to read. */
export const readPullRequest = async (cwd: string, gh: GhInCheckout = ghInCheckout): Promise<PullRequestRead> => {
  const answer = await gh(['pr', 'view', '--json', PR_FIELDS], cwd)
  if (answer.exitCode !== 0) {
    const said = `${answer.stderr} ${answer.stdout}`.trim()
    if (/no pull requests? found/i.test(said)) return { kind: 'none' }
    return { kind: 'unreachable', why: said.split('\n')[0] || 'gh could not answer.' }
  }
  let parsed: { number?: unknown; state?: unknown; headRefOid?: unknown; url?: unknown; statusCheckRollup?: unknown }
  try {
    parsed = JSON.parse(answer.stdout) as typeof parsed
  } catch {
    return { kind: 'unreachable', why: 'gh answered with something that is not JSON.' }
  }
  const state = typeof parsed.state === 'string' ? STATES[parsed.state.toUpperCase()] : undefined
  const head = typeof parsed.headRefOid === 'string' ? parsed.headRefOid.toLowerCase() : ''
  if (!Number.isInteger(parsed.number) || state === undefined || !isSha(head)) {
    return { kind: 'unreachable', why: 'gh answered without a pull request number, state or head.' }
  }
  const ci = (Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : []).flatMap((one) => {
    const check = checkRunOf(one)
    return check ? [check] : []
  })
  return {
    kind: 'found',
    pr: { number: parsed.number as number, head, state, url: typeof parsed.url === 'string' ? parsed.url : null },
    ci,
  }
}
