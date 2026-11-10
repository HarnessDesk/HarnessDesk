import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  TRIGGER_DECISIONS_KEPT, TRIGGER_THREADS_KEPT,
  type PhoneTriageRow, type TriggerDecision, type TriggerDecisionsPage, type TriggerDefinition, type TriggerFact, type TriggerMode,
  type TriggerRuleCheck, type TriggerTriage, type TriggerWorkThread,
} from '@harnessdesk/protocol'

import { Serial } from '../goals/assignments.js'
import { atomicJson } from '../goals/store.js'
import { leadContainsSecret } from '../lead/secrets.js'
import type { OfferAnswer } from './admission.js'
import type { ArmedTrigger } from './consent.js'
import type { MentionThread } from './forge.js'

/**
 * Mentions: a comment on the forge that addresses the desk by its handle asks
 * it for work.
 *
 * What it reads is untrusted all the way through. A comment is matched on
 * `@handle` in its own words only — never inside code, a quote, or another
 * word. Deterministic rules decide first, in order — addressed, allowed,
 * project, label, handled, stop — and the first that fails ignores it with
 * its own sentence, before anything is sent anywhere. Only then is one
 * assessment asked, and all it can answer is a decision and a sentence:
 * what accepting opens, its budget and its round are the trigger's, fixed
 * when it was armed, and the comment never reaches them. An assessment that
 * cannot be made is a question for the person, never a guess.
 *
 * A trigger observes until a person switches it to act on this machine: an
 * accepted request is recorded as "would have accepted" and nothing else
 * happens. Arming it again — a changed declaration — puts it back to observe.
 *
 * An accepted request that acted is one thread of work: the issue or pull
 * request it started on, every Goal it opened, and every pull request that
 * work opened. A later comment on any of them from someone allowed joins it
 * without a new triage; anyone else's is counted as an observation and acted
 * on never. It closes when every linked pull request merged or closed, or
 * when someone allowed asks it to stop.
 */

const FILE = 'triggers-mentions.json'
/** How many comment ids a thread remembers having taken, so a comment offered twice joins once. */
const THREAD_SEEN = 200
const EXCERPT = 280
const REASON = 300
/** At most this many assessments a day on one desk; past it, a request waits for the person. */
export const ASSESSMENTS_PER_DAY = 200

export const ASSESS_UNAVAILABLE = 'The assessment could not be made, so this waits for you.'
export const ASSESS_SECRET = 'This comment looks like it holds a credential, so it was not sent for assessment; it waits for you.'
export const ASSESS_CAPPED = `More than ${ASSESSMENTS_PER_DAY} requests were assessed today, so this one waits for you.`
const STOPPED = 'Stopped from the forge: someone allowed asked the work on this thread to stop.'

// ----------------------------------------------------------------- reading

const FENCE = /(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*\2[^\n]*|$)/g
const INLINE = /`[^`\n]*`/g
const QUOTE = /^[ \t]*>.*$/gm
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A comment's own words: fenced code, inline code and quoted lines taken out. */
const ownWords = (body: string): string => body.replace(FENCE, '\n').replace(INLINE, ' ').replace(QUOTE, '')

/** Whether a comment addresses `@handle` in its own words: not in code, not in a quote, not as part of another word or address. */
export const addressesHandle = (body: string, handle: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_.@/+-])@${escape(handle)}(?![A-Za-z0-9_-])`, 'i').test(ownWords(body))

/** Whether it asks `@handle` to stop or cancel, as the words right after the handle. */
export const asksToStop = (body: string, handle: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_.@/+-])@${escape(handle)}[\\s,:]+(?:stop|cancel)\\b`, 'i').test(ownWords(body))

const TRIAGES: ReadonlySet<string> = new Set(['accept', 'ignore', 'stop', 'ask'])

export interface MentionAssessment {
  readonly decision: TriggerTriage
  readonly reason: string
}

/**
 * An assessment's answer: one decision and one short sentence, from the
 * first JSON object in the text. Every other field is dropped; anything
 * that is not exactly that is no answer.
 */
export const parseAssessment = (text: string): MentionAssessment | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { decision, reason } = value as Record<string, unknown>
  if (typeof decision !== 'string' || !TRIAGES.has(decision)) return null
  if (typeof reason !== 'string') return null
  const clean = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (!clean) return null
  return { decision: decision as TriggerTriage, reason: clean.length > REASON ? `${clean.slice(0, REASON - 1)}…` : clean }
}

/** What one assessment is shown: the comment as data, and what accepting would open, told rather than asked. */
export interface MentionAssessInput {
  readonly trigger: { readonly id: string; readonly handle: string; readonly opens: string }
  readonly repository: string
  readonly thread: { readonly kind: 'issue' | 'pull-request'; readonly number: number; readonly title: string }
  readonly comment: { readonly author: string | null; readonly body: string }
}

/** The observer model, behind one call. Null, or a throw, is "could not be made". */
export type MentionAssessor = (input: MentionAssessInput, signal: AbortSignal) => Promise<MentionAssessment | null>

/**
 * Where an accepted thread of work is attached to the desk's work ledger.
 * The ledger is another part of the desk; until it is wired here, this is a
 * no-op and the thread's own record is the only linkage.
 */
export interface WorkItemsPort {
  attach(origin: { readonly kind: 'mention'; readonly trigger: string; readonly repository: string; readonly thread: TriggerWorkThread['origin'] }, links: TriggerWorkThread['links']): Promise<void>
}

export const NO_WORK_ITEMS: WorkItemsPort = { attach: async () => {} }

const opensWords = (definition: TriggerDefinition): string =>
  'flow' in definition.opens ? `the flow ${definition.opens.flow}` : 'agent' in definition.opens ? `the Agent ${definition.opens.agent}` : 'the Lead'

const threadWords = (kind: 'issue' | 'pull-request', number: number): string =>
  `${kind === 'pull-request' ? 'Pull request' : 'Issue'} #${number}`

const listWords = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`

const allowedWords = (definition: TriggerDefinition): string => listWords([
  definition.from === 'collaborators' ? 'the arming account and people who can write to the repository' : 'the arming account',
  ...(definition.people ?? []),
  ...(definition.bots ?? []).map((bot) => `the bot ${bot}`),
])

const commentId = (url: string): string => /#issuecomment-([1-9][0-9]{0,18})$/.exec(url)?.[1] ?? ''

const excerptOf = (body: string): string => {
  const flat = body.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat
}

const digest = (parts: readonly string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20)

// ------------------------------------------------------------------ ledger

interface StoredThread extends TriggerWorkThread {
  /** Admission keys of every firing it took: what the Lead's own pull request is found by. */
  readonly firings: readonly string[]
  /** Comment ids it already took or counted. */
  readonly seen: readonly string[]
}

interface LedgerFile {
  readonly version: 1
  readonly decisions: readonly TriggerDecision[]
  readonly threads: readonly StoredThread[]
  readonly modes: Readonly<Record<string, { readonly mode: TriggerMode; readonly armedAt: number }>>
  readonly assessed: { readonly day: string; readonly count: number }
}

const EMPTY: LedgerFile = { version: 1, decisions: [], threads: [], modes: {}, assessed: { day: '', count: 0 } }

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The file as the host wrote it, or null: what is not exactly that is never trusted, and never overwritten. */
const ledgerOf = (value: unknown): LedgerFile | null => {
  if (!isMap(value) || value['version'] !== 1 || !Array.isArray(value['decisions']) || !Array.isArray(value['threads']) || !isMap(value['modes']) || !isMap(value['assessed'])) return null
  const decisions = value['decisions'].filter((one): one is TriggerDecision =>
    isMap(one) && typeof one['id'] === 'string' && typeof one['trigger'] === 'string' && typeof one['project'] === 'string' && TRIAGES.has(String(one['decision'])) &&
    isMap(one['comment']) && isMap(one['thread']) && Array.isArray(one['rules']))
  const threads = value['threads'].filter((one): one is StoredThread =>
    isMap(one) && typeof one['id'] === 'string' && isMap(one['links']) && Array.isArray(one['firings']) && Array.isArray(one['seen']) && isMap(one['origin']))
  const modes: Record<string, { mode: TriggerMode; armedAt: number }> = {}
  for (const [key, entry] of Object.entries(value['modes'])) {
    if (isMap(entry) && (entry['mode'] === 'act' || entry['mode'] === 'observe') && Number.isSafeInteger(entry['armedAt'])) modes[key] = { mode: entry['mode'], armedAt: entry['armedAt'] as number }
  }
  const assessed = value['assessed']
  return {
    version: 1, decisions, threads, modes,
    assessed: typeof assessed['day'] === 'string' && Number.isSafeInteger(assessed['count']) ? { day: assessed['day'], count: assessed['count'] as number } : EMPTY.assessed,
  }
}

const modeKey = (project: string, trigger: string): string => `${project}\u0000${trigger}`

// -------------------------------------------------------------------- port

export interface MentionPort {
  /** The desk's state folder. */
  readonly home: string
  readonly forge: {
    isAccount(project: string, login: string, bot: boolean, author: string, signal: AbortSignal): Promise<boolean>
    writes(project: string, repository: string, login: string, author: string, signal: AbortSignal): Promise<boolean>
    thread(project: string, repository: string, number: number, signal: AbortSignal): Promise<MentionThread>
    pullState(project: string, repository: string, number: number, signal: AbortSignal): Promise<'open' | 'merged' | 'closed'>
    comment(project: string, repository: string, id: number, signal: AbortSignal): Promise<TriggerFact>
  }
  /** The observer model; null when none can be asked on this desk. */
  readonly assess: MentionAssessor | null
  /** The handle a trigger without one answers to: the desk's Lead name. */
  leadName(): string
  /** Stops the work on these Goals, with the reason. */
  stop(goals: readonly string[], why: string): Promise<void>
  /** The pull requests the work on these Goals and firings opened, by number. */
  pullRequests(repository: string, goals: readonly string[], firings: readonly string[]): Promise<readonly number[]>
  readonly workItems: WorkItemsPort
  /** A decision that waits for the person: said once, by its own key. */
  ask(arm: ArmedTrigger, decision: TriggerDecision): Promise<void>
  /** Something a surface shows of this project's triggers changed. */
  changed(project: string): void
  readonly signal: AbortSignal
  now(): number
  log(message: string, details?: Readonly<Record<string, unknown>>): void
}

type Admit = (arm: ArmedTrigger, fact: TriggerFact) => Promise<OfferAnswer>

interface Verdict {
  readonly decision: TriggerTriage
  readonly reason: string
  readonly by: TriggerDecision['by']
  readonly rules: readonly TriggerRuleCheck[]
}

// ------------------------------------------------------------------ triage

export class MentionTriage {
  readonly #port: MentionPort
  readonly #file: string
  readonly #serial = new Serial()
  #ledger: LedgerFile | null = null
  #problem: string | null = null

  constructor(port: MentionPort) {
    this.#port = port
    this.#file = join(port.home, FILE)
  }

  /** Why mentions are judged nowhere on this desk now — a decisions file that is not the desk's own — or null. */
  get problem(): string | null { return this.#problem }

  async #read(): Promise<LedgerFile> {
    if (this.#ledger) return this.#ledger
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.#ledger = EMPTY)
      throw error
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch { /* below */ }
    const ledger = ledgerOf(parsed)
    if (!ledger) {
      this.#problem = 'The mention decisions on this desk could not be read, so mentions wait until a person looks at it.'
      throw new Error(this.#problem)
    }
    return (this.#ledger = ledger)
  }

  async #write(next: LedgerFile): Promise<void> {
    const trimmed: LedgerFile = {
      ...next,
      decisions: next.decisions.slice(-TRIGGER_DECISIONS_KEPT),
      threads: next.threads.length > TRIGGER_THREADS_KEPT
        // Closed ones go first, then the oldest open.
        ? [...next.threads.filter((one) => one.state === 'closed'), ...next.threads.filter((one) => one.state === 'open')].slice(-TRIGGER_THREADS_KEPT)
        : next.threads,
    }
    await atomicJson(this.#file, trimmed)
    this.#ledger = trimmed
  }

  // ---------------------------------------------------------------- mode

  #modeOf(ledger: LedgerFile, arm: ArmedTrigger): TriggerMode {
    const stored = ledger.modes[modeKey(arm.project, arm.id)]
    return stored && stored.armedAt === arm.armedAt ? stored.mode : 'observe'
  }

  /** A trigger's mode on this machine; observe unless a person switched this arm to act. */
  async mode(arm: ArmedTrigger): Promise<TriggerMode> {
    return this.#modeOf(await this.#read(), arm)
  }

  /** An arm made or taken away: the trigger observes again until a person switches it, whatever it did before. */
  reset(project: string, trigger: string): Promise<void> {
    return this.#serial.run(async () => {
      const ledger = await this.#read()
      const key = modeKey(project, trigger)
      if (!(key in ledger.modes)) return
      const { [key]: _gone, ...modes } = ledger.modes
      await this.#write({ ...ledger, modes })
    })
  }

  setMode(arm: ArmedTrigger, mode: TriggerMode): Promise<void> {
    return this.#serial.run(async () => {
      const ledger = await this.#read()
      await this.#write({ ...ledger, modes: { ...ledger.modes, [modeKey(arm.project, arm.id)]: { mode, armedAt: arm.armedAt } } })
      this.#port.changed(arm.project)
    })
  }

  // --------------------------------------------------------------- reads

  /** One trigger's decisions, newest first, its mode for this arm (observe when disarmed), and its threads. */
  async page(project: string, trigger: string, arm: ArmedTrigger | null): Promise<TriggerDecisionsPage> {
    const ledger = await this.#read()
    return {
      mode: arm ? this.#modeOf(ledger, arm) : 'observe',
      decisions: ledger.decisions.filter((one) => one.project === project && one.trigger === trigger).reverse(),
      threads: ledger.threads.filter((one) => one.project === project && one.trigger === trigger).reverse().map(publicThread),
    }
  }

  /** Every decision on this desk, newest first, as the phone shows it: a project by its folder name, never a path. */
  async phone(limit: number): Promise<readonly PhoneTriageRow[]> {
    const ledger = await this.#read()
    return [...ledger.decisions].sort((a, b) => b.decidedAt - a.decidedAt).slice(0, limit).map((one) => ({
      id: one.id, trigger: one.trigger, project: basename(one.project), repository: one.repository, thread: one.thread,
      author: one.comment.author, excerpt: one.comment.excerpt, decision: one.decision, reason: one.reason, by: one.by,
      mode: one.mode, acted: one.acted, decidedAt: one.decidedAt, url: one.comment.url,
    }))
  }

  /** The thread kind a Goal's work started on, for its label; null when no thread linked it. */
  originOf(goal: string): TriggerWorkThread['origin'] | null {
    return this.#ledger?.threads.find((one) => one.links.goals.includes(goal))?.origin ?? null
  }

  // --------------------------------------------------------------- judge

  /**
   * One comment, offered to one mention arm. Resolves once it is decided
   * and recorded, joined, counted, or found to be nothing for this trigger;
   * throws — so the source keeps it and offers it again — when anything it
   * needs could not be read or admitted now.
   */
  judge(arm: ArmedTrigger, fact: TriggerFact, admit: Admit): Promise<void> {
    return this.#serial.run(async () => {
      if (fact.desk === true || fact.source !== 'mention' || fact.project !== arm.project) return
      const id = commentId(fact.url ?? '')
      if (!id) return
      let ledger = await this.#read()
      if (ledger.decisions.some((one) => one.project === arm.project && one.trigger === arm.id && one.comment.id === id)) return
      const handle = this.#handle(arm.definition)
      const number = Number(fact.subject)
      const mode = this.#modeOf(ledger, arm)
      const addressed = addressesHandle(fact.body ?? '', handle)

      const linked = ledger.threads.find((one) => one.project === arm.project && one.trigger === arm.id && one.state === 'open' &&
        (one.links.issues.includes(number) || one.links.pulls.includes(number)))
      if (linked) {
        if (linked.seen.includes(id)) return
        const allowed = await this.#allowed(arm, fact)
        if (!allowed.passed) {
          await this.#thread(linked.id, (one) => ({ ...one, observations: one.observations + 1, seen: remember(one.seen, id) }))
          return
        }
        if (addressed && asksToStop(fact.body ?? '', handle)) {
          const verdict: Verdict = {
            decision: 'stop', by: 'rules', reason: `Asked by ${fact.login ?? 'someone allowed'} to stop the work on ${threadWords(linked.origin.kind, linked.origin.number)}.`,
            rules: [{ id: 'addressed', passed: true, detail: `Addresses @${handle}.` }, allowed, { id: 'stop-word', passed: true, detail: 'Asks the work on this thread to stop.' }],
          }
          if (mode === 'act') await this.#port.stop(linked.links.goals, STOPPED)
          await this.#thread(linked.id, (one) => mode === 'act'
            ? { ...one, state: 'closed', closed: { reason: 'stopped', at: this.#port.now() }, seen: remember(one.seen, id) }
            : { ...one, seen: remember(one.seen, id) })
          await this.#record(arm, fact, verdict, mode, mode === 'act', mode === 'act' ? linked.id : null)
          return
        }
        if (mode !== 'act') return
        const answer = await admit(arm, { ...fact, subject: String(linked.origin.number), thread: linked.origin.kind })
        await this.#thread(linked.id, (one) => ({
          ...one, resumes: one.resumes + 1, seen: remember(one.seen, id),
          firings: one.firings.includes(answer.firing) ? one.firings : [...one.firings, answer.firing],
          links: {
            ...one.links,
            goals: answer.goal && !one.links.goals.includes(answer.goal) ? [...one.links.goals, answer.goal] : one.links.goals,
          },
        }))
        this.#port.changed(arm.project)
        return
      }

      // Ordinary discussion on a thread no work follows: not a request, so no decision.
      if (!addressed) return
      const verdict = await this.#gate(arm, fact, handle)
      ledger = await this.#read()
      let acted = false
      let work: string | null = null
      let reason = verdict.reason
      if (verdict.decision === 'accept' && mode === 'act') {
        const answer = await admit(arm, fact)
        if (answer.outcome === 'skipped') reason = `${reason} It did not start: ${answer.reason ?? 'the trigger skipped it.'}`
        else {
          acted = true
          work = await this.#open(arm, fact, answer, id)
        }
      }
      const decision = await this.#record(arm, fact, { ...verdict, reason }, mode, acted, work)
      if (decision.decision === 'ask') await this.#port.ask(arm, decision)
    })
  }

  /**
   * A person asks for a decision to be made again: the comment is read again
   * as the forge holds it now, and the rules and the assessment run again
   * under the trigger's mode now. An accept that acts now opens its work,
   * once.
   */
  reevaluate(arm: ArmedTrigger, decisionId: string, admit: Admit): Promise<TriggerDecision> {
    return this.#serial.run(async () => {
      const before = (await this.#read()).decisions.find((one) => one.id === decisionId && one.project === arm.project && one.trigger === arm.id)
      if (!before) throw Object.assign(new Error('There is no such decision on this trigger.'), { code: 'HD_TRIGGER_REFUSED' })
      const fact = { ...await this.#port.forge.comment(arm.project, before.repository, Number(before.comment.id), this.#port.signal), project: arm.project }
      const handle = this.#handle(arm.definition)
      const verdict: Verdict = addressesHandle(fact.body ?? '', handle)
        ? await this.#gate(arm, fact, handle)
        : { decision: 'ignore', by: 'rules', reason: `This comment no longer addresses @${handle}.`, rules: [{ id: 'addressed', passed: false, detail: `This comment no longer addresses @${handle}.` }] }
      const ledger = await this.#read()
      const mode = this.#modeOf(ledger, arm)
      let acted = before.acted
      let work = before.work
      let reason = verdict.reason
      if (verdict.decision === 'accept' && mode === 'act' && !before.acted) {
        const answer = await admit(arm, fact)
        if (answer.outcome === 'skipped') reason = `${reason} It did not start: ${answer.reason ?? 'the trigger skipped it.'}`
        else {
          acted = true
          work = await this.#open(arm, fact, answer, before.comment.id)
        }
      }
      const after: TriggerDecision = {
        ...before, decision: verdict.decision, reason, by: verdict.by, rules: verdict.rules, mode, acted, work,
        comment: { ...before.comment, excerpt: excerptOf(fact.body ?? '') },
        decidedAt: this.#port.now(), evaluations: before.evaluations + 1,
      }
      const now = await this.#read()
      await this.#write({ ...now, decisions: now.decisions.map((one) => one.id === after.id ? after : one) })
      this.#port.changed(arm.project)
      if (after.decision === 'ask') await this.#port.ask(arm, after)
      return after
    })
  }

  /**
   * Follows every open thread: links the pull requests its work opened, and
   * closes it once every linked pull request merged or closed. A read that
   * fails leaves the thread as it was, for the next pass.
   */
  sweep(): Promise<void> {
    return this.#serial.run(async () => {
      if (this.#problem) return
      let ledger: LedgerFile
      try {
        ledger = await this.#read()
      } catch {
        return
      }
      for (const thread of ledger.threads.filter((one) => one.state === 'open')) {
        try {
          const found = await this.#port.pullRequests(thread.repository, thread.links.goals, thread.firings)
          const pulls = [...new Set([...thread.links.pulls, ...found.filter((one) => Number.isSafeInteger(one) && one > 0)])]
          let next: StoredThread = pulls.length === thread.links.pulls.length ? thread : { ...thread, links: { ...thread.links, pulls } }
          if (pulls.length > 0) {
            const states = await Promise.all(pulls.map((one) => this.#port.forge.pullState(thread.project, thread.repository, one, this.#port.signal)))
            if (states.every((state) => state !== 'open')) {
              next = { ...next, state: 'closed', closed: { reason: states.includes('merged') ? 'merged' : 'closed', at: this.#port.now() } }
            }
          }
          if (next !== thread) {
            await this.#thread(thread.id, () => next)
            if (next.links !== thread.links) await this.#attach(next)
            this.#port.changed(thread.project)
          }
        } catch (error) {
          this.#port.log('a mention thread could not be followed', { error: error instanceof Error ? error.message : String(error) })
        }
      }
    })
  }

  // ------------------------------------------------------------- the gate

  #handle(definition: TriggerDefinition): string {
    return (definition.handle ?? this.#port.leadName()).toLowerCase()
  }

  /** Whether the comment's author may ask this trigger for work: the arming account, a named person or bot by id, or a collaborator. */
  async #allowed(arm: ArmedTrigger, fact: TriggerFact): Promise<TriggerRuleCheck> {
    const definition = arm.definition
    const fail = (who: string): TriggerRuleCheck => ({ id: 'allowed', passed: false, detail: `${who} is not on this trigger’s list: ${allowedWords(definition)}.` })
    if (typeof fact.author !== 'string') return { id: 'allowed', passed: false, detail: 'Who wrote this comment could not be read.' }
    if (fact.author === arm.binding.account) return { id: 'allowed', passed: true, detail: 'The arming account.' }
    const login = fact.login ?? null
    if (!login) return fail('Its author')
    const signal = this.#port.signal
    if (fact.bot === true) {
      if ((definition.bots ?? []).includes(login) && await this.#port.forge.isAccount(arm.project, login, true, fact.author, signal)) {
        return { id: 'allowed', passed: true, detail: `The bot ${login}, named on this trigger.` }
      }
      return fail(`The bot ${login}`)
    }
    if ((definition.people ?? []).includes(login) && await this.#port.forge.isAccount(arm.project, login, false, fact.author, signal)) {
      return { id: 'allowed', passed: true, detail: `${login}, named on this trigger.` }
    }
    if (definition.from === 'collaborators' && fact.repository && await this.#port.forge.writes(arm.project, fact.repository, login, fact.author, signal)) {
      return { id: 'allowed', passed: true, detail: `${login} can write to the repository.` }
    }
    return fail(login)
  }

  /** The rules in order, stopping at the first that fails; then, when every rule passed, one assessment. */
  async #gate(arm: ArmedTrigger, fact: TriggerFact, handle: string): Promise<Verdict> {
    const definition = arm.definition
    const number = Number(fact.subject)
    const kind = fact.thread ?? 'issue'
    const rules: TriggerRuleCheck[] = [{ id: 'addressed', passed: true, detail: `Addresses @${handle}.` }]
    const ignore = (rule: TriggerRuleCheck): Verdict => {
      rules.push(rule)
      return { decision: 'ignore', by: 'rules', reason: rule.detail ?? 'A rule did not pass.', rules }
    }
    const allowed = await this.#allowed(arm, fact)
    if (!allowed.passed) return ignore(allowed)
    rules.push(allowed)
    if (fact.project !== arm.project || fact.repository !== arm.binding.repository) {
      return ignore({ id: 'project', passed: false, detail: 'This comment is on another repository than the one this trigger was armed for.' })
    }
    rules.push({ id: 'project', passed: true, detail: null })
    const thread = await this.#port.forge.thread(arm.project, fact.repository!, number, this.#port.signal)
    const labels = definition.label ?? []
    if (labels.length > 0) {
      const has = new Set(thread.labels.map((one) => one.toLowerCase()))
      if (!labels.some((one) => has.has(one.toLowerCase()))) {
        return ignore({ id: 'label', passed: false, detail: `${threadWords(kind, number)} carries none of this trigger’s labels: ${labels.join(', ')}.` })
      }
      rules.push({ id: 'label', passed: true, detail: null })
    }
    if (thread.state === 'closed') return ignore({ id: 'handled', passed: false, detail: `${threadWords(kind, number)} is already closed.` })
    rules.push({ id: 'handled', passed: true, detail: null })
    if (asksToStop(fact.body ?? '', handle)) return ignore({ id: 'stop-word', passed: false, detail: 'It asks to stop, and no work follows this thread.' })

    const ask = (reason: string, by: Verdict['by']): Verdict => ({ decision: 'ask', reason, by, rules })
    if (leadContainsSecret(fact.body ?? '')) return ask(ASSESS_SECRET, 'rules')
    if (!this.#port.assess) return ask(ASSESS_UNAVAILABLE, 'assessment')
    const ledger = await this.#read()
    const day = new Date(this.#port.now()).toISOString().slice(0, 10)
    const count = ledger.assessed.day === day ? ledger.assessed.count : 0
    if (count >= ASSESSMENTS_PER_DAY) return ask(ASSESS_CAPPED, 'rules')
    await this.#write({ ...ledger, assessed: { day, count: count + 1 } })
    let answer: MentionAssessment | null = null
    try {
      answer = await this.#port.assess({
        trigger: { id: definition.id, handle, opens: opensWords(definition) },
        repository: fact.repository!,
        thread: { kind, number, title: thread.title },
        comment: { author: fact.login ?? null, body: fact.body ?? '' },
      }, this.#port.signal)
    } catch {
      answer = null
    }
    if (!answer) return ask(ASSESS_UNAVAILABLE, 'assessment')
    return { decision: answer.decision, reason: answer.reason, by: 'assessment', rules }
  }

  // ------------------------------------------------------------- records

  async #record(arm: ArmedTrigger, fact: TriggerFact, verdict: Verdict, mode: TriggerMode, acted: boolean, work: string | null): Promise<TriggerDecision> {
    const id = commentId(fact.url ?? '')
    const decision: TriggerDecision = {
      id: `d-${digest([arm.project, arm.id, id])}`, trigger: arm.id, project: arm.project, repository: fact.repository ?? '',
      thread: { kind: fact.thread ?? 'issue', number: Number(fact.subject) },
      comment: { id, url: fact.url ?? '', at: fact.at, author: fact.login ?? null, excerpt: excerptOf(fact.body ?? '') },
      decision: verdict.decision, reason: verdict.reason, by: verdict.by, rules: verdict.rules,
      mode, acted, work, decidedAt: this.#port.now(), evaluations: 0,
    }
    const ledger = await this.#read()
    await this.#write({ ...ledger, decisions: [...ledger.decisions.filter((one) => one.id !== decision.id), decision] })
    this.#port.changed(arm.project)
    return decision
  }

  /** A new thread of work for an accepted request that was admitted; its id. */
  async #open(arm: ArmedTrigger, fact: TriggerFact, answer: OfferAnswer, comment: string): Promise<string> {
    const number = Number(fact.subject)
    const kind = fact.thread ?? 'issue'
    const thread: StoredThread = {
      id: `w-${digest([arm.project, arm.id, comment])}`, trigger: arm.id, project: arm.project, repository: fact.repository ?? '',
      origin: { kind, number },
      links: { issues: kind === 'issue' ? [number] : [], pulls: kind === 'pull-request' ? [number] : [], goals: answer.goal ? [answer.goal] : [] },
      state: 'open', closed: null, resumes: 0, observations: 0, openedAt: this.#port.now(),
      firings: [answer.firing], seen: [comment],
    }
    const ledger = await this.#read()
    await this.#write({ ...ledger, threads: [...ledger.threads.filter((one) => one.id !== thread.id), thread] })
    await this.#attach(thread)
    return thread.id
  }

  async #attach(thread: StoredThread): Promise<void> {
    try {
      await this.#port.workItems.attach({ kind: 'mention', trigger: thread.trigger, repository: thread.repository, thread: thread.origin }, thread.links)
    } catch (error) {
      this.#port.log('a mention thread could not be attached to the work ledger', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  async #thread(id: string, change: (thread: StoredThread) => StoredThread): Promise<void> {
    const ledger = await this.#read()
    await this.#write({ ...ledger, threads: ledger.threads.map((one) => one.id === id ? change(one) : one) })
  }
}

const remember = (seen: readonly string[], id: string): readonly string[] => [...seen, id].slice(-THREAD_SEEN)

const publicThread = (thread: StoredThread): TriggerWorkThread => {
  const { firings: _firings, seen: _seen, ...rest } = thread
  return rest
}
