import { isAbsolute } from 'node:path'

import { isBlocked, type AgentRuntime, type FlowSeat, type UsageReport } from '@harnessdesk/protocol'

import {
  agentOrder,
  chooseSeat,
  differences,
  explainRefusal,
  passedFor,
  permissionWithin,
  type PassedOver,
  type SeatOffer,
} from '../agent-seating.js'
import { seatSpec } from '../flow.js'
import type { OpenedSeat } from '../host.js'
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
   * Opens a conversation as an Agent, or refuses and leaves nothing open.
   *
   * Refuse, never substitute: a review signed by a model that did not write it
   * is worse than no review. So what can be known before a conversation exists
   * — installed, working, signed in, unspent, offering the model — is checked
   * before one is opened, and what only an open conversation can say is read
   * back from it and compared with what was asked. A seat that will not open,
   * or opens running anything else, is closed and passed over, and the next
   * candidate the Agent named is tried — exactly as a candidate found wanting
   * before opening is. The next candidate is one the Agent asked for, so trying
   * it substitutes nothing; and whether a fact came to light before opening or
   * after must not decide whether the seating goes on. Only when every
   * candidate has failed is the call refused, with one list: every candidate,
   * and why.
   *
   * One seat at a time. A seat that is not kept is closed, and let go by the
   * host, before the next is opened, so one seating never has two conversations
   * open at once; the most it can open and close is the length of `prefer`.
   *
   * The brief goes over once, as the standing order, through the same order
   * path a flow's seats are given theirs by. Re-sending it every turn would pay
   * for it every turn and say nothing new. A seat whose brief could not be
   * handed over is closed and the call fails there, not down the list: the
   * brief may have reached that conversation although the handing-over failed,
   * and trying another seat could leave two at work on it. Only once the brief
   * is over is the conversation recorded as the Agent and the brief it was
   * handed — a conversation whose brief never arrived was not handed one.
   *
   * The order ends with the rule of the permission the seat holds: the narrower
   * of the Agent's ceiling and the call's grant, and the grant is `read` when
   * the call makes none, because seating has no step to grant anything more.
   * It is the flow's own sentence for that permission (`agentOrder`), and it is
   * recorded beside the Agent. Told, not enforced — which is also all a flow
   * seat's permission is until the tool surface holds seats to it.
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

    const permission = permissionWithin(definition.permission, params.permission ?? 'read')
    const candidates = params.seats?.length ? params.seats : definition.prefer
    const offers = await offersFor(ctx, candidates)
    const passed: PassedOver[] = []
    for (let rest = candidates; ; ) {
      const chosen = chooseSeat(rest, offers)
      passed.push(...chosen.passed)
      if (!chosen.seat) throw new Error(explainRefusal(passed))
      const seat = chosen.seat
      // Every candidate above the one chosen was passed over, so what is left starts just below it.
      rest = rest.slice(chosen.passed.length + 1)
      const opened = await openAsAsked(ctx, seat, { cwd: params.cwd, title: definition.name })
      if ('reason' in opened) {
        passed.push(opened)
        continue
      }

      try {
        await ctx.seats.order(opened.runtime, opened.sessionId, agentOrder(definition.brief, permission, params.cwd))
      } catch (error) {
        await ctx.seats.retire(opened.runtime, opened.sessionId)
        throw new Error(
          `${definition.name} was seated on ${seatSpec(seat)}, and its brief could not be handed over, so the conversation was closed: ${messageOf(error)}`,
        )
      }
      return ctx.seats.recordAgent(opened.runtime, opened.sessionId, {
        agent: definition.id,
        briefDigest: digest,
        permission,
      })
    }
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
 * Opens one candidate and holds it to what it asked for: the open seat, or the
 * candidate passed over with why — and then nothing of it is left open.
 *
 * A seat that fails part-way through opening is closed by the host before the
 * failure reaches here; one that opens on something else is closed here, and
 * the close is waited for, so the next candidate is only opened once this one
 * is gone.
 */
const openAsAsked = async (
  ctx: HostContext,
  seat: FlowSeat,
  where: { readonly cwd: string; readonly title: string },
): Promise<OpenedSeat | PassedOver> => {
  let opened: OpenedSeat
  try {
    opened = await ctx.seats.open(seat, where)
  } catch (error) {
    return passedFor(seat, { kind: 'couldNotOpen', detail: messageOf(error) })
  }
  const found = differences(seat, opened.running)
  if (found.length === 0) return opened
  await ctx.seats.retire(opened.runtime, opened.sessionId)
  return passedFor(seat, { kind: 'openedOtherwise', detail: found.join(', and ') })
}

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
 *   never empty for unread, which the chooser would take for "offers none",
 *   and which is exactly what a picker's list says about an agent that never
 *   managed to declare one (`modelsOf`).
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
  return Promise.all(runtimes.map((runtime) => offerOf(ctx, runtime, reports)))
}

const offerOf = async (
  ctx: HostContext,
  runtime: AgentRuntime,
  reports: readonly UsageReport[],
): Promise<SeatOffer> => {
  const id = String(runtime.info.id)
  const health = runtime.health()
  // Nothing else is read about a runtime that cannot open a conversation; the chooser stops at why.
  const unread = { models: null, efforts: null, signedIn: false, spent: false }
  /* Added, and its program is missing. Offered with that said rather than
     dropped: a runtime nobody added is fixed by adding it, and this one by
     installing what it runs, and only an offer can carry the difference. */
  if (health.state === 'unavailable' && health.reason === 'notInstalled') {
    return { runtime: id, notInstalled: true, ...unread }
  }
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
    models: await modelsOf(runtime),
    efforts: null,
    signedIn,
    spent: report ? isBlocked(report) : false,
  }
}

/**
 * The ids of the models a runtime offers, or null when it could not say.
 *
 * `listModels` is the picker's question, and a picker would rather draw nothing
 * than an error: the ACP adapter answers it with an empty list when its agent
 * never managed to declare a catalogue. To the chooser empty is "offers none",
 * so a runtime that can tell the two apart is asked the way that does
 * (`knownModels`); any other is asked `listModels`, and its failing is its
 * "could not say".
 */
const modelsOf = async (runtime: AgentRuntime): Promise<readonly string[] | null> => {
  try {
    const models = await (runtime.knownModels ? runtime.knownModels() : runtime.listModels())
    return models?.map((one) => one.id) ?? null
  } catch {
    return null
  }
}
