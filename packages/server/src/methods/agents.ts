import { isAbsolute } from 'node:path'

import { isBlocked, type AgentRuntime, type FlowSeat, type UsageReport } from '@harnessdesk/protocol'

import { chooseSeat, explainRefusal, openedOtherwise, type SeatOffer } from '../agent-seating.js'
import { seatSpec } from '../flow.js'
import type { HostContext, MethodsUnder } from './context.js'

/**
 * The Agent roster, read — and one Agent, seated.
 *
 * Reads only, apart from seating. Writing an Agent is editing a file, and the
 * desk has an editor plane for that — a second write path for the same file is
 * a second answer to "what does this Agent say".
 *
 * Neither read verb catches. A directory of this machine's roster that exists
 * and cannot be read fails the call, naming the path and the reason, because a
 * person can act on that and cannot act on a roster that is quietly empty.
 * Nothing in a project fails it — a project arrives in a clone — and neither
 * does one `AGENT.md` that cannot be read or parsed: each arrives as an entry
 * with no definition and a problem saying why, and goes out as it came.
 */
export const agentMethods = {
  'agent/list': async (ctx, params) => ctx.agents.list(await projectOf(ctx, params.project)),
  'agent/read': async (ctx, params) => ctx.agents.read(params.id, await projectOf(ctx, params.project)),

  /**
   * Opens a conversation as an Agent, or refuses and opens nothing.
   *
   * Refuse, never substitute: a review signed by a model that did not write it
   * is worse than no review. So what can be known before a conversation exists
   * — installed, working, signed in, unspent, offering the model — is checked
   * before one is opened, and what only an open conversation can say is read
   * back from it and compared with what was asked. A seat running anything
   * else is closed, and the refusal says what differed. It is not replaced by
   * the next candidate: a runtime that opened on something other than it was
   * asked for is a finding about this desk, the refusal is where the person
   * learns it, and every further try would open — and leave in that runtime's
   * history — another conversation.
   *
   * The brief goes over once, as the standing order, through the same order
   * path a flow's seats are given theirs by. Re-sending it every turn would pay
   * for it every turn and say nothing new. Only then is the conversation
   * recorded as the Agent and the brief it was handed — a conversation whose
   * brief never arrived was not handed one.
   */
  'agent/seat': async (ctx, params) => {
    // The host would resolve a relative folder against wherever it was started.
    if (!isAbsolute(params.cwd)) throw new Error(`${params.cwd} is not an absolute path.`)
    // The same confinement agent/list and agent/read apply, through the same
    // helper. A second way to turn a renderer-supplied path into a directory to
    // read is a second place to get it wrong — and what is read here becomes a
    // model's standing order.
    const entry = await ctx.agents.read(params.id, await projectOf(ctx, params.project))
    if (!entry) throw new Error(`No Agent called “${params.id}”.`)
    const { definition, digest } = entry
    // A definition only exists when nothing was wrong enough to refuse it, and a
    // digest only when the file was read; both are narrowed here rather than
    // trusted, so the compiler holds that reasoning and not a comment.
    if (!definition || digest === null) {
      const problem = entry.problems.find((one) => one.level === 'error')
      throw new Error(
        `${entry.path} cannot be used: ${problem ? `${problem.at} — ${problem.text}` : 'it could not be read'}`,
      )
    }

    const candidates = params.seats?.length ? params.seats : definition.prefer
    const chosen = chooseSeat(candidates, await offersFor(ctx, candidates))
    if (!chosen.seat) throw new Error(explainRefusal(chosen.passed))
    const seat = chosen.seat
    const refuse = (why: string): Error => new Error(explainRefusal([...chosen.passed, { seat, why }]))

    let opened
    try {
      opened = await ctx.seats.open(seat, { cwd: params.cwd, title: definition.name })
    } catch (error) {
      throw refuse(`${seat.runtime} could not open a conversation: ${messageOf(error)}`)
    }
    const otherwise = openedOtherwise(seat, opened.running)
    if (otherwise !== null) {
      await ctx.seats.retire(opened.runtime, opened.sessionId)
      throw refuse(otherwise)
    }

    try {
      await ctx.seats.order(opened.runtime, opened.sessionId, definition.brief)
    } catch (error) {
      await ctx.seats.retire(opened.runtime, opened.sessionId)
      throw new Error(
        `${definition.name} was seated on ${seatSpec(seat)}, and its brief could not be handed over, so the conversation was closed: ${messageOf(error)}`,
      )
    }
    return ctx.seats.recordAgent(opened.runtime, opened.sessionId, { agent: definition.id, briefDigest: digest })
  },
} satisfies MethodsUnder<'agent/'>

/**
 * The project a request named, held to the folders opened here.
 *
 * A project's Agents are read from beneath it, and `project` crossed a socket
 * the host trusts nothing from: unconfined, a request could have the host list
 * `.harnessdesk/agents` under any directory on the disk and read what is in it.
 * So it answers to the rule the git verbs answer to, `confineGitRoot`: an open
 * folder, or the top of the repository an open folder sits in. The second half
 * is not a courtesy — a project keeps its Agents at the top of its repository,
 * and a person who opened a subfolder of it still means that repository. Both
 * sides are compared as real paths, so a link inside an open folder does not
 * lead out of it, and what is read is the path the host answered, not the text
 * that arrived.
 *
 * A relative path is refused here rather than handed on: the host would resolve
 * it against wherever it happened to be started.
 *
 * `id` needs no such check while the roster matches it against its own listing
 * and never joins it onto a path. A roster that learned to open one Agent's
 * file directly would have to hold `id` to a single path segment first.
 */
const projectOf = async (ctx: HostContext, project: string | undefined): Promise<string | undefined> => {
  if (project === undefined) return undefined
  if (!isAbsolute(project)) throw new Error(`${project} is not an absolute path.`)
  return ctx.workspaces.confineGitRoot(project)
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * What this desk can seat on each runtime the candidates name, read from the
 * desk itself — never assumed, and never a failed read passed off as an answer.
 *
 * - **Installed** is the runtime registry: a runtime this desk has not added has
 *   no offer, and neither has one that says it is not installed on this machine.
 * - **Unavailable** is its own health when that is not ready — too old, crashed,
 *   still starting — in its own words, and an account that would not answer.
 * - **Signed in** is the accounts plane: an account on it, or an agent that keeps
 *   its own credential where the desk cannot see it and so never asks for one.
 * - **Spent** is the usage the desk already reads, judged by the one rule every
 *   surface uses (`isBlocked`): an account-wide window, never one model's.
 * - **Models** is the runtime's own list, or null when it could not be read —
 *   never empty for unread, which the chooser would take for "offers none".
 * - **Efforts** are null: a runtime declares them per session, so they are held
 *   to account once the seat is open, not guessed at here.
 */
const offersFor = async (ctx: HostContext, candidates: readonly FlowSeat[]): Promise<SeatOffer[]> => {
  const runtimes = [...new Set(candidates.map((one) => one.runtime))].flatMap((id) => {
    const runtime = ctx.runtimes.get(id)
    return runtime ? [runtime] : []
  })
  if (runtimes.length === 0) return []
  const reports = await ctx.usage().reports()
  const offers = await Promise.all(runtimes.map((runtime) => offerOf(ctx, runtime, reports)))
  return offers.filter((offer): offer is SeatOffer => offer !== null)
}

const offerOf = async (
  ctx: HostContext,
  runtime: AgentRuntime,
  reports: readonly UsageReport[],
): Promise<SeatOffer | null> => {
  const id = String(runtime.info.id)
  const health = runtime.health()
  if (health.state === 'unavailable' && health.reason === 'notInstalled') return null
  // Nothing else is read about a runtime that cannot open a conversation; the chooser stops at why.
  const unread = { models: null, efforts: null, signedIn: false, spent: false }
  if (health.state === 'unavailable') {
    const why = health.remediation ? `${health.message} ${health.remediation}` : health.message
    return { runtime: id, unavailable: why, ...unread }
  }
  if (health.state === 'starting') return { runtime: id, unavailable: 'it is still starting', ...unread }

  let signedIn = true
  // An agent that keeps its own credential is never asked to sign in here.
  if (ctx.runtimes.infoOf(runtime).capabilities.account !== false) {
    try {
      signedIn = (await runtime.getAccount()).accounts.length > 0
    } catch (error) {
      return { runtime: id, unavailable: `its account could not be read — ${messageOf(error)}`, ...unread }
    }
  }
  const report = reports.find((one) => one.runtime === runtime.info.id)
  return {
    runtime: id,
    models: await runtime.listModels().then(
      (models) => models.map((one) => one.id),
      () => null,
    ),
    efforts: null,
    signedIn,
    spent: report ? isBlocked(report) : false,
  }
}
