import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

import type {
  FlowOrigin,
  FlowPreview,
  TriggerArmPreview,
  TriggerDefinition,
  TriggerProblem,
  TriggerProjectView,
  TriggerView,
} from '@harnessdesk/protocol'

import type { CredentialCipher } from '../credentials.js'
import { Serial } from '../goals/assignments.js'
import { ceilingWithin } from '../agent-seating.js'
import { atomicJson, syncDirectory } from '../goals/store.js'
import { agentFlowSource, parseTriggers } from './definition.js'
import { TRIGGERS_PATH, type TriggerSourceFile } from './source.js'

/**
 * Machine consent: the only thing that lets a committed trigger run.
 *
 * A trigger in a clone does nothing until a person on this machine previews
 * exactly what it would run — the committed declaration, the whole flow it
 * opens, every Agent brief, command, working directory, timeout, grant and
 * seating input — and arms it with that preview's one-use token. The arm is
 * bound to five things besides the trigger's id: which project and which
 * clone of it, the committed file's bytes, the digest of that whole closure,
 * the signed-in forge account, and the forge repository. Any of them moving
 * is a changed arm, and a changed arm opens nothing until it is armed again.
 * A runtime's availability is not bound: it is rechecked at dispatch.
 *
 * The consent lives in `triggers-machine.json` in the desk's state folder,
 * each arm signed with a key sealed by the machine's credential cipher in
 * `triggers-key.bin`. Neither is in a backup; a generic preference patch, an
 * Agent tool, a restored Goal or repository text cannot write either. A file
 * copied from another machine, edited by hand, of an unknown version or
 * unreadable is not authority: its arms list as refused, and rearming is the
 * repair. The file has one writer — this class, through one serial queue —
 * and every write is a synced temporary renamed over it, then the folder
 * synced, while the host holds the desk's writer lease.
 *
 * Lock order: the consent queue asks for no other queue. Arming observes the
 * source first (the task-3 baseline, outside the queue), then re-reads every
 * bound input *inside* the queue and writes only if nothing moved.
 */

const MACHINE_FILE = 'triggers-machine.json'
const KEY_FILE = 'triggers-key.bin'
const UNREADABLE_ASIDE = 'triggers-machine.json.unreadable'
const MACHINE_LIMIT = 1024 * 1024
const ARM_LIMIT = 4096
const TOKEN_TTL_MS = 5 * 60_000
const CLOSURE_ENTRY_LIMIT = 128
const CLOSURE_SOURCE_LIMIT = 1024 * 1024
const SIGNATURE = /^[a-f0-9]{64}$/

/** What an arm is bound to, besides its trigger id. */
export interface ArmBinding {
  readonly project: string
  readonly incarnation: string
  readonly source: string
  readonly closure: string
  /** An opaque digest of the forge sign-in, or `none` for a source that reads no forge. */
  readonly account: string
  /** The forge repository the arm observes, or null for a source that reads no forge. */
  readonly repository: string | null
}

export function consentMatches(saved: ArmBinding | null, current: ArmBinding): boolean {
  return saved !== null && saved.project === current.project &&
    saved.incarnation === current.incarnation && saved.source === current.source &&
    saved.closure === current.closure && saved.account === current.account &&
    saved.repository === current.repository
}

/** The frozen execution shape an arm consents to. */
export interface TriggerClosure {
  /** The flow text that would run: the resolved catalogue file, or the single-Agent flow. */
  readonly source: string
  readonly digest: string
  readonly preview: FlowPreview
  readonly bindings: readonly { readonly kind: 'flow' | 'agent' | 'command' | 'seating'; readonly id: string; readonly digest: string }[]
  /** What refuses arming this shape, beyond the flow's own problems: all about what it says, none about this moment. */
  readonly problems: readonly TriggerProblem[]
  /**
   * What refuses arming *now* without changing what would run — no seat can
   * be taken while a runtime is down. A preview shows it; an arm binds none
   * of it, and a firing's dispatch reads it again (plan decision 4).
   */
  readonly availability: readonly TriggerProblem[]
}

/** The host-only port on the flow preview owner that freezes what a trigger would run. */
export interface TriggerPreviewPort {
  freeze(root: string, definition: TriggerDefinition): Promise<TriggerClosure>
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const CLOSURE_FIX = 'Correct the flow or its Agents, commit them, and preview again.'
const SEAT_FIX = 'Its Seats below say why each one was passed over and what fixes it; then preview again.'

/** The flow a trigger opens could not be resolved: what the project says now, not a read to try again. */
export class ClosureMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClosureMissingError'
  }
}

/** The two reads a closure is frozen from, both owned elsewhere. */
export interface TriggerClosureReads {
  /** `FlowCatalog.resolve`: project, then user, then built-in, by id. */
  flowSource(root: string, id: string): Promise<{ readonly source: string; readonly origin: FlowOrigin; readonly path: string }>
  /** `FlowPreviews.freeze`: the dry run with no start token. */
  preview(root: string, source: string): Promise<FlowPreview>
}

/**
 * Resolves a trigger's target and freezes its closure. Reads only: the flow
 * by the catalogue's own id and layer rules, the preview by the flow preview
 * owner's own no-token read.
 */
export class TriggerClosures implements TriggerPreviewPort {
  readonly #port: TriggerClosureReads

  constructor(port: TriggerClosureReads) {
    this.#port = port
  }

  async freeze(root: string, definition: TriggerDefinition): Promise<TriggerClosure> {
    const problems: TriggerProblem[] = []
    let text: string
    let flow: { readonly id: string; readonly origin: string; readonly path: string | null }
    if ('flow' in definition.opens) {
      let resolved: Awaited<ReturnType<TriggerClosureReads['flowSource']>>
      try {
        resolved = await this.#port.flowSource(root, definition.opens.flow)
      } catch (error) {
        throw new ClosureMissingError(error instanceof Error ? error.message : String(error))
      }
      text = resolved.source
      flow = { id: definition.opens.flow, origin: resolved.origin, path: resolved.path }
    } else {
      text = agentFlowSource(definition.opens.agent)
      flow = { id: `agent:${definition.opens.agent}`, origin: 'trigger', path: null }
    }
    const preview = await this.#port.preview(root, text)
    const availability: TriggerProblem[] = []
    for (const problem of preview.problems) {
      if (problem.level !== 'error') continue
      if (problem.availability) availability.push({ at: `flow.${problem.at}`, text: problem.text, fix: SEAT_FIX })
      else problems.push({ at: `flow.${problem.at}`, text: problem.text, fix: CLOSURE_FIX })
    }
    const compiled = preview.compiled
    const bindings: TriggerClosure['bindings'][number][] = [{ kind: 'flow', id: flow.id, digest: sha256(text) }]
    let executable = Buffer.byteLength(text, 'utf8')
    for (const binding of compiled.bindings) {
      executable += Buffer.byteLength(binding.agent.brief, 'utf8')
      bindings.push({
        kind: 'agent', id: `${binding.role}[${binding.index}]`,
        digest: sha256(JSON.stringify([binding.agent.id, binding.origin, binding.digest, binding.grant, binding.seats])),
      })
    }
    for (const command of preview.commands) {
      executable += Buffer.byteLength(command.run, 'utf8')
      bindings.push({ kind: 'command', id: command.role, digest: sha256(JSON.stringify([command.run, command.cwd, command.timeout])) })
      const inside = relative(root, command.cwd)
      if (inside.startsWith('..') || isAbsolute(inside)) {
        problems.push({ at: `flow.roles.${command.role}.cwd`, text: 'This check runs outside the project, so a trigger cannot consent to it.', fix: 'Give the check a working folder inside the project.' })
      }
    }
    for (const seat of preview.seats) {
      /*
       * What seating would try, never what it would get: the candidates in
       * order and the level the need declares, from the Agent's own ceiling
       * and the role's grant. Which candidate wins, and whether the winner
       * holds its ceiling, is this machine at this moment — read again at
       * dispatch, never bound (review #898).
       */
      const binding = compiled.bindings.find((one) => one.role === seat.role && one.index === seat.index)
      const level = binding?.agent.ceiling ? ceilingWithin(binding.agent.ceiling, binding.grant) : binding?.grant ?? null
      bindings.push({
        kind: 'seating', id: `${seat.role}[${seat.index}]`,
        digest: sha256(JSON.stringify({ agent: seat.agent, from: seat.plan.from, blocked: seat.plan.blocked, candidates: seat.plan.candidates.map((one) => one.seat), level, isolate: seat.isolate })),
      })
    }
    if (bindings.length > CLOSURE_ENTRY_LIMIT || executable > CLOSURE_SOURCE_LIMIT) {
      problems.push({ at: 'flow', text: 'This flow is too large to arm: at most 128 bound parts and 1 MiB of flow, briefs and commands.', fix: 'Arm a smaller flow.' })
    }
    if (definition.forks === 'allow') {
      const document = compiled.document
      const writes = document.format !== 'agents' || document.flow.roles.some((role) => role.kind === 'check' || (role.kind === 'agent' && role.grant !== 'read'))
      if (writes) {
        problems.push({
          at: 'forks',
          text: 'A trigger that allows forks may only read: every role must have a read grant and none may run a command against a stranger’s pull request.',
          fix: 'Set forks: never, or open a flow whose roles only read.',
        })
      }
    }
    const digest = sha256(JSON.stringify({
      version: 1,
      definition,
      flow: { ...flow, digest: sha256(text) },
      bindings,
      messaging: preview.messaging,
    }))
    return { source: text, digest, preview, bindings, problems, availability }
  }
}

/** Everything arming reads from outside this class. */
export interface TriggerConsentPort {
  /** Admits a root the person opened (`workspaces.confineGitRoot`); its canonical path. */
  confine(root: string): Promise<string>
  /** The admitted root's triggers file, as committed. Throws a sentence when the file is refused. */
  source(root: string): Promise<TriggerSourceFile>
  readonly closure: TriggerPreviewPort
  /** The signed-in forge identity as an opaque digest, or why there is none; read from the project's own folder. */
  account(project: string): Promise<{ readonly account: string } | { readonly refused: string; readonly fix: string }>
  /** The forge repository this project is observed on, or why none can be. */
  repository(project: string): Promise<{ readonly repository: string } | { readonly refused: string; readonly fix: string }>
  /**
   * The first observation after arming, which baselines existing facts. Throws
   * when the source cannot be read, and then nothing is armed. Returns the
   * baseline instant to persist with the arm.
   */
  baseline(arm: { readonly project: string; readonly id: string; readonly definition: TriggerDefinition; readonly binding: ArmBinding }): Promise<number>
  now(): number
}

/** One arm as the monitor reads it: verified, enabled, and not yet rechecked against the world. */
export interface ArmedTrigger {
  readonly project: string
  readonly id: string
  readonly definition: TriggerDefinition
  readonly binding: ArmBinding
  readonly baseline: number
  readonly armedAt: number
}

interface StoredArm {
  readonly project: string
  readonly id: string
  readonly enabled: boolean
  readonly binding: ArmBinding
  readonly definition: TriggerDefinition
  readonly baseline: number
  readonly armedAt: number
  readonly signature: string
}

interface MachineDocument {
  readonly revision: number
  readonly arms: readonly StoredArm[]
  /** Why the file as a whole is not authority; null when it read. */
  readonly unreadable: string | null
}

/** A file the desk owns, written whole: a synced temporary renamed over it, then its folder synced. */
const atomicBytes = async (file: string, bytes: Buffer): Promise<void> => {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    await syncDirectory(dirname(file))
  } finally {
    await rm(temporary, { force: true })
  }
}

const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code })
const refusal = (message: string): Error => coded(message, 'HD_TRIGGER_REFUSED')

export const PREVIEW_AGAIN = 'This arm preview is no longer valid. Preview it again.'
const CHANGED = 'The trigger or what it runs changed since it was previewed. Preview it again.'
const REARM = 'Review the preview and arm it again.'
const UNVERIFIED = 'This machine cannot verify how this trigger was armed, so it does not run.'
const UNVERIFIED_FIX = 'Preview it and arm it again on this machine.'

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, limit = 4096): value is string => typeof value === 'string' && value.length <= limit

const bindingOf = (value: unknown): ArmBinding | null => {
  if (!isMap(value)) return null
  const { project, incarnation, source, closure, account, repository } = value
  if (!text(project) || !text(incarnation, 128) || !text(source, 128) || !text(closure, 128) || !text(account, 128) ||
    !(repository === null || text(repository, 256))) return null
  return { project, incarnation, source, closure, account, repository }
}

const armOf = (value: unknown): StoredArm | null => {
  if (!isMap(value)) return null
  const binding = bindingOf(value['binding'])
  const { project, id, enabled, definition, baseline, armedAt, signature } = value
  if (!binding || !text(project) || !text(id, 64) || typeof enabled !== 'boolean' || !isMap(definition) ||
    !Number.isSafeInteger(baseline) || !Number.isSafeInteger(armedAt) || !text(signature, 128)) return null
  return { project, id, enabled, binding, definition: definition as unknown as TriggerDefinition, baseline: baseline as number, armedAt: armedAt as number, signature }
}

/** What an arm's signature covers: every field, in a fixed order. */
const signed = (arm: Omit<StoredArm, 'signature'>): string => JSON.stringify([
  'harnessdesk-trigger-arm', 1, arm.project, arm.id, arm.enabled,
  [arm.binding.project, arm.binding.incarnation, arm.binding.source, arm.binding.closure, arm.binding.account, arm.binding.repository],
  arm.definition, arm.baseline, arm.armedAt,
])

interface Current {
  readonly file: TriggerSourceFile
  readonly problems: readonly TriggerProblem[]
  readonly definition: TriggerDefinition | null
  readonly closure: TriggerClosure | null
  readonly binding: ArmBinding | null
  /** The fix for the first problem that stopped a binding, when it is the forge's. */
  readonly fix: string | null
  /** The forge repository it would bind, once read: what the arming review names. */
  readonly repository?: string | null
}

export class TriggerConsent {
  readonly #home: string
  readonly #cipher: CredentialCipher
  readonly #port: TriggerConsentPort
  readonly #serial = new Serial()
  readonly #tokens = new Map<string, { readonly project: string; readonly id: string; readonly binding: ArmBinding; readonly expires: number }>()

  constructor(home: string, cipher: CredentialCipher, port: TriggerConsentPort) {
    this.#home = home
    this.#cipher = cipher
    this.#port = port
  }

  // ------------------------------------------------------------ storage

  async #key(): Promise<Buffer | null> {
    let blob: Buffer
    try {
      blob = await readFile(join(this.#home, KEY_FILE))
    } catch {
      return null
    }
    try {
      const hex = this.#cipher.decrypt(blob).trim()
      return /^[a-f0-9]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null
    } catch {
      return null
    }
  }

  /** The key, or a new one when there is none this machine can read: arms the old one signed stop verifying. */
  async #ensureKey(): Promise<Buffer> {
    const existing = await this.#key()
    if (existing) return existing
    const key = randomBytes(32)
    await atomicBytes(join(this.#home, KEY_FILE), this.#cipher.encrypt(key.toString('hex')))
    return key
  }

  async #load(): Promise<MachineDocument> {
    const file = join(this.#home, MACHINE_FILE)
    let handle
    try {
      handle = await open(file, 'r')
    } catch {
      return { revision: 0, arms: [], unreadable: null }
    }
    let raw: string
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MACHINE_LIMIT) return { revision: 0, arms: [], unreadable: 'too large' }
      raw = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { revision: 0, arms: [], unreadable: 'not JSON' }
    }
    if (!isMap(parsed) || parsed['version'] !== 1 || !Number.isSafeInteger(parsed['revision']) || !Array.isArray(parsed['arms']) ||
      (parsed['arms'] as unknown[]).length > ARM_LIMIT) {
      const revision = isMap(parsed) && Number.isSafeInteger(parsed['revision']) ? parsed['revision'] as number : 0
      return { revision, arms: [], unreadable: 'unknown version' }
    }
    const arms: StoredArm[] = []
    for (const one of parsed['arms'] as unknown[]) {
      const arm = armOf(one)
      if (arm) arms.push(arm)
    }
    return { revision: parsed['revision'] as number, arms, unreadable: null }
  }

  #verify(arm: StoredArm, key: Buffer | null): boolean {
    if (!key || !SIGNATURE.test(arm.signature)) return false
    const expected = createHmac('sha256', key).update(signed(arm)).digest()
    return timingSafeEqual(expected, Buffer.from(arm.signature, 'hex'))
  }

  /** The arm recorded for one trigger, and whether this machine can vouch for it. */
  async #recorded(project: string, id: string): Promise<{ readonly arm: StoredArm | null; readonly verified: boolean; readonly unreadable: boolean }> {
    const document = await this.#load()
    if (document.unreadable !== null) return { arm: null, verified: false, unreadable: true }
    const arm = document.arms.find((one) => one.project === project && one.id === id) ?? null
    if (!arm) return { arm: null, verified: false, unreadable: false }
    return { arm, verified: this.#verify(arm, await this.#key()), unreadable: false }
  }

  // ------------------------------------------------------------- reads

  /**
   * Every bound input, read now. Never throws for what the project says.
   *
   * - `preview`: everything that would refuse arming now, availability too.
   * - `view`: what an arm stands on — its content and its forge — and not
   *   whether a seat can be taken this moment, which a dispatch rechecks.
   * - `offer`: the content only, for a fact being answered. A read that
   *   cannot be made now — the file, a seat plan, who is signed in, which
   *   repository — throws: that is no answer, so the fact is kept and offered
   *   again (review #898), never consumed as a changed arm.
   */
  async #current(root: string, id: string, mode: 'preview' | 'view' | 'offer' = 'preview'): Promise<Current> {
    const canonical = await this.#port.confine(root)
    let file: TriggerSourceFile
    try {
      file = await this.#port.source(canonical)
    } catch (error) {
      if (mode === 'offer') throw error
      const empty: TriggerSourceFile = { project: canonical, incarnation: '', revision: null, sourceDigest: null, text: null, workingCopyChanged: false }
      return { file: empty, problems: [{ at: 'file', text: (error as Error).message, fix: 'Commit .harnessdesk/triggers.yml as a regular text file in a real folder.' }], definition: null, closure: null, binding: null, fix: null }
    }
    let repository: string | null = null
    const refuse = (problems: readonly TriggerProblem[], definition: TriggerDefinition | null = null, closure: TriggerClosure | null = null): Current =>
      ({ file, problems, definition, closure, binding: null, fix: problems[0]?.fix ?? null, repository })
    if (file.text === null || file.sourceDigest === null) {
      return refuse([{ at: 'file', text: 'There is no committed trigger file in this project.', fix: 'Commit .harnessdesk/triggers.yml.' }])
    }
    const document = parseTriggers(file.text)
    if (document.problems.length > 0) return refuse(document.problems)
    const definition = document.definitions.find((one) => one.id === id) ?? null
    if (!definition) return refuse([{ at: 'id', text: `There is no committed trigger called "${id}".`, fix: 'Commit the trigger, then preview it.' }])
    let closure: TriggerClosure
    try {
      closure = await this.#port.closure.freeze(file.project, definition)
    } catch (error) {
      // A flow that is gone is what the project says now: a changed arm. Any other failed read is no answer.
      if (mode === 'offer' && !(error instanceof ClosureMissingError)) throw error
      return refuse([{ at: 'opens', text: (error as Error).message, fix: CLOSURE_FIX }], definition)
    }
    const problems: TriggerProblem[] = [...closure.problems, ...(mode === 'preview' ? closure.availability : [])]
    let account = 'none'
    if (definition.on.kind !== 'schedule') {
      const signedIn = await this.#port.account(file.project)
      if ('refused' in signedIn) {
        if (mode === 'offer') throw coded(signedIn.refused, 'HD_TRIGGER_UNREAD')
        problems.push({ at: 'account', text: signedIn.refused, fix: signedIn.fix })
      } else account = signedIn.account
      const repo = await this.#port.repository(file.project)
      if ('refused' in repo) {
        if (mode === 'offer') throw coded(repo.refused, 'HD_TRIGGER_UNREAD')
        problems.push({ at: 'repository', text: repo.refused, fix: repo.fix })
      } else repository = repo.repository
    }
    // Answering a fact compares content alone: a problem the same content always has was refused at arming.
    if (problems.length > 0 && mode !== 'offer') return refuse(problems, definition, closure)
    return {
      file, problems: [], definition, closure, fix: null, repository,
      binding: { project: file.project, incarnation: file.incarnation, source: file.sourceDigest, closure: closure.digest, account, repository },
    }
  }

  #sweep(): void {
    const now = this.#port.now()
    for (const [token, held] of this.#tokens) if (held.expires < now) this.#tokens.delete(token)
  }

  async preview(root: string, id: string): Promise<TriggerArmPreview> {
    this.#sweep()
    const current = await this.#current(root, id)
    let token: string | null = null
    let expiresAt: number | null = null
    if (current.binding && current.problems.length === 0) {
      token = randomUUID()
      expiresAt = this.#port.now() + TOKEN_TTL_MS
      this.#tokens.set(token, { project: current.binding.project, id, binding: current.binding, expires: expiresAt })
    }
    return {
      id, token, expiresAt, sourcePath: TRIGGERS_PATH, workingCopyChanged: current.file.workingCopyChanged,
      definition: current.definition, flow: current.closure?.preview ?? null, problems: current.problems, moneyPolicy: 'observed-stop',
      repository: current.repository ?? null,
    }
  }

  /**
   * Arms one trigger with its preview's one-use token: consumed here whatever
   * happens, refused unless every bound input still reads exactly as it was
   * previewed, and written only after the first observation succeeded.
   */
  async arm(root: string, id: string, token: string): Promise<TriggerView> {
    this.#sweep()
    const held = this.#tokens.get(token)
    this.#tokens.delete(token)
    if (!held || held.expires < this.#port.now() || held.id !== id) throw refusal(PREVIEW_AGAIN)
    const before = await this.#current(root, id)
    if (!before.binding || !before.definition || held.project !== before.binding.project || !consentMatches(held.binding, before.binding)) {
      throw refusal(CHANGED)
    }
    const definition = before.definition
    const baseline = await this.#port.baseline({ project: held.project, id, definition, binding: held.binding })
    await this.#serial.run(async () => {
      // Read again inside the queue: what is written is what is true now.
      const again = await this.#current(root, id)
      if (!again.binding || !consentMatches(held.binding, again.binding)) throw refusal(CHANGED)
      const document = await this.#load()
      if (document.unreadable !== null) {
        await rename(join(this.#home, MACHINE_FILE), join(this.#home, UNREADABLE_ASIDE)).catch(() => {})
      }
      const key = await this.#ensureKey()
      const body: Omit<StoredArm, 'signature'> = {
        project: held.project, id, enabled: true, binding: held.binding, definition, baseline, armedAt: this.#port.now(),
      }
      const arm: StoredArm = { ...body, signature: createHmac('sha256', key).update(signed(body)).digest('hex') }
      await this.#save(document, arm)
    })
    return this.#view(root, id)
  }

  /** Disarms one trigger on this machine: an explicit, signed off switch. Never runs anything. */
  async disarm(root: string, id: string): Promise<TriggerView> {
    const project = (await this.#current(root, id)).file.project
    await this.#serial.run(async () => {
      const document = await this.#load()
      const existing = document.unreadable === null ? document.arms.find((one) => one.project === project && one.id === id) : undefined
      if (!existing) return
      const key = await this.#ensureKey()
      const body: Omit<StoredArm, 'signature'> = {
        project: existing.project, id: existing.id, enabled: false, binding: existing.binding,
        definition: existing.definition, baseline: existing.baseline, armedAt: this.#port.now(),
      }
      await this.#save(document, { ...body, signature: createHmac('sha256', key).update(signed(body)).digest('hex') })
    })
    return this.#view(root, id)
  }

  async #save(document: MachineDocument, arm: StoredArm): Promise<void> {
    const arms = [...document.arms.filter((one) => !(one.project === arm.project && one.id === arm.id)), arm]
    if (arms.length > ARM_LIMIT) throw refusal('This machine holds too many trigger arms. Disarm some first.')
    const revision = Math.max(document.revision + 1, this.#port.now())
    await atomicJson(join(this.#home, MACHINE_FILE), { version: 1, revision, arms })
  }

  /**
   * The current binding when this trigger is armed here and nothing it is
   * bound to moved; null otherwise. Content only: throws — no answer yet —
   * when something it reads cannot be read now.
   */
  async binding(root: string, id: string): Promise<ArmBinding | null> {
    const current = await this.#current(root, id, 'offer')
    if (!current.binding) return null
    const recorded = await this.#recorded(current.binding.project, id)
    if (!recorded.arm || !recorded.verified || !recorded.arm.enabled) return null
    return consentMatches(recorded.arm.binding, current.binding) ? current.binding : null
  }

  /**
   * Every verified, enabled arm on this machine, as recorded — what a monitor
   * may poll for. Recorded is not current: admission rechecks `binding` before
   * anything fires.
   */
  async armed(): Promise<readonly ArmedTrigger[]> {
    const document = await this.#load()
    if (document.unreadable !== null) return []
    const key = await this.#key()
    return document.arms
      .filter((arm) => arm.enabled && this.#verify(arm, key))
      .map(({ project, id, definition, binding, baseline, armedAt }) => ({ project, id, definition, binding, baseline, armedAt }))
  }

  async #view(root: string, id: string, known?: Current): Promise<TriggerView> {
    const current = known ?? await this.#current(root, id, 'view')
    const project = current.binding?.project ?? current.file.project
    const recorded = await this.#recorded(project, id)
    const base = { id, definition: current.definition, last: null, openGoals: 0 }
    if (recorded.unreadable || (recorded.arm && !recorded.verified)) {
      return { ...base, armed: false, state: 'refused', reason: UNVERIFIED, fix: UNVERIFIED_FIX }
    }
    if (!recorded.arm || !recorded.arm.enabled) return { ...base, armed: false, state: 'off', reason: null, fix: null }
    if (!current.binding) {
      return { ...base, armed: false, state: 'refused', reason: current.problems[0]?.text ?? UNVERIFIED, fix: current.fix ?? REARM }
    }
    const saved = recorded.arm.binding
    const now = current.binding
    if (consentMatches(saved, now)) return { ...base, armed: true, state: 'armed', reason: null, fix: null }
    const reason = saved.project !== now.project || saved.incarnation !== now.incarnation
      ? 'This project was replaced since the trigger was armed.'
      : saved.source !== now.source ? 'The triggers file changed since it was armed.'
        : saved.account !== now.account ? 'The forge sign-in changed since it was armed.'
          : saved.repository !== now.repository ? 'The project’s forge repository changed since it was armed.'
            : 'The flow, an Agent, a command or its seating changed since it was armed.'
    return { ...base, armed: false, state: 'changed', reason, fix: REARM }
  }

  /** A project's triggers file and how this machine stands on each trigger in it. Reads only. */
  async list(root: string): Promise<TriggerProjectView> {
    const canonical = await this.#port.confine(root)
    const document = await this.#load()
    let file: TriggerSourceFile | null = null
    let problems: readonly TriggerProblem[] = []
    try {
      file = await this.#port.source(canonical)
    } catch (error) {
      problems = [{ at: 'file', text: (error as Error).message, fix: 'Commit .harnessdesk/triggers.yml as a regular text file in a real folder.' }]
    }
    const parsed = file?.text ? parseTriggers(file.text) : { definitions: [], problems: [] }
    if (parsed.problems.length > 0) problems = parsed.problems
    const triggers: TriggerView[] = []
    for (const definition of parsed.definitions) triggers.push(await this.#view(canonical, definition.id))
    return {
      project: file?.project ?? canonical,
      revision: document.revision,
      path: TRIGGERS_PATH,
      exists: file === null || file.text !== null,
      workingCopyChanged: file?.workingCopyChanged ?? false,
      triggers,
      problems,
    }
  }
}
