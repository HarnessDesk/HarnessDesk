import { createHash } from 'node:crypto'
import { PushPlaintext } from '@harnessdesk/contract'
import { fromB64u, sealPushJson } from '@harnessdesk/crypto'
import type { AgentEvent, Approval, HarnessDeskAccountStatus, LeadInbox, LeadInboxItem } from '@harnessdesk/protocol'
import type { Device } from '@harnessdesk/phone-link'
import { accountRefusalStatus, type PhonePushStatus, type SealedPhonePush } from './harnessdesk-account.js'
import { scrub } from './phone-redact.js'

/**
 * The sealed body of a needs-you push: the contract's `PushPlaintext`, which the phone's notification extension opens.
 * `title` is the conversation, Team or Lead it is about; `body` one line saying what it waits on; `deep` the Inbox's own
 * id for the item (`ask:<id>`, `lead`, `chat:<runtime:session>`, `team:<goal>`). The account service and the phone's
 * push service only ever carry it sealed.
 */
export type PhonePushBody = PushPlaintext & { readonly kind: 'needs-you'; readonly deep: string }

/** The part of the HarnessDesk account a push needs. */
export interface PhonePushAccount {
  status(): Promise<HarnessDeskAccountStatus>
  sendPush(push: SealedPhonePush): Promise<PhonePushStatus>
}

export interface PhonePushOptions {
  readonly account: PhonePushAccount
  /** The phones this desk has paired, each with the key its pushes are sealed with. */
  readonly devices: () => readonly Device[]
  /** The Inbox the bell and the phone list: what waits on the person. */
  readonly inbox: () => Promise<LeadInbox>
  /** The Lead's name, for a push about the Lead or its question; null when there is none to read. */
  readonly leadName: () => Promise<string | null>
  readonly log: (message: string, fields?: Record<string, unknown>) => void
  /** How long changes are gathered before the Inbox is read again. */
  readonly delayMs?: number
  readonly now?: () => number
  /** The HTTP status a send was refused with; the account client's own by default. */
  readonly refusalStatus?: (error: unknown) => number | undefined
}

export const PUSH_TITLE_CHARS = 80
export const PUSH_BODY_CHARS = 120
/** A ref is the Inbox's id, sent as `deep`; one longer than this is not sent rather than cut, since a cut ref would open nothing. */
const PUSH_REF_CHARS = 200
/** An item that stopped waiting and came back within this long is not pushed again. */
export const PUSH_REPEAT_MS = 10 * 60_000
/** The desk's own pace, under the account service's limits (60 a minute per desk, 30 per phone). */
export const PUSH_DESK_PER_MINUTE = 30
export const PUSH_DEVICE_PER_MINUTE = 12
/** How long the sender holds off after the account says too many, or no longer accepts this desk's session. */
const PUSH_PAUSE_MS = 60_000
/** How long a phone the push service has no token for is left alone before it is tried again. */
const PUSH_UNREGISTERED_MS = 10 * 60_000
/** Sessions whose open approvals are remembered for a push's line, and approvals per session. */
const APPROVAL_SESSIONS = 256
const APPROVALS_PER_SESSION = 16

/**
 * One flat line: controls and runs of space removed, clipped with an ellipsis to at most `max` UTF-16 units (the
 * contract's own count), never splitting a character.
 */
export const pushLine = (value: string, max: number): string => {
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const chars = [...clean]
  let kept = ''
  for (const char of chars) {
    if (kept.length + char.length > max - 1) break
    kept += char
  }
  return `${kept.trimEnd()}…`
}

/** A short stable tag for a ref, so a later push about the same item replaces the earlier one on the lock screen. */
export const pushCollapse = (ref: string): string => createHash('sha256').update(ref).digest('base64url').slice(0, 22)

/** What one open approval asks for, in one line the phone can show. Agent text, so it is scrubbed. */
export const approvalLine = (approval: Approval): string => {
  switch (approval.type) {
    case 'command': return approval.kind === 'stdin' ? `Asks to send input to ${scrub(approval.command, 200)}` : `Asks to run ${scrub(approval.command, 200)}`
    case 'fileChange': {
      const files = approval.changes.length
      const name = files === 1 ? approval.changes[0]!.path.split(/[\\/]/).filter(Boolean).pop() : undefined
      return name ? `Asks to change ${scrub(name, 120)}` : `Asks to change ${files} files`
    }
    case 'permission': return scrub(approval.summary, 200) || 'Asks for permission'
    case 'userInput': return scrub(approval.questions[0]?.question ?? '', 200) || 'Has a question for you'
    case 'elicitation': return scrub(approval.message, 200) || 'Has a question for you'
  }
}

/**
 * The body of one push, as the contract's `PushPlaintext` and within what can be sealed: the body line gives way first.
 * `id` names this one push. Null when the ref alone could not fit, which an Inbox id never comes near.
 */
export const pushBody = (ref: string, title: string, body: string, ts: number): PhonePushBody | null => {
  if (!ref || ref.length > PUSH_REF_CHARS) return null
  let line = pushLine(body, PUSH_BODY_CHARS)
  const heading = pushLine(title, PUSH_TITLE_CHARS) || 'HarnessDesk'
  const id = createHash('sha256').update(`${ref}\0${ts}`).digest('base64url').slice(0, 22)
  for (;;) {
    const value: PhonePushBody = { v: 1, id, ts, kind: 'needs-you', title: heading, body: line, deep: ref }
    if (PushPlaintext.safeParse(value).success) return value
    if (!line) return null
    line = pushLine(line, Math.floor(line.length / 2))
  }
}

/**
 * Sends one push to each phone the account linked to this desk when something newly needs the person. "Needs the
 * person" is the Inbox's own list (`lead/inbox/read`), the one the bell and the phone show, so a push never says
 * something waits that the Inbox does not list. Each push is sealed with the phone's own key on this desk: the account
 * service and the phone's push service carry it and can read none of it.
 *
 * Nothing is pushed for what already waited when the sender started looking, an item is pushed once while it waits,
 * and one that comes back within `PUSH_REPEAT_MS` is not pushed again. A push that fails is logged and dropped: the
 * phone's Inbox still lists the item.
 */
export class PhonePushSender {
  readonly #options: PhonePushOptions
  #timer: ReturnType<typeof setTimeout> | null = null
  #running: Promise<void> | null = null
  #again = false
  #disposed = false
  /** What waited at the last read; null until a read with somebody to push to sets the baseline. */
  #waiting: Set<string> | null = null
  readonly #pushedAt = new Map<string, number>()
  readonly #approvals = new Map<string, { readonly id: string; readonly line: string }[]>()
  readonly #sent: number[] = []
  readonly #perDevice = new Map<string, number[]>()
  /** Phones left alone until this time: no push token, or refused as not linked (until the account changes). */
  readonly #skip = new Map<string, number>()
  #pausedUntil = 0

  constructor(options: PhonePushOptions) { this.#options = options }

  #now(): number { return (this.#options.now ?? Date.now)() }

  /** Something that can change what waits on the person happened; the Inbox is read once things settle. */
  poke(): void {
    if (this.#disposed || this.#timer) return
    this.#timer = setTimeout(() => { this.#timer = null; this.#run() }, this.#options.delayMs ?? 1500)
    this.#timer.unref?.()
  }

  /** The account said something: a phone it refused as not linked may be linked now. Timed waits keep running. */
  accountChanged(): void {
    for (const [id, until] of this.#skip) if (until === Number.POSITIVE_INFINITY) this.#skip.delete(id)
    this.poke()
  }

  /** Approvals as agents ask and settle them, so a push about a chat can say what it asks for. */
  noteEvent(runtime: string, event: AgentEvent): void {
    if (event.type === 'approval/requested') {
      const key = `${runtime}:${event.approval.sessionId}`
      const list = (this.#approvals.get(key) ?? []).filter(one => one.id !== event.approval.id)
      list.push({ id: event.approval.id, line: approvalLine(event.approval) })
      this.#approvals.delete(key)
      this.#approvals.set(key, list.slice(-APPROVALS_PER_SESSION))
      if (this.#approvals.size > APPROVAL_SESSIONS) this.#approvals.delete(this.#approvals.keys().next().value!)
    } else if (event.type === 'approval/resolved') {
      const key = `${runtime}:${event.sessionId}`
      const list = this.#approvals.get(key)?.filter(one => one.id !== event.approvalId)
      if (list && list.length > 0) this.#approvals.set(key, list)
      else this.#approvals.delete(key)
    } else if (event.type === 'session/closed') this.#approvals.delete(`${runtime}:${event.sessionId}`)
  }

  /** Resolves once any read or send under way has finished; for tests and shutdown. */
  async settled(): Promise<void> {
    while (this.#running) await this.#running
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #run(): void {
    if (this.#disposed) return
    if (this.#running) { this.#again = true; return }
    this.#running = this.#round()
      .catch(error => this.#options.log('phone push round failed', { error: error instanceof Error ? error.name : 'error' }))
      .finally(() => {
        this.#running = null
        if (this.#again && !this.#disposed) { this.#again = false; this.poke() }
      })
  }

  /** Phones that can get a push now: paired here with a push key and allowed to read, and linked by the account. */
  async #targets(): Promise<Device[]> {
    let status: HarnessDeskAccountStatus
    try { status = await this.#options.account.status() } catch { return [] }
    if (status.status !== 'signedIn' || !status.desk.reachable) return []
    const linked = new Set(status.phones.map(phone => phone.deviceId))
    return this.#options.devices().filter(device => linked.has(device.id) && typeof device.pushKey === 'string' && device.pushKey.length > 0
      && Number.isInteger(device.kid) && device.kid >= 1 && device.tiers.includes('read'))
  }

  async #round(): Promise<void> {
    const targets = await this.#targets()
    // With nobody to push to the baseline is dropped, so a phone linked later hears only what newly waits after it.
    if (targets.length === 0 || this.#disposed) { this.#waiting = null; return }
    let inbox: LeadInbox
    try { inbox = await this.#options.inbox() } catch (error) {
      this.#options.log('phone push could not read the inbox', { error: error instanceof Error ? error.name : 'error' })
      return
    }
    const items = inbox.items.filter(item => item.needsYou && item.kind !== 'notice')
    const previous = this.#waiting
    this.#waiting = new Set(items.map(item => item.id))
    if (previous === null || this.#disposed) return
    const now = this.#now()
    for (const [ref, at] of this.#pushedAt) if (now - at >= PUSH_REPEAT_MS) this.#pushedAt.delete(ref)
    const fresh = items.filter(item => !previous.has(item.id) && !this.#pushedAt.has(item.id))
    let leadName: string | null | undefined
    for (const item of fresh) {
      if (this.#disposed) return
      // Counted as pushed before anything is sent, so a failure is never retried into a second push for one item.
      this.#pushedAt.set(item.id, now)
      if (item.kind === 'lead' || item.kind === 'ask') leadName ??= await this.#options.leadName().catch(() => null)
      const body = this.#body(item, leadName ?? null, Math.floor(now / 1000))
      if (!body) { this.#options.log('phone push skipped: too large', { kind: item.kind }); continue }
      const collapse = pushCollapse(body.deep)
      for (const device of targets) await this.#send(device, body, collapse)
    }
  }

  #body(item: LeadInboxItem, leadName: string | null, ts: number): PhonePushBody | null {
    const lead = leadName || 'Lead'
    switch (item.kind) {
      case 'ask': return pushBody(item.id, lead, item.title, ts)
      case 'lead': return pushBody(item.id, lead, item.count && item.count > 1 ? `Waiting for you on ${item.count} things` : 'Waiting for you', ts)
      case 'chat': {
        const open = item.target ? this.#approvals.get(item.target) : undefined
        return pushBody(item.id, item.title, open?.at(-1)?.line ?? 'Waiting on you', ts)
      }
      default: return pushBody(item.id, item.title, 'Waiting on you', ts)
    }
  }

  /** True when one more push fits the desk's pace and this phone's, and counts it. */
  #allow(deviceId: string, now: number): boolean {
    const recent = (list: number[]) => { while (list.length > 0 && now - list[0]! >= 60_000) list.shift(); return list }
    const desk = recent(this.#sent)
    const device = recent(this.#perDevice.get(deviceId) ?? [])
    if (desk.length >= PUSH_DESK_PER_MINUTE || device.length >= PUSH_DEVICE_PER_MINUTE) return false
    desk.push(now); device.push(now)
    this.#perDevice.set(deviceId, device)
    return true
  }

  async #send(device: Device, body: PhonePushBody, collapse: string): Promise<void> {
    if (this.#disposed) return
    const now = this.#now()
    if (now < this.#pausedUntil || (this.#skip.get(device.id) ?? 0) > now) return
    if (!this.#allow(device.id, now)) { this.#options.log('phone push held back: too many this minute', { device: device.id }); return }
    try {
      const sealed = await sealPushJson(fromB64u(device.pushKey), device.kid, device.id, body)
      // The phone link may have stopped while this was sealed.
      if (this.#disposed) return
      const status = await this.#options.account.sendPush({
        deviceId: device.id, kid: sealed.kid, nonce: sealed.nonce, ciphertext: sealed.ciphertext, priority: 'high', collapse,
      })
      if (status === 'unregistered') this.#skip.set(device.id, now + PUSH_UNREGISTERED_MS)
      this.#options.log('phone push', { device: device.id, status })
    } catch (error) {
      const refused = (this.#options.refusalStatus ?? accountRefusalStatus)(error)
      if (refused === 429 || refused === 401) this.#pausedUntil = now + PUSH_PAUSE_MS
      // Not linked to this desk after all: left alone until the account says something has changed.
      else if (refused === 403) this.#skip.set(device.id, Number.POSITIVE_INFINITY)
      this.#options.log('phone push failed', { device: device.id, ...(refused ? { status: refused } : { error: error instanceof Error ? error.name : 'error' }) })
    }
  }
}
