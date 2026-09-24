import { basename, dirname, isAbsolute, join } from 'node:path'

import { digestOf } from '@harnessdesk/agent-inventory'

import {
  AGENT_DESCRIPTION_LIMIT,
  AGENT_NAME_LIMIT,
  BriefNotHandedOverError,
  isCeilingLevel,
  isBlocked,
  remainingOf,
  SeatRefusedError,
  type AgentDefinition,
  type AgentEntry,
  type AgentId,
  type AgentOrigin,
  type AgentRuntime,
  type CeilingLevel,
  type FlowSeat,
  type HostMethods,
  type MachineSeating,
  type ModelInfo,
  type RuntimeHealth,
  type SeatPlan,
  type SeatGrant,
  type SeatId,
  type SeatRecord,
  type SessionAttachmentReceipt,
  type SessionAttachments,
  type UsageReport,
  runtimeId,
  sessionId as makeSessionId,
} from '@harnessdesk/protocol'
import type { AttachmentSubject, PreparedAttachments } from '../attachments/plane.js'

import { ceilingEdit, parseAgentDefinition } from '../agent-def.js'
import { incarnationOf } from '../evidence/seen.js'
import type { SeatedAs } from '../registry.js'
import {
  agentIdOf,
  agentSource,
  copyAgentFolder,
  createAgentFolder,
  projectAgentDir,
  projectAgentFolder,
  readAgentSource,
  rewriteAgentFile,
  rollbackCreatedAgent,
  userAgentFolder,
} from '../agent-files.js'
import { isReservedId, reservedIdText } from '../agent-seating-file.js'
import { unheldPolicy } from '../ceilings/policy.js'
import {
  agentOrder,
  blockedPlan,
  candidateOf,
  ceilingWithin,
  chooseSeat,
  describeSeat,
  differencesOf,
  effortWord,
  explainRefusal,
  grantOf,
  leftOnFailure,
  passedFor,
  planSeats,
  standingOf,
  type CeilingNeed,
  type PassedOver,
  type SeatOffer,
  type SeatWords,
} from '../agent-seating.js'
import { AGENT_FILE_LIMIT, PROJECT_AGENT_DIR } from '../agents.js'
import { sameSeat } from '../flow.js'
import type { OpenedSeat } from '../host.js'
import { knownAgent } from '../installs/known-agents.js'
import { SEAT_READ_DEADLINE_MS, within } from '../seat-reads.js'
import type { HostContext, MethodsUnder } from './context.js'

/**
 * The Agent roster, read — and one Agent, seated.
 *
 * The roster reads, seating chooses this machine's seats, and four file verbs
 * create or copy a folder, move one to the Trash, or reveal its file. Editing
 * what an Agent says still belongs only to the editor plane.
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
    const machine = await ctx.seating.read()
    const unheld = unheldPolicy(ctx.state.state.preferences)
    const ids = params.ids ?? roster.map((one) => one.id)
    const weighed = ids.map((id): Weighed => {
      const entry = roster.find((one) => one.id === id)
      if (!entry) return { plan: blockedPlan(id, `No Agent called “${id}”.`) }
      if (!entry.definition || entry.digest === null) return { plan: blockedPlan(id, unusable(entry)) }
      return {
        id,
        list: candidatesFor(entry.definition, machine),
        prefer: entry.definition.prefer,
        need: { level: ceilingWithin(entry.definition.ceiling, grantOf(undefined)), unheld },
      }
    })
    // Every runtime either list names, read once: the Agent's own list is only weighed beside this Mac's.
    const desk = await readDesk(
      ctx,
      weighed.flatMap((one) => ('list' in one ? [...('seats' in one.list ? one.list.seats : []), ...one.prefer] : [])),
    )
    const words = wordsFor(ctx, desk.catalogues, desk.registryNames)
    return weighed.map((one): SeatPlan => {
      if ('plan' in one) return one.plan
      const own = () => planSeats(one.id, one.prefer, desk.offers, words, 'prefer', one.need).candidates
      if ('refused' in one.list) return { ...blockedPlan(one.id, one.list.refused, 'machine'), own: own() }
      if (one.list.from === 'machine') {
        return { ...planSeats(one.id, one.list.seats, desk.offers, words, 'machine', one.need), own: own() }
      }
      return planSeats(one.id, one.list.seats, desk.offers, words, 'prefer', one.need)
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
    const result = await seatAgent(ctx, params, { board: null, role: null })
    return result.session
  },

  'agent/seating/read': (ctx) => ctx.seating.read(),

  'agent/seating/set': async (ctx, params) => {
    const changedElsewhere =
      "This Agent's seats on this Mac changed in another window; nothing was saved. The page now shows the current seats."
    const { seating, wrote } = await ctx.seating.set(
      params.id,
      params.seats,
      params.expected === undefined
        ? {}
        : { refuseIfDifferent: { expected: params.expected, message: changedElsewhere } },
    )
    // Every plan drawn before a write is stale, in every window: each write is
    // told, once, and nothing else is — a set that changes nothing must not
    // send every window back to re-read a file that did not change. Whether it
    // wrote is `set()`'s to say, from inside the queue that orders the writes.
    // A reading taken here before queueing could not tell two sets racing
    // (codex to claude, and back) from one, and told every window only of the
    // first — a window re-reading on it stayed on claude.
    if (wrote) ctx.push({ method: 'agent/changed', params: { project: null, revision: seating.revision } })
    return seating
  },

  /**
   * *Save as an Agent*: writes a new folder and its `AGENT.md`, to this
   * machine or to a project, and answers the entry the roster now lists for
   * it.
   *
   * `seat` is the seat the conversation this is saved from is on. Saved to
   * this machine it is written as the Agent's own `prefer`. Saved to a
   * project, `prefer` names only the seat's runtime — a committed model name
   * breaks the Agent on every machine but its author's — and the exact seat
   * is kept instead in this machine's `seating.json`, which replaces
   * `prefer` here and never merges with it.
   *
   * Refuses rather than write anything broken or invisible, each check
   * before anything is written: what is written must parse back as an Agent,
   * so a name or field the parser would refuse is caught here and not only
   * once the roster is asked to find what was just written; a copy that
   * would already be shadowed the moment it lands — a project's own Agent of
   * this name, when saving to this machine — is refused in the same words
   * `agent/copy` uses for the same mistake; and when an exact seat must be
   * kept in `seating.json`, that file is read first, so a file nobody can
   * read refuses the call before the folder is even made. If keeping the
   * seat still fails after the folder was made, the folder — made
   * exclusively by this call, so it is this call's alone — is removed and
   * the failure is rethrown, rather than left behind minus the seat it
   * promised.
   */
  'agent/create': async (ctx, params) => {
    if (params.name.length > AGENT_NAME_LIMIT) {
      throw new Error(`An Agent's name may have at most ${AGENT_NAME_LIMIT} characters, not ${params.name.length}.`)
    }
    if (params.description !== undefined && params.description.length > AGENT_DESCRIPTION_LIMIT) {
      throw new Error(
        `An Agent's description may have at most ${AGENT_DESCRIPTION_LIMIT} characters, not ${params.description.length}.`,
      )
    }
    const id = agentIdOf(params.name)
    if (!id) throw new Error(`“${params.name}” leaves nothing to name a folder by — use letters or digits.`)
    if (isReservedId(id)) throw new Error(reservedIdText(id))
    const project = await projectOf(ctx, params.project)
    // Committed, a model name breaks the Agent on every other machine: the project names the runtime, this Mac keeps the seat.
    const bare: FlowSeat = { runtime: params.seat.runtime }
    const exact = exactSeat(params.seat)
    const prefer = params.to === 'project' ? [bare] : [params.seat]
    const source = agentSource({
      name: params.name,
      description: params.description ?? null,
      ceiling: params.ceiling,
      prefer,
    })
    if (Buffer.byteLength(source, 'utf8') > AGENT_FILE_LIMIT) {
      throw new Error(
        `“${params.name}” is too large to read back as saved: an Agent file may be at most ${AGENT_FILE_LIMIT / 1024} KiB.`,
      )
    }
    // What is written must read back — a refusal here, not the confusing one
    // `found()` would give once the roster is asked to find what cannot parse.
    const parsed = parseAgentDefinition(source, id)
    const unreadable = parsed.problems.find((one) => one.level === 'error')
    if (unreadable) throw new Error(`“${params.name}” cannot be saved: ${unreadable.at} — ${unreadable.text}`)
    const mismatched = parsed.agent
      ? savedFieldMismatch(parsed.agent, params.name, params.description ?? null, params.ceiling, prefer)
      : 'definition'
    if (mismatched) {
      throw new Error(`“${params.name}” cannot be saved because its ${mismatched} does not read back exactly as given.`)
    }
    // A copy that would arrive already shadowed is invisible from the moment
    // it is written. Refused here, in `agent/copy`'s own words for the same mistake.
    const shadowedBy = await ctx.agents.read(id, project)
    if (shadowedBy && RANK[shadowedBy.origin] < RANK[params.to]) {
      throw new Error(shadowedText(params.to, shadowedBy.origin, id))
    }
    const machine = await ctx.seating.read()
    const kept = machine.entries.find((one) => one.id === id)
    // `seating.json` is keyed by id alone, so a kept entry seats every Agent
    // of this id — a built-in or a user Agent of the same name, in every
    // other project, included. Writing over it here would silently retarget
    // them; leaving it in place would silently win over the `prefer` being
    // written now. The one case that is neither is a project Save whose exact
    // seat already reads as the entry kept there: `set()` below then writes
    // nothing, so nothing is retargeted and nothing is overridden.
    const onlyKeptSeat = kept?.seats.length === 1 ? kept.seats[0] : undefined
    const keptMatchesExact =
      params.to === 'project' && exact && onlyKeptSeat !== undefined && sameSeat(onlyKeptSeat, params.seat)
    // Said once, reused at the write below: a different window's set for
    // this id, landing after this read and before that write, is refused in
    // the very words this check would have refused with, had it read that
    // window's answer instead of this one.
    const alreadySeatedText = `This Mac already has seats for “${id}”, and they would win over the one you are saving. Change or clear them on its page first, or pick another name.`
    if (kept && !keptMatchesExact) {
      throw new Error(alreadySeatedText)
    }
    // This machine's seats must be readable before anything is written, when
    // an exact seat would need to be kept there.
    if (params.to === 'project' && exact) {
      const broken = machine.problems.find((one) => one.id === null)
      if (broken) {
        throw new Error(
          `This machine's seats in ${machine.path} cannot be read, so “${params.name}”’s seat could not be kept there: ${broken.text}`,
        )
      }
    }
    // Last check before the write: a refused call never makes a project's
    // `.harnessdesk/agents`, and the path walk is as fresh as it can be.
    const root = await rootOf(ctx, params.to, project)
    const created = await createAgentFolder(root, id, source)
    if (params.to === 'project' && exact) {
      try {
        // Decided again here, inside `set()`'s own write queue, against
        // whatever the file holds the instant before this write — not the
        // `machine` read all the way back at the top of this call, which
        // another window's set landing in the gap since could have made
        // stale. This call's own folder and path walk stay sound either way;
        // only its choice of seat might no longer be.
        const { seating, wrote } = await ctx.seating.set(id, [params.seat], { refuseIfDifferent: alreadySeatedText })
        if (wrote) ctx.push({ method: 'agent/changed', params: { project: null, revision: seating.revision } })
      } catch (error) {
        const left = await rollbackCreatedAgent(created, project ?? '')
        if (left) {
          throw new Error(`${messageOf(error)} The Agent folder was left in place because ${left}.`)
        }
        throw error
      }
    }
    ctx.push({ method: 'agent/changed', params: { project: params.to === 'project' ? (project ?? null) : null } })
    return found(await ctx.agents.read(id, project), { id, origin: params.to, path: created.path })
  },

  'agent/ceiling/preview': async (ctx, params) => {
    const { path, folder } = await updatable(ctx, params)
    const source = await readAgentSource(join(folder, 'AGENT.md'))
    const edit = ceilingEdit(source, params.level)
    if ('refused' in edit) throw new Error(`${path} cannot be updated: ${edit.refused}.`)
    return { path, digest: digestOf(source), line: edit.line, before: edit.before, after: edit.after, diff: edit.diff }
  },

  'agent/ceiling/write': async (ctx, params) => {
    const { path, folder, project } = await updatable(ctx, params)
    await rewriteAgentFile(folder, params.digest, (source) => {
      const edit = ceilingEdit(source, params.level)
      if ('refused' in edit) throw new Error(`${path} cannot be updated: ${edit.refused}.`)
      return edit.next
    })
    ctx.push({ method: 'agent/changed', params: { project: params.origin === 'project' ? (project ?? null) : null } })
    return found(await ctx.agents.read(params.id, project), { id: params.id, origin: params.origin, path })
  },

  /**
   * *Customize…*: copies the Agent found at `from` to this machine or to a
   * project, where the copy shadows it, and answers the copy's entry.
   * Refused where the copy would itself be shadowed by what it copies — a
   * copy is only worth making where it comes first.
   */
  'agent/copy': async (ctx, params) => {
    const project = await projectOf(ctx, params.project)
    const entry = await ctx.agents.read(params.id, project)
    if (!entry) throw new Error(`There is no ${originAgent(params.from)} Agent called “${params.id}” to copy.`)
    const looked = listedAgentPath(ctx, entry, params.from, project)
    if (looked.at === 'missing') {
      throw new Error(`There is no ${originAgent(params.from)} Agent called “${params.id}” to copy.`)
    }
    if (looked.at === 'invalid') throw new Error(`“${params.id}” is not a real Agent folder, so it cannot be copied.`)
    const source = looked.path
    if (RANK[entry.origin] < RANK[params.to]) throw new Error(shadowedText(params.to, entry.origin, params.id))
    if (RANK[params.to] >= RANK[params.from]) {
      throw new Error(
        `A copy in ${params.to === 'user' ? 'your Agents' : 'the project'} would be shadowed by ${originCopy(params.from)} — copy it somewhere that comes first.`,
      )
    }
    const sourceRead = parseAgentDefinition(await readAgentSource(source), params.id)
    const sourceProblem = sourceRead.problems.find((one) => one.level === 'error')
    if (!sourceRead.agent || sourceProblem) {
      throw new Error(
        `${source} cannot be copied as an Agent${sourceProblem ? `: ${sourceProblem.at} — ${sourceProblem.text}` : '.'}`,
      )
    }
    // Phase 10's line-preserving editor can later rewrite only `prefer`. Until
    // then, refusing is safer than committing this machine's model names.
    if (params.to === 'project' && sourceRead.agent.prefer.some(exactSeat)) {
      throw new Error(
        `“${sourceRead.agent.name}” names models in its seats. A project's Agent names runtimes only, so it works on every machine. Keep it yours, or copy it once its seats name runtimes only.`,
      )
    }
    const root = await rootOf(ctx, params.to, project)
    const destination = join(root, params.id)
    await copyAgentFolder(dirname(source), destination)
    ctx.push({ method: 'agent/changed', params: { project: params.to === 'project' ? (project ?? null) : null } })
    return found(await ctx.agents.read(params.id, project), {
      id: params.id,
      origin: params.to,
      path: join(destination, 'AGENT.md'),
    })
  },

  /** *Remove…*: moves a user or project Agent's folder to the Trash. Needs the desktop app; what ships cannot be removed. */
  'agent/remove': async (ctx, params) => {
    if (!ctx.options.trashPath) throw new Error('Moving an Agent to the Trash needs the desktop app.')
    const origin = params.origin as AgentOrigin
    if (origin === 'builtin') throw new Error('A built-in Agent cannot be removed; customize it first.')
    const project = await projectOf(ctx, params.project)
    const entry = await ctx.agents.read(params.id, project)
    if (!entry) throw new Error(`There is no ${originAgent(origin)} Agent called “${params.id}” to remove.`)
    const looked = listedAgentPath(ctx, entry, origin, project)
    if (looked.at === 'missing') throw new Error(`There is no ${originAgent(origin)} Agent called “${params.id}” to remove.`)
    if (looked.at === 'invalid') throw new Error(`“${params.id}” is not a real Agent folder, so it cannot be removed.`)
    await ctx.options.trashPath(dirname(looked.path))
    ctx.push({ method: 'agent/changed', params: { project: origin === 'project' ? (project ?? null) : null } })
    return null
  },

  /** Shows the file an Agent comes from in the OS file browser — the winner, or the copy at `origin`. Needs the desktop app. */
  'agent/reveal': async (ctx, params) => {
    if (!ctx.options.revealPath) throw new Error('Showing a file in the file browser needs the desktop app.')
    const project = await projectOf(ctx, params.project)
    const entry = await ctx.agents.read(params.id, project)
    if (!entry) throw new Error(`There is no Agent called “${params.id}” here.`)
    const looked = listedAgentPath(ctx, entry, params.origin ?? entry.origin, project)
    if (looked.at === 'missing') throw new Error(`There is no Agent called “${params.id}” here.`)
    if (looked.at === 'invalid') throw new Error(`“${params.id}” is not a real Agent folder, so it cannot be revealed.`)
    await ctx.options.revealPath(looked.path)
    return null
  },
} satisfies MethodsUnder<'agent/'>

export interface AgentSeatContext {
  board: string | null
  role: string | null
  environment?: Readonly<Record<string, string>>
  openingId?: SeatId
  grant?: SeatGrant
}

/**
 * Resolves, checks trust and ceiling, and builds the isolated input a
 * candidate's runtime session is created with — called before that session
 * exists, so `SessionOptions.attachments` can actually carry what this
 * function decides rather than describe a session already running unscoped.
 *
 * A refusal here (an unsuppressed unapproved default, most notably) is never
 * caught and retried against the next candidate: decision "refuse, never
 * substitute" means a runtime that cannot honor this Seat's declarations
 * fails the whole seating, in this candidate's own words, rather than
 * silently seating on a different runtime nobody announced.
 */
async function prepareAttachments(
  attachments: NonNullable<HostContext['attachments']>,
  subject: AttachmentSubject,
): Promise<PreparedAttachments> {
  return attachments.prepare(subject)
}

/**
 * Reads back what the runtime actually loaded and durably freezes it — or
 * writes nothing at all. An Agent with no `skills:`/`mcp:` declared resolves
 * to zero declarations, and this is never called for it: the plain path
 * stays plain, with no sidecar file and no input ever computed for it.
 *
 * The receipt comes from the runtime's own `attachmentReceipt`, read back
 * after the session exists — never assumed from what was requested. A
 * runtime with no such method, one that throws, or one that answers a key
 * that does not match what this Seat was actually prepared with, is treated
 * exactly like a runtime that loaded nothing: honest, never optimistic.
 */
async function finishAttachments(
  attachments: NonNullable<HostContext['attachments']>,
  runtime: AgentRuntime | undefined,
  sessionId: string,
  prepared: PreparedAttachments,
  record: SeatRecord,
): Promise<void> {
  if (prepared.declarations.length === 0) return
  let receipt: SessionAttachmentReceipt = { key: prepared.input.key, loaded: [], refused: [] }
  if (runtime?.attachmentReceipt) {
    try {
      const observed = await runtime.attachmentReceipt(makeSessionId(sessionId))
      if (observed.key === prepared.input.key) receipt = observed
    } catch {
      // Left as the empty receipt above: a readback that failed is "not loaded", never "loaded".
    }
  }
  await attachments.record(record, prepared, receipt)
}

/**
 * The runtime `seatAgent` would seat this Agent on by default — the same
 * candidate list, the same desk read and the same `chooseSeat` at the same
 * default ceiling — without opening anything. `attachment/review` asks this
 * so a person approves loading for the runtime (and build) the Seat will
 * actually check the approval against, never merely the first runtime that
 * happens to support attachments at all. `null` when no candidate would seat.
 */
export async function defaultSeatRuntime(ctx: HostContext, definition: AgentDefinition): Promise<string | null> {
  const list = candidatesFor(definition, await ctx.seating.read())
  if ('refused' in list) return null
  const desk = await readDesk(ctx, list.seats)
  const need: CeilingNeed = { level: ceilingWithin(definition.ceiling, grantOf(undefined)), unheld: unheldPolicy(ctx.state.state.preferences) }
  return chooseSeat(list.seats, desk.offers, need).seat?.runtime ?? null
}

/** The one seating operation used by a plain Agent and by Goal staffing. */
export async function seatAgent(
  ctx: HostContext,
  params: HostMethods['agent/seat']['params'],
  context: AgentSeatContext,
): Promise<{ session: HostMethods['agent/seat']['result']; record: SeatRecord }> {
  if (!isAbsolute(params.cwd)) throw new Error(`${params.cwd} is not an absolute path.`)
  const project = await projectOf(ctx, params.project)
  const entry = await ctx.agents.read(params.id, project)
  if (!entry) throw new Error(`No Agent called “${params.id}”.`)
  const { definition, digest } = entry
  if (!definition || digest === null) throw new Error(unusable(entry))

  const requested = context.grant?.kind === 'permission' ? context.grant.permission : params.permission
  const level = ceilingWithin(
    definition.ceiling,
    context.grant?.kind === 'ceiling' ? context.grant.level : grantOf(requested),
  )
  const need: CeilingNeed = { level, unheld: unheldPolicy(ctx.state.state.preferences) }
  // Its repository's identity on disk, not its path: computed once, the same
  // way `evidence/seen.ts` binds a command approval, so a repository deleted
  // and cloned again at the same path is a new incarnation and inherits
  // nothing. Only when this build is wired for attachments at all — an
  // unwired host has no trust store for the identity to matter to.
  const incarnation = ctx.attachments ? await incarnationOf(project ?? params.cwd) : ''
  const list = candidatesFor(definition, await ctx.seating.read(), params.seats)
  if ('refused' in list) throw new Error(`${definition.name} cannot be seated: ${list.refused}`)
  const candidates = list.seats
  const desk = await readDesk(ctx, candidates)
  const offers = desk.offers
  const words = wordsFor(ctx, desk.catalogues, desk.registryNames)
  const said = (values: readonly PassedOver[]) => values.map((one) => candidateOf(one, words))
  const passed: PassedOver[] = []
  for (let rest = candidates; ; ) {
    const chosen = chooseSeat(rest, offers, need)
    passed.push(...chosen.passed)
    if (!chosen.seat) throw new SeatRefusedError(explainRefusal(passed), { candidates: said(passed) })
    const selected = chosen.seat
    rest = rest.slice(chosen.passed.length + 1)
    // Prepared before this candidate's session exists — never after — so a
    // capable runtime is actually handed the isolated filter at
    // `createSession`, instead of a native, unscoped session being asked
    // after the fact to account for attachments it was never given. A thrown
    // refusal here (an unsuppressed unapproved default) is deliberately not
    // caught: it fails the whole seating on this candidate's own runtime,
    // never falling through to try another one it never announced.
    const prepared: PreparedAttachments | undefined = ctx.attachments
      ? await prepareAttachments(ctx.attachments, {
          project: project ?? params.cwd,
          incarnation,
          agent: definition.id,
          origin: entry.origin,
          agentDigest: digest,
          runtime: selected.runtime,
          build: ctx.runtimes.get(selected.runtime)?.info.version ?? '',
          ceiling: level,
        })
      : undefined
    const attachmentsInput: SessionAttachments | undefined =
      prepared && prepared.declarations.length > 0 ? prepared.input : undefined
    const opened = await openAsAsked(ctx, selected, {
      cwd: params.cwd, title: definition.name,
      ...(context.environment ? { environment: context.environment } : {}),
      ...(attachmentsInput ? { attachments: attachmentsInput } : {}),
    })
    if ('reason' in opened) {
      passed.push(opened)
      continue
    }

    const held = await ctx.seats.hold(opened.runtime, opened.sessionId, level)
    if (held.ceiling.hold !== 'held' && need.unheld === 'refuse') {
      const left = await ctx.seats.discard(opened.runtime, opened.sessionId)
      passed.push({ ...passedFor(selected, { kind: 'unheld', level, detail: held.why }), left })
      continue
    }
    const seated: SeatedAs = {
      agent: definition.id,
      name: definition.name,
      briefDigest: digest,
      standing: standingOf(definition.ceilingFrom, level),
      seatLabel: opened.label,
      passedOver: said(passed),
      ceiling: held.ceiling,
      ceilingNote: held.how ?? held.why,
    }
    let record: SeatRecord
    try {
      if (context.openingId !== undefined) {
        throw new Error('A fixed Goal opening must be staged by the Goal assignment journal.')
      }
      record = await ctx.evidence.seats.opened({
        agent: { id: definition.id, name: definition.name, origin: entry.origin },
        briefDigest: digest,
        seat: selected,
        seatLabel: seated.seatLabel,
        passedOver: seated.passedOver,
        standing: seated.standing,
        ceiling: seated.ceiling,
        cwd: params.cwd,
        session: { runtime: opened.runtime, sessionId: opened.sessionId },
        board: context.board,
        role: context.role,
      })
    } catch (error) {
      await ctx.seats.retire(opened.runtime, opened.sessionId)
      throw new Error(
        `${definition.name} was seated on ${describeSeat(selected, words)}, and its Seat record could not be written, so the conversation was closed: ${messageOf(error)}`,
      )
    }
    if (ctx.attachments && prepared) {
      try {
        await finishAttachments(ctx.attachments, ctx.runtimes.get(opened.runtime), opened.sessionId, prepared, record)
        // Beside the session, the same way `seatedAs` is: the tool gateway
        // resolves a live caller token to this Seat through the registry,
        // never by re-deriving it, so a re-announced session cannot forget it.
        ctx.registry.recordAttachmentSeat(runtimeId(opened.runtime), makeSessionId(opened.sessionId), record.id)
      } catch (error) {
        await ctx.evidence.seats.closeId?.(record.id, 'deleted').catch(() => {})
        await ctx.seats.retire(opened.runtime, opened.sessionId)
        throw new Error(
          `${definition.name} was seated on ${describeSeat(selected, words)}, and its attachment record could not be written, so the conversation was closed: ${messageOf(error)}`,
        )
      }
    }
    try {
      await ctx.seats.order(opened.runtime, opened.sessionId, agentOrder(definition.brief, level, params.cwd))
    } catch (error) {
      await ctx.evidence.seats.closeId?.(record.id, 'deleted').catch(() => {})
      await ctx.seats.retire(opened.runtime, opened.sessionId)
      throw new BriefNotHandedOverError(
        `${definition.name} was seated on ${describeSeat(selected, words)}, and its brief could not be handed over, so the conversation was closed: ${messageOf(error)}`,
      )
    }
    return { session: ctx.seats.recordAgent(opened.runtime, opened.sessionId, seated), record }
  }
}

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
 * File verbs match `id` against the roster and then `listedAgentPath` checks
 * that the matched entry is one folder name at the exact tier path before any
 * path is acted on. The unread-project placeholder is deliberately not one.
 *
 * A folder inside a checkout is read as that checkout's top (`topLevel`),
 * because that is where a project keeps its Agents.
 */
export const projectOf = async (ctx: HostContext, project: string | undefined): Promise<string | undefined> => {
  if (project === undefined) return undefined
  if (!isAbsolute(project)) throw new Error(`${project} is not an absolute path.`)
  const confined = await ctx.workspaces.confineGitRoot(project)
  /* A project keeps its Agents at the top of its checkout, and a person often
     opens a folder inside it — so a folder is read as the checkout it is in: a
     subfolder as its repository's top, a linked worktree as its own. The top
     is held to the same rule the folder was, so this never reaches a
     repository nobody opened part of. */
  const top = await ctx.workspaces.topLevel(confined)
  return top === null || top === confined ? confined : ctx.workspaces.confineGitRoot(top)
}

/** Why an entry cannot be seated: its first error, where it is, in the file's own terms. */
export const unusable = (entry: AgentEntry): string => {
  const problem = entry.problems.find((one) => one.level === 'error')
  return `${entry.path} cannot be used: ${problem ? `${problem.at} — ${problem.text}` : 'it could not be read'}`
}

/** A list of seats to try, and where it came from — `candidatesFor`'s answer when it has one. */
interface CandidateList {
  readonly from: 'seats' | 'machine' | 'prefer'
  readonly seats: readonly FlowSeat[]
}

/**
 * The seats one Agent tries here, highest precedence first: a seating's own
 * `seats`, then this machine's entry for it, then its `prefer` — each replacing
 * the next, never merged with it.
 *
 * An entry this machine has for it that cannot be read is a refusal, never a
 * fall back to `prefer`: the person replaced that list here, and seating on it
 * anyway is the quiet kind of substitution. So is a file that cannot be read
 * at all, because nobody can say whether it held an entry for this Agent —
 * which is also why that whole-file refusal never claims to be "for it": the
 * file may never have named this Agent at all. And it calls the file unusable
 * rather than unreadable: a whole-file problem already says in a sentence what
 * went wrong ("it could not be read: …", "it is not JSON: …"), and "cannot be
 * read: it could not be read" would say it twice.
 */
const candidatesFor = (
  definition: AgentDefinition,
  machine: MachineSeating,
  seats?: readonly FlowSeat[],
): CandidateList | { readonly refused: string } => {
  if (seats?.length) return { from: 'seats', seats }
  const broken = machine.problems.find((one) => one.id === definition.id || one.id === null)
  if (broken) {
    const where =
      broken.id === null
        ? `this machine's seats in ${machine.path} cannot be used`
        : `this machine's seats for it in ${machine.path} cannot be read${broken.at ? ` at ${broken.at}` : ''}`
    return { refused: `${where}: ${broken.text} — edit this machine's seats to fix it.` }
  }
  const entry = machine.entries.find((one) => one.id === definition.id)
  return entry ? { from: 'machine', seats: entry.seats } : { from: 'prefer', seats: definition.prefer }
}

/** Which tier outranks which: a copy is only worth making where it comes first. */
const RANK: Readonly<Record<AgentOrigin, number>> = { project: 0, user: 1, builtin: 2 }

const exactSeat = (seat: FlowSeat): boolean => Boolean(seat.model || seat.effort || seat.thinking)

export const originAgent = (origin: AgentOrigin): string =>
  origin === 'builtin' ? 'built-in' : origin === 'user' ? 'personal' : 'project'

const originCopy = (origin: AgentOrigin): string =>
  origin === 'builtin' ? 'the built-in copy' : origin === 'user' ? 'your copy' : "the project's copy"

const shadowedText = (to: 'user' | 'project', winner: AgentOrigin, id: string): string => {
  const by = winner === 'project' ? `the project “${id}”` : winner === 'user' ? `your “${id}”` : `the built-in “${id}”`
  return `A copy in ${to === 'user' ? 'your Agents' : 'the project'} would be shadowed by ${by} already there — remove or rename it first.`
}

/** The file of the copy of an Agent found at one tier — the winner, or one it shadows — or null. */
const copyAt = (entry: AgentEntry, origin: AgentOrigin): string | null =>
  entry.origin === origin ? entry.path : (entry.shadows.find((one) => one.origin === origin)?.path ?? null)

export type ListedAgentPath =
  | { readonly at: 'found'; readonly path: string }
  | { readonly at: 'missing' }
  | { readonly at: 'invalid' }

/**
 * The one path a file verb may act on. A roster error placeholder has a slash
 * in its id and names the directory itself; a malformed entry may name any
 * other path. Neither becomes a copy, Trash target or reveal merely because it
 * appeared in the roster.
 */
export const listedAgentPath = (
  ctx: HostContext,
  entry: AgentEntry,
  origin: AgentOrigin,
  project: string | undefined,
): ListedAgentPath => {
  const path = copyAt(entry, origin)
  if (!path) return { at: 'missing' }
  if (!entry.id || entry.id === '.' || entry.id === '..' || basename(entry.id) !== entry.id) return { at: 'invalid' }
  const root =
    origin === 'user'
      ? ctx.agents.roots.user
      : origin === 'builtin'
        ? ctx.agents.roots.builtin
        : project
          ? join(project, PROJECT_AGENT_DIR)
          : null
  if (!root || path !== join(root, entry.id, 'AGENT.md')) return { at: 'invalid' }
  return { at: 'found', path }
}

export const updatable = async (
  ctx: HostContext,
  params: { readonly id: string; readonly origin: 'user' | 'project'; readonly project?: string },
): Promise<{ readonly path: string; readonly folder: string; readonly project: string | undefined }> => {
  const project = await projectOf(ctx, params.project)
  const entry = await ctx.agents.read(params.id, project)
  const looked = entry ? listedAgentPath(ctx, entry, params.origin, project) : ({ at: 'missing' } as const)
  if (looked.at === 'missing') throw new Error(`There is no ${originAgent(params.origin)} Agent called “${params.id}” to update.`)
  if (looked.at === 'invalid') throw new Error(`“${params.id}” is not a real Agent folder, so it cannot be updated.`)
  const folder =
    params.origin === 'project'
      ? await projectAgentFolder(project ?? '', params.id)
      : await userAgentFolder(ctx.agents.roots.user, params.id)
  return { path: looked.path, folder, project }
}

/** Where a new or copied Agent goes: this machine's roster, or the project's own, made inside it. */
const rootOf = async (ctx: HostContext, to: 'user' | 'project', project: string | undefined): Promise<string> => {
  if (to === 'user') return ctx.agents.roots.user
  if (!project) throw new Error('Name the project to write the Agent into.')
  return projectAgentDir(project)
}

/** The exact entry just written, which the roster must now list and parse. */
export const found = (
  entry: AgentEntry | null,
  expected: { readonly id: string; readonly origin: AgentOrigin; readonly path: string },
): AgentEntry => {
  if (!entry || !entry.definition || entry.origin !== expected.origin || entry.path !== expected.path) {
    throw new Error(
      `“${expected.id}” was written and did not read back as the ${originAgent(expected.origin)} Agent at ${expected.path}.`,
    )
  }
  return entry
}

/** Which field Save owns did not survive its own writer and parser byte for meaning. */
const savedFieldMismatch = (
  definition: AgentDefinition,
  name: string,
  description: string | null,
  ceiling: AgentDefinition['ceiling'],
  prefer: readonly FlowSeat[],
): 'name' | 'description' | 'ceiling' | 'preferred seats' | null => {
  if (definition.name !== name) return 'name'
  if ((definition.description ?? null) !== description) return 'description'
  if (definition.ceiling !== ceiling) return 'ceiling'
  if (definition.prefer.length !== prefer.length) return 'preferred seats'
  if (!definition.prefer.every((seat, index) => sameSeat(seat, prefer[index]!))) return 'preferred seats'
  return null
}

/**
 * One Agent, weighed for `agent/seat/dry`: already blocked, or a candidate
 * list still waiting on the desk's own reads, with its own `prefer` beside it
 * — read once here, whether or not it ends up weighed as `own`. Given its own
 * name rather than inferred, so the union stays the one written here —
 * combining these two shapes through plain, unannotated return statements
 * pads each with the other's keys as optional `undefined`, which defeats the
 * `'plan' in one` / `'list' in one` checks below that tell them apart.
 */
type Weighed =
  | { readonly plan: SeatPlan }
  | {
      readonly id: AgentId
      readonly list: CandidateList | { readonly refused: string }
      readonly prefer: readonly FlowSeat[]
      readonly need: CeilingNeed
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
  where: {
    readonly cwd: string
    readonly title: string
    readonly environment?: Readonly<Record<string, string>>
    readonly attachments?: SessionAttachments
  },
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
      spentModels: report ? spentScopesOf(report) : [],
      holds: Object.keys(ctx.runtimes.infoOf(runtime).ceilings ?? {}).filter(isCeilingLevel),
    },
    catalogue,
  }
}

/**
 * The scopes of the report's own spent lanes, for the chooser to match against
 * a candidate's model. With no account-wide lane a spent scope no longer
 * spends the runtime (`bindingLane`), so a candidate asking for the very model
 * that is out has to be told here. Only the agent's own lanes: another
 * sign-in's figures (`unverified`) never decide a seat.
 */
const spentScopesOf = (report: UsageReport): readonly string[] =>
  report.lanes.flatMap((lane) => {
    if (!lane.scope || lane.placeholder === true) return []
    const left = remainingOf(lane)
    return left !== null && left <= 0 ? [lane.scope] : []
  })

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

/**
 * One Agent's seat plan, for a flow's dry run: the same reads and the same
 * chooser `agent/seat/dry` uses for the whole roster, narrowed to one Agent
 * and the exact seats and grant a flow role names — a role's own `seats:`
 * when it lists any, its machine entry or `prefer` otherwise, held to the
 * narrower of the Agent's ceiling and the role's `grant:`.
 *
 * A new phase-6 extraction: `agent/seat/dry`'s own batched loop is
 * unchanged, kept for the many-Agents-at-once read it was built for; this is
 * the same primitives (`candidatesFor`, `planSeats`, `readDesk`, `wordsFor`)
 * called once per role, which is what a dry run's own bounded roster costs.
 */
export const previewAgent = async (
  ctx: HostContext,
  root: string,
  agent: string,
  seats: readonly FlowSeat[],
  grant: CeilingLevel,
): Promise<SeatPlan> => {
  const project = await projectOf(ctx, root)
  const entry = await ctx.agents.read(agent, project)
  if (!entry) return blockedPlan(agent, `No Agent called “${agent}”.`)
  if (!entry.definition || entry.digest === null) return blockedPlan(agent, unusable(entry))
  const machine = await ctx.seating.read()
  const unheld = unheldPolicy(ctx.state.state.preferences)
  const list = candidatesFor(entry.definition, machine, seats.length ? seats : undefined)
  const need: CeilingNeed = { level: ceilingWithin(entry.definition.ceiling, grant), unheld }
  if ('refused' in list) return blockedPlan(agent, list.refused, 'machine')
  const desk = await readDesk(ctx, [...list.seats, ...entry.definition.prefer])
  const words = wordsFor(ctx, desk.catalogues, desk.registryNames)
  // A role's own explicit `seats:` reads like `prefer` here: `SeatPlan.from` tells
  // a person "the machine" or "the Agent" chose this list, and a role's own list is
  // the flow author's choice, presented the way an Agent's own `prefer` is.
  return planSeats(agent, list.seats, desk.offers, words, list.from === 'seats' ? 'prefer' : list.from, need)
}
