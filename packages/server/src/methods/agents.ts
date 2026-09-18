import { isAbsolute } from 'node:path'

import {
  BriefNotHandedOverError,
  isBlocked,
  SeatRefusedError,
  type AgentEntry,
  type AgentRuntime,
  type FlowSeat,
  type ModelInfo,
  type RuntimeHealth,
  type UsageReport,
} from '@harnessdesk/protocol'

import {
  agentOrder,
  blockedPlan,
  candidateOf,
  chooseSeat,
  describeSeat,
  differencesOf,
  effortWord,
  explainRefusal,
  leftOnFailure,
  passedFor,
  permissionWithin,
  planSeats,
  type PassedOver,
  type SeatOffer,
  type SeatWords,
} from '../agent-seating.js'
import type { OpenedSeat } from '../host.js'
import { knownAgent } from '../installs/known-agents.js'
import { SEAT_READ_DEADLINE_MS, within } from '../seat-reads.js'
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
   * Which seat each Agent would take here, and why not the others, opening
   * nothing. The desk is read once for every runtime any of them names — the
   * same reads, and the same deadline, as a real seating — so a menu listing
   * ten Agents asks each runtime once, not ten times.
   *
   * "Opens nothing" means no conversation, for any Agent named here, and
   * names none either. It does not mean nothing runs: an ACP agent that has
   * never declared its models yet, in this process, has that answered by
   * `catalogueOf` → `knownModels`, which starts the agent's own hidden probe
   * once to learn it (`adapter-acp/src/runtime.ts`) — the same probe a real
   * seating or the model picker would have started to ask the same question.
   */
  'agent/seat/dry': async (ctx, params) => {
    const roster = await ctx.agents.list(await projectOf(ctx, params.project))
    const ids = params.ids ?? roster.map((one) => one.id)
    const entries = ids.map((id) => ({ id, entry: roster.find((one) => one.id === id) ?? null }))
    const desk = await readDesk(
      ctx,
      entries.flatMap(({ entry }) => entry?.definition?.prefer ?? []),
    )
    const words = wordsFor(ctx, desk.catalogues, desk.registryNames)
    return entries.map(({ id, entry }) => {
      if (!entry) return blockedPlan(id, `No Agent called “${id}”.`)
      if (!entry.definition || entry.digest === null) return blockedPlan(id, unusable(entry))
      return planSeats(id, entry.definition.prefer, desk.offers, words)
    })
  },

  /**
   * Opens a conversation as an Agent, or refuses and leaves nothing open.
   *
   * Refuse, never substitute: a review signed by a model that did not write it
   * is worse than no review. So what can be known before a conversation exists
   * — installed, working, signed in, unspent, offering the model — is checked
   * before one is opened, and what only an open conversation can say is read
   * back from it and compared with what was asked. A seat that will not open,
   * or opens running anything else, is discarded and passed over, and the next
   * candidate the Agent named is tried — exactly as a candidate found wanting
   * before opening is. The next candidate is one the Agent asked for, so trying
   * it substitutes nothing; and whether a fact came to light before opening or
   * after must not decide whether the seating goes on. Only when every
   * candidate has failed is the call refused, with one list: every candidate,
   * and why.
   *
   * Discarded is the host's word (`HostContext['seats']['discard']`): closed,
   * deleted where its runtime keeps it, and forgotten by the desk — unless
   * somebody used it while it was open, and then left as it is, the handle
   * they are using it on included. What each was left as is said on its line.
   *
   * One seat at a time. A seat that is not kept is discarded by the host before
   * the next is opened, so one seating never holds two conversations open at
   * once — one somebody took up meanwhile is theirs, not the seating's; the
   * most it can open is the length of `prefer`.
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
    if (!definition || digest === null) throw new Error(unusable(entry))

    const permission = permissionWithin(definition.permission, params.permission ?? 'read')
    const candidates = params.seats?.length ? params.seats : definition.prefer
    const desk = await readDesk(ctx, candidates)
    const offers = desk.offers
    const words = wordsFor(ctx, desk.catalogues, desk.registryNames)
    const said = (list: readonly PassedOver[]) => list.map((one) => candidateOf(one, words))
    const passed: PassedOver[] = []
    for (let rest = candidates; ; ) {
      const chosen = chooseSeat(rest, offers)
      passed.push(...chosen.passed)
      if (!chosen.seat) throw new SeatRefusedError(explainRefusal(passed), { candidates: said(passed) })
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
        // In the seat's own words, never its spec (`SeatCandidate.seat`'s "never
        // shown" applies here too) — and its own code, the way `SeatRefusedError`
        // carries one, so a surface can tell this apart from a refusal it never
        // opened anything for.
        throw new BriefNotHandedOverError(
          `${definition.name} was seated on ${describeSeat(seat, words)}, and its brief could not be handed over, so the conversation was closed: ${messageOf(error)}`,
        )
      }
      return ctx.seats.recordAgent(opened.runtime, opened.sessionId, {
        agent: definition.id,
        briefDigest: digest,
        permission,
        seatLabel: opened.label,
        passedOver: said(passed),
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

/** Why an entry cannot be seated: its first error, where it is, in the file's own terms. */
const unusable = (entry: AgentEntry): string => {
  const problem = entry.problems.find((one) => one.level === 'error')
  return `${entry.path} cannot be used: ${problem ? `${problem.at} — ${problem.text}` : 'it could not be read'}`
}

/**
 * A registry snapshot's name for an id, worth showing: never blank or
 * whitespace, and null both when the id is not there and when the name it
 * gave it is nothing a label should start with.
 */
const registryNameIn = (names: ReadonlyMap<string, string>, id: string): string | null =>
  names.get(id)?.trim() || null

/**
 * The words a seat is said in here. A runtime added to the desk by the name
 * it presents; one that is not, by the name the desk knows it by
 * (`knownAgent`), or, failing that, the name `registryNames` gives it —
 * `readDesk`'s own snapshot of the public registry (`desk.registryNames`),
 * the same one `couldAdd` already judged the id against, so a name is never
 * read from a fresher document than the fix was; and one neither names, by
 * its id, which is the last word left. A model and an effort by the labels
 * its runtime answered with, where it answered.
 */
const wordsFor = (
  ctx: HostContext,
  catalogues: ReadonlyMap<string, readonly ModelInfo[]>,
  registryNames: ReadonlyMap<string, string> = new Map(),
): SeatWords => {
  const model = (runtime: string, id: string | null | undefined) =>
    id ? catalogues.get(runtime)?.find((one) => one.id === id) : undefined
  return {
    runtime: (id) => {
      const runtime = ctx.runtimes.get(id)
      if (runtime) return ctx.runtimes.infoOf(runtime).presentation.name
      return knownAgent(id)?.name ?? registryNameIn(registryNames, id) ?? id
    },
    model: (runtime, id) => model(runtime, id)?.displayName ?? id,
    effort: (runtime, id, effort) =>
      model(runtime, id)?.reasoningLevels.find((level) => level.id === effort)?.label ?? effortWord(effort),
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Opens one candidate and holds it to what it asked for: the open seat, or the
 * candidate passed over with why — and then nothing the seating opened is left
 * open, unless somebody took it up meanwhile.
 *
 * A seat that fails part-way through opening is discarded by the host before
 * the failure reaches here, and what that left is noted on the failure
 * (`leftOnFailure`) — as is a runtime answering with a conversation the desk
 * already holds, which is refused before anything is done to it; one that
 * opens on something else is discarded here (`ctx.seats.discard`), and the
 * discard is waited for, so the next candidate is only opened once this one is
 * gone. Either way, what the conversation was left as goes on the candidate's
 * line — left as it is, because somebody used it or it was never the
 * seating's, or archived, because it could not be deleted — never dropped.
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
    const left = leftOnFailure(error)
    return { ...passedFor(seat, { kind: 'couldNotOpen', detail: messageOf(error) }), ...(left ? { left } : {}) }
  }
  const found = differencesOf(seat, opened.running)
  if (found.length === 0) return opened
  const left = await ctx.seats.discard(opened.runtime, opened.sessionId)
  return { ...passedFor(seat, { kind: 'openedOtherwise', differences: found }), left }
}

/**
 * What this desk can seat on each runtime named, and the models each
 * answered with — one read, for every Agent a dry run or a seating asks
 * about at once.
 */
interface Desk {
  readonly offers: readonly SeatOffer[]
  /** Each runtime's models as it named them, where the list was read — for the words, not the choice. */
  readonly catalogues: ReadonlyMap<string, readonly ModelInfo[]>
  /**
   * The public registry's ids and names, from the one cache read this call
   * made to judge an id neither added nor known — empty when nothing here
   * ever needed one. Carried so `wordsFor` names a candidate from the same
   * document `couldAdd` judged it against, never a second, possibly fresher,
   * read of the same cache.
   */
  readonly registryNames: ReadonlyMap<string, string>
}

/**
 * What this desk can seat on each runtime the candidates name, read from the
 * desk itself — never assumed, and never a failed read passed off as an answer.
 *
 * - **Installed** is the runtime registry. A runtime this desk has added, with
 *   its program on this machine, is read below for what it offers; one added
 *   whose program is not on this machine gets an offer that says so
 *   (`notInstalled`), and nothing more of it is read. An id this desk has not
 *   added gets no offer at all when it could be added (`couldAdd`), and an
 *   offer that says so when it could not (`unknownRuntime`) — never read as
 *   though adding it would help.
 * - **Unavailable** is its own health when that is not ready — too old,
 *   crashed, still starting — in its own words; or, when asking for its
 *   account failed outright, that failure, in the words it came back with.
 * - **Silent** is its account not answering within the deadline: nothing else
 *   about the runtime is read, and it is not waited for past it.
 * - **Signed in** is the accounts plane: an account on it, or an agent that keeps
 *   its own credential where the desk cannot see it and so never asks for one.
 * - **Spent** is the usage the desk already reads, judged by the one rule every
 *   surface uses (`isBlocked`): an account-wide window, never one model's.
 * - **Models** is the runtime's own list, or null when it could not be read —
 *   never empty for unread, which the chooser would take for "offers none",
 *   and which is exactly what a picker's list says about an agent that never
 *   managed to declare one (`catalogueOf`).
 * - **Efforts** are null: a runtime declares them per session, so they are held
 *   to account once the seat is open, not guessed at here.
 */
export const readDesk = async (ctx: HostContext, candidates: readonly FlowSeat[]): Promise<Desk> => {
  const ids = [...new Set(candidates.map((one) => one.runtime))]
  const runtimes: AgentRuntime[] = []
  /*
   * The registry snapshot `couldAdd` and, later, `wordsFor` both judge an id
   * against — read at most once per call, lazily, the first time this loop
   * meets an id that is neither added nor `knownAgent`. Two separate reads of
   * the cache, one here and another when the plan is named, could straddle a
   * refetch between them and give one candidate a fix from one document and a
   * name from another; this call reads it once and both questions are put to
   * that one answer.
   */
  let registryNames: ReadonlyMap<string, string> | null = null
  const registrySnapshot = (): ReadonlyMap<string, string> => {
    registryNames ??= ctx.options.agents?.registryNames() ?? new Map()
    return registryNames
  }
  // An id this desk has not added but could, and one it could not add at
  // all, are not the same refusal — the first is fixed by adding it, the
  // second only by fixing the seats that name it — so which of the two an id
  // is gets decided here, once, rather than at every candidate naming it.
  const unknown: SeatOffer[] = []
  for (const id of ids) {
    const runtime = ctx.runtimes.get(id)
    if (runtime) {
      runtimes.push(runtime)
    } else if (!couldAdd(id, registrySnapshot)) {
      unknown.push({ runtime: id, unknownRuntime: true, models: null, efforts: null, signedIn: false, spent: false })
    }
  }
  if (runtimes.length === 0) return { offers: unknown, catalogues: new Map(), registryNames: registryNames ?? new Map() }
  const deadline = seatReadDeadline(ctx)
  // Started, not yet awaited: usage is read for every runtime at once, and
  // waiting for it here before a single account or model read even begins is
  // exactly the wait this deadline exists to bound. `offerOf` awaits it only
  // once it actually needs `reports`, near the end of its own reads, so the
  // two run concurrently.
  const reports = usageWithin(ctx, runtimes, deadline)
  const reads = runtimes.map((runtime) => offerOf(ctx, runtime, reports, deadline))
  // Every read settles before anything is answered, a failure included.
  // `Promise.all` gives up at the first read that throws, and this call would
  // then return with the usage read, and every other runtime's reads, still
  // running behind it — each on a timer of its own.
  for (const read of await Promise.allSettled([reports, ...reads])) {
    if (read.status === 'rejected') throw read.reason
  }
  const settled = await Promise.all(reads)
  return {
    offers: [...settled.map((one) => one.offer), ...unknown],
    catalogues: new Map(settled.flatMap((one) => (one.catalogue ? [[one.offer.runtime, one.catalogue] as const] : []))),
    registryNames: registryNames ?? new Map(),
  }
}

/**
 * Whether an id this desk has not added is one it could add: an agent the
 * desk knows how to run (`knownAgent`), or one `registryNames` — the given
 * snapshot of the public registry, as it was last fetched — lists. What
 * Settings › Runtimes offers to add. `registryNames` is read only when
 * `knownAgent` does not already answer, so a candidate this desk knows of its
 * own accord never touches the registry cache at all; the snapshot itself is
 * `readDesk`'s own, read from the cache and never fetched for this (see
 * `readDesk`): every read a seating makes before it chooses is held to the
 * seating's deadline, and a fetch would not be. With nothing cached, the
 * desk's own list decides alone.
 */
const couldAdd = (id: string, registryNames: () => ReadonlyMap<string, string>): boolean =>
  knownAgent(id) !== undefined || registryNames().has(id)

/** `seatReadDeadlineMs`, held to a deadline a real timer can use: finite and positive, or the default. */
const seatReadDeadline = (ctx: HostContext): number => {
  const ms = ctx.options.seatReadDeadlineMs
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : SEAT_READ_DEADLINE_MS
}

/**
 * The usage each runtime reports, within the deadline — or, past it, the last
 * reading the desk already holds for it.
 *
 * Usage is read for every runtime at once, so one silent source would hold
 * every seating. A window the desk cannot read now is one the runtime states
 * again on the first turn, and the last reading is still a reading; a runtime
 * with none is not known to be spent, exactly as before a reading exists.
 *
 * The fallback is metered runtimes only (`ctx.runtimes.metered`), the same
 * runtimes the normal path would have reported on: one switched off is never
 * read for usage at all, so an old cached reading for it — if that runtime
 * had one before it was switched off — must not be read back in here as
 * today's answer.
 */
const usageWithin = async (
  ctx: HostContext,
  runtimes: readonly AgentRuntime[],
  deadline: number,
): Promise<readonly UsageReport[]> => {
  const read = await within(() => ctx.usage().reports(), deadline)
  if (read.settled === 'value') return read.value
  if (read.settled === 'late') {
    ctx.logger.warn('a seating read no usage within its deadline, so the last readings stand in', { afterMs: deadline })
  } else {
    ctx.logger.warn('a seating could not read usage, so the last readings stand in', { error: String(read.error) })
  }
  const metered = new Set(ctx.runtimes.metered().map((runtime) => String(runtime.info.id)))
  return runtimes.flatMap((runtime) => {
    if (!metered.has(String(runtime.info.id))) return []
    const last = ctx.usage().cached(runtime.info.id)
    return last ? [last] : []
  })
}

export const offerOf = async (
  ctx: HostContext,
  runtime: AgentRuntime,
  reports: Promise<readonly UsageReport[]>,
  deadline: number,
): Promise<{ readonly offer: SeatOffer; readonly catalogue: readonly ModelInfo[] | null }> => {
  const id = String(runtime.info.id)
  // Nothing else is read about a runtime that cannot open a conversation; the chooser stops at why.
  const unread = { models: null, efforts: null, signedIn: false, spent: false }
  const only = (offer: SeatOffer) => ({ offer, catalogue: null })
  let health: RuntimeHealth
  try {
    health = runtime.health()
  } catch (error) {
    // A runtime that cannot even say whether it is ready is passed over with
    // that said — the same as one that answered "unavailable" itself — and
    // not a reason for every other candidate's own read to go unanswered:
    // one runtime's read failing must not blank the whole desk's plan.
    return only({ runtime: id, unavailable: messageOf(error), ...unread })
  }
  /* Added, and its program is missing. Offered with that said rather than
     dropped: a runtime nobody added is fixed by adding it, and this one by
     installing what it runs, and only an offer can carry the difference. */
  if (health.state === 'unavailable' && health.reason === 'notInstalled') {
    return only({ runtime: id, notInstalled: true, ...unread })
  }
  if (health.state === 'unavailable') {
    const why = health.remediation ? `${health.message} ${health.remediation}` : health.message
    return only({ runtime: id, unavailable: why, ...unread })
  }
  if (health.state === 'starting') return only({ runtime: id, unavailable: 'it is still starting', ...unread })

  let signedIn = true
  // An agent that keeps its own credential is never asked to sign in here.
  if (ctx.runtimes.infoOf(runtime).capabilities.account !== false) {
    const account = await within(() => runtime.getAccount(), deadline)
    if (account.settled === 'late') return only({ runtime: id, silent: deadline, ...unread })
    if (account.settled === 'error') {
      return only({ runtime: id, unavailable: `its account could not be read — ${messageOf(account.error)}`, ...unread })
    }
    signedIn = account.value.accounts.length > 0
  }
  const catalogue = await catalogueOf(runtime, deadline)
  const resolved = await reports
  const report = resolved.find((one) => one.runtime === runtime.info.id)
  return {
    offer: {
      runtime: id,
      models: catalogue?.map((one) => one.id) ?? null,
      efforts: null,
      signedIn,
      spent: report ? isBlocked(report) : false,
    },
    catalogue,
  }
}

/**
 * The models a runtime offers, or null when it could not say — failing, or
 * not saying within the deadline, which is the same "could not say" here.
 *
 * `listModels` is the picker's question, and a picker would rather draw nothing
 * than an error: the ACP adapter answers it with an empty list when its agent
 * never managed to declare a catalogue. To the chooser empty is "offers none",
 * so a runtime that can tell the two apart is asked the way that does
 * (`knownModels`); any other is asked `listModels`.
 */
const catalogueOf = async (runtime: AgentRuntime, deadline: number): Promise<readonly ModelInfo[] | null> => {
  const read = await within(() => (runtime.knownModels ? runtime.knownModels() : runtime.listModels()), deadline)
  return read.settled === 'value' ? (read.value ?? null) : null
}
